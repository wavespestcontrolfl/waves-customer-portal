/**
 * Admin alert quiet fall-off: an open admin bell alert with no new activity for 72 hours is marked done
 * (owner ruling 2026-11-04, verbatim: "IF THE ALERT IS OVER 3 DAYS OLD,, IT SHOULD FALL OFF"). One pass,
 * runAdminAlertQuietFallOff, every 10 minutes (scheduler.js). It cleans the bell and Needs Me.
 *
 * Gate GATE_ALERT_QUIET_FALL_OFF, three states (alertQuietFallOffMode):
 *   unset / anything else = off, no query
 *   shadow                = count and log what WOULD close, write nothing
 *   true                  = close
 *
 * WHAT FALLS OFF. Open rows (done_at IS NULL) that are in the bell (not Activity-only: the same
 * excludeActivityOnlyFromBell every bell reader uses) and whose last activity is older than 72 hours.
 *   - LAST ACTIVITY = the latest of created_at and the stamps the code leaves behind (the very list
 *     admin-alert-retention.js reads, imported from it): metadata.rungAt (a ringing refresh; bumpOnRefresh also moves created_at),
 *     observedAt (an ops-crons digest repeat), lastFailureAt (the model-failure bell), and quietHoldFrom
 *     (a Reopen, below). A QUIET refresh stamps nothing, so it is not news and does not keep a row. A stamp that
 *     does not look like a timestamp, or lies more than a day ahead, is ignored.
 *   - KEEP_UNTIL_SETTLED_CATEGORIES stay: money alerts wait for the money to settle (owner ruling 2026-11-05, "A");
 *     a person marks them done.
 *   - Claude's queue is never touched (metadata.claudeQueue / sentToClaude): a Mac launcher opens a terminal
 *     tab per row and that tab closes it. The bell filter already excludes those rows; this guards it twice.
 *   - A row an emitter re-raises by itself while its condition holds is left open: a dedupeOpenOnly emitter whose
 *     next sweep would raise a FRESH row, and ring or text, the minute we close this one, so closing it would only
 *     churn. The emitter is found as admin-alert-retention.js RERING finds it (the FIRST entry in registry order
 *     with a matching prefix) and only a 'periodic' first match holds the row. The 30-day retention rule still
 *     reaches it.
 *
 * DONE STATE. done_by 'quiet-72h', resolution "No new activity for 3 days", read state per doneColumns with
 * keepExisting (an unread row is read at the close; a person's read stands). Never deleted.
 *
 * REOPEN. A quiet-72h row is reopenable (notification-service REOPENABLE_DONE_BY_SQL; PERSON_DONE_BY_SQL keeps its
 * meaning for every other caller). The Reopen stamps metadata.quietHoldFrom, which is last activity, so the row
 * gets 72 more hours. A ringing refresh drops the stamp (rungAt then says when the row last had news).
 * The stamp is its own key and NOT `metadata.retired`: admin-alert-relevance.js re-arms only rows whose
 * retired.by is its own, and its candidateQuery skips any row that carries `retired`. Reusing the key would
 * make a reopened quiet row invisible to the relevance sweep for good. With a separate key the relevance sweep
 * behaves exactly as before: it never re-arms a quiet row, judges a reopened (open) one like any other, and can
 * take a quiet-72h done row over when the subject really moved on (openToCloser's rule).
 *
 * COME BACK. A new emission with changed content rings the row back through notifyAdmin: a refreshOnDedupe emitter
 * finds the done row (done rows are found unless dedupeOpenOnly) and a ringing refresh clears the done fields,
 * as it does after a person's Done; a dedupeOpenOnly emitter raises a fresh row. An emission with identical
 * content, or an emitter with no refresh, stays silent, as after a person's Done.
 *
 * WRITES. Candidates are read in id-keyset pages (PAGE_SIZE), at most TICK_CAP rows closed per tick. Each batch is
 * ONE guarded UPDATE that re-applies every condition in its WHERE (open, bell, not Claude's, category, last
 * activity older than the cutoff), so a ring that lands between the read and the write wins. No FOR UPDATE /
 * FOR SHARE: the pass is advisory and must never block an emitter or a money path. A batch that cannot get its
 * row locks within LOCK_TIMEOUT_MS is skipped and the next tick takes it.
 */

const db = require('../models/db');
const logger = require('./logger');
const { alertQuietFallOffMode } = require('../config/feature-gates');
// The activity stamps and the re-raise registry are admin-alert-retention.js's: one definition for both sweeps.
const { ACTIVITY_STAMP_KEYS, RERING } = require('./admin-alert-retention');

