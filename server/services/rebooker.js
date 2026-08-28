const crypto = require('crypto');
const db = require('../models/db');
const RULES = require('../config/reschedule-rules');
const logger = require('./logger');
const { scheduledServiceTrackTokenExpiry } = require('./track-token-expiry');
const { clearTechCurrentJob } = require('./tech-status');
const { shiftCallFollowUpsForParentMove } = require('./call-booking-catalog');
const { findConflictingVisits, acquireOccupancyLock, acquireOccupancyLocks } = require('./scheduling/occupancy');
const { getIo } = require('../sockets');
const {
  parseETDateTime, etParts, etDateString, addETDays,
  addETMonthsByWeekday, etNthWeekdayOfMonth, sameDayWindowElapsed,
  deriveWindowEnd, windowDurationMinutes,
} = require('../utils/datetime-et');

// The window ONE series occurrence lands on, from ITS OWN stored window /
// duration: a start-only move derives each occurrence's end from its own
// span (stored span → estimated_duration_minutes → 60) — never the anchor's
// — so a 60-min and a 120-min sibling each keep their span; a full window
// applies as given; no window keeps the row's own. With
// options.adminWindowRules (the dispatch route) every landing window is
// run through the shared admin validator (scheduling/window-rules.js) and a
// single failing occurrence — e.g. a legacy 07:00 sibling — aborts the
// whole series (422, inside the trx, nothing moved).
function seriesOccurrenceWindow(win, sib, options = {}) {
  const sibDuration = windowDurationMinutes(sib.window_start, sib.window_end, sib.estimated_duration_minutes);
  const start = win.start || sib.window_start || null;
  let end = win.end || null;
  // A null end that survives the toggle below must be PERSISTED null: the
  // validator derives a temporary end from the duration to judge the block,
  // and that derived value must never leak back onto the row when the
  // rollback switch says "keep the legacy null" (a revert toggle outranks a
  // derivation).
  let endStaysNull = false;
  if (!end) {
    // REBOOKER_NULL_END_OCCUPANCY=off is the rollback toggle for null-end
    // derivation — it outranks this derivation too (legacy: keep the row's
    // own end, null included).
    const deriveNullEnd = process.env.REBOOKER_NULL_END_OCCUPANCY !== 'off';
    end = (win.start && deriveNullEnd) ? deriveWindowEnd(win.start, sibDuration) : (sib.window_end || null);
    endStaysNull = !end;
  }
  if (options.adminWindowRules === true && (start || end)) {
    const { assertAdminAppointmentWindow } = require('./scheduling/window-rules');
    // windowEnd null → the validator derives a TEMPORARY end from the
    // occurrence's own duration purely to run end > start / end <= day end.
    const normalized = assertAdminAppointmentWindow({ windowStart: start, windowEnd: end, durationMinutes: sibDuration });
    // Persist the normalized pair only when this move sets a window; a
    // no-window move keeps the row's own (validated) values untouched.
    if (win.start) return { start: normalized.window_start, end: endStaysNull ? null : normalized.window_end };
  }
  return { start, end };
}

// Seasonal mosquito cadence lives in the seeder — single source of truth for
// the Feb-Oct walk, so this file's own nextRecurringDate cannot drift from it.
const { SEASONAL_FEB_OCT, seasonalFebOctDate, clampDateToSeason, customerPrefersNoWeekends } = require('./recurring-appointment-seeder');

// Series sibling-projection clash horizon (rescheduleSeries): a shifted
// FUTURE occurrence only hard-aborts the sweep when its recomputed date
// lands within this many days of today. Beyond it the calendar is
// placeholder-land — the recurring seeder itself commits overlapping
// 12:00–13:00 placeholder rows months out, and auto-dispatch/admin re-place
// stops as their dates approach — so a far-future "clash" is not a real
// double-booking. Hard-aborting on one made most self-serve series
// reschedules impossible for customers with a second plan (2026-08-14 field
// report: every offered slot 409'd because a projection collided with a
// seeded placeholder 6 months out). The ANCHOR row — the visit the customer
// actually picked — is always hard-checked regardless of this horizon, as
// are siblings landing inside it, and so is ANY sibling whose occupant is
// not positively a seeded placeholder (isSeededPlaceholderRow). A
// beyond-horizon placeholder overlap commits at its cadence date WITHOUT a
// window (no occupancy — never two occupying rows) and is flagged
// (`conflicted`) so route callers can park an admin retiming notification.
const SERIES_SIBLING_CLASH_HORIZON_DAYS = Math.max(
  1,
  Number(process.env.REBOOKER_SIBLING_CLASH_HORIZON_DAYS) || 60
);

// True when a projected sibling date is close enough to today that an
// occupancy overlap there is a real double-booking (see the horizon const).
function siblingClashWithinHorizon(dateStr) {
  const horizonEnd = etDateString(addETDays(new Date(), SERIES_SIBLING_CLASH_HORIZON_DAYS));
  return String(dateStr).split('T')[0] <= horizonEnd;
}

// A conflicting row is a SEEDED PLACEHOLDER — disposable for the
// beyond-horizon rule — only when it is positively identified as one: a
// recurring child the seeder wrote (is_recurring + recurring_parent_id)
// that is still `pending` and was never customer-confirmed, and is not a
// live estimate hold. Anything else on the window (a one-off booking, a
// confirmed/dispatched occurrence, a hold) is a real appointment and the
// series sweep must still abort on it regardless of horizon.
function isSeededPlaceholderRow(row) {
  return Boolean(row)
    && row.is_recurring === true
    && !!row.recurring_parent_id
    && row.status === 'pending'
    && !row.customer_confirmed
    && !row.reservation_expires_at;
}

// Patterns whose dates are month-anchored (nth-weekday semantics): a series
// re-anchor must recompute and persist recurring_nth/recurring_weekday from
// the new anchor date, or moving the anchor to a new weekday would keep
// projecting siblings on the OLD weekday. seasonal_feb_oct qualifies —
// seasonalFebOctDate resolves via the same nth/weekday month math. Exported
// for tests.
function isMonthBasedRecurrence(pattern) {
  return pattern === 'monthly_nth_weekday' || pattern === SEASONAL_FEB_OCT
    || !!MONTH_RECURRENCE_INTERVALS[pattern];
}

const MONTH_RECURRENCE_INTERVALS = {
  monthly: 1, bimonthly: 2, quarterly: 3, triannual: 4,
  semiannual: 6, biannual: 6, annual: 12, yearly: 12,
};

const RESCHEDULABLE_STATUSES = new Set(['pending', 'confirmed', 'rescheduled']);

// Live lifecycle states a staff-initiated reschedule may override via
// options.allowLive (rain starts while en route, customer calls to push
// the visit while the tech is on site). Terminal states (completed /
// cancelled / skipped) stay non-reschedulable on every path.
const LIVE_OVERRIDE_STATUSES = new Set(['en_route', 'on_site']);

// Collective series moves (owner rulings 2026-07-30 "the schedule follows the
// last treatment" + 2026-08-28 "any and all recurring appts move with their
// sister appts"): once GATE_ADMIN_COLLECTIVE_MOVE is on, EVERY date move of a
// cadence visit that reaches reschedule() shifts its future siblings too —
// the choke point in reschedule() delegates to rescheduleSeries, so each
// caller (dispatch drag, edit modal, SMS reply, IB tool, …) inherits the rule
// instead of re-implementing it. Callers whose moves are NOT intent
// (auto-dispatch nudges) or that govern series scope themselves (rain-out's
// post-series fallback, the customer web page's disclosed scope) pass
// options.seriesPolicy = 'single'. Kill = unset the gate.
function collectiveMoveGateOn() {
  return process.env.GATE_ADMIN_COLLECTIVE_MOVE === 'true';
}

function dateOnly(v) {
  if (v == null || v === '') return null;
  return String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
}

// Whole calendar days between two YYYY-MM-DD strings (UTC-anchored so DST
// never yields a fractional day) — the delta a date exception shifts by.
// A cadence row's position in its series: the cadence date it deviated
// from when it is a date exception, else its own date.
function seriesPosition(row) {
  return dateOnly(row.date_exception === true && row.date_exception_cadence_date
    ? row.date_exception_cadence_date
    : row.scheduled_date);
}

