/**
 * Data-hygiene auto-apply — the exception-based hands-off lane.
 *
 * Applies GREEN normalization proposals (the scanner's own eligibility
 * signal: evidence.auto_apply_eligible === true, tier 'high', confidence at
 * or above the floor) directly to the source row, stamping the proposal
 * status='auto_applied'. Everything below the bar stays 'pending' for the
 * review UI. Sensitive/extraction proposals (property access codes) are
 * NEVER touched here — they keep the human approve path in the admin route.
 *
 * Every apply is audited (auditHygieneProposalApply, vault_id null for
 * non-sensitive) and reversible via the existing /revert endpoint, which is
 * the one-click undo the hands-off pattern requires.
 *
 * Gate: dataHygieneAutoApply (GATE_DATA_HYGIENE_AUTO_APPLY === 'true',
 * opt-in in every environment — auto-writer pattern). Cron: 3:35am ET,
 * after the 3:15am scanner, job_health 'data-hygiene-auto-apply'.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { isEnabled } = require('../../config/feature-gates');
const { auditHygieneProposalApply } = require('../audit-log');

// resource_type -> physical table. Only these two ever receive
// normalization proposals; anything else is skipped fail-closed.
const NORMALIZATION_TABLES = {
  customer: 'customers',
  customer_account: 'customer_accounts',
};

// Defense-in-depth: per-table column allowlist mirroring exactly what the
// scanner reads. A proposal naming any other field is skipped, not applied.
const NORMALIZATION_FIELDS = {
  customer: new Set(['first_name', 'last_name', 'email', 'phone', 'state', 'zip']),
  customer_account: new Set(['first_name', 'last_name', 'email', 'phone']),
};

const MIN_CONFIDENCE = clampFloor(process.env.DATA_HYGIENE_AUTO_APPLY_MIN_CONFIDENCE, 0.98);
const BATCH_CAP = clampCap(process.env.DATA_HYGIENE_AUTO_APPLY_BATCH, 200);

function clampFloor(raw, fallback) {
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

function clampCap(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 1000);
}

function parseEvidence(evidence) {
  if (evidence === null || evidence === undefined) return {};
  if (typeof evidence === 'object') return evidence;
  try {
    return JSON.parse(evidence);
  } catch {
    return null; // malformed evidence -> not eligible, fail closed
  }
}

/**
 * The green bar. Pure — used by the sweep and unit-testable directly.
 * Returns { eligible, reason } so skips are explainable.
 */
function isAutoApplyEligible(proposal, { minConfidence = MIN_CONFIDENCE } = {}) {
  if (!proposal || proposal.status !== 'pending') return { eligible: false, reason: 'not_pending' };
  if (proposal.source !== 'normalization') return { eligible: false, reason: 'not_normalization' };
  if (proposal.is_sensitive) return { eligible: false, reason: 'sensitive' };
  if (proposal.tier !== 'high') return { eligible: false, reason: 'tier_not_high' };
  const confidence = Number.parseFloat(proposal.confidence);
  if (!Number.isFinite(confidence) || confidence < minConfidence) {
    return { eligible: false, reason: 'below_confidence_floor' };
  }
  const table = NORMALIZATION_TABLES[proposal.resource_type];
  if (!table) return { eligible: false, reason: 'unknown_resource_type' };
  if (!NORMALIZATION_FIELDS[proposal.resource_type].has(proposal.field)) {
    return { eligible: false, reason: 'field_not_allowlisted' };
  }
  const evidence = parseEvidence(proposal.evidence);
  if (!evidence || evidence.auto_apply_eligible !== true) {
    return { eligible: false, reason: 'not_marked_eligible' };
  }
  if (proposal.proposed_value === null || proposal.proposed_value === undefined
    || String(proposal.proposed_value) === '') {
    return { eligible: false, reason: 'empty_proposed_value' };
  }
  return { eligible: true };
}

function valuesEqual(a, b) {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  if (left === null && right === null) return true;
  if (left === null || right === null) return false;
  return String(left) === String(right);
}

/**
 * Shared applier for a NON-SENSITIVE normalization proposal. Runs inside the
 * caller's transaction; the caller must have SELECT ... FOR UPDATE'd the
 * proposal row already. Guarded: the live value must still equal the
 * proposal's current_value or the proposal is marked stale instead.
 *
 * Also used by the admin route's approve endpoint so human-applied and
 * auto-applied fixes share one code path.
 *
 * Returns { outcome: 'applied' | 'stale' }.
 */
