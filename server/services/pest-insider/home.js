/**
 * Pest Insider "Your home": the per-reader facts and the token helpers.
 *
 * The shared issue body (render.js) carries two tokens that stand alone just
 * before the sign-off: {{pi-home}} in the HTML and {{pi-home-text}} in the
 * plain text. They are two tokens because a SendGrid substitution is one
 * literal token -> one value applied to every part (the quiz tokens work the
 * same way, newsletter-quiz.js). The sender fills them per reader with that
 * customer's block (render.js homeBlock), or with '' for a reader without
 * one. Every other surface that shows a stored body (archive, RSS feed,
 * touchpoint log, the owner's FYI copy) strips them, so the block never
 * reaches the shared body, the archive or a copy a reader did not get.
 *
 * This file is a leaf: no database layer is loaded until loadHomeFacts runs,
 * so the strip helpers can be required from newsletter-draft.js and
 * newsletter-proof.js without a load-order risk.
 */
'use strict';

const { dateOnlyString } = require('../../utils/date-only');
const { etDateString } = require('../../utils/datetime-et');

const HOME_TOKEN = '{{pi-home}}';
const HOME_TEXT_TOKEN = '{{pi-home-text}}';

// "Last visit" older than this shows no block: the customer is not a current one.
const MAX_LAST_VISIT_AGE_DAYS = 365;
// Customers per query: one ANY-list is a bound parameter each, so a long
// audience is read in slices (newsletter-sender sends 500 per batch).
const CHUNK = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const HOME_TOKEN_PATTERN = /\{\{\s*pi-home(?:-text)?\s*\}\}/gi;

const hasHomeToken = (content) => new RegExp(HOME_TOKEN_PATTERN.source, 'i').test(String(content || ''));

// Both tokens removed; what is left is the issue exactly as it reads with no block.
const neutralizeHomeTokens = (content) => String(content || '').replace(HOME_TOKEN_PATTERN, '');

// The visit's service line, from the platform's one classifier (the estimator's
// serviceKeysFromText through newsletter-audience-profiles' linesFromScheduledServices,
// which also folds palm and commercial keys into the six sellable lines). A visit
// that names no line, or more than one, has none: the block prints no label then.
// The classifier reads the service name only to pick a line; the name itself
// is never kept or shown.
function serviceLineOf(serviceType) {
  const { linesFromScheduledServices } = require('../newsletter-audience-profiles');
  // The helper skips terminal statuses (a finished visit is not live coverage),
  // so the row is handed over as a live recurring one: only its text is read.
  const { lines } = linesFromScheduledServices([{ service_type: serviceType, status: 'confirmed', is_recurring: true }]);
  return lines.length === 1 ? lines[0] : null;
}

const dayNumber = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

// One customer's facts from their aggregate row, or null when they are not a
// current customer with a recent finished visit.
function homeFromRow(row, today) {
  const lastDate = dateOnlyString(row.last_date);
  const sinceDate = dateOnlyString(row.since_date);
  if (!lastDate || !sinceDate) return null;
  if (dayNumber(today) - dayNumber(lastDate) > MAX_LAST_VISIT_AGE_DAYS) return null;
  return {
    lastVisit: { date: lastDate, line: serviceLineOf(row.service_type) },
    sinceDate,
    visitCount: Number(row.visit_count),
  };
}

/**
 * One batched read of the customers' finished visits (scheduled_services,
 * status 'completed', visit date on or before today in Eastern time).
 * Returns Map<customerId, { lastVisit: { date, line }, sinceDate, visitCount }>.
 * A customer who is archived (deleted_at) or inactive (active = false, the
 * notion audience profiles use), or whose latest finished visit is over a year
 * old, has no entry. It may throw: the caller fails closed.
 * @param {Function} conn  knex or a transaction
 * @param {string[]} customerIds
 * @param {Date} [now]
 */
async function loadHomeFacts(conn, customerIds, now = new Date()) {
  const ids = Array.from(new Set((customerIds || []).filter(Boolean)));
  const facts = new Map();
  const today = etDateString(now);
  for (let i = 0; i < ids.length; i += CHUNK) {
    // DISTINCT ON keeps each customer's latest visit; the window aggregates
    // are computed over all of the customer's finished visits first.
    const rows = await conn('scheduled_services as s')
      .join('customers as c', 'c.id', 's.customer_id')
      .whereIn('s.customer_id', ids.slice(i, i + CHUNK))
      .where('s.status', 'completed')
      .where('s.scheduled_date', '<=', today)
      .whereNull('c.deleted_at')
      .whereRaw('c.active IS DISTINCT FROM false')
      .distinctOn('s.customer_id')
      .select(
        's.customer_id',
        's.scheduled_date as last_date',
        's.service_type',
        conn.raw('MIN(s.scheduled_date) OVER (PARTITION BY s.customer_id) AS since_date'),
        conn.raw('COUNT(*) OVER (PARTITION BY s.customer_id)::int AS visit_count'),
      )
      .orderBy([{ column: 's.customer_id' }, { column: 's.scheduled_date', order: 'desc' }, { column: 's.id', order: 'desc' }]);
    for (const row of rows) {
      const home = homeFromRow(row, today);
      if (home) facts.set(row.customer_id, home);
    }
  }
  return facts;
}

module.exports = { HOME_TOKEN, HOME_TEXT_TOKEN, hasHomeToken, neutralizeHomeTokens, loadHomeFacts, serviceLineOf };