function calendarDaysBetween(fromStr, toStr) {
  const [fy, fm, fd] = String(fromStr).split('-').map(Number);
  const [ty, tm, td] = String(toStr).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// Everything a later Undo needs to put a row back exactly as it was (restore
// recorded state, never a negative delta) — plus updated_at, the version stamp
// that lets Undo refuse a row somebody edited after the move.
const SERIES_MOVE_SNAPSHOT_COLUMNS = [
  'scheduled_date', 'window_start', 'window_end', 'status', 'technician_id',
  'route_order', 'time_window', 'window_display', 'track_token_expires_at',
  'date_exception', 'date_exception_source', 'date_exception_at', 'date_exception_cadence_date', 'updated_at',
];

// The columns a this-visit-only DATE move of a cadence row stamps (staff,
// customer, SMS reply, IB tool, bulk board move — every raw mover uses this
// same stamp): the row is a deliberate exception to its series, and its
// cadence POSITION is the date it deviated from — kept across repeated
// single moves so the sweep still orders it by where it belongs in the
// series. Auto-dispatch nudges are placement, not intent: no stamp.
function dateExceptionStamp(row, source) {
  if (!row || row.is_recurring !== true || source === 'auto_dispatch') return {};
  return {
    date_exception: true,
    date_exception_source: source,
    date_exception_at: new Date(),
    date_exception_cadence_date: row.date_exception === true && row.date_exception_cadence_date
      ? dateOnly(row.date_exception_cadence_date)
      : dateOnly(row.scheduled_date),
  };
}
const DATE_EXCEPTION_CLEAR = {
  date_exception: false, date_exception_source: null, date_exception_at: null, date_exception_cadence_date: null,
};
function snapshotRow(row) {
  const out = {};
  for (const col of SERIES_MOVE_SNAPSHOT_COLUMNS) {
    const v = row[col];
    if (v instanceof Date) {
      out[col] = col === 'scheduled_date' ? v.toISOString().slice(0, 10) : v.toISOString();
    } else if (v && typeof v === 'object') {
      // A knex Raw (track_token_expires_at is computed in SQL) is an
      // expression, not a value — the persisted value comes back through
      // RETURNING and overlays this; null only when the driver returned none.
      out[col] = null;
    } else {
      out[col] = v === undefined ? null : v;
    }
  }
  return out;
}

// Series retry identity. A client-minted operationKey wins. Without one the
// key is derived from IMMUTABLE request data — this anchor, the target date,
// the requested start — never from the anchor's current date (which already
// equals the target once the first attempt committed, so a retry would mint
// a different key and shift/skip wrongly). Derived keys are honored only
// within a short retry horizon: a genuine later move of the same visit to
// the same slot is a new action, and its predecessor with that key is marked
// superseded before the new row claims the unique index.
const SERIES_RETRY_HORIZON_MS = 10 * 60 * 1000;
function seriesOperationKey(serviceId, newDate, newWindow, options = {}) {
  const win = parseWindow(newWindow);
  const hm = (t) => (t ? String(t).slice(0, 5) : '-');
  // Every request dimension the move writes — date, start AND end (an
  // end-only correction to a just-moved slot is a different request), plus
  // an explicit anchor clear — so only a true repeat matches. Stored on the
  // row as request_key; a client-minted operation_key replays only the
  // identical request.
  const requestKey = `${serviceId}:${dateOnly(newDate)}:${hm(win.start)}:${hm(win.end)}${options.clearAnchorWindow === true ? ':clear' : ''}`;
  if (typeof options.operationKey === 'string' && options.operationKey) {
    return { key: options.operationKey, derived: false, requestKey };
  }
  return { key: requestKey, derived: true, requestKey };
}
// A replay additionally requires the anchor to still sit exactly where the
// committed move left it (date + window from its recorded occurrence).
function priorStillCurrent(prior, service) {
  const occ = (prior.result?.rescheduledOccurrences || []).find((o) => String(o.id) === String(service.id))
    || (Array.isArray(prior.rows) ? prior.rows.find((r) => String(r.id) === String(service.id)) : null);
  const after = occ ? { date: occ.date ?? occ.after?.scheduled_date, start: occ.windowStart ?? occ.after?.window_start, end: occ.windowEnd ?? occ.after?.window_end } : null;
  if (!after) return false;
  const hm = (t) => (t ? String(t).slice(0, 5) : null);
  return dateOnly(after.date) === dateOnly(service.scheduled_date)
    && hm(after.start) === hm(service.window_start)
    && hm(after.end) === hm(service.window_end);
}
// A derived-key match whose anchor has since changed is a STALE retry: it
// must never fall through and apply its old window as a single edit.
// `observed` (optional out-param): receives the newest committed row the
// lookup saw (or null) BEFORE any decision, so a later transactional
// conflict can tell a row committed concurrently with this attempt from
// the row this attempt already judged (see findConcurrentSeriesMoveWinner).
async function findPriorSeriesMove(conn, serviceId, { key, derived, requestKey }, service = null, newDate = null, expect = null, observed = null) {
  const q = conn('series_moves').where({ anchor_service_id: serviceId, operation_key: key, status: 'committed' });
  if (derived) q.where('created_at', '>', new Date(Date.now() - SERIES_RETRY_HORIZON_MS));
  const prior = await q.orderBy('created_at', 'desc').first();
  if (observed) observed.row = prior || null;
  if (!prior) return null;
  // A client key bound to a DIFFERENT request (other target date, other
  // window, a clear) is a caller bug, never a silent replay of the earlier
  // move — checked before the still-current fence so the caller learns the
  // real reason.
  if ((newDate && prior.new_date && dateOnly(prior.new_date) !== dateOnly(newDate))
    || (requestKey && prior.request_key && prior.request_key !== requestKey)) {
    throw Object.assign(new Error('This operation key was already used for a different move of this appointment'), {
      statusCode: 409,
      isOperational: true,
      code: 'OPERATION_KEY_REUSED',
    });
  }
  if (service && !priorStillCurrent(prior, service)) {
    // The anchor no longer sits where the prior move left it. Two cases share
    // this shape: a STALE retry of the prior move (dangerous — its window is
    // obsolete) and a LEGITIMATE new move back to the same slot (A→B, B→C,
    // C→B within the horizon). The caller's scheduling pin tells them apart:
    // a request observed at the prior's ORIGINAL date is the old attempt; a
    // request observed anywhere else is a new action on the current state,
    // which proceeds (its row supersedes the prior). No pin → stay safe.
    const observedDate = expect && expect.scheduled_date ? dateOnly(expect.scheduled_date) : null;
    const observedElsewhere = observedDate && prior.original_date && observedDate !== dateOnly(prior.original_date);
    if (derived && observedElsewhere) return null;
    throw Object.assign(new Error('This move was already applied and the visit has changed since — reload and check the schedule before moving it again'), {
      statusCode: 409,
      isOperational: true,
      code: 'SERIES_MOVE_STALE',
    });
  }
  return prior;
}

// After a transactional conflict (CAS 409 / unique 23505): the row this
// attempt may replay is ONLY the concurrent winner of the SAME request —
// committed after the row the pre-transaction lookup already judged (an
// older row under this key is that judged row: superseded, or the
// A→B row a legitimate C→B return move deliberately walked past), bound
// to this exact request, and with the anchor still sitting where it left
// it (a fresh read — the pre-move snapshot is stale by definition here).
// Anything else means the caller's move did NOT happen: the real error
// propagates instead of a success report for a slot the anchor never
// reached.
async function findConcurrentSeriesMoveWinner(conn, serviceId, opKey, observedPrior) {
  const q = conn('series_moves').where({ anchor_service_id: serviceId, operation_key: opKey.key, status: 'committed' });
  if (opKey.derived) q.where('created_at', '>', new Date(Date.now() - SERIES_RETRY_HORIZON_MS));
  if (observedPrior?.created_at) q.where('created_at', '>', observedPrior.created_at);
  const winner = await q.orderBy('created_at', 'desc').first();
  if (!winner) return null;
  if (observedPrior && String(winner.id) === String(observedPrior.id)) return null;
  if (opKey.requestKey && winner.request_key && winner.request_key !== opKey.requestKey) return null;
  const fresh = await conn('scheduled_services').where({ id: serviceId }).first('id', 'scheduled_date', 'window_start', 'window_end');
  if (!fresh || !priorStillCurrent(winner, fresh)) return null;
  return winner;
}

// Idempotent post-commit cleanup a replay of a committed move must still
// perform (the original pass may have died right after its commit): a live
// anchor's tech_status pointer release (conditional on the pointer still
// targeting this job) and the customer tracker refresh. The non-idempotent
// follow-up shift is inside the move trx, so a replay never repeats it.
async function replaySeriesMoveCleanup(prior) {
  const anchor = Array.isArray(prior.rows) ? prior.rows.find((r) => r.anchor) : null;
  if (!anchor || !LIVE_OVERRIDE_STATUSES.has(String(anchor.before?.status))) return;
  const techId = anchor.before?.technician_id || null;
  if (techId) {
    try {
      await clearTechCurrentJob({ tech_id: techId, current_job_id: anchor.id, status: 'idle' });
    } catch (err) {
      logger.error(`[rebooker] tech_status clear on series replay failed for ${anchor.id}: ${err.message}`);
    }
  }
  emitCustomerJobRefresh({ id: anchor.id, customer_id: prior.customer_id }, 'confirmed');
}

// What an operation_key replay hands back for a committed move: the result
// stored WITH the row in the move transaction, or — for a row whose result
// column is somehow empty — the same occurrence list rebuilt from the
// per-row snapshots, so a replaying caller can always run its effects.
function replaySeriesMoveResult(prior, requestedDate) {
  // A key is bound to ONE move: the same key with a different target is a
  // caller bug, never a silent replay of the earlier move's occurrences.
  if (requestedDate && dateOnly(prior.new_date) !== dateOnly(requestedDate)) {
    throw Object.assign(new Error('This operation key was already used for a different move of this appointment'), {
      statusCode: 409,
      isOperational: true,
      code: 'OPERATION_KEY_REUSED',
    });
  }
  const base = prior.result && typeof prior.result === 'object'
    ? prior.result
    : (() => {
      const rows = Array.isArray(prior.rows) ? prior.rows : [];
      const rescheduledOccurrences = rows.map((r) => ({
        id: r.id,
        date: r.after?.scheduled_date ?? null,
        windowStart: r.after?.window_start ?? null,
        windowEnd: r.after?.window_end ?? null,
        conflicted: !!(r.before?.window_start && !r.after?.window_start),
      }));
      return {
        success: true,
        originalDate: prior.original_date,
        newDate: prior.new_date,
        occurrencesRescheduled: rescheduledOccurrences.length,
        rescheduledOccurrences,
        deltaDays: prior.delta_days,
        skippedCount: prior.skipped_count,
        exceptionCount: prior.exception_count,
      };
    })();
  return { ...base, seriesMoveId: prior.id, replayed: true };
}

// Telemetry + audit for a series shift that did NOT commit (written outside
// the rolled-back transaction, best-effort): the un-gate review reads
// rollback/failure counts from the same table as the successes.
async function recordFailedSeriesMove(fields, err) {
  try {
    await db('series_moves').insert({
      id: crypto.randomUUID(),
      ...fields,
      status: 'failed',
      error: String(err?.message || err).slice(0, 2000),
    });
  } catch (recordErr) {
    logger.warn(`[rebooker] failed series_moves record not written for ${fields.anchor_service_id}: ${recordErr.message}`);
  }
}

// Tracker-lifecycle rewind applied when a live job is force-rescheduled.
// track_state returns to 'scheduled' so En Route can fire again on the
// new day, track_sms_sent_at clears so the en-route SMS re-sends, and
// the arrival/start timestamps clear so duration capture on the new
// visit doesn't measure from the abandoned attempt (a stale arrived_at
// would make buildCompletionLifecycleUpdates compute a days-long
// service time).
const LIVE_LIFECYCLE_RESET = {
  track_state: 'scheduled',
  en_route_at: null,
  arrived_at: null,
  actual_start_time: null,
  check_in_time: null,
  track_sms_sent_at: null,
  // Clear the arrival-SMS guard too, mirroring track_sms_sent_at, so the
  // "tech has arrived" text can re-send when the rescheduled visit arrives.
  arrival_sms_sent_at: null,
};

// Live TRACK states the rewind test recognizes alongside the operational
// statuses above. `status` alone under-detects: the manual En Route taps
// advance track_state and stamp lifecycle columns WITHOUT syncing status
// (track-transitions' syncOperationalStatus is opt-in and only the geofence
// handler passes it), and a partially-rewound row can carry stale stamps
// under a pending/rescheduled status. A moved row keeping any of this
// evidence makes the new day's markEnRoute a silent no-op — no en_route_at,
// no track SMS — and leaks the aborted attempt's timestamps into the
// customer report's visit timeline (live incident 2026-08-11).
const LIVE_TRACK_STATES = new Set(['en_route', 'on_property']);

// Observed tracker/lifecycle snapshot for a mover's CAS. track_state alone
// is not enough: markOnProperty can add lifecycle timestamps to an
// already-on_property row, and the en-route SMS completion stamps
// track_sms_sent_at without changing state — a mover matching only
// track_state could reset the row from a stale snapshot and still let an
// old-attempt guard write land afterward, suppressing the new attempt's
// text. Matching the full observed snapshot makes ANY concurrent lifecycle
// write miss the move instead. Applied to the query builder (not a plain
// where-object) because timestamptz equality needs ms truncation on BOTH
// sides: node-postgres round-trips Dates at millisecond precision while
// rows written by SQL now() carry microseconds — a naive equality would
// NEVER match those and every move would false-conflict (same pattern as
// call-research-miner / estimate-public's date_trunc CAS).
const TRACK_CAS_TIMESTAMP_COLUMNS = [
  'en_route_at', 'arrived_at', 'actual_start_time', 'check_in_time',
  'track_sms_sent_at', 'arrival_sms_sent_at',
];
function applyTrackLifecycleCas(query, row = {}) {
  query.where({ track_state: row.track_state ?? null });
  for (const col of TRACK_CAS_TIMESTAMP_COLUMNS) {
    const value = row[col];
    if (value == null) {
      query.whereNull(col);
    } else {
      query.whereRaw(
        `date_trunc('milliseconds', ??) = date_trunc('milliseconds', ?::timestamptz)`,
        [col, new Date(value)],
      );
    }
  }
  return query;
}

// Should a date move rewind this row's tracker lifecycle? True on live
// operational status, live track_state, or any leftover lifecycle stamp.
// Callers gate movability separately (terminal rows never reach this).
function needsLifecycleRewind(service = {}) {
  if (LIVE_OVERRIDE_STATUSES.has(service.status)) return true;
  if (LIVE_TRACK_STATES.has(service.track_state)) return true;
  return Boolean(
    service.en_route_at
    || service.arrived_at
    || service.actual_start_time
    || service.check_in_time
    // Leftover SMS guards count too: a partial reset can clear the
    // timestamps but keep track_sms_sent_at / arrival_sms_sent_at, and a
    // moved row keeping them silently suppresses the new day's en-route
    // and arrival texts.
    || service.track_sms_sent_at
    || service.arrival_sms_sent_at,
  );
}

function recurrenceOrdinalOptions(baseDateStr, opts = {}) {
  const safe = baseDateStr ? String(baseDateStr).split('T')[0] : null;
  if (!safe) return opts;
  const base = parseETDateTime(safe + 'T12:00');
  if (isNaN(base.getTime())) return opts;
  const et = etParts(base);
  return {
    ...opts,
    nth: (opts.nth != null && opts.nth !== '' && !isNaN(parseInt(opts.nth)))
      ? parseInt(opts.nth)
      : Math.ceil(et.day / 7),
    weekday: (opts.weekday != null && opts.weekday !== '' && !isNaN(parseInt(opts.weekday)))
      ? parseInt(opts.weekday)
      : et.dayOfWeek,
  };
}

// ET-safe duplicate of nextRecurringDate (the original lives in
// server/routes/admin-schedule.js). Schedule dates are ET wall-clock
// strings — Railway runs TZ=UTC, so naive `new Date(s + 'T12:00:00')`
// math drifts at DST/midnight boundaries. Routed through datetime-et
// helpers here. Keep recurrence semantics in sync with the original.
function nextRecurringDate(baseDateStr, pattern, i, opts = {}) {
  const { nth, weekday, intervalDays } = opts;
  const safe = baseDateStr ? String(baseDateStr).split('T')[0] : null;
  if (!safe) return null;
  const base = parseETDateTime(safe + 'T12:00');
  if (isNaN(base.getTime())) return safe;
  const nthNum = (nth != null && nth !== '' && !isNaN(parseInt(nth))) ? parseInt(nth) : null;
  const wdayNum = (weekday != null && weekday !== '' && !isNaN(parseInt(weekday))) ? parseInt(weekday) : null;
  const intNum = (intervalDays != null && intervalDays !== '' && !isNaN(parseInt(intervalDays))) ? parseInt(intervalDays) : null;

  if (pattern === 'monthly_nth_weekday' && nthNum != null && wdayNum != null) {
    const baseEt = etParts(base);
    const totalMonths = (baseEt.month - 1) + i;
    const targetYear = baseEt.year + Math.floor(totalMonths / 12);
    const targetMonth1 = ((totalMonths % 12) + 12) % 12 + 1; // 1-12
    return etDateString(etNthWeekdayOfMonth(targetYear, targetMonth1, nthNum, wdayNum));
  }

  // Seasonal mosquito (9x Feb-Oct) is neither a month-interval nor a fixed
  // day-gap cadence — its gap is 1 month in season and 4 across the winter.
  // Delegate to the seeder so extension/reschedule here cannot drift from the
  // dates the series was seeded with (it would otherwise take the generic
  // 91-day fallback below and schedule winter visits).
  if (pattern === SEASONAL_FEB_OCT) return seasonalFebOctDate(safe, i, opts);
  if (MONTH_RECURRENCE_INTERVALS[pattern]) {
    return etDateString(addETMonthsByWeekday(base, MONTH_RECURRENCE_INTERVALS[pattern] * i, opts));
  }

  const intervals = { daily: 1, weekly: 7, biweekly: 14 };
  let gap;
  if (pattern === 'custom' && intNum) gap = Math.max(1, intNum);
  else gap = intervals[pattern] || 91;
  return etDateString(addETDays(base, gap * i));
}

// Tell an open TrackPage (or customer portal) that a live job was
// rewound. The public tracker refetches on customer:job_update but only
// polls while en_route — an on_property viewer would otherwise sit on
// the stale "tech on site" screen until a manual refresh. Payload
// follows the strict customer-facing allowlist in job-status.js
// (job_id / status / eta / tech_id / tech_first_name / updated_at) —
// see the PII BOUNDARY block there before adding fields.
function emitCustomerJobRefresh(service, toStatus) {
  if (!service?.customer_id) return;
  const io = getIo();
  if (!io) {
    logger.warn('[rebooker] io not initialized; skipping customer refresh broadcast');
    return;
  }
  io.to(`customer:${service.customer_id}`).emit('customer:job_update', {
    job_id: service.id,
    status: toStatus,
    eta: null,
    tech_id: service.technician_id || null,
    tech_first_name: null,
    updated_at: new Date(),
  });
}

// Occupancy-probe end for a row landing at `windowStart` with no stored
// end. window_end is nullable (schema-legal — admin edits leave open-ended
// windows), but the row still OCCUPIES a span once booked: the shared SQL
// predicate (scheduling/occupancy.js) COALESCEs a null end to
// window_start + NULLIF(estimated_duration_minutes, 0)-or-60. A write gate
// that skips (or probes a flat 60) for such a row is asymmetric with the
// read side — the booked row will block OTHERS across its derived span,
// while its own booking checked nothing (or less). Derive the same span
// here so write-side gates probe exactly what the row will occupy.
// deriveWindowEnd is the CANONICAL derivation (datetime-et) and its
// contract is inherited whole: null = the span would cross midnight, and
// "callers must treat null as a validation failure, never as a windowless
// visit" — so this THROWS the same pick-an-earlier-start rejection
// admin-schedule and the IB reschedule tool raise (codex #3377 P1: a
// 23:59 clamp silently under-probed the tail, and Postgres time
// arithmetic would wrap the booked row's effective end before its start).
// The pre-fix code was strictly worse on this edge either way: the series
// fallback built a '24:30' literal that blew up the ?::time cast inside
// the transaction.
// Kill switch: REBOOKER_NULL_END_OCCUPANCY=off restores the legacy
// behavior at every call site (single path skips its gate again, series
// fallbacks return to flat 60) — callers key on the env, not this helper.
function occupancyProbeEnd(windowStart, storedEnd, estimatedDurationMinutes) {
  if (storedEnd) return storedEnd;
  if (!windowStart) return null;
  const dur = Number(estimatedDurationMinutes) > 0 ? Number(estimatedDurationMinutes) : 60;
  const derived = deriveWindowEnd(windowStart, dur);
  if (!derived) {
    throw Object.assign(new Error('That window would cross midnight — pick an earlier start'), {
      statusCode: 400,
      isOperational: true,
      code: 'INVALID_WINDOW',
    });
  }
  return derived;
}

// Convert "08:00-09:00" → { start: '08:00', end: '09:00' }. Tolerates objects.
function parseWindow(w) {
  if (!w) return { start: null, end: null };
  if (typeof w === 'object') return { start: w.start || null, end: w.end || null };
  const m = String(w).match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return { start: null, end: null };
  return { start: m[1], end: m[2] };
}

// The per-occurrence date projection a series shift writes — shared by
// rescheduleSeries (inside its transaction) and previewSeriesMove (read-only
// counts for the surfaces), so what a surface previews is exactly what the
// move probes and writes.
async function makeSeriesProjector({ service, parent, newDate, seriesDateStr }) {
  const pattern = parent.recurring_pattern;
  const isMonthBasedPattern = isMonthBasedRecurrence(pattern);
  // Seasonal series keep their seeded weekend/season contract on re-anchor
  // (codex r15 P2): conversion seeds seasonal series with skip_weekends,
  // but a weekend anchor (public availability can offer weekends) would
  // otherwise project every later occurrence onto weekends — and a shifted
  // date can cross the season edge (Oct 31 Sat → Nov 2). The customer's
  // picked anchor date itself is honored as-is; only projected siblings
  // shift. Scoped to seasonal so every other cadence keeps its
  // long-standing unshifted re-anchor behavior.
  // B6: the projected siblings honor the customer's LIVE weekday
  // preference alongside the operator-set series flag — the flag alone
  // is operator provenance; the preference is never persisted onto rows.
  const seriesSkipWeekends = !!parent.skip_weekends
    || await customerPrefersNoWeekends(db, parent.customer_id);
  const projectSeriesDate = (raw) => {
    let out = String(raw).split('T')[0];
    // The weekend shift applies to EVERY recurring pattern (hook B6 P1 —
    // the old seasonal-only scoping predates the ruling): a weekend-
    // averse customer re-anchoring a quarterly/monthly series must not
    // get weekend siblings. The customer's picked anchor date itself is
    // honored as-is; only projected siblings shift.
    if (seriesSkipWeekends) {
      const at = parseETDateTime(`${out}T12:00`);
      const { dayOfWeek } = etParts(at);
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        const back = parent.weekend_shift === 'back';
        const delta = back ? (dayOfWeek === 6 ? -1 : -2) : (dayOfWeek === 6 ? 2 : 1);
        out = etDateString(addETDays(at, delta));
      }
    }
    if (pattern !== SEASONAL_FEB_OCT) return out;
    // No blackout layer is threaded here, so the clamp can only exhaust
    // on 75 straight in-season weekend days — impossible. The || keeps
    // this caller's legacy always-a-date contract if that ever changes
    // (its write sites are not null-safe).
    return clampDateToSeason(SEASONAL_FEB_OCT, out, { skipWeekends: seriesSkipWeekends }) || out;
  };
  const opts = {
    ...(isMonthBasedPattern
      ? recurrenceOrdinalOptions(newDate)
      : {
          nth: parent.recurring_nth,
          weekday: parent.recurring_weekday,
        }),
    intervalDays: parent.recurring_interval_days,
  };
  // Weekend shifts can COLLAPSE consecutive occurrences onto one weekday
  // (a daily series re-anchored Friday maps Sat+Sun+Mon all to Monday; a
  // 2-day cadence anchored Thursday maps Sat and Mon both to Monday) — a
  // plan must never write two of its own visits on one date (codex
  // #3509). Project each occurrence ONCE, memoized, advancing a collided
  // date day-by-day (still honoring the weekend rule and the season
  // clamp) — the collision probe and the write loop below read this same
  // mapping, so what gets probed is exactly what gets written.
  // Anchor delta (calendar days) — what a date EXCEPTION shifts by instead
  // of being regenerated from cadence (owner ruling 2026-08-28: "Nov 17
  // because the customer is traveling" survives "Sep 10 → Sep 15"). The
  // weekend/season rules still apply to the shifted date.
  const deltaDays = calendarDaysBetween(dateOnly(service.scheduled_date), seriesDateStr);
  const pureCadenceDate = (occurrenceIndex) => projectSeriesDate(
    nextRecurringDate(newDate, parent.recurring_pattern, occurrenceIndex, opts),
  );
  const projectedByOccurrence = new Map();
  const projectOccurrenceDate = (occurrenceIndex, sib = null) => {
    if (projectedByOccurrence.has(occurrenceIndex)) return projectedByOccurrence.get(occurrenceIndex);
    let out = occurrenceIndex === 0
      ? String(newDate).split('T')[0]
      : (sib && sib.date_exception === true
        ? projectSeriesDate(etDateString(addETDays(parseETDateTime(`${dateOnly(sib.scheduled_date)}T12:00`), deltaDays)))
        : pureCadenceDate(occurrenceIndex));
    const used = new Set(projectedByOccurrence.values());
    for (let guard = 0; guard < 31 && used.has(out); guard++) {
      let at = addETDays(parseETDateTime(`${out}T12:00`), 1);
      if (seriesSkipWeekends) {
        const { dayOfWeek } = etParts(at);
        if (dayOfWeek === 0 || dayOfWeek === 6) at = addETDays(at, dayOfWeek === 6 ? 2 : 1);
      }
      out = etDateString(at);
      if (pattern === SEASONAL_FEB_OCT) {
        out = clampDateToSeason(SEASONAL_FEB_OCT, out, { skipWeekends: seriesSkipWeekends }) || out;
      }
    }
    projectedByOccurrence.set(occurrenceIndex, out);
    return out;
  };
  return { pattern, isMonthBasedPattern, seriesSkipWeekends, opts, deltaDays, pureCadenceDate, projectOccurrenceDate };
}

