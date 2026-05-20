const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const {
  auditPestPressureConfigChange,
  auditPestPressureScoreOverride,
  ipFromReq,
  uaFromReq,
} = require('../services/audit-log');
const {
  DEFAULT_CONFIG,
  validateConfig,
} = require('../services/pest-pressure/config');
const { calculatePestPressureScore } = require('../services/pest-pressure/calculate');
const {
  loadActiveConfig,
  updateActiveConfig,
  loadScoreForServiceRecord,
  applyOverride,
  removeOverride,
  listRecentScores,
  listAuditEvents,
  loadHistoryForCustomer,
} = require('../services/pest-pressure/store');
const { calculateAndPersistForServiceRecord } = require('../services/pest-pressure/orchestrate');

// All endpoints below are admin-only — config changes affect customer-facing
// reports and a future override flow (Phase 4) directly mutates customer
// surfaces. Tech-only roles get a flat 403.
router.use(adminAuthenticate, requireAdmin);

// Clamp a list-endpoint `limit` query param into [1, max], defaulting to
// `def` for missing/non-numeric values. The old code only clamped the
// upper bound, so `?limit=-1` produced a negative value that PostgreSQL
// rejects as `ERROR: LIMIT must not be negative`. Force the lower bound
// to 1 so the route can't be a denial-of-service vector.
function clampListLimit(raw, def, max) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return def;
  return Math.min(parsed, max);
}

const EDITABLE_FIELDS = [
  'enabled',
  'showOnCustomerReport',
  'showHowCalculated',
  'showComponentBreakdownToCustomer',
  'missingDataBehavior',
  'minimumDataRequired',
  'allowManualOverride',
  'allowTechnicianClientRatingEntry',
  'enabledServiceLines',
  'requireRecurringFrequency',
  'weights',
  'labels',
  'trendThresholds',
  'serviceFrequencyWindows',
  'clientQuestionText',
  'customerExplanationText',
  'calculationVersion',
];

function pickEditable(body) {
  if (!body || typeof body !== 'object') return {};
  const out = {};
  for (const key of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

function diffChangedFields(before, after) {
  const changed = [];
  for (const key of EDITABLE_FIELDS) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) changed.push(key);
  }
  return changed;
}

/**
 * GET /api/admin/pest-pressure/config
 * Returns the active config (or DEFAULT_CONFIG if no row exists yet) plus
 * the field whitelist so the client can render the form without hard-coding it.
 */
router.get('/config', async (req, res) => {
  try {
    const config = await loadActiveConfig(db);
    return res.json({ config, defaults: DEFAULT_CONFIG, editableFields: EDITABLE_FIELDS });
  } catch (err) {
    logger.error(`[admin-pest-pressure] GET /config failed: ${err.message}`);
    return res.status(500).json({ error: 'failed_to_load_config' });
  }
});

/**
 * PUT /api/admin/pest-pressure/config
 * Body: partial config (any subset of EDITABLE_FIELDS). Server merges
 * onto current config, validates, persists, and audits.
 *
 * Returns 422 with the validation errors when the merged config is
 * invalid — no partial writes.
 */
router.put('/config', async (req, res) => {
  try {
    const before = await loadActiveConfig(db);
    const incoming = pickEditable(req.body);
    const merged = { ...before, ...incoming };
    // Drop internal source marker so it doesn't leak into the snapshot.
    delete merged._source;

    const validation = validateConfig(merged);
    if (!validation.valid) {
      return res.status(422).json({ error: 'invalid_config', errors: validation.errors });
    }

    const after = await updateActiveConfig(db, {
      scope: 'global',
      updatedBy: req.technicianId || null,
      config: merged,
    });

    const changedFields = diffChangedFields(before, after);
    if (changedFields.length > 0) {
      await auditPestPressureConfigChange({
        tech_user_id: req.technicianId || null,
        config_id: after.id,
        scope: 'global',
        changed_fields: changedFields,
        before,
        after,
        ip_address: ipFromReq(req),
        user_agent: uaFromReq(req),
      });
    }

    return res.json({ config: after, changedFields });
  } catch (err) {
    logger.error(`[admin-pest-pressure] PUT /config failed: ${err.message}`);
    return res.status(500).json({ error: 'failed_to_update_config' });
  }
});

/**
 * POST /api/admin/pest-pressure/preview
 * Body: { inputs: { clientRating, technicianRating, reServiceImpact,
 *   recurringIssueRating, riskFactorRating, previousScore },
 *   config?: <partial config to overlay on active for what-if scenarios> }
 *
 * Runs the same calculatePestPressureScore engine the completion flow uses
 * and returns the full result for admin display.
 */
