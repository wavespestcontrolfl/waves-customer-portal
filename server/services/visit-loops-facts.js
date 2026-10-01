/**
 * Visit status and open loops: the READ-ONLY facts the texting AI was missing
 * in the 2026-09-30 blind bake-off (live tech position / lateness, a missed
 * visit, promises we owe, asks the customer is still waiting on). Everything
 * here is already in Postgres; nothing writes, nothing sends.
 *
 * No visit note: scheduled_services.notes is staff/booking scratch (booking
 * notes, office remarks, access details) and only sometimes the tech's own
 * text, so it never feeds a customer-facing prompt from here (PR #5499 r1).
 *
 * context-aggregator attaches the result as `context.visitLoops`. Every field
 * is nullable / an empty array, and every query is isolated: a failure yields
 * that one field null (or []) and a warn log, never a throw, so a broken
 * dispatch table can never take the whole customer context down with it.
 *
 * Interpretation notes (the drafter decides what to say, not this module):
 *  - "today's visit" = the first upcoming row whose scheduled_date is today
 *    (ET). Position, late alert, passed-window and live-note facts are about
 *    today's visit(s) only.
 *  - The window judged "passed" is the CUSTOMER-FACING one (window_start plus
 *    the standard arrival window, exactly what deriveWindow quotes), not the
 *    internal job block in window_end: calling a 9-11 visit "late" at 10:15
 *    because dispatch blocked 60 minutes would contradict what the customer
 *    was told. window_end is the fallback only when there is no start.
 *  - Call promises are read whatever GATE_CALL_COMMITMENTS says: it is a WRITE
 *    gate, and promises recorded while it was on stay owed after a rollback
 *    (admin-call-recordings.js reads them ungated too). SMS rows need
 *    smsCommitmentsEnabled(); email rows need GATE_EMAIL_OPERATIONAL_ACTIONS.
 */
const db = require('../models/db');
const logger = require('./logger');
const { etDateString, etParts, addETDays } = require('../utils/datetime-et');
const { arrivalWindowRange } = require('../utils/sms-time-format');
const { calendarDay } = require('./live-eta-destination');
const { UPCOMING_SERVICE_STATUSES } = require('./visit-context/statuses');
const { gateEnvValue } = require('../config/feature-gates');
const { FUTURE_TIMESTAMP_TOLERANCE_MS } = require('./customer-tracking-eta');

const FRESH_LOCATION_MS = 5 * 60 * 1000;
const DESCRIPTION_MAX = 120;
const LIST_MAX = 5;
const MISSED_LOOKBACK_DAYS = 7;
const LATE_ALERT_TYPES = ['tech_late', 'unassigned_overdue'];
// A visit nobody has performed or started: the only statuses a "window passed"
// or a "never completed" reading is true of.
const NOT_STARTED_STATUSES = ['pending', 'confirmed'];
const LIVE_TRACK_STATES = ['en_route', 'on_property', 'on_site'];
const ON_SITE_STATUSES = ['on_site', 'on_property'];

function emptyVisitLoops() {
  return {
    techPosition: null,
    lateAlert: null,
    pastWindow: null,
    missedVisit: null,
    weOwe: [],
    customerWaiting: [],
  };
}

// Run one field's loader; any failure (a sync throw from a builder, a rejected
// query) becomes the fallback and a warn log.
async function safely(field, fallback, fn) {
  try {
    const value = await fn();
    return value === undefined ? fallback : value;
  } catch (err) {
    logger.warn(`[visit-loops-facts] ${field} unavailable: ${err?.message || err}`);
    return fallback;
  }
}

const clip = (value, max) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const toDate = (value) => {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};
const parseJson = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return null; } }
  return value;
};
const hhmmToMinutes = (value) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const nowEtMinutes = (now) => {
  const p = etParts(now);
  return p.hour * 60 + p.minute;
};
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;

// Coarse service family for "was a later visit of the same service booked":
// the same buckets the customer would use, never a price or plan rule.
function familyKey(serviceType) {
  const t = String(serviceType || '').toLowerCase();
  // explicit tree/shrub tokens first: "Tree & Shrub Fertilization" is not lawn
  if (/tree|shrub|ornamental/.test(t)) return 'tree_shrub';
  if (/lawn|turf|fertiliz|weed|sod/.test(t)) return 'lawn';
  if (/mosquito/.test(t)) return 'mosquito';
  if (/termite|wdo|wood.destroying/.test(t)) return 'termite';
  if (/rodent|\brats?\b|mice|mouse/.test(t)) return 'rodent';
  if (/pest|roach|\bants?\b|spider|perimeter|general|bug/.test(t)) return 'pest';
  return t.trim() || null;
}

