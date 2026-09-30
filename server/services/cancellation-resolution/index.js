'use strict';

/**
 * Cancellation resolution engine — public surface.
 *
 *   previewCancellationResolution(...)  read-only: facts → resolver → card
 *   openCancellationCase(...)           one cancellation_cases row per request
 *
 * Dark behind GATE_CANCEL_FLOW_V2 (call-time read so tests and Railway
 * flips take effect without a restart). Kill switch = unset.
 *
 * The engine decides; it never performs the accepted action, never sends
 * anything, and never phrases copy — see templates.js.
 */

const db = require('../../models/db');
const { gateEnvValue } = require('../../config/feature-gates');
const { REASON_CODE_VERSION, isReasonCode, reasonCodeMeta } = require('./reason-codes');
const { loadCancellationFacts } = require('./facts');
const { resolveCancellation } = require('./resolve');

const GATE = 'GATE_CANCEL_FLOW_V2';

function cancelFlowV2Enabled() {
  return gateEnvValue(GATE);
}

async function previewCancellationResolution({ customerId, reasonCode = null, families = [], context = {}, now = new Date() } = {}) {
  const facts = await loadCancellationFacts(customerId, { now });
  if (!facts) return null;
  const resolution = resolveCancellation({ facts, reasonCode, families, context, now });
  return { facts, resolution };
}

/**
 * Persist the case. Called by the cancel commit path (route) AFTER the
 * processor ran, so the row records what actually happened. Idempotent per
 * service request (UNIQUE service_request_id): a retry returns the row.
 */
async function openCancellationCase({
  customerId, serviceRequestId = null, families = [], reasonCode = null, reasonText = null,
  resolution = null, resolutionOutcome = null, snapshot = {}, processed = false,
}, dbh = db) {
  if (!customerId) throw new Error('openCancellationCase requires customerId');
  if (serviceRequestId) {
    const existing = await dbh('cancellation_cases').where({ service_request_id: serviceRequestId }).first();
    if (existing) {
      // Retry repair, not an early return: a first attempt can leave the row
      // 'open' (processor partially failed) or missing server-derived fields.
      // Fill only what is absent and promote open→committed when this retry
      // reports the cancel as processed — never rewrite recorded facts.
      const repair = {};
      if (processed && existing.status === 'open') repair.status = 'committed';
      // A retry can carry a SITUATIONAL hard-stop verdict (adverse event /
      // safety complaint, reconstructed from reason+context) that the
      // original write lost — record it so the case reaches the incident
      // lane; never downgrade an existing verdict.
      if (
        !existing.hard_stop && resolution && resolution.kind === 'hard_stop'
        && (!existing.reason_code || !resolution.reasonCode || existing.reason_code === resolution.reasonCode)
      ) {
        // Never attach a verdict from a DIFFERENT reason to a recorded case
        // (a later retry claiming health_or_chemicals must not flip an
        // existing price case into the incident lane).
        repair.hard_stop = true;
        if (!existing.review_type) repair.review_type = resolution.reviewType || null;
      }
      if (!existing.reason_code && isReasonCode(reasonCode)) {
        repair.reason_code = reasonCode;
        // The taxonomy travels with the code: a repaired billing_issue must
        // land in the office review lane like a first-write one would.
        const repairMeta = reasonCodeMeta(reasonCode);
        if (repairMeta && repairMeta.hardStop) {
          repair.hard_stop = true;
          repair.review_type = repairMeta.reviewType;
        }
      }
      const retryCard = resolution && resolution.kind === 'card' ? resolution.card : null;
      if (!existing.resolution_template_id && retryCard) {
        repair.resolution_template_id = retryCard.templateId;
        repair.resolution_slots = JSON.stringify(retryCard.slots || {});
        repair.resolution_action = JSON.stringify(retryCard.action || {});
        // Same rule as the insert path: only an explicit, validated claim
        // counts as an impression — a repaired-in card the customer may
        // never have seen records 'none' and must not burn the 12-month
        // suppression slot.
        repair.resolution_outcome = ['shown', 'accepted', 'declined'].includes(resolutionOutcome) ? resolutionOutcome : 'none';
      }
      if (Object.keys(repair).length) {
        repair.updated_at = new Date();
        await dbh('cancellation_cases').where({ id: existing.id }).update(repair);
        return { ...existing, ...repair };
      }
      return existing;
    }
  }
  const code = isReasonCode(reasonCode) ? reasonCode : null;
  const meta = code ? reasonCodeMeta(code) : null;
  const card = resolution && resolution.kind === 'card' ? resolution.card : null;
  // A code-level hard-stop reason is a hard stop even when the caller passed
  // no resolution object (the POST commit path never passes one) — the flag
  // and review_type must come from the taxonomy, not caller input.
  const hardStop = !!(resolution && resolution.kind === 'hard_stop') || !!(meta && meta.hardStop);
  const row = {
    customer_id: customerId,
    service_request_id: serviceRequestId,
    scope: JSON.stringify(Array.isArray(families) ? families : []),
    reason_code: code,
    reason_code_version: REASON_CODE_VERSION,
    reason_text: reasonText ? String(reasonText).slice(0, 2000) : null,
    hard_stop: hardStop,
    review_type: (resolution && resolution.kind === 'hard_stop' && resolution.reviewType)
      || (meta && meta.hardStop ? meta.reviewType : null),
    resolution_template_id: card ? card.templateId : null,
    resolution_slots: card ? JSON.stringify(card.slots) : null,
    resolution_action: card ? JSON.stringify(card.action) : null,
    // Only an explicit caller-claimed outcome that survived the route's
    // template-match check counts as an impression; the server having
    // RESOLVED a card is not proof the customer SAW it.
    resolution_outcome: card && ['shown', 'accepted', 'declined'].includes(resolutionOutcome) ? resolutionOutcome : 'none',
    snapshot: JSON.stringify(snapshot || {}),
    status: processed ? 'committed' : 'open',
  };
  const [inserted] = await dbh('cancellation_cases').insert(row).returning('*');
  return inserted;
}

/**
 * Release an accepted case whose action changed nothing, so it is neither
 * replayed as a 24 h dedupe nor counted as a shown card for 12 months.
 * Under the accept route's own per-customer lock, from a fresh read, and
 * only while no receipt and no active or resumed plan hold stand for it:
 * a concurrent or retried execution of the same case that did succeed is
 * never undone. Returns whether the case was released.
 */
async function releaseUnappliedCase({ caseId, customerId, code }) {
  if (!caseId || !customerId) return false;
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`cancel-accept:${customerId}`]);
    const fresh = await trx('cancellation_cases').where({ id: caseId }).forUpdate().first('resolution_outcome', 'snapshot');
    if (!fresh || fresh.resolution_outcome !== 'accepted') return false;
    const snap = typeof fresh.snapshot === 'string' ? JSON.parse(fresh.snapshot) : (fresh.snapshot || {});
    if (snap.accept_receipt) return false;
    const standing = await trx('plan_holds').where({ cancellation_case_id: caseId }).whereIn('status', ['active', 'resumed']).first('id');
    if (standing) return false;
    await trx('cancellation_cases').where({ id: caseId }).update({
      resolution_outcome: 'none',
      snapshot: JSON.stringify({ ...snap, accept_refused: { code, at: new Date().toISOString() } }),
      updated_at: new Date(),
    });
    return true;
  });
}

module.exports = {
  GATE,
  cancelFlowV2Enabled,
  previewCancellationResolution,
  openCancellationCase,
  releaseUnappliedCase,
};
