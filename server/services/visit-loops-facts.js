/**
 * Visit status and open loops: the READ-ONLY facts the texting AI was missing
 * in the 2026-09-30 blind bake-off (lateness, a passed window, promises we
 * owe, asks the customer is still waiting on). Everything here is already in
 * Postgres; nothing writes, nothing sends. (A missed-visit fact was split out of
 * PR #5499 into its own PR, owner 10-02.)
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
 *  - "today's visits" = the customer's live rows dated today (ET), plus
 *    yesterday's while their window still runs past midnight. Late-alert and
 *    passed-window facts are about those occurrences only.
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
const { gateEnvValue } = require('../config/feature-gates');

const DESCRIPTION_MAX = 120;
const LIST_MAX = 5;
const LATE_ALERT_TYPES = ['tech_late', 'unassigned_overdue'];
// A visit nobody has performed or started: the only statuses a "window passed"
// or a "never completed" reading is true of.
const NOT_STARTED_STATUSES = ['pending', 'confirmed'];
// The tracker can lead a lagging status column (customer-lifecycle-guard): a row
// only reads as not-started (past its window) while its tracker is
// unset or still 'scheduled' (never live, complete, cancelled or skipped).
const NOT_STARTED_TRACK_STATES = ['scheduled'];
const trackNotStarted = (state) => state == null || NOT_STARTED_TRACK_STATES.includes(state);

function emptyVisitLoops() {
  return {
    lateAlert: null,
    pastWindow: null,
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
// A visit dated yesterday whose customer-facing window rolls past midnight and has
// not yet ended at nowMin (ET minutes of today).
function crossesIntoNow(row, nowMin) {
  const end = customerWindowEndMinutes(row);
  return end != null && end > 1440 && nowMin < end - 1440;
}

// The occurrence an alert was raised for, from its own record — or null when it
// records none (reschedules do not resolve alerts, so an unstamped one cannot be
// shown to be about a current slot):
//  - no-show-detector: promised_window.start_at, the IMMUTABLE promise the customer
//    was given — it holds even after an uncommunicated internal move of the row;
//  - tech-late-detector: scheduled_date + window_start, which must still be the
//    row's current schedule (a same-day reschedule leaves the old alert behind).
// Returns { date, startHms }.
const ET_HHMM = { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
// A frozen promised_window is checked against the visit's LATEST delivered promise
// (latest: the latestPromises entry, or undefined when no notice exists): a
// communicated reschedule (a different or unknown start) obsoletes the alert even
// before the detector sweep reconciles it; with no newer notice it stands.
function alertOccurrence(payload, visit, latest) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const promised = toDate(p.promised_window && p.promised_window.start_at);
  if (promised && latest) {
    const current = toDate(latest.start_at);
    if (!current || current.getTime() !== promised.getTime()) return null;
  }
  if (promised) return { date: etDateString(promised), startHms: `${promised.toLocaleTimeString('en-US', ET_HHMM)}:00` };
  if (!p.scheduled_date || !p.window_start) return null;
  if (calendarDay(p.scheduled_date) !== calendarDay(visit.scheduled_date)) return null;
  if (hhmmToMinutes(p.window_start) !== hhmmToMinutes(visit.window_start)) return null;
  return { date: calendarDay(visit.scheduled_date), startHms: String(visit.window_start) };
}

// A delay is only news before arrival: a visit the tracker (or status) shows
// arrived, finished, cancelled or skipped never carries one, even while its other
// column lags.
const PRE_ARRIVAL_STATUSES = ['pending', 'confirmed', 'en_route'];
const PRE_ARRIVAL_TRACK_STATES = ['scheduled', 'en_route'];
const preArrival = (r) => PRE_ARRIVAL_STATUSES.includes(r.status) && (r.track_state == null || PRE_ARRIVAL_TRACK_STATES.includes(r.track_state));
// The customer's open delay alerts, read through their visits — not only today's
// schedule: an uncommunicated move can take the row off today while its promised
// window is still today (the no-show detector's promisedIds path). Each alert must
// be for an occurrence live now: today's, or yesterday's still running past midnight.
async function loadLateAlert({ conn, deriveWindow, customerId, now }) {
  const alerts = await conn('dispatch_alerts as a')
    .join('scheduled_services as ss', 'ss.id', 'a.job_id')
    .where('ss.customer_id', customerId)
    .whereIn('a.type', LATE_ALERT_TYPES).whereNull('a.resolved_at')
    .orderBy('a.created_at', 'desc')
    .select('a.type', 'a.severity', 'a.payload', 'ss.id', 'ss.visit_id', 'ss.technician_id', 'ss.status', 'ss.track_state', 'ss.scheduled_date',
      'ss.window_start', 'ss.window_end', 'ss.window_display', 'ss.time_window', 'ss.service_type');
  const today = etDateString(now);
  const yesterday = etDateString(addETDays(now, -1));
  const nowMin = nowEtMinutes(now);
  const liveNow = (occ) => occ.date === today || (occ.date === yesterday && crossesIntoNow({ window_start: occ.startHms }, nowMin));
  // Every applicable alert, newest first; a confirmed delay outranks a tracking
  // gap (a gap is not a must-answer loop, so it must never hide a real delay).
  // a lagging member of a stop whose sibling has already ARRIVED or finished carries
  // no delay (the passed-window stop rule, arrival-only: en route can still be late)
  const startedStops = await startedStopKeys(conn, customerId, alerts || [], { arrivedOnly: true });
  const latest = await latestPromiseMap(conn, [...new Set((alerts || []).map((r) => r.id))], now);
  const applicable = [];
  for (const row of alerts || []) {
    const key = stopKey(row);
    if (!preArrival(row) || (key && startedStops.has(key))) continue;
    const payload = parseJson(row.payload);
    const occ = alertOccurrence(payload, row, latest.get(String(row.id)));
    if (!occ || !liveNow(occ)) continue;
    applicable.push({ row, payload, occ, gap: payload?.evidence === 'missing_tracking' && Number(payload?.stage) !== 2 });
  }
  const chosen = applicable.find((a) => !a.gap) || applicable[0];
  if (!chosen) return null;
  const { row, occ } = chosen;
  return {
    type: row.type,
    severity: row.severity || null,
    // no-show-detector stage 1 (45 min into an open window, no departure) is a
    // tracking gap, not confirmed lateness; its stage 2 (30 min after the promised
    // window ended, no arrival — departed or not) IS a delay. No minutes either
    // way: payload.delay_minutes is frozen at insert and measured from the
    // internal job block, never the customer's promised window.
    missingTracking: chosen.gap,
    visitId: String(row.id),
    windowStart: occ.startHms,
    scheduledDate: occ.date,
    visitType: row.service_type || null,
    windowDisplay: windowLabel({ ...row, window_start: occ.startHms }, deriveWindow),
  };
}

// One physical stop = the same tech, day, customer and window start (the sibling
// group stops-ahead.js uses): a lagging row is not "passed" when a sibling is
// already underway or done.
// A visit group's own id when it has one; otherwise the (tech, day, window) tuple —
// but only when all three are known: a row that can't be shown to share a stop
// (unassigned, windowless) never collapses into another (null = no sibling).
// The visit group scoped by tech and day (a frozen member keeps its visit_id after a
// same-day reassignment, so visit_id alone would join two physical stops — the
// admin-schedule membership rule); otherwise the (tech, day, window) tuple. Either
// needs a known tech and day; a row that can't be shown to share a stop never
// collapses into another (null = no sibling).
const stopKey = (r) => {
  const day = calendarDay(r.scheduled_date);
  if (!r.technician_id || !day) return null;
  if (r.visit_id) return `v:${r.visit_id}|${r.technician_id}|${day}`;
  return r.window_start ? `t:${r.technician_id}|${day}|${r.window_start}` : null;
};
// The stops (stopKey) on these days where some row is underway or done, by status
// or tracker — used by the passed-window read.
// arrivedOnly (the delay read): only arrival or completion counts — a stop the tech
// is still driving to can be late, and its own en-route row must not hide its delay.
async function startedStopKeys(conn, customerId, rows, { arrivedOnly = false } = {}) {
  const dates = [...new Set(rows.map((r) => calendarDay(r.scheduled_date)).filter(Boolean))];
  if (!dates.length) return new Set();
  const statuses = arrivedOnly ? ['on_site', 'completed'] : ['en_route', 'on_site', 'completed'];
  const trackStates = arrivedOnly ? ['on_property', 'complete'] : ['en_route', 'on_property', 'complete'];
  const advanced = await conn('scheduled_services').where({ customer_id: customerId })
    .whereIn('scheduled_date', dates)
    .where((b) => b.whereIn('status', statuses).orWhereIn('track_state', trackStates))
    .select('visit_id', 'technician_id', 'scheduled_date', 'window_start');
  return new Set((advanced || []).map(stopKey).filter(Boolean));
}
// The occurrence the customer was PROMISED for each candidate: the no-show detector's
// own promise evidence (loadPromiseEvents + latestPromises: the newest window a
// message actually delivered), so an uncommunicated internal move never changes it.
// No promise event: the row's schedule (what booking showed them). { date, startHms }.
// A promise event with start_at null (a newer notice superseded the window without
// recording its replacement) means the promised time is UNKNOWN: null, and the row
// is skipped — never substitute the schedule and apologise for a window we can't name.
async function latestPromiseMap(conn, ids, now) {
  if (!ids.length) return new Map();
  const detector = require('./no-show-detector');
  const events = await detector.loadPromiseEvents(conn, ids, { now });
  return detector.latestPromises(events || [], now);
}
async function promisedOccurrences(conn, rows, now) {
  const latest = await latestPromiseMap(conn, rows.map((r) => r.id), now);
  const out = new Map();
  for (const row of rows) {
    const promise = latest.get(String(row.id));
    const start = toDate(promise?.start_at);
    if (promise && !start) { out.set(String(row.id), null); continue; }
    out.set(String(row.id), start
      ? { date: etDateString(start), startHms: `${start.toLocaleTimeString('en-US', ET_HHMM)}:00` }
      : { date: calendarDay(row.scheduled_date), startHms: row.window_start || null });
  }
  return out;
}

// Every not-started visit whose PROMISED customer-facing window has ended: the
// earliest is rendered, all of them ride in `passedKeys` for the send-time
// signature (a second window passing while a card waits must change it).
// Candidates are the customer's live rows near today — not only today's schedule —
// since an uncommunicated move can take a row off today while its promise is today.
async function findPastWindow({ conn, now, deriveWindow, customerId }) {
  const today = etDateString(now);
  const yesterday = etDateString(addETDays(now, -1));
  const nowMin = nowEtMinutes(now);
  const rows = ((await conn('scheduled_services')
    .where({ customer_id: customerId })
    .where('scheduled_date', '>=', yesterday).where('scheduled_date', '<=', etDateString(addETDays(now, 60)))
    .whereIn('status', NOT_STARTED_STATUSES)
    .select('id', 'visit_id', 'technician_id', 'scheduled_date', 'status', 'track_state', 'window_start', 'window_end',
      'window_display', 'time_window', 'service_type')) || [])
    // not started (tracker unset or 'scheduled'), plus the service-record,
    // street-level-hold and sibling checks below
    .filter((row) => NOT_STARTED_STATUSES.includes(row.status) && trackNotStarted(row.track_state));
  if (!rows.length) return null;
  const promised = await promisedOccurrences(conn, rows, now);
  // the promised occurrence is today (or yesterday's, running past midnight)
  const candidates = rows.filter((row) => {
    const occ = promised.get(String(row.id));
    return !!occ && (occ.date === today || occ.date === yesterday);
  });
  if (!candidates.length) return null;
  const ids = candidates.map((r) => r.id);
  const [recorded, held, startedStops] = await Promise.all([
    conn('service_records').whereIn('scheduled_service_id', ids).select('scheduled_service_id'),
    // an uncleared street-level address hold was never dispatched: no passed window
    conn('scheduled_services as ss').whereIn('ss.id', ids)
      .whereExists(function unclearedAddressHold() { require('./street-level-hold').heldVisitSubquery(this, 'ss'); })
      .select('ss.id'),
    startedStopKeys(conn, customerId, candidates),
  ]);
  const done = new Set([...(recorded || []).map((r) => String(r.scheduled_service_id)), ...(held || []).map((r) => String(r.id))]);
  const passed = [];
  for (const row of candidates) {
    const key = stopKey(row);
    if (done.has(String(row.id)) || (key && startedStops.has(key))) continue;
    const occ = promised.get(String(row.id));
    // minutes since the promised day's midnight; yesterday's occurrence is +1440 behind
    const endMin = customerWindowEndMinutes({ window_start: occ.startHms });
    const nowOnDay = occ.date === today ? nowMin : nowMin + 1440;
    if (endMin == null || endMin >= nowOnDay) continue;
    passed.push({ row, occ, minutesPast: nowOnDay - endMin });
  }
  if (!passed.length) return null;
  passed.sort((x, y) => `${x.occ.date}T${x.occ.startHms}`.localeCompare(`${y.occ.date}T${y.occ.startHms}`));
  const { row, occ, minutesPast } = passed[0];
  return {
    visitId: String(row.id),
    windowStart: occ.startHms,
    scheduledDate: occ.date,
    type: row.service_type || null,
    windowDisplay: windowLabel({ ...row, window_start: occ.startHms }, deriveWindow),
    minutesPast,
    passedKeys: passed.map((p) => `${p.row.id}@${p.occ.date}T${p.occ.startHms}`),
  };
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

// Every open Waves-owned call promise for the customer. The canonical reader pages in
// its own order (overdue / due first, oldest call first), but the facts render the
// newest five — so it is read to the end (bounded) rather than one capped page, and
// a fresh promise behind many older ones is never dropped. Shared with the send check.
const CALL_PAGE = 200;
const CALL_PAGES_MAX = 10;
async function allOpenCallCommitments(conn, { customerId, now = new Date() }) {
  const { listOpenCommitments } = require('./call-commitments');
  const rows = [];
  for (let p = 0; p < CALL_PAGES_MAX; p += 1) {
    const page = (await listOpenCommitments(conn, { customerId, party: 'waves', limit: CALL_PAGE, offset: p * CALL_PAGE, now })) || [];
    rows.push(...page);
    if (page.length < CALL_PAGE) break;
  }
  return rows;
}

// Every open SMS/email commitment in one lane ('promise' | 'request'), paged to the
// end: the reader orders by due / oldest source, the facts render the newest five.
async function allSmsLane(conn, { customerId, now = new Date(), channels = null, lane }) {
  const { listSmsCommitments } = require('./sms-operational-actions');
  const rows = [];
  for (let p = 0; p < CALL_PAGES_MAX; p += 1) {
    const page = (await listSmsCommitments(conn, { customerId, limit: SMS_PAGE, offset: p * SMS_PAGE, now, channels, lane })) || [];
    rows.push(...page);
    if (page.length < SMS_PAGE) break;
  }
  return rows;
}
const SMS_PAGE = 200;

async function loadCommitments({ conn, customerId, now, strict }) {
  // strict (a send-time rebuild): every nested read throws instead of reading as empty
  const read = strict ? (_field, _fallback, fn) => fn() : safely;
  const rows = [];
  // Call promises: read regardless of GATE_CALL_COMMITMENTS — it gates
  // writing; rows recorded while it was on are still owed after a rollback.
  {
    const calls = await read('call commitments', [], () => allOpenCallCommitments(conn, { customerId, now }));
    for (const r of calls) rows.push({ ...r, __source: 'call' });
  }
  // SMS + email rows share one reader; each channel keeps its own gate.
  await read('sms/email commitments', null, async () => {
    const { smsCommitmentsEnabled } = require('./sms-operational-actions');
    const smsOn = smsCommitmentsEnabled();
    const emailOn = gateEnvValue('GATE_EMAIL_OPERATIONAL_ACTIONS');
    if (!smsOn && !emailOn) return null;
    // only the enabled channels, each lane read to the end of its pages, and each
    // row classified by the lane query that returned it (never a second read whose
    // failure could turn a customer's request into a promise of ours)
    const channels = [smsOn && 'sms', emailOn && 'email'].filter(Boolean);
    for (const lane of ['promise', 'request']) {
      const listed = await allSmsLane(conn, { customerId, now, channels, lane });
      for (const r of listed.filter((x) => (x.channel === 'email' ? emailOn : smsOn))) {
        rows.push({ ...r, __lane: lane, __source: r.channel === 'email' ? 'email' : 'sms' });
      }
    }
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
  const isWaiting = (r) => r.__source !== 'call' && r.__lane === 'request';
  const isWeOwe = (r) => (r.__source === 'call' ? r.party === 'waves' : r.__lane === 'promise');

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
// Commitments are skipped there (they have their own recheck) unless
// withCommitments (the gratitude boundary needs the whole picture).
async function loadVisitLoops({ customerId, now = new Date(), deriveWindow = null, conn = db, strict = false, withCommitments = false } = {}) {
  const out = emptyVisitLoops();
  if (!customerId) return out;
  const ctx = { conn, now, deriveWindow, customerId, strict };
  const read = strict ? (_field, _fallback, fn) => fn() : safely;

  const pastWindow = await read('past window', null, () => findPastWindow(ctx));

  const [lateAlert, commitments] = await Promise.all([
    read('late alert', null, () => loadLateAlert(ctx)),
    strict && !withCommitments
      ? { weOwe: [], customerWaiting: [] }
      : read('commitments', { weOwe: [], customerWaiting: [] }, () => loadCommitments(ctx)),
  ]);

  out.lateAlert = lateAlert;
  out.pastWindow = pastWindow;
  out.weOwe = commitments.weOwe;
  out.customerWaiting = commitments.customerWaiting;
  return out;
}

// The time-sensitive VISIT STATUS facts a reply can restate, as one comparable
// string (null when none): a delay or tracking gap (its visit occurrence, service
// and kind) and a passed window (its occurrence and service). The send boundary
// rebuilds the facts for the customer and
// refuses when this changed — a reschedule, a completion or a resolved alert all
// show up here, with no recheck per fact. Raw window_start, never the display
// label (the rebuild has no deriveWindow).
function visitStatusSignature(visitLoops) {
  const v = visitLoops && typeof visitLoops === 'object' ? visitLoops : {};
  const key = (...parts) => parts.map((x) => (x == null ? '' : String(x))).join(':');
  // the occurrence: visit + date + window start (a same-hour move to another day changes it)
  const at = (f) => `${f.visitId}@${f.scheduledDate ?? ''}T${f.windowStart ?? ''}`;
  const parts = [
    v.lateAlert && `late:${key(at(v.lateAlert), v.lateAlert.visitType, v.lateAlert.type, v.lateAlert.missingTracking === true)}`,
    v.pastWindow && `past:${key(at(v.pastWindow), v.pastWindow.type)}:${[].concat(v.pastWindow.passedKeys || []).join(',')}`,
  ].filter(Boolean);
  return parts.length ? parts.join('|') : null;
}

module.exports = { loadVisitLoops, emptyVisitLoops, commitmentRevision, visitStatusSignature, allOpenCallCommitments, allSmsLane };