// The customer-facing end of the arrival window, in ET minutes since midnight of
// the visit day; a window that crosses midnight (23:00-01:00) ends past 1440.
// Only from window_start's arrival range: window_end is the internal job block,
// never a promised cutoff, so a row without a start has no cutoff at all.
function customerWindowEndMinutes(row) {
  const start = hhmmToMinutes(row.window_start);
  const range = arrivalWindowRange(String(row.window_start || ''));
  const end = range ? hhmmToMinutes(range.split('-')[1]) : null;
  if (end == null || start == null) return null;
  return end < start ? end + 1440 : end;
}

function windowLabel(row, deriveWindow) {
  try {
    const derived = typeof deriveWindow === 'function' ? deriveWindow(row) : null;
    if (derived) return derived;
  } catch { /* fall through to the stored display */ }
  const display = String(row.window_display || '').trim();
  if (display) return display;
  const tw = String(row.time_window || '').trim();
  return tw ? tw.charAt(0).toUpperCase() + tw.slice(1) : null;
}

// ── today's visits ──────────────────────────────────────────────────────────
// ALL of the customer's live visits today (ET), earliest first — not the
// aggregator's upcoming list, which caps at three rows (a four-service day exists).
async function loadTodayRows(customerId, { conn, now }) {
  const today = etDateString(now);
  const yesterday = etDateString(addETDays(now, -1));
  const rows = await conn('scheduled_services as ss')
    .leftJoin('technicians as tech', 'ss.technician_id', 'tech.id')
    .where('ss.customer_id', customerId)
    .whereIn('ss.scheduled_date', [today, yesterday])
    .whereIn('ss.status', UPCOMING_SERVICE_STATUSES)
    .orderByRaw('ss.window_start ASC NULLS LAST, ss.route_order ASC NULLS LAST, ss.id ASC')
    .select('ss.id', 'ss.visit_id', 'ss.technician_id', 'ss.route_order', 'ss.scheduled_date', 'ss.status', 'ss.track_state',
      'ss.window_start', 'ss.window_end', 'ss.window_display', 'ss.time_window', 'ss.service_type', 'tech.name as technician_name');
  // yesterday's rows only while their arrival window still runs past midnight
  // (a 23:00 visit is live until 01:00) — the same rule that keeps them out of
  // missed visits until then
  const nowMin = nowEtMinutes(now);
  return (rows || []).filter((r) => calendarDay(r.scheduled_date) === today || crossesIntoNow(r, nowMin));
}
// A visit dated yesterday whose customer-facing window rolls past midnight and has
// not yet ended at nowMin (ET minutes of today).
function crossesIntoNow(row, nowMin) {
  const end = customerWindowEndMinutes(row);
  return end != null && end > 1440 && nowMin < end - 1440;
}

// Stops before this visit: ONLY the customer tracker's own count (stops-ahead.js
// computeStopsAhead — dispatch sort order, sibling state, GATE_STOPS_AWAY, the
// three-stop cap, the never-increase floor), read-only: a number is used only when
// it is already the durable floor the tracker shows; otherwise none. An SMS never
// states a count the tracker would not, and this module never writes.
async function trackerStopsAhead(conn, visit, now, strict) {
  // strict (send-time rebuild): an outage throws instead of reading as "no count"
  const result = await require('./stops-ahead').computeStopsAhead(conn, String(visit.id), { readOnly: true, today: etDateString(now), throwOnError: Boolean(strict) });
  return Number.isInteger(result?.stopsAhead) ? result.stopsAhead : null;
}

