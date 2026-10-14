/**
 * Rider-series READ-ONLY PREVIEW (pest-rides-the-lawn-rhythm, owner decision
 * 2026-09-28: ship a read-only preview first after five non-converging
 * Codex rounds on the write engine — see PR #5268, now a paused draft).
 *
 * This module NEVER writes. It answers one question — "if a pest series
 * rode a lawn series' dates, what would the plan look like, and is the
 * pair even eligible?" — using the SAME date rule and the SAME read-side
 * eligibility rules the (unmerged) write engine settled on across five
 * review rounds, reused here so the eventual write engine and this preview
 * can never silently disagree about what "eligible" or "the plan" means.
 * `docs/design/rider-series-scheduling.md` has the full rule set.
 *
 * `scheduled_services.rides_parent_id` is written in ONE place: estimate
 * accept, behind GATE_PEST_RIDES_LAWN_AT_ACCEPT (rider-accept-seeding.js
 * links a quarterly rider series to the lawn series it was seeded on), and is
 * read by the series extension (admin-schedule.js#extendSeriesOnceLocked, same
 * gate) so a rider's next visit keeps riding the lawn. Nothing calls
 * `previewRiderPair` from any hook, cron, or writer. It is reached ONLY from
 * scripts/rider-series-preview-report.js, a read-only ops report the owner
 * runs by hand.
 *
 * Everything below is a plain (non-locking, non-transactional) read: no
 * `FOR UPDATE`/`FOR SHARE`, no advisory lock, no row lock, no write of any
 * kind — `previewRiderPair` accepts any knex connection (the pool, a
 * transaction, or the ops script's own READ ONLY transaction) and never
 * calls `.transaction()` itself.
 */
