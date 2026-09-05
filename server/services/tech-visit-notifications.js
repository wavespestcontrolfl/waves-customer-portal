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
const { stampedLine2Sql } = require('./stamped-address');
const { gateEnvValue } = require('../config/feature-gates');
const { isAssignable } = require('./technician-eligibility');
const { parseETDateTime, TZ } = require('../utils/datetime-et');
const { VOICE_AGENT_BOOKING_SOURCE_ACTION } = require('./call-booking-source-actions');

const GATE = 'GATE_TECH_VISIT_NOTIFICATIONS';

const KINDS = Object.freeze(['assigned', 'unassigned', 'rescheduled', 'cancelled']);
// Lifecycle states with nothing left to announce for an assignment/move card.
const TERMINAL_VISIT_STATUSES = new Set(['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show']);
// How a moved-off card names an ended visit ("Now cancelled" instead of
// "Now with B"): the previous holder still learns the stop left their route
// even when the visit ended before their card landed.
const ENDED_LABELS = Object.freeze({ cancelled: 'cancelled', completed: 'completed', skipped: 'skipped', rescheduled: 'rescheduled', no_show: 'a no-show' });

// True when the caller's committed snapshot no longer matches the row — a
// later change moved the visit on. Only the fields the caller supplied are
// compared (an assignment hook may know the date alone).
function snapshotSuperseded(snapshot, row) {
  if (!snapshot) return false;
  const hhmm = (v) => (v ? String(v).slice(0, 5) : null);
  if (snapshot.date !== undefined && dateOnly(snapshot.date) !== dateOnly(row.scheduled_date)) return true;
  if (snapshot.windowStart !== undefined && hhmm(snapshot.windowStart) !== hhmm(row.window_start)) return true;
  if (snapshot.windowEnd !== undefined && hhmm(snapshot.windowEnd) !== hhmm(row.window_end)) return true;
  return false;
}

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

// What a failed card write may put in the log. A Knex error message carries
// the SQL with its bound values — here the card text: the customer's name
// and street address — so only the driver's code / error name is logged,
// never the message (AGENTS.md: no PII in logs).
function errorTag(err) {
  return String((err && (err.code || err.name)) || 'error');
}

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
  // Text-reply movers first: reschedule-sms passes 'customer_sms', which the
  // generic customer branch below would otherwise claim as "online".
  if (label === 'sms' || label === 'reschedule_sms' || label === 'customer_sms') return 'by the customer by text';
  if (label.startsWith('customer')) return 'by the customer online';
  if (label === 'auto_dispatch') return 'by auto-dispatch';
  if (label.startsWith('rain')) return 'by the rain-out sweep';
  return 'by the office';
}

function customerLabel(visit) {
  return String(visit.cust_last_name || visit.cust_first_name || 'Customer').trim();
}

// Where the truck goes: the visit's stamped service address when the
// booking stamped one (phone bookings always do, and it may be a different
// property than the customer's address on file), else the customer's. The
// unit (line 2) rides along — the card has no details link, so a condo
// booking without it sends the tech to the building, not the door (codex
// r11 P2); `address_line2` is resolved by stampedLine2Sql (a diverging
// stamp never borrows the customer's unit).
function placeLabel(visit) {
  const stamped = visit.service_address_line1
    ? [visit.service_address_line1, visit.address_line2, visit.service_address_city].filter(Boolean)
    : [visit.cust_address, visit.address_line2, visit.cust_city].filter(Boolean);
  return stamped.join(', ') || null;
}

/**
 * Compose the card's headline / message / payload for one kind. Pure.
 * `previous` is { date, windowStart, windowEnd } for rescheduled;
 * `newTechnicianName` names who holds an unassigned visit NOW (read off
 * the locked row, never the hook's own destination).
 */
function composeCard({ kind, visit, actorText, previous, newTechnicianName, ended = null }) {
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
    if (ended) lines.push(`Now ${ended}`);
    else lines.push(newTechnicianName ? `Now with ${newTechnicianName}` : 'Now unassigned');
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
      now_with: kind === 'unassigned' && !ended ? (newTechnicianName || null) : null,
      ended: kind === 'unassigned' ? (ended || null) : null,
      actor: actorText,
    },
  };
}

// The visit + its customer. Inside the card transaction the visit row is
// locked FOR SHARE (of s only — the customer row stays free) so the
// contradiction check below and the feed insert see ONE committed state:
// a writer's UPDATE on the same row waits for the card to land, and a
// writer that already holds the row makes this read wait for its commit.
async function loadVisit(visitId, conn, { lock = false } = {}) {
  let q = conn('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.id', visitId);
  if (lock) q = q.forShare('s');
  return q.first(
    's.id', 's.service_type', 's.scheduled_date', 's.window_start', 's.window_end', 's.technician_id', 's.status',
    's.source_action', 's.service_address_line1', 's.service_address_city',
    'c.first_name as cust_first_name', 'c.last_name as cust_last_name',
    'c.address_line1 as cust_address', 'c.city as cust_city',
    conn.raw(`${stampedLine2Sql('s', 'c')} as address_line2`),
  );
}