async function loadTechPosition(todayRows, { conn, now, deriveWindow, strict }) {
  const visit = todayRows.find((r) => r.technician_id);
  if (!visit) return null;
  const status = await conn('tech_status').where({ tech_id: visit.technician_id })
    .first('status', 'current_job_id', 'location_updated_at');
  const updatedAt = toDate(status?.location_updated_at);
  const ageMs = updatedAt ? now.getTime() - updatedAt.getTime() : null;
  // The tracker stores the provider's fix time and accepts it slightly in the
  // future (tech-status.js), so a small negative age is a fresh fix.
  const fresh = ageMs != null && ageMs >= -FUTURE_TIMESTAMP_TOLERANCE_MS && ageMs <= FRESH_LOCATION_MS;

  // A started visit (by status or tracker) has no stops "before" it — and the send
  // recount rejects started visits — so only a not-started visit carries a count.
  // ...and a fresh tech_status whose current job is this visit (on site, or driving
  // to it) leads a lagging 'confirmed' row the same way.
  const currentJob = fresh && String(status?.current_job_id ?? '') === String(visit.id);
  const notStarted = NOT_STARTED_STATUSES.includes(visit.status) && !currentJob
    && !LIVE_TRACK_STATES.includes(visit.track_state) && visit.track_state !== 'complete';
  const stopsAhead = notStarted ? await trackerStopsAhead(conn, visit, now, strict) : null;
  return {
    techName: firstName(visit.technician_name),
    status: fresh ? String(status.status) : 'stale',
    minutesSinceUpdate: ageMs == null ? null : Math.max(0, Math.floor(ageMs / 60000)),
    stopsAhead,
    // current_job_id is set from en_route on, so "at this visit" also needs an
    // on-site status; driving to it is "en route", not "at this visit now".
    atThisVisit: currentJob && ON_SITE_STATUSES.includes(String(status.status)),
    // Which of today's visits this is about (a customer can have two today).
    visitId: String(visit.id),
    techId: String(visit.technician_id),
    windowStart: visit.window_start || null,
    visitType: visit.service_type || null,
    windowDisplay: windowLabel(visit, deriveWindow),
  };
}