const {
  parseETDateTime, etDateString, addETDays, etCalendarDayOf,
} = require('../utils/datetime-et');
const { JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
// The canonical plan-row predicate: the root, explicit or legacy NULL-flagged
// children; never a booster, a callback or an included follow-up.
const { isPlanSeriesRow } = require('./recurring-series-cancel-reseed');
// Tracker state can run ahead of status (the best-effort status sync lags):
// the same two-column rule customer-lifecycle-guard.js#whereVisitRowLive
// applies. A terminal tracker state is finished; a live one is in progress.
const { TERMINAL_TRACK_STATES } = require('./customer-lifecycle-guard');
const { LIVE_TRACK_STATES } = require('./cancellation-eligibility');
const { LIVE_COMPLETION_CLAIM_STATUSES } = require('./visit-groups');
const { getBlackoutLayers } = require('./scheduling/blackout-dates');
const { clearOfBlackout, isBlackedOut } = require('./scheduling/blackout-nudge');

const MIN_GAP_DAYS = 77;
const TARGET_GAP_DAYS = 84;
const MAX_WAIT_DAYS = 105;
// Owner ruling: existing customers' pest dates move with NO texts — a row
// inside this window is close enough that the customer may already be
// acting on it, so it's a fixed anchor regardless of what any
// reminder/confirmation ledger shows. Same value the write engine uses.
const NEAR_TERM_DAYS = 7;
// How long an overdue rider (anchor so old the next step would land before
// the plan floor) waits for a host date before taking a standalone date on
// the floor: the normal window's width, MAX_WAIT_DAYS - MIN_GAP_DAYS.
const OVERDUE_WAIT_DAYS = MAX_WAIT_DAYS - MIN_GAP_DAYS;
// The same rule per rider cadence (owner ruling 2026-10-01, second batch): the
// rider takes the first lawn date at least `min` days after its last visit,
// waits for one until `max`, else stands alone at `target`. On a monthly lawn
// (28-35 day gaps) `min` sits between k-1 and k lawn gaps, so the rider gets
// every k-th lawn visit: monthly 1, bi-monthly 2, quarterly 3, semiannual 6.
// `season`: Feb-Oct only — Nov-Jan lawn dates are never taken and the wait
// carries over the winter.
const QUARTERLY_GAPS = { min: MIN_GAP_DAYS, target: TARGET_GAP_DAYS, max: MAX_WAIT_DAYS };
const RIDER_GAPS = {
  quarterly: QUARTERLY_GAPS,
  monthly: { min: 21, target: 28, max: 49 },
  bimonthly: { min: 49, target: 56, max: 77 },
  semiannual: { min: 161, target: 182, max: 196 },
  seasonal_feb_oct: { min: 21, target: 28, max: 49, season: true },
};
// A cadence with no row (a pair the table does not allow, previewed anyway)
// keeps the quarterly rule it has always been planned with.
function riderGapsFor(pattern) {
  return RIDER_GAPS[pattern] || QUARTERLY_GAPS;
}
// Same bound the write engine's computeRiderHorizon applies (see its own
// comment there): at most ~2 years past the rider's own standalone
// horizon, so a host row seeded or hand-edited an arbitrary distance out
// can never blow the preview's horizon (and planRiderDates' own walk) out
// to match it.
const MAX_HORIZON_EXTRA_DAYS = 730;

const IN_PROGRESS_STATUSES = ['en_route', 'on_site'];
const MOVABLE_ROW_STATUSES = ['pending', 'confirmed'];
const DEAD_CARD_STATUSES = ['released', 'cancelled', 'failed', 'expired'];
const NON_PINNING_MESSAGE_PURPOSES = ['appointment_cancellation'];

// Structural pair reasons that make a plan uncomputable (never merely
// "the office wouldn't write this today") — see previewRiderPair's own
// comment for why these, and only these, skip plan computation.
const STRUCTURAL_BLOCKERS = new Set([
  'rider_not_found', 'not_a_rider', 'host_missing', 'self_link', 'host_is_rider',
  'cross_customer', 'not_recurring', 'not_series_root',
]);

// Reasons that make the plan's host dates NOT a ride for the series extension
// (admin-schedule.js#extendSeriesOnceLocked): the pair is structurally wrong, a
// property compare failed or could not be made, the pairing table / host
// service does not allow it, the plan has no anchor or a host/rider row is
// waiting to be rescheduled (its dates are about to change), or a read the
// plan depends on failed. Everything else the preview lists (customer holds,
// plan hold, duplicate series, a stopped plan, ...) gates whether the SERIES
// may be extended at all — a decision the extension's own callers already make
// — and says nothing about whether the next date can ride the lawn.
const RIDE_BLOCKING_REASONS = new Set([
  ...STRUCTURAL_BLOCKERS,
  'different_property', 'property_unresolved', 'pairing_not_enabled', 'no_anchor',
  'host_reschedule_pending', 'rider_reschedule_pending', 'blackout_check_error',
  'series_check_error', 'error',
]);

// Table-driven pair-structure gates (Codex P2 round on PR #5290 —
// previewRiderPair's own complexity): every ROW is a plain sync predicate
// over the already-loaded pair context, evaluated in order and never
// short-circuited (design doc: `reasons` lists every applicable gate).
// `different_property` and `plan_stopped` stay OUTSIDE this table — both
// need an extra DB read (the resolved property scope, the latest plan-alert
// decision) that this table's sync predicates deliberately don't take on.
const PAIR_STRUCTURE_GATES = [
  ['self_link', (ctx) => String(ctx.resolvedHostId) === String(ctx.riderParentId)],
  ['cross_customer', (ctx) => String(ctx.riderParent.customer_id) !== String(ctx.hostParent.customer_id)],
  ['host_is_rider', (ctx) => !!ctx.hostParent.rides_parent_id],
  ['not_series_root', (ctx) => !!ctx.riderParent.recurring_parent_id],
  ['not_recurring', (ctx) => !ctx.riderParent.is_recurring || !ctx.riderParent.recurring_pattern],
  ['not_ongoing', (ctx) => !(ctx.cols.recurring_ongoing ? !!ctx.riderParent.recurring_ongoing : false)],
  // The CURRENT services (loadPairContext overlays both roots with their
  // series-scope service overrides): a host that is no longer a 6-week/monthly
  // lawn series, or a rider the pairing table does not allow on it.
  ['pairing_not_enabled', (ctx) => !riderPairingEnabled(ctx.hostParent, riderFamilyOf(ctx.riderParent), ctx.riderParent.recurring_pattern)],
];

function dateOnly(value) {
  if (!value) return null;
  return etCalendarDayOf(value);
}

function addDaysStr(dateStr, days) {
  const base = parseETDateTime(`${dateOnly(dateStr)}T12:00`);
  if (isNaN(base.getTime())) return null;
  return etDateString(addETDays(base, days));
}

// Same weekend-shift arithmetic the seeder applies to every date it walks
// (recurring-appointment-seeder.js#shiftPastWeekend), reused verbatim.
function shiftPastWeekend(dateStr, skip, direction = 'forward') {
  if (!skip || !dateStr) return dateStr;
  const { shiftPastWeekend: seederShift } = require('./recurring-appointment-seeder');
  return seederShift(dateStr, skip, direction);
}

// Pure — the horizon rule, byte-identical to the write engine's own
// computeRiderHorizon (services/rider-series.js): the LATER of the host's
// own last live date and the rider's own standalone horizon, bounded to at
// most MAX_HORIZON_EXTRA_DAYS past the standalone horizon.
function computeRiderHorizon(anchorDate, hostDates, pattern) {
  const { plannedVisitCountForPattern } = require('./recurring-appointment-seeder');
  const count = plannedVisitCountForPattern(pattern, {});
  const gaps = Math.max(0, count - 1);
  const standaloneHorizon = addDaysStr(anchorDate, gaps * riderGapsFor(pattern).target);
  const sorted = Array.from(new Set((hostDates || []).map(dateOnly).filter(Boolean))).sort();
  let horizon = standaloneHorizon;
  if (sorted.length) {
    const hostLast = sorted[sorted.length - 1];
    if (hostLast > horizon) horizon = hostLast;
  }
  const maxHorizon = addDaysStr(standaloneHorizon, MAX_HORIZON_EXTRA_DAYS);
  if (maxHorizon && horizon > maxHorizon) horizon = maxHorizon;
  return horizon;
}

// One walk-step of the date rule (Codex P2 round on PR #5290 —
// planRiderDates' own complexity): given the LAST planned/anchor date, the
// plan floor, and the sorted host dates, returns the next candidate date or
// null when the walk cannot continue at all (an unparseable `last`). Split
// out so planRiderDates itself is just the loop/guard/stop conditions —
// this function still contains every decision the rule makes for ONE step,
// genuinely fewer of them per function, not the same branches relocated
// into a single-call helper.
function nextRiderDate({
  last, floor, sortedHosts, skipWeekends, dir, blackoutDates, gaps = QUARTERLY_GAPS,
}) {
  let minDate = addDaysStr(last, gaps.min);
  let maxDate = addDaysStr(last, gaps.max);
  if (!minDate || !maxDate) return null;
  const overdue = !!floor && minDate < floor;
  if (overdue) {
    minDate = floor;
    maxDate = addDaysStr(floor, gaps.max - gaps.min);
  }
  if (gaps.season) ({ minDate, maxDate } = seasonWindow(minDate, maxDate, gaps.max - gaps.min));
  const hostCandidate = sortedHosts.find((d) => d >= minDate);
  if (hostCandidate && hostCandidate <= maxDate) return hostCandidate;
  if (gaps.season) return seasonStandaloneDate({ last, overdue, minDate, skipWeekends, dir, blackoutDates });
  const base = overdue ? floor : addDaysStr(last, gaps.target);
  let next = shiftPastWeekend(base, skipWeekends, dir);
  if (floor && next && next < floor) next = shiftPastWeekend(base, skipWeekends, 'forward');
  if (next && blackoutDates) next = clearOfBlackout(next, blackoutDates, { skipWeekends });
  return next;
}

function inSeason(dateStr) {
  const { SEASON_FIRST_MONTH, SEASON_LAST_MONTH } = require('./recurring-appointment-seeder');
  const month = Number(String(dateStr).slice(5, 7));
  return month >= SEASON_FIRST_MONTH && month <= SEASON_LAST_MONTH;
}

// The first in-season day on or after a date: the date itself in season, else
// the 1st of the coming season's first month.
function seasonOpenOnOrAfter(dateStr) {
  if (inSeason(dateStr)) return dateStr;
  const { SEASON_FIRST_MONTH, SEASON_LAST_MONTH } = require('./recurring-appointment-seeder');
  const year = Number(dateStr.slice(0, 4)) + (Number(dateStr.slice(5, 7)) > SEASON_LAST_MONTH ? 1 : 0);
  return `${year}-${String(SEASON_FIRST_MONTH).padStart(2, '0')}-01`;
}

// A seasonal rider's wait does not run through the winter: a window that
// starts off season starts at the season's opening instead, and one that only
// ends off season stays open the same number of days into the next season.
function seasonWindow(minDate, maxDate, width) {
  const opens = seasonOpenOnOrAfter(minDate);
  if (opens !== minDate) return { minDate: opens, maxDate: addDaysStr(opens, width) };
  const reopens = seasonOpenOnOrAfter(maxDate);
  return { minDate, maxDate: reopens === maxDate ? maxDate : addDaysStr(reopens, width) };
}

// No lawn date in a seasonal rider's window: the date its own Feb-Oct walk
// gives (an overdue rider: the window's first day), kept in season the way
// the seeder keeps it. null = no clear in-season date, so the plan stops.
function seasonStandaloneDate({ last, overdue, minDate, skipWeekends, dir, blackoutDates }) {
  const Seeder = require('./recurring-appointment-seeder');
  const base = overdue ? minDate : Seeder.seasonalFebOctDate(last, 1);
  let next = shiftPastWeekend(base, skipWeekends, overdue ? 'forward' : dir);
  if (next && blackoutDates) next = clearOfBlackout(next, blackoutDates, { skipWeekends });
  return next && Seeder.clampDateToSeason(Seeder.SEASONAL_FEB_OCT, next, { skipWeekends, blackoutDates });
}

// Which series may ride which (owner rulings 2026-10-01), one table. Each
// rider cadence has its own day gaps (RIDER_GAPS): a quarterly rider gets
// every 2nd date of a 6-week lawn host and every 3rd of a monthly one. The
// `gated` rows are the second batch (monthly lawn hosts only), open while
// GATE_RIDER_PAIRS_MONTHLY_LAWN is on. Not chosen, so no row: a 6-week lawn
// with a bi-monthly rider, and any pair hosted on a pest visit.
const QUARTERLY_RIDER_FAMILIES = ['pest_control', 'tree_shrub', 'termite_bait'];
const RIDER_PAIRINGS = [
  { host: 'lawn_6wk', riderFamilies: QUARTERLY_RIDER_FAMILIES, riderPattern: 'quarterly' },
  { host: 'lawn_monthly', riderFamilies: QUARTERLY_RIDER_FAMILIES, riderPattern: 'quarterly' },
  { host: 'lawn_monthly', riderFamilies: ['pest_control', 'tree_shrub'], riderPattern: 'bimonthly', gated: true },
  { host: 'lawn_monthly', riderFamilies: ['pest_control'], riderPattern: 'monthly', gated: true },
  { host: 'lawn_monthly', riderFamilies: ['pest_control'], riderPattern: 'semiannual', gated: true },
  { host: 'lawn_monthly', riderFamilies: ['mosquito'], riderPattern: 'seasonal_feb_oct', gated: true },
];

// 'lawn_6wk' | 'lawn_monthly' | null for a series row. Prod stores 6-week lawn
// three ways: every_6_weeks, custom with a 42-day interval (whatever the
// catalog key says — the interval is the cadence), and custom with a NULL
// interval on lawn_care_6week.
// Is this row's CURRENT service lawn care? The one predicate for "can this row
// host a rider": its stamped catalog key when it has one (a later service
// change stamps the new key, whatever the old label said), else its label.
// Applied to the override-overlaid host root and to every host occurrence.
function isLawnServiceRow(row) {
  const { serviceKeyFor } = require('./recurring-appointment-seeder');
  const snapshot = String(row?.service_key_snapshot || '');
  return snapshot ? snapshot.startsWith('lawn_care') : serviceKeyFor({ service_type: row?.service_type }) === 'lawn_care';
}

function riderHostKind(row) {
  if (!row) return null;
  const snapshot = String(row.service_key_snapshot || '');
  if (!isLawnServiceRow(row)) return null;
  if (row.recurring_pattern === 'every_6_weeks') return 'lawn_6wk';
  if (row.recurring_pattern === 'monthly') return 'lawn_monthly';
  if (row.recurring_pattern !== 'custom') return null;
  const interval = row.recurring_interval_days;
  return Number(interval) === 42 || (interval == null && snapshot === 'lawn_care_6week') ? 'lawn_6wk' : null;
}

function riderFamilyOf(row) {
  const { serviceKeyFor } = require('./recurring-appointment-seeder');
  const snapshot = row?.service_key_snapshot;
  return serviceKeyFor(snapshot ? { service_key: snapshot } : { service_type: row?.service_type });
}

// Optional call: suites that mock feature-gates partially never define the
// second-batch reader, which means off.
function riderPairingEnabled(hostRow, riderFamily, riderPattern) {
  const host = riderHostKind(hostRow);
  const secondBatch = () => !!require('../config/feature-gates').riderPairsMonthlyLawnLive?.();
  return !!host && RIDER_PAIRINGS.some((p) => p.host === host
    && p.riderPattern === riderPattern && p.riderFamilies.includes(riderFamily)
    && (!p.gated || secondBatch()));
}

/**
 * Pure date rule — no DB access. Same rule the write engine's own
 * planRiderDates (services/rider-series.js) applies, one step of which
 * (nextRiderDate, above) is factored out for complexity, not behavior —
 * see the 19 shared plan tests (rider-series-preview-plan.test.js). See
 * that function's own header for the full parameter contract ("Date rule"
 * in the design doc).
 */
function planRiderDates({
  hostDates = [], lastRiderDate, horizonDate, skipWeekends = false, weekendShift = 'forward',
  earliestDate = null, blackoutDates = null, gaps = QUARTERLY_GAPS,
} = {}) {
  const anchor = dateOnly(lastRiderDate);
  const horizon = dateOnly(horizonDate);
  const floor = dateOnly(earliestDate);
  const dates = [];
  if (!anchor || !horizon) return dates;
  const sortedHosts = Array.from(new Set((hostDates || []).map(dateOnly).filter(Boolean))).sort()
    .filter((d) => !gaps.season || inSeason(d));
  const dir = weekendShift === 'back' ? 'back' : 'forward';

  let last = anchor;
  for (let guard = 0; guard < 1000; guard++) {
    const next = nextRiderDate({
      last, floor, sortedHosts, skipWeekends, dir, blackoutDates, gaps,
    });
    if (!next || next <= last || next > horizon) break;
    dates.push(next);
    last = next;
  }
  return dates;
}

// Reused by BOTH the preview's own different_property gate and the report
// script's candidate bucketing (Codex P1 round on PR #5290: the old
// different_property gate only fired when BOTH parents already carried a
// stamped property_id, and the script's bucketing collapsed every
// null-property root into one 'unstamped' bucket per customer — neither
// actually resolved "what property is this root at"). Built from the SAME
// address resolution the duplicate-series guard scopes on
// (admin-schedule.js#topUpScopeInput: the override-aware stamped address,
// else an unstamped root's own source estimate, else the customer's
// primary address) plus estimate-property-linkage.js's canonical
// property-tuple key (normalizedEstimatePropertyKey/samePropertyKey —
// "identical street+unit in different cities/ZIPs are DISTINCT
// properties", the same primitive the duplicate-series guard's own street
// compare is built from). `resolved: false` means neither a property_id
// nor a parseable address could be found anywhere for this root — the
// conservative `property_unresolved` case, never guessed either way.
async function resolveSeriesPropertyScope(conn, parent) {
  const { topUpScopeInput } = require('../routes/admin-schedule');
  const { normalizedEstimatePropertyKey } = require('./estimate-property-linkage');
  // Savepoint: topUpScopeInput swallows a failed source-estimate read as a
  // best-effort fallback, but that failed statement aborts the transaction
  // (25P02) for its own customer-address read after it. Isolate the lookup
  // so the caller's transaction stays usable, and treat a failed lookup as
  // unresolved (reported property_unresolved, never guessed).
  let scope;
  try {
    scope = await conn.transaction((sp) => topUpScopeInput(sp, parent));
  } catch {
    return { propertyId: null, key: null, resolved: false };
  }
  const propertyId = scope.property_id ? String(scope.property_id) : null;
  const key = scope.address ? normalizedEstimatePropertyKey(scope.address) : null;
  return { propertyId, key, resolved: !!(propertyId || key) };
}

// Symmetric same-property compare over two resolveSeriesPropertyScope
// results, returned as one of 'same' / 'different' / 'unresolved'.
// property_id decides when BOTH sides carry one (authoritative, no street
// compare — mirrors the duplicate-series guard's own rule); otherwise the
// normalized property-tuple key decides. Either side unresolved, or a
// mismatched pair (one id-only, one key-only — nothing comparable), is
// conservatively NEVER a match: unresolved reports as such, and the
// mismatched-shape case reports 'different' rather than guessing.
function seriesPropertyVerdict(a, b) {
  const { samePropertyKey } = require('./estimate-property-linkage');
  if (!a?.resolved || !b?.resolved) return 'unresolved';
  if (a.propertyId && b.propertyId) return a.propertyId === b.propertyId ? 'same' : 'different';
  if (a.key && b.key) return samePropertyKey(a.key, b.key) ? 'same' : 'different';
  return 'different';
}

// Makes scopes of MIXED shape comparable. A root with no stamped property_id
// resolves from its address alone (topUpScopeInput: the customer's primary
// address) -> {propertyId: null, key}, while its child rows carry only a
// stamped property_id and no service_address_* columns ->
// {propertyId, key: null}. seriesPropertyVerdict reads that pair as nothing
// comparable ('different'), which silently dropped every child row of such a
// series from the host dates (and from the apply script's host occurrence).
// When a set of scopes holds BOTH a key-only and an id-only scope, the
// id-only ones get their property's own address key (customer_properties,
// ONE batched read for the whole set, never per row) built with the SAME
// normalizedEstimatePropertyKey the other side's key is, so the compare
// stays samePropertyKey. The id is kept (two ids still decide by id). Fails
// CLOSED: a failed read, a missing property row, or a property with no
// parseable address leaves key null, which stays 'different' (never 'same',
// never guessed). Returns a new array, same order; inputs are not mutated.
async function withComparableKeys(conn, scopes) {
  const list = scopes.map((s) => s || null);
  const idOnly = (s) => !!(s?.resolved && s.propertyId && !s.key);
  const keyOnly = (s) => !!(s?.resolved && !s.propertyId && s.key);
  if (!list.some(idOnly) || !list.some(keyOnly)) return list;
  const { normalizedEstimatePropertyKey } = require('./estimate-property-linkage');
  const ids = Array.from(new Set(list.filter(idOnly).map((s) => s.propertyId)));
  const keyById = new Map();
  try {
    // Savepoint, like resolveSeriesPropertyScope: a failed read must not
    // abort the caller's transaction (25P02).
    const props = await conn.transaction((sp) => sp('customer_properties')
      .whereIn('id', ids)
      .select('id', 'address_line1', 'address_line2', 'city', 'state', 'zip'));
    for (const p of props) {
      const address = [
        p.address_line1, p.address_line2, p.city, `${p.state || ''} ${p.zip || ''}`.trim(),
      ].filter(Boolean).join(', ');
      keyById.set(String(p.id), address ? normalizedEstimatePropertyKey(address) : null);
    }
  } catch {
    return list;
  }
  return list.map((s) => (idOnly(s) && keyById.get(s.propertyId) ? { ...s, key: keyById.get(s.propertyId) } : s));
}

// Pure, per-ROW twin of resolveSeriesPropertyScope (Codex P1 round #2 on PR
// #5290 — loadHostRows' own host-row filter, below): a plain child row's
// own stamped `property_id` and `service_address_*` columns, reduced to the
// same {propertyId, key, resolved} shape with the SAME normalized key
// (`estimate-property-linkage.js#normalizedEstimatePropertyKey`), but never
// falling back to an estimate or the customer's primary address — that
// fallback only makes sense for resolving a SERIES ROOT's own scope
// (topUpScopeInput), never for a plain child row mid-series. `resolved:
// false` (no property_id, no stamped address on the row itself) is the
// ordinary case for most child rows — the caller reads that as "this row
// carries no scope of its own" and inherits the host's effective scope,
// exactly as the old raw-property_id compare treated a NULL property_id.
function rowPropertyScope(row) {
  const { normalizedEstimatePropertyKey } = require('./estimate-property-linkage');
  const propertyId = row.property_id ? String(row.property_id) : null;
  const address = [
    row.service_address_line1, row.service_address_line2, row.service_address_city,
    `${row.service_address_state || ''} ${row.service_address_zip || ''}`.trim(),
  ].filter(Boolean).join(', ');
  const key = address ? normalizedEstimatePropertyKey(address) : null;
  return { propertyId, key, resolved: !!(propertyId || key) };
}

// Batched "is this rider row pinned by a durable record" lookup — same
// tables and same DEAD/NON_PINNING exclusions the write engine's
// immovableRowIdSet applies, but returns WHICH category matched (for the
// preview's own `pinned[].why`) instead of a flat boolean set. Read-only:
// plain SELECTs, no lock of any kind.
async function messagedRowIds(conn, ids) {
  // A non-null sent_at alone isn't delivery: a suppressed send (owner
  // silence, a disabled gate or template) records a synthetic provider id
  // and sent_at, and a real text can end undelivered. Apply the same
  // real-send checks as no-show-detector.js#loadPromiseEvents
  // (textActuallyWentOut: push, a live sms_log delivery state, or an
  // unlinked real Twilio SM/MM sid; not blocked; no provider error).
  const { textActuallyWentOut } = require('./no-show-detector');
  return conn('messaging_audit_log as a')
    .leftJoin('sms_log as s', 's.twilio_sid', 'a.provider_message_id')
    .whereIn('a.appointment_id', ids.map(String))
    .whereNotIn('a.purpose', NON_PINNING_MESSAGE_PURPOSES)
    .whereNotNull('a.sent_at')
    .whereNull('a.blocked_code')
    .whereNull('a.provider_error')
    .where(textActuallyWentOut)
    .distinct()
    .pluck('a.appointment_id');
}

// Reuses no-show-detector.js's canonical "was the customer told" evidence
// unification (loadPromiseEvents) instead of re-deriving it from
// messaging_audit_log alone (Codex P1 round on PR #5290): a messaging_audit_log
// scan keyed on appointment_id ALONE misses pre-2026-08-06 rows linked only
// by metadata.scheduled_service_id (appointment_id wasn't stamped on those
// senders until that date), a delivered appointment EMAIL (no SMS row at
// all — email_messages/customer_interactions), and a call-derived promise
// (an applied phone reschedule, or the call that booked the visit —
// neither ever sends a text of its own). loadPromiseEvents already reads
// every one of those sources and is the SAME evidence the no-show detector
// itself alerts against, so this preview can never disagree with it about
// what counts as a delivered promise. Read-only: loadPromiseEvents issues
// plain SELECTs, no lock, no write — same posture as every other read
// here. A cancellation notice still never pins: loadPromiseEvents only
// reads scheduling-notice purposes (confirmation/reminder tiers) and
// call-derived events, never appointment_cancellation, so the "a
// cancellation notice doesn't pin" rule holds with no extra exclusion
// needed here.
async function deliveredPromiseRowIds(conn, ids) {
  const { loadPromiseEvents } = require('./no-show-detector');
  const events = await loadPromiseEvents(conn, ids.map(String));
  return [...new Set(events.map((e) => e.visit_id).filter(Boolean).map(String))];
}

async function attributeReasonMap(conn, rowIds) {
  const ids = (rowIds || []).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  // Sequential, not Promise.all: every read runs on the caller's one
  // transaction connection, and pg rejects concurrent queries on one client
  // (deprecated now, an error in pg 9).
  const invoiced = await conn('invoices').whereIn('scheduled_service_id', ids).pluck('scheduled_service_id');
  const cardHeld = await conn('estimate_card_holds').whereIn('scheduled_service_id', ids)
    .whereNotIn('status', DEAD_CARD_STATUSES).pluck('scheduled_service_id');
  const cardRequested = await conn('appointment_card_requests').whereIn('scheduled_service_id', ids)
    .whereNotIn('status', DEAD_CARD_STATUSES).pluck('scheduled_service_id');
  const packeted = await conn('visit_completion_packet_items').whereIn('scheduled_service_id', ids).pluck('scheduled_service_id');
  const completionClaims = await conn('service_completion_attempts').whereIn('service_id', ids)
    .whereIn('status', LIVE_COMPLETION_CLAIM_STATUSES).pluck('service_id');
  const messagedRows = await messagedRowIds(conn, ids);
  const promisedRows = await deliveredPromiseRowIds(conn, ids);
  // Priority order only matters for which SINGLE `why` a row reports when
  // more than one applies — every category still independently pins the
  // row either way. promisedRows and messagedRows share the SAME `why`
  // ('messaged') — both are "the customer was told" evidence, just read
  // from two different scopes of the same underlying record set.
  for (const id of promisedRows) map.set(id, 'messaged');
  for (const id of messagedRows) map.set(id, 'messaged');
  for (const id of completionClaims) map.set(id, 'completion_claim');
  for (const id of packeted) map.set(id, 'closeout_packet');
  for (const id of cardRequested) map.set(id, 'card_request');
  for (const id of cardHeld) map.set(id, 'card_hold');
  for (const id of invoiced) map.set(id, 'invoice');
  return map;
}

// Classifies one rider row for the preview: {terminal:true} (excluded from
// both the movable and the pinned picture — history, never touched),
// {booster:true} (not a plan row: booster, callback or included follow-up;
// never a move/cancel/anchor candidate), {pinned:true, why}
// (a live row that cannot move, with the reason), or {movable:true}.
// Byte-identical rule set to the write engine's immovableByOwnFields +
// attributeImmovable + near-term cutoff (services/rider-series.js), with
// two additions the design doc calls for:
//  - a NULL-status row (a legacy base row with no stamped status) is
//    reported pinned with why: 'null_status' rather than silently falling
//    through every check — the write engine achieves the same "never
//    movable" outcome for it implicitly (it's outside
//    MOVABLE_ROW_STATUSES), but the preview's job is to SHOW why, not
//    just to leave it out.
//  - a 'rescheduled' row (is_recurring plan row only — a booster's own
//    rescheduled status is unaffected and still classifies as `terminal`
//    below, exactly as before) is a LIVE visit awaiting re-placement, not
//    history: reported pinned with why: 'rescheduled_pending' instead of
//    `terminal` (Codex P1 round on PR #5290). Its date is stale — the row
//    is waiting to be MOVED, not sitting at a date anyone should read as
//    "when pest last actually happened" — so previewRiderPair excludes it
//    from the anchor computation even though it is `pinned`, the one case
//    where a pinned row does not anchor.
// Pins read straight off the row's own columns, checked in order.
const OWN_FIELD_PINS = [
  ['prepaid', (r) => r.prepaid_amount != null],
  ['customer_confirmed', (r) => r.customer_confirmed === true],
  ['field_confirmed', (r) => r.field_confirmed_at != null],
  ['visit_id', (r) => r.visit_id != null],
  ['arrival_sms_sent', (r) => r.arrival_sms_sent_at != null],
  ['prep_sent', (r) => r.prep_sent_at != null],
];

function classifyRiderRow(row, reasonMap, nearTermCutoff, todayStr) {
  // A tracker-cancelled visit is gone, whatever status says. A 'rescheduled'
  // status wins over a stale 'complete' tracker (the legacy customer
  // reschedule path flips only status), so check it before 'complete'.
  if (row.track_state === 'cancelled') return { terminal: true };
  if (isPlanSeriesRow(row) && row.status === 'rescheduled') {
    return { pinned: true, why: 'rescheduled_pending' };
  }
  if (TERMINAL_TRACK_STATES.includes(row.track_state)) return { terminal: true };
  if (JOIN_INELIGIBLE_STATUSES.includes(row.status)) return { terminal: true };
  if (!isPlanSeriesRow(row)) return { booster: true };
  if (IN_PROGRESS_STATUSES.includes(row.status) || LIVE_TRACK_STATES.includes(row.track_state)) {
    return { pinned: true, why: 'in_progress' };
  }
  const ownPin = OWN_FIELD_PINS.find(([, test]) => test(row));
  if (ownPin) return { pinned: true, why: ownPin[0] };
  if (reasonMap.has(row.id)) return { pinned: true, why: reasonMap.get(row.id) };
  if (row.status == null) return { pinned: true, why: 'null_status' };
  const d = dateOnly(row.scheduled_date);
  // A live row dated before today never happened (still pending/confirmed):
  // report it as overdue, never as near-term.
  if (d != null && todayStr && d < todayStr) return { pinned: true, why: 'overdue' };
  if (d != null && d <= nearTermCutoff) return { pinned: true, why: 'near_term' };
  if (MOVABLE_ROW_STATUSES.includes(row.status)) return { movable: true };
  return { pinned: true, why: 'other_status' };
}

// Pure diff (byte-identical shape to the write engine's diffRiderPlan,
// minus the host-join window/technician refresh — the preview reports
// DATES only, never a technician or window assignment, so there is no
// "refresh" concept here): claims at most one movable row per planned
// date (lowest id wins a same-date tie), then pairs the remaining
// unmatched movable rows with the remaining unmatched planned dates in
// order (earliest movable row <-> earliest unmatched date) as moves; any
// planned dates left over are inserts, any movable rows left over are
// cancels.
function diffPlan(plan, movableRows) {
  const movableByDate = new Map();
  for (const r of movableRows) {
    const d = dateOnly(r.scheduled_date);
    if (!d) continue;
    if (!movableByDate.has(d)) movableByDate.set(d, []);
    movableByDate.get(d).push(r);
  }
  for (const rows of movableByDate.values()) rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const claimedIds = new Set();
  const keep = [];
  const unmatchedPlanned = [];
  for (const d of plan) {
    const candidates = movableByDate.get(d) || [];
    const existing = candidates.find((r) => !claimedIds.has(r.id));
    if (existing) {
      claimedIds.add(existing.id);
      keep.push({ id: existing.id, date: d });
    } else {
      unmatchedPlanned.push(d);
    }
  }
  const unmatchedMovable = movableRows
    .filter((r) => !claimedIds.has(r.id))
    // Id tie-break: same-date rows must pair the same way on every run, not
    // in PostgreSQL's physical row order.
    .sort((a, b) => dateOnly(a.scheduled_date).localeCompare(dateOnly(b.scheduled_date))
      || String(a.id).localeCompare(String(b.id)));

  const pairCount = Math.min(unmatchedMovable.length, unmatchedPlanned.length);
  const move = [];
  for (let i = 0; i < pairCount; i++) {
    move.push({ id: unmatchedMovable[i].id, from: dateOnly(unmatchedMovable[i].scheduled_date), to: unmatchedPlanned[i] });
  }
  const insert = unmatchedPlanned.slice(pairCount);
  const cancel = unmatchedMovable.slice(pairCount).map((r) => ({ id: r.id, date: dateOnly(r.scheduled_date) }));
  return {
    keep, move, insert, cancel,
  };
}

// --- previewRiderPair, split into phases (Codex P2 round on PR #5290 —
// previewRiderPair's own complexity) ---------------------------------------

// Phase 1: resolve the two parent rows and the pair's basic shape. Returns
// either { blocked: reason } for the id-resolution failures that make
// everything past this point uncomputable (rider_not_found / not_a_rider /
// host_missing), or the loaded context every later phase reads.
async function loadPairContext(conn, riderParentId, hostParentId) {
  if (!riderParentId) return { blocked: 'rider_not_found' };
  const cols = await conn('scheduled_services').columnInfo();
  const riderParent = await conn('scheduled_services').where({ id: riderParentId }).first();
  if (!riderParent) return { blocked: 'rider_not_found' };
  const resolvedHostId = hostParentId || riderParent.rides_parent_id;
  if (!resolvedHostId) return { blocked: 'not_a_rider' };
  const hostRaw = await conn('scheduled_services').where({ id: resolvedHostId }).first();
  if (!hostRaw) return { blocked: 'host_missing' };
  // Both roots are read as the series CURRENTLY is: a "this and following"
  // service change leaves the completed root's columns and stamps the new
  // service in recurring_template_overrides.
  const { overlayRecurringTemplateOverrides } = require('./recurring-template-overrides');
  return {
    cols,
    riderParent: overlayRecurringTemplateOverrides(riderParent, cols),
    hostParent: overlayRecurringTemplateOverrides(hostRaw, cols),
    riderParentId,
    resolvedHostId,
  };
}

// Phase 2: every pair/customer/series gate. Returns { reasons, hostScope }
// — reasons is the full array (every applicable gate, never first-hit; the
// caller decides whether a STRUCTURAL_BLOCKERS hit skips plan computation),
// hostScope is the host's own resolved property scope (Codex P1 round #2 on
// PR #5290 — computed here once, alongside the pair's own property compare,
// and handed to loadHostRows below so it never re-resolves it).
async function evaluatePairGates(conn, ctx) {
  const {
    cols, riderParent, hostParent, riderParentId,
  } = ctx;
  const reasons = PAIR_STRUCTURE_GATES.filter(([, test]) => test(ctx)).map(([reason]) => reason);

  // Property scope: only meaningful for the SAME customer (a cross-customer
  // pair is already structurally blocked above, and comparing two
  // different customers' addresses is not a "same property" question at
  // all — skip the extra reads for that case).
  const sameCustomer = String(riderParent.customer_id) === String(hostParent.customer_id);
  let hostScope = null;
  if (cols.property_id && sameCustomer) {
    const rawRiderScope = await resolveSeriesPropertyScope(conn, riderParent);
    const rawHostScope = await resolveSeriesPropertyScope(conn, hostParent);
    const [riderScope, comparableHost] = await withComparableKeys(conn, [rawRiderScope, rawHostScope]);
    hostScope = comparableHost;
    const verdict = seriesPropertyVerdict(riderScope, hostScope);
    if (verdict === 'unresolved') reasons.push('property_unresolved');
    else if (verdict === 'different') reasons.push('different_property');
  }

  const latestDecision = await conn('recurring_plan_alerts')
    .where({ recurring_parent_id: riderParentId })
    .whereNotNull('resolved_at')
    .orderBy('resolved_at', 'desc')
    .orderBy('id', 'desc')
    .first('resolved_action');
  const stoppedBy = latestDecision?.resolved_action;
  if (stoppedBy === 'cancel_series' || stoppedBy === 'let_lapse') reasons.push('plan_stopped');

  // Customer gates — the shared table the write engine and the nightly
  // top-up both use (services/series-customer-eligibility.js), read-only,
  // no FOR SHARE (the engine takes one; this preview commits nothing so
  // there is nothing to serialize against). All-hits variant: the preview
  // lists every applicable gate, not just the first.
  const { SERIES_CUSTOMER_COLUMNS, seriesCustomerSkipReasons } = require('./series-customer-eligibility');
  const customer = await conn('customers').where({ id: riderParent.customer_id }).first(SERIES_CUSTOMER_COLUMNS);
  reasons.push(...seriesCustomerSkipReasons(customer));

  // Series gates — admin-schedule.js's all-hits topupAllSeriesSkipReasons
  // (annual prepay / family plan hold / duplicate active series), reused
  // READ-ONLY: no advisory lock taken (see this module's own header and
  // that export's own comment in admin-schedule.js). Passed the OVERLAID
  // rider parent (Codex P2 round #2 on PR #5290), same as
  // topUpRecurringSeriesLocked overlays parent BEFORE calling
  // topupSeriesSkipReason itself: a series-scope price/service edit
  // (recurring_template_overrides, GATE_EDIT_APPT_PRICE_SERVICE_SCOPE)
  // redirects service_id/service_type, which plan_hold's own family
  // classification and duplicate_series' own family/address match both
  // read straight off `parent` — reading the STALE raw parent here would
  // classify the series by a service it no longer is (or isn't yet), the
  // one thing this preview exists to never disagree with the top-up about.
  try {
    const { topupAllSeriesSkipReasons } = require('../routes/admin-schedule');
    // Savepoint: a failed read here must not abort the caller's
    // transaction (25P02) for every read after it.
    const seriesSkips = await conn.transaction((sp) => topupAllSeriesSkipReasons(sp, riderParent, riderParentId, cols));
    // Owner ruling 2026-09-29: an annual-prepay pest series rides the lawn
    // rhythm too. Its prepaid visits stay pinned ('prepaid'), and only the
    // visits after them join lawn dates, so the prepay refusal the top-up
    // applies doesn't apply to a rider.
    reasons.push(...seriesSkips.filter((r) => r !== 'annual_prepay_series'));
  } catch {
    reasons.push('series_check_error');
  }

  return { reasons, hostScope };
}

// Phase 3: host dates — base rows only, null-safe status, same EFFECTIVE
// property scope per row, future, not join-ineligible.
//
// Codex P1 round #2 on PR #5290: the old filter compared each child row's
// raw `property_id` against the host PARENT's own raw `property_id` column
// — stale the moment the host moved via
// `recurring_template_overrides.appointment_address` (the parent's own
// column never changes; only its EFFECTIVE, override-aware scope does, the
// same one the pair's own `different_property` gate resolves), and
// entirely skipped (every child counted, drifted or not) whenever the
// parent's raw column happened to be null. Both are fixed by resolving the
// host's effective scope ONCE (`hostScope`, evaluatePairGates — the exact
// same resolveSeriesPropertyScope call the pair gate uses, over the
// OVERLAID parent) and comparing each candidate row's own resolved scope
// (`rowPropertyScope`, above — its own property_id/service_address_*
// columns) against it with the SAME comparator, `seriesPropertyVerdict`.
// The host PARENT's own row always matches (it IS the effective scope,
// however stale its own raw columns are). A child row with no resolved
// scope of its own (no property_id, no stamped address — the ordinary case
// for most child rows) still inherits the host's scope, same as the old
// null-safe behavior; only a row whose OWN resolved scope actively
// disagrees is dropped.
// A host plan visit waiting to be rescheduled has a stale date, so it's left
// out of the host dates; but until the rebooker places it, the rider's plan
// could still change. Report it so the pair is never shown as approvable.
async function hostReschedulePending(conn, hostParent, cols) {
  const rows = await conn('scheduled_services')
    .where((q) => { q.where('id', hostParent.id).orWhere('recurring_parent_id', hostParent.id); })
    .where('status', 'rescheduled')
    .modify((q) => { if (cols.track_state) q.whereNot('track_state', 'cancelled'); })
    .select('id', 'is_recurring', 'recurring_parent_id', ...['is_callback', 'followup_included'].filter((c) => cols[c]));
  return rows.some(isPlanSeriesRow);
}

// THE live plan-row read for one or more series (roots and their cadence
// children): status outside JOIN_INELIGIBLE_STATUSES (NULL counts as live),
// tracker state not terminal, isPlanSeriesRow (no boosters, callbacks or
// included follow-ups), optionally from a date on. Shared by this preview's
// host dates and by accept-time rider seeding (rider-accept-seeding.js), so
// "which rows of a series are live" has one answer.
function livePlanSeriesRows(conn, parentIds, cols, { fromDate = null, extraColumns = [] } = {}) {
  return conn('scheduled_services')
    .where((q) => { q.whereIn('id', parentIds).orWhereIn('recurring_parent_id', parentIds); })
    .where((q) => { q.whereNull('status').orWhereNotIn('status', JOIN_INELIGIBLE_STATUSES); })
    .modify((q) => {
      if (cols.track_state) q.where((t) => { t.whereNull('track_state').orWhereNotIn('track_state', TERMINAL_TRACK_STATES); });
      if (fromDate) q.where('scheduled_date', '>=', fromDate);
    })
    .orderBy('scheduled_date', 'asc')
    .select(
      'id', 'scheduled_date', 'is_recurring', 'recurring_parent_id',
      ...['is_callback', 'followup_included'].filter((c) => cols[c]),
      ...extraColumns.filter((c) => cols[c]),
    )
    .then((rows) => rows.filter(isPlanSeriesRow));
}

// The host's live future plan rows that can carry a rider, as rows (the
// extension needs each date's window and technician): same EFFECTIVE property
// scope as the host, and each occurrence's OWN current service is lawn (a
// "this and following" service change re-stamps upcoming rows; a mosquito or
// pest row shares the lawn's visit group family but is not a lawn visit).
async function loadHostRows(conn, hostParent, cols, todayStr, hostScope) {
  const addressCols = [
    'service_address_line1', 'service_address_line2', 'service_address_city',
    'service_address_state', 'service_address_zip',
  ];
  const hostRowsRaw = await livePlanSeriesRows(conn, [hostParent.id], cols, {
    fromDate: todayStr,
    extraColumns: [
      'property_id', ...addressCols, 'window_start', 'window_end', 'technician_id',
      'service_type', 'service_key_snapshot',
    ],
  });
  // The root is classified by the overlaid hostParent (its own columns are the
  // historical first visit); a child by what it says it is now.
  let filtered = hostRowsRaw.filter((r) => isLawnServiceRow(String(r.id) === String(hostParent.id) ? hostParent : r));
  if (cols.property_id && hostScope?.resolved) {
    // One batched key lookup for the whole host series (withComparableKeys):
    // an unstamped parent's address-only scope vs id-only child rows.
    const rowScopes = filtered.map(rowPropertyScope);
    const [comparableHost, ...comparableRows] = await withComparableKeys(conn, [hostScope, ...rowScopes]);
    filtered = filtered.filter((r, i) => {
      if (String(r.id) === String(hostParent.id)) return true;
      if (!comparableRows[i].resolved) return true;
      return seriesPropertyVerdict(comparableRows[i], comparableHost) === 'same';
    });
  }
  return filtered;
}

// Phase 4: every rider row (parent + children), classified, with the
// anchor date and the reschedule-pending flag. A 'rescheduled' plan row is
// pinned (see classifyRiderRow) but explicitly excluded from anchoring —
// its date is stale, it is waiting to be replaced, not a real "last pest
// happened here" date.
// One rider row's role in the anchor decision, from its tracker-aware
// classification (never raw status: a lagging status can say 'rescheduled'
// after the tracker cancelled the visit, or 'confirmed' after it completed).
// A row anchors when it was performed, or when it's pinned and still live:
// ahead of today, or in progress (even across midnight). A cancelled,
// skipped, no-show or rescheduled status wins over a stale 'complete'
// tracker, and an overdue unperformed row never anchors.
function anchorRole(r, c, todayStr) {
  if (!isPlanSeriesRow(r)) return { reschedule: false, anchorDate: null };
  if (c.why === 'rescheduled_pending') return { reschedule: true, anchorDate: null };
  const operationallyTerminal = ['cancelled', 'skipped', 'no_show', 'rescheduled'].includes(r.status);
  const performed = !operationallyTerminal && (r.track_state === 'complete'
    || (r.status === 'completed' && !TERMINAL_TRACK_STATES.includes(r.track_state)));
  const d = dateOnly(r.scheduled_date);
  const pinnedLive = c.pinned === true && c.why !== 'overdue'
    && ((d != null && d >= todayStr) || c.why === 'in_progress');
  return { reschedule: false, anchorDate: (performed || pinnedLive) ? d : null };
}

async function classifyRiderRows(conn, riderParentId, riderParent, todayStr) {
  const riderRows = await conn('scheduled_services')
    .where((q) => { q.where('id', riderParentId).orWhere('recurring_parent_id', riderParentId); })
    .select('*');
  const reasonMap = await attributeReasonMap(conn, riderRows.map((r) => r.id));
  const nearTermCutoff = addDaysStr(todayStr, NEAR_TERM_DAYS);

  let lastRiderDate = null;
  let reschedulePending = false;
  const classifications = new Map();
  for (const r of riderRows) {
    const c = classifyRiderRow(r, reasonMap, nearTermCutoff, todayStr);
    classifications.set(r.id, c);
    const { reschedule, anchorDate } = anchorRole(r, c, todayStr);
    if (reschedule) reschedulePending = true;
    if (anchorDate && (!lastRiderDate || anchorDate > lastRiderDate)) lastRiderDate = anchorDate;
  }
  // Codex P2 round #2 on PR #5290: when the RIDER PARENT ROW ITSELF is the
  // one awaiting reschedule (status 'rescheduled') and nothing else in the
  // series anchors, its own `scheduled_date` is exactly the stale date it
  // is waiting to be moved off of — the same reason a rescheduled CHILD row
  // never anchors (see classifyRiderRow's own comment). Falling back to it
  // here would silently reintroduce that stale date as "when this last
  // actually happened." No other anchor-eligible row at all means no
  // anchor — previewRiderPair reports `no_anchor` alongside
  // `rider_reschedule_pending` rather than planning off a date that was
  // never really kept.
  // The parent's own date is the fallback anchor only for a brand-new
  // series whose first visit is still live. A skipped, no-show, cancelled or
  // rescheduled parent never happened on that date, so it never anchors
  // (completed already anchored above).
  // An overdue parent (still pending/confirmed, dated before today) never
  // happened either, so it can't be the fallback anchor.
  const parentClass = classifications.get(riderParent.id);
  const parentAnchorable = !JOIN_INELIGIBLE_STATUSES.includes(riderParent.status)
    && !TERMINAL_TRACK_STATES.includes(riderParent.track_state)
    && !(parentClass && parentClass.why === 'overdue');
  if (!lastRiderDate && parentAnchorable) lastRiderDate = dateOnly(riderParent.scheduled_date);
  return {
    riderRows, classifications, lastRiderDate, reschedulePending,
  };
}

/**
 * Read-only preview of ONE rider/host pairing — computable whether or not
 * `scheduled_services.rides_parent_id` is actually set (only accept-time
 * rider seeding writes it, behind GATE_PEST_RIDES_LAWN_AT_ACCEPT): pass
 * `hostParentId` explicitly to preview a CANDIDATE pair the ops
 * report found by its own heuristic (same customer, same property, an
 * active ongoing lawn series + an active ongoing pest series), or omit it
 * to read the rider's own already-stamped link.
 *
 * Never throws for an ordinary ineligible/incomplete pair — every reason
 * lands in `reasons`. Returns `{ eligible: false, reasons: ['error'] }`
 * only if a read itself fails (fails closed, same posture as the write
 * engine's own top-level catch).
 *
 * `reasons` collects EVERY applicable pair/customer/series gate (not just
 * the first, unlike the write engine's own short-circuiting skip check) so
 * an office list can show every reason a pair is blocked, not just one.
 * Plan computation (anchor/horizon/plan/keep/move/insert/cancel/pinned) is
 * skipped only for the STRUCTURAL_BLOCKERS — reasons that make "the plan"
 * meaningless, not merely "the office wouldn't act on it today" — so a
 * pair blocked only by a policy gate (customer held, duplicate series, an
 * unresolved plan_stopped decision, a rider row awaiting reschedule, …)
 * still shows what the plan WOULD be.
 *
 * @param {import('knex').Knex | import('knex').Knex.Transaction} conn
 * @param {{riderParentId: string, hostParentId?: string}} args
 * @returns {Promise<{eligible: boolean, reasons: string[], anchor: ?string,
 *   planFloor: ?string, horizon: ?string, plan: string[], keep: Array,
 *   move: Array, insert: string[], cancel: Array,
 *   retained: Array<{id: string, date: string}>,
 *   beyondSchedule: Array<{id: string, date: string}>,
 *   pinned: Array<{id: string, date: ?string, why: string}>,
 *   hostRows: Array<object>}>}
 */
async function previewRiderPair(conn, { riderParentId, hostParentId } = {}) {
  const empty = (reasons) => ({
    eligible: false,
    reasons,
    anchor: null,
    planFloor: null,
    horizon: null,
    plan: [],
    keep: [],
    move: [],
    insert: [],
    cancel: [],
    retained: [],
    beyondSchedule: [],
    pinned: [],
    hostRows: [],
  });

  try {
    const loaded = await loadPairContext(conn, riderParentId, hostParentId);
    if (loaded.blocked) return empty([loaded.blocked]);
    const { cols, riderParent, hostParent } = loaded;

    const { reasons, hostScope } = await evaluatePairGates(conn, loaded);
    if (reasons.some((r) => STRUCTURAL_BLOCKERS.has(r))) return empty(reasons);

    // --- Plan computation (read-only, same rules as buildRiderSyncPlan) ---
    const todayStr = etDateString();
    const hostRows = await loadHostRows(conn, hostParent, cols, todayStr, hostScope);
    const hostDates = Array.from(new Set(hostRows.map((r) => dateOnly(r.scheduled_date)).filter(Boolean))).sort();
    if (await hostReschedulePending(conn, hostParent, cols)) reasons.push('host_reschedule_pending');
    const {
      riderRows, classifications, lastRiderDate, reschedulePending,
    } = await classifyRiderRows(conn, riderParentId, riderParent, todayStr);
    if (reschedulePending) reasons.push('rider_reschedule_pending');
    const pinnedRows = () => riderRows
      .map((r) => ({ row: r, c: classifications.get(r.id) }))
      .filter(({ c }) => c && c.pinned === true)
      .map(({ row, c }) => ({ id: row.id, date: dateOnly(row.scheduled_date), why: c.why }));
    // No anchor: the plan stays empty, but the live pinned visits (e.g. a
    // rescheduled_pending row) are still reported.
    if (!lastRiderDate) { reasons.push('no_anchor'); return { ...empty(reasons), pinned: pinnedRows() }; }

    const futureMovable = riderRows.filter((r) => {
      const c = classifications.get(r.id);
      return c && c.movable === true && dateOnly(r.scheduled_date) >= todayStr;
    });
    const movableRows = futureMovable.filter((r) => dateOnly(r.scheduled_date) > lastRiderDate);
    // Movable visits dated on or before the anchor (a later visit is pinned)
    // are left where they are. Report them so every future visit appears in
    // exactly one list.
    const retained = futureMovable
      .filter((r) => dateOnly(r.scheduled_date) <= lastRiderDate)
      .map((r) => ({ id: r.id, date: dateOnly(r.scheduled_date) }));

    const nearTermCutoff = addDaysStr(todayStr, NEAR_TERM_DAYS);
    const planFloor = addDaysStr(nearTermCutoff, 1);
    const standaloneAnchor = lastRiderDate > planFloor ? lastRiderDate : planFloor;
    const horizonDate = computeRiderHorizon(standaloneAnchor, hostDates, riderParent.recurring_pattern);

    const { customerPrefersNoWeekends } = require('./recurring-appointment-seeder');
    const skipRiderStamp = !!riderParent.skip_weekends;
    const skipRiderEffective = skipRiderStamp || await customerPrefersNoWeekends(conn, riderParent.customer_id);
    const weekendShift = riderParent.weekend_shift === 'back' ? 'back' : 'forward';

    // Owner blackout days — same shared read-only lookup every series
    // generator uses. A read error still plans (without blackout clearing)
    // but adds blackout_check_error, so the pair is never shown as eligible.
    let blackoutDates = null;
    try {
      const from = standaloneAnchor < todayStr ? standaloneAnchor : todayStr;
      const to = horizonDate > from ? horizonDate : from;
      blackoutDates = await conn.transaction((sp) => getBlackoutLayers(from, to, sp));
    } catch {
      // The plan still computes (without blackout clearing), but the pair is
      // flagged so the office never approves dates it couldn't check.
      blackoutDates = null;
      reasons.push('blackout_check_error');
    }

    // A lawn date the rider cannot take (an owner blackout, a weekend the rider
    // opted out of) is not a candidate: the plan goes on to the next lawn date.
    // The horizon above still counts every lawn date.
    const usableHost = (r) => !isBlackedOut(dateOnly(r.scheduled_date), blackoutDates)
      && shiftPastWeekend(dateOnly(r.scheduled_date), skipRiderEffective, weekendShift) === dateOnly(r.scheduled_date);
    const rideHostRows = hostRows.filter(usableHost);
    const plan = planRiderDates({
      hostDates: rideHostRows.map((r) => dateOnly(r.scheduled_date)),
      lastRiderDate,
      horizonDate,
      earliestDate: planFloor,
      skipWeekends: skipRiderEffective,
      weekendShift,
      blackoutDates,
      gaps: riderGapsFor(riderParent.recurring_pattern),
    });

    // Movable visits after the horizon (the last scheduled lawn date, or the
    // rider's own bounded horizon) aren't surplus: they'd join lawn dates
    // once lawn is extended. Report them as beyond the lawn schedule, never
    // as cancellations.
    const beyondSchedule = movableRows
      .filter((r) => dateOnly(r.scheduled_date) > horizonDate)
      .map((r) => ({ id: r.id, date: dateOnly(r.scheduled_date) }));
    const diff = diffPlan(plan, movableRows.filter((r) => dateOnly(r.scheduled_date) <= horizonDate));
    const pinned = pinnedRows();

    return {
      eligible: reasons.length === 0,
      reasons,
      anchor: lastRiderDate,
      planFloor,
      horizon: horizonDate,
      plan,
      keep: diff.keep,
      move: diff.move,
      insert: diff.insert,
      cancel: diff.cancel,
      retained,
      beyondSchedule,
      pinned,
      hostRows: rideHostRows,
    };
  } catch (err) {
    return {
      eligible: false,
      reasons: ['error'],
      anchor: null,
      planFloor: null,
      horizon: null,
      plan: [],
      keep: [],
      move: [],
      insert: [],
      cancel: [],
      retained: [],
      beyondSchedule: [],
      pinned: [],
      hostRows: [],
      error: err.message,
    };
  }
}

module.exports = {
  MIN_GAP_DAYS,
  TARGET_GAP_DAYS,
  MAX_WAIT_DAYS,
  NEAR_TERM_DAYS,
  OVERDUE_WAIT_DAYS,
  MAX_HORIZON_EXTRA_DAYS,
  planRiderDates,
  riderGapsFor,
  computeRiderHorizon,
  riderHostKind,
  riderPairingEnabled,
  isLawnServiceRow,
  RIDE_BLOCKING_REASONS,
  livePlanSeriesRows,
  previewRiderPair,
  resolveSeriesPropertyScope,
  seriesPropertyVerdict,
  withComparableKeys,
  _internals: {
    dateOnly, addDaysStr, classifyRiderRow, diffPlan, attributeReasonMap, computeRiderHorizon, nextRiderDate, rowPropertyScope,
  },
};
