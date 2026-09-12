/**
 * Which calls' recovery evidence belongs to the CURRENT recovery contract.
 *
 * The promotion gate reconstructs routing verdicts from address cards, so a
 * call whose recovery ran under a different phonetic prompt or model is
 * evidence for THAT behavior, not this one. Deciding that per call has been
 * wrong in both directions on PR #4437, which is why it lives here with its
 * own tests instead of inline in the readiness script:
 *
 *  - Judging each card independently let a resolved historical card disqualify
 *    a call forever, so a reprocessed call's current, attributable outcome
 *    could never re-enter the cohort (r4 P1).
 *  - "Any card matching the current version wins" then went too far the other
 *    way: after a model rollback a stale resolved card matching again would
 *    admit a call whose LATEST attempt ran on the other model (r6 pre-push P1).
 *
 * So exactly one card speaks for each call — the latest attempt. An active
 * card outranks a resolved one, and among equals the most recently updated
 * wins. Cards the processor explicitly superseded are skipped: they describe a
 * pass that is gone and may neither attribute nor disqualify.
 */

const isActive = (status) => status === 'open' || status === 'in_progress';

/** A card records a recovery ATTEMPT; one with no recovery evidence does not. */
const recordsAttempt = (p) => Boolean(
  p.recovery_prompt_version || p.address_candidates || p.recovery_method || p.address_as_heard,
);

/**
 * @param {Array} cards      triage_items rows: { call_log_id, payload, status, updated_at, created_at }
 * @param {string} current   recoveryCohortVersion() for this process
 * @param {Function} [parse] payload parser (jsonb may arrive as text)
 * @returns {{ stale: Set<string>, unattributable: Set<string> }} calls to drop
 */
function classifyRecoveryCohort(cards, current, parse = (v) => v) {
  const authority = new Map();
  for (const card of cards || []) {
    let p = {};
    // Operator-visible jsonb: one malformed payload must not crash a readiness
    // run, it just fails to prove its pass.
    try { p = parse(card.payload) || {}; } catch { p = {}; }
    if (p.recovery_superseded_at) continue;
    if (!recordsAttempt(p)) continue;
    const active = isActive(card.status) ? 1 : 0;
    const at = new Date(card.updated_at || card.created_at || 0).getTime() || 0;
    const held = authority.get(card.call_log_id);
    if (!held || active > held.active || (active === held.active && at > held.at)) {
      authority.set(card.call_log_id, { active, at, p });
    }
  }

  const stale = new Set();
  const unattributable = new Set();
  for (const [callId, { p }] of authority) {
    if (p.recovery_prompt_version === current) continue;
    if (p.recovery_prompt_version) stale.add(callId);
    else unattributable.add(callId);
  }
  return { stale, unattributable };
}

module.exports = { classifyRecoveryCohort, recordsAttempt, isActive };
