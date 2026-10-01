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
const { etDateString, etParts } = require('../utils/datetime-et');
const { arrivalWindowRange } = require('../utils/sms-time-format');
const { calendarDay } = require('./live-eta-destination');
const { JOIN_INELIGIBLE_STATUSES, UPCOMING_SERVICE_STATUSES } = require('./visit-context/statuses');
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

const rowId = (s) => s?.scheduledServiceId ?? s?.id ?? null;
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
  if (/lawn|turf|fertiliz|weed|sod/.test(t)) return 'lawn';
  if (/mosquito/.test(t)) return 'mosquito';
  if (/termite|wdo|wood.destroying/.test(t)) return 'termite';
  if (/rodent|rat\b|mice|mouse/.test(t)) return 'rodent';
  if (/tree|shrub|ornamental/.test(t)) return 'tree_shrub';
  if (/pest|roach|ant\b|ants|spider|perimeter|general|bug/.test(t)) return 'pest';
  return t.trim() || null;
}

// The customer-facing end of the arrival window, in ET minutes since midnight.
function customerWindowEndMinutes(row) {
  const range = arrivalWindowRange(String(row.window_start || ''));
  if (range) return hhmmToMinutes(range.split('-')[1]);
  return hhmmToMinutes(row.window_end);
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

const ET_STAMP = { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const formatEtStamp = (value) => {
  const d = toDate(value);
  return d ? d.toLocaleString('en-US', ET_STAMP) : null;
};

// ── today's visits ──────────────────────────────────────────────────────────
async function loadTodayRows(upcomingServices, conn) {
  const ids = (upcomingServices || []).filter((s) => s && s.isToday).map(rowId).filter(Boolean);
  if (!ids.length) return [];
  const rows = await conn('scheduled_services')
    .whereIn('id', ids)
    .select('id', 'technician_id', 'route_order', 'scheduled_date', 'status', 'track_state', 'window_start',
      'window_end', 'window_display', 'time_window', 'service_type');
  // Keep the aggregator's order (earliest-first upcoming list) and carry the
  // tech name it already resolved.
  const byId = new Map((rows || []).map((r) => [String(r.id), r]));
  return upcomingServices.filter((s) => s && s.isToday && byId.has(String(rowId(s)))).map((s) => ({
    ...byId.get(String(rowId(s))),
    technician_name: s.tech || null,
  }));
}

async function loadTechPosition(todayRows, { conn, now, deriveWindow }) {
  const visit = todayRows.find((r) => r.technician_id);
  if (!visit) return null;
  const status = await conn('tech_status').where({ tech_id: visit.technician_id })
    .first('status', 'current_job_id', 'location_updated_at');
  const updatedAt = toDate(status?.location_updated_at);
  const ageMs = updatedAt ? now.getTime() - updatedAt.getTime() : null;
  // The tracker stores the provider's fix time and accepts it slightly in the
  // future (tech-status.js), so a small negative age is a fresh fix.
  const fresh = ageMs != null && ageMs >= -FUTURE_TIMESTAMP_TOLERANCE_MS && ageMs <= FRESH_LOCATION_MS;

  let stopsAhead = null;
  const routeOrder = visit.route_order == null ? null : Number(visit.route_order);
  if (Number.isFinite(routeOrder)) {
    const result = await conn('scheduled_services')
      .where({ technician_id: visit.technician_id, scheduled_date: etDateString(now) })
      .where('route_order', '<', routeOrder)
      .whereNotIn('status', JOIN_INELIGIBLE_STATUSES)
      .count('* as count').first();
    const n = Number(result?.count);
    stopsAhead = Number.isFinite(n) ? n : null;
  }
  return {
    techName: firstName(visit.technician_name),
    status: fresh ? String(status.status) : 'stale',
    minutesSinceUpdate: ageMs == null ? null : Math.max(0, Math.floor(ageMs / 60000)),
    stopsAhead,
    // current_job_id is set from en_route on, so "at this visit" also needs an
    // on-site status; driving to it is "en route", not "at this visit now".
    atThisVisit: fresh && ON_SITE_STATUSES.includes(String(status?.status))
      && Boolean(status?.current_job_id) && String(status.current_job_id) === String(visit.id),
    // Which of today's visits this is about (a customer can have two today).
    visitType: visit.service_type || null,
    windowDisplay: windowLabel(visit, deriveWindow),
  };
}

async function loadLateAlert(todayRows, { conn, deriveWindow }) {
  const ids = todayRows.map((r) => r.id);
  if (!ids.length) return null;
  const alert = await conn('dispatch_alerts')
    .whereIn('job_id', ids).whereIn('type', LATE_ALERT_TYPES).whereNull('resolved_at')
    .orderBy('created_at', 'desc')
    .first('type', 'severity', 'payload', 'job_id');
  if (!alert) return null;
  // Bound to the visit it was raised on: with two visits today, a delay on the
  // afternoon lawn stop must not read as the morning pest visit running late.
  const visit = todayRows.find((r) => String(r.id) === String(alert.job_id)) || null;
  const where = { visitType: visit?.service_type || null, windowDisplay: visit ? windowLabel(visit, deriveWindow) : null };
  const payload = parseJson(alert.payload);
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

function findPastWindow(todayRows, { now, deriveWindow }) {
  const nowMin = nowEtMinutes(now);
  for (const row of todayRows) {
    if (!NOT_STARTED_STATUSES.includes(row.status) || LIVE_TRACK_STATES.includes(row.track_state)) continue;
    const endMin = customerWindowEndMinutes(row);
    if (endMin == null || endMin >= nowMin) continue;
    return { type: row.service_type || null, windowDisplay: windowLabel(row, deriveWindow), minutesPast: nowMin - endMin };
  }
  return null;
}

// ── missed visit ────────────────────────────────────────────────────────────
async function loadMissedVisit({ conn, customerId, now, deriveWindow }) {
  const today = etDateString(now);
  const since = etDateString(new Date(now.getTime() - MISSED_LOOKBACK_DAYS * 86400000));
  const candidates = [];

  const unfinished = await conn('scheduled_services')
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
    .first('id', 'service_type', 'scheduled_date', 'window_start', 'window_end', 'window_display', 'time_window', 'status');
  if (unfinished) {
    candidates.push({
      type: unfinished.service_type || null, date: calendarDay(unfinished.scheduled_date),
      windowDisplay: windowLabel(unfinished, deriveWindow), status: unfinished.status, reason: 'not_completed',
    });
  }

  const noshow = await conn('reschedule_log as rl')
    .leftJoin('scheduled_services as ss', 'ss.id', 'rl.scheduled_service_id')
    .where('rl.customer_id', customerId).where('rl.reason_code', 'customer_noshow')
    .where('rl.original_date', '<=', today).where('rl.original_date', '>=', since)
    .orderBy('rl.original_date', 'desc')
    .first('rl.scheduled_service_id', 'rl.original_date', 'rl.original_window', 'rl.new_date', 'ss.service_type',
      'ss.window_start', 'ss.window_end', 'ss.window_display', 'ss.time_window', 'ss.status');
  if (noshow) {
    const date = calendarDay(noshow.original_date);
    const family = familyKey(noshow.service_type);
    const liveOrDone = [...UPCOMING_SERVICE_STATUSES, 'completed'];
    // The soft no-show path moves the SAME row (possibly later the same day)
    // and stamps new_date: that row still live or done is the follow-up.
    const movedSelf = noshow.new_date != null && liveOrDone.includes(noshow.status);
    // Otherwise another visit of the same service on or after the missed day
    // (a same-day replacement counts), never the logged row itself.
    const later = !movedSelf && date && family
      ? await conn('scheduled_services')
        .where({ customer_id: customerId }).where('scheduled_date', '>=', date)
        .whereIn('status', liveOrDone)
        .modify((b) => { if (noshow.scheduled_service_id) b.whereNot('id', noshow.scheduled_service_id); })
        .select('service_type')
      : [];
    const followedUp = movedSelf || (later || []).some((r) => familyKey(r.service_type) === family);
    if (!followedUp) {
      candidates.push({
        type: noshow.service_type || null, date,
        // The window that was MISSED: the logged original, not the joined
        // row's current (possibly moved) window.
        windowDisplay: String(noshow.original_window || '').trim() || windowLabel(noshow, deriveWindow) || null,
        status: noshow.status || 'no_show', reason: 'customer_noshow',
      });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return candidates[0];
}

// ── open promises / asks ────────────────────────────────────────────────────
const rowSourceAt = (r) => toDate(r.call_started_at) || toDate(r.sms_started_at) || toDate(r.created_at);

async function loadCommitments({ conn, customerId, now }) {
  const rows = [];
  // Call promises: read regardless of GATE_CALL_COMMITMENTS — it gates
  // writing; rows recorded while it was on are still owed after a rollback.
  {
    const { listOpenCommitments } = require('./call-commitments');
    const calls = await safely('call commitments', [], () => listOpenCommitments(conn, { customerId, limit: 50, now }));
    for (const r of calls) rows.push({ ...r, __source: 'call' });
  }
  // SMS + email rows share one reader; each channel keeps its own gate.
  await safely('sms/email commitments', null, async () => {
    const { smsCommitmentsEnabled, listSmsCommitments } = require('./sms-operational-actions');
    const smsOn = smsCommitmentsEnabled();
    const emailOn = gateEnvValue('GATE_EMAIL_OPERATIONAL_ACTIONS');
    if (!smsOn && !emailOn) return null;
    const listed = await listSmsCommitments(conn, { customerId, limit: 50, now });
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

  const weOwe = unique.filter(isWeOwe).sort(byRecent).slice(0, LIST_MAX).map((r) => {
    const dueAt = toDate(r.effective_due_at || r.due_at);
    const overdue = Boolean(dueAt) && dueAt.getTime() <= now.getTime();
    return {
      // call_commitments.id — the send boundary re-checks it is still open.
      id: r.id == null ? null : String(r.id),
      kind: r.kind || null,
      description: clip(r.description, DESCRIPTION_MAX),
      // A passed deadline is said as overdue, never restated as a future time.
      dueText: overdue
        ? `overdue since ${formatEtStamp(dueAt)}`
        : clip(r.sms_context?.due_text || r.due_text, 80) || formatEtStamp(dueAt),
      source: r.__source,
    };
  });
  const customerWaiting = unique.filter(isWaiting).sort(byRecent).slice(0, LIST_MAX).map((r) => {
    const at = rowSourceAt(r);
    return { id: r.id == null ? null : String(r.id), kind: r.kind || null, description: clip(r.description, DESCRIPTION_MAX), since: at ? etDateString(at) : null };
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
async function loadVisitLoops({ customerId, upcomingServices = [], now = new Date(), deriveWindow = null, conn = db } = {}) {
  const out = emptyVisitLoops();
  if (!customerId) return out;
  const ctx = { conn, now, deriveWindow, customerId };

  const todayRows = await safely('today visits', [], () => loadTodayRows(upcomingServices, conn));
  const pastWindow = await safely('past window', null, () => findPastWindow(todayRows, ctx));

  const [techPosition, lateAlert, missedVisit, commitments] = await Promise.all([
    safely('tech position', null, () => loadTechPosition(todayRows, ctx)),
    safely('late alert', null, () => loadLateAlert(todayRows, ctx)),
    safely('missed visit', null, () => loadMissedVisit(ctx)),
    safely('commitments', { weOwe: [], customerWaiting: [] }, () => loadCommitments(ctx)),
  ]);

  out.techPosition = techPosition;
  out.lateAlert = lateAlert;
  out.pastWindow = pastWindow;
  out.missedVisit = missedVisit;
  out.weOwe = commitments.weOwe;
  out.customerWaiting = commitments.customerWaiting;
  return out;
}

module.exports = { loadVisitLoops, emptyVisitLoops, familyKey };
