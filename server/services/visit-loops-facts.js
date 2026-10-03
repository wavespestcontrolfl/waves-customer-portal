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
// An alert raised on a grouped member that was since cancelled/skipped speaks for
// the stop's next LIVE member (the detector's representativeOf hand-off, which its
// sweep makes later): read it through that member, same physical stop, lowest id.
const VISIT_COLUMNS = ['id', 'visit_id', 'technician_id', 'status', 'track_state', 'scheduled_date',
  'window_start', 'window_end', 'window_display', 'time_window', 'service_type'];
async function liveRepresentatives(conn, alerts) {
  const { LIVE_STATUSES } = require('./no-show-detector');
  const gone = (r) => !LIVE_STATUSES.includes(r.status) && !ATTENDED_STATUSES.includes(r.status);
  const visitIds = [...new Set(alerts.filter((r) => gone(r) && r.visit_id).map((r) => String(r.visit_id)))];
  if (!visitIds.length) return alerts;
  // never an uncleared street-level hold (never dispatched — the alert query's rule)
  const members = ((await conn('scheduled_services as ss').whereIn('ss.visit_id', visitIds)
    .whereIn('ss.status', PRE_ARRIVAL_STATUSES)
    .whereNotExists(function unclearedAddressHold() { require('./street-level-hold').heldVisitSubquery(this, 'ss'); })
    .select(...VISIT_COLUMNS.map((c) => `ss.${c}`))) || [])
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return alerts.map((alert) => {
    if (!gone(alert) || !alert.visit_id) return alert;
    const next = members.find((m) => String(m.visit_id) === String(alert.visit_id) && m.id !== alert.id && stopKey(m) && stopKey(m) === stopKey(alert));
    return next ? { ...alert, ...next } : alert;
  });
}
// The customer's open delay alerts, read through their visits — not only today's
// schedule: an uncommunicated move can take the row off today while its promised
// window is still today (the no-show detector's promisedIds path). Each alert must
// be for an occurrence live now: today's, or yesterday's still running past midnight.
async function loadLateAlert({ conn, deriveWindow, customerId, now }) {
  const alerts = await conn('dispatch_alerts as a')
    .join('scheduled_services as ss', 'ss.id', 'a.job_id')
    .where('ss.customer_id', customerId)
    .whereIn('a.type', LATE_ALERT_TYPES).whereNull('a.resolved_at')
    // an uncleared street-level address hold was never dispatched (the tech-late
    // detector resolves its alert on its next sweep): no delay in the meantime
    .whereNotExists(function unclearedAddressHold() { require('./street-level-hold').heldVisitSubquery(this, 'ss'); })
    // a service record is definitive completion, stop key or not (an unassigned legacy row has none)
    .whereNotExists(function recorded() { this.select(1).from('service_records as sr').whereRaw('sr.scheduled_service_id = ss.id'); })
    .orderBy('a.created_at', 'desc')
    .select('a.type', 'a.severity', 'a.payload', 'ss.id', 'ss.visit_id', 'ss.technician_id', 'ss.status', 'ss.track_state', 'ss.scheduled_date',
      'ss.window_start', 'ss.window_end', 'ss.window_display', 'ss.time_window', 'ss.service_type');
  const today = etDateString(now);
  const yesterday = etDateString(addETDays(now, -1));
  // yesterday's overnight window stays live while its alert is unresolved: a stage-2
  // alert is raised AFTER the window ends, so "window still open" would drop it
  const overnight = (occ) => (customerWindowEndMinutes({ window_start: occ.startHms }) || 0) >= 1440; // a 10 PM–12 AM window counts
  const liveNow = (occ) => occ.date === today || (occ.date === yesterday && overnight(occ));
  // Every applicable alert, newest first; a confirmed delay outranks a tracking
  // gap (a gap is not a must-answer loop, so it must never hide a real delay).
  // a lagging member of a stop whose sibling has already ARRIVED or finished carries
  // no delay (the passed-window stop rule, arrival-only: en route can still be late)
  const resolved = await liveRepresentatives(conn, alerts || []);
  const startedStops = await startedStopKeys(conn, customerId, resolved, { arrivedOnly: true });
  const latest = await stopPromiseMap(conn, resolved, now);
  const applicable = [];
  for (const row of resolved) {
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
// admin-schedule membership rule, null-safe: two unassigned members of one visit
// share it); otherwise the (tech, day, window) tuple, which needs a known tech. A
// row that can't be shown to share a stop never collapses into another (null).
const stopKey = (r) => {
  const day = calendarDay(r.scheduled_date);
  if (!day) return null;
  if (r.visit_id) return `v:${r.visit_id}|${r.technician_id || 'unassigned'}|${day}`;
  return r.technician_id && r.window_start ? `t:${r.technician_id}|${day}|${r.window_start}` : null;
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
    // a service record is definitive completion, whatever the lagging status says
    .where((b) => b.whereIn('status', statuses).orWhereIn('track_state', trackStates)
      .orWhereExists(function recorded() { this.select(1).from('service_records as sr').whereRaw('sr.scheduled_service_id = scheduled_services.id'); }))
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
// Each row's STOP promise, the detector's own resolution: a grouped reminder's
// evidence sits on whichever member won the claim, so siblings are loaded and
// stopPromise picks the window across the members. A row's members are its
// PHYSICAL stop — same visit_id, tech and day (stopKey): a member reassigned to
// another tech or day keeps its visit_id but is a separate stop, and its own notices
// never speak for this one — plus any sibling the customer no longer expects
// (cancelled, skipped, …): stopPromise takes only its GROUPED evidence, which spoke
// for every member when it was sent (the claim owner of a grouped reminder can be
// cancelled while a silently moved sibling still holds that window).
// Map id → promise (absent: none).
const ATTENDED_STATUSES = ['completed'];
const promiseStopKey = (r) => (r.visit_id && stopKey(r)) || `row:${r.id}`;
async function stopPromiseMap(conn, rows, now) {
  const pick = (r) => ({ id: r.id, visit_id: r.visit_id, status: r.status, technician_id: r.technician_id, scheduled_date: r.scheduled_date });
  const own = [...new Map(rows.map((r) => [String(r.id), pick(r)])).values()];
  if (!own.length) return new Map();
  const detector = require('./no-show-detector');
  const known = new Set(own.map((r) => String(r.id)));
  const visitIds = [...new Set(own.map((r) => r.visit_id).filter(Boolean).map(String))];
  const siblings = visitIds.length
    ? ((await conn('scheduled_services').whereIn('visit_id', visitIds)
      .select('id', 'visit_id', 'status', 'technician_id', 'scheduled_date')) || [])
      .filter((r) => !known.has(String(r.id)) && visitIds.includes(String(r.visit_id))).map(pick)
    : [];
  const awaited = (m) => detector.LIVE_STATUSES.includes(m.status) || ATTENDED_STATUSES.includes(m.status);
  const membersOf = (row) => [...own, ...siblings].filter((m) => String(m.id) === String(row.id)
    || (row.visit_id && String(m.visit_id) === String(row.visit_id)
      && (promiseStopKey(m) === promiseStopKey(row) || !awaited(m))));
  const all = [...own, ...siblings];
  const events = detector.byVisit((await detector.loadPromiseEvents(conn, all.map((r) => String(r.id)), { now })) || []);
  const out = new Map();
  for (const row of own) {
    const promise = detector.stopPromise(membersOf(row), events, now);
    if (promise) out.set(String(row.id), promise);
  }
  return out;
}
async function promisedOccurrences(conn, rows, now) {
  const latest = await stopPromiseMap(conn, rows, now);
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
  const COLUMNS = ['id', 'visit_id', 'technician_id', 'scheduled_date', 'status', 'track_state', 'window_start', 'window_end',
    'window_display', 'time_window', 'service_type'];
  // every live row of THIS customer from 60 days back on, with no upper bound: an
  // uncommunicated move (forward or back) keeps the row in scan, and its promise
  // (stopPromiseMap) decides the occurrence — the detector's promisedVisitIds recall,
  // scoped to one customer instead of a fleet-wide read per inbound text
  const scanned = await conn('scheduled_services')
    .where({ customer_id: customerId })
    .where('scheduled_date', '>=', etDateString(addETDays(now, -60)))
    .whereIn('status', NOT_STARTED_STATUSES)
    .select(...COLUMNS);
  const rows = (scanned || [])
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
    // yesterday's occurrence counts only when its window ran past midnight into today
    if (occ.date !== today && endMin < 1440) continue;
    passed.push({ row, occ, minutesPast: nowOnDay - endMin });
  }
  if (!passed.length) return null;
  // a visit-id tie-break: the same state must sign the same at draft and at send
  passed.sort((x, y) => `${x.occ.date}T${x.occ.startHms}`.localeCompare(`${y.occ.date}T${y.occ.startHms}`)
    || String(x.row.id).localeCompare(String(y.row.id)));
  const { row, occ, minutesPast } = passed[0];
  return {
    visitId: String(row.id),
    windowStart: occ.startHms,
    scheduledDate: occ.date,
    type: row.service_type || null,
    windowDisplay: windowLabel({ ...row, window_start: occ.startHms }, deriveWindow),
    minutesPast,
    // unassigned: there is no tech to check with — the reply says the office is checking
    assigned: !!row.technician_id,
    passedKeys: passed.map((p) => `${p.row.id}@${p.occ.date}T${p.occ.startHms}`),
  };
}

// ── missed visit ────────────────────────────────────────────────────────────
// A logged customer no-show (reschedule_log reason customer_noshow — the nightly
// missed-appointment sweep, a dispatch "no show", a soft rebook) in the last week
// that nobody followed up. Only LOGGED misses count: the sweep is the canonical
// judgment, so a merely lagging status is never called a miss here.
// What was missed and where come from the occurrence scope frozen at log time
// (occurrence_service_type / occurrence_service_id / occurrence_property_id): the live row can be corrected
// or reused since. A row logged before those columns existed has no frozen scope —
// unknown, so it is skipped, never read from the current row.
const MISSED_LOOKBACK_DAYS = 7;
// The fixed last line of the gate-on VISIT STATUS & OPEN LOOPS section once the
// missed-visit read exists: tells the model what MISSED VISIT covers, and marks
// the section's contract — a sealed-eval item frozen before this read (which could
// have hidden an open miss) lacks it, so it never grades the '_cflvm' prompt.
const MISSED_VISIT_SCOPE_LINE = `(MISSED VISIT lists a logged no-show from the last ${MISSED_LOOKBACK_DAYS} days whose visit has not been rebooked.)`;
const MISSED_PAGE = 10;
const MISSED_PAGES_MAX = 20;
const LIVE_OR_DONE = ['pending', 'confirmed', 'en_route', 'on_site', 'completed'];
// the track_state enum's in-progress values (scheduled | en_route | on_property | complete | cancelled)
const LIVE_TRACK_STATES = ['en_route', 'on_property'];
// One service identity, compared the way the catalog-aware invariants compare
// visits (completion-record-invariants, lead-to-cash-invariants): the catalog
// row by service_id, else the ONE catalog row whose name matches the label
// (trimmed, case-insensitive), else the label itself. No keyword taxonomy: a
// different catalog service (another flea package, palm injection vs tree &
// shrub) is a different service, and a renamed label of the same catalog row
// is the same one.
const normName = (s) => String(s || '').trim().toLowerCase();
async function catalogIdsByName(conn, labels) {
  const wanted = [...new Set(labels.map(normName).filter(Boolean))];
  const byName = new Map();
  if (!wanted.length) return byName;
  const rows = (await conn('services').whereRaw('lower(trim(name)) = ANY(?)', [wanted]).select('id', 'name')) || [];
  for (const r of rows) {
    const k = normName(r.name);
    // a name several catalog rows share identifies none of them
    byName.set(k, byName.has(k) && byName.get(k) !== String(r.id) ? null : String(r.id));
  }
  return byName;
}
function serviceIdentityKey(serviceId, label, byName) {
  if (serviceId) return `id:${serviceId}`;
  const id = byName.get(normName(label));
  if (id) return `id:${id}`;
  return normName(label) ? `name:${normName(label)}` : null;
}
// The logged original START ("09:00:00-10:30:00" → "09:00:00"); writers store the
// internal job block as the end, so only the start is the promised window.
function missedWindowStart(originalWindow) {
  const start = /^\s*(\d{1,2}:\d{2})/.exec(String(originalWindow || ''));
  if (!start) return null;
  return start[1].length === 4 ? `0${start[1]}:00` : `${start[1]}:00`;
}
// Was this logged miss followed up? (owner 10-02, #5610: the office rebooks a miss.)
// 1. The logged row itself, while it still holds the frozen scope (same property,
//    same catalog service — a row staff repurposed is no evidence): rebooked in
//    place (new_date), moved off the missed slot, under way, completed, or performed
//    (tracker complete or a service record). A move the office has not reviewed yet
//    (a call-booked or voice-agent row, call-booking-source-actions) is not one.
// 2. Only when the logged row is no longer a live visit (any status outside
//    LIVE_OR_DONE — dispatch "no show", skipped, cancelled, the legacy reschedule
//    flow's 'rescheduled', any later parking status — or the row is gone; Codex
//    #5610 r6): a REPLACEMENT the office booked (owner
//    10-02 r4) — same customer, same frozen property and catalog service, created
//    after the miss was logged, on or after the missed day, live or done (status AND
//    tracker: a track_state of 'cancelled' leads a lagging status), NOT a generated
//    child (a series child — recurring_parent_id — or a visit generated from ANOTHER
//    visit — parent_service_id / followup_source_service_id pointing anywhere but the
//    missed row, which is explicit provenance and counts) and NOT an unreviewed
//    call/voice booking. Any other booking never counts (series top-ups look just like one).
async function noshowFollowedUp(conn, customerId, noshow) {
  const { isUnreviewedDispatchOwned } = require('./call-booking-source-actions');
  const date = calendarDay(noshow.original_date);
  const scopeKey = async (rows) => {
    const byName = await catalogIdsByName(conn, [noshow.occurrence_service_type, ...rows.map((r) => r.service_type)]);
    return {
      missed: serviceIdentityKey(noshow.occurrence_service_id, noshow.occurrence_service_type, byName),
      of: (r) => serviceIdentityKey(r.service_id, r.service_type, byName),
    };
  };
  const rowPresent = Boolean(noshow.scheduled_service_id && noshow.ss_status_present);
  // live = a live/done status AND a tracker that is not cancelled (track_state leads a lagging status)
  if (rowPresent && LIVE_OR_DONE.includes(noshow.status) && noshow.track_state !== 'cancelled') {
    if (isUnreviewedDispatchOwned({ source_action: noshow.ss_source_action, customer_confirmed: noshow.ss_customer_confirmed, status: noshow.status })
      && noshow.track_state !== 'complete' && noshow.recorded !== true) return false;
    const missedStart = hhmmToMinutes(missedWindowStart(noshow.original_window));
    // a windowless missed slot that has since been given a time is a move too (Codex #5610 r3)
    const currentStart = hhmmToMinutes(noshow.window_start);
    const rowMoved = calendarDay(noshow.ss_scheduled_date) !== date
      || (missedStart != null ? currentStart !== missedStart : currentStart != null);
    // the visit itself is under way (the tech started it late, unmoved): nothing for the office to rebook
    const underWay = ['en_route', 'on_site'].includes(noshow.status) || LIVE_TRACK_STATES.includes(noshow.track_state);
    const rowEvidence = noshow.track_state === 'complete' || noshow.recorded === true || underWay
      || (LIVE_OR_DONE.includes(noshow.status) && (noshow.new_date != null || noshow.status === 'completed' || rowMoved));
    if (!rowEvidence || (noshow.ss_property_id || null) !== (noshow.occurrence_property_id || null)) return false;
    const key = await scopeKey([{ service_type: noshow.ss_service_type }]);
    return Boolean(key.missed) && key.of({ service_id: noshow.ss_service_id, service_type: noshow.ss_service_type }) === key.missed;
  }
  // terminal (or gone): an office-booked replacement
  if (!date) return false;
  let query = conn('scheduled_services')
    .where({ customer_id: customerId })
    .where('scheduled_date', '>=', date)
    .whereIn('status', LIVE_OR_DONE)
    .where('created_at', '>', noshow.logged_at)
    .whereNull('recurring_parent_id')
    .where((q) => q.whereNull('track_state').orWhereNot('track_state', 'cancelled'));
  query = noshow.occurrence_property_id
    ? query.where({ property_id: noshow.occurrence_property_id })
    : query.whereNull('property_id');
  if (noshow.scheduled_service_id) query = query.whereNot('id', noshow.scheduled_service_id);
  // generated from another visit (Codex #5610 r7); generated from THIS miss is provenance
  const missedRowId = noshow.scheduled_service_id ? String(noshow.scheduled_service_id) : null;
  const generatedElsewhere = (r) => [r.parent_service_id, r.followup_source_service_id]
    .some((id) => id != null && String(id) !== missedRowId);
  const replacements = ((await query.select('service_id', 'service_type', 'status', 'track_state', 'source_action', 'customer_confirmed',
    'parent_service_id', 'followup_source_service_id')) || [])
    .filter((r) => r.track_state !== 'cancelled' && !generatedElsewhere(r) && !isUnreviewedDispatchOwned(r));
  if (!replacements.length) return false;
  const key = await scopeKey(replacements);
  return Boolean(key.missed) && replacements.some((r) => key.of(r) === key.missed);
}
// The newest UNFOLLOWED no-show in the lookback, paged in a stable order so a page
// of followed-up rows never hides an older open one (the page cap is a backstop).
async function loadMissedVisit({ conn, customerId, now, deriveWindow }) {
  const today = etDateString(now);
  // ET calendar days, not fixed 24h periods (a DST week would reach an 8th day back)
  const since = etDateString(addETDays(now, -MISSED_LOOKBACK_DAYS));
  for (let p = 0; p < MISSED_PAGES_MAX; p += 1) {
    const noshows = (await conn('reschedule_log as rl')
      .leftJoin('scheduled_services as ss', 'ss.id', 'rl.scheduled_service_id')
      .where('rl.customer_id', customerId).where('rl.reason_code', 'customer_noshow')
      .where('rl.original_date', '<=', today).where('rl.original_date', '>=', since)
      .whereNotNull('rl.occurrence_service_type')
      .orderBy('rl.original_date', 'desc').orderBy('rl.created_at', 'desc').orderBy('rl.id', 'asc')
      .offset(p * MISSED_PAGE).limit(MISSED_PAGE)
      .select('rl.id', 'rl.scheduled_service_id', 'rl.original_date', 'rl.original_window', 'rl.new_date', 'rl.created_at as logged_at',
        'rl.occurrence_service_type', 'rl.occurrence_service_id', 'rl.occurrence_property_id',
        'ss.scheduled_date as ss_scheduled_date', 'ss.window_start', 'ss.status', 'ss.track_state',
        'ss.service_id as ss_service_id', 'ss.service_type as ss_service_type', 'ss.property_id as ss_property_id',
        'ss.source_action as ss_source_action', 'ss.customer_confirmed as ss_customer_confirmed',
        conn.raw('(ss.id IS NOT NULL) AS ss_status_present'),
        conn.raw('EXISTS (SELECT 1 FROM service_records sr WHERE sr.scheduled_service_id = rl.scheduled_service_id) AS recorded'))) || [];
    for (const noshow of noshows) {
      if (await noshowFollowedUp(conn, customerId, noshow)) continue;
      const startHms = missedWindowStart(noshow.original_window);
      return {
        logId: String(noshow.id),
        // the logged occurrence's row: a WINDOW PASSED / DELAY line for the same row yields to this one
        visitId: noshow.scheduled_service_id ? String(noshow.scheduled_service_id) : null,
        type: noshow.occurrence_service_type,
        date: calendarDay(noshow.original_date),
        windowStart: startHms,
        // the window that was MISSED, as promised: the logged start through the
        // arrival-window formatter, never the row's current (possibly moved) window
        windowDisplay: startHms ? windowLabel({ window_start: startHms }, deriveWindow) : null,
      };
    }
    if (noshows.length < MISSED_PAGE) break;
  }
  return null;
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

  const [lateAlert, missedVisit, commitments] = await Promise.all([
    read('late alert', null, () => loadLateAlert(ctx)),
    read('missed visit', null, () => loadMissedVisit(ctx)),
    strict && !withCommitments
      ? { weOwe: [], customerWaiting: [] }
      : read('commitments', { weOwe: [], customerWaiting: [] }, () => loadCommitments(ctx)),
  ]);

  // The nightly sweep logs a miss but leaves the row unstarted, so the same occurrence
  // can also read as a passed window or a delay that evening: the logged miss is the
  // stronger fact and supersedes them (one instruction per visit — Codex #5610 r4).
  const sameVisit = (f) => Boolean(missedVisit && missedVisit.visitId && f && String(f.visitId) === missedVisit.visitId);
  out.lateAlert = sameVisit(lateAlert) ? null : lateAlert;
  out.pastWindow = sameVisit(pastWindow) ? null : pastWindow;
  out.missedVisit = missedVisit;
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
    // the logged occurrence: a newer miss, or this one followed up, changes it
    v.missedVisit && `missed:${key(v.missedVisit.logId, v.missedVisit.type, `${v.missedVisit.date ?? ''}@${v.missedVisit.windowStart ?? ''}`)}`,
    v.pastWindow && `past:${key(at(v.pastWindow), v.pastWindow.type)}:${[].concat(v.pastWindow.passedKeys || []).join(',')}:${v.pastWindow.assigned === false ? 'unassigned' : 'assigned'}`,
  ].filter(Boolean);
  return parts.length ? parts.join('|') : null;
}

module.exports = { loadVisitLoops, emptyVisitLoops, MISSED_VISIT_SCOPE_LINE, commitmentRevision, visitStatusSignature, allOpenCallCommitments, allSmsLane };
