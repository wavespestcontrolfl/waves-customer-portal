/**
 * Tech visit notifications (Field Team Program, Phase 0 item 2).
 *
 * Tells the ASSIGNED FIELD TECHNICIAN — staff, never a customer — when a
 * visit lands on their route, leaves it, moves, or is cancelled. One entry
 * point, hung on the three writers every schedule change already passes
 * through (assignDispatchJob, the rebooker's single-visit move, and
 * transitionJobStatus → cancelled), plus the edit modal's own date write and
 * the two Intelligence Bar writers that bypass assignDispatchJob.
 *
 * Delivery = one `tech_notifications` row (the tech home feed polls it and
 * keeps the card until the tech clears it) + one best-effort push through
 * PushService. Push copy is a single line (owner ruling 2026-09-05: "You have
 * a new visit on your route"); the details wait in the app.
 *
 * Silent by design:
 *   - GATE_TECH_VISIT_NOTIFICATIONS is not exactly on → nothing (dark; unset
 *     is the kill switch; read at CALL time so a flip needs no redeploy).
 *   - the actor IS the recipient → nothing (Adam assigning himself).
 *   - the recipient is not assignable (prospective / inactive / office-only,
 *     technician-eligibility.js) → nothing.
 *   - a failure here never fails the write it follows: every hook runs after
 *     the caller's outermost commit and swallows its own errors.
 *
 * Not covered here (deliberately): route-order shuffles (whole tech-day
 * rewrites, see route-reorder.js's zero-communication note) and series-scope
 * moves (rescheduleSeries) — both would fan out one card per stop.
 */
const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { isAssignable } = require('./technician-eligibility');
const { parseETDateTime, TZ } = require('../utils/datetime-et');

const GATE = 'GATE_TECH_VISIT_NOTIFICATIONS';

const KINDS = Object.freeze(['assigned', 'unassigned', 'rescheduled', 'cancelled']);

const TYPE_BY_KIND = Object.freeze({
  assigned: 'visit_assigned',
  unassigned: 'visit_unassigned',
  rescheduled: 'visit_rescheduled',
  cancelled: 'visit_cancelled',
});

// Push copy: one line each, no customer details on the lock screen.
const PUSH_TITLE_BY_KIND = Object.freeze({
  assigned: 'You have a new visit on your route',
  unassigned: 'A visit was moved off your route',
  rescheduled: 'A visit on your route moved',
  cancelled: 'A visit on your route was cancelled',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function enabled() {
  return gateEnvValue(GATE);
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function clockLabel(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isInteger(h)) return null;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const minutes = Number.isInteger(m) && m > 0 ? `:${String(m).padStart(2, '0')}` : '';
  return { text: `${hour12}${minutes}`, meridiem: h < 12 ? 'AM' : 'PM' };
}

/** "Thu Sep 10, 9–11 AM" / "Thu Sep 10, 11 AM–1 PM" / "Thu Sep 10". */
function formatWhen(date, windowStart, windowEnd) {
  const day = dateOnly(date);
  if (!day) return null;
  // "Thu, Sep 10" → "Thu Sep 10" (the card reads like a text, not a form).
  const dayLabel = parseETDateTime(`${day}T12:00`)
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ })
    .replace(',', '');
  const start = clockLabel(windowStart);
  const end = clockLabel(windowEnd);
  if (!start) return dayLabel;
  if (!end) return `${dayLabel}, ${start.text} ${start.meridiem}`;
  const window = start.meridiem === end.meridiem
    ? `${start.text}–${end.text} ${end.meridiem}`
    : `${start.text} ${start.meridiem}–${end.text} ${end.meridiem}`;
  return `${dayLabel}, ${window}`;
}