async function applyNormalizationProposal({ trx, proposal, reviewedVia, reviewerId = null }) {
  const table = NORMALIZATION_TABLES[proposal.resource_type];
  const target = await trx(table)
    .where({ id: proposal.resource_id })
    .forUpdate()
    .first();

  const actual = target ? target[proposal.field] : undefined;
  if (!target || !valuesEqual(actual, proposal.current_value)) {
    await trx('data_hygiene_proposals')
      .where({ id: proposal.id, status: 'pending' })
      .update({
        status: 'stale',
        reviewed_via: reviewedVia,
        reviewed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
    return { outcome: 'stale' };
  }

  await trx(table)
    .where({ id: proposal.resource_id })
    .update({
      [proposal.field]: proposal.proposed_value,
      updated_at: trx.fn.now(),
    });

  await auditHygieneProposalApply({
    trx,
    proposal_id: proposal.id,
    rule_id: proposal.rule_id,
    rule_version: proposal.rule_version,
    source: proposal.source,
    field: proposal.field,
    resource_type: proposal.resource_type,
    resource_id: proposal.resource_id,
    scope_type: proposal.scope_type,
    scope_id: proposal.scope_id,
    // Non-sensitive: "redacted" is the raw value by contract (audit-log.js).
    before_redacted: proposal.current_value,
    after_redacted: proposal.proposed_value,
    before_hash: null,
    after_hash: null,
    vault_id: null,
    reviewer_id: reviewerId,
    reviewed_via: reviewedVia,
    is_sensitive: false,
  });

  await trx('data_hygiene_proposals')
    .where({ id: proposal.id, status: 'pending' })
    .update({
      status: reviewedVia === 'auto' ? 'auto_applied' : 'approved',
      reviewer_id: reviewerId,
      reviewed_via: reviewedVia,
      reviewed_at: trx.fn.now(),
      applied_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });

  return { outcome: 'applied' };
}

/**
 * The nightly sweep. One proposal per transaction so a single bad row can't
 * poison the batch; ends with ONE digest bell (never per-item — green work
 * is silent per row, the digest is the audit surface).
 */
async function runAutoApplySweep({ dbi = db } = {}) {
  if (!isEnabled('dataHygieneAutoApply')) {
    return { skipped: 'gate_off' };
  }

  const candidates = await dbi('data_hygiene_proposals')
    .where({ status: 'pending', source: 'normalization', is_sensitive: false, tier: 'high' })
    .where('confidence', '>=', MIN_CONFIDENCE)
    .orderBy('created_at', 'asc')
    .limit(BATCH_CAP);

  const results = { applied: 0, stale: 0, skipped: 0, errors: 0, byRule: {} };

  for (const candidate of candidates) {
    const { eligible } = isAutoApplyEligible(candidate);
    if (!eligible) {
      results.skipped += 1;
      continue;
    }
    try {
      await dbi.transaction(async (trx) => {
        const proposal = await trx('data_hygiene_proposals')
          .where({ id: candidate.id })
          .forUpdate()
          .first();
        // Re-check under lock — a human may have reviewed it since the scan.
        const recheck = isAutoApplyEligible(proposal);
        if (!recheck.eligible) {
          results.skipped += 1;
          return;
        }
        const { outcome } = await applyNormalizationProposal({
          trx,
          proposal,
          reviewedVia: 'auto',
        });
        if (outcome === 'applied') {
          results.applied += 1;
          results.byRule[proposal.rule_id] = (results.byRule[proposal.rule_id] || 0) + 1;
        } else {
          results.stale += 1;
        }
      });
    } catch (err) {
      results.errors += 1;
      logger.warn(`[data-hygiene] auto-apply failed for proposal ${candidate.id} (left pending): ${err.message}`);
    }
  }

  if (results.applied > 0) {
    try {
      const remaining = await dbi('data_hygiene_proposals')
        .where({ status: 'pending' })
        .count({ n: '*' })
        .first();
      const ruleSummary = Object.entries(results.byRule)
        .map(([rule, n]) => `${rule} ×${n}`)
        .join(', ');
      await require('../notification-service').notifyAdmin(
        'system',
        `Data hygiene: ${results.applied} fix${results.applied === 1 ? '' : 'es'} auto-applied`,
        `${ruleSummary}. All audited and reversible from the Data Hygiene page. ${Number(remaining?.n) || 0} lower-confidence proposals still pending review.`,
        {
          // The hygiene page lives as a tab of the Agents hub; a bare
          // /admin/data-hygiene redirect DROPS query params (verified in
          // dev) — deep-link the tab route directly.
          link: '/admin/agents?tab=hygiene&status=auto_applied',
          metadata: { ...results },
        },
      );
    } catch (notifyErr) {
      logger.warn(`[data-hygiene] auto-apply digest notify failed (non-blocking): ${notifyErr.message}`);
    }
  }

  logger.info(`[data-hygiene] auto-apply sweep: applied=${results.applied} stale=${results.stale} skipped=${results.skipped} errors=${results.errors}`);
  return results;
}

module.exports = {
  runAutoApplySweep,
  applyNormalizationProposal,
  isAutoApplyEligible,
  NORMALIZATION_TABLES,
  NORMALIZATION_FIELDS,
  _test: { valuesEqual, parseEvidence, MIN_CONFIDENCE, BATCH_CAP },
};
