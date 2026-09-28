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
 * Nothing in this repository sets `scheduled_services.rides_parent_id` yet
 * (schema-only migration 20260928220000_scheduled_services_rides_parent —
 * see its own header) and nothing calls `previewRiderPair` from any hook,
 * cron, or writer. It is reached ONLY from
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
const { LIVE_COMPLETION_CLAIM_STATUSES } = require('./visit-groups');
const { getBlackoutLayers } = require('./scheduling/blackout-dates');
const { clearOfBlackout } = require('./scheduling/blackout-nudge');

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
  'cross_customer', 'not_recurring',
]);

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
  const standaloneHorizon = addDaysStr(anchorDate, gaps * TARGET_GAP_DAYS);
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

/**
 * Pure date rule — no DB access. Byte-identical to the write engine's own
 * planRiderDates (services/rider-series.js) — see that function's own
 * header for the full parameter contract ("Date rule" in the design doc).
 */
function planRiderDates({
  hostDates = [], lastRiderDate, horizonDate, skipWeekends = false, weekendShift = 'forward',
  earliestDate = null, blackoutDates = null,
} = {}) {
  const anchor = dateOnly(lastRiderDate);
  const horizon = dateOnly(horizonDate);
  const floor = dateOnly(earliestDate);
  const dates = [];
  if (!anchor || !horizon) return dates;
  const sortedHosts = Array.from(new Set((hostDates || []).map(dateOnly).filter(Boolean))).sort();
  const dir = weekendShift === 'back' ? 'back' : 'forward';

  let last = anchor;
  for (let guard = 0; guard < 1000; guard++) {
    let minDate = addDaysStr(last, MIN_GAP_DAYS);
    let maxDate = addDaysStr(last, MAX_WAIT_DAYS);
    if (!minDate || !maxDate) break;
    const overdue = !!floor && minDate < floor;
    if (overdue) {
      minDate = floor;
      maxDate = addDaysStr(floor, OVERDUE_WAIT_DAYS);
    }
    const hostCandidate = sortedHosts.find((d) => d >= minDate);
    let next;
    if (hostCandidate && hostCandidate <= maxDate) {
      next = hostCandidate;
    } else {
      const base = overdue ? floor : addDaysStr(last, TARGET_GAP_DAYS);
      next = shiftPastWeekend(base, skipWeekends, dir);
      if (floor && next && next < floor) next = shiftPastWeekend(base, skipWeekends, 'forward');
      if (next && blackoutDates) next = clearOfBlackout(next, blackoutDates, { skipWeekends });
    }
    if (!next || next <= last) break;
    if (next > horizon) break;
    dates.push(next);
    last = next;
  }
  return dates;
}

// Batched "is this rider row pinned by a durable record" lookup — same
// tables and same DEAD/NON_PINNING exclusions the write engine's
// immovableRowIdSet applies, but returns WHICH category matched (for the
// preview's own `pinned[].why`) instead of a flat boolean set. Read-only:
// plain SELECTs, no lock of any kind.
async function messagedRowIds(conn, ids) {
  return conn('messaging_audit_log')
    .whereIn('appointment_id', ids.map(String))
    .whereNotIn('purpose', NON_PINNING_MESSAGE_PURPOSES)
    .whereNotNull('sent_at')
    .pluck('appointment_id');
}