class SmartRebooker {
  async findRescheduleOptions(serviceId, reason, opts = {}) {
    const service = await db('scheduled_services')
      .where('scheduled_services.id', serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name',
        'customers.city', 'customers.zip', 'customers.waveguard_tier')
      .first();

    if (!service) throw new Error('Service not found');

    const options = [];
    const today = new Date();

    // Rain-out SMS alternates enumerate their own dates (not via find-time)
    // — skip owner blackout days here too (shared helper, fail-open).
    const { getBlackoutDates } = require('./scheduling/blackout-dates');
    const blackout = await getBlackoutDates(
      etDateString(addETDays(today, 1)),
      etDateString(addETDays(today, 10)),
    );

    for (let d = 1; d <= 10; d++) {
      // ET calendar math — toISOString() reads the UTC date while displayDate
      // below formats in ET, so between 8 PM and midnight ET the customer would
      // see "Thu Jun 11" but the system would book Jun 12. Derive both from ET.
      const candidateDate = addETDays(today, d); // anchored at noon UTC on the ET calendar day

      const dateStr = etDateString(candidateDate);
      if (blackout.has(dateStr)) continue;
      // A seasonal (Feb–Oct) visit must not be OFFERED a Nov–Jan option to
      // flows that commit with a non-admin initiator: rain-out calls
      // reschedule() as 'tech', whose season guard would reject the target —
      // recording failures and leaving the job unmoved (codex r14 P1).
      // Late-October rain-outs simply offer the remaining in-season days.
      // The ADMIN dispatch picker calls this generator with NO reason and
      // commits as 'admin', which deliberately allows off-season exceptions —
      // its options stay unfiltered (codex r15 P2).
      if (reason && service.recurring_pattern === SEASONAL_FEB_OCT) {
        const month = Number(dateStr.slice(5, 7));
        if (month < 2 || month > 10) continue;
      }

      const dayLoad = await db('scheduled_services')
        .where('scheduled_date', dateStr)
        .whereIn('status', ['pending', 'confirmed'])
        .count('* as count').first();

      const nearbyServices = await db('scheduled_services')
        .where('scheduled_date', dateStr)
        .whereIn('status', ['pending', 'confirmed'])
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .select('customers.zip', 'customers.city');

      const sameAreaCount = nearbyServices.filter(s =>
        s.zip === service.zip || (s.city || '').toLowerCase() === (service.city || '').toLowerCase()
      ).length;

      let score = 100;
      const load = parseInt(dayLoad.count);
      if (load > 8) score -= 30;
      else if (load > 6) score -= 15;
      else if (load > 4) score -= 5;

      score += sameAreaCount * 10; // Route density bonus
      score += Math.max(0, (8 - d)) * 5; // Sooner is better
      if (candidateDate.getDay() === new Date(service.scheduled_date).getDay()) score += 8; // Same day of week

      const window = this.findBestWindow(service);

      // Skip candidates whose committed block would deterministically 409:
      // the picker submits window.start + the visit's own duration, so test
      // exactly that span with the same tech-blind occupancy predicate
      // reschedule() enforces. Without this, busy days surface suggestions
      // that can never be selected.
      const effDuration = (() => {
        // Callers that book a DIFFERENT span than the visit's own block
        // (rain-out commits a one-hour slot) pass probeSpanMinutes so the
        // probe tests exactly what they will submit.
        const forced = parseInt(opts.probeSpanMinutes, 10);
        if (Number.isInteger(forced) && forced > 0) return forced;
        // Stored span FIRST, then the duration estimate — the same order
        // the RescheduleModal uses to build the window it submits, so the
        // probe tests exactly the block Select will commit.
        if (service.window_start && service.window_end) {
          const [h1, m1] = String(service.window_start).split(':').map(Number);
          const [h2, m2] = String(service.window_end).split(':').map(Number);
          const span = (h2 * 60 + (m2 || 0)) - (h1 * 60 + (m1 || 0));
          if (span > 0) return span;
        }
        const d = parseInt(service.estimated_duration_minutes, 10);
        if (Number.isInteger(d) && d > 0) return d;
        return 60;
      })();
      const startMin = (() => {
        const [h, m] = String(window.start).split(':').map(Number);
        return h * 60 + (m || 0);
      })();
      const endTotal = Math.min(startMin + effDuration, 23 * 60 + 59);
      const candidateEnd = `${String(Math.floor(endTotal / 60)).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`;
      try {
        const clash = await findConflictingVisits({
          db,
          date: dateStr,
          windowStart: window.start,
          windowEnd: candidateEnd,
          excludeServiceIds: [String(serviceId)],
          excludeStatuses: ['cancelled', 'completed'],
        });
        if (clash.length) continue;
      } catch (err) {
        // Occupancy probe failure keeps the candidate (legacy behavior) —
        // the commit-time check still rejects a genuine clash.
        logger.warn(`[rebooker] suggestion occupancy probe failed for ${dateStr}: ${err.message}`);
      }

      options.push({
        date: dateStr,
        dayOfWeek: candidateDate.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' }),
        displayDate: candidateDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }),
        currentLoad: load,
        sameAreaServices: sameAreaCount,
        suggestedWindow: window,
        score,
      });
    }

    options.sort((a, b) => b.score - a.score);
    return options.slice(0, 3);
  }

  findBestWindow(service) {
    const s = (service.service_type || '').toLowerCase();
    if (s.includes('lawn') || s.includes('turf') || s.includes('mosquito')) return { start: '08:00', end: '10:00', display: '8:00-10:00 AM' };
    return { start: '09:00', end: '12:00', display: '9:00 AM-12:00 PM' };
  }

  async reschedule(serviceId, newDate, newWindow, reason, initiatedBy, options = {}) {
    const service = await db('scheduled_services').where({ id: serviceId }).first();
    if (!service) throw new Error('Service not found');
    const allowedStatuses = options.allowLive === true
      ? new Set([...RESCHEDULABLE_STATUSES, ...LIVE_OVERRIDE_STATUSES])
      : RESCHEDULABLE_STATUSES;
    if (!allowedStatuses.has(service.status)) {
      throw Object.assign(new Error(`Cannot reschedule a ${service.status} job`), {
        statusCode: 409,
      });
    }
    // Collective choke point (see collectiveMoveGateOn): a DATE move of a
    // cadence visit is a series move. Same-date window edits, boosters
    // (is_recurring=false) and one-time visits stay single. The caller's
    // `expect` pin (date/window) carries over as the series writer's own
    // expectAnchor fence; excludeServiceIds is a batch-mover concept the
    // series path has no use for.
    if (options.seriesPolicy !== 'single' && collectiveMoveGateOn() && service.is_recurring === true) {
      // A retry of a series move that already committed finds the anchor ON
      // the target (no date delta) — resolve the prior move by request
      // identity BEFORE branching on the anchor's mutable date, so the
      // retry replays it (and its caller can finish the effects) instead of
      // falling into a same-date single edit.
      const opKey = seriesOperationKey(serviceId, newDate, newWindow, options);
      const prior = await findPriorSeriesMove(db, serviceId, opKey, service, newDate, options.expect || null);
      if (prior) {
        await replaySeriesMoveCleanup(prior);
        return replaySeriesMoveResult(prior, newDate);
      }
      if (dateOnly(newDate) !== dateOnly(service.scheduled_date)) {
        const { seriesPolicy: _policy, expect, excludeServiceIds: _exclude, ...seriesOptions } = options;
        // The caller's full scheduling pin rides along: a start-only or
        // date-only resolution derived its window from window_end /
        // estimated_duration_minutes, so those must fence the series anchor
        // too, not just date + start.
        if (expect && !seriesOptions.expectAnchor) {
          const pin = {};
          for (const col of ['scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes']) {
            if (Object.prototype.hasOwnProperty.call(expect, col)) pin[col] = expect[col];
          }
          if (Object.keys(pin).length) seriesOptions.expectAnchor = pin;
        }
        // A caller-minted key rides along in seriesOptions; a DERIVED key is
        // never handed over as one — rescheduleSeries derives the identical
        // key itself and keeps its retry-horizon / supersession semantics.
        return this.rescheduleSeries(serviceId, newDate, newWindow, reason, initiatedBy, seriesOptions);
      }
    }
    const wasLive = LIVE_OVERRIDE_STATUSES.has(service.status);
    // Evidence-based rewind test — broader than wasLive (live track_state
    // or stale stamps under a non-live status). Drives the lifecycle reset
    // AND the post-commit tracker cleanup below; movability stays
    // status-based. For NON-live rows the rewind is additionally gated on
    // the DATE actually changing: a same-date window edit of a visit with
    // genuine same-day tracker state must not erase the active attempt.
    const sameDayTarget = String(newDate || '').split('T')[0]
      === String(service.scheduled_date instanceof Date
        ? service.scheduled_date.toISOString()
        : service.scheduled_date || '').slice(0, 10);
    const lifecycleRewound = wasLive || (!sameDayTarget && needsLifecycleRewind(service));

    // A past target date moves the job where no "upcoming" query will ever
    // find it — silently never serviced. Stale SMS replies and freeform
    // admin input both reach this path.
    const newDateStr = String(newDate || '').split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDateStr) || newDateStr < etDateString()) {
      throw Object.assign(new Error('Reschedule target date is invalid or in the past'), {
        statusCode: 400,
        isOperational: true,
        code: 'INVALID_DATE',
      });
    }

    // Owner blackout re-check at COMMIT for every non-admin initiator
    // (customer self-serve, SMS replies, rain-out/auto flows): the option
    // being confirmed may have been generated before the owner blocked the
    // date. Admin-initiated moves stay unblocked BY DESIGN — the owner can
    // knowingly book his own day off from dispatch. Fail-open helper.
    if (initiatedBy !== 'admin') {
      const { isBlackoutDate } = require('./scheduling/blackout-dates');
      if (await isBlackoutDate(newDateStr)) {
        throw Object.assign(new Error('That day is no longer available'), {
          statusCode: 409,
          isOperational: true,
          code: 'SLOT_TAKEN',
        });
      }
    }
    // A single occurrence of a seasonal (Feb–Oct) series must not move into
    // the Nov–Jan gap either (codex r10 P1 — small moves skip the series
    // re-anchor and its guard entirely): an October visit postponed into
    // November is a prohibited winter treatment. Both parents and seeded
    // children carry recurring_pattern, so the row's own column decides.
    // Admin moves stay allowed — an off-season visit is an office decision.
    if (initiatedBy !== 'admin' && service.recurring_pattern === SEASONAL_FEB_OCT) {
      const month = Number(newDateStr.slice(5, 7));
      if (month < 2 || month > 10) {
        throw Object.assign(new Error('This seasonal program runs February through October — winter dates are not available for this visit. Contact the office if you need an exception.'), {
          statusCode: 409,
          isOperational: true,
          code: 'OFF_SEASON',
        });
      }
    }

    const originalDate = service.scheduled_date;
    const win = parseWindow(newWindow);
    const windowEnd = win.end || service.window_end;

    // Same-day target whose window already elapsed in ET is just as
    // unreachable as yesterday — a stale morning option accepted in the
    // afternoon would move the job into a past window. Shared cutoff logic
    // (datetime-et.sameDayWindowElapsed) so every mover rejects identically.
    if (sameDayWindowElapsed(newDateStr, windowEnd || win.start || service.window_start)) {
      throw Object.assign(new Error('That window has already passed today'), {
        statusCode: 409,
        isOperational: true,
        code: 'SLOT_TAKEN',
      });
    }
    // Gate span ≠ persisted span: window_end stays null when the caller
    // left it open-ended, but the occupancy checks below probe the span
    // the row will actually occupy per the read predicate. Previously a
    // null windowEnd skipped all three guarded blocks entirely — a
    // start-but-no-end row could be moved onto an occupied slot with NO
    // check, a latent double-booking reachable from every reschedule
    // caller (customer links, dispatch board, rain-out on legacy rows).
    const occupancyGateEnd = windowEnd || (
      process.env.REBOOKER_NULL_END_OCCUPANCY === 'off'
        ? null
        : occupancyProbeEnd(win.start || service.window_start, null, service.estimated_duration_minutes)
    );
    const updates = {
      scheduled_date: newDate,
      window_start: win.start || service.window_start,
      window_end: windowEnd,
      status: 'confirmed',
      ...(lifecycleRewound ? LIVE_LIFECYCLE_RESET : {}),
      // A this-visit-only DATE move of a cadence visit is a deliberate
      // exception to the series — see dateExceptionStamp.
      ...(!sameDayTarget ? dateExceptionStamp(service, initiatedBy) : {}),
    };
    if (Object.prototype.hasOwnProperty.call(options, 'technicianId')) {
      updates.technician_id = options.technicianId;
    }
    // A day or tech change invalidates the stop's route sequence: clear it so
    // the destination day appends the stop (every consumer sorts
    // COALESCE(route_order, 999)) instead of interleaving the old day's
    // number. Canonical clear for every rebooker caller — auto-dispatch tier
    // day-moves ride this path. Same-day window-only reschedules keep their
    // sequence.
    {
      const svcDay = service.scheduled_date instanceof Date
        ? service.scheduled_date.toISOString().slice(0, 10)
        : String(service.scheduled_date).slice(0, 10);
      const techChanges = Object.prototype.hasOwnProperty.call(options, 'technicianId')
        && (options.technicianId || null) !== (service.technician_id || null);
      if (String(newDate).slice(0, 10) !== svcDay || techChanges) {
        updates.route_order = null;
      }
    }

    // Staff-advisory overlap mode (options.overlapAdvisory — the admin
    // dispatch reschedule passes it; owner ruling 2026-08-25: staff-side
    // saves never block on schedule conflicts): an occupancy clash below
    // commits the move and the result carries a warning naming the date.
    // Customer-facing callers (public reschedule/re-service, rain-out,
    // reschedule-sms) omit the option and keep the hard SLOT_TAKEN 409s.
    // Blackout/past-window validation and the concurrency CAS are NOT
    // advisory at any setting.
    const overlapAdvisory = options.overlapAdvisory === true;
    let overlapWarned = false;

    await db.transaction(async (trx) => {
      // The kept technician's route is real — writing 'confirmed' on top
      // of an overlapping job double-books them deterministically (the
      // customer picked from offers that never checked the route).
      const keptTechId = Object.prototype.hasOwnProperty.call(options, 'technicianId')
        ? options.technicianId
        : service.technician_id;
      if (updates.window_start && occupancyGateEnd) {
        // COARSEST scheduling lock FIRST: the date-wide occupancy lock guards
        // the tech-blind findConflictingVisits check below. Without a
        // date-scoped key, two writers with DIFFERENT techs (or one assigned +
        // one unassigned) take different tech locks, both pass the global
        // check, and both commit an overlap. Taken before the tech lock so the
        // single path, the series path, and the zone-null confirm all acquire
        // date-occupancy -> tech in one order (no deadlock inversion). See the
        // ORDERING CONTRACT in scheduling/occupancy.js.
        await acquireOccupancyLock(trx, newDateStr);
        // Then the tech-scoped slot-reserve lock (same namespace + `${techId ||
        // 'unassigned'}` key shape slot-reservation.js uses). STILL needed even
        // with the date lock above: the kept-tech overlap check must serialize
        // against slot-reservation.js estimate reserves + createSelfBooking,
        // which take this tech lock but NOT the date-occupancy one.
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['slot-reserve', `${keptTechId || 'unassigned'}:${newDateStr}`],
        );
      }
      if (keptTechId && updates.window_start && occupancyGateEnd) {
        const overlap = await trx('scheduled_services')
          .where('scheduled_date', newDateStr)
          .where('technician_id', keptTechId)
          .whereNot('id', serviceId)
          .whereNotIn('status', ['cancelled', 'completed'])
          // Expired estimate-slot holds are dead weight until cleanup
          // reclaims them — same active-reservation predicate
          // slot-reservation.js uses, so a lapsed hold can't block a
          // legitimate reschedule.
          .where((q) => {
            q.whereNull('reservation_expires_at')
              .orWhereRaw('reservation_expires_at > NOW()');
          })
          // COALESCE the nullable window_end (same predicate as
          // slot-reservation) — rows without an end time would otherwise
          // never register as conflicts.
          .whereRaw(
            "window_start < ?::time AND COALESCE(window_end, window_start + ((COALESCE(NULLIF(estimated_duration_minutes, 0), 60)::text || ' minutes')::interval)) > ?::time",
            [occupancyGateEnd, updates.window_start],
          )
          .first('id');
        if (overlap) {
          if (!overlapAdvisory) {
            throw Object.assign(new Error('That window conflicts with another job on the technician\'s route'), {
              statusCode: 409,
              isOperational: true,
              code: 'SLOT_TAKEN',
            });
          }
          overlapWarned = true;
        }
      }

      // Tech-blind occupancy (shared module): the kept-tech WHERE above can
      // never match technician-NULL rows, and the whole check was skipped
      // when keptTechId was null (reachable via rain-out and reschedule-sms
      // on techless rows) — a public reschedule landed the clash silently.
      // One active tech means ANY overlap is a real double-booking. Status
      // set matches the tech check above (completed excluded — a done
      // morning visit must not block an afternoon move). Batch movers
      // (rain-out route pushes) pass options.excludeServiceIds so the
      // visits moving in the same sweep don't collide with their own
      // pre-move positions.
      if (updates.window_start && occupancyGateEnd) {
        const occupancyClash = await findConflictingVisits({
          db: trx,
          date: newDateStr,
          windowStart: updates.window_start,
          windowEnd: occupancyGateEnd,
          excludeServiceIds: [...new Set([serviceId, ...(options.excludeServiceIds || [])].map(String))],
          excludeStatuses: ['cancelled', 'completed'],
        });
        if (occupancyClash.length) {
          if (!overlapAdvisory) {
            // Same failure mode as the kept-tech check so every caller's
            // 409/SLOT_TAKEN handling works unchanged.
            throw Object.assign(new Error('That window conflicts with another job on the technician\'s route'), {
              statusCode: 409,
              isOperational: true,
              code: 'SLOT_TAKEN',
            });
          }
          overlapWarned = true;
        }
      }

      const updated = await applyTrackLifecycleCas(
        trx('scheduled_services')
          // The full observed tracker/lifecycle snapshot is in the CAS (see
          // applyTrackLifecycleCas): the lifecycleRewound decision above
          // came from the outer read, and tracker writers advance state and
          // stamps WITHOUT touching status — a status-only match would let
          // this move commit while carrying freshly written lifecycle state
          // onto the new date. Any tracker change makes the write miss and
          // surface the concurrent-change 409 below instead.
          .where({ id: serviceId, status: service.status })
          .whereIn('status', Array.from(allowedStatuses)),
        service,
      )
        // Optional caller-supplied expected-state predicate (e.g. auto-dispatch
        // passing the locked/excluded flags + original date) so a concurrent
        // operator lock/move is caught atomically here, not just by a prior read.
        // .where({}) is a no-op, so callers that omit it are unaffected.
        .where(options.expect || {})
        // When the occupancy gate derived its span FROM the duration (null
        // stored end), pin that duration in the CAS: a concurrent
        // duration-only edit (admin editor commits exactly that) would
        // otherwise leave the probe checking the OLD span while the final
        // row occupies the new one — the tail lands unchecked (codex #3377
        // P1). The advisory locks can't serialize this: the duration editor
        // doesn't take them. A raced edit makes the write miss and surface
        // the concurrent-change 409 below, same as every other CAS field.
        .where((!windowEnd && occupancyGateEnd)
          ? { estimated_duration_minutes: service.estimated_duration_minutes ?? null }
          : {})
        .update({
          ...updates,
          track_token_expires_at: scheduledServiceTrackTokenExpiry(trx, newDate, windowEnd),
        });
      if (updated === 0) {
        throw Object.assign(new Error('Cannot reschedule — job transitioned to a non-reschedulable state concurrently'), {
          statusCode: 409,
        });
      }

      if (service.status !== 'confirmed') {
        await trx('job_status_history').insert({
          job_id: serviceId,
          from_status: service.status,
          to_status: 'confirmed',
          transitioned_by: null,
        });
      }

      await trx('reschedule_log').insert({
        scheduled_service_id: serviceId,
        customer_id: service.customer_id,
        original_date: originalDate,
        new_date: newDate,
        reason_code: reason,
        initiated_by: initiatedBy,
        original_window: service.window_start ? `${service.window_start}-${service.window_end}` : null,
        new_window: win.start ? `${win.start}-${win.end}` : null,
      });
    });

    // Live override post-commit cleanup:
    //   1. The tech's tech_status row still points at this job
    //      (en_route / on_site). Release it so the tech shows idle and
    //      the next job can claim them. Best-effort outside the trx —
    //      same pattern as track-transitions.markComplete; a failure
    //      here leaves a stale pointer, not inconsistent job state.
    //   2. A customer watching the public tracker would otherwise stay
    //      on the stale en-route / on-site screen — push the refresh.
    if (wasLive || lifecycleRewound) {
      // lifecycleRewound without wasLive: a manual En Route tap advanced
      // track_state (and pinned tech_status) without syncing status — the
      // rewind above cleared the row, so the tech pointer and any open
      // customer tracker need the same cleanup. This path lands the row on
      // 'confirmed' either way, so the refresh status is unchanged.
      if (service.technician_id) {
        try {
          await clearTechCurrentJob({
            tech_id: service.technician_id,
            current_job_id: serviceId,
            status: 'idle',
          });
        } catch (err) {
          logger.error(`[rebooker] tech_status clear after live reschedule failed for ${serviceId}: ${err.message}`);
        }
      }
      emitCustomerJobRefresh({ ...service, ...updates, id: serviceId }, 'confirmed');
    }

    // Keep a call-created follow-up (visit 2) spaced from its parent —
    // shared with the admin schedule-edit path; best-effort outside the trx.
    try {
      const shifted = await shiftCallFollowUpsForParentMove({
        conn: db,
        parentServiceId: serviceId,
        fromDate: originalDate,
        toDate: newDateStr,
      });
      if (shifted > 0) {
        logger.info(`[rebooker] shifted ${shifted} call-created follow-up visit(s) with parent ${serviceId} (-> ${newDateStr})`);
      }
    } catch (err) {
      logger.error(`[rebooker] call follow-up shift failed for ${serviceId}: ${err.message}`);
    }

    // Check escalation
    const count = await db('reschedule_log')
      .where({ scheduled_service_id: serviceId })
      .count('* as count').first();

    if (parseInt(count.count) >= RULES.escalation.max_auto_reschedules_per_service) {
      const customer = await db('customers').where({ id: service.customer_id }).first();
      logger.warn(`Service ${serviceId} for ${customer.first_name} ${customer.last_name} has been rescheduled ${count.count} times — needs manual review`);
      await db('reschedule_log').where({ scheduled_service_id: serviceId }).orderBy('created_at', 'desc').first()
        .then(log => log && db('reschedule_log').where({ id: log.id }).update({ escalated: true }));
    }

    // This writer moves the visit with a direct UPDATE, not
    // transitionJobStatus — a LEGACY outbound-review row (pending before the
    // 2026-08-11 review-hold removal) rescheduled here would otherwise move
    // and message the customer while still unactivated: reminders unarmed,
    // lead unconverted, review card open (Codex #3361 r2 P0). Best-effort
    // post-commit, at-most-once via the helper's guarded stamp.
    try {
      const { activateLegacyOutboundReviewRowIfNeeded } = require('./outbound-review-confirm');
      await activateLegacyOutboundReviewRowIfNeeded(db, serviceId, 'rebooker-reschedule');
    } catch (activateErr) {
      logger.warn(`[rebooker] legacy outbound activation failed for ${serviceId}: ${activateErr.message}`);
    }

    if (overlapWarned) {
      const { slotOverlapWarning } = require('./scheduling/window-rules');
      return { success: true, originalDate, newDate, warnings: [slotOverlapWarning(newDateStr)] };
    }
    return { success: true, originalDate, newDate };
  }

  // Reschedule the dropped occurrence AND every future sibling in the
  // recurring series. The dropped slot becomes the new anchor and every
  // later occurrence is recomputed from it via nextRecurringDate(),
  // so a quarterly series anchored on May 1 dragged to Apr 29 will
  // re-anchor at Apr 29 and shift the next occurrences accordingly.
  // Past + completed/cancelled rows are left untouched.
  //
  // All sibling updates + per-row job_status_history inserts + the
  // reschedule_log row run inside a single trx — either every row
  // shifts and is audited, or none do. We don't go through
  // transitionJobStatus per-sibling because that helper has a strict
  // fromStatus atomic guard meant for live single-job lifecycle
  // events; here we're sweeping a known set of rows we just SELECTed
  // inside the same trx, so a direct UPDATE + history INSERT keeps
  // the audit trail consistent without re-introducing racing checks
  // designed for a different access pattern.
  async rescheduleSeries(serviceId, newDate, newWindow, reason, initiatedBy, options = {}) {
    const service = await db('scheduled_services').where({ id: serviceId }).first();
    if (!service) throw new Error('Service not found');
    // Staff-advisory overlap mode — same contract as the single path above:
    // occupancy clashes commit and warn (per clashing date); validation and
    // concurrency aborts are unaffected.
    const overlapAdvisory = options.overlapAdvisory === true;
    const overlapWarnDates = new Set();
    const allowedStatuses = options.allowLive === true
      ? new Set([...RESCHEDULABLE_STATUSES, ...LIVE_OVERRIDE_STATUSES])
      : RESCHEDULABLE_STATUSES;
    if (!allowedStatuses.has(service.status)) {
      // Strict callers (no allowLive) get pointed at the
      // single-occurrence path, which the admin route always overrides.
      const hint = LIVE_OVERRIDE_STATUSES.has(service.status)
        ? ' as a series — reschedule this appointment only, then adjust the series from the new date if needed'
        : '';
      throw Object.assign(new Error(`Cannot reschedule a ${service.status} job${hint}`), {
        statusCode: 409,
      });
    }
    // Only the ANCHOR may be live under allowLive — it's the job the
    // staffer is explicitly standing in front of (rain mid-visit, the
    // customer asking to push the cadence). Other live siblings are a
    // different visit actively in progress and stay untouched below.
    const wasLive = LIVE_OVERRIDE_STATUSES.has(service.status);

    const parentId = service.recurring_parent_id || service.id;
    const parent = await db('scheduled_services').where({ id: parentId }).first();
    if (!parent || (!parent.is_recurring && !parent.recurring_pattern)) {
      throw new Error('Service is not part of a recurring series');
    }
    // The schema doesn't enforce parent/customer equality, and this method
    // is reachable from the public bearer-token route — a stale or miswired
    // recurring_parent_id must never let one customer's token mutate
    // another customer's parent row or future visits. Sibling sweep below
    // carries the same customer_id scope.
    if (String(parent.customer_id) !== String(service.customer_id)) {
      throw Object.assign(new Error('Series parent belongs to a different customer — refusing to shift'), {
        statusCode: 409,
      });
    }

    const win = parseWindow(newWindow);

    // Same target validation as reschedule(): a past (or same-day elapsed)
    // anchor would shift the whole chain into dates no "upcoming" query
    // ever finds. Siblings shift forward of the anchor, so a valid anchor
    // keeps them valid.
    const seriesDateStr = String(newDate || '').split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(seriesDateStr) || seriesDateStr < etDateString()) {
      throw Object.assign(new Error('Reschedule target date is invalid or in the past'), {
        statusCode: 400,
        isOperational: true,
        code: 'INVALID_DATE',
      });
    }
    // Same non-admin blackout commit guard as reschedule() — see there.
    if (initiatedBy !== 'admin') {
      const { isBlackoutDate } = require('./scheduling/blackout-dates');
      if (await isBlackoutDate(seriesDateStr)) {
        throw Object.assign(new Error('That day is no longer available'), {
          statusCode: 409,
          isOperational: true,
          code: 'SLOT_TAKEN',
        });
      }
    }
    // A seasonal (Feb–Oct) series must not re-anchor into the winter gap: the
    // anchor would sit in Nov–Jan while the walk resumes in February,
    // displacing the October visit (codex r7 P1 — the public pull-forward
    // route reaches this method). Operators may still override — an
    // off-season anchor is an office decision everywhere else in this lane.
    if (initiatedBy !== 'admin' && parent.recurring_pattern === SEASONAL_FEB_OCT) {
      const month = Number(seriesDateStr.slice(5, 7));
      if (month < 2 || month > 10) {
        throw Object.assign(new Error('This seasonal program runs February through October — winter dates are not available for this series. Contact the office if you need an exception.'), {
          statusCode: 409,
          isOperational: true,
          code: 'OFF_SEASON',
        });
      }
    }
    if (sameDayWindowElapsed(seriesDateStr, win.end || service.window_end || win.start || service.window_start)) {
      throw Object.assign(new Error('That window has already passed today'), {
        statusCode: 409,
        isOperational: true,
        code: 'SLOT_TAKEN',
      });
    }
    // (After every pre-transaction validation above: a replay answers only a
    // request the move itself would accept.)
    // operation_key dedupes the INITIATING action: a retried request (timeout,
    // double tap, an agent re-running its tool) returns the committed result
    // instead of shifting the series a second time. The series_moves id it
    // carries is the idempotency key for every downstream effect. Callers
    // that mint no key get the action's natural identity — this anchor,
    // from its current date, to the target — so two concurrent identical
    // submissions still serialize on the partial unique index (the loser
    // replays the winner), while a later genuine move back to the same date
    // (the anchor then sits elsewhere) is a different action.
    const opKey = seriesOperationKey(serviceId, newDate, newWindow, options);
    const operationKey = opKey.key;
    const observedPrior = { row: null };
    {
      const prior = await findPriorSeriesMove(db, serviceId, opKey, service, newDate, options.expectAnchor || null, observedPrior);
      if (prior) {
        await replaySeriesMoveCleanup(prior);
        return replaySeriesMoveResult(prior, newDate);
      }
    }
    const {
      isMonthBasedPattern, opts, deltaDays, pureCadenceDate, projectOccurrenceDate,
    } = await makeSeriesProjector({ service, parent, newDate, seriesDateStr });

    // Live lifecycle states (en_route, on_site) and intentional drop-offs
    // (skipped) must NOT be steamrolled back to 'confirmed' by a series
    // shift — only pending + confirmed are safe to update. BUT we still
    // need to count them for cadence math: if a quarterly series has a
    // skipped occurrence between two confirmed ones, the next confirmed
    // sibling should land at the +2-quarter mark, not +1, otherwise the
    // recomputed date collides with the skipped one. So we fetch ALL
    // non-terminal siblings, index by their position in the ordered
    // list, and only UPDATE/audit the reschedulable ones.
    const TERMINAL = ['completed', 'cancelled'];
    const RESCHEDULABLE = RESCHEDULABLE_STATUSES;

    // Non-anchor siblings whose tracker lifecycle was rewound inside the
    // trx — they get the shared post-commit cleanup after commit. The
    // anchor's own rewind is tracked separately (same trx-fresh decision).
    const rewoundSiblings = [];
    let anchorRewound = false;
    let rewoundAnchorRow = null;
    let seriesMoveId = null;
    let committedResult = null;
    let skippedCount = 0;
    const moveRows = [];
    const failedMoveFields = {
      operation_key: operationKey,
      request_key: opKey.requestKey,
      anchor_service_id: serviceId,
      parent_service_id: parentId,
      customer_id: service.customer_id,
      source_surface: options.sourceSurface || 'unspecified',
      initiated_by: initiatedBy,
      reason_code: reason,
      original_date: dateOnly(service.scheduled_date),
      new_date: seriesDateStr,
      delta_days: deltaDays,
      notify_requested: options.notifyRequested === true,
    };
    const occurrencesRescheduled = await db.transaction(async (trx) => {
      // NOTE (lock order): the month-based parent's recurrence-anchor UPDATE
      // is deliberately NOT here. It is the series path's first ROW lock and
      // must be taken AFTER the date-wide advisory locks (rung 1) below —
      // acquiring it up front inverted the global order and deadlocked a
      // concurrent single reschedule that held a target-date advisory lock
      // while waiting to touch this same parent row. It now runs right after
      // acquireOccupancyLocks. The plain (unlocked) sibling SELECT that
      // follows is a read, takes no row lock, and can safely precede rung 1.

      // Cadence rows ONLY: booster-month extras share recurring_parent_id
      // but carry is_recurring=false and hold no recurrence index — sweeping
      // them would both move the boosters and push genuine children an
      // extra interval, destroying the configured booster schedule.
      // Siblings are selected and ordered by SERIES POSITION — a date
      // exception's cadence date, else its own date — never by the
      // deliberately exceptional date: a later occurrence pulled before the
      // anchor is still a later occurrence, and two rows never swap index
      // because one of them was moved across the other.
      const siblings = await trx('scheduled_services')
        .whereRaw('(id = ? OR (recurring_parent_id = ? AND is_recurring = true))', [parentId, parentId])
        .where('customer_id', service.customer_id)
        .whereRaw('COALESCE(date_exception_cadence_date, scheduled_date) >= ?::date', [seriesPosition(service)])
        .whereNotIn('status', TERMINAL)
        .orderByRaw('COALESCE(date_exception_cadence_date, scheduled_date) asc, scheduled_date asc')
        .select(
          'id', 'status', 'scheduled_date', 'window_start', 'window_end', 'technician_id',
          // Undo snapshot + exception handling (SERIES_MOVE_SNAPSHOT_COLUMNS).
          'route_order', 'time_window', 'window_display', 'track_token_expires_at', 'updated_at',
          'date_exception', 'date_exception_source', 'date_exception_at', 'date_exception_cadence_date',
          // Feeds the duration-aware occupancy fallbacks below.
          'estimated_duration_minutes',
          // Rewind evidence for needsLifecycleRewind below — a pending
          // sibling can still carry stale tracker stamps (or SMS guards)
          // from an aborted attempt that a partial reset left behind.
          'track_state', 'en_route_at', 'arrived_at', 'actual_start_time', 'check_in_time',
          'track_sms_sent_at', 'arrival_sms_sent_at',
        );

      // Anchor cadence at the dropped service's position so siblings
      // before it (same-date ties) don't pull index 0 away from it.
      const droppedIdx = siblings.findIndex((s) => String(s.id) === String(serviceId));
      // Anchor race guard — ALL callers: between the outer service read and
      // this SELECT the anchor may have completed/cancelled (absent — the
      // terminal filter dropped it) or been marked skipped (present, since
      // 'skipped' is non-terminal for cadence math, but a no-show drop that
      // must NOT be revived to confirmed). Either way the series must not
      // shift: a terminal anchor changing the customer's future cadence is
      // wrong regardless of who initiated the move. Throw, rolling back the
      // trx (and skipping the wasLive post-commit cleanup). A raced
      // live→live advance (en_route→on_site) or live→confirmed flip stays
      // movable under allowLive.
      {
        const anchorRow = droppedIdx === -1 ? null : siblings[droppedIdx];
        const anchorStillMovable = !!anchorRow
          && (RESCHEDULABLE.has(anchorRow.status) || (wasLive && LIVE_OVERRIDE_STATUSES.has(anchorRow.status)));
        if (!anchorStillMovable) {
          throw Object.assign(new Error('Cannot reschedule — job transitioned to a non-reschedulable state concurrently'), {
            statusCode: 409,
          });
        }
        // Caller-supplied expected anchor state: the public route DECIDES
        // scope (single vs whole-series) from its own read of the anchor.
        // If the anchor's date/window moved between that read and this trx,
        // the pull-forward math behind the decision is stale — abort so the
        // caller re-reads and re-decides instead of shifting a series the
        // customer no longer qualified to shift.
        if (options.expectAnchor) {
          const norm = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));
          const hm = (t) => (t ? String(t).slice(0, 5) : null);
          const expDate = norm(options.expectAnchor.scheduled_date);
          const expStart = hm(options.expectAnchor.window_start);
          const has = (col) => Object.prototype.hasOwnProperty.call(options.expectAnchor, col);
          const expEnd = has('window_end') ? hm(options.expectAnchor.window_end) : undefined;
          const expDuration = has('estimated_duration_minutes')
            ? (options.expectAnchor.estimated_duration_minutes ?? null)
            : undefined;
          // Presence-based for the window: a pinned NULL start (windowless
          // anchor at planning time) must fail the fence if a window was
          // added meanwhile, exactly like a pinned start that changed.
          if ((expDate && norm(anchorRow.scheduled_date) !== expDate)
            || (has('window_start') && hm(anchorRow.window_start) !== expStart)
            || (expEnd !== undefined && hm(anchorRow.window_end) !== expEnd)
            || (expDuration !== undefined && (anchorRow.estimated_duration_minutes ?? null) !== expDuration)) {
            throw Object.assign(new Error('Cannot reschedule — appointment changed concurrently'), {
              statusCode: 409,
              isOperational: true,
              code: 'SLOT_TAKEN',
            });
          }
        }
      }
      const startIdx = droppedIdx;

      // The rows THIS sweep will move — conflict checks below exclude
      // exactly these (their dates are changing) and nothing else. Cadence
      // rows BEFORE the anchor stay put and must still register as
      // conflicts: pulling an Aug 4 weekly to Jul 21 shifts Aug 11 → Jul 28
      // right onto the untouched Jul 28 occurrence.
      const sweptIds = siblings
        .slice(startIdx)
        .filter((s) => RESCHEDULABLE.has(s.status) || (wasLive && String(s.id) === String(serviceId)))
        .map((s) => s.id);

      // Same-series same-DATE collisions are hard-blocked regardless of
      // tech/time (auto-dispatch candidate-slots does the same): a plan must
      // never get two of its own visits on one day. Project every date this
      // shift will write and probe the series rows that are NOT moving
      // (boosters, pre-anchor occurrences, skipped rows) — a hit aborts the
      // whole trx so the caller offers a different anchor slot instead.
      {
        const projectedDates = [];
        for (let i = startIdx; i < siblings.length; i++) {
          const sib = siblings[i];
          if (!RESCHEDULABLE.has(sib.status) && !(wasLive && String(sib.id) === String(serviceId))) continue;
          const oi = i - startIdx;
          projectedDates.push(projectOccurrenceDate(oi, sib));
        }
        if (projectedDates.length) {
          // Date-wide occupancy locks for EVERY target date this sweep will
          // write, acquired UP FRONT in sorted order (acquireOccupancyLocks
          // dedups + sorts) — before any per-sibling tech lock in the loop
          // below and before the reads here. This serializes the series
          // against the single-visit path and the zone-null confirm on each
          // shared date (they all take date-occupancy first), and two
          // concurrent series moving overlapping date sets grab the shared
          // date locks in the same order, so neither the series-vs-single nor
          // the series-vs-series case can deadlock. See the ORDERING CONTRACT
          // in scheduling/occupancy.js.
          await acquireOccupancyLocks(trx, projectedDates);

          // First ROW lock of the series path — taken here, AFTER the rung-1
          // date advisory locks, never before (see the NOTE at the top of the
          // transaction). The projected date set is already known from the
          // plain-SELECT sibling read above (no row lock), so the parent
          // update can wait until the advisory locks are held.
          if (isMonthBasedPattern) {
            await trx('scheduled_services').where({ id: parentId }).update({
              recurring_nth: opts.nth,
              recurring_weekday: opts.weekday,
              updated_at: trx.fn.now(),
            });
          }

          const seriesClash = await trx('scheduled_services')
            .whereRaw('(id = ? OR recurring_parent_id = ?)', [parentId, parentId])
            .whereNotIn('id', sweptIds)
            .whereNotIn('status', TERMINAL)
            .whereIn('scheduled_date', projectedDates)
            .first('id');
          if (seriesClash) {
            throw Object.assign(new Error('That date lands on another visit in this plan — pick a different time'), {
              statusCode: 409,
              isOperational: true,
              code: 'SLOT_TAKEN',
            });
          }
          // Owner blackout days for NON-admin shifts cover every projected
          // date, not just the anchor — a re-anchored sibling must not land
          // on a day off either. Sorted probe range, fail-open helper; a
          // hit aborts so the customer picks a different anchor slot.
          if (initiatedBy !== 'admin') {
            const { getBlackoutDates } = require('./scheduling/blackout-dates');
            const sorted = [...projectedDates].sort();
            const blackout = await getBlackoutDates(sorted[0], sorted[sorted.length - 1]);
            if (projectedDates.some((d) => blackout.has(d))) {
              throw Object.assign(new Error('That schedule would land a visit on an unavailable day — pick a different time'), {
                statusCode: 409,
                isOperational: true,
                code: 'SLOT_TAKEN',
              });
            }
          }
        }
      }

      const touched = [];
      for (let i = startIdx; i < siblings.length; i++) {
        const sib = siblings[i];
        // The live anchor (allowLive) moves like a single-job override;
        // every OTHER live/skipped row is still skipped — see the
        // cadence-math comment above.
        const isLiveAnchor = wasLive && String(sib.id) === String(serviceId);
        if (!RESCHEDULABLE.has(sib.status) && !isLiveAnchor) {
          skippedCount += 1;
          continue;
        }

        const occurrenceIndex = i - startIdx;
        const isAnchor = occurrenceIndex === 0;
        // Memoized deduped projection — identical to what the collision
        // probe above locked and probed (codex #3509).
        const date = isAnchor
          ? newDate
          : projectOccurrenceDate(occurrenceIndex, sib);

        // Non-live rows rewind only when this row's date actually changes
        // (same-date landings keep a genuine same-day attempt intact).
        const sibDateChanges = String(date || '').split('T')[0]
          !== String(sib.scheduled_date instanceof Date
            ? sib.scheduled_date.toISOString()
            : sib.scheduled_date || '').slice(0, 10);
        const sibRewound = isLiveAnchor || (sibDateChanges && needsLifecycleRewind(sib));
        // A series move mutates the DATE dimension it owns (owner ruling
        // 2026-08-28): the anchor takes the caller's window and lands on
        // 'confirmed' like any reschedule; every sibling KEEPS its own
        // window, status, tech and overrides — a Sep 10 1–3 PM visit moved
        // to Sep 15 8–10 AM must not silently make Oct–Dec 8–10 AM, and a
        // pending placeholder must stay a placeholder (isSeededPlaceholderRow
        // keys on status; plan-extend counts only pending rows). A kept
        // window is still a window this move writes onto a new date, so under
        // adminWindowRules it must satisfy the shared admin validator
        // (windows start on the hour — AGENTS.md); a sibling that can't is
        // named so the operator fixes that visit's time first instead of the
        // series silently carrying an off-hour start forward.
        let occurrenceWindow;
        // options.clearAnchorWindow: the caller's explicit "clear both bounds"
        // rides IN this transaction with the date move (the Edit appointment
        // modal) — the anchor lands windowless, never half-applied across
        // two transactions. Occupancy probes skip a windowless anchor, as
        // they do for any windowless row.
        const anchorCleared = isAnchor && options.clearAnchorWindow === true;
        if (anchorCleared) {
          occurrenceWindow = { start: null, end: null };
        } else if (isAnchor) {
          occurrenceWindow = seriesOccurrenceWindow(win, sib, options);
        } else {
          // A kept sibling window is still a window this move writes onto a
          // new date, so it passes the canonical validator on EVERY series
          // path (windows start on the hour — AGENTS.md), not only for admin
          // callers. Staff paths abort with the visit named (they can fix
          // that visit's time); customer paths (web, SMS) must not dead-end
          // on a legacy sibling's data — the sibling's start is normalized
          // to its hour, duration kept, same as Quick Move's anchor rule.
          try {
            occurrenceWindow = seriesOccurrenceWindow({ start: null, end: null }, sib, { ...options, adminWindowRules: true });
          } catch (err) {
            if (!(err && (err.statusCode === 422 || err.status === 422))) throw err;
            if (options.adminWindowRules === true) {
              err.message = `The future visit on ${dateOnly(sib.scheduled_date)} keeps a time this move can't carry forward (${err.message}) — fix that visit's time first, then move the series`;
              throw err;
            }
            const [hh] = String(sib.window_start).split(':');
            const flooredStart = `${String(hh).padStart(2, '0')}:00`;
            const sibDuration = windowDurationMinutes(sib.window_start, sib.window_end, sib.estimated_duration_minutes);
            occurrenceWindow = { start: flooredStart, end: deriveWindowEnd(flooredStart, sibDuration) };
            logger.warn(`[rebooker] series sibling ${sib.id} kept an off-hour start ${sib.window_start} — normalized to ${flooredStart} on its new date (${err.message})`);
          }
        }
        // An exception row this shift lands exactly on its cadence date has
        // rejoined the series — clear the flag (the only clearing path until
        // an explicit rejoin operation exists).
        const rejoinsCadence = !isAnchor && sib.date_exception === true
          && String(date).split('T')[0] === pureCadenceDate(occurrenceIndex);
        // Exception bookkeeping: the anchor now DEFINES the cadence (any
        // exception it carried is spent); a kept exception's series position
        // moves to its new cadence slot; a rejoined row is plain cadence again.
        const exceptionUpdate = isAnchor
          ? (sib.date_exception === true ? DATE_EXCEPTION_CLEAR : {})
          : (rejoinsCadence
            ? DATE_EXCEPTION_CLEAR
            : (sib.date_exception === true ? { date_exception_cadence_date: pureCadenceDate(occurrenceIndex) } : {}));
        const updateData = {
          scheduled_date: date,
          window_start: occurrenceWindow.start,
          window_end: occurrenceWindow.end,
          status: isAnchor ? 'confirmed' : sib.status,
          updated_at: trx.fn.now(),
          ...exceptionUpdate,
          ...(sibRewound ? LIVE_LIFECYCLE_RESET : {}),
          // Day change invalidates the row's route sequence — clear it so the
          // destination day appends the stop (consumers sort NULLs last).
          ...(sibDateChanges ? { route_order: null } : {}),
        };
        // Rewound rows need the post-commit cleanup (tech pointer release +
        // customer tracker refresh) — collected here, applied after the trx
        // commits. The sibling SELECT is column-limited, so carry the
        // series' customer_id for the refresh payload. The anchor's flag is
        // tracked separately and drives the anchor cleanup block below —
        // keyed on THIS trx's fresh read (with the same date-change gate),
        // never the outer snapshot, so a concurrent tap after the outer
        // read is covered and a same-day edit that did NOT rewind never
        // clears an active tech.
        if (sibRewound) {
          if (String(sib.id) === String(serviceId)) {
            anchorRewound = true;
            rewoundAnchorRow = { ...sib, customer_id: service.customer_id };
          } else {
            rewoundSiblings.push({ ...sib, customer_id: service.customer_id });
          }
        }
        // The ANCHOR may carry a caller-chosen technician (the customer
        // self-serve path validated its slot against a specific tech's
        // route — dropping that assignment would bypass the slot's
        // conflict guarantee and strand the chosen opening). Same
        // advisory-lock + overlap guard as the single-visit path, scoped
        // to the anchor; siblings keep their existing techs. Callers that
        // omit the option (admin series shifts) are unaffected.
        // Anchor gate span, derived BEFORE the tech-scoped guard (codex
        // #3377 P1 r2): keying that guard on the raw window_end let a
        // null-end anchor skip the slot-reserve tech lock AND the tech
        // overlap query — slot-reservation writers take the tech lock but
        // not the date lock, so the later tech-blind probe alone cannot
        // serialize against them and both could commit an overlap under
        // READ COMMITTED. Stored end wins; else the duration-derived span.
        // Null under the kill switch so the guard keeps its legacy skip.
        const anchorGateEnd = !isAnchor ? null : (updateData.window_end || (
          process.env.REBOOKER_NULL_END_OCCUPANCY === 'off'
            ? null
            : occupancyProbeEnd(updateData.window_start, null, sib.estimated_duration_minutes)
        ));
        if (isAnchor && Object.prototype.hasOwnProperty.call(options, 'technicianId')) {
          updateData.technician_id = options.technicianId || null;
          // Tech change also invalidates the sequence (same rule as the
          // single-reschedule path above).
          if ((options.technicianId || null) !== (sib.technician_id || null)) {
            updateData.route_order = null;
          }
          if (options.technicianId && updateData.window_start && anchorGateEnd) {
            await trx.raw(
              'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
              ['slot-reserve', `${options.technicianId}:${String(date).split('T')[0]}`],
            );
            const overlap = await trx('scheduled_services')
              .where('scheduled_date', date)
              .where('technician_id', options.technicianId)
              .whereNot('id', sib.id)
              .whereNotIn('status', ['cancelled', 'completed'])
              .where((q) => {
                q.whereNull('reservation_expires_at')
                  .orWhereRaw('reservation_expires_at > NOW()');
              })
              .whereRaw(
                "window_start < ?::time AND COALESCE(window_end, window_start + ((COALESCE(NULLIF(estimated_duration_minutes, 0), 60)::text || ' minutes')::interval)) > ?::time",
                [anchorGateEnd, updateData.window_start],
              )
              .first('id');
            if (overlap) {
              if (!overlapAdvisory) {
                throw Object.assign(new Error('That window conflicts with another job on the technician\'s route'), {
                  statusCode: 409,
                  isOperational: true,
                  code: 'SLOT_TAKEN',
                });
              }
              overlapWarnDates.add(String(date).split('T')[0]);
            }
          }
        }
        // Anchor tech-blind occupancy (shared module) — the tech-scoped
        // check above can't see technician-NULL rows and never ran at all
        // for techless anchors. Same throw/handling as the single-visit
        // path; sweptIds excludes every row this sweep is moving.
        if (isAnchor && updateData.window_start) {
          // Duration-aware span shared with the tech guard above (was flat
          // 60, which under-checked a >60-min anchor's tail). Under the
          // kill switch anchorGateEnd is null and this falls back to the
          // legacy flat-60 — this probe always ran, unlike the guard.
          const anchorOccEnd = anchorGateEnd
            || occupancyProbeEnd(updateData.window_start, updateData.window_end, null);
          const anchorOccClash = await findConflictingVisits({
            db: trx,
            date: String(date).split('T')[0],
            windowStart: updateData.window_start,
            windowEnd: anchorOccEnd,
            excludeServiceIds: sweptIds,
            excludeStatuses: TERMINAL,
          });
          if (anchorOccClash.length) {
            if (!overlapAdvisory) {
              throw Object.assign(new Error('That window conflicts with another job on the technician\'s route'), {
                statusCode: 409,
                isOperational: true,
                code: 'SLOT_TAKEN',
              });
            }
            overlapWarnDates.add(String(date).split('T')[0]);
          }
        }
        if (anchorCleared) {
          // Legacy presentation fields too (same clear the windowless
          // sibling park applies) — a cleared anchor must not keep promising
          // the abandoned time through window_display / time_window.
          updateData.time_window = null;
          updateData.window_display = null;
        }
        updateData.track_token_expires_at = scheduledServiceTrackTokenExpiry(
          trx,
          date,
          updateData.window_end,
        );
        if (isMonthBasedPattern) {
          updateData.recurring_nth = opts.nth;
          updateData.recurring_weekday = opts.weekday;
        }

        // Non-anchor siblings land on recomputed cadence dates the route
        // never validated. Under the tech-blind invariant an UNASSIGNED row
        // still OCCUPIES its window — findConflictingVisits counts every
        // non-terminal row regardless of technician_id — so clearing
        // technician_id does NOT resolve a clash; it commits a double-booking
        // that then blocks later offers/reschedules. Unassignment is not a
        // resolution. The series path fixes each sibling's date
        // deterministically from the cadence (nextRecurringDate) and has no
        // tolerance search to slide an occurrence into a free window, so an
        // unplaceable NEAR-TERM sibling aborts the whole all-or-none shift
        // the same way the anchor and single-visit paths signal an
        // unresolvable conflict — throw SLOT_TAKEN, roll back, commit
        // nothing overlapping. BEYOND the clash horizon (see
        // SERIES_SIBLING_CLASH_HORIZON_DAYS) the overlap is with
        // placeholder-land, not a real route: commit the cadence date the
        // owner ruling calls for and flag the occurrence (`conflicted`) for
        // the callers' admin-review parking instead of dead-ending the
        // customer.
        let sibClashBeyondHorizon = false;
        if (!isAnchor && updateData.window_start) {
          // Kept-tech slot-reserve lock (rung 3) — same lock the anchor and
          // single-visit paths take, keeping the global order even though the
          // check itself is tech-blind: a concurrent assignment on this
          // tech+date must serialize behind us, not pass its own overlap
          // check and double-book before this trx commits.
          if (sib.technician_id) {
            await trx.raw(
              'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
              ['slot-reserve', `${sib.technician_id}:${String(date).split('T')[0]}`],
            );
          }
          // Null window_end (schema-legal) must not collapse the probe to a
          // zero-length window — mirror the SQL predicate's duration-or-60
          // fallback (was flat 60, which under-probed >60-min services).
          const occEnd = occupancyProbeEnd(
            updateData.window_start,
            updateData.window_end,
            process.env.REBOOKER_NULL_END_OCCUPANCY === 'off' ? null : sib.estimated_duration_minutes,
          );
          // Tech-blind occupancy (shared module) — a strict superset of the
          // old tech-scoped probe (it also catches technician-NULL rows and
          // ran even for techless siblings). sweptIds excludes exactly the
          // rows this sweep is moving; everything else counts (boosters,
          // pre-anchor cadence rows that stayed put, other plans).
          const occClash = await findConflictingVisits({
            db: trx,
            date: String(date).split('T')[0],
            windowStart: updateData.window_start,
            windowEnd: occEnd,
            excludeServiceIds: sweptIds,
            excludeStatuses: TERMINAL,
          });
          if (occClash.length) {
            if (overlapAdvisory) {
              // Staff-advisory mode (admin dispatch): overlaps never block a
              // save — collect the date for the warnings[] the route returns.
              overlapWarnDates.add(String(date).split('T')[0]);
            } else if (siblingClashWithinHorizon(date) || !occClash.every(isSeededPlaceholderRow)) {
              // A near-term projection onto an occupied window is a real
              // double-booking — and so is a far-out one whose occupant is
              // anything but a seeded placeholder (isSeededPlaceholderRow).
              // Abort all-or-none. subcode lets customer
              // surfaces explain that the WINDOW doesn't fit the plan (another
              // time may), instead of the misleading "just taken" retry loop
              // (code stays SLOT_TAKEN — rain-out and admin callers branch
              // on it and must keep working unchanged).
              throw Object.assign(new Error('That time doesn\'t work with this plan\'s upcoming visits — try another time or day'), {
                statusCode: 409,
                isOperational: true,
                code: 'SLOT_TAKEN',
                subcode: 'SERIES_PROJECTION',
              });
            } else {
              // Beyond the horizon and every occupant is a seeded
              // placeholder: commit the occurrence at its cadence date
              // WINDOWLESS. A windowless row carries no occupancy (the
              // probe's window predicate never matches it), so no two
              // occupying rows ever share the window — the invariant holds
              // — and the NULL window is the durable signal: dispatch
              // routes windowless rows freely and the operator retimes it
              // as the date approaches, exactly like a windowless prepay
              // seed. Flagged (`conflicted`) so callers park the review
              // notification as well.
              sibClashBeyondHorizon = true;
              updateData.window_start = null;
              updateData.window_end = null;
              // Legacy presentation fields too: seeded children inherit the
              // parent's time_window, and customer-facing context / route
              // reorder fall back to window_display → time_window when
              // window_start is null — left alone they would keep promising
              // the abandoned time.
              updateData.time_window = null;
              updateData.window_display = null;
              // Expiry was derived from the timed window above — recompute
              // for the windowless row (helper applies its windowless default).
              updateData.track_token_expires_at = scheduledServiceTrackTokenExpiry(trx, date, null);
              logger.warn(`[rebooker] series re-anchor for ${serviceId}: occurrence ${sib.id} projected onto a seeded-placeholder window ${String(date).split('T')[0]} ${occurrenceWindow.start} beyond the ${SERIES_SIBLING_CLASH_HORIZON_DAYS}d clash horizon — committed at cadence WITHOUT a window, flagged for retiming`);
            }
          }
        }

        // Atomic optimistic guard for EVERY row — same contract as the
        // single-job path, and it carries the previously READ scheduling
        // fields, not just status: a concurrent reschedule usually leaves
        // status 'confirmed', so status alone would let this sweep
        // overwrite a newer date/window/tech edit. ANY raced row aborts
        // the whole trx — the series shift is all-or-none, so the customer
        // is never told "your visits moved" while one stayed on the old
        // cadence.
        const updated = await applyTrackLifecycleCas(
          trx('scheduled_services')
            .where({
              id: sib.id,
              status: sib.status,
              scheduled_date: sib.scheduled_date,
              window_start: sib.window_start,
              // window_end and technician_id are overwritten by this sweep
              // (duration + the conflict-unassign decision were computed from
              // the values read above) — a concurrent resize/reassignment
              // must invalidate the match, not be steamrolled.
              window_end: sib.window_end ?? null,
              technician_id: sib.technician_id ?? null,
              // Duration pin, only when the occupancy probes above derived
              // their span from it (null landing end + gate on): a
              // concurrent duration-only edit must invalidate the match —
              // same rationale as the single-path CAS (codex #3377 P1).
              // Also pinned when a start-only move derived this row's end
              // from its own duration (seriesOccurrenceWindow).
              ...(((!updateData.window_end && process.env.REBOOKER_NULL_END_OCCUPANCY !== 'off') || (win.start && !win.end))
                ? { estimated_duration_minutes: sib.estimated_duration_minutes ?? null }
                : {}),
            }),
          // Full tracker/lifecycle snapshot too: the sibRewound decision
          // came from this read — see the single-job CAS above.
          sib,
        )
          // RETURNING the snapshot columns: the persisted values (the
          // SQL-computed expiry, updated_at = the Undo version stamp) from
          // the same statement that wrote them — no second read.
          .update(updateData, SERIES_MOVE_SNAPSHOT_COLUMNS);
        const updatedRows = Array.isArray(updated) ? updated : null;
        if ((updatedRows ? updatedRows.length : updated) === 0) {
          throw Object.assign(new Error('Cannot reschedule — an appointment in this series changed concurrently'), {
            statusCode: 409,
            isOperational: true,
            code: 'SLOT_TAKEN',
          });
        }
        if (sibClashBeyondHorizon || (anchorCleared && sib.window_start)) {
          // The row just went timed → windowless: pre-close its reminder in
          // THIS trx (windows_preclosed marker), or the sync trigger's
          // recompute leaves it armed for the 08:00 placeholder time.
          const AppointmentReminders = require('./appointment-reminders');
          await AppointmentReminders.precloseWindowlessReminderInTx(trx, sib.id);
        }

        if (isAnchor && sib.status !== 'confirmed') {
          // transitioned_by is a UUID FK to technicians; the route
          // currently passes the sentinel 'admin' string for
          // initiatedBy, which would violate the FK. Until we plumb
          // the real authenticated admin UUID, leave this null —
          // reschedule_log.initiated_by below preserves the 'admin'
          // sentinel for the action audit.
          await trx('job_status_history').insert({
            job_id: sib.id,
            from_status: sib.status,
            to_status: 'confirmed',
            transitioned_by: null,
          });
        }
        moveRows.push({
          id: sib.id,
          anchor: isAnchor,
          exception: !isAnchor && sib.date_exception === true && !rejoinsCadence,
          before: snapshotRow(sib),
          after: snapshotRow({ ...sib, ...updateData, ...(updatedRows?.[0] || {}) }),
        });
        touched.push({
          id: sib.id,
          date,
          windowStart: sibClashBeyondHorizon ? null : occurrenceWindow.start,
          windowEnd: sibClashBeyondHorizon ? null : occurrenceWindow.end,
          // True only for a BEYOND-horizon occurrence whose projected window
          // held a seeded placeholder — committed at its cadence date
          // WINDOWLESS (see above); near-term clashes and real-booking
          // clashes abort the whole trx and never reach here. Callers
          // (admin-dispatch, reschedule-public) park flagged occurrences as a
          // schedule_conflict admin notification for retiming; the tech is
          // KEPT.
          conflicted: sibClashBeyondHorizon,
        });
      }

      // A call-booked package's follow-up (visit 2, linked by
      // parent_service_id — not a cadence sibling) stays spaced from its
      // primary. INSIDE this trx: the shift applies a delta and is not
      // idempotent, so it must land exactly once with the move (a replay of
      // a committed move must never re-run it). Tech-day locks it takes are
      // rung-3, after this trx's rung-1 date locks — the ordering contract.
      const followUpsShifted = await shiftCallFollowUpsForParentMove({
        conn: trx,
        parentServiceId: serviceId,
        fromDate: dateOnly(service.scheduled_date),
        toDate: seriesDateStr,
      });
      if (followUpsShifted > 0) {
        logger.info(`[rebooker] shifted ${followUpsShifted} call-created follow-up visit(s) with series anchor ${serviceId} (-> ${seriesDateStr})`);
      }

      // One operation row per shift — the audit boundary, the idempotency
      // key for every side effect, and the Undo source of truth. Inside the
      // trx: a shift with no record is as bad as a record with no shift.
      // The partial unique index on operation_key (committed rows only)
      // makes two concurrent same-key requests serialize here — the loser
      // rolls back and replays the winner's result (see the catch below).
      seriesMoveId = crypto.randomUUID();
      if (opKey.derived) {
        // A derived key beyond the retry horizon is a NEW action on the same
        // slot: retire its predecessor so the committed-rows unique index
        // admits this move (the old row keeps its snapshots for Undo).
        await trx('series_moves')
          .where({ anchor_service_id: serviceId, operation_key: operationKey, status: 'committed' })
          .update({ status: 'superseded' });
      }
      // The replay payload is written WITH the row, in this trx — a
      // committed move whose result a later retry cannot see would let that
      // retry claim effects without any occurrences to sync.
      const exceptionCount = moveRows.filter((r) => r.exception).length;
      const seriesWarnings = [...overlapWarnDates].sort().map((d) => {
        const { slotOverlapWarning } = require('./scheduling/window-rules');
        return slotOverlapWarning(d);
      });
      committedResult = {
        success: true,
        originalDate: dateOnly(service.scheduled_date),
        newDate,
        occurrencesRescheduled: touched.length,
        rescheduledOccurrences: touched,
        deltaDays,
        skippedCount,
        exceptionCount,
        ...(seriesWarnings.length ? { warnings: seriesWarnings } : {}),
      };
      await trx('series_moves').insert({
        id: seriesMoveId,
        ...failedMoveFields,
        movable_count: touched.length,
        skipped_count: skippedCount,
        exception_count: exceptionCount,
        conflict_count: touched.filter((t) => t.conflicted).length,
        status: 'committed',
        rows: JSON.stringify(moveRows),
        result: JSON.stringify(committedResult),
      });

      await trx('reschedule_log').insert({
        scheduled_service_id: serviceId,
        customer_id: service.customer_id,
        original_date: service.scheduled_date,
        new_date: newDate,
        reason_code: `${reason}_series`,
        initiated_by: initiatedBy,
        original_window: service.window_start ? `${service.window_start}-${service.window_end}` : null,
        new_window: win.start ? `${win.start}-${win.end}` : null,
        series_move_id: seriesMoveId,
      });

      return touched;
    }).catch(async (err) => {
      // Two concurrent identical operations: the loser usually fails an
      // appointment CAS (SLOT_TAKEN) before it ever reaches the unique
      // series_moves insert (23505). On a transactional conflict, replay
      // ONLY a row proven to be this attempt's concurrent winner (committed
      // after the row the pre-trx lookup judged, same request, anchor now
      // where it left it) — the caller's action did happen. A slot conflict
      // or concurrent edit with no such winner is a real failure: an older
      // row under this key (the A→B row behind a C→B return move) must
      // never be reported as this attempt's success while the anchor sits
      // elsewhere.
      if (err?.code === '23505' || err?.statusCode === 409) {
        const winner = await findConcurrentSeriesMoveWinner(db, serviceId, opKey, observedPrior.row).catch(() => null);
        if (winner) return { replayedFrom: winner };
      }
      await recordFailedSeriesMove(failedMoveFields, err);
      throw err;
    });
    if (occurrencesRescheduled && occurrencesRescheduled.replayedFrom) {
      await replaySeriesMoveCleanup(occurrencesRescheduled.replayedFrom);
      return replaySeriesMoveResult(occurrencesRescheduled.replayedFrom, newDate);
    }

    // Live-anchor post-commit cleanup — same pattern as the single-job
    // override in reschedule(): free the tech_status pointer and push
    // the customer-tracker refresh so an open TrackPage doesn't sit on
    // the stale en-route / on-site screen. Keyed on the trx's OWN rewind
    // decision (anchorRewound — fresh read, date-change gated), so a
    // same-day edit that preserved the lifecycle never clears an active
    // tech, and a concurrent tap after the outer read is still covered.
    if (wasLive || anchorRewound) {
      // The trx-fresh anchor row wins over the outer snapshot: a concurrent
      // reassignment between the two reads would otherwise clear the OLD
      // tech (or none) and leave the current tech pinned to the moved
      // visit. Falls back to the outer read when the fresh row carries no
      // tech — clearTechCurrentJob is conditional on the job pointer, so a
      // stale fallback is a no-op at worst.
      const anchorTechId = rewoundAnchorRow?.technician_id ?? service.technician_id;
      if (anchorTechId) {
        try {
          await clearTechCurrentJob({
            tech_id: anchorTechId,
            current_job_id: serviceId,
            status: 'idle',
          });
        } catch (err) {
          logger.error(`[rebooker] tech_status clear after live series reschedule failed for ${serviceId}: ${err.message}`);
        }
      }
      emitCustomerJobRefresh({ ...service, ...(rewoundAnchorRow || {}), id: serviceId }, 'confirmed');
    }
    // Rewound non-anchor siblings get the same cleanup: release any tech
    // pinned to them and refresh open trackers. Siblings keep their own
    // status in the sweep, so the refresh carries it. Best-effort per row.
    for (const rewoundSib of rewoundSiblings) {
      try {
        await applyLiveMovePostCommitEffects(rewoundSib, { toStatus: String(rewoundSib.status) });
      } catch (err) {
        logger.error(`[rebooker] track-rewind cleanup failed for series sibling ${rewoundSib.id}: ${err.message}`);
      }
    }

    // Same escalation check the single-visit path runs — a series re-anchor
    // is still a reschedule of this visit, and the manual-review threshold
    // must not be bypassable by qualifying for the series path.
    try {
      const count = await db('reschedule_log')
        .where({ scheduled_service_id: serviceId })
        .count('* as count').first();
      if (parseInt(count.count) >= RULES.escalation.max_auto_reschedules_per_service) {
        logger.warn(`Service ${serviceId} has been rescheduled ${count.count} times (latest as a series re-anchor) — needs manual review`);
        await db('reschedule_log').where({ scheduled_service_id: serviceId }).orderBy('created_at', 'desc').first()
          .then((log) => log && db('reschedule_log').where({ id: log.id }).update({ escalated: true }));
      }
    } catch (err) {
      logger.warn(`[rebooker] series escalation check failed for ${serviceId}: ${err.message}`);
    }

    // Same legacy-activation seam as the single-visit path (Codex #3361 r5
    // P0): the series update writes scheduled_services directly — a LEGACY
    // outbound-review anchor moved (and possibly texted) here would stay
    // customer_confirmed=false with its reminders, lead, and review card
    // stranded. Best-effort post-commit, at-most-once via the helper.
    try {
      const { activateLegacyOutboundReviewRowIfNeeded } = require('./outbound-review-confirm');
      await activateLegacyOutboundReviewRowIfNeeded(db, serviceId, 'rebooker-reschedule-series');
    } catch (activateErr) {
      logger.warn(`[rebooker] legacy outbound activation failed for series anchor ${serviceId}: ${activateErr.message}`);
    }

    // Same payload the row stores (originalDate as the raw column value,
    // matching the single path's return shape).
    return { ...committedResult, originalDate: service.scheduled_date, seriesMoveId };
  }

  // Read-only preview of what rescheduleSeries would touch — the server
  // contract every surface renders ("Move visit + N future visits", the IB
  // pending-action card). No client computes N. Same sibling selection and
  // projector as the move; conflicts are probed without locks for the
  // projected SIBLINGS (the anchor's own window is the caller's choice and is
  // validated by the move itself).
  async previewSeriesMove(serviceId, newDate) {
    const service = await db('scheduled_services').where({ id: serviceId }).first();
    if (!service) throw Object.assign(new Error('Service not found'), { statusCode: 404 });
    const seriesDateStr = dateOnly(newDate);
    const empty = {
      collective: false, deltaDays: 0, movableCount: 0, skippedCount: 0,
      exceptionCount: 0, conflictCount: 0, firstAffectedDate: null, lastAffectedDate: null,
    };
    if (service.is_recurring !== true || !seriesDateStr || seriesDateStr === dateOnly(service.scheduled_date)) {
      return empty;
    }
    const parentId = service.recurring_parent_id || service.id;
    const parent = await db('scheduled_services').where({ id: parentId }).first();
    if (!parent || (!parent.is_recurring && !parent.recurring_pattern)) return empty;
    const TERMINAL = ['completed', 'cancelled'];
    const siblings = await db('scheduled_services')
      .whereRaw('(id = ? OR (recurring_parent_id = ? AND is_recurring = true))', [parentId, parentId])
      .where('customer_id', service.customer_id)
      .whereRaw('COALESCE(date_exception_cadence_date, scheduled_date) >= ?::date', [seriesPosition(service)])
      .whereNotIn('status', TERMINAL)
      .orderByRaw('COALESCE(date_exception_cadence_date, scheduled_date) asc, scheduled_date asc')
      .select('id', 'status', 'scheduled_date', 'window_start', 'window_end', 'estimated_duration_minutes', 'date_exception', 'date_exception_cadence_date');
    const droppedIdx = siblings.findIndex((s) => String(s.id) === String(serviceId));
    if (droppedIdx === -1) return empty;
    const { deltaDays, projectOccurrenceDate } = await makeSeriesProjector({ service, parent, newDate, seriesDateStr });
    const swept = siblings.slice(droppedIdx);
    // Staff surfaces move a live anchor (allowLive); every other live/skipped
    // row is counted-but-not-moved, exactly as the sweep does.
    const movable = swept.filter((row, idx) => RESCHEDULABLE_STATUSES.has(row.status)
      || (idx === 0 && LIVE_OVERRIDE_STATUSES.has(row.status)));
    const sweptIds = movable.map((row) => String(row.id));
    const dates = [];
    let conflictCount = 0;
    for (let i = 0; i < swept.length; i++) {
      const row = swept[i];
      if (!movable.includes(row)) continue;
      const date = projectOccurrenceDate(i, row);
      dates.push(date);
      if (i === 0 || !row.window_start) continue;
      const clash = await findConflictingVisits({
        db,
        date,
        windowStart: row.window_start,
        windowEnd: occupancyProbeEnd(row.window_start, row.window_end, row.estimated_duration_minutes),
        excludeServiceIds: sweptIds,
        excludeStatuses: TERMINAL,
      });
      if (clash.length) conflictCount += 1;
    }
    dates.sort();
    return {
      collective: true,
      deltaDays,
      movableCount: movable.length,
      skippedCount: swept.length - movable.length,
      exceptionCount: movable.filter((row, idx) => idx > 0 && row.date_exception === true).length,
      conflictCount,
      firstAffectedDate: dates[0] || null,
      lastAffectedDate: dates[dates.length - 1] || null,
    };
  }
}