// Who made the change, as the tech should read it. A technicians.id names
// the staff member; system callers pass the rebooker's initiatedBy labels.
async function describeActor(actor, conn) {
  if (!actor) return 'by the office';
  const label = String(actor);
  if (UUID_RE.test(label)) {
    try {
      const row = await conn('technicians').where({ id: label }).first('name');
      const first = row?.name ? String(row.name).trim().split(/\s+/)[0] : null;
      if (first) return `by ${first}`;
    } catch (err) {
      logger.warn(`[tech-visit-notifications] actor lookup failed: ${err.message}`);
    }
    return 'by the office';
  }
  if (label.startsWith('customer')) return 'by the customer online';
  if (label === 'sms' || label === 'reschedule_sms') return 'by the customer by text';
  if (label === 'auto_dispatch') return 'by auto-dispatch';
  if (label.startsWith('rain')) return 'by the rain-out sweep';
  return 'by the office';
}

function customerLabel(visit) {
  return String(visit.cust_last_name || visit.cust_first_name || 'Customer').trim();
}

function placeLabel(visit) {
  return [visit.cust_address, visit.cust_city].filter(Boolean).join(', ') || null;
}

/**
 * Compose the card's headline / message / payload for one kind. Pure.
 * `previous` is { date, windowStart, windowEnd } for rescheduled;
 * `newTechnicianName` names who now holds an unassigned visit.
 */
function composeCard({ kind, visit, actorText, previous, newTechnicianName }) {
  const who = customerLabel(visit);
  const when = formatWhen(visit.scheduled_date, visit.window_start, visit.window_end);
  const where = placeLabel(visit);
  const service = visit.service_type || 'Service';
  const lines = [];
  let headline;
  if (kind === 'assigned') {
    headline = 'New visit on your route';
    lines.push(`${service} · ${when}`);
    if (where) lines.push(where);
    lines.push(`Assigned ${actorText}`);
  } else if (kind === 'unassigned') {
    headline = 'Moved off your route';
    lines.push(`${service} · ${when}`);
    lines.push(newTechnicianName ? `Now with ${newTechnicianName}` : 'Now unassigned');
    lines.push(`Reassigned ${actorText}`);
  } else if (kind === 'rescheduled') {
    headline = 'Visit moved';
    const before = previous ? formatWhen(previous.date, previous.windowStart, previous.windowEnd) : null;
    lines.push(service);
    if (before) lines.push(`Was ${before}`);
    lines.push(`Now ${when}`);
    lines.push(`Moved ${actorText}`);
  } else {
    headline = 'Visit cancelled';
    lines.push(`${service} · ${when}`);
    lines.push(`Cancelled ${actorText}`);
  }
  return {
    message: `${headline}: ${who} — ${lines.join(' · ')}`,
    payload: {
      kind,
      visit_id: visit.id,
      headline,
      customer_name: who,
      service_type: visit.service_type || null,
      when,
      previous_when: kind === 'rescheduled' && previous
        ? formatWhen(previous.date, previous.windowStart, previous.windowEnd)
        : null,
      address: where,
      now_with: kind === 'unassigned' ? (newTechnicianName || null) : null,
      actor: actorText,
    },
  };
}

async function loadVisit(visitId, conn) {
  return conn('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.id', visitId)
    .first(
      's.id', 's.service_type', 's.scheduled_date', 's.window_start', 's.window_end', 's.technician_id',
      'c.first_name as cust_first_name', 'c.last_name as cust_last_name',
      'c.address_line1 as cust_address', 'c.city as cust_city',
    );
}

/**
 * Resolve one notice without writing anything: the silent rules, the
 * recipient, the visit, the composed card. Returns { ok: false, skipped }
 * or { ok: true, ...notice }. Never throws.
 */
