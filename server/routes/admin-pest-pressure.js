const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const {
  auditPestPressureConfigChange,
  ipFromReq,
  uaFromReq,
} = require('../services/audit-log');
const {
  DEFAULT_CONFIG,
  validateConfig,
} = require('../services/pest-pressure/config');
const { calculatePestPressureScore } = require('../services/pest-pressure/calculate');
const { loadActiveConfig, updateActiveConfig } = require('../services/pest-pressure/store');

// All endpoints below are admin-only — config changes affect customer-facing
// reports and a future override flow (Phase 4) directly mutates customer
// surfaces. Tech-only roles get a flat 403.
router.use(adminAuthenticate, requireAdmin);

const EDITABLE_FIELDS = [
  'enabled',
  'showOnCustomerReport',
  'showHowCalculated',
  'showComponentBreakdownToCustomer',
  'missingDataBehavior',
  'minimumDataRequired',
  'allowManualOverride',
  'allowTechnicianClientRatingEntry',
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

module.exports = router;