// Side effects reschedule() applies around a live (en_route/on_site) move,
// shared with the raw movers that flip live rows → 'confirmed' outside
// SmartRebooker (admin bulk reschedule, IB reschedule_appointment, IB
// move_stops_to_day). Without these, a live move flips the row but:
//   1. skips the job_status_history append (the repo's audit trail) — runs
//      on `conn`, so a transactional caller keeps it atomic with the flip;
//   2. leaves tech_status pointing at the moved job (tech shows en route /
//      on site forever) — released best-effort, same as the post-commit
//      cleanup in reschedule(); clearTechCurrentJob only clears when the
//      pointer still targets this job;
//   3. leaves an open TrackPage on the stale live screen — refresh pushed.
// Call AFTER the caller's status UPDATE, and only for rows that were live.
// `svc` is the pre-update row (id / status / customer_id / technician_id);
// `actor` is the acting technician/staff uuid for history attribution
// (null = system, matching reschedule()'s own insert).
// Transactional half: the job_status_history append. Runs on `conn` so a
// transactional caller keeps it atomic with the status flip — and ONLY this
// half may run inside a caller's transaction (see below).
async function applyLiveMoveHistory(conn, svc, { actor = null } = {}) {
  if (String(svc.status) !== 'confirmed') {
    await conn('job_status_history').insert({
      job_id: svc.id,
      from_status: svc.status,
      to_status: 'confirmed',
      transitioned_by: actor,
    });
  }
}

