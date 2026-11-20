/**
 * Self-serve estimates: plan restart (cancellation restart, GATE_CANCEL_FLOW_V2),
 * plan start (the portal pricing card's first-plan quote, GATE_PORTAL_PLAN_START)
 * and the service report's priced cross-sell tap (service_report_cta,
 * GATE_REPORT_CLICK_TO_ESTIMATE) publish an estimate as 'sent' when the customer
 * taps, with nothing delivered. Their sent_at is a mint stamp, not a send, and
 * the mint promises no follow-up (the zero-follow-up contract, codex GH #3671;
 * AGENTS.md gives the report-card and restart mints the same bounds).
 *
 * A staff-facing reader that reads sent_at or a sent status as "we sent this"
 * (a send count or funnel, a staff follow-up prompt) leaves such a row out,
 * unless staff really delivered it later: the admin send path stamps
 * estimate_data.deliveryState.firstDeliveredAt. A report that dates a send or a
 * view (a funnel, a period count, win/loss) reads sentAtSql /
 * countableViewAtSql. The staff follow-up surfaces (the Estimates list and its
 * 9 AM push, the Pipeline board) read a delivered one as stored, as they read
 * any estimate. Customer comms use the separate noEngagementAutomation rule
 * (estimate-comms-eligibility.js).
 *
 * A leaf module (no requires), so any reader can load it with no cycle.
 */
const SELF_SERVE_ESTIMATE_SOURCES = Object.freeze(['plan_restart', 'plan_start', 'service_report_cta']);

// One test for "staff delivered it", in JavaScript and in SQL alike (codex
// pre-push P1: the list and the 9 AM push must agree): firstDeliveredAt is
// there and is not the empty string. SQL reads the value as text (#>>), so a
// JSON null is absent in both forms, and any other value is present in both.
function hasDeliveryStamp(estimateData) {
  const stamp = estimateData?.deliveryState?.firstDeliveredAt;
  return stamp !== undefined && stamp !== null && stamp !== '';
}

// SQL helpers for a row under `alias` (a code constant, never input). A
// self-serve row reads its delivery from firstDeliveredAt, as a timestamptz
// (NULL when absent or unreadable). Any other row keeps its own column.
const SELF_SERVE_SOURCES_SQL = SELF_SERVE_ESTIMATE_SOURCES.map((source) => `'${source}'`).join(', ');
const deliveryStampSql = (alias) => `${alias}.estimate_data #>> '{deliveryState,firstDeliveredAt}'`;
// The stamp as text, NULL when absent or empty: hasDeliveryStamp in SQL.
const presentStampSql = (alias) => `NULLIF(${deliveryStampSql(alias)}, '')`;

// Knex where-callback that keeps every row except an undelivered self-serve
// one, for the estimates table under `alias`. NULL-aware (codex GH #3671 r20
// P2): legacy rows carry source NULL, which a bare NOT IN would drop.
function whereNotUndeliveredSelfServe(alias) {
  return function notUndeliveredSelfServe() {
    this.whereNull(`${alias}.source`)
      .orWhereNotIn(`${alias}.source`, SELF_SERVE_ESTIMATE_SOURCES)
      .orWhereRaw(`${presentStampSql(alias)} IS NOT NULL`);
  };
}

// The same rule on a row already read (its source and parsed estimate_data).
function isUndeliveredSelfServe(source, estimateData) {
  return SELF_SERVE_ESTIMATE_SOURCES.includes(String(source || '')) && !hasDeliveryStamp(estimateData);
}

// A deliveryState stamp PostgreSQL reads as a real instant: a date shape AND
// a value it can read. The shape alone lets an ISO-looking but impossible
// value (Feb 30) abort a whole query at the cast; pg_input_is_valid alone
// accepts special literals such as 'now' and 'infinity' (codex pre-push P1).
// The readers that read a stamp in SQL alone share it: the two watchers, and
// estimate-draft-retire.js, whose rule it was. `expr` is SQL text built from
// code constants. No ? in a pattern here: these strings go into raw SQL with
// bindings.
function isoInstantSql(expr) {
  return `(${expr} ~ '^[0-9]{4}-' AND pg_input_is_valid(${expr}, 'timestamptz'))`;
}

// The stamp deliveryState.<key> of the row under `alias` as a timestamptz,
// NULL when absent or unreadable, so a bad stamp never aborts a query. `key`
// is a code constant, never input.
function deliveryInstantSql(alias, key) {
  const stamp = `(${alias}.estimate_data #>> '{deliveryState,${key}}')`;
  return `(CASE WHEN ${isoInstantSql(stamp)} THEN ${stamp}::timestamptz END)`;
}

