/**
 * scheduled_services.status vocabulary (codex round-3 P2 on PR #4807).
 *
 * The full 9-value CHECK-constrained set (server/models/migrations/
 * 20260615000005_scheduled_services_no_show_status.js, which lists it
 * inline so this file doesn't need to chase the constraint):
 *   pending | confirmed | en_route | on_site | rescheduled | cancelled |
 *   completed | skipped | no_show
 *
 * NONTERMINAL = still a live, working visit — everything except the 5
 * terminal/closed-out statuses. Callers that had been filtering on just
 * ['pending', 'confirmed'] (both callback_number_needed clearance writers:
 * admin-triage.js's card resolve, customer-contact-fanout.js's phone-edit
 * fan-out) excluded a visit already en_route/on_site — so verifying the
 * caller's number after the tech was already rolling left the arrival text
 * withheld even though the hold should have lifted. Shared here so the two
 * writers can never drift on the definition.
 */
const TERMINAL_SCHEDULED_SERVICE_STATUSES = ['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show'];
const NONTERMINAL_SCHEDULED_SERVICE_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];

/**
 * CLEARABLE = the status set the callback_number_needed clearance writers
 * (admin-triage.js's card resolve, customer-contact-fanout.js's phone-edit
 * fan-out — the same two NONTERMINAL_SCHEDULED_SERVICE_STATUSES consumes)
 * are willing to lift the hold on: NONTERMINAL plus 'rescheduled' (codex
 * round-5 P2). 'rescheduled' is genuinely terminal for the row it's
 * stamped on (no further work happens on THAT row) and reminders treat it
 * as pending-rebook, not "still working" — so it correctly stays OUT of
 * NONTERMINAL, whose "still a live, working visit" meaning a future
 * consumer may reasonably rely on. But a rescheduled row can still be a
 * GROUPED SIBLING of the row the customer was actually rebooked onto
 * (resolveCallbackNumberHoldRows checks every row sharing visit_id, not
 * just the id a caller happens to hold) — if the clearance writers skip it
 * for being terminal, its callback_number_hold_at never gets cleared, and
 * the group-wide hold predicate keeps reading the NEW row as held too,
 * even after the number was verified. A dedicated set here — rather than
 * widening NONTERMINAL itself — keeps NONTERMINAL's own semantics correct
 * for any other consumer.
 */
const CLEARABLE_SCHEDULED_SERVICE_STATUSES = [...NONTERMINAL_SCHEDULED_SERVICE_STATUSES, 'rescheduled'];

module.exports = {
  TERMINAL_SCHEDULED_SERVICE_STATUSES,
  NONTERMINAL_SCHEDULED_SERVICE_STATUSES,
  CLEARABLE_SCHEDULED_SERVICE_STATUSES,
};
