/**
 * Per-call supervision for the collections voice lane.
 *
 * "Supervised" = an admin-approved (hand-dialed) case; only supervised calls
 * may ride the owner shakedown call-window override (codex P1 on #3555).
 * Origination derives it ONCE from collection_cases.approved_by at dial time
 * and stamps `collectionsSupervised` into the call_log metadata it writes
 * before calls.create. Every in-call reader (vestibule webhooks, relay
 * conversation) resolves through here, from that IMMUTABLE stamp only —
 * never from the case, whose approved_by is cleared by writeCallOutcome and
 * replaced by later approvals (codex #3560 P2 + hook rounds): a webhook
 * retry must classify the call exactly as the first attempt did.
 *
 * A row without the stamp (originated before it existed) is UNSUPERVISED —
 * no durable historical source records the dial-time actor for those rows,
 * and inferring it from current case state is the mutable read this module
 * exists to forbid. Fail-closed direction: the override is withheld (press-0
 * takes the callback branch; revalidation stays on the real clock), never
 * granted.
 */

function callSupervision(meta) {
  return Boolean(meta) && meta.collectionsSupervised === true;
}

module.exports = { callSupervision };