// The reports date a send by firstDeliveredAt in SQL (the Intelligence Bar)
// and in JavaScript (win/loss, the service-line card). Both must read the
// same instant, or both none (codex pre-push P1), so both read only a
// complete ISO instant with an explicit offset: what the send path writes
// (toISOString()), up to the microseconds PostgreSQL's own JSON carries.
// PostgreSQL alone also reads a zone name or a missing offset; JavaScript
// alone rolls an impossible day over (Feb 30 to Mar 1), so that day is
// checked in JavaScript too. Any other stamp is present but unreadable in
// both, and both date the send by sent_at. {0,1} stands for ?.
const ISO_INSTANT_PATTERN = '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])'
  + 'T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6}){0,1}(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])$';
const ISO_INSTANT_RE = new RegExp(ISO_INSTANT_PATTERN);
function firstDeliveredAtSql(alias) {
  const stamp = `(${alias}.estimate_data #>> '{deliveryState,firstDeliveredAt}')`;
  return `(CASE WHEN ${stamp} ~ '${ISO_INSTANT_PATTERN}' AND pg_input_is_valid(${stamp}, 'timestamptz') THEN ${stamp}::timestamptz END)`;
}
// In epoch ms; JavaScript keeps whole milliseconds, so it lands on the same
// side of every day and month boundary as PostgreSQL's microseconds.
function firstDeliveredAtMs(estimateData) {
  const stamp = estimateData?.deliveryState?.firstDeliveredAt;
  if (typeof stamp !== 'string' || !ISO_INSTANT_RE.test(stamp)) return null;
  const [year, month, day] = stamp.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day ? Date.parse(stamp) : null;
}
function selfServeOr(alias, selfServeSql, otherSql) {
  return `(CASE WHEN ${alias}.source IN (${SELF_SERVE_SOURCES_SQL}) THEN ${selfServeSql} ELSE ${otherSql} END)`;
}

// isUndeliveredSelfServe as a SQL boolean, for a reader that selects the flag
// rather than load estimate_data (the 9 AM Call today push reads 2,000 rows).
// A source-NULL row gives NULL, which reads as false.
function undeliveredSelfServeSql(alias) {
  return `(${alias}.source IN (${SELF_SERVE_SOURCES_SQL}) AND ${presentStampSql(alias)} IS NULL)`;
}

// A self-serve row's delivery instant: its first real delivery. Its sent_at is
// the mint stamp, and the admin send path rewrites sent_at on every later
// attempt, suppressed ones too (codex pre-push r16 P1), while firstDeliveredAt
// never moves. An undelivered one has none (NULL). A stamp present but
// unreadable still records a staff send, dated by sent_at, so the rows dated
// here are exactly the delivered ones whereNotUndeliveredSelfServe keeps.
// Win/loss reads the same anchor in JavaScript (estimate-winloss.js
// sentAnchorMs).
function deliveredAtSql(alias) {
  const unreadableStamp = `CASE WHEN ${presentStampSql(alias)} IS NOT NULL THEN ${alias}.sent_at END`;
  return `COALESCE(${firstDeliveredAtSql(alias)}, ${unreadableStamp})`;
}

// The instant a row counts as sent: a self-serve row's delivery instant, any
// other row's sent_at.
function sentAtSql(alias) {
  return selfServeOr(alias, deliveredAtSql(alias), `${alias}.sent_at`);
}

// The instant a row counts as viewed. A self-serve quote is opened in the
// portal before any send, so a later staff send must not turn that look into
// a viewed send (codex pre-push r15): only a view at or after its delivery
// instant (deliveredAtSql, the same anchor its send is dated by) counts. The
// first such view is the earliest one known at or after the delivery: the per-open log (estimate_views), viewed_at and
// last_viewed_at (LEAST skips a NULL). A later open then never moves it to a
// later period (codex pre-push P1), also when the view handler stamped
// viewed_at but its log insert failed, and a legacy row the log predates
// still counts.
function countableViewAtSql(alias) {
  const delivered = deliveredAtSql(alias);
  const firstLoggedOpen = `(SELECT MIN(ev.viewed_at) FROM estimate_views ev WHERE ev.estimate_id = ${alias}.id AND ev.viewed_at >= ${delivered})`;
  const fromDelivery = (column) => `CASE WHEN ${alias}.${column} >= ${delivered} THEN ${alias}.${column} END`;
  return selfServeOr(alias,
    `LEAST(${firstLoggedOpen}, ${fromDelivery('viewed_at')}, ${fromDelivery('last_viewed_at')})`,
    `${alias}.viewed_at`);
}


module.exports = {
  SELF_SERVE_ESTIMATE_SOURCES, whereNotUndeliveredSelfServe, isUndeliveredSelfServe, undeliveredSelfServeSql,
  sentAtSql, countableViewAtSql, isoInstantSql, deliveryInstantSql, firstDeliveredAtMs,
};