// Post-commit half: tech_status release + customer tracker refresh. Both are
// externally visible outside the caller's transaction (clearTechCurrentJob
// writes via the GLOBAL db connection; the socket emit reaches clients
// immediately), so a transactional caller MUST run this only after a
// successful commit — otherwise a rollback leaves the tech cleared and
// clients holding a phantom refresh for a move that never happened. Matches
// reschedule()'s own post-commit sequencing above.
// toStatus: the operational status the customer refresh should carry —
// 'confirmed' for a genuine live move (the movers land those on
// 'confirmed'), the row's unchanged status for a tracker-evidence-only
// rewind (track_state was live but status never synced, so the move did
// not flip it).
async function applyLiveMovePostCommitEffects(svc, { toStatus = 'confirmed' } = {}) {
  if (svc.technician_id) {
    try {
      await clearTechCurrentJob({
        tech_id: svc.technician_id,
        current_job_id: svc.id,
        status: 'idle',
      });
    } catch (err) {
      logger.error(`[rebooker] tech_status clear after live move failed for ${svc.id}: ${err.message}`);
    }
  }
  emitCustomerJobRefresh(svc, toStatus);
}

// Convenience composition for NON-transactional callers (the IB movers run
// their UPDATE directly on db, so "after the update" is already
// post-commit). Transactional callers (admin bulk reschedule) must call the
// two halves separately: applyLiveMoveHistory on the trx, then
// applyLiveMovePostCommitEffects after the commit.
async function applyLiveMoveSideEffects(conn, svc, opts = {}) {
  // The two halves are INDEPENDENT for non-transactional callers: the move has
  // already committed, so the audit-history append is best-effort, but the
  // operational cleanup (tech_status release + tracker refresh) is not — a
  // failed history insert must NOT skip it, or the tech stays pinned to the
  // moved job and the customer sees a stale live tracker while the caller still
  // reports success. Catch (not await-through) the history append so cleanup
  // always runs; a history failure is still logged.
  try {
    await applyLiveMoveHistory(conn, svc, opts);
  } catch (err) {
    logger.error(`[rebooker] live-move history append failed for ${svc.id}: ${err.message}`);
  }
  await applyLiveMovePostCommitEffects(svc);
}

