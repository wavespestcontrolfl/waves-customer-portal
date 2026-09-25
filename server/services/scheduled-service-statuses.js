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

module.exports = {
  TERMINAL_SCHEDULED_SERVICE_STATUSES,
  NONTERMINAL_SCHEDULED_SERVICE_STATUSES,
};