async function prepareNotice({
  visitId, kind, technicianId, actorId = null, previous = null, newTechnicianId = null, conn = db,
} = {}) {
  try {
    if (!enabled()) return { ok: false, skipped: 'gate_off' };
    if (!KINDS.includes(kind)) return { ok: false, skipped: 'unknown_kind' };
    if (!visitId || !technicianId) return { ok: false, skipped: 'no_recipient' };
    if (actorId && String(actorId) === String(technicianId)) return { ok: false, skipped: 'self' };

    const tech = await conn('technicians').where({ id: technicianId })
      .first('id', 'name', 'employment_status', 'field_dispatchable');
    if (!isAssignable(tech)) return { ok: false, skipped: 'not_assignable' };

    const visit = await loadVisit(visitId, conn);
    if (!visit) return { ok: false, skipped: 'no_visit' };

    const actorText = await describeActor(actorId, conn);
    let newTechnicianName = null;
    if (kind === 'unassigned' && newTechnicianId) {
      const next = await conn('technicians').where({ id: newTechnicianId }).first('name');
      newTechnicianName = next?.name || null;
    }
    const card = composeCard({ kind, visit, actorText, previous, newTechnicianName });
    return {
      ok: true,
      visitId,
      kind,
      technicianId,
      type: TYPE_BY_KIND[kind],
      message: card.message,
      payload: card.payload,
      pushTitle: PUSH_TITLE_BY_KIND[kind],
    };
  } catch (err) {
    logger.error(`[tech-visit-notifications] ${kind} notice failed for visit ${visitId}: ${err.message}`);
    return { ok: false, skipped: 'error' };
  }
}

// The feed row: same insert helper the geofence prompts use (lazy — the
// handler module is heavy and this module is required from writers).
async function writeCard(notice) {
  const { sendTechNotification } = require('./geofence-handler');
  await sendTechNotification(notice.technicianId, {
    type: notice.type,
    message: notice.message,
    payload: notice.payload,
  });
}

// Best-effort push; the card is already durable when this runs.
async function pushCard(notice) {
  try {
    const PushService = require('./push-notifications');
    await PushService.sendToAdminUser(notice.technicianId, {
      title: notice.pushTitle,
      body: '',
      url: '/tech',
      tag: `visit-${notice.visitId}`,
      priority: 'high',
    });
  } catch (pushErr) {
    logger.warn(`[tech-visit-notifications] push failed for tech ${notice.technicianId} (card already written): ${pushErr.message}`);
  }
}

// Every card in the batch is persisted BEFORE any push is awaited: a push
// can wait seconds per subscription, and two rapid reassignments (A→B,
// B→C) must never let B's stale "new visit" land after its "moved off".
async function deliver(notices) {
  const ready = notices.filter((n) => n && n.ok);
  for (const n of ready) await writeCard(n);
  for (const n of ready) await pushCard(n);
  return ready.length;
}

/**
 * Notify ONE technician about ONE visit. Resolves to { sent: true } or
 * { sent: false, skipped: <reason> }; never throws.
 *
 * @param {object} args
 * @param {string} args.visitId          scheduled_services.id
 * @param {'assigned'|'unassigned'|'rescheduled'|'cancelled'} args.kind
 * @param {string} args.technicianId     the recipient
 * @param {string|null} [args.actorId]   technicians.id of who acted, or a
 *                                       system label ('auto_dispatch', …)
 * @param {object|null} [args.previous]  { date, windowStart, windowEnd } —
 *                                       rescheduled only
 * @param {string|null} [args.newTechnicianId]  unassigned only: who has it now
 */
async function notifyTechVisitChange(args = {}) {
  const notice = await prepareNotice(args);
  if (!notice.ok) return { sent: false, skipped: notice.skipped };
  try {
    await deliver([notice]);
    return { sent: true };
  } catch (err) {
    logger.error(`[tech-visit-notifications] ${args.kind} notice failed for visit ${args.visitId}: ${err.message}`);
    return { sent: false, skipped: 'error' };
  }
}