async function attributeReasonMap(conn, rowIds) {
  const ids = (rowIds || []).filter(Boolean);
  const map = new Map();
  if (!ids.length) return map;
  const [
    invoiced, cardHeld, cardRequested, packeted, completionClaims, messagedRows,
  ] = await Promise.all([
    conn('invoices').whereIn('scheduled_service_id', ids).pluck('scheduled_service_id'),
    conn('estimate_card_holds').whereIn('scheduled_service_id', ids)
      .whereNotIn('status', DEAD_CARD_STATUSES).pluck('scheduled_service_id'),
    conn('appointment_card_requests').whereIn('scheduled_service_id', ids)
      .whereNotIn('status', DEAD_CARD_STATUSES).pluck('scheduled_service_id'),
    conn('visit_completion_packet_items').whereIn('scheduled_service_id', ids).pluck('scheduled_service_id'),
    conn('service_completion_attempts').whereIn('service_id', ids)
      .whereIn('status', LIVE_COMPLETION_CLAIM_STATUSES).pluck('service_id'),
    messagedRowIds(conn, ids),
  ]);
  // Priority order only matters for which SINGLE `why` a row reports when
  // more than one applies — every category still independently pins the
  // row either way.
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
// {booster:true} (never a move/cancel/anchor candidate), {pinned:true, why}
// (a live row that cannot move, with the reason), or {movable:true}.
// Byte-identical rule set to the write engine's immovableByOwnFields +
// attributeImmovable + near-term cutoff (services/rider-series.js), with
// one addition the design doc calls for: a NULL-status row (a legacy base
// row with no stamped status) is reported pinned with why: 'null_status'
// rather than silently falling through every check — the write engine
// achieves the same "never movable" outcome for it implicitly (it's
// outside MOVABLE_ROW_STATUSES), but the preview's job is to SHOW why, not
// just to leave it out.
function classifyRiderRow(row, reasonMap, nearTermCutoff) {
  if (JOIN_INELIGIBLE_STATUSES.includes(row.status)) return { terminal: true };
  if (row.is_recurring !== true) return { booster: true };
  if (IN_PROGRESS_STATUSES.includes(row.status)) return { pinned: true, why: 'in_progress' };
  if (row.prepaid_amount != null) return { pinned: true, why: 'prepaid' };
  if (row.customer_confirmed === true) return { pinned: true, why: 'customer_confirmed' };
  if (row.field_confirmed_at != null) return { pinned: true, why: 'field_confirmed' };
  if (row.visit_id != null) return { pinned: true, why: 'visit_id' };
  if (row.arrival_sms_sent_at != null) return { pinned: true, why: 'arrival_sms_sent' };
  if (row.prep_sent_at != null) return { pinned: true, why: 'prep_sent' };
  if (reasonMap.has(row.id)) return { pinned: true, why: reasonMap.get(row.id) };
  if (row.status == null) return { pinned: true, why: 'null_status' };
  const d = dateOnly(row.scheduled_date);
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
    .sort((a, b) => dateOnly(a.scheduled_date).localeCompare(dateOnly(b.scheduled_date)));

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

/**
 * Read-only preview of ONE rider/host pairing — computable whether or not
 * `scheduled_services.rides_parent_id` is actually set (nothing writes it
 * yet): pass `hostParentId` explicitly to preview a CANDIDATE pair the ops
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
 * unresolved plan_stopped decision, …) still shows what the plan WOULD be.
 *
 * @param {import('knex').Knex | import('knex').Knex.Transaction} conn
 * @param {{riderParentId: string, hostParentId?: string}} args
 * @returns {Promise<{eligible: boolean, reasons: string[], anchor: ?string,
 *   planFloor: ?string, horizon: ?string, plan: string[], keep: Array,
 *   move: Array, insert: string[], cancel: Array,
 *   pinned: Array<{id: string, date: ?string, why: string}>}>}
 */
async function previewRiderPair(conn, { riderParentId, hostParentId } = {}) {
  const reasons = [];
  const empty = () => ({
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
    pinned: [],
  });

  try {
    if (!riderParentId) { reasons.push('rider_not_found'); return empty(); }

    const cols = await conn('scheduled_services').columnInfo();
    const riderParent = await conn('scheduled_services').where({ id: riderParentId }).first();
    if (!riderParent) { reasons.push('rider_not_found'); return empty(); }

    const resolvedHostId = hostParentId || riderParent.rides_parent_id;
    if (!resolvedHostId) { reasons.push('not_a_rider'); return empty(); }

    if (String(resolvedHostId) === String(riderParentId)) reasons.push('self_link');

    const hostParent = await conn('scheduled_services').where({ id: resolvedHostId }).first();
    if (!hostParent) { reasons.push('host_missing'); return empty(); }

    if (String(riderParent.customer_id) !== String(hostParent.customer_id)) reasons.push('cross_customer');
    if (hostParent.rides_parent_id) reasons.push('host_is_rider');
    if (riderParent.recurring_parent_id) reasons.push('not_series_root');
    if (!riderParent.is_recurring || !riderParent.recurring_pattern) reasons.push('not_recurring');
    const riderOngoing = cols.recurring_ongoing ? !!riderParent.recurring_ongoing : false;
    if (!riderOngoing) reasons.push('not_ongoing');
    if (cols.property_id && hostParent.property_id && riderParent.property_id
      && String(hostParent.property_id) !== String(riderParent.property_id)) {
      reasons.push('different_property');
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
    // there is nothing to serialize against).
    const { SERIES_CUSTOMER_COLUMNS, seriesCustomerSkipReason } = require('./series-customer-eligibility');
    const customer = await conn('customers').where({ id: riderParent.customer_id }).first(SERIES_CUSTOMER_COLUMNS);
    const customerSkip = seriesCustomerSkipReason(customer);
    if (customerSkip) reasons.push(customerSkip);

    // Series gates — admin-schedule.js's topupSeriesSkipReason (annual
    // prepay / family plan hold / duplicate active series), reused
    // READ-ONLY: no advisory lock taken (see this module's own header and
    // that export's own comment in admin-schedule.js).
    try {
      const { topupSeriesSkipReason } = require('../routes/admin-schedule');
      const seriesSkip = await topupSeriesSkipReason(conn, riderParent, riderParentId, cols);
      if (seriesSkip) reasons.push(seriesSkip);
    } catch {
      reasons.push('series_check_error');
    }

    const structurallyBlocked = reasons.some((r) => STRUCTURAL_BLOCKERS.has(r));
    if (structurallyBlocked) return empty();

    // --- Plan computation (read-only, same rules as buildRiderSyncPlan) ---
    const todayStr = etDateString();

    const hostRowsRaw = await conn('scheduled_services')
      .where((q) => { q.where('id', hostParent.id).orWhere('recurring_parent_id', hostParent.id); })
      .where('is_recurring', true)
      .where((q) => { q.whereNull('status').orWhereNotIn('status', JOIN_INELIGIBLE_STATUSES); })
      .where('scheduled_date', '>=', todayStr)
      .modify((q) => {
        // "same property per row" (design doc) — a host recurring-child row
        // whose own property_id has drifted from the host parent's is never
        // read as a host date, the same per-row property guard the pair
        // gate above applies at the parent level.
        if (cols.property_id && hostParent.property_id) {
          q.where((qq) => { qq.whereNull('property_id').orWhere('property_id', hostParent.property_id); });
        }
      })
      .orderBy('scheduled_date', 'asc')
      .select('id', 'scheduled_date');
    const hostDates = Array.from(new Set(hostRowsRaw.map((r) => dateOnly(r.scheduled_date)).filter(Boolean))).sort();

    // Plain read, no lock — this preview never writes, so there is nothing
    // to guard a snapshot against.
    const riderRows = await conn('scheduled_services')
      .where((q) => { q.where('id', riderParentId).orWhere('recurring_parent_id', riderParentId); })
      .select('*');

    const reasonMap = await attributeReasonMap(conn, riderRows.map((r) => r.id));
    const nearTermCutoff = addDaysStr(todayStr, NEAR_TERM_DAYS);

    let lastRiderDate = null;
    const classifications = new Map();
    for (const r of riderRows) {
      const c = classifyRiderRow(r, reasonMap, nearTermCutoff);
      classifications.set(r.id, c);
      if (r.is_recurring === true && (r.status === 'completed' || c.pinned === true)) {
        const d = dateOnly(r.scheduled_date);
        if (d && (!lastRiderDate || d > lastRiderDate)) lastRiderDate = d;
      }
    }
    if (!lastRiderDate) lastRiderDate = dateOnly(riderParent.scheduled_date);
    if (!lastRiderDate) { reasons.push('no_anchor'); return empty(); }

    const movableRows = riderRows.filter((r) => {
      const c = classifications.get(r.id);
      return c && c.movable === true
        && dateOnly(r.scheduled_date) >= todayStr
        && dateOnly(r.scheduled_date) > lastRiderDate;
    });

    const planFloor = addDaysStr(nearTermCutoff, 1);
    const standaloneAnchor = lastRiderDate > planFloor ? lastRiderDate : planFloor;
    const horizonDate = computeRiderHorizon(standaloneAnchor, hostDates, riderParent.recurring_pattern);

    const { customerPrefersNoWeekends } = require('./recurring-appointment-seeder');
    const skipRiderStamp = !!riderParent.skip_weekends;
    const skipRiderEffective = skipRiderStamp || await customerPrefersNoWeekends(conn, riderParent.customer_id);
    const weekendShift = riderParent.weekend_shift === 'back' ? 'back' : 'forward';

    // Owner blackout days — same shared read-only lookup every series
    // generator uses; fails open (null) on a read error, same posture as
    // every other blackout consumer in this codebase.
    let blackoutDates = null;
    try {
      const from = standaloneAnchor < todayStr ? standaloneAnchor : todayStr;
      const to = horizonDate > from ? horizonDate : from;
      blackoutDates = await getBlackoutLayers(from, to, conn);
    } catch { blackoutDates = null; }

    const plan = planRiderDates({
      hostDates,
      lastRiderDate,
      horizonDate,
      earliestDate: planFloor,
      skipWeekends: skipRiderEffective,
      weekendShift,
      blackoutDates,
    });

    const diff = diffPlan(plan, movableRows);
    const pinned = riderRows
      .map((r) => ({ row: r, c: classifications.get(r.id) }))
      .filter(({ c }) => c && c.pinned === true)
      .map(({ row, c }) => ({ id: row.id, date: dateOnly(row.scheduled_date), why: c.why }));

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
      pinned,
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
      pinned: [],
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
  computeRiderHorizon,
  previewRiderPair,
  _internals: {
    dateOnly, addDaysStr, classifyRiderRow, diffPlan, attributeReasonMap, computeRiderHorizon,
  },
};
