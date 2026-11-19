/**
 * Self-serve estimates: plan restart (cancellation restart, GATE_CANCEL_FLOW_V2)
 * and plan start (the portal pricing card's first-plan quote,
 * GATE_PORTAL_PLAN_START) publish an estimate as 'sent' when the customer taps,
 * with nothing delivered. Their sent_at is a mint stamp, not a send, and the
 * mint promises no follow-up (the zero-follow-up contract, codex GH #3671).
 *
 * A staff-facing reader that reads sent_at or a sent status as "we sent this"
 * (a send count or funnel, a staff follow-up prompt) leaves such a row out,
 * unless staff really delivered it later: the admin send path stamps
 * estimate_data.deliveryState.firstDeliveredAt. Customer comms use the separate
 * noEngagementAutomation rule (estimate-comms-eligibility.js).
 *
 * A leaf module (no requires), so any reader can load it with no cycle.
 */
const SELF_SERVE_ESTIMATE_SOURCES = Object.freeze(['plan_restart', 'plan_start']);

// Knex where-callback that keeps every row except an undelivered self-serve
// one, for the estimates table under `alias` (a code constant, never input).
// NULL-aware (codex GH #3671 r20 P2): legacy rows carry source NULL, which a
// bare NOT IN would drop.
function whereNotUndeliveredSelfServe(alias) {
  return function notUndeliveredSelfServe() {
    this.whereNull(`${alias}.source`)
      .orWhereNotIn(`${alias}.source`, SELF_SERVE_ESTIMATE_SOURCES)
      .orWhereRaw(`(${alias}.estimate_data #>> '{deliveryState,firstDeliveredAt}') IS NOT NULL`);
  };
}

// The same rule on a row already read (its source and parsed estimate_data).
function isUndeliveredSelfServe(source, estimateData) {
  return SELF_SERVE_ESTIMATE_SOURCES.includes(String(source || ''))
    && !estimateData?.deliveryState?.firstDeliveredAt;
}

module.exports = { SELF_SERVE_ESTIMATE_SOURCES, whereNotUndeliveredSelfServe, isUndeliveredSelfServe };