// Notices for one visit apply in the order their changes committed. Two
// hooks for the same visit (A→B, then B→C seconds later) each read the
// tech, the visit, and the actor before writing; without a queue the later
// change's reads can finish first and B would see "moved off" before its
// stale "new visit". A per-visit promise chain (in-process — the portal
// runs as one server) makes each visit's batch write, then push, before
// the next batch starts. Entries clear themselves when the chain drains.
const visitQueues = new Map();
function enqueueForVisit(visitId, fn) {
  const key = String(visitId);
  const prior = visitQueues.get(key) || Promise.resolve();
  const next = prior.then(fn, fn).catch((err) => {
    logger.warn(`[tech-visit-notifications] queued notice failed for visit ${key}: ${err.message}`);
  });
  visitQueues.set(key, next);
  next.finally(() => { if (visitQueues.get(key) === next) visitQueues.delete(key); });
  return next;
}

// Run `fn` after the caller's OUTERMOST commit (a savepoint's own promise
// resolves at savepoint release — same rule as dispatch-assignment's
// broadcast hook); with no trx, start it now — in either case through the
// visit's queue. Errors never reach the caller, and callers do not await the
// returned promise: push delivery (APNs / FCM / web-push round trips) stays
// off every response path.
function afterCommit(trx, fn, visitId) {
  const { commitPromiseOf } = require('../utils/trx-commit-promise');
  const commitPromise = trx ? commitPromiseOf(trx) : null;
  const run = () => enqueueForVisit(visitId, fn);
  if (commitPromise) {
    // A rolled-back transaction has nothing to announce.
    commitPromise.then(run).catch(() => {});
    return null;
  }
  return run();
}

/**
 * A technician change on one visit: the previous holder hears it left, the
 * new holder hears it arrived. Post-commit, best-effort. No-op when nothing
 * changed.
 */
function notifyAssignmentChange({ visitId, fromTechId = null, toTechId = null, actorId = null, trx = null } = {}) {
  const from = fromTechId || null;
  const to = toTechId || null;
  if (!visitId || from === to) return null;
  if (!enabled()) return null;
  return afterCommit(trx, async () => {
    const notices = [];
    if (from) notices.push(await prepareNotice({ visitId, kind: 'unassigned', technicianId: from, actorId, newTechnicianId: to }));
    if (to) notices.push(await prepareNotice({ visitId, kind: 'assigned', technicianId: to, actorId }));
    await deliver(notices);
  }, visitId);
}

/** Same visit, same tech, new date or window. Post-commit, best-effort. */
function notifyVisitRescheduled({ visitId, technicianId, actorId = null, previous = null, trx = null } = {}) {
  if (!visitId || !technicianId) return null;
  if (!enabled()) return null;
  return afterCommit(trx, () => notifyTechVisitChange({ visitId, kind: 'rescheduled', technicianId, actorId, previous }), visitId);
}

/**
 * The visit is gone. Post-commit, best-effort. `technicianId` may be
 * omitted by a caller that only holds the visit id (the cancellation
 * processor, after its live-state compensation check) — the assigned tech
 * is read from the row.
 */
function notifyVisitCancelled({ visitId, technicianId = null, actorId = null, trx = null } = {}) {
  if (!visitId) return null;
  if (!enabled()) return null;
  return afterCommit(trx, async () => {
    let recipient = technicianId;
    if (!recipient) {
      const row = await db('scheduled_services').where({ id: visitId }).first('technician_id');
      recipient = row?.technician_id || null;
    }
    if (!recipient) return;
    await notifyTechVisitChange({ visitId, kind: 'cancelled', technicianId: recipient, actorId });
  }, visitId);
}

module.exports = {
  GATE,
  KINDS,
  isEnabled: enabled,
  TYPE_BY_KIND,
  PUSH_TITLE_BY_KIND,
  notifyTechVisitChange,
  notifyAssignmentChange,
  notifyVisitRescheduled,
  notifyVisitCancelled,
  _test: { formatWhen, composeCard, describeActor, visitQueues },
};