// Does an alert's own record of the window (tech-late-detector: scheduled_date +
// window_start; no-show-detector: promised_window.start_at) still describe the
// visit's current occurrence? An alert that records NONE is rejected: reschedules
// do not resolve alerts, so an unstamped one cannot be shown to be about today's slot.
const ET_HHMM = { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
function alertMatchesOccurrence(payload, visit) {
  const p = payload && typeof payload === 'object' ? payload : {};
  if (!p.scheduled_date && !p.window_start && !(p.promised_window && p.promised_window.start_at)) return false;
  if (p.scheduled_date && calendarDay(p.scheduled_date) !== calendarDay(visit.scheduled_date)) return false;
  const visitStart = hhmmToMinutes(visit.window_start);
  if (p.window_start && hhmmToMinutes(p.window_start) !== visitStart) return false;
  const promised = toDate(p.promised_window && p.promised_window.start_at);
  if (promised) {
    if (etDateString(promised) !== calendarDay(visit.scheduled_date)) return false;
    if (hhmmToMinutes(promised.toLocaleTimeString('en-US', ET_HHMM)) !== visitStart) return false;
  }
  return true;
}

async function loadLateAlert(todayRows, { conn, deriveWindow }) {
  const ids = todayRows.map((r) => r.id);
  if (!ids.length) return null;
  const alerts = await conn('dispatch_alerts')
    .whereIn('job_id', ids).whereIn('type', LATE_ALERT_TYPES).whereNull('resolved_at')
    .orderBy('created_at', 'desc')
    .select('type', 'severity', 'payload', 'job_id');
  // Bound to the visit AND the occurrence it was raised on: with two visits today a
  // delay on the afternoon stop must not read as the morning one, and an alert left
  // over from before a same-day reschedule (reschedules do not resolve it) must not
  // read as the new window running late.
  let visit = null;
  let payload = null;
  const alert = (alerts || []).find((a) => {
    visit = todayRows.find((r) => String(r.id) === String(a.job_id)) || null;
    payload = parseJson(a.payload);
    return visit && alertMatchesOccurrence(payload, visit);
  });
  if (!alert) return null;
  const where = { visitId: String(visit.id), windowStart: visit.window_start || null, visitType: visit.service_type || null, windowDisplay: windowLabel(visit, deriveWindow) };
  // no-show-detector raises the same two types on missing tracking alone (stage 1
  // is 45 min into an open window): that is a tracking gap, not confirmed lateness.
  if (payload?.evidence === 'missing_tracking') {
    return { type: alert.type, severity: alert.severity || null, minutesLate: null, missingTracking: true, ...where };
  }
  const minutes = Number(payload?.delay_minutes);
  return {
    type: alert.type,
    severity: alert.severity || null,
    minutesLate: Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : null,
    missingTracking: false,
    ...where,
  };
}

async function findPastWindow(todayRows, { conn, now, deriveWindow }) {
  const nowMin = nowEtMinutes(now);
  const candidates = todayRows.filter((row) => NOT_STARTED_STATUSES.includes(row.status)
    && !LIVE_TRACK_STATES.includes(row.track_state)
    // the same completion evidence loadMissedVisit honors: a tracker that reached
    // 'complete' ahead of a lagging status, or a written service record
    && row.track_state !== 'complete');
  if (!candidates.length) return null;
  const recorded = await conn('service_records').whereIn('scheduled_service_id', candidates.map((r) => r.id)).select('scheduled_service_id');
  const done = new Set((recorded || []).map((r) => String(r.scheduled_service_id)));
  for (const row of candidates) {
    if (done.has(String(row.id))) continue;
    const endMin = customerWindowEndMinutes(row);
    if (endMin == null || endMin >= nowMin) continue;
    return { visitId: String(row.id), windowStart: row.window_start || null, type: row.service_type || null, windowDisplay: windowLabel(row, deriveWindow), minutesPast: nowMin - endMin };
  }
  return null;
}

// ── missed visit ────────────────────────────────────────────────────────────
const MISSED_SCAN_MAX = 10;
// The logged original START ("09:00:00-10:30:00" → "09:00:00"); writers store the
// internal job block as the end, so only the start is the promised window.
function missedWindowStart(originalWindow) {
  const start = /^\s*(\d{1,2}:\d{2})/.exec(String(originalWindow || ''));
  if (!start) return null;
  return start[1].length === 4 ? `0${start[1]}:00` : `${start[1]}:00`;
}
function missedWindowLabel(originalWindow, deriveWindow) {
  const startHms = missedWindowStart(originalWindow);
  return startHms ? windowLabel({ window_start: startHms }, deriveWindow) : null;
}
// A pending/confirmed visit from the lookback that nobody performed.
async function loadUnfinishedVisit({ conn, customerId, now, deriveWindow }, { today, since }) {
  const unfinishedRows = await conn('scheduled_services')
    .where({ customer_id: customerId })
    .where('scheduled_date', '<', today).where('scheduled_date', '>=', since)
    .whereIn('status', NOT_STARTED_STATUSES)
    // Performed but never closed out is not a miss: the tracker can reach
    // 'complete' ahead of a lagging status, and a written service record
    // means the work was done (an invoice alone proves nothing — they can be
    // minted before the visit).
    .where((b) => b.whereNull('track_state').orWhereNot('track_state', 'complete'))
    .whereNotExists(function serviceRecorded() {
      this.select(1).from('service_records as sr').whereRaw('sr.scheduled_service_id = scheduled_services.id');
    })
    .orderBy('scheduled_date', 'desc')
    .limit(MISSED_SCAN_MAX)
    .select('id', 'service_type', 'scheduled_date', 'window_start', 'window_end', 'window_display', 'time_window', 'status');
  // Yesterday's late visit whose window runs past midnight (23:00-01:00) is
  // still open, not missed, until that window ends.
  const yesterday = etDateString(addETDays(now, -1));
  const nowMin = nowEtMinutes(now);
  const stillOpen = (row) => calendarDay(row.scheduled_date) === yesterday && crossesIntoNow(row, nowMin);
  const unfinished = (unfinishedRows || []).find((row) => !stillOpen(row));
  if (!unfinished) return null;
  return {
    type: unfinished.service_type || null, date: calendarDay(unfinished.scheduled_date), windowStart: unfinished.window_start || null,
    windowDisplay: windowLabel(unfinished, deriveWindow), status: unfinished.status, reason: 'not_completed',
  };
}

// The newest customer no-show in the lookback that was not followed up.
async function loadOpenNoshow({ conn, customerId, deriveWindow }, { today, since }) {
  const noshows = await conn('reschedule_log as rl')
    .leftJoin('scheduled_services as ss', 'ss.id', 'rl.scheduled_service_id')
    .where('rl.customer_id', customerId).where('rl.reason_code', 'customer_noshow')
    .where('rl.original_date', '<=', today).where('rl.original_date', '>=', since)
    .orderBy('rl.original_date', 'desc')
    .limit(MISSED_SCAN_MAX)
    .select('rl.scheduled_service_id', 'rl.original_date', 'rl.original_window', 'rl.new_date', 'rl.created_at as logged_at', 'ss.property_id', 'ss.scheduled_date as ss_scheduled_date', 'ss.service_type',
      'ss.window_start', 'ss.window_end', 'ss.window_display', 'ss.time_window', 'ss.status');
  // Newest UNRESOLVED no-show: a rebooked newer one must not hide an older open miss.
  for (const noshow of noshows || []) {
    const date = calendarDay(noshow.original_date);
    const family = familyKey(noshow.service_type);
    const liveOrDone = [...UPCOMING_SERVICE_STATUSES, 'completed'];
    // The logged row itself is the follow-up when it is live or done AND no longer
    // the missed occurrence: the soft path stamps new_date; a no-show logged
    // without one (missed-appointment onSkip) can still be rebooked on the same
    // row later (another day or a later window) or completed.
    const missedStartHms = missedWindowStart(noshow.original_window);
    const rowMoved = calendarDay(noshow.ss_scheduled_date) !== date
      || (missedStartHms != null && hhmmToMinutes(noshow.window_start) !== hhmmToMinutes(missedStartHms));
    const movedSelf = liveOrDone.includes(noshow.status)
      && (noshow.new_date != null || noshow.status === 'completed' || rowMoved);
    // Otherwise another visit of the same service on or after the missed day
    // (a same-day replacement counts), never the logged row itself.
    // No property on the missed row (legacy, or the property was deleted): another
    // visit cannot be shown to be at the same address, so only the row itself can
    // resolve it.
    const later = !movedSelf && date && family && noshow.property_id
      ? await conn('scheduled_services')
        .where({ customer_id: customerId }).where('scheduled_date', '>=', date)
        .whereIn('status', liveOrDone)
        .modify((b) => {
          if (noshow.scheduled_service_id) b.whereNot('id', noshow.scheduled_service_id);
          // the same property: another address's visit does not resolve this miss
          b.where('property_id', noshow.property_id);
          // booked in response: a recurring series pre-creates its future children,
          // so a visit that already existed before the no-show was logged is not one
          if (noshow.logged_at) b.where('created_at', '>', noshow.logged_at);
        })
        .select('service_type', 'scheduled_date', 'window_start')
      : [];
    // A same-day visit counts only when its window starts AFTER the missed slot (an
    // earlier visit that day preceded the no-show); unknown starts do not count.
    const missedStart = hhmmToMinutes(missedStartHms);
    const afterMiss = (r) => calendarDay(r.scheduled_date) !== date
      || (missedStart != null && (hhmmToMinutes(r.window_start) ?? -1) > missedStart);
    const followedUp = movedSelf || (later || []).some((r) => familyKey(r.service_type) === family && afterMiss(r));
    if (!followedUp) {
      return {
        type: noshow.service_type || null, date, windowStart: missedStartHms,
        // The window that was MISSED, as the customer was promised it: the logged
        // original START through the arrival-window formatter (writers store
        // "start-end" with the internal job block as the end), never the joined
        // row's current (possibly moved) window.
        windowDisplay: missedWindowLabel(noshow.original_window, deriveWindow),
        status: noshow.status || 'no_show', reason: 'customer_noshow',
      };
    }
  }
  return null;
}

// The most recent of the two missed-visit sources.
async function loadMissedVisit(ctx) {
  const range = {
    today: etDateString(ctx.now),
    // ET calendar days, not fixed 24h periods (a DST week would reach an 8th day back)
    since: etDateString(addETDays(ctx.now, -MISSED_LOOKBACK_DAYS)),
  };
  const candidates = (await Promise.all([loadUnfinishedVisit(ctx, range), loadOpenNoshow(ctx, range)])).filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return candidates[0];
}

// ── open promises / asks ────────────────────────────────────────────────────
// A short fingerprint of the commitment fields a draft can restate (kind, wording):
// a staff edit that keeps the row open changes it.
function commitmentRevision(r) {
  const basis = [r && r.kind, r && r.description].map((v) => (v == null ? '' : String(v))).join('|');
  return require('crypto').createHash('sha1').update(basis).digest('hex').slice(0, 12);
}
// Redact before clipping: a credential straddling the cap would lose the words
// the redactor keys on (lazy require — the aggregator requires this module).
const safeDescription = (value) => clip(require('./context-aggregator').redactAccessCodes(String(value == null ? '' : value)), DESCRIPTION_MAX);
// The canonical commitment timing (call-commitments implicitDueAt): a human entry
// added later to an older call dates from its own row, not the call.
const rowSourceAt = (r) => (r.source === 'human' ? toDate(r.created_at) : null)
  || toDate(r.call_started_at) || toDate(r.sms_started_at) || toDate(r.created_at);

async function loadCommitments({ conn, customerId, now }) {
  const rows = [];
  // Call promises: read regardless of GATE_CALL_COMMITMENTS — it gates
  // writing; rows recorded while it was on are still owed after a rollback.
  {
    const { listOpenCommitments } = require('./call-commitments');
    // party 'waves' in the query, so the limit bounds the rows actually rendered
    const calls = await safely('call commitments', [], () => listOpenCommitments(conn, { customerId, party: 'waves', limit: 50, now }));
    for (const r of calls) rows.push({ ...r, __source: 'call' });
  }
  // SMS + email rows share one reader; each channel keeps its own gate.
  await safely('sms/email commitments', null, async () => {
    const { smsCommitmentsEnabled, listSmsCommitments } = require('./sms-operational-actions');
    const smsOn = smsCommitmentsEnabled();
    const emailOn = gateEnvValue('GATE_EMAIL_OPERATIONAL_ACTIONS');
    if (!smsOn && !emailOn) return null;
    // only the enabled channels, and each rendered lane on its own page, so a limit
    // never lets one population crowd the other out
    const channels = [smsOn && 'sms', emailOn && 'email'].filter(Boolean);
    const lanes = await Promise.all(['promise', 'request'].map((lane) => listSmsCommitments(conn, { customerId, limit: 50, now, channels, lane })));
    const listed = lanes.flat();
    const kept = listed.filter((r) => (r.channel === 'email' ? emailOn : smsOn));
    // The reader's select omits sms_context (basis: promise vs request, and the
    // spoken due text); one keyed read supplies it.
    let contexts = new Map();
    if (kept.length) {
      contexts = await safely('sms commitment context', new Map(), async () => {
        const found = await conn('call_commitments').whereIn('id', kept.map((r) => r.id)).select('id', 'sms_context');
        return new Map((found || []).map((f) => [String(f.id), parseJson(f.sms_context) || {}]));
      });
    }
    for (const r of kept) rows.push({ ...r, sms_context: contexts.get(String(r.id)) || null, __source: r.channel === 'email' ? 'email' : 'sms' });
    return null;
  });

  const seen = new Set();
  const unique = rows.filter((r) => {
    const key = String(r.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const byRecent = (a, b) => (rowSourceAt(b)?.getTime() || 0) - (rowSourceAt(a)?.getTime() || 0);

  // customerWaiting: a text/email the customer sent that asks us for something
  // (basis 'request'). A customer-party CALL row is something the customer
  // promised us, so it appears in neither list.
  const isWaiting = (r) => r.__source !== 'call' && r.sms_context?.basis === 'request';
  const isWeOwe = (r) => (r.__source === 'call' ? r.party === 'waves' : r.party === 'waves' && r.sms_context?.basis !== 'request');

  // No deadline is restated: due_at can be an internal default (a 48h reminder for
  // an untimed "I'll call you back"), an earliest-action floor ("after 3 PM") or
  // pass between draft and send, and effective_due_at can be a staff snooze. Each
  // line carries the day it was asked instead, which also anchors any relative
  // timing the description itself holds ("later today").
  const weOwe = unique.filter(isWeOwe).sort(byRecent).slice(0, LIST_MAX).map((r) => {
    const at = rowSourceAt(r);
    return {
      // call_commitments.id + a revision of what is rendered — the send boundary
      // re-checks it is still open and unedited.
      id: r.id == null ? null : String(r.id),
      rev: commitmentRevision(r),
      kind: r.kind || null,
      description: safeDescription(r.description),
      since: at ? etDateString(at) : null,
      source: r.__source,
    };
  });
  const customerWaiting = unique.filter(isWaiting).sort(byRecent).slice(0, LIST_MAX).map((r) => {
    const at = rowSourceAt(r);
    return { id: r.id == null ? null : String(r.id), rev: commitmentRevision(r), kind: r.kind || null, description: safeDescription(r.description), since: at ? etDateString(at) : null };
  });
  return { weOwe, customerWaiting };
}

/**
 * @param {object} args
 * @param {string} args.customerId
 * @param {Array}  args.upcomingServices  context.upcomingServices (mapped rows: isToday, tech, scheduledServiceId)
 * @param {Date}   [args.now]
 * @param {Function} [args.deriveWindow]  row -> customer-facing window label (the aggregator's own deriveWindow)
 * @param {Function} [args.conn]          knex handle (tests)
 */
// strict (the send-time rebuild): a failed read throws instead of becoming an
// empty field, so an outage is a retryable recheck failure, never "the facts changed".
// Commitments are skipped there (they have their own recheck).
async function loadVisitLoops({ customerId, now = new Date(), deriveWindow = null, conn = db, strict = false } = {}) {
  const out = emptyVisitLoops();
  if (!customerId) return out;
  const ctx = { conn, now, deriveWindow, customerId, strict };
  const read = strict ? (_field, _fallback, fn) => fn() : safely;

  const todayRows = await read('today visits', [], () => loadTodayRows(customerId, ctx));
  const pastWindow = await read('past window', null, () => findPastWindow(todayRows, ctx));

  const [techPosition, lateAlert, missedVisit, commitments] = await Promise.all([
    read('tech position', null, () => loadTechPosition(todayRows, ctx)),
    read('late alert', null, () => loadLateAlert(todayRows, ctx)),
    read('missed visit', null, () => loadMissedVisit(ctx)),
    strict ? { weOwe: [], customerWaiting: [] } : safely('commitments', { weOwe: [], customerWaiting: [] }, () => loadCommitments(ctx)),
  ]);

  out.techPosition = techPosition;
  out.lateAlert = lateAlert;
  out.pastWindow = pastWindow;
  out.missedVisit = missedVisit;
  out.weOwe = commitments.weOwe;
  out.customerWaiting = commitments.customerWaiting;
  return out;
}

// The time-sensitive VISIT STATUS facts a reply can restate, as one comparable
// string (null when none): a fresh tech position (its visit, window, tech, status,
// at-this-visit, stop count), a delay or tracking gap (its visit, window and kind),
// a passed window (its visit and window), a missed visit (type, day, reason) — each
// with the service name the line renders, so a staff correction shows up too. Raw
// window_start, never the display label (the rebuild has no deriveWindow). The send boundary rebuilds the facts
// for the customer and refuses when this changed — a reschedule, a completion, a
// resolved alert or a moved route all show up here, with no recheck per fact.
function visitStatusSignature(visitLoops) {
  const v = visitLoops && typeof visitLoops === 'object' ? visitLoops : {};
  const key = (...parts) => parts.map((x) => (x == null ? '' : String(x))).join(':');
  const tp = v.techPosition;
  const parts = [
    // a stale position still renders a line about this occurrence: its identity is
    // durable (no location TTL), so a completion / cancel / move invalidates it too
    tp && (tp.status === 'stale'
      ? `stalepos:${key(`${tp.visitId}@${tp.windowStart ?? ''}`, tp.visitType, tp.techId)}`
      : `pos:${key(`${tp.visitId}@${tp.windowStart ?? ''}`, tp.visitType, tp.techId, tp.status, tp.atThisVisit === true, tp.stopsAhead)}`),
    v.lateAlert && `late:${key(`${v.lateAlert.visitId}@${v.lateAlert.windowStart ?? ''}`, v.lateAlert.visitType, v.lateAlert.type, v.lateAlert.missingTracking === true)}`,
    v.pastWindow && `past:${key(`${v.pastWindow.visitId}@${v.pastWindow.windowStart ?? ''}`, v.pastWindow.type)}`,
    v.missedVisit && `missed:${key(v.missedVisit.type, `${v.missedVisit.date}@${v.missedVisit.windowStart ?? ''}`, v.missedVisit.reason)}`,
  ].filter(Boolean);
  return parts.length ? parts.join('|') : null;
}

module.exports = { loadVisitLoops, emptyVisitLoops, familyKey, commitmentRevision, visitStatusSignature };