// Does the committed row still agree with the card? The per-visit queue
// orders notices within ONE process; during a deploy two app instances
// overlap (cron-lock.js), so an A→B card prepared on the old instance can
// run after B→C committed through the new one. A card the row already
// contradicts is dropped — the writer of the later change tells the tech
// the current state, and the newest feed row is never stale. Returns the
// row's holder (technicians.id or null) when the card stands, else false.
function cardStands({ kind, technicianId, snapshot, previousStatus }, row) {
  // A voice-agent booking is silent until the office confirms it
  // (relay-booking.js: a pending office-review row is not yet real): a
  // reassignment, move, or cancel while it is still pending says nothing
  // to anyone — the confirm hook announces it to whoever holds it then. A
  // cancel reads `cancelled` by now, so the writer passes the status it
  // transitioned FROM.
  if (row.source_action === VOICE_AGENT_BOOKING_SOURCE_ACTION
    && (String(row.status) === 'pending' || String(previousStatus) === 'pending')) return false;
  const holder = row.technician_id ? String(row.technician_id) : null;
  const recipient = String(technicianId);
  if (kind === 'assigned' || kind === 'rescheduled') {
    if (holder !== recipient) return false;
    // A visit that has since ended (cancelled, completed, …) has no
    // "new visit" / "moved" card left to deliver.
    if (TERMINAL_VISIT_STATUSES.has(String(row.status))) return false;
    // The schedule this hook committed must still be the row's schedule:
    // two same-tech moves prepared out of order (deploy overlap, a
    // deferred hold notice) would otherwise leave the OLDER "Now …" as
    // the newest card. The later move's own card is the one that lands.
    if (snapshotSuperseded(snapshot, row)) return false;
  }
  if (kind === 'unassigned' && holder === recipient) return false;
  if (kind === 'cancelled' && String(row.status) !== 'cancelled') return false;
  // A moved-off card after the visit ended (codex r10 P2 + pre-push audit):
  // a delayed A→B card across a deploy overlap must not say "Now with B"
  // about a visit B has since completed or cancelled — but A still has to
  // hear the stop left their route (the cancel card went to B alone), so
  // the card names the terminal state instead of being dropped.
  const ended = kind === 'unassigned' && TERMINAL_VISIT_STATUSES.has(String(row.status))
    ? (ENDED_LABELS[String(row.status)] || String(row.status).replace(/_/g, ' '))
    : null;
  return { holder, ended };
}

/**
 * Resolve the parts of one notice that do not depend on the visit row:
 * the silent rules, the recipient, who acted. Returns { ok: false, skipped }
 * or { ok: true, ...notice }; the row itself is read — and checked — under
 * lock when the card is written (writeCard). Never throws.
 */
async function prepareNotice({
  visitId, kind, technicianId, actorId = null, previous = null, snapshot = null, previousStatus = null, conn = db,
} = {}) {
  try {
    if (!enabled()) return { ok: false, skipped: 'gate_off' };
    if (!KINDS.includes(kind)) return { ok: false, skipped: 'unknown_kind' };
    if (!visitId || !technicianId) return { ok: false, skipped: 'no_recipient' };
    if (actorId && String(actorId) === String(technicianId)) return { ok: false, skipped: 'self' };

    const tech = await conn('technicians').where({ id: technicianId })
      .first('id', 'name', 'employment_status', 'field_dispatchable');
    if (!isAssignable(tech)) return { ok: false, skipped: 'not_assignable' };

    const actorText = await describeActor(actorId, conn);
    return {
      ok: true,
      visitId,
      kind,
      technicianId,
      actorText,
      previous,
      snapshot,
      previousStatus,
      type: TYPE_BY_KIND[kind],
      pushTitle: PUSH_TITLE_BY_KIND[kind],
    };
  } catch (err) {
    logger.error(`[tech-visit-notifications] ${kind} notice failed for visit ${visitId}: ${err.message}`);
    return { ok: false, skipped: 'error' };
  }
}