const HOUR_MS = 60 * 60 * 1000;
const QUIET_HOURS = 72;
const PAGE_SIZE = 200;
const TICK_CAP = 200;
const MAX_PAGES = 10;
const LOCK_TIMEOUT_MS = 2000;
const STATEMENT_TIMEOUT_MS = 20000;
const FUTURE_SLACK_MS = 24 * HOUR_MS;
const RESOLUTION = 'No new activity for 3 days';
// Money alerts stay until a person marks them done (owner ruling 2026-11-05, "A": money alerts stay until
// settled). Nothing here closes them on a settlement event: a dispute alert stays until a person marks it done, which
// covers "until the dispute closes". One entry per line, so a category leaves the list with a one-line change.
const KEEP_UNTIL_SETTLED_CATEGORIES = [
  'billing', // money owed: invoice and billing alerts
  'payment', // money owed: failed payments (payment_failed) and bill payment errors (bill_payment_error)
  'dispute', // money at risk: a chargeback with an evidence deadline that Stripe's handler states in the alert
  'refund', // money at risk: refunds on combined charges that need a manual reconcile (stripe-webhook.js)
  'tax', // money owed: tax deadlines and filings
  'payout', // money at risk: a Stripe payout that failed or was held
  'payroll', // money at risk: a failed Mercury paycheck (payroll-mercury-alerts.js)
  'llm_cost', // spend: an AI spend spike must reach the owner
];
const TIMESTAMP_RE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$';

const notificationPrivate = () => require('./notification-service')._private;

// A metadata stamp as a timestamptz, or NULL when it is missing, not shaped like an ISO time, not a real time
// (pg_input_is_valid: Postgres 16+, so '2026-13-99T15:00:00Z' is ignored, never a throw), or more than a day ahead.
// The shape test also keeps 'now', 'today' and 'infinity' from counting. Nested CASE: the cast runs only after both
// tests passed.
function stampSql(key) {
  const text = `metadata->>'${key}'`;
  return `CASE WHEN (${text} ~ ? AND pg_input_is_valid(${text}, 'timestamptz')) THEN CASE WHEN (${text})::timestamptz <= ?::timestamptz THEN (${text})::timestamptz END END`;
}

// created_at and every activity stamp, the latest wins (GREATEST ignores the NULLs).
function lastActivity(now) {
  const limit = new Date(now.getTime() + FUTURE_SLACK_MS).toISOString();
  return {
    sql: `GREATEST(created_at, ${ACTIVITY_STAMP_KEYS.map(stampSql).join(', ')})`,
    bindings: ACTIVITY_STAMP_KEYS.flatMap(() => [TIMESTAMP_RE, limit]),
  };
}

// Keeps open a row whose emitter re-raises a fresh row by itself while its condition holds. The row's registry entry
// is the FIRST entry (registry order) with a prefix its dedupeKey starts with, exactly as admin-alert-retention.js
// ringRiskFor finds it, and only a 'periodic' first match holds: an earlier 'event' entry wins over a later periodic
// prefix (payroll-mercury-key-send is an event entry that also starts with the periodic payroll-mercury-key). The
// ordered registry is flattened into parallel arrays; WITH ORDINALITY keeps its order for the first-match pick.
function periodicHoldSql(registry = RERING) {
  const flat = registry.flatMap((entry) => entry.prefixes.map((prefix) => ({ prefix, kind: entry.kind })));
  return {
    sql: `NOT COALESCE((SELECT t.kind = 'periodic' FROM unnest(?::text[], ?::text[]) WITH ORDINALITY AS t(prefix, kind, ord)
      WHERE starts_with(COALESCE(metadata->>'dedupeKey', ''), t.prefix) ORDER BY t.ord LIMIT 1), false)`,
    bindings: [flat.map((f) => f.prefix), flat.map((f) => f.kind)],
  };
}

// The ONE definition of "falls off", used by the read and again by the write.
function applyFallOffScope(query, { cutoff, now }) {
  const { excludeActivityOnlyFromBell } = notificationPrivate();
  const activity = lastActivity(now);
  const hold = periodicHoldSql();
  return excludeActivityOnlyFromBell(query.where({ recipient_type: 'admin' }).whereNull('done_at'))
    .whereRaw("metadata->'claudeQueue' IS NULL")
    .whereRaw("metadata->'sentToClaude' IS NULL")
    .whereRaw('NOT (COALESCE(category, \'\') = ANY(?::text[]))', [KEEP_UNTIL_SETTLED_CATEGORIES])
    .whereRaw(hold.sql, hold.bindings)
    .whereRaw(`${activity.sql} < ?::timestamptz`, [...activity.bindings, cutoff.toISOString()]);
}

// One id-keyset page of rows that fall off now.
function selectCandidates(conn, { cutoff, now, cursor, limit, scope = null }) {
  const query = conn('notifications');
  applyFallOffScope(query, { cutoff, now });
  if (scope) scope(query);
  if (cursor) query.where('id', '>', cursor);
  return query.select('id', 'category').orderBy('id', 'asc').limit(limit);
}