module.exports = new SmartRebooker();
// Shared with the IB schedule tools + bulk admin movers so every reschedule
// path applies the same live-lifecycle rewind (see comment on the constant).
module.exports.LIVE_LIFECYCLE_RESET = LIVE_LIFECYCLE_RESET;
module.exports.needsLifecycleRewind = needsLifecycleRewind;
module.exports.applyTrackLifecycleCas = applyTrackLifecycleCas;
module.exports.applyLiveMoveSideEffects = applyLiveMoveSideEffects;
module.exports.applyLiveMoveHistory = applyLiveMoveHistory;
module.exports.applyLiveMovePostCommitEffects = applyLiveMovePostCommitEffects;
module.exports.isMonthBasedRecurrence = isMonthBasedRecurrence;
// Exported for tests: the per-occurrence window derivation (rollback toggle +
// admin window rules) the series mover applies to every sibling.
module.exports.seriesOccurrenceWindow = seriesOccurrenceWindow;
module.exports.collectiveMoveGateOn = collectiveMoveGateOn;
module.exports.dateExceptionStamp = dateExceptionStamp;
module.exports.nextRecurringDate = nextRecurringDate;
module.exports.recurrenceOrdinalOptions = recurrenceOrdinalOptions;
module.exports.SERIES_MOVE_SNAPSHOT_COLUMNS = SERIES_MOVE_SNAPSHOT_COLUMNS;
