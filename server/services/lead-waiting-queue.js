/**
 * The "lead waiting for a first contact" queue: ONE definition shared by the
 * Action Inbox item leads_awaiting_contact (services/dashboard-alerts.js) and
 * the nightly lead repeat sweep (services/lead-repeat-sweep.js), so the sweep
 * only ever touches rows the inbox counts and the two can never drift.
 *
 * Mirrors the Speed-to-Lead backlog definition (routes/admin-leads.js):
 * status='new' is the sole pre-first-response state, response_time_minutes is
 * stamped at first response, and first_contact_at is the lead's own inbound
 * moment. Soft-deleted leads are invisible on every Leads surface. Internal /
 * test leads (QA captures left in status='new') never count; leads denormalize
 * contact names, so the customers-side exclusion does not cover them. The
 * shared fresh-start floor keeps the pre-reset backlog of never-answered leads
 * from counting forever.
 *
 * Column names are unqualified: apply it to an unaliased `leads` query.
 */

const { SPEED_TO_LEAD_FRESH_START } = require('../utils/speed-to-lead-fresh-start');
const { INTERNAL_TEST_CUSTOMERS } = require('./internal-test-customers');
const { phoneIdentityKey } = require('../utils/phone');

// A lead is "waiting" once it has gone this long with no first response.
// Mirrors the Response Speed tile's alert threshold order-of-magnitude but
// fires earlier: 30 minutes is where a same-day booking realistically slips.
const LEAD_RESPONSE_SLA_MINUTES = 30;

// `database` is the knex instance the query came from (its .raw builds the
// internal-name exclusion). Returns the query for chaining.
function applyLeadsAwaitingContactFilter(query, database) {
  query
    .where('status', 'new')
    .whereNull('deleted_at')
    .whereNull('response_time_minutes')
    .whereNotNull('first_contact_at')
    .whereRaw(`first_contact_at <= NOW() - INTERVAL '${LEAD_RESPONSE_SLA_MINUTES} minutes'`);
  if (SPEED_TO_LEAD_FRESH_START) {
    query.where('first_contact_at', '>=', SPEED_TO_LEAD_FRESH_START);
  }
  if (INTERNAL_TEST_CUSTOMERS.length) {
    query.whereNotIn(
      database.raw("LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))"),
      INTERNAL_TEST_CUSTOMERS,
    );
  }
  return query;
}

// How many PEOPLE the queue holds (owner 2026-11-01, "yes": one person who
// reran the quote form six times counted six times). Leads on one phone line
// are one person: phoneIdentityKey (utils/phone.js) keys a NANP number by its
// last 10 digits and a +-prefixed international number by all its digits. A
// lead with no usable phone (none, or a fragment) counts as its own person,
// so a missing or partial number never merges two people. `rows` carry `id`
// and `phone`.
function waitingPersonKey(row) {
  const key = phoneIdentityKey(row.phone);
  if (key && /^\d{10}$/.test(key)) return `phone:${key}`;
  const international = typeof row.phone === 'string' && row.phone.trim().startsWith('+');
  if (international && /^\+[1-9]\d{7,14}$/.test(key || '')) return `phone:${key}`;
  return `lead:${row.id}`;
}

function countWaitingPeople(rows) {
  return new Set(rows.map(waitingPersonKey)).size;
}

module.exports = {
  LEAD_RESPONSE_SLA_MINUTES,
  applyLeadsAwaitingContactFilter,
  countWaitingPeople,
};