// Closes `ids` with ONE guarded UPDATE. Returns the rows that landed ({ id, category }). A row whose last
// activity moved past the cutoff since the read (a ring), that was closed, or that left the bell is not touched.
async function closeBatch(conn, ids, { cutoff, now, scope = null }) {
  if (!ids.length) return [];
  const { doneColumns, QUIET_FALL_OFF_DONE_BY } = notificationPrivate();
  try {
    return await conn.transaction(async (trx) => {
      await trx.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await trx.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      const query = trx('notifications').whereIn('id', ids);
      applyFallOffScope(query, { cutoff, now });
      if (scope) scope(query);
      return query
        .update(doneColumns({ by: QUIET_FALL_OFF_DONE_BY, resolution: RESOLUTION, at: now, keepExisting: true, conn: trx }))
        .returning(['id', 'category']);
    });
  } catch (err) {
    if (err?.code === '55P03' || err?.code === '57014') {
      logger.warn(`[alert-quiet-fall-off] batch of ${ids.length} skipped (${err.code}); the next tick takes it`);
      return [];
    }
    throw err;
  }
}

const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };

// What a pass does with a page of candidates, per mode. `field` is the summary count it fills.
const MODES = {
  shadow: { verb: 'would close', field: 'wouldClose', act: async (_conn, rows) => rows },
  true: { verb: 'closed', field: 'closed', act: (conn, rows, ctx) => closeBatch(conn, rows.map((r) => r.id), ctx) },
};

/**
 * One pass. Returns { skipped: true, reason: 'gate_off' } or the summary
 * { mode, scanned, closed, wouldClose, byCategory }. `scope` (tests only) narrows the query to a fixture's rows.
 */
async function runAdminAlertQuietFallOff({
  now = new Date(), mode = alertQuietFallOffMode(), conn = db, scope = null,
  pageSize = PAGE_SIZE, cap = TICK_CAP, maxPages = MAX_PAGES,
} = {}) {
  const handler = MODES[mode];
  if (!handler) return { skipped: true, reason: 'gate_off' };
  const cutoff = new Date(now.getTime() - QUIET_HOURS * HOUR_MS);
  // Live: never read more rows than the tick may still close, so every row read is attempted.
  const budget = { shadow: pageSize * maxPages, true: cap }[mode];
  const byCategory = {};
  let scanned = 0;
  let counted = 0;
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const limit = Math.min(pageSize, budget - counted);
    const rows = limit > 0 ? await selectCandidates(conn, { cutoff, now, cursor, limit, scope }) : [];
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;
    const landed = await handler.act(conn, rows, { cutoff, now, scope });
    counted += landed.length;
    landed.forEach((r) => bump(byCategory, r.category));
    if (rows.length < limit) break;
  }
  const summary = { mode, scanned, closed: 0, wouldClose: 0, byCategory, [handler.field]: counted };
  logger.info(`[alert-quiet-fall-off] ${mode}: ${handler.verb} ${counted} of ${scanned} candidate(s), by category ${JSON.stringify(byCategory)}`);
  return summary;
}

/**
 * Undo: reopens the rows this rule closed since `since` (done_by 'quiet-72h' only: a row a later closer took, or a
 * person reopened and closed again, no longer matches). Dry run by default. Stamps quietHoldFrom like a Reopen, so the
 * rule waits 72 more hours. Returns { found, reopened, byCategory }. Counts only; never reads or returns row text.
 */
async function reopenQuietFallOff({ since, apply = false, now = new Date(), conn = db, scope = null } = {}) {
  const sinceDate = new Date(since);
  if (!since || Number.isNaN(sinceDate.getTime())) throw new Error('reopenQuietFallOff needs a valid since time');
  const { DONE_CLEARED, QUIET_FALL_OFF_DONE_BY, QUIET_HOLD_KEY } = notificationPrivate();
  const match = (q) => {
    q.where({ recipient_type: 'admin', done_by: QUIET_FALL_OFF_DONE_BY }).whereNotNull('done_at').where('done_at', '>=', sinceDate);
    if (scope) scope(q);
    return q;
  };
  const rows = await match(conn('notifications')).select('category').count('* as n').groupBy('category');
  const byCategory = Object.fromEntries(rows.map((r) => [r.category || 'unknown', Number(r.n)]));
  const found = Object.values(byCategory).reduce((a, b) => a + b, 0);
  if (!apply || !found) return { found, reopened: 0, byCategory };
  const stamp = JSON.stringify({ [QUIET_HOLD_KEY]: now.toISOString() });
  let reopened = 0;
  for (;;) {
    const ids = await match(conn('notifications')).orderBy('id').limit(PAGE_SIZE).pluck('id');
    if (!ids.length) break;
    const n = await conn.transaction(async (trx) => {
      await trx.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      return match(trx('notifications').whereIn('id', ids))
        .update({ ...DONE_CLEARED, metadata: trx.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [stamp]) });
    });
    reopened += n;
    if (!n) break;
  }
  return { found, reopened, byCategory };
}

module.exports = {
  runAdminAlertQuietFallOff,
  reopenQuietFallOff,
  selectCandidates,
  closeBatch,
  applyFallOffScope,
  lastActivity,
  periodicHoldSql,
  KEEP_UNTIL_SETTLED_CATEGORIES,
  QUIET_HOURS,
  RESOLUTION,
  PAGE_SIZE,
  TICK_CAP,
  MAX_PAGES,
};