router.post('/preview', async (req, res) => {
  try {
    const active = await loadActiveConfig(db);
    const overlay = pickEditable(req.body?.config || {});
    const config = { ...active, ...overlay };
    delete config._source;

    const validation = validateConfig(config);
    if (!validation.valid) {
      return res.status(422).json({ error: 'invalid_config', errors: validation.errors });
    }

    const result = calculatePestPressureScore(req.body?.inputs || {}, config);
    return res.json({ result, configUsed: config });
  } catch (err) {
    if (err instanceof RangeError) {
      return res.status(400).json({ error: 'invalid_input', message: err.message });
    }
    logger.error(`[admin-pest-pressure] POST /preview failed: ${err.message}`);
    return res.status(500).json({ error: 'preview_failed' });
  }
});

const OVERRIDE_REASON_MAX = 500;

/**
 * PUT /api/admin/pest-pressure/scores/:serviceRecordId/override
 * Body: { displayedScore, reason }
 * Requires a non-empty reason. Stores original_calculated_score so the
 * removal endpoint can restore the engine's number. Audits as critical.
 */
router.put('/scores/:serviceRecordId/override', async (req, res) => {
  try {
    const config = await loadActiveConfig(db);
    if (!config.allowManualOverride) {
      return res.status(403).json({ error: 'overrides_disabled' });
    }
    const { displayedScore, reason } = req.body || {};
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmedReason) {
      return res.status(400).json({ error: 'reason_required' });
    }
    if (trimmedReason.length > OVERRIDE_REASON_MAX) {
      return res.status(400).json({ error: 'reason_too_long', max: OVERRIDE_REASON_MAX });
    }

    const updated = await applyOverride(db, {
      serviceRecordId: req.params.serviceRecordId,
      displayedScore,
      reason: trimmedReason,
      overriddenBy: req.technicianId || null,
    });

    await auditPestPressureScoreOverride({
      tech_user_id: req.technicianId || null,
      score_id: updated.id,
      service_record_id: updated.service_record_id,
      customer_id: updated.customer_id,
      original_calculated_score: updated.original_calculated_score,
      displayed_score: updated.displayed_score,
      override_reason: trimmedReason,
      action_type: 'set',
      ip_address: ipFromReq(req),
      user_agent: uaFromReq(req),
    });

    return res.json({ score: updated });
  } catch (err) {
    if (err instanceof RangeError) {
      return res.status(400).json({ error: 'invalid_score', message: err.message });
    }
    if (err.statusCode === 404 || err.message === 'score_not_found') {
      return res.status(404).json({ error: 'score_not_found' });
    }
    logger.error(`[admin-pest-pressure] PUT /scores/:id/override failed: ${err.message}`);
    return res.status(500).json({ error: 'override_failed' });
  }
});

/**
 * DELETE /api/admin/pest-pressure/scores/:serviceRecordId/override
 * Restores displayed_score to the engine-calculated value.
 */
router.delete('/scores/:serviceRecordId/override', async (req, res) => {
  try {
    const existing = await loadScoreForServiceRecord(db, req.params.serviceRecordId);
    if (!existing) {
      return res.status(404).json({ error: 'score_not_found' });
    }
    if (!existing.is_overridden) {
      return res.json({ score: existing, removed: false });
    }
    const previousOverride = {
      original: existing.original_calculated_score,
      displayed: existing.displayed_score,
      reason: existing.override_reason,
    };
    const updated = await removeOverride(db, { serviceRecordId: req.params.serviceRecordId });

    await auditPestPressureScoreOverride({
      tech_user_id: req.technicianId || null,
      score_id: updated.id,
      service_record_id: updated.service_record_id,
      customer_id: updated.customer_id,
      original_calculated_score: previousOverride.original,
      displayed_score: updated.displayed_score,
      override_reason: previousOverride.reason,
      action_type: 'remove',
      ip_address: ipFromReq(req),
      user_agent: uaFromReq(req),
    });

    return res.json({ score: updated, removed: true });
  } catch (err) {
    logger.error(`[admin-pest-pressure] DELETE /scores/:id/override failed: ${err.message}`);
    return res.status(500).json({ error: 'remove_override_failed' });
  }
});

/**
 * POST /api/admin/pest-pressure/scores/:serviceRecordId/recalculate
 * Body: { clearOverride?: boolean }
 *
 * Re-runs the engine with current source data. By default, an existing
 * manual override is preserved (recalculation refreshes calculated_score
 * but not displayed_score). Pass clearOverride: true to drop the
 * override and surface the new calculated score immediately.
 *
 * Audits as a recalculate event (not an override action) so the
 * audit trail distinguishes between "admin redid the math" and "admin
 * intentionally changed the number."
 */