// The feed row (same columns the geofence prompts insert). The visit row
// is read under FOR SHARE and checked against the card in the SAME
// transaction as the insert, so no other transition can commit between
// the check and the card (deploy overlap, two instances): a stale card is
// dropped (returns false), never written as the newest row. The card
// describes the schedule the hook COMMITTED (the caller's snapshot), not
// whatever the row holds by delivery time; the row supplies the rest
// (customer, service, address) and — for a moved-off card — who holds the
// visit NOW, so rapid A→B→C never tells A "Now with B".
async function writeCard(notice) {
  return db.transaction(async (trx) => {
    const row = await loadVisit(notice.visitId, trx, { lock: true });
    if (!row) return false;
    const stands = cardStands(notice, row);
    if (!stands) return false;
    const visit = {
      ...row,
      ...(notice.snapshot?.date !== undefined ? { scheduled_date: notice.snapshot.date } : {}),
      ...(notice.snapshot?.windowStart !== undefined ? { window_start: notice.snapshot.windowStart } : {}),
      ...(notice.snapshot?.windowEnd !== undefined ? { window_end: notice.snapshot.windowEnd } : {}),
    };
    let newTechnicianName = null;
    if (notice.kind === 'unassigned' && stands.holder && !stands.ended) {
      const next = await trx('technicians').where({ id: stands.holder }).first('name');
      newTechnicianName = next?.name || null;
    }
    const card = composeCard({ kind: notice.kind, visit, actorText: notice.actorText, previous: notice.previous, newTechnicianName, ended: stands.ended || null });
    await trx('tech_notifications').insert({
      technician_id: notice.technicianId,
      type: notice.type,
      message: card.message,
      payload: JSON.stringify(card.payload),
    });
    return true;
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
  const written = [];
  let dropped = 0;
  for (const n of notices.filter((x) => x && x.ok)) {
    try {
      if (await writeCard(n)) written.push(n);
      else dropped += 1;
    } catch (err) {
      logger.error(`[tech-visit-notifications] ${n.kind} card not written for visit ${n.visitId} (${errorTag(err)})`);
    }
  }
  for (const n of written) await pushCard(n);
  return { written: written.length, dropped };
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
 * @param {string|null} [args.previousStatus]  cancelled only: the status the
 *                                       writer transitioned from
 */
async function runNotice(args = {}) {
  const notice = await prepareNotice(args);
  if (!notice.ok) return { sent: false, skipped: notice.skipped };
  const { written, dropped } = await deliver([notice]);
  if (written) return { sent: true };
  return { sent: false, skipped: dropped ? 'stale' : 'error' };
}

// Public single-notice entry (creation hooks call it directly): it rides
// the visit's queue like every batch, so a "new visit" card can never be
// overtaken by a reassignment that follows the creation seconds later.
// Skips are decided without queueing (nothing to order).
async function notifyTechVisitChange(args = {}) {
  if (!enabled()) return { sent: false, skipped: 'gate_off' };
  if (!args.visitId) return { sent: false, skipped: 'no_recipient' };
  // args.trx: a creator writing inside a caller-owned transaction hands it
  // over so the card waits for the OUTERMOST commit (same rule as the
  // assignment / move / cancel hooks); without one it queues now.
  const { trx = null, ...notice } = args;
  return afterCommit(trx, () => runNotice(notice), notice.visitId);
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
    logger.warn(`[tech-visit-notifications] queued notice failed for visit ${key} (${errorTag(err)})`);
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
function notifyAssignmentChange({ visitId, fromTechId = null, toTechId = null, actorId = null, snapshot = null, trx = null } = {}) {
  const from = fromTechId || null;
  const to = toTechId || null;
  if (!visitId || from === to) return null;
  if (!enabled()) return null;
  return afterCommit(trx, async () => {
    const notices = [];
    if (from) notices.push(await prepareNotice({ visitId, kind: 'unassigned', technicianId: from, actorId, snapshot }));
    if (to) notices.push(await prepareNotice({ visitId, kind: 'assigned', technicianId: to, actorId, snapshot }));
    await deliver(notices);
  }, visitId);
}

/** Same visit, same tech, new date or window. Post-commit, best-effort. */
function notifyVisitRescheduled({ visitId, technicianId, actorId = null, previous = null, snapshot = null, trx = null } = {}) {
  if (!visitId || !technicianId) return null;
  if (!enabled()) return null;
  return afterCommit(trx, () => runNotice({ visitId, kind: 'rescheduled', technicianId, actorId, previous, snapshot }), visitId);
}

/**
 * The visit is gone. Post-commit, best-effort. `technicianId` may be
 * omitted by a caller that only holds the visit id (the cancellation
 * processor, after its live-state compensation check) — the assigned tech
 * is read from the row.
 */
function notifyVisitCancelled({ visitId, technicianId = null, actorId = null, snapshot = null, previousStatus = null, trx = null } = {}) {
  if (!visitId) return null;
  if (!enabled()) return null;
  return afterCommit(trx, async () => {
    let recipient = technicianId;
    if (!recipient) {
      const row = await db('scheduled_services').where({ id: visitId }).first('technician_id');
      recipient = row?.technician_id || null;
    }
    if (!recipient) return;
    await runNotice({ visitId, kind: 'cancelled', technicianId: recipient, actorId, snapshot, previousStatus });
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