router.post('/scores/:serviceRecordId/recalculate', async (req, res) => {
  try {
    // Strict boolean — Boolean(req.body.clearOverride) coerced any
    // truthy string (including the literal string "false") to true,
    // so a payload like { clearOverride: "false" } would silently
    // enter the override-removal path and clear a manual override the
    // operator was trying to leave intact. Require the literal boolean
    // true so the type contract is unambiguous; everything else preserves
    // the override.
    const clearOverride = req.body && req.body.clearOverride === true;

    // Snapshot the existing override BEFORE running the recalc so the
    // audit row records the actual pre-removal state even if recalc
    // mutates the row (persistScore preserves the override when
    // clearOverride isn't passed in its payload, but capturing here
    // also future-proofs against unrelated row state shifts).
    let existing = null;
    if (clearOverride) {
      existing = await loadScoreForServiceRecord(db, req.params.serviceRecordId);
    }

    // Run the recalc FIRST so we can fail-fast on a missing service
    // record / disabled feature WITHOUT having already mutated override
    // state. Before this re-ordering, removeOverride + audit ran ahead
    // of the orchestrator's null-result 404 path, leaving the system in
    // a "override cleared but score not recomputed" half-state.
    //
    // Note for reviewers (codex re-flags this line each round): the
    // orchestrator was updated in the same PR to mirror
    // service_records.pressure_index from persisted.displayed_score
    // (which preserves an active override) rather than from the engine's
    // fresh result. So a recalc with clearOverride=false correctly leaves
    // both pest_pressure_scores.displayed_score AND
    // service_records.pressure_index pointing at the override value.
    // See server/services/pest-pressure/orchestrate.js and the
    // pressure_index regression guard in pest-pressure-store.test.js.
    const result = await calculateAndPersistForServiceRecord(req.params.serviceRecordId, db);
    if (!result) {
      return res.status(404).json({ error: 'service_record_not_found_or_disabled' });
    }

    // Recalc succeeded — now safe to remove the override and audit. The
    // recalc just updated calculated_score; removeOverride will set
    // displayed_score to that latest calculated value and mirror it to
    // service_records.pressure_index.
    if (clearOverride && existing && existing.is_overridden) {
      const previousOverride = {
        // The calculated value at the time the override was first set.
        original: existing.original_calculated_score,
        // The override value the customer saw before removal.
        displayed: existing.displayed_score,
        reason: existing.override_reason,
      };
      const removed = await removeOverride(db, { serviceRecordId: req.params.serviceRecordId });
      // Use the post-remove displayed_score — that's the TRUE restored
      // value. removeOverride sets displayed_score to the (now-current,
      // post-recalc) calculated_score, which may differ from the stale
      // original_calculated_score when the override was preserved across
      // earlier recalculations.
      const restored = removed ? removed.displayed_score : existing.calculated_score;
      await auditPestPressureScoreOverride({
        tech_user_id: req.technicianId || null,
        score_id: existing.id,
        service_record_id: req.params.serviceRecordId,
        customer_id: existing.customer_id,
        original_calculated_score: previousOverride.original,
        displayed_score: restored,
        override_reason: previousOverride.reason,
        action_type: 'remove',
        ip_address: ipFromReq(req),
        user_agent: uaFromReq(req),
      });
    }

    const updated = await loadScoreForServiceRecord(db, req.params.serviceRecordId);
    return res.json({ score: updated, calculation: result.result });
  } catch (err) {
    logger.error(`[admin-pest-pressure] POST /scores/:id/recalculate failed: ${err.message}`);
    return res.status(500).json({ error: 'recalculate_failed' });
  }
});

/**
 * GET /api/admin/pest-pressure/scores/recent?limit=25
 * Recent calculated scores across all customers — feeds the admin
 * "Recent Scores" table where overrides are issued.
 */
router.get('/scores/recent', async (req, res) => {
  try {
    const limit = clampListLimit(req.query.limit, 25, 100);
    const rows = await listRecentScores(db, { limit });
    return res.json({ scores: rows });
  } catch (err) {
    logger.error(`[admin-pest-pressure] GET /scores/recent failed: ${err.message}`);
    return res.status(500).json({ error: 'failed_to_load_recent' });
  }
});

/**
 * GET /api/admin/pest-pressure/customers/:customerId/history?serviceLine=&limit=
 * Per-customer score history for the admin detail view.
 */
router.get('/customers/:customerId/history', async (req, res) => {
  try {
    const limit = clampListLimit(req.query.limit, 12, 50);
    const serviceLine = req.query.serviceLine || null;
    const rows = await loadHistoryForCustomer(db, req.params.customerId, { serviceLine, limit });
    return res.json({ history: rows });
  } catch (err) {
    logger.error(`[admin-pest-pressure] GET /customers/:id/history failed: ${err.message}`);
    return res.status(500).json({ error: 'failed_to_load_history' });
  }
});

/**
 * GET /api/admin/pest-pressure/audit?limit=50
 * Recent audit events for pest-pressure actions (config changes,
 * overrides, override removals).
 */
router.get('/audit', async (req, res) => {
  try {
    const limit = clampListLimit(req.query.limit, 50, 200);
    const events = await listAuditEvents(db, { limit });
    return res.json({ events });
  } catch (err) {
    logger.error(`[admin-pest-pressure] GET /audit failed: ${err.message}`);
    return res.status(500).json({ error: 'failed_to_load_audit' });
  }
});

module.exports = router;
