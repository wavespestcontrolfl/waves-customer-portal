/**
 * Visit groups — Phase 1 core (docs/design/visit-group-scope.md rev 5).
 *
 * A `service_visits` row is the parent of N scheduled_services sharing one
 * physical stop (same customer, property, date, overlapping window). The
 * visit owns the stop, the technician, and (Phase 2) the closeout, the one
 * customer message, and the visit-scoped payment. Children keep their own
 * records, reports, and invoices.
 *
 * Concurrency: every create/join/split/dissolve runs inside a transaction
 * holding `pg_advisory_xact_lock(hashtext('visit.stop'), hashtext(baseKey))`
 * where baseKey = `<property_id|customer_id>:<date>`. `stop_seq` is
 * allocated as max(seq)+1 over ALL historical rows for the base key, and
 * (stop_base_key, stop_seq) is unique across every lifecycle state, so a
 * closed visit's identity is never re-minted. `visit_id` is the durable
 * identity — reschedules recompute the base key under both stop locks.
 *
 * DARK: gate `GATE_VISIT_GROUPS` (feature-gates `visitGroups`). Nothing
 * calls createOrJoinVisit while the gate is off; guards (isRowVisitBlocked)
 * are inert because no row carries a visit_id yet. Kill switch: unset the
 * gate — no new groups; existing visits keep behaving as created
 * (behavior_version is frozen at creation and never rewritten by gates).
 */

const db = require('../models/db');
const { assertAssignableTechnician } = require('./technician-eligibility');

const OPEN_STATUSES = ['open'];
// Row-status vocabularies live in the canonical visit-context module.
const { TERMINAL_ROW_STATUSES, JOIN_INELIGIBLE_STATUSES } = require('./visit-context/statuses');
const ACTIVE_PACKET_STATUSES = ['accepted', 'processing'];
// service_completion_attempts statuses that mean a legacy /complete owns the
// row: pending (claimed), side effects queued/running, or already succeeded.
// Stamping and the unit mover both refuse members carrying one.
const LIVE_COMPLETION_CLAIM_STATUSES = ['pending', 'side_effects_pending', 'side_effects_running', 'succeeded'];

/**
 * pg returns `date` columns as JS Date instances (UTC midnight); strings
 * arrive as 'YYYY-MM-DD[...]'. Normalize both to the calendar date. A Date
 * is read via its UTC fields — pg parses `date` at UTC midnight, so UTC
 * getters return the stored calendar day regardless of host timezone
 * (datetime-et discipline: never toString a Date for a calendar day).
 */
function dateOnly(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function stopBaseKey({ propertyId, customerId, scheduledDate }) {
  const anchor = propertyId || customerId;
  const date = dateOnly(scheduledDate);
  if (!anchor || !date) throw new Error('stopBaseKey needs propertyId|customerId and scheduledDate');
  return `${anchor}:${date}`;
}

function toMinutes(t) {
  if (t == null) return null;
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Overlap rule (doc §2, rev 5f): a row with no window joins any visit for
 * the stop; two windows overlap when they share any minute. The visit's
 * window widens to the union on join.
 */
function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  const as = toMinutes(aStart);
  const ae = toMinutes(aEnd);
  const bs = toMinutes(bStart);
  const be = toMinutes(bEnd);
  if (as == null || bs == null) return true; // windowless joins
  const aHi = ae == null ? as : ae;
  const bHi = be == null ? bs : be;
  return as <= bHi && bs <= aHi;
}

function familiesCompatible(a, b) {
  if (!a || !b) return false;
  return a === b; // policy table: same family only, until the owner widens it
}

/**
 * Join eligibility for a row against an open visit (doc §2). Pure.
 * `row`/`visit` carry: customer_id, property_id, scheduled_date,
 * window_start, window_end, technician_id, group_family, groupable.
 */
function canJoin(row, visit) {
  if (!row || !visit) return { ok: false, reason: 'missing' };
  if (String(visit.status) !== 'open') return { ok: false, reason: 'visit_not_open' };
  if (String(row.customer_id) !== String(visit.customer_id)) return { ok: false, reason: 'customer' };
  if (String(row.property_id || '') !== String(visit.property_id || '')) return { ok: false, reason: 'property' };
  if (dateOnly(row.scheduled_date) !== dateOnly(visit.scheduled_date)) {
    return { ok: false, reason: 'date' };
  }
  if (JOIN_INELIGIBLE_STATUSES.includes(String(row.status || ''))) {
    return { ok: false, reason: 'row_terminal' };
  }
  // An unconfirmed office-review booking is not yet a real stop (it needs
  // the tech's field-confirm tap or the office's activation first); it
  // groups once confirmed — the shared status writer regroups it on
  // pending → confirmed (codex #3603 r2).
  if (require('./call-booking-source-actions').isPendingOutboundReviewBooking(row)) {
    return { ok: false, reason: 'office_review' };
  }
  if (!row.groupable) return { ok: false, reason: 'not_groupable' };
  if (!familiesCompatible(row.group_family, visit.group_family)) return { ok: false, reason: 'family' };
  if (row.technician_id && visit.technician_id
      && String(row.technician_id) !== String(visit.technician_id)) {
    return { ok: false, reason: 'technician' };
  }
  if (!windowsOverlap(row.window_start, row.window_end, visit.window_start, visit.window_end)) {
    return { ok: false, reason: 'window' };
  }
  return { ok: true };
}

/**
 * Dissolution conditions (doc §2, rev 5): only while the visit is untouched.
 * `activity` is a plain snapshot the caller assembles (or visitActivity()
 * loads): sent/claimed effects, en_route/arrived stamps, packets, child
 * records/invoices, link issued, payment attempted.
 */
function canDissolve(activity) {
  if (!activity) return { ok: false, reason: 'missing' };
  if (String(activity.status) !== 'open') return { ok: false, reason: 'visit_not_open' };
  if (activity.effectsStarted) return { ok: false, reason: 'effects_sent' };
  if (activity.enRouteAt || activity.arrivedAt) return { ok: false, reason: 'route_started' };
  if (activity.activePacket || activity.anyPacket) return { ok: false, reason: 'packet_exists' };
  if (activity.childRecords || activity.childInvoices || activity.childReports) {
    return { ok: false, reason: 'child_artifacts' };
  }
  if (activity.linkIssued) return { ok: false, reason: 'link_issued' };
  if (activity.paymentAttempted) return { ok: false, reason: 'payment_attempted' };
  return { ok: true };
}

/**
 * Membership freeze (doc §2, rev 5d): split/separate allowed only while the
 * visit is open with no child artifacts, no link, no payment, no packet.
 * Sent reminder/tracker effects do NOT block a split.
 */
function canSplit(activity) {
  if (!activity) return { ok: false, reason: 'missing' };
  if (String(activity.status) !== 'open') return { ok: false, reason: 'visit_not_open' };
  // A reminder send is in flight (claimed, inside its lease): the office
  // retries in a moment — see visitActivity.reminderClaimLive.
  if (activity.reminderClaimLive) return { ok: false, reason: 'reminder_in_flight' };
  // ANY packet — active, done, or failed — freezes membership: a failed
  // packet can be retried against its recorded items (doc rev 5d).
  if (activity.activePacket || activity.anyPacket) return { ok: false, reason: 'packet_in_flight' };
  if (activity.childRecords || activity.childInvoices || activity.childReports) {
    return { ok: false, reason: 'child_artifacts' };
  }
  if (activity.linkIssued) return { ok: false, reason: 'link_issued' };
  if (activity.paymentAttempted) return { ok: false, reason: 'payment_attempted' };
  return { ok: true };
}

/**
 * Legacy per-row /complete guard (doc §5 Gates, rev 5c): any row attached to
 * a non-dissolved visit must complete through the visit sheet. Pure.
 */
function isRowVisitBlocked(row, visit) {
  if (!row || !row.visit_id) return false;
  if (!visit) return true; // orphaned pointer: fail CLOSED — never risk a duplicate completion
  return String(visit.status) !== 'dissolved';
}

async function lockStop(trx, baseKey) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['visit.stop', baseKey]);
}

/**
 * Take the stop advisory lock for the stop a scheduled_services row sits
 * on (peek → key → lock). Returns the key, or null when the row is gone.
 * Used by the legacy /complete handler to serialize its completion CLAIM
 * with stamping (codex #3590 r12): stamping checks for live claims and
 * stamps under this lock, so a claim that also commits under it can never
 * slip between stamping's snapshot and its commit.
 */
async function lockStopForRow(trx, serviceId) {
  const peek = await trx('scheduled_services').where({ id: serviceId })
    .first('property_id', 'customer_id', 'scheduled_date');
  if (!peek) return null;
  const baseKey = stopBaseKey({
    propertyId: peek.property_id,
    customerId: peek.customer_id,
    scheduledDate: peek.scheduled_date,
  });
  await lockStop(trx, baseKey);
  // Revalidate under the lock (codex #3590 r13): a reschedule committing
  // between the peek and the lock leaves us holding the OLD stop's lock
  // while stamping serializes on the new one. Same peek → lock → verify →
  // retry contract as createOrJoinVisit; callers retry on VISIT_STOP_MOVED.
  const locked = await trx('scheduled_services').where({ id: serviceId })
    .first('property_id', 'customer_id', 'scheduled_date');
  if (!locked) return null;
  const lockedKey = stopBaseKey({
    propertyId: locked.property_id,
    customerId: locked.customer_id,
    scheduledDate: locked.scheduled_date,
  });
  if (lockedKey !== baseKey) {
    const err = new Error('visit stop moved concurrently — retry');
    err.code = 'VISIT_STOP_MOVED';
    throw err;
  }
  return baseKey;
}

/** Non-terminal members of a visit with the fields join/chain checks need. */
async function openMembers(t, visitId, { forUpdate = false } = {}) {
  const q = t('scheduled_services').where({ visit_id: visitId })
    .whereNotIn('status', TERMINAL_ROW_STATUSES);
  if (forUpdate) q.forUpdate();
  return q.select('id', 'scheduled_date', 'window_start', 'window_end', 'technician_id', 'status');
}

/**
 * Assign a visit's technician onto one member through the canonical
 * assignment writer (codex #3590 r13 P1): assignDispatchJob clears the
 * unassigned-pool route_order, resolves unassigned_overdue alerts, holds
 * the tech-day fence and broadcasts after commit — a bare technician_id
 * write left dispatch state disagreeing with visit ownership. Runs on the
 * caller's transaction; no-op when the row already carries the tech.
 */
// Destination-technician occupancy for one member window (local codex audit
// r24): technicianId never rides the rebooker (its assignment is the
// canonical writer's, after the move), so the rebooker's authoritative
// kept-tech overlap check runs against each row's OLD technician. The
// DESTINATION technician's route is checked here with the rebooker's own
// predicate (active holds, COALESCEd end, cancelled/completed excluded);
// the visit's own members are excluded — they move together. Returns the
// clashing row id or null; unassigning (null tech) never clashes.
async function destinationTechClash(t, { technicianId, date, windowStart, windowEnd, durationMinutes, excludeIds }) {
  if (!technicianId || !date || !windowStart) return null;
  const start = String(windowStart).slice(0, 5);
  const end = windowEnd ? String(windowEnd).slice(0, 5) : shiftClock(start, Number(durationMinutes) || 60);
  const clash = await t('scheduled_services')
    .where('scheduled_date', date)
    .where('technician_id', technicianId)
    .whereNotIn('id', [...new Set((excludeIds || []).map(String))])
    .whereNotIn('status', ['cancelled', 'completed'])
    .where((q) => { q.whereNull('reservation_expires_at').orWhereRaw('reservation_expires_at > NOW()'); })
    .whereRaw(
      "window_start < ?::time AND COALESCE(window_end, window_start + ((COALESCE(NULLIF(estimated_duration_minutes, 0), 60)::text || ' minutes')::interval)) > ?::time",
      [end, start],
    )
    .first('id');
  return clash ? clash.id : null;
}

// Is this visit's membership frozen for a direct slot writer (issued link,
// packet, artifacts, payment attempt — canSplit) or owned by a live
// completion claim on any member? The unit mover refuses such visits
// before its lone-member exit; a direct writer (bulk board move,
// update-details) or a self-serve surface must apply the SAME verdict
// (codex #3609 r26 P1/P2), or a frozen visit that kept one live member
// beside a terminal one would be moved under a parent — and artifacts —
// describing the old stop. Returns { frozen, reason } — an unreadable
// state reads as frozen (fail closed).
async function frozenVisitVerdict(t, visitId) {
  if (!visitId) return { frozen: false, reason: null };
  try {
    const activity = await visitActivity(visitId, t);
    if (!activity) return { frozen: false, reason: null }; // no such visit: the row is effectively ungrouped
    // Not open and not dissolved (closing, …) = being finalized: frozen for
    // every direct writer, exactly as the unit mover refuses it (P0 r36).
    if (String(activity.status) !== 'open' && String(activity.status) !== 'dissolved') return { frozen: true, reason: 'visit_not_open' };
    if (String(activity.status) === 'dissolved') return { frozen: false, reason: null };
    const split = canSplit(activity);
    if (!split.ok && split.reason !== 'visit_not_open') return { frozen: true, reason: split.reason };
    const memberIds = (await t('scheduled_services').where({ visit_id: visitId }).select('id')).map((m) => m.id);
    const claim = memberIds.length
      ? await t('service_completion_attempts').whereIn('service_id', memberIds).whereIn('status', LIVE_COMPLETION_CLAIM_STATUSES).first('id')
      : null;
    if (claim) return { frozen: true, reason: 'completion_in_flight' };
    return { frozen: false, reason: null };
  } catch (err) {
    require('./logger').warn(`[visit-groups] frozenVisitVerdict(${visitId}) unreadable — treated as frozen: ${err.message}`);
    return { frozen: true, reason: 'unreadable' };
  }
}

// Shared guard for DIRECT slot writers (IB tools, board movers): under the
// row's stop lock, a grouped row (≥2 live members) or a member of a
// frozen/claimed/finalizing visit must not be moved alone (codex #3609
// r29 P1 — the IB tools wrote the row directly and stranded the parent).
// Throws the same operational 409s the bulk mover uses; callers surface
// or per-row-skip them.
// `observedVisitId` = the caller's own read of the row's visit_id; an
// ungrouped observation returns immediately (the caller's CAS pins
// visit_id, so a row grouped SINCE that read misses the write instead) —
// the locked verification below runs only for rows observed grouped.
async function assertRowMovableAlone(t, rowId, observedVisitId) {
  if (!observedVisitId) return;
  await lockStopForRow(t, rowId);
  const fresh = await t('scheduled_services').where({ id: rowId }).first('visit_id');
  const vid = fresh ? fresh.visit_id : observedVisitId;
  if (!vid) return;
  const members = await openMembers(t, vid);
  if (members.length >= 2) {
    throw Object.assign(new Error('This appointment is grouped with another service at the same stop — move the stop from the schedule (the whole visit moves together), or separate the services first.'), { statusCode: 409, code: 'VISIT_EDIT_SCHEDULE_UNSUPPORTED', isOperational: true });
  }
  const verdict = await frozenVisitVerdict(t, vid);
  if (verdict.frozen) {
    throw Object.assign(new Error('This visit already has an issued link, records or a payment in progress — finish it, or contact the office to move it.'), { statusCode: 409, code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', isOperational: true, reason: verdict.reason });
  }
}

async function alignMemberTechnician(t, rowId, technicianId, { skipVisitSeam = false, expectTechnicianId, actorId = null, noticeActorId } = {}) {
  const { assignDispatchJob } = require('./dispatch-assignment');
  // actorId: the staff row behind a unit move (dispatch_alerts.resolved_by
  // + the broadcast). noticeActorId: who the tech's card names when that is
  // not a staff row — the customer moving the stop online — so their own
  // move stays silent and the card never says "by the office" for a
  // customer move (codex r9 P2).
  await assignDispatchJob({
    jobId: rowId, technicianId, actorId, emit: true, trx: t, skipVisitSeam,
    ...(expectTechnicianId !== undefined ? { expectTechnicianId } : {}),
    ...(noticeActorId !== undefined ? { noticeActorId } : {}),
  });
}

/**
 * Do the WINDOWED members of a set form ONE transitively-overlapping chain
 * (09-10 · 10-11 · 11-12 is one stop; 09-10 · 11-12 is two)? Windowless
 * members join anything and are ignored here. Shared by creation
 * (codex r12 P2: an arbitrary anchor row rejected valid chains) and by
 * post-removal recompute (codex r8).
 */
function windowedMembersConnected(members) {
  const windowed = (members || []).filter((m) => m && m.window_start)
    .sort((a, b) => String(a.window_start).localeCompare(String(b.window_start)));
  for (let i = 1; i < windowed.length; i += 1) {
    const prevHi = windowed.slice(0, i)
      .map((m) => toMinutes(m.window_end) ?? toMinutes(m.window_start))
      .reduce((a, b) => Math.max(a, b), -1);
    if (toMinutes(windowed[i].window_start) > prevHi) return false;
  }
  return true;
}

async function visitActivity(visitId, trx = db) {
  const visit = await trx('service_visits').where({ id: visitId }).first();
  if (!visit) return null;
  const [effects, reminderClaim, packets, children] = await Promise.all([
    trx('visit_effects').where({ visit_id: visitId }).whereNot('status', 'pending').first(),
    // A reminder tier claimed inside its lease: an owner is mid-send, or
    // delivered and not yet ledgered/closed (GH codex #3699 r9 P2). A
    // split in that window would detach an armed row the owner's
    // post-send member close can no longer see. Lease-bounded, so a
    // finalize failure that leaves the row `claimed` forever cannot
    // freeze splits past the lease.
    trx('visit_effects').where({ visit_id: visitId })
      .whereIn('effect_type', [...REMINDER_EFFECT_TYPES])
      .where('status', 'claimed')
      .where('claimed_at', '>', new Date(Date.now() - NOTIFICATION_CLAIM_LEASE_MS))
      .first('id'),
    trx('visit_completion_packets').where({ visit_id: visitId }).select('status'),
    trx('scheduled_services').where({ visit_id: visitId }).select('id'),
  ]);
  const childIds = children.map((c) => c.id);
  const [record, invoice] = childIds.length
    ? await Promise.all([
      trx('service_records').whereIn('scheduled_service_id', childIds).first('id')
        .catch(() => null),
      trx('invoices').whereIn('scheduled_service_id', childIds).first('id')
        .catch(() => null),
    ])
    : [null, null];
  return {
    status: visit.status,
    effectsStarted: Boolean(effects),
    reminderClaimLive: Boolean(reminderClaim),
    enRouteAt: visit.en_route_at,
    arrivedAt: visit.arrived_at,
    activePacket: packets.some((p) => ACTIVE_PACKET_STATUSES.includes(String(p.status))),
    anyPacket: packets.length > 0,
    childRecords: Boolean(record),
    childInvoices: Boolean(invoice),
    childReports: false, // reports hang off service_records; covered by childRecords
    linkIssued: Boolean(visit.summary_token_issued_at),
    paymentAttempted: Boolean(visit.payment_intent_id),
    childCount: childIds.length,
  };
}

/**
 * Recompute a visit's window as the union of its remaining non-terminal
 * members (codex r7 P2): removing the earliest/latest child must shrink
 * the union or later joins can match a stale range.
 */
async function recomputeVisitWindow(t, visitId) {
  const members = await t('scheduled_services').where({ visit_id: visitId })
    .whereNotIn('status', TERMINAL_ROW_STATUSES)
    .select('window_start', 'window_end');
  if (!members.length) return;
  // Connectivity (codex r8): removing a BRIDGE member can leave the rest
  // transitively disconnected (09-10 and 11-12 held together by a 10-11
  // middle). Windowed members must form ONE overlapping chain; if not,
  // and the visit is still dissolvable, it dissolves — otherwise
  // membership is preserved and logged (frozen visits never got here;
  // effects-sent visits log for the office).
  if (!windowedMembersConnected(members)) {
    const activity = await visitActivity(visitId, t);
    if (canDissolve(activity).ok) {
      await t('scheduled_services').where({ visit_id: visitId }).update({ visit_id: null });
      await t('service_visits').where({ id: visitId })
        .update({ status: 'dissolved', close_reason: 'row_moved', closed_at: t.fn.now() });
      return;
    }
    const logger = require('./logger');
    logger.warn(`[visit-groups] visit ${visitId} members no longer form one stop after a removal — membership preserved (not dissolvable)`);
  }
  const starts = members.map((m) => m.window_start).filter(Boolean);
  const ends = members.map((m) => m.window_end).filter(Boolean);
  await t('service_visits').where({ id: visitId }).update({
    window_start: starts.length ? starts.sort()[0] : null,
    window_end: ends.length ? ends.sort().slice(-1)[0] : null,
  });
}

async function nextStopSeq(trx, baseKey) {
  const row = await trx('service_visits')
    .where({ stop_base_key: baseKey })
    .max('stop_seq as max')
    .first();
  return Number(row && row.max ? row.max : 0) + 1;
}

/**
 * Create a visit for `rows` (>= 2 scheduled_services already loaded with
 * catalog flags) or join them onto an eligible open visit for the stop.
 * Caller checks the gate; this only enforces invariants. Returns the visit.
 */
const baseKeyFor = (r) => stopBaseKey({
  propertyId: r.property_id,
  customerId: r.customer_id,
  scheduledDate: r.scheduled_date,
});

async function createOrJoinVisit({ rows, createdBy, trx = null }) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('createOrJoinVisit needs >= 2 rows');
  const ids = rows.map((r) => (r && r.id) || r).filter(Boolean);
  if (ids.length !== rows.length) throw new Error('createOrJoinVisit rows need ids');

  // Authoritative reload with catalog flags — caller snapshots are never
  // trusted for eligibility (codex r3 P1: a reschedule/reassignment can
  // commit between the caller's read and our lock).
  const loadRows = (t, { lock }) => {
    let q = t('scheduled_services as ss')
      .leftJoin('services as svc', 'ss.service_id', 'svc.id')
      .whereIn('ss.id', ids)
      .select(
        'ss.id', 'ss.customer_id', 'ss.property_id', 'ss.scheduled_date',
        'ss.source_action', 'ss.customer_confirmed',
        'ss.window_start', 'ss.window_end', 'ss.technician_id', 'ss.status',
        'ss.visit_id',
        'svc.groupable as groupable', 'svc.group_family as group_family',
      );
    if (lock) q = q.forUpdate('ss');
    return q;
  };

  const run = async (t) => {
    // Derive the stop key from an unlocked peek, take the stop advisory
    // lock (always BEFORE row locks — same order as splitChild/dissolve),
    // then lock + reload and confirm the key still matches. A concurrent
    // reschedule between peek and lock surfaces as a mismatch.
    const peek = await loadRows(t, { lock: false });
    if (peek.length !== ids.length) throw new Error('createOrJoinVisit: row not found');
    const stopCustomerId = peek[0].customer_id;
    // A STABLE mixed-customer selection is an invalid request, not a race
    // (GH codex r2 P2): refuse it as not-groupable (the route's 409)
    // instead of letting the post-lock check spin it through the
    // VISIT_STOP_MOVED retries into a 500.
    if (peek.some((r) => String(r.customer_id) !== String(stopCustomerId))) {
      throw new Error('rows not mutually groupable: rows span two customers');
    }
    // Autopay exclusion UNDER the customer row lock (pre-push codex P0 —
    // TOCTOU): the callers' unlocked pre-checks are fast paths only; the
    // authoritative check runs here, in the same transaction that creates
    // or joins the visit. Customer lock taken BEFORE the stop advisory
    // lock, matching the booking paths' customer → stop-advisory order
    // (booking.js locks the customer first, then stamps). A concurrent
    // enrollment either committed first (seen and refused here) or waits
    // on this row lock until the grouping commits. Enrollment AFTER a
    // group exists is NOT a double-charge path in Phase 1 (every row
    // still bills once, per row — see customerExcludedByAutopay); it is
    // the documented Phase-2 gate-flip precondition, owned by that lane.
    // FOR NO KEY UPDATE, not FOR UPDATE (pre-push codex r9 P1): the callers'
    // just-inserted scheduled_services row already holds the customer's
    // FK KEY SHARE lock, and FOR UPDATE conflicts with KEY SHARE — two
    // concurrent same-customer bookings would each hold KEY SHARE and
    // deadlock on the upgrade (one grouping silently skipped). NO KEY
    // UPDATE does not conflict with KEY SHARE, yet still conflicts with the
    // enrollment UPDATE's own NO KEY UPDATE lock — the serialization the
    // TOCTOU fix needs is intact.
    await t('customers').where({ id: stopCustomerId }).forNoKeyUpdate().first('id');
    if (await customerExcludedByAutopay(stopCustomerId, t)) {
      throw new Error('rows not mutually groupable: autopay_enrolled');
    }
    await lockStop(t, baseKeyFor(peek[0]));
    const baseKey = baseKeyFor(peek[0]);

    const fresh = await loadRows(t, { lock: true });
    if (fresh.length !== ids.length) throw new Error('createOrJoinVisit: row not found');
    const [first] = fresh;
    const lockedKey = baseKeyFor(first);
    if (lockedKey !== baseKey
      // The stop key anchors on property when present, so a customer swap
      // (merge repoint) could survive the key check — the autopay verdict
      // above was rendered for stopCustomerId and must not carry over.
      || fresh.some((r) => String(r.customer_id) !== String(stopCustomerId))) {
      const err = new Error('visit stop moved concurrently — retry');
      err.code = 'VISIT_STOP_MOVED';
      throw err;
    }

    const attachedVisitIds = [...new Set(fresh.map((r) => r.visit_id).filter(Boolean).map(String))];
    if (attachedVisitIds.length > 1) {
      throw new Error('visit membership conflict: rows span two visits');
    }
    for (const r of fresh) {
      if (JOIN_INELIGIBLE_STATUSES.includes(String(r.status || ''))) {
        throw new Error('visit membership conflict: a row is already terminal');
      }
      if (!r.groupable || !r.group_family) {
        throw new Error('rows not mutually groupable: not_groupable');
      }
      if (require('./call-booking-source-actions').isPendingOutboundReviewBooking(r)) {
        throw new Error('rows not mutually groupable: office_review');
      }
    }
    // A row that already carries a completion artifact (service record or
    // invoice — prepaid, pre-minted, or an earlier completion) never forms
    // or joins a visit (codex #3590 r13): canSplit would freeze the new
    // group on that artifact immediately, making it impossible to separate.
    const unattachedIds0 = fresh.filter((r) => !r.visit_id).map((r) => r.id);
    if (unattachedIds0.length) {
      const [rec, inv] = await Promise.all([
        t('service_records').whereIn('scheduled_service_id', unattachedIds0).first('id').catch(() => null),
        t('invoices').whereIn('scheduled_service_id', unattachedIds0).first('id').catch(() => null),
      ]);
      if (rec || inv) throw new Error('rows not mutually groupable: child_artifact');
    }
    // One technician owns the visit (doc §2 rev 5): all non-null
    // assignments across the input rows must agree.
    const rowTechs = [...new Set(fresh.map((r) => r.technician_id).filter(Boolean).map(String))];
    if (rowTechs.length > 1) throw new Error('rows not mutually groupable: technician');
    // Non-window compatibility against the first row (customer, property,
    // date, family, tech, status) — the anchor is WINDOWLESS here so the
    // window rule is judged over the whole set below, not against whichever
    // row the unordered query returned first (codex #3590 r12 P2: a valid
    // 09-10 · 10-11 · 11-12 chain was rejected whenever an endpoint
    // happened to be the anchor).
    const anchor = { ...first, status: 'open', window_start: null, window_end: null };
    for (const r of fresh.slice(1)) {
      const probe = canJoin(r, anchor);
      if (!probe.ok) throw new Error(`rows not mutually groupable: ${probe.reason}`);
    }
    if (!windowedMembersConnected(fresh)) {
      throw new Error('rows not mutually groupable: window');
    }

    let visit = null;
    if (attachedVisitIds.length === 1) {
      // Join-to-existing: some rows already belong to one visit — the rest
      // may only join THAT visit, and only while it is open and eligible.
      const target = await t('service_visits').where({ id: attachedVisitIds[0] }).first();
      if (!target || String(target.status) !== 'open' || target.stop_base_key !== baseKey) {
        throw new Error('visit membership conflict: attached visit not open for joining');
      }
      // Membership freeze applies to JOINS too (codex #3590 r4): once the
      // visit has a packet, child artifact, issued link, or payment
      // attempt, its member set is frozen — a late join would desync
      // packet items and the customer surface.
      const targetActivity = await visitActivity(target.id, t);
      const joinGate = canSplit(targetActivity);
      if (!joinGate.ok) {
        throw new Error(`visit membership conflict: target frozen (${joinGate.reason})`);
      }
      // Non-window rules against the target; the window rule runs over
      // the COMBINED member set (codex #3590 r13 P2): a 09-10 visit plus a
      // 10-11 · 11-12 continuation is one chain even though 11-12 never
      // touches the parent's current union.
      const targetAnchor = { ...target, window_start: null, window_end: null };
      for (const r of fresh) {
        if (r.visit_id) continue; // already a member
        const probe = canJoin(r, targetAnchor);
        if (!probe.ok) throw new Error(`rows not mutually groupable: ${probe.reason}`);
      }
      const targetMembers = await openMembers(t, target.id);
      if (!windowedMembersConnected([...targetMembers, ...fresh.filter((r) => !r.visit_id)])) {
        throw new Error('rows not mutually groupable: window');
      }
      if (rowTechs.length && target.technician_id && String(target.technician_id) !== rowTechs[0]) {
        throw new Error('rows not mutually groupable: technician');
      }
      visit = target;
    } else {
      const openVisits = await t('service_visits')
        .where({ stop_base_key: baseKey })
        .whereIn('status', OPEN_STATUSES)
        .orderBy('stop_seq', 'asc');
      for (const v of openVisits) {
        if (rowTechs.length && v.technician_id && String(v.technician_id) !== rowTechs[0]) continue;
        const vAnchor = { ...v, window_start: null, window_end: null };
        if (!fresh.every((r) => canJoin(r, vAnchor).ok)) continue;
        // Combined-chain window rule (codex r13 P2), as in join-to-existing.
        if (!windowedMembersConnected([...(await openMembers(t, v.id)), ...fresh])) continue;
        // Membership freeze applies here too (codex r5): a visit whose
        // packet/artifact/link/payment froze its member set never absorbs
        // new rows, even fully unattached ones — skip to a fresh seq.
        const vActivity = await visitActivity(v.id, t);  
        if (!canSplit(vActivity).ok) continue;
        visit = v; break;
      }
    }

    if (!visit) {
      const seq = await nextStopSeq(t, baseKey);
      [visit] = await t('service_visits')
        .insert({
          customer_id: first.customer_id,
          property_id: first.property_id || null,
          scheduled_date: dateOnly(first.scheduled_date),
          window_start: first.window_start || null,
          window_end: first.window_end || null,
          stop_base_key: baseKey,
          stop_seq: seq,
          technician_id: rowTechs[0] || null,
          group_family: first.group_family || null,
          status: 'open',
          created_by: createdBy || 'admin:unknown',
        })
        .returning('*');
    }

    // Widen the visit window to the union of member windows (doc rev 5f).
    const starts = [visit.window_start, ...fresh.map((r) => r.window_start)].filter(Boolean);
    const ends = [visit.window_end, ...fresh.map((r) => r.window_end)].filter(Boolean);
    const patch = {};
    if (starts.length) patch.window_start = starts.sort()[0];
    if (ends.length) patch.window_end = ends.sort().slice(-1)[0];
    // The visit owns the assignment: adopt the rows' single technician when
    // the visit has none, and align children below.
    if (!visit.technician_id && rowTechs[0]) patch.technician_id = rowTechs[0];
    if (Object.keys(patch).length) {
      await t('service_visits').where({ id: visit.id }).update(patch);
      Object.assign(visit, patch);
    }

    // Serialize with legacy completion (codex r2 P0): rows are locked
    // above; refuse any row with a live or succeeded completion attempt.
    // The legacy handler claims its attempt (committed) BEFORE re-reading
    // membership under the same row lock, so every interleaving resolves:
    // either we see the claim here and refuse, or the handler sees our
    // committed stamp and 409s.
    // The check spans EVERY current member of a reused/joined visit, not
    // just the input rows (codex #3590 r11): a claim on an existing member
    // may already have committed and released the post-claim stop lock —
    // attaching new rows now would only have them dissolved by that
    // completion's dissolveForLegacyCompletion moments later.
    const liveAttempt = await t('service_completion_attempts')
      .where((qb) => {
        qb.whereIn('service_id', ids);
        if (visit.id) {
          qb.orWhereIn('service_id', t('scheduled_services').select('id').where({ visit_id: visit.id }));
        }
      })
      .whereIn('status', LIVE_COMPLETION_CLAIM_STATUSES)
      .first('id')
      .catch(() => null);
    if (liveAttempt) {
      throw new Error('visit membership conflict: a completion attempt is in flight');
    }

    // The visit owns assignment (rev-5 item 6): when the parent has (or
    // adopts) a technician, EVERY member aligns — including previously
    // attached children, or tech-scoped dispatch views would split the
    // physical stop (codex #3590 r4).
    // Alignment goes through the canonical assignment writer (codex r13
    // P1) — never a bare technician_id write.
    if (visit.technician_id) {
      const unassignedMembers = (await openMembers(t, visit.id)).filter((m) => !m.technician_id);
      for (const m of unassignedMembers) await alignMemberTechnician(t, m.id, visit.technician_id);
    }
    const unattachedIds = fresh.filter((r) => !r.visit_id).map((r) => r.id);
    const stamped = unattachedIds.length
      ? await t('scheduled_services')
        .whereIn('id', unattachedIds)
        .whereNull('visit_id')
        .update({ visit_id: visit.id })
      : 0;
    if (Number(stamped) !== unattachedIds.length) {
      throw new Error('visit membership conflict: a row is attached to another visit');
    }
    // A joiner INHERITS an active unit-move hold (codex #3609 r34 P1):
    // when this join lands between a running move's phases (the mover's
    // lease is claimed in its own trx, not under this stop lock for the
    // whole move), an existing member's live move_hold_until must cover
    // the new member too — otherwise a partial move leaves every planned
    // member suppressed while the late joiner texts freely. Same inherit
    // shape the registration self-heal uses; best-effort (the mover's
    // per-member re-stamp and the senders' checks stay authoritative).
    if (unattachedIds.length) {
      try {
        const heldSibling = await t('appointment_reminders as ar')
          .join('scheduled_services as ss', 'ss.id', 'ar.scheduled_service_id')
          .where('ss.visit_id', visit.id)
          .where('ar.move_hold_until', '>', new Date())
          .orderBy('ar.move_hold_until', 'desc')
          .first('ar.move_hold_until', 'ar.move_hold_token');
        if (heldSibling) {
          // A joiner with NO reminder row gets one CREATED held (codex r35):
          // booking/seeding can group rows before registerAppointment runs,
          // and that later registration would arrive unheld mid-move.
          const existing = (await t('appointment_reminders')
            .whereIn('scheduled_service_id', unattachedIds)
            .select('scheduled_service_id')).map((r) => String(r.scheduled_service_id));
          for (const missingId of unattachedIds.map(String).filter((id) => !existing.includes(id))) {
            await ensureMemberReminderRowInTx(t, missingId);
          }
          await t('appointment_reminders')
            .whereIn('scheduled_service_id', unattachedIds)
            .where((q) => { q.whereNull('move_hold_until').orWhere('move_hold_until', '<', heldSibling.move_hold_until); })
            .update({ move_hold_until: heldSibling.move_hold_until, move_hold_token: heldSibling.move_hold_token || null });
        }
      } catch (holdErr) {
        // FAIL CLOSED (uncapped r36 P1): this inherit is the ONLY thing
        // keeping a mid-move joiner quiet — a swallowed failure commits an
        // unheld member that can text stale details while the move runs.
        // Aborting rolls the join back; createOrJoinVisit's retry loop (or
        // the caller's) re-attempts.
        throw Object.assign(new Error(`visit join aborted — the member hold could not be inherited: ${holdErr.message}`), { code: holdErr.code || 'VISIT_JOIN_HOLD_FAILED' });
      }
    }
    if (visit.technician_id) {
      for (const r of fresh) {
        if (!r.visit_id && !r.technician_id) await alignMemberTechnician(t, r.id, visit.technician_id);
      }
    }
    return visit;
  };

  if (trx) return run(trx);
  // Advisory locks are transaction-scoped; a stop that moved concurrently
  // needs a fresh transaction, so retry the whole unit a couple of times.
  let lastErr = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      return await db.transaction(run);  
    } catch (err) {
      // 40P01 = PG deadlock: the tech-day fence taken by assignDispatchJob
      // can be held by a scheduling writer that is waiting on our stop
      // lock; PG aborts one side — retrying resolves it.
      if (err && (err.code === 'VISIT_STOP_MOVED' || err.code === '40P01')) { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Explicit split / "Separate these services" (doc §2): DETACH one child to
 * a plain ungrouped row, subject to the membership freeze. Until Phase-2
 * grouped completion exists, a one-row visit is pointless (the doc says it
 * auto-dissolves), so detaching IS the split; when the source is left with
 * one untouched row it dissolves too, returning both rows to the legacy
 * per-row path.
 */
/**
 * A row leaving a visit (split / split-triggered dissolve) carries the
 * visit's already-decided reminder tiers with it (GH codex r8 P2): the
 * owner's send closes every member row afterwards, but a split that lands
 * between the ledger finalize and that close — or after a worker crash —
 * leaves the detached row armed, and armed-without-a-visit means the
 * per-row path texts the same tier again. Reads the ledger for the row's
 * OWN occurrence date (the dedupe key carries it) and closes the row's
 * flag for every tier the visit already sent or suppressed; a `failed`
 * (retryable) tier stays armed — over-notify, never silence. Same
 * transaction as the detach, so there is no window.
 */
const REMINDER_TIER_FLAGS = Object.freeze({
  reminder_72h: ['reminder_72h_sent', 'reminder_72h_sent_at'],
  reminder_24h: ['reminder_24h_sent', 'reminder_24h_sent_at'],
});
async function carryVisitReminderState(t, visit, rows) {
  for (const row of rows) {
    const keys = Object.keys(REMINDER_TIER_FLAGS)
      .map((effectType) => dedupeKeyFor({ id: visit.id, scheduled_date: row.scheduled_date }, effectType));
    const decided = await t('visit_effects')
      .where({ visit_id: visit.id })
      .whereIn('dedupe_key', keys)
      .whereIn('status', ['sent', 'suppressed'])
      .select('effect_type');
    for (const eff of decided) {
      const [flag, at] = REMINDER_TIER_FLAGS[eff.effect_type] || [];
      if (!flag) continue;
      await t('appointment_reminders')
        .where({ scheduled_service_id: row.id, cancelled: false, [flag]: false })
        .update({ [flag]: true, [at]: t.fn.now() });
    }
  }
}

async function splitChild({ visitId, scheduledServiceId, createdBy }) {
  return db.transaction(async (t) => {
    const visit = await t('service_visits').where({ id: visitId }).first();
    if (!visit) throw new Error('visit not found');
    await lockStop(t, visit.stop_base_key);
    const activity = await visitActivity(visitId, t);
    const gate = canSplit(activity);
    if (!gate.ok) {
      const err = new Error(`split refused: ${gate.reason}`);
      err.code = 'VISIT_SPLIT_REFUSED';
      throw err;
    }
    const child = await t('scheduled_services')
      .where({ id: scheduledServiceId, visit_id: visitId }).first();
    if (!child) throw new Error('row is not a member of this visit');

    await t('scheduled_services').where({ id: child.id }).update({ visit_id: null });
    await carryVisitReminderState(t, visit, [child]);

    const remaining = await t('scheduled_services')
      .where({ visit_id: visitId })
      .whereNotIn('status', TERMINAL_ROW_STATUSES)
      .count('id as n').first();
    let dissolved = false;
    if (Number(remaining.n) <= 1) {
      const still = await visitActivity(visitId, t);
      if (canDissolve(still).ok) {
        const lastMembers = await t('scheduled_services').where({ visit_id: visitId }).select('id', 'scheduled_date');
        await t('scheduled_services').where({ visit_id: visitId }).update({ visit_id: null });
        await carryVisitReminderState(t, visit, lastMembers);
        await t('service_visits').where({ id: visitId })
          .update({ status: 'dissolved', close_reason: 'operator', closed_at: t.fn.now() });
        dissolved = true;
      }
    }
    if (!dissolved) await recomputeVisitWindow(t, visitId);
    return { detached: child.id, visitId };
  });
}

/**
 * Canonical cancel/skip hook (doc §2: "Cancel/skip leaves the group; the
 * last remaining row dissolves it"). Called from the status-transition
 * path after a child goes terminal. Detaches the terminal row and, when at
 * most one non-terminal member remains on an untouched visit, dissolves
 * it. Best-effort: never fails the committed status flip.
 */
async function handleChildTerminal(scheduledServiceId) {
  try {
    const row = await db('scheduled_services').where({ id: scheduledServiceId }).first('id', 'visit_id');
    if (!row || !row.visit_id) return false;
    return await db.transaction(async (t) => {
      const visit = await t('service_visits').where({ id: row.visit_id }).first();
      if (!visit || !['open'].includes(String(visit.status))) return false;
      await lockStop(t, visit.stop_base_key);
      // Re-read under the stop lock (codex #3590 r3 P1): this hook runs
      // post-commit and async — a cancellation reversal or regroup may
      // have landed first. Only a row still terminal AND still attached
      // to THIS visit detaches; the update is predicated on both.
      const fresh = await t('scheduled_services').where({ id: row.id })
        .forUpdate().first('id', 'visit_id', 'status');
      if (!fresh || String(fresh.visit_id) !== String(visit.id)
          || !TERMINAL_ROW_STATUSES.includes(String(fresh.status || ''))) {
        return false;
      }
      // Same freeze rule as stop changes: a packet/artifact/link/payment
      // froze the member set — a terminal child stays recorded on the
      // visit (the closeout path accounts for it), never detached.
      const frozenCheck = canSplit(await visitActivity(visit.id, t));
      if (!frozenCheck.ok && frozenCheck.reason !== 'visit_not_open') {
        const logger = require('./logger');
        logger.warn(`[visit-groups] terminal child on frozen visit ${visit.id} (row ${fresh.id}, ${frozenCheck.reason}) — membership preserved`);
        return false;
      }
      // Terminal child leaves the group (its record keeps history via the
      // packet items / service_records, not via visit_id).
      const cleared = await t('scheduled_services')
        .where({ id: fresh.id, visit_id: visit.id })
        .whereIn('status', TERMINAL_ROW_STATUSES)
        .update({ visit_id: null });
      if (!Number(cleared)) return false;
      const remaining = await t('scheduled_services')
        .where({ visit_id: visit.id })
        .whereNotIn('status', TERMINAL_ROW_STATUSES)
        .count('id as n').first();
      if (Number(remaining.n) > 1) {
        await recomputeVisitWindow(t, visit.id);
        return false;
      }
      const activity = await visitActivity(visit.id, t);
      if (!canDissolve(activity).ok) return false;
      await t('scheduled_services').where({ visit_id: visit.id }).update({ visit_id: null });
      await t('service_visits').where({ id: visit.id })
        .update({ status: 'dissolved', close_reason: 'row_cancelled', closed_at: t.fn.now() });
      return true;
    });
  } catch (err) {
    const logger = require('./logger');
    logger.warn(`[visit-groups] handleChildTerminal(${scheduledServiceId}) skipped: ${err.message}`);
    return false;
  }
}

/**
 * Reschedule/reassignment seam (doc §2, R3 interim): when a single grouped
 * child's stop no longer matches its visit (date changed, window no longer
 * overlaps, or a conflicting technician), the child DETACHES and the
 * remainder dissolves if only one untouched member is left. The full
 * group-moves-as-a-unit behavior arrives with the #3562 collective-move
 * integration (next PR); this seam guarantees no visit ever holds a child
 * for the wrong stop in the meantime. Best-effort, gate-independent.
 */
async function handleChildStopChanged(scheduledServiceId) {
  try {
    const row = await db('scheduled_services').where({ id: scheduledServiceId })
      .first('id', 'visit_id', 'scheduled_date', 'window_start', 'window_end', 'technician_id', 'status');
    if (!row || !row.visit_id) return false;
    return await db.transaction(async (t) => {
      const visit = await t('service_visits').where({ id: row.visit_id }).first();
      if (!visit || String(visit.status) !== 'open') return false;
      await lockStop(t, visit.stop_base_key);
      const fresh = await t('scheduled_services as ss')
        .leftJoin('services as svc', 'ss.service_id', 'svc.id')
        .where('ss.id', row.id).forUpdate('ss')
        .first('ss.id', 'ss.visit_id', 'ss.scheduled_date', 'ss.window_start', 'ss.window_end',
          'ss.technician_id', 'ss.status', 'svc.groupable', 'svc.group_family');
      if (!fresh || String(fresh.visit_id) !== String(visit.id)) return false;
      // A FROZEN visit (packet/artifact/link/payment) never loses members
      // to a stop edit (codex r6): the recorded artifacts must keep their
      // child set. Membership stays; the stale stop is logged for the
      // office and resolves through the visit's own closeout path.
      const frozenCheck = canSplit(await visitActivity(visit.id, t));
      if (!frozenCheck.ok && frozenCheck.reason !== 'visit_not_open') {
        const logger = require('./logger');
        logger.warn(`[visit-groups] stop change on frozen visit ${visit.id} (row ${fresh.id}, ${frozenCheck.reason}) — membership preserved`);
        return false;
      }
      // Window test runs against the OTHER members, not the stale parent
      // union (codex r5): a child that no longer overlaps any sibling is a
      // second physical stop even when it grazes the old union.
      const others = await t('scheduled_services').where({ visit_id: visit.id })
        .whereNot('id', fresh.id)
        .whereNotIn('status', TERMINAL_ROW_STATUSES)
        .select('window_start', 'window_end');
      const overlapsMembers = others.length === 0
        || others.some((o) => windowsOverlap(fresh.window_start, fresh.window_end, o.window_start, o.window_end));
      // Tech: a conflicting assignment detaches; an assignment landing on
      // an UNASSIGNED visit is ADOPTED — the visit owns assignment, so the
      // parent and every unassigned member align (codex r5).
      let staleParentTech = false;
      if (fresh.technician_id && visit.technician_id
          && String(fresh.technician_id) !== String(visit.technician_id)) {
        // Whole-visit reassignment lands child-by-child (codex r10: the
        // day swap moves every member, the parent lags): when EVERY
        // non-terminal member already carries the row's new technician,
        // the parent is the stale side — re-point it instead of
        // detaching the first-processed child.
        const memberTechs = await t('scheduled_services').where({ visit_id: visit.id })
          .whereNotIn('status', TERMINAL_ROW_STATUSES)
          .distinct('technician_id').pluck('technician_id');
        if (memberTechs.length === 1 && String(memberTechs[0]) === String(fresh.technician_id)) {
          await t('service_visits').where({ id: visit.id }).update({ technician_id: fresh.technician_id });
          visit.technician_id = fresh.technician_id;
          staleParentTech = true;
        }
      }
      const techConflict = !staleParentTech && Boolean(
        (fresh.technician_id && visit.technician_id
          && String(fresh.technician_id) !== String(visit.technician_id))
        // Explicitly UNASSIGNING one child of an assigned visit is a
        // single-row divergence from visit-owned assignment — the child
        // detaches rather than becoming invisible to tech-scoped views
        // (codex r6; doc rev-5 item 6: one-row tech changes are splits).
        || (!fresh.technician_id && visit.technician_id),
      );
      const stillMatches = dateOnly(fresh.scheduled_date) === dateOnly(visit.scheduled_date)
        && overlapsMembers
        && !techConflict
        // An Edit that reclassifies the SERVICE (new service_id) must keep
        // the same-family rule enforced at creation (codex r7).
        && Boolean(fresh.groupable)
        && familiesCompatible(fresh.group_family, visit.group_family)
        && !JOIN_INELIGIBLE_STATUSES.includes(String(fresh.status || ''));
      if (stillMatches) {
        // Adoption ONLY once every retention predicate passed (codex r8):
        // adopting before the date/window/family checks let a departing
        // child leave its technician stamped on an unrelated visit.
        if (fresh.technician_id && !visit.technician_id) {
          await t('service_visits').where({ id: visit.id }).update({ technician_id: fresh.technician_id });
          // Siblings align through the canonical assignment writer (codex
          // r13 P1: route_order, unassigned_overdue alerts, fence, broadcast).
          const siblings = (await openMembers(t, visit.id))
            .filter((m) => !m.technician_id && String(m.id) !== String(fresh.id));
          for (const m of siblings) await alignMemberTechnician(t, m.id, fresh.technician_id);
          visit.technician_id = fresh.technician_id;
        }
        // The move stayed overlapping SOME member, but may have broken
        // transitive connectivity (codex r9: a bridge moved to the front
        // strands the tail) or shifted the union — run the connectivity-
        // aware recompute, which dissolves a disconnected dissolvable
        // visit and otherwise updates the union.
        await recomputeVisitWindow(t, visit.id);
        return false;
      }
      await t('scheduled_services').where({ id: fresh.id }).update({ visit_id: null });
      const remaining = await t('scheduled_services')
        .where({ visit_id: visit.id })
        .whereNotIn('status', TERMINAL_ROW_STATUSES)
        .count('id as n').first();
      let dissolved = false;
      if (Number(remaining.n) <= 1) {
        const activity = await visitActivity(visit.id, t);
        if (canDissolve(activity).ok) {
          await t('scheduled_services').where({ visit_id: visit.id }).update({ visit_id: null });
          await t('service_visits').where({ id: visit.id })
            .update({ status: 'dissolved', close_reason: 'row_moved', closed_at: t.fn.now() });
          dissolved = true;
        }
      }
      if (!dissolved) await recomputeVisitWindow(t, visit.id);
      return true;
    });
  } catch (err) {
    const logger = require('./logger');
    logger.warn(`[visit-groups] handleChildStopChanged(${scheduledServiceId}) skipped: ${err.message}`);
    return false;
  }
}

/**
 * Legacy-completion gate for alternate completion routes (pest-recap) and
 * the deferred dissolve of the main /complete path. `ensure` answers "may
 * this row complete per-row right now?" WITHOUT mutating anything:
 * unattached/dissolved ⇒ ok; open visit with any packet, or a
 * closing/closed visit ⇒ not ok (409 material). `dissolve` runs after a
 * legacy completion durably commits: the open packet-less visit dissolves
 * (reason legacy_completion) so it can never speak for rows that already
 * spoke for themselves. Both idempotent, both stop-lock ordered.
 */
async function ensureLegacyCompletable(scheduledServiceId, database = db) {
  const row = await database('scheduled_services').where({ id: scheduledServiceId }).first('id', 'visit_id');
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.visit_id) return { ok: true };
  const visit = await database('service_visits').where({ id: row.visit_id }).first('id', 'status');
  if (!visit) return { ok: false, reason: 'orphan', visitId: row.visit_id }; // fail closed
  if (String(visit.status) === 'dissolved') return { ok: true };
  if (['closing', 'closed'].includes(String(visit.status))) {
    return { ok: false, reason: 'visit_' + visit.status, visitId: visit.id };
  }
  const packet = await database('visit_completion_packets').where({ visit_id: visit.id }).first('id');
  if (packet) return { ok: false, reason: 'packet_exists', visitId: visit.id };
  return { ok: true, openVisitId: visit.id };
}

async function dissolveForLegacyCompletion(visitId, { expectChildId = null, trx = null } = {}) {
  const body = async (t) => {
      const visit = await t('service_visits').where({ id: visitId }).first();
      if (!visit || String(visit.status) !== 'open') return false;
      await lockStop(t, visit.stop_base_key);
      // The completed child must STILL belong to this visit (codex r10):
      // a split/move landing between the recheck and this cleanup means
      // the visit's other members are valid — dissolving it would be
      // collateral damage.
      if (expectChildId) {
        const stillMember = await t('scheduled_services')
          .where({ id: expectChildId, visit_id: visit.id }).first('id');
        if (!stillMember) return false;
      }
      const packet = await t('visit_completion_packets').where({ visit_id: visit.id }).first('id');
      if (packet) return false;
      await t('scheduled_services').where({ visit_id: visit.id }).update({ visit_id: null });
      await t('service_visits').where({ id: visit.id })
        .update({ status: 'dissolved', close_reason: 'legacy_completion', closed_at: t.fn.now() });
      return true;
  };
  // On a caller transaction (pest-recap, codex #3590 r13): the dissolve
  // commits WITH the completion or not at all — failures surface to the
  // caller instead of being swallowed, since a post-commit retry trigger
  // does not exist on that path. The caller must already hold the stop
  // lock (lockStopForRow) before its row lock to keep lock order.
  if (trx) return body(trx);
  try {
    return await db.transaction(body);
  } catch (err) {
    const logger = require('./logger');
    logger.warn(`[visit-groups] dissolveForLegacyCompletion(${visitId}) skipped: ${err.message}`);
    return false;
  }
}

/**
 * Stamping entry point for scheduling paths (converter same-trip rows,
 * recurring seeder, future admin actions). Gate-checked, best-effort:
 * grouping is an enhancement, so failures LOG and return null rather than
 * breaking scheduling. Finds same-stop partner rows (same customer +
 * property + date, non-terminal, groupable catalog type, unattached or in
 * one open visit) and groups them with `rowId`.
 */
/**
 * TRUE when grouping must be refused for this customer because they are on
 * autopay (or their autopay state cannot be read — fail closed). Shared by
 * the automatic stamping path and the office group route.
 *
 * WHAT THIS PROTECTS (and what it does not): Phase 1 has NO visit-level
 * billing — service_visits.payment_intent_id / billing_strategy /
 * billing_hold have no writers, no money code reads visit_id, and a
 * grouped member completing through any existing path first dissolves
 * its open visit (dissolveForLegacyCompletion) and then completes and
 * bills PER ROW, once each — byte-identical to two ungrouped same-day
 * services today. So a customer who enrolls in autopay AFTER a group
 * forms is charged exactly as with no group: once per completed row,
 * never twice. The exclusion protects the Phase-2 contract (one
 * visit-level PaymentIntent, per-invoice receipt suppression): groups
 * must not pre-exist for enrolled customers when that lane ships, and
 * the enrollment-time refuse/dissolve seam belongs to that lane
 * (spec §6/§7, GATE_VISIT_GROUP_AUTOPAY) — not to a money flow here.
 */
async function customerExcludedByAutopay(customerId, database = db) {
  try {
    const customer = await database('customers').where({ id: customerId })
      .first('id', 'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id', 'ach_status');
    if (!customer) return true;
    // ENROLLMENT excludes, not current chargeability (pre-push codex P0):
    // customerOnAutopay returns false during an autopay PAUSE, but a
    // paused customer is still enrolled — a group formed during the pause
    // would persist into resumed autopay and the per-row charger would
    // charge each sibling separately. An explicit enrollment flag refuses
    // outright; the chargeability predicate then catches legacy rows
    // (autopay_enabled NULL with a live default autopay method).
    if (customer.autopay_enabled === true) return true;
    // Explicitly disabled = unenrolled, regardless of any stale pause stamp.
    if (customer.autopay_enabled === false) return false;
    // Legacy NULL-flag rows: ENROLLMENT signals only — never the
    // chargeability predicate (customerOnAutopay), which returns false for
    // a pause, an expired card, or a pending ACH even though all three
    // still represent enrollment (GH codex r3+r4 P1s: the flag survives a
    // card replacement, and the group would persist into resumed
    // chargeability). Enrolled = a live pause (only enrolled accounts
    // pause) OR ANY autopay-enabled method on file, chargeable or not.
    const { isPaused } = require('./autopay-eligibility');
    if (isPaused(customer)) return true;
    const method = await database('payment_methods')
      .where({ customer_id: customerId, autopay_enabled: true })
      .first('id');
    return Boolean(method);
  } catch (err) {
    require('./logger').warn(`[visit-groups] autopay-exclusion check failed for customer ${customerId} — refusing to group: ${err.message}`);
    return true;
  }
}

async function maybeGroupRow(rowId, { createdBy, database = db } = {}) {
  const { gates } = require('../config/feature-gates');
  if (!gates.visitGroups) return null;
  try {
    if (database && database.isTransaction) {
      // Inside a caller transaction (booking/converter/seeder) the work
      // must run on that trx (its uncommitted rows are invisible
      // elsewhere), but a grouping failure must not abort the caller's
      // transaction (25P02 poisons every later statement) — so the WHOLE
      // attempt, reads included, runs inside a SAVEPOINT (knex nested
      // transaction) and the catch below swallows the rolled-back
      // savepoint (codex #3590 r4; widened from createOrJoinVisit alone
      // to the pre-reads + autopay check by the r5 pre-push audit: a
      // failed SELECT there aborted the caller just the same).
      return await database.transaction((sp) => groupRowOn(sp, rowId, createdBy));
    }
    return await groupRowOn(database, rowId, createdBy);
  } catch (err) {
    const logger = require('./logger');
    logger.warn(`[visit-groups] maybeGroupRow(${rowId}) skipped: ${err.message}`);
    return null;
  }
}

// maybeGroupRow's body on one connection: `database` is either the plain
// pool (createOrJoinVisit opens its own transaction) or the caller's
// savepoint (everything, createOrJoinVisit included, runs on it).
async function groupRowOn(database, rowId, createdBy) {
  const row = await database('scheduled_services as ss')
    .leftJoin('services as svc', 'ss.service_id', 'svc.id')
    .where('ss.id', rowId)
    .first('ss.id', 'ss.customer_id', 'ss.property_id', 'ss.scheduled_date',
      'ss.source_action', 'ss.customer_confirmed',
      'ss.window_start', 'ss.window_end', 'ss.technician_id',
      'ss.status', 'ss.visit_id', 'svc.groupable', 'svc.group_family');
  if (!row || row.visit_id || !row.groupable || !row.group_family) return null;
  // Property identity is REQUIRED for automatic grouping (codex #3590
  // r14): a null-property row (legacy / multi-home parent carrying only
  // a stamped service address) would match any other null-property row
  // for the customer that day, folding two addresses into one stop.
  // Such rows group once property linkage stamps them (the linkage
  // regroup pass) or by explicit office action.
  if (!row.property_id) return null;
  // A placed window is REQUIRED for automatic grouping (codex #3590
  // r15): windowless overlaps anything, and a windowless row is by
  // policy an unplaced placeholder (booking-wizard demotion clears the
  // window + tech for the office). Office placement/explicit grouping
  // is the path for those rows — as subject AND as partner.
  if (!row.window_start) return null;
  if (require('./call-booking-source-actions').isPendingOutboundReviewBooking(row)) return null;
  if (JOIN_INELIGIBLE_STATUSES.includes(String(row.status || ''))) return null;
  // Autopay exclusion (spec rev-2 item: "autopay customers are not
  // grouped until grouped autopay ships"; owner ruling 2026-08-31) —
  // see customerExcludedByAutopay for what it protects (the Phase-2
  // visit-level PI contract; per-row billing today is once per row,
  // group or not). FAST PATH ONLY — the authoritative check runs inside
  // createOrJoinVisit under the customer row lock (pre-push codex P0
  // TOCTOU); this unlocked read just avoids partner queries for a
  // customer that will be refused anyway. Unit moves of existing visits
  // never pass through createOrJoinVisit, so later enrollment cannot
  // break them.
  if (await customerExcludedByAutopay(row.customer_id, database)) return null;
  const partnersQ = database('scheduled_services as ss')
    .leftJoin('services as svc', 'ss.service_id', 'svc.id')
    .leftJoin('service_visits as sv', 'sv.id', 'ss.visit_id')
    .where('ss.customer_id', row.customer_id)
    .where('ss.scheduled_date', dateOnly(row.scheduled_date))
    .whereNot('ss.id', row.id)
    .whereNotIn('ss.status', JOIN_INELIGIBLE_STATUSES)
    .where('svc.groupable', true)
    .where('svc.group_family', row.group_family)
    .whereNotNull('ss.window_start')
    .where((q) => q.whereNull('ss.visit_id').orWhere('sv.status', 'open'))
    .select('ss.id', 'ss.visit_id');
  if (row.property_id) partnersQ.where('ss.property_id', row.property_id);
  else partnersQ.whereNull('ss.property_id');
  partnersQ.select('ss.window_start', 'ss.window_end', 'ss.technician_id',
    'ss.customer_id', 'ss.property_id', 'ss.scheduled_date', 'ss.status',
    'ss.source_action', 'ss.customer_confirmed',
    'svc.groupable', 'svc.group_family');
  // Every same-stop candidate, deterministically ordered — a cap made
  // grouping depend on heap order once a customer had more rows than
  // the cap (codex #3590 r12 P2). The set is bounded by one customer's
  // one-day, one-property, one-family rows.
  const partners = await partnersQ.orderBy('ss.window_start', 'asc').orderBy('ss.id', 'asc');
  if (!partners.length) return null;
  // Mutually compatible subset (codex r1 P1): one incompatible same-day
  // row must not poison the whole grouping. Treat the new row as a
  // pseudo-visit and keep only partners that would join it, then keep at
  // most ONE attached visit's members (createOrJoinVisit refuses rows
  // spanning two visits).
  const pseudoVisit = { ...row, status: 'open' };
  const compatible = partners.filter((p) => canJoin(p, pseudoVisit).ok
    && windowsOverlap(row.window_start, row.window_end, p.window_start, p.window_end));
  if (!compatible.length) return null;
  const attachedVisit = compatible.find((p) => p.visit_id);
  let subset = attachedVisit
    ? compatible.filter((p) => !p.visit_id || String(p.visit_id) === String(attachedVisit.visit_id))
    : compatible;
  // Technician partition (codex r7 P2): when the new row is unassigned
  // and partners span two technicians, keep ONE tech's partition
  // (the attached visit's tech when present, else the first assigned
  // partner's) plus unassigned partners — otherwise createOrJoinVisit
  // rejects the whole mixed set and nothing groups.
  if (!row.technician_id) {
    const partTechs = [...new Set(subset.map((p) => p.technician_id).filter(Boolean).map(String))];
    if (partTechs.length > 1) {
      const keep = (attachedVisit && attachedVisit.technician_id && String(attachedVisit.technician_id))
        || partTechs[0];
      subset = subset.filter((p) => !p.technician_id || String(p.technician_id) === keep);
    }
  }
  const rows = [{ id: row.id }, ...subset.map((p) => ({ id: p.id }))];
  if (database && database.isTransaction) {
    return await createOrJoinVisit({ rows, createdBy: createdBy || 'dispatch', trx: database });
  }
  return await createOrJoinVisit({ rows, createdBy: createdBy || 'dispatch' });
}

// ---- Live transitions: one tap moves the whole stop (doc §3) ---------------
// En Route / Arrived are tapped ONCE per visit. The tapped row is the
// primary; every eligible sibling (same open visit, non-terminal, same
// technician) transitions in the SAME transaction through the shared
// status writer (each row's own CAS still runs). Tracker writers run per
// sibling after commit with the customer text suppressed — the customer
// gets exactly one "on the way" / "arrived" text, from the primary — and
// the visit records the one-shot in visit_effects (tracker_en_route /
// tracker_arrived), which also starts the membership freeze (canDissolve).
// Implicit SIBLING eligibility only — a `rescheduled` row is a withdrawn
// placeholder awaiting replacement (JOIN_INELIGIBLE_STATUSES) and is never
// advanced by another member's tap (codex #3603 r7); the explicit primary
// keeps its route-level rules.
const LIVE_TRANSITION_FROM = Object.freeze({
  en_route: ['pending', 'confirmed'],
  on_site: ['pending', 'confirmed', 'en_route'],
});

function siblingEligibleFor(toStatus, siblingStatus) {
  const allowed = LIVE_TRANSITION_FROM[String(toStatus || '')];
  return Boolean(allowed && allowed.includes(String(siblingStatus || '')));
}

/**
 * THE visit-aware step of every tracker transition (codex #3603 r1): called
 * by track-transitions.markEnRoute / markOnProperty after the primary row's
 * own write succeeded — manual taps, admin status flips, geofence, GPS
 * arrival and the time clock all converge there, so one En Route / Arrived
 * signal moves the whole stop no matter which entry point produced it.
 *
 * Runs on EVERY call for a grouped primary, including idempotent re-taps,
 * and is idempotent itself (siblings already at the target are skipped for
 * status but still reconciled for tracker state; effect rows insert
 * on-conflict-ignore) — a transient failure after a partial run is repaired
 * by the next signal instead of leaving siblings stale.
 *
 * Lock order: stop advisory lock → sibling row locks, in its OWN
 * transaction after the primary's transaction committed — the primary's
 * status write never holds a row lock while waiting on the stop lock, so
 * two taps on different members (or a tap vs a split/reschedule seam)
 * cannot deadlock.
 *
 * `primary` is the already-loaded scheduled_services row (select *) — an
 * ungrouped row costs no query at all.
 */
/**
 * Visit-scoped notification claim (doc §2 handoff rule; codex #3603 r4/r5):
 * taken by a member's tracker path BEFORE its per-row customer send, UNDER
 * the stop lock with the row's membership re-verified — a row a split just
 * detached never claims (and never blocks) the old visit's notice. The
 * visit_effects row for (visit, tracker_*) is inserted `claimed` on the
 * unique key: exactly one concurrent member wins and sends; the others see
 * 'taken' and stamp themselves covered. Customer texts are at-most-once —
 * an unknown claim state ('error') never sends and is reported to the
 * caller as an incomplete stop, never silently swallowed.
 * Returns { state: 'owner' | 'taken' | 'in_flight' | 'detached' | 'error',
 * token } — `token` (random, stored as visit_effects.claim_token, codex r10)
 * is the owner's proof of ownership for its pre-send lease check and its
 * finalize; a reclaim issues a new token, so a stalled former owner can
 * neither send nor finalize over it. null when the row has no visit.
 */
/**
 * kind → visit_effects.effect_type. Tracker kinds keep their historical
 * mapping (anything unrecognized falls back to tracker_arrived, byte-
 * identical to the old ternary); reminder kinds are the 72h/24h
 * appointment-reminder rails (spec §4: once per visit via
 * visit_effects(reminder_72h/24h)).
 */
const EFFECT_TYPE_BY_KIND = Object.freeze({
  en_route: 'tracker_en_route',
  arrived: 'tracker_arrived',
  on_site: 'tracker_arrived',
  reminder_72h: 'reminder_72h',
  reminder_24h: 'reminder_24h',
  completion_sms: 'completion_sms',
  completion_email: 'completion_email',
  visit_payment: 'visit_payment',
});
const REMINDER_EFFECT_TYPES = new Set(['reminder_72h', 'reminder_24h']);
const PACKET_EFFECT_TYPES = new Set(['completion_sms', 'completion_email', 'visit_payment']);
function effectTypeForKind(kind) {
  return EFFECT_TYPE_BY_KIND[kind] || 'tracker_arrived';
}
/**
 * Dedupe key for a visit-level effect. Tracker kinds keep the historical
 * `${visitId}:${effectType}` shape (existing prod rows must keep matching).
 * Reminder kinds carry the visit's DATE: a unit move to a new date yields a
 * new key, so the moved visit gets exactly one fresh reminder per tier —
 * without touching the move path's tracker-only effect deletions. Chosen
 * over a window-bearing key deliberately: membership churn recomputes the
 * visit window, and a window key would re-text customers on ordinary
 * joins/leaves. Consequence (documented divergence): a same-date retime
 * does not re-send an already-sent tier.
 */
function dedupeKeyFor(visit, effectType) {
  return REMINDER_EFFECT_TYPES.has(effectType)
    ? `${visit.id}:${effectType}:${dateOnly(visit.scheduled_date)}`
    : `${visit.id}:${effectType}`;
}

async function claimVisitNotification(row, kind) {
  if (!row || !row.visit_id) return null;
  const effectType = effectTypeForKind(kind);
  const packetEffect = PACKET_EFFECT_TYPES.has(effectType);
  const eligibleStatuses = packetEffect ? ['closing', 'closed'] : ['open'];
  const logger = require('./logger');
  const token = require('crypto').randomBytes(16).toString('hex');
  try {
    return await db.transaction(async (t) => {
      let visit = await t('service_visits').where({ id: row.visit_id }).first();
      if (!visit || !eligibleStatuses.includes(String(visit.status))) return { state: 'detached', token: null };
      await lockStop(t, visit.stop_base_key);
      // Re-read the parent AFTER the lock (codex #3603 r14): a whole-visit
      // reassignment / window recompute that committed while we waited
      // must be judged on the current parent, not the pre-lock snapshot.
      visit = await t('service_visits').where({ id: row.visit_id }).first();
      if (!visit || !eligibleStatuses.includes(String(visit.status))) return { state: 'detached', token: null };
      if (packetEffect) {
        const packet = await t('visit_completion_packets').where({ visit_id: visit.id }).first('id', 'status');
        if (!packet || !['processing', 'done'].includes(packet.status)) return { state: 'detached', token: null };
        const pending = await t('visit_completion_packet_items').where({ packet_id: packet.id }).whereNot('status', 'done').first('id');
        if (pending) return { state: 'in_flight', token: null };
      }
      // Full stop tuple, not just the id (codex r9): a same-day window move
      // whose detach seam has not run yet still carries the old visit_id.
      const fresh = await t('scheduled_services').where({ id: row.id }).forUpdate()
        .first('id', 'visit_id', 'technician_id', 'customer_id', 'property_id', 'scheduled_date', 'window_start', 'window_end');
      if (!fresh || String(fresh.visit_id || '') !== String(visit.id)) return { state: 'detached', token: null };
      // The visit owns assignment: a one-child reassignment that committed
      // ahead of its detach seam is a detached row (codex r12).
      if (visit.technician_id && String(fresh.technician_id || '') !== String(visit.technician_id)) return { state: 'detached', token: null };
      if (!rowStillAtVisitStop(fresh, visit, await otherLiveMembers(t, visit.id, fresh.id))) return { state: 'detached', token: null };
      // Fresh row ⇒ owner. Existing row: a `failed` (retryable provider
      // miss) is RECLAIMED — the retry the ledger promised (codex r6) — and
      // so is a STALE `claimed` row (a claim whose finalize failed or whose
      // process died: the claim is a short lease, codex r8). A live
      // `claimed` row is 'in_flight' (another member is sending — or the
      // lease has not expired yet): never send, never stamp covered, the
      // caller reports the stop incomplete and the next signal retries.
      // sent / suppressed ⇒ 'taken' (this row is covered).
      const leaseCutoff = new Date(Date.now() - NOTIFICATION_CLAIM_LEASE_MS);
      // Key computed from the POST-LOCK parent (reminder keys carry the
      // visit's date — a move that committed while we waited must claim
      // under the date it actually holds).
      const dedupeKey = dedupeKeyFor(visit, effectType);
      const rows = await t('visit_effects')
        .insert({
          visit_id: visit.id,
          effect_type: effectType,
          dedupe_key: dedupeKey,
          status: 'claimed',
          attempts: 0,
          claimed_at: new Date(),
          claim_token: token,
        })
        .onConflict(['visit_id', 'effect_type', 'dedupe_key'])
        .merge({ status: 'claimed', claimed_at: new Date(), claim_token: token })
        .where(function reclaimable() {
          this.where('visit_effects.status', '=', 'failed')
            .orWhere(function staleClaim() {
              this.where('visit_effects.status', '=', 'claimed').where('visit_effects.claimed_at', '<', leaseCutoff);
            });
        })
        .returning('id');
      if (rows && rows.length) return { state: 'owner', token, dedupeKey };
      const existing = await t('visit_effects')
        .where({ visit_id: visit.id, effect_type: effectType, dedupe_key: dedupeKey })
        .first('status');
      return { state: existing && String(existing.status) === 'claimed' ? 'in_flight' : 'taken', token: null, dedupeKey };
    });
  } catch (err) {
    logger.warn(`[visit-groups] notification claim ${effectType} for visit ${row.visit_id} failed: ${err.message}`);
    return { state: 'error', token: null };
  }
}

// The non-idempotent provider handoff is durable BEFORE sending a summary.
// An unknown result never becomes a reclaimable expired claim. A known
// pre-provider block can still finalize as retry/suppressed normally.
async function beginVisitNotificationDispatch(visitId, kind, token, { dedupeKey = null } = {}) {
  const effectType = effectTypeForKind(kind);
  if (!PACKET_EFFECT_TYPES.has(effectType) || !token) return false;
  const rows = await db('visit_effects').where({ visit_id: visitId, effect_type: effectType,
    dedupe_key: dedupeKey || `${visitId}:${effectType}`, claim_token: token,
  }).where(function owned() {
    this.where('status', 'unknown_delivery').orWhere(function liveClaim() {
      this.where('status', 'claimed').where('claimed_at', '>', new Date(Date.now() - NOTIFICATION_CLAIM_LEASE_MS));
    });
  }).update({ status: 'unknown_delivery', claimed_at: db.fn.now(), updated_at: db.fn.now() }).returning('id');
  return rows.length > 0;
}

/**
 * Row's current stop tuple (date, customer, property) still matches the
 * visit AND its window still connects to the visit's OTHER live members —
 * the same rule handleChildStopChanged applies (codex #3603 r11): a row
 * moved inside the stale union but away from every sibling is a separate
 * stop. Windowless rows, and rows with no windowed siblings, connect.
 */
function rowStillAtVisitStop(row, visit, otherMembers = []) {
  if (dateOnly(row.scheduled_date) !== dateOnly(visit.scheduled_date)
      || String(row.customer_id) !== String(visit.customer_id)
      || String(row.property_id || '') !== String(visit.property_id || '')) return false;
  if (!row.window_start) return true;
  // Only siblings that are themselves still at the stop count as anchors
  // (same tuple, window inside the visit's recorded union) — a sibling
  // that moved away must not make the unmoved row look detached.
  const anchors = (otherMembers || []).filter((m) => m && m.window_start
    && (m.scheduled_date == null || dateOnly(m.scheduled_date) === dateOnly(visit.scheduled_date))
    && (m.customer_id == null || String(m.customer_id) === String(visit.customer_id))
    && (m.property_id == null || String(m.property_id || '') === String(visit.property_id || ''))
    && windowsOverlap(m.window_start, m.window_end, visit.window_start, visit.window_end));
  if (!anchors.length) return windowsOverlap(row.window_start, row.window_end, visit.window_start, visit.window_end);
  return anchors.some((m) => windowsOverlap(row.window_start, row.window_end, m.window_start, m.window_end));
}

/** Non-terminal members of a visit other than `rowId`, with their stop tuple + windows (for connectivity checks). */
async function otherLiveMembers(t, visitId, rowId) {
  return t('scheduled_services').where({ visit_id: visitId }).whereNot('id', rowId)
    .whereNotIn('status', TERMINAL_ROW_STATUSES)
    .select('id', 'customer_id', 'property_id', 'scheduled_date', 'window_start', 'window_end');
}

/**
 * Advance the claimed ledger row with the owner's ACTUAL attempt outcome
 * (codex r4/r5): sent / suppressed / failed; attempts counted; a sent row
 * is never downgraded. Non-attempt outcomes are a no-op. Its own checked
 * step: a failure here leaves the row `claimed`, so the caller reports the
 * stop incomplete instead of advertising a status that was never written.
 */
async function finalizeVisitNotification(visitId, kind, smsOutcome, at = new Date(), token = null, { dedupeKey = null } = {}) {
  const effectType = effectTypeForKind(kind);
  if (!visitId || !NOTIFICATION_ATTEMPT_OUTCOMES.has(String(smsOutcome))) return { ok: true, skipped: true, effectType, status: null };
  const status = smsOutcome === 'sent' ? 'sent' : smsOutcome === 'retry' ? 'failed' : 'suppressed';
  // Reminder kinds MUST pass the claim's key (it carries the visit date);
  // tracker call sites keep the historical default untouched.
  const key = dedupeKey || `${visitId}:${effectType}`;
  try {
    return await db('visit_effects')
      .insert({
        visit_id: visitId,
        effect_type: effectType,
        dedupe_key: key,
        status,
        attempts: 1,
        sent_at: status === 'sent' ? at : null,
      })
      .onConflict(['visit_id', 'effect_type', 'dedupe_key'])
      .merge({
        status,
        attempts: db.raw('?? + 1', ['visit_effects.attempts']),
        sent_at: status === 'sent' ? at : null,
        updated_at: at,
      })
      .where('visit_effects.status', '<>', 'sent')
      // Only the current claim owner finalizes (codex r10): a stale owner's
      // late finalize never clobbers a reclaimer's row.
      .modify((q) => { if (token) q.where('visit_effects.claim_token', '=', token); })
      .returning('id')
      .then(async (rows) => {
        if (rows && rows.length) return { ok: true, effectType, status };
        // Zero rows finalized (pre-push codex P1): either the row is
        // already durably `sent` (finalize is then a no-op success), or
        // ownership changed under us — report ok:false so the caller runs
        // its durable fallback instead of assuming the ledger advanced.
        const current = await db('visit_effects')
          .where({ visit_id: visitId, effect_type: effectType, dedupe_key: key })
          .first('status');
        if (current && String(current.status) === 'sent') return { ok: true, effectType, status: 'sent', alreadyFinal: true };
        return { ok: false, effectType, status, reason: 'claim not finalized (ownership changed)' };
      });
  } catch (err) {
    require('./logger').warn(`[visit-groups] visit ${visitId} ${kind}: visit_effects finalize failed: ${err.message}`);
    return { ok: false, effectType, status, reason: `effect finalize failed: ${err.message}` };
  }
}

const NOTIFICATION_ATTEMPT_OUTCOMES = new Set(['sent', 'suppressed', 'retry', 'gate_off']);
// A claim is a lease: a `claimed` row older than this is reclaimable (its
// owner's finalize failed or its process died). Sized well above any
// plausible send (a multi-contact Twilio loop takes seconds, not minutes);
// the owner also re-checks its lease right before the provider call
// (notificationLeaseLive) so a stalled sender never fires after a reclaim
// (codex #3603 r9). No provider-level idempotency exists for SMS.
const NOTIFICATION_CLAIM_LEASE_MS = 10 * 60 * 1000;

/**
 * Atomically RENEW the owner's lease (claimed_at = now) — succeeds only
 * while the row is still `claimed` under OUR token (codex #3603 r12). The
 * owner calls this immediately before its provider call so ownership stays
 * valid through the send even if the preceding work ate the lease; a
 * reclaim (new token) or a terminal row makes this fail — do not send.
 */
async function renewNotificationLease(visitId, kind, token, { dedupeKey = null } = {}) {
  if (!visitId || !token) return false;
  const effectType = effectTypeForKind(kind);
  try {
    const n = await db('visit_effects')
      .where({ visit_id: visitId, effect_type: effectType, dedupe_key: dedupeKey || `${visitId}:${effectType}`, status: 'claimed', claim_token: token })
      .update({ claimed_at: new Date() });
    return Number(n) > 0;
  } catch (err) {
    require('./logger').warn(`[visit-groups] lease renew ${effectType} for visit ${visitId} failed: ${err.message}`);
    return false;
  }
}

/**
 * Is the owner's claim still live (status claimed, inside the lease)? Used
 * before slow pre-send work; the send itself is guarded by
 * renewNotificationLease.
 */
async function notificationLeaseLive(visitId, kind, token, { dedupeKey = null } = {}) {
  if (!visitId || !token) return false;
  const effectType = effectTypeForKind(kind);
  try {
    const row = await db('visit_effects')
      .where({ visit_id: visitId, effect_type: effectType, dedupe_key: dedupeKey || `${visitId}:${effectType}` })
      .first('status', 'claimed_at', 'claim_token');
    // Ours, still claimed, inside the lease — a reclaim replaced the token.
    return Boolean(row && String(row.status) === 'claimed' && row.claimed_at
      && String(row.claim_token || '') === String(token)
      && (Date.now() - new Date(row.claimed_at).getTime()) < NOTIFICATION_CLAIM_LEASE_MS);
  } catch (err) {
    require('./logger').warn(`[visit-groups] lease check ${effectType} for visit ${visitId} failed: ${err.message}`);
    return false;
  }
}

async function fanOutLiveTransition({ primary, kind, actorType = 'tech', actorId = null, smsOutcome = null, notificationOwner = false, claimToken = null }) {
  const toStatus = kind === 'en_route' ? 'en_route' : kind === 'on_site' ? 'on_site' : null;
  if (!primary || !primary.visit_id || !toStatus) return null;
  const targetTrack = kind === 'en_route' ? 'en_route' : 'on_property';
  const logger = require('./logger');
  const lifecycleAt = new Date();
  let fan = null;
  try {
    fan = await db.transaction(async (t) => {
      let visit = await t('service_visits').where({ id: primary.visit_id }).first();
      if (!visit || String(visit.status) !== 'open') return null;
      await lockStop(t, visit.stop_base_key);
      // Re-read the parent after the lock (codex r14) — see claimVisitNotification.
      visit = await t('service_visits').where({ id: primary.visit_id }).first();
      if (!visit || String(visit.status) !== 'open') return null;
      // Revalidate the PRIMARY under the stop lock (codex #3603 r2): a split
      // or stop change can detach it between the tracker's row load and
      // this lock — the tracker CAS does not predicate on visit_id. Only a
      // primary that is still this visit's member, on the same technician,
      // and actually at the target status leads its siblings.
      const lockedPrimary = await t('scheduled_services').where({ id: primary.id }).forUpdate()
        .first('id', 'visit_id', 'technician_id', 'status', 'customer_id', 'property_id', 'scheduled_date', 'window_start', 'window_end');
      if (!lockedPrimary
          || String(lockedPrimary.visit_id || '') !== String(visit.id)
          || String(lockedPrimary.technician_id || '') !== String(primary.technician_id || '')
          || (visit.technician_id && String(lockedPrimary.technician_id || '') !== String(visit.technician_id))
          || !rowStillAtVisitStop(lockedPrimary, visit, await otherLiveMembers(t, visit.id, lockedPrimary.id))) {
        logger.warn(`[visit-groups] ${kind} fan-out for ${primary.id}: primary no longer leads visit ${visit.id} (visit=${lockedPrimary && lockedPrimary.visit_id}) — skipped`);
        return null;
      }
      if (String(lockedPrimary.status) !== toStatus) {
        // Still a member but its operational status lags the tracker (an
        // automatic caller's best-effort status sync failed): NOT benign —
        // nothing moved, the caller must report the stop incomplete (r6).
        logger.warn(`[visit-groups] ${kind} fan-out for ${primary.id}: primary status ${lockedPrimary.status} lags target ${toStatus} — incomplete`);
        return { incomplete: 'primary_status_lagging' };
      }
      const siblings = await t('scheduled_services')
        .where({ visit_id: visit.id })
        .whereNot('id', primary.id)
        .whereNotIn('status', TERMINAL_ROW_STATUSES)
        .forUpdate()
        .select('id', 'status', 'technician_id', 'track_state', 'source_action', 'customer_confirmed',
          'customer_id', 'property_id', 'scheduled_date', 'window_start', 'window_end',
          'actual_start_time', 'check_in_time', 'arrived_at');
      const { transitionJobStatus } = require('./job-status');
      const { isPendingOutboundReviewBooking } = require('./call-booking-source-actions');
      const moved = [];
      const trackers = [];
      const covered = [];
      const skipped = [];
      // The stop = the primary's CONNECTED COMPONENT over member windows
      // (codex r8): 09-10 · 10-11 · 11-12 is one stop even though 11-12
      // never touches the tapped 09-10 row — the same chain rule
      // windowedMembersConnected applies at creation. Windowless members
      // join anything. Only same-tuple, same-tech members can chain.
      const sameStopTuple = (s) => dateOnly(s.scheduled_date) === dateOnly(visit.scheduled_date)
        && String(s.customer_id) === String(visit.customer_id)
        && String(s.property_id || '') === String(visit.property_id || '')
        && String(s.technician_id || '') === String(primary.technician_id || '');
      // Bridges are WINDOWED, join-eligible members only — a windowless row
      // joins the stop but never links two disjoint windows (mirrors
      // windowedMembersConnected), and a withdrawn/terminal row bridges
      // nothing.
      const component = new Set([lockedPrimary.id]);
      // A WINDOWLESS primary is join-only, never a link (codex r9): seed the
      // bridges from the windowed, join-eligible siblings instead — but only
      // when they form ONE chain among themselves; two chains would be
      // ambiguous, so nothing follows and the office resolves it.
      let bridges;
      if (lockedPrimary.window_start) {
        bridges = [lockedPrimary];
      } else {
        const windowed = siblings.filter((s) => s.window_start && sameStopTuple(s) && !JOIN_INELIGIBLE_STATUSES.includes(String(s.status || '')));
        if (!windowed.length) {
          // An all-windowless (explicitly grouped) visit is ONE stop by
          // definition (codex r10): every same-tuple sibling is a member.
          siblings.filter(sameStopTuple).forEach((s) => component.add(s.id));
          bridges = [];
        } else {
          bridges = windowedMembersConnected(windowed) ? windowed.slice() : [];
          if (!bridges.length) logger.warn(`[visit-groups] ${kind} fan-out for ${primary.id}: windowless primary, siblings form more than one chain — nothing follows`);
        }
      }
      let grew = true;
      while (grew) {
        grew = false;
        for (const s of siblings) {
          if (component.has(s.id) || !sameStopTuple(s)) continue;
          if (bridges.some((m) => windowsOverlap(s.window_start, s.window_end, m.window_start, m.window_end))) {
            component.add(s.id);
            if (s.window_start && !JOIN_INELIGIBLE_STATUSES.includes(String(s.status || ''))) bridges.push(s);
            grew = true;
          }
        }
      }
      for (const s of siblings) {
        // Exact technician equality — an unassigned sibling is NOT the
        // primary's tech's to advance (codex r1): the visit owns assignment,
        // so a null here is an inconsistency to surface, not a wildcard.
        if (String(s.technician_id || '') !== String(primary.technician_id || '')) {
          skipped.push({ id: s.id, reason: 'technician' });
          continue;
        }
        // Stop identity revalidated on the LOCKED row (codex r6): a
        // reschedule that committed before its post-commit detach seam ran
        // still carries the old visit_id — never advance a row that is no
        // longer physically at this stop.
        // Stop identity (r6/r7/r8): a row outside the primary's connected
        // component — date/customer/property changed, or its window no
        // longer chains to the stop — is a separate stop, whatever its stale
        // visit_id still says.
        if (!component.has(s.id)) {
          skipped.push({ id: s.id, reason: 'stop_changed' });
          continue;
        }
        if (String(s.status) !== toStatus) {
          if (!siblingEligibleFor(toStatus, s.status)) { skipped.push({ id: s.id, reason: `status:${s.status}` }); continue; }
          // An office-review booking needs the tech's explicit field-confirm
          // stamp + activation (tech-track's autoConfirmOutboundReviewBooking)
          // before a day-of advance — never implied by a sibling's tap. It
          // stays behind for its own tap (fail closed: no silent activation).
          if (isPendingOutboundReviewBooking(s)) { skipped.push({ id: s.id, reason: 'office_review' }); continue; }
          if (toStatus === 'on_site') {
            const { buildOnSiteLifecycleUpdates } = require('../utils/service-duration-capture');
            const updates = buildOnSiteLifecycleUpdates(s, lifecycleAt);
            if (Object.keys(updates).length) await t('scheduled_services').where({ id: s.id }).update(updates);
          }
          await transitionJobStatus({ jobId: s.id, fromStatus: s.status, toStatus, transitionedBy: actorId, trx: t });
          moved.push(s.id);
        }
        covered.push(s.id);
        if (String(s.track_state || '') !== targetTrack) trackers.push(s.id);
      }
      const stampCol = toStatus === 'en_route' ? 'en_route_at' : 'arrived_at';
      await t('service_visits').where({ id: visit.id }).whereNull(stampCol).update({ [stampCol]: lifecycleAt });
      return { visitId: visit.id, visitDate: dateOnly(visit.scheduled_date), moved, trackers, covered, skipped };
    });
  } catch (err) {
    // Surfaced, not swallowed (codex #3603 r2): the caller reports the
    // stop as NOT fully synced; the next signal (re-tap / Sync Stop /
    // automatic arrival) re-runs this idempotently.
    logger.warn(`[visit-groups] ${kind} fan-out for ${primary.id} (visit ${primary.visit_id}) failed: ${err.message}`);
    return { ok: false, visitId: primary.visit_id, reason: err.message, siblingIds: [], trackerIds: [], skipped: [] };
  }
  if (!fan) return null;
  if (fan.incomplete) return { ok: false, visitId: primary.visit_id, reason: fan.incomplete, siblingIds: [], trackerIds: [], skipped: [] };

  // Tracker writes for lagging siblings — customer text suppressed (the one
  // text came from the primary). _visitSibling stops the tracker from
  // fanning out again from inside the fan-out.
  const trackTransitions = require('./track-transitions');
  // Collected, not just logged (codex #3603 r3): a sibling whose tracker
  // write failed after the status commit leaves a stale customer-visible
  // tracker with every operational status already matching — the caller
  // must report the stop as not fully synced so the next signal repairs it.
  const trackerFailures = [];
  for (const id of fan.trackers) {
    try {
      // Expected-state fence (codex r9): the tracker refuses a sibling that
      // a reschedule rewound / detached between the fan-out transaction and
      // this write (sibling_state_changed), instead of advancing the new
      // attempt with messaging suppressed.
      const expect = { visitId: fan.visitId, scheduledDate: fan.visitDate, status: toStatus };
      const r = kind === 'en_route'
        ? await trackTransitions.markEnRoute(id, { actorType, actorId, suppressCustomerSms: true, _visitSibling: true, expect })
        : await trackTransitions.markOnProperty(id, { actingTechId: actorId, actorType, actorId, suppressArrivalSms: true, _visitSibling: true, expect });
      if (!r || !r.ok) {
        trackerFailures.push({ id, reason: (r && r.reason) || 'tracker returned ok=false' });
        logger.warn(`[visit-groups] visit ${fan.visitId} ${kind}: tracker write for sibling ${id} returned ${r && r.reason}`);
      }
    } catch (err) {
      trackerFailures.push({ id, reason: err.message });
      logger.warn(`[visit-groups] visit ${fan.visitId} ${kind}: tracker write for sibling ${id} failed: ${err.message}`);
    }
  }
  // Covered-by-visit stamps on every reconciled sibling (whereNull ⇒
  // idempotent): no later per-row path re-texts the customer.
  const smsCol = kind === 'en_route' ? 'track_sms_sent_at' : 'arrival_sms_sent_at';
  // Siblings are stamped covered ONLY when the visit notice is terminally
  // handled (codex #3603 r13): after a retryable provider failure the effect
  // is `failed` and reclaimable — a sibling's later signal must still reach
  // claimVisitNotification, so its guard stays open. Claim-state outcomes
  // (in flight / error / lease expired / not attempted) likewise leave the
  // siblings to the owner's own reconciliation.
  let noticeHandled = ['sent', 'suppressed', 'gate_off', 'already_handled', 'covered'].includes(String(smsOutcome));
  if (noticeHandled && String(smsOutcome) === 'already_handled') {
    // The primary's guard being stamped does not prove the VISIT notice was
    // delivered (codex r14: a retryable arrival miss whose guard release
    // failed leaves the guard stamped while the effect is `failed`). Only a
    // terminal effect — or no visit effect at all (legacy per-row send) —
    // covers the siblings.
    try {
      const effectType0 = effectTypeForKind(kind);
      const eff = await db('visit_effects')
        .where({ visit_id: fan.visitId, effect_type: effectType0, dedupe_key: `${fan.visitId}:${effectType0}` })
        .first('status');
      noticeHandled = !eff || ['sent', 'suppressed'].includes(String(eff.status));
    } catch (err) {
      noticeHandled = false;
      logger.warn(`[visit-groups] visit ${fan.visitId} ${kind}: effect status read failed: ${err.message}`);
    }
  }
  if (fan.covered.length && noticeHandled) {
    try {
      // Fenced to THIS visit attempt (codex r5): a sibling force-rescheduled
      // after the transaction (guards cleared, new date, new row identity)
      // must not be stamped covered by its old stop.
      await db('scheduled_services')
        .whereIn('id', fan.covered)
        .where({ visit_id: fan.visitId })
        .where('scheduled_date', fan.visitDate)
        .where('track_state', targetTrack)
        .whereNull(smsCol)
        .update({ [smsCol]: lifecycleAt });
    } catch (err) {
      // A sibling left without its covered stamp could still text later
      // (codex r4) — that is an incomplete stop, reported as such.
      trackerFailures.push({ id: 'covered_stamp', reason: err.message });
      logger.warn(`[visit-groups] visit ${fan.visitId} ${kind}: covered-by-visit stamp failed: ${err.message}`);
    }
  }
  // The visit's one-shot ledger row, advanced ONLY by the notification
  // owner's actual attempt (codex r4/r5) — its own checked step.
  const recordEffect = notificationOwner && NOTIFICATION_ATTEMPT_OUTCOMES.has(String(smsOutcome));
  let effect = null;
  if (recordEffect) {
    const fin = await finalizeVisitNotification(fan.visitId, kind, smsOutcome, lifecycleAt, claimToken);
    if (fin.ok) effect = { effectType: fin.effectType, status: fin.status };
    else trackerFailures.push({ id: 'effect_finalize', reason: fin.reason });
  }
  // Structural skips (stop tuple / technician no longer match the visit)
  // mean a detach seam did not run — repair membership durably NOW through
  // the canonical seam (codex r14); a row that still is not detached
  // afterwards is an incomplete stop (alert / 409), never silent success.
  for (const x of fan.skipped.filter((k) => k.reason === 'technician' || k.reason === 'stop_changed')) {
    try {
      const detached = await handleChildStopChanged(x.id);
      if (!detached) trackerFailures.push({ id: x.id, reason: `structural_skip_unrepaired:${x.reason}` });
    } catch (err) {
      trackerFailures.push({ id: x.id, reason: `structural_skip_repair_failed:${err.message}` });
    }
  }
  if (fan.skipped.length) {
    logger.warn(`[visit-groups] visit ${fan.visitId} ${kind}: ${fan.skipped.length} sibling(s) left as-is: ${fan.skipped.map((x) => `${x.id}=${x.reason}`).join(',')}`);
  }
  const base = { visitId: fan.visitId, siblingIds: fan.moved, trackerIds: fan.trackers, skipped: fan.skipped, effect };
  if (trackerFailures.length) {
    return { ...base, ok: false, trackerFailures, reason: `tracker write failed for ${trackerFailures.map((f) => `${f.id}: ${f.reason}`).join('; ')}` };
  }
  return { ...base, ok: true };
}

/**
 * Attach a shared `visit` summary to every row of a schedule payload that
 * carries a visitId (pure; mutates the rows). Consumers (tech home, dispatch
 * board) render one grouped card from it. Ungrouped rows are untouched.
 */
function visitSummariesForRows(rows, {
  idKey = 'visitId', memberIdKey = 'id', durationKey = 'estimatedDuration', statusKey = 'status',
} = {}) {
  const byVisit = new Map();
  for (const r of rows || []) {
    const v = r && r[idKey];
    if (!v) continue;
    if (!byVisit.has(v)) byVisit.set(v, []);
    byVisit.get(v).push(r);
  }
  for (const [visitId, members] of byVisit) {
    const live = members.filter((m) => !TERMINAL_ROW_STATUSES.includes(String(m[statusKey] || '')));
    const summary = {
      id: visitId,
      serviceCount: members.length,
      memberIds: members.map((m) => m[memberIdKey]),
      primaryId: (live[0] || members[0])[memberIdKey],
      estimatedDuration: members.reduce((acc, m) => acc + (Number(m[durationKey]) || 0), 0),
      serviceTypes: members.map((m) => m.serviceType || m.service_type).filter(Boolean),
      liveCount: live.length,
    };
    for (const m of members) m.visit = summary;
  }
  return byVisit;
}

// ---- R3: moving one grouped row moves the group (doc §2, ruled rev 5) ------
// THE shared last-moment send guard for appointment notices (codex r47 —
// one implementation for the SMS canonical path and the appointment-email
// path, never two drifting copies). True = do not send:
//   1. a LIVE move_hold_until on the row's reminder record;
//   2. renderedSlotMs (the epoch of the slot the body quotes) matching
//      neither the row's promised arrival nor the grouped stop's canonical start;
//   3. the hold RE-READ after the slot/visit awaits — a mover can claim
//      between the first hold read and those queries, with the row still
//      showing the pre-move slot.
// Fail closed on any read error.
async function appointmentSendHeld(scheduledServiceId, renderedSlotMs = null) {
  if (!scheduledServiceId) return false;
  const logger = require('./logger');
  try {
    const holdLive = async () => {
      const row = await db('appointment_reminders')
        .where({ scheduled_service_id: scheduledServiceId })
        .first('move_hold_until');
      return !!(row && row.move_hold_until && new Date(row.move_hold_until).getTime() > Date.now());
    };
    if (await holdLive()) return true;
    if (Number.isFinite(renderedSlotMs)) {
      const live = await db('scheduled_services')
        .where({ id: scheduledServiceId })
        .first('id', 'reservation_service_mix', 'scheduled_date', 'window_start', 'visit_id');
      if (!live || !live.scheduled_date) return true; // row gone/stale — never send the old slot
      const { parseETDateTime, etCalendarDayOf } = require('../utils/datetime-et');
      const day = etCalendarDayOf(live.scheduled_date);
      const toMs = (hhmm) => {
        const at = parseETDateTime(`${day}T${hhmm || '08:00'}`);
        return at && !Number.isNaN(at.getTime()) ? at.getTime() : null;
      };
      const arrivalStart = await require('./reservation-arrival').arrivalStartForService(db, live);
      const candidates = [toMs(arrivalStart ? String(arrivalStart).slice(0, 5) : null)];
      if (live.visit_id) {
        const stopStart = await liveStopStartHHMM(db, live.visit_id);
        if (stopStart) candidates.push(toMs(stopStart));
      }
      if (!candidates.some((ms) => ms !== null && ms === renderedSlotMs)) return true;
      // The slot/visit reads above are awaits a mover can slip behind while
      // the row still shows the pre-move slot — the hold is checked LAST.
      if (await holdLive()) return true;
    }
    return false;
  } catch (err) {
    logger.warn(`[visit-groups] appointment send-hold check failed for ${scheduledServiceId} — send held: ${err.message}`);
    return true;
  }
}

// The staff repair message for an INCOMPLETE unit move (codex r44): a
// straggler still at the old slot, a member that MOVED but could not be
// reassigned (fixing its assignment, not re-moving it), and a failed
// parent retarget each need different guidance — one builder so the
// dispatch and rain-out responses never drift.
function incompleteMoveMessage(failedEntries = [], parentRetargetFailed = false) {
  const stragglers = failedEntries.filter((f) => f.movedButUnassigned !== true);
  const unassigned = failedEntries.filter((f) => f.movedButUnassigned === true);
  const parts = [];
  if (stragglers.length) parts.push(`${stragglers.length} grouped service(s) are still on the old day/time — fix the stragglers on the board`);
  if (unassigned.length) parts.push(`${unassigned.length} service(s) moved to the new time but could not be reassigned to the technician — fix their assignment on the board (they are NOT at the old time)`);
  if (!parts.length || parentRetargetFailed) parts.push('the visit record still describes the old stop — re-save the stop from the board');
  return `Only part of this stop finished moving: ${parts.join('; ')}. Then text the customer.`;
}

// The grouped stop's canonical start (earliest live member's HH:MM) — the
// value grouped customer copy quotes (rain-out, the appointment page).
// Shared by the last-moment notice checks so a LATER chained member's own
// start never fails a comparison against the stop start (codex r40).
async function liveStopStartHHMM(conn, visitId) {
  if (!visitId) return null;
  const members = await conn('scheduled_services')
    .where({ visit_id: visitId })
    .whereNotIn('status', TERMINAL_ROW_STATUSES)
    .select('window_start');
  const starts = members.map((m) => (m.window_start ? String(m.window_start).slice(0, 5) : null)).filter(Boolean).sort();
  return starts[0] || null;
}

// Ensure a member has a reminder row a hold can live on (shared by the
// unit-move claim and createOrJoinVisit's join-inherit — codex r35): a
// WINDOWED member gets an ARMED registration (normal 72h/24h once any hold
// clears), a windowless one the pre-closed 08:00 placeholder. Returns the
// row (or null when the member has no usable schedule).
async function ensureMemberReminderRowInTx(t, memberId) {
  const row = await t('scheduled_services').where({ id: memberId })
    .first('customer_id', 'scheduled_date', 'window_start', 'service_type', 'created_at');
  if (!row || !row.customer_id || !row.scheduled_date) return null;
  const AppointmentReminders = require('./appointment-reminders');
  if (row.window_start) {
    return AppointmentReminders.registerVisitReminderInTx(t, {
      scheduledServiceId: memberId,
      customerId: row.customer_id,
      appointmentTime: `${dateOnly(row.scheduled_date)}T${String(row.window_start).slice(0, 5)}`,
      serviceType: row.service_type || 'service',
      source: 'unit_move_hold',
      createdAt: row.created_at,
    });
  }
  const { parseETDateTime } = require('../utils/datetime-et');
  const stubTime = parseETDateTime(`${dateOnly(row.scheduled_date)}T08:00`);
  if (!stubTime || Number.isNaN(stubTime.getTime())) return null;
  return AppointmentReminders.insertPreClosedPlaceholderRowInTx(t, {
    scheduledServiceId: memberId, customerId: row.customer_id, apptTime: stubTime,
    serviceLabel: row.service_type || 'service', source: 'unit_move_hold', createdAt: row.created_at,
  });
}

// Durable reminder send hold for grouped unit moves. TTL is the
// self-expiry (a forgotten repair can never silence a customer forever);
// the takeover grace is the lease window inside which an ACTIVE stamp is
// presumed to belong to a live concurrent mover (a move completes in
// seconds) — older active stamps are retained partial-move holds a repair
// move may take over (codex r30 P1). Stamp time is until − TTL, so the
// TTL must never change without considering in-flight stamps.
const MOVE_HOLD_TTL_MS = 24 * 60 * 60 * 1000;
const MOVE_HOLD_TAKEOVER_AFTER_MS = 5 * 60 * 1000;

/**
 * Claim the durable reminder SEND HOLD for a cohort of rows inside the
 * caller's transaction (the unit mover's claim, extracted so the office
 * Combine — which moves ungrouped rows one rebooker commit at a time —
 * holds its cohort the same way; GH codex #3843 r1 P1). FOR UPDATE +
 * the live-lease refusal + a held placeholder for every member without a
 * reminder row; returns the reminder row ids stamped. The caller owns the
 * stop lock and the expiry/token it passes.
 */
async function claimReminderHoldInTx(t, holdMemberIds, { holdUntil, holdToken }) {
  const holdRows = await t('appointment_reminders')
    .whereIn('scheduled_service_id', holdMemberIds)
    .forUpdate()
    .select('id', 'scheduled_service_id', 'move_hold_until');
  // Foreign-hold refusal is a LEASE with a takeover grace (codex r30
  // P1): a stamp inside the grace belongs to a LIVE concurrent mover
  // (a move completes in seconds) and is refused. An OLDER active
  // stamp is a RETAINED hold — a partial move / failed retarget kept
  // it so nobody texts until staff repair the stop — and the repair
  // move the needsAttention alert asks for IS such a new mover: it
  // takes the lease over (FOR UPDATE above serializes rival repairs;
  // the re-stamp below replaces the old stamp, so the finished
  // repair's fenced release clears it). Without the takeover every
  // repair 503'd until the 24h expiry. Stamp time is derivable:
  // every stamp is written as now + MOVE_HOLD_TTL_MS.
  const foreign = holdRows.find((r) => {
    if (!r.move_hold_until) return false;
    const until = new Date(r.move_hold_until).getTime();
    if (until <= Date.now()) return false; // expired
    const stampedAt = until - MOVE_HOLD_TTL_MS;
    return Date.now() - stampedAt < MOVE_HOLD_TAKEOVER_AFTER_MS; // live mover
  });
  if (foreign) {
    throw Object.assign(new Error('another move of this stop is still in progress — try again shortly'), { code: 'VISIT_MOVE_HOLD_ACTIVE' });
  }
  // A member with NO reminder row gets a HELD pre-closed placeholder
  // (codex r29 P1): the lease must exist durably for every member —
  // a self-heal or inline registration mid-move would otherwise create
  // an unheld row with no held sibling to inherit from. The placeholder
  // mechanism is the repo's own (all send legs closed in one INSERT;
  // the sync trigger re-arms it when a real slot lands — carrying our
  // stamp, so the re-armed row stays quiet until release/expiry), and
  // its per-service idempotency means a racing registration finds the
  // row instead of inserting a rival.
  const coveredMemberIds = new Set(holdRows.map((r) => String(r.scheduled_service_id)));
  const stubIds = [];
  for (const memberId of holdMemberIds.filter((id) => !coveredMemberIds.has(id))) {
    const rec = await ensureMemberReminderRowInTx(t, memberId);
    if (rec && rec.id) stubIds.push(rec.id);
  }
  const allIds = [...holdRows.map((r) => r.id), ...stubIds];
  if (!allIds.length) return [];
  await t('appointment_reminders').whereIn('id', allIds)
    .update({ move_hold_until: holdUntil, move_hold_token: holdToken });
  return allIds;
}

// Release a cohort hold, fenced on its own token (a newer mover's stamp
// is never cleared). Throws on failure — callers decide (the safe
// direction is leaving the rows quiet until the stamp expires).
async function releaseReminderHoldByToken(holdToken) {
  await db('appointment_reminders')
    .where({ move_hold_token: holdToken })
    .update({ move_hold_until: null, move_hold_token: null });
}

const UNIT_MOVE_STATUSES = new Set(['pending', 'confirmed', 'rescheduled']);
const UNIT_MOVE_LIVE_STATUSES = new Set(['en_route', 'on_site']);

function shiftClock(hhmm, deltaMin) {
  const m = toMinutes(hhmm);
  if (m == null || !Number.isFinite(deltaMin)) return hhmm || null;
  const v = ((m + deltaMin) % 1440 + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

/**
 * Move a grouped row's WHOLE visit as one unit (R3): called by
 * SmartRebooker.reschedule / rescheduleSeries before their own work for a
 * row that carries a visit_id and no visitPolicy:'single'. "Just this
 * service" is the explicit split action (splitChild), never a flag here.
 *
 * Order (codex #3609 r1 — nothing is committed for the visit before the
 * tapped row itself has moved):
 * 1. PLAN, read-only, peek → stop lock → verify key → retry: re-read the
 *    open visit and its live members, refuse if ANY member is not movable
 *    or no longer at the stop (409), compute every member's target (same
 *    date; windows shifted by the primary's start delta; a member already
 *    at the target is skipped — a route-wide batch that reaches the visit
 *    through a second member is a no-op, not a second move) and a
 *    per-member concurrency fence from the LOCKED row (the caller's pins
 *    describe only the primary).
 * 2. MOVE the primary with the caller's own options, then each sibling with
 *    its own fence, visitPolicy:'single' (no recursion), skipVisitSeam
 *    (the detach seam runs once at the end — per member it would detach
 *    the first mover from siblings still on the old stop) and the member
 *    ids excluded from both occupancy probes. Each member keeps its own
 *    series semantics. The primary failing rethrows — nothing has moved.
 * 3. RETARGET the parent from the members' ACTUAL rows under BOTH stop
 *    locks taken in sorted key order: date, window union of the rows that
 *    landed, new stop key + seq, the caller's technician (incl. an explicit
 *    null = whole-visit unassignment), and — on a date change or a live
 *    move — a lifecycle reset (en_route_at / arrived_at cleared, tracker
 *    effects removed so the new day's notices re-arm).
 * 4. Detach seam for every member (a sibling that failed stays behind,
 *    detached), then the union is recomputed.
 * Warnings from every member are aggregated; a failed sibling is reported
 * in visitMove.failed and as a warning for the operator.
 */
// Does a live row satisfy a rebooker-style `expect` predicate? Same
// semantics as the rebooker's `.where(options.expect)` CAS, evaluated in JS:
// dates by day, clocks by HH:MM, everything else by null-safe string
// equality; a key the row does not carry fails (closed).
function expectMatchesRow(row, expect) {
  if (!row) return false;
  const norm = (v) => (v == null || v === '' ? null : String(v).slice(0, 5));
  for (const [key, want] of Object.entries(expect || {})) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) return false;
    const have = row[key];
    if (key === 'scheduled_date') { if (dateOnly(have) !== dateOnly(want)) return false; continue; }
    if (key === 'window_start' || key === 'window_end') { if (norm(have) !== norm(want)) return false; continue; }
    if ((have == null) !== (want == null)) return false;
    if (have != null && String(have) !== String(want)) return false;
  }
  return true;
}

async function moveVisitAsUnit({ rebooker, serviceId, service, newDate, newWindow, reason, initiatedBy, options = {} }) {
  if (!rebooker || !service || !service.visit_id) return null;
  const logger = require('./logger');
  const allowLive = options.allowLive === true;
  const movable = (st) => UNIT_MOVE_STATUSES.has(String(st)) || (allowLive && UNIT_MOVE_LIVE_STATUSES.has(String(st)));
  const win = typeof newWindow === 'object' && newWindow ? { start: newWindow.start || null, end: newWindow.end || null }
    : (() => { const m = String(newWindow || '').match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/); return m ? { start: m[1], end: m[2] } : { start: null, end: null }; })();
  const newDateStr = dateOnly(newDate);

  // ---- 1. plan (read-only) ----
  let plan = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // A visit that is not open and not dissolved (closing, or any future
      // state) is REFUSED, never declined to the rebooker's single-row path
      // (local gate P0 r36): its packet / issued link / records / payment
      // still describe this stop, and the detach seam ignores non-open
      // visits — a child moved alone would leave those artifacts behind.
      // Dissolved = the rows are free (the dissolver nulls visit_id; a stale
      // pointer is effectively ungrouped) ⇒ null, the single path.
      const refuseNotOpen = (status) => {
        throw Object.assign(new Error('Cannot move this stop: the visit is being finalized — finish it, or contact the office to move it.'), { statusCode: 409, code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', isOperational: true, reason: 'visit_not_open', visitStatus: String(status) });
      };
      plan = await db.transaction(async (t) => {
        const peek = await t('service_visits').where({ id: service.visit_id }).first();
        if (!peek) return null;
        if (String(peek.status) !== 'open') return String(peek.status) === 'dissolved' ? null : refuseNotOpen(peek.status);
        await lockStop(t, peek.stop_base_key);
        const visit = await t('service_visits').where({ id: service.visit_id }).first();
        if (!visit) return null;
        if (String(visit.status) !== 'open') return String(visit.status) === 'dissolved' ? null : refuseNotOpen(visit.status);
        if (visit.stop_base_key !== peek.stop_base_key) {
          throw Object.assign(new Error('visit stop moved concurrently — retry'), { code: 'VISIT_STOP_MOVED' });
        }
        const members = await t('scheduled_services').where({ visit_id: visit.id })
          .whereNotIn('status', TERMINAL_ROW_STATUSES).forUpdate()
          .select('id', 'status', 'technician_id', 'customer_id', 'property_id', 'scheduled_date', 'window_start', 'window_end', 'is_recurring', 'estimated_duration_minutes', 'auto_dispatch_locked', 'auto_dispatch_excluded');
        const primary = members.find((m) => String(m.id) === String(serviceId));
        if (!primary) return null;
        // Frozen membership (issued link, packet, artifacts, payment attempt —
        // completion-stage state; the detach seam deliberately preserves it):
        // members are moved in separate transactions, so no compensation can
        // make a grouped move of such a visit atomic across a crash or deploy
        // between member commits (local codex audit P0). Refused up front —
        // nothing is written; finish the visit or contact the office.
        // Checked BEFORE the lone-member decline (local audit r30): a frozen
        // visit that kept one live member beside a terminal one would
        // otherwise fall to the rebooker's single-row path, whose seam
        // preserves the frozen membership — the child at the new stop, the
        // visit and its issued/payment artifacts at the old one.
        const split = canSplit(await visitActivity(visit.id, t));
        if (!split.ok && split.reason !== 'visit_not_open') {
          throw Object.assign(new Error('Cannot move this stop: the visit already has an issued link, records or a payment in progress — finish it, or contact the office to move it.'), { statusCode: 409, code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', isOperational: true, reason: split.reason });
        }
        // Durable completion claims (local codex audit P0): the legacy
        // /complete handler claims service_completion_attempts under the
        // row's stop lock and then lets an open, packet-less grouped row
        // complete where it sits (dissolving the visit at commit) — state
        // canSplit cannot see. Mirror createOrJoinVisit's guard under the
        // same stop lock + member row locks: a member with a live or
        // succeeded claim freezes the move before anything is written. The
        // rebooker repeats this under each member's own row locks
        // (VISIT_COMPLETION_IN_FLIGHT) for a claim that lands after the plan.
        // No catch: an unreadable ledger fails the move, never opens it.
        const liveClaim = await t('service_completion_attempts')
          .whereIn('service_id', members.map((m) => m.id))
          .whereIn('status', LIVE_COMPLETION_CLAIM_STATUSES)
          .first('id', 'service_id');
        if (liveClaim) {
          throw Object.assign(new Error('Cannot move this stop: a grouped service is being completed — try again after it finishes, or contact the office.'), { statusCode: 409, code: 'VISIT_FROZEN_MOVE_UNSUPPORTED', isOperational: true, reason: 'completion_in_flight', memberId: liveClaim.service_id });
        }
        // One live member is not a grouped stop: the rebooker's ordinary
        // single-row path moves it (its seam detaches an unfrozen visit).
        if (members.length < 2) return null;
        // SCOPE (owner decision pending, codex #3609 r3): a grouped stop is
        // moved as a unit by STAFF, on the direct (non-series) path only —
        // the surfaces whose callers handle partial results. A customer
        // self-serve move of a grouped visit and an explicit series-scoped
        // move of a grouped anchor are refused with guidance until the
        // series_moves-backed visit operation ships; nothing is written.
        if (/^customer/i.test(String(initiatedBy || ''))) {
          throw Object.assign(new Error('This appointment includes more than one service — please call or text us to move it and we will take care of it.'), { statusCode: 409, code: 'VISIT_CUSTOMER_MOVE_UNSUPPORTED', isOperational: true });
        }
        if (options.primaryViaSeries) {
          throw Object.assign(new Error('This service is grouped with another at the same stop — move the stop from the schedule (this visit only), or separate the services first.'), { statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED', isOperational: true });
        }
        // The same refusal for IMPLICIT widening (local codex audit): with the
        // collective gate on, a date move of a cadence primary would enter the
        // series path, which moves future occurrences one row at a time and
        // detaches them from their own grouped siblings. Staff move this visit
        // only (seriesPolicy 'single') until the series-aware visit operation
        // ships.
        if (primary.is_recurring === true && options.seriesPolicy !== 'single'
          && process.env.GATE_ADMIN_COLLECTIVE_MOVE === 'true' && newDateStr !== dateOnly(primary.scheduled_date)) {
          throw Object.assign(new Error('This service is grouped with another at the same stop — move this visit only (not the series), or separate the services first.'), { statusCode: 409, code: 'VISIT_SERIES_MOVE_UNSUPPORTED', isOperational: true });
        }
        for (const m of members) {
          // Auto-dispatch honours the operator opt-outs on EVERY grouped
          // member, with the same guard the tapped row gets (codex r5): a
          // locked/excluded sibling fails the whole unit move.
          if (String(initiatedBy) === 'auto_dispatch' && (m.auto_dispatch_locked === true || m.auto_dispatch_excluded === true)) {
            throw Object.assign(new Error('Cannot auto-move this stop: a grouped service is locked or excluded from auto-dispatch'), { statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_OPT_OUT', memberId: m.id, isOperational: true });
          }
          if (!movable(m.status)) {
            throw Object.assign(new Error(`Cannot move this stop: a grouped service is ${m.status} — separate it first`), { statusCode: 409, code: 'VISIT_MEMBER_NOT_MOVABLE', memberId: m.id });
          }
          if (!rowStillAtVisitStop(m, visit, members.filter((o) => o.id !== m.id))) {
            throw Object.assign(new Error('Cannot move this stop: a grouped service is no longer at this stop — separate it first'), { statusCode: 409, code: 'VISIT_MEMBER_DETACHED', memberId: m.id });
          }
        }
        // Sibling offset anchor: the tapped row's own start, else the VISIT's
        // canonical start (a windowless tapped row is still a member of a
        // windowed stop — local codex audit). No anchor at all with windowed
        // siblings is ambiguous: refuse rather than leave siblings at the old
        // time behind a moved anchor.
        const anchorStart = primary.window_start || visit.window_start || null;
        if (win.start && !anchorStart && members.some((m) => m.id !== primary.id && m.window_start)) {
          throw Object.assign(new Error('Cannot move this stop to a new time from a service without a time window — move it from a grouped service that has one, or set this service\'s window first'), { statusCode: 409, code: 'VISIT_WINDOWLESS_ANCHOR_MOVE_UNSUPPORTED', isOperational: true });
        }
        const delta = win.start && anchorStart ? (toMinutes(win.start) - toMinutes(anchorStart)) : 0;
        const validateSibling = (m, start, end) => {
          try {
            require('./scheduling/window-rules').assertAdminAppointmentWindow({ windowStart: start, windowEnd: end, durationMinutes: m.estimated_duration_minutes });
          } catch (e) {
            throw Object.assign(new Error(`Cannot move this stop: a grouped service's time is not allowed on the new slot — ${e.message}`), { statusCode: 409, code: 'VISIT_MEMBER_WINDOW_INVALID', memberId: m.id, isOperational: true });
          }
        };
        // A shifted bound must stay inside the target day (codex r24 P2):
        // shiftClock wraps modulo 24h, so a positive offset pushing a late
        // sibling past midnight would derive an "early-morning" window the
        // admin rules accept — on the same date, no longer one physical stop.
        const shiftInDay = (row, bound) => {
          const base = toMinutes(bound);
          if (base == null || !Number.isFinite(delta)) return bound || null;
          const total = base + delta;
          if (total < 0 || total >= 1440) {
            throw Object.assign(new Error(`Cannot move this stop: a grouped service's time would cross midnight on the new slot (${bound} shifted by ${delta > 0 ? '+' : ''}${delta} min) — move it separately`), { statusCode: 409, code: 'VISIT_MEMBER_WINDOW_INVALID', memberId: row.id, isOperational: true });
          }
          return shiftClock(bound, delta);
        };
        const targets = members.map((m) => {
          const isPrimary = m.id === primary.id;
          let window = null;
          let targetStart = m.window_start || null;
          let targetEnd = m.window_end || null;
          if (win.start && (m.window_start || isPrimary)) {
            // The tapped row takes the requested slot even when it was
            // windowless (codex r3); a windowless sibling stays windowless.
            targetStart = isPrimary ? win.start : shiftInDay(m, m.window_start);
            targetEnd = isPrimary ? (win.end || (m.window_end ? shiftInDay(m, m.window_end) : null)) : shiftInDay(m, m.window_end);
            window = targetEnd ? `${targetStart}-${targetEnd}` : { start: targetStart, end: null };
            // A DERIVED sibling window must pass the admin window rules (on
            // the hour, ends by the day cutoff) BEFORE the first member
            // write, for EVERY caller (codex r4/r9): dispatch validates only
            // the tapped window; rain-out and auto-dispatch validate none —
            // a legacy :30 sibling must not ride its offset onto a new slot.
            if (!isPrimary) validateSibling(m, targetStart, targetEnd);
          } else if (!isPrimary && m.window_start && dateOnly(m.scheduled_date) !== newDateStr) {
            // Date-only move: the sibling keeps its own window, which now
            // lands on a NEW date — a legacy off-hour window cannot ride
            // onto it either (codex r11; same ruling update-details applies).
            validateSibling(m, targetStart, targetEnd);
          }
          const norm = (v) => (v ? String(v).slice(0, 5) : null);
          const techMatches = options.technicianId === undefined || String(m.technician_id || '') === String(options.technicianId || '');
          // No-op only when EVERY requested field already holds (codex r2):
          // date, start AND end (normalized), and the explicit technician.
          const alreadyAtTarget = dateOnly(m.scheduled_date) === newDateStr
            && (!win.start || (!m.window_start && !isPrimary) || (norm(m.window_start) === norm(targetStart) && norm(m.window_end) === norm(targetEnd)))
            && techMatches;
          return {
            id: m.id, isPrimary, window, alreadyAtTarget, previousStatus: String(m.status),
            startHHMM: norm(targetStart) || norm(m.window_start) || null,
            // Original bounds kept SEPARATELY (local audit): a null end must
            // roll back as { start, end: null }, never as a zero-length
            // "09:00-09:00" window.
            original: { date: dateOnly(m.scheduled_date), start: norm(m.window_start) || null, end: norm(m.window_end) || null,
              window: m.window_start ? (m.window_end ? `${norm(m.window_start)}-${norm(m.window_end)}` : { start: norm(m.window_start), end: null }) : null },
            // Per-member fence from the LOCKED row (codex r1): the caller's
            // expect / expectAnchor / expectOccurrenceIds pin the primary only.
            // visit_id + technician_id fence the member's own move to the
            // planned unit (codex r7): a row split from the visit or
            // reassigned after the plan fails ITS CAS instead of moving.
            // status too (local audit): a sibling that went en_route / on_site
            // / terminal after the plan released its locks fails ITS CAS and
            // the primary's excludeExpect contract before the first write.
            expect: { scheduled_date: dateOnly(m.scheduled_date), window_start: m.window_start || null, window_end: m.window_end || null, visit_id: visit.id, technician_id: m.technician_id || null, status: String(m.status) },
          };
        });
        // Hard cap from the LOCKED plan (codex r8): auto-dispatch reserves
        // its per-run change budget from an unlocked pre-read; the member
        // count that actually CHANGES is decided here, under the stop lock —
        // members already at the requested placement (a windowless sibling
        // on a same-day window move, codex r22 P2) are not changes — and
        // must fit the budget the caller still has, or nothing moves.
        const changingCount = targets.filter((x) => !x.alreadyAtTarget).length;
        if (Number.isFinite(options.maxUnitSize) && changingCount > options.maxUnitSize) {
          throw Object.assign(new Error(`Cannot move this stop as a unit: ${changingCount} grouped services would change, exceeding the caller's remaining change budget (${options.maxUnitSize})`), { statusCode: 409, code: 'VISIT_UNIT_OVER_CAP', isOperational: true, memberCount: changingCount });
        }
        // Caller-supplied member guard (codex r13 P1): auto-dispatch's
        // apply-time HARD guards (72h reminder freeze, technician capability,
        // live status, preferences) are evaluated for the tapped row only;
        // the caller re-validates EVERY locked member here — under the stop
        // lock, with each member's DERIVED target window (codex r16 P1),
        // before the first write — or the grouped automatic move is refused.
        if (typeof options.memberGuard === 'function') {
          await options.memberGuard({ trx: t, members, primaryId: primary.id, visitId: visit.id, targets });
        }
        // Destination-technician occupancy for EVERY derived member window
        // (local codex audit r24), before the first write: a hard clash
        // refuses the whole unit (SLOT_TAKEN — the callers' existing
        // handling); on an advisory staff surface (overlapAdvisory) it is a
        // warning, as the rebooker's own check would be. alignMember repeats
        // the check under the technician's slot-reserve lock at assignment.
        const techClashWarnings = [];
        if (options.technicianId) {
          for (const tg of targets) {
            const m = members.find((x) => String(x.id) === String(tg.id));
            const [ts, te] = typeof tg.window === 'string' ? tg.window.split('-') : [tg.window?.start || m.window_start || null, tg.window ? null : (m.window_end || null)];
            const clashId = await destinationTechClash(t, {
              technicianId: options.technicianId, date: newDateStr, windowStart: ts, windowEnd: te,
              durationMinutes: m.estimated_duration_minutes, excludeIds: members.map((x) => x.id),
            });
            if (!clashId) continue;
            if (options.overlapAdvisory !== true) {
              throw Object.assign(new Error('That window conflicts with another job on the technician\'s route'), { statusCode: 409, isOperational: true, code: 'SLOT_TAKEN', memberId: tg.id, conflictId: clashId });
            }
            techClashWarnings.push(`service ${tg.id} overlaps another job on the destination technician's route (${clashId})`);
          }
        }
        return {
          visitId: visit.id, oldKey: visit.stop_base_key, oldDate: dateOnly(visit.scheduled_date),
          customerId: visit.customer_id, propertyId: visit.property_id, techClashWarnings,
          targets, memberIds: members.map((m) => m.id),
          anyLive: members.some((m) => UNIT_MOVE_LIVE_STATUSES.has(String(m.status))),
          primaryRecurring: primary.is_recurring === true,
        };
      });
      break;
    } catch (err) {
      if (err && err.code === 'VISIT_STOP_MOVED' && attempt < 2) continue;
      throw err;
    }
  }
  if (!plan) return null;
  const pending = plan.targets.filter((x) => !x.alreadyAtTarget);
  if (!pending.length) {
    // Exact retry after a committed move: a recurring primary re-enters the
    // rebooker so a committed series move REPLAYS with its own contract
    // (seriesMoveId, occurrences, cleanup) instead of a generic no-op
    // (codex r3); the members are already at the target, nothing moves.
    // Only a request that could actually have created a series_moves
    // operation re-enters (codex r4): an explicit seriesPolicy 'single'
    // (Quick Move's fallback, auto-dispatch) or a dark collective gate
    // keeps the plain no-op — re-entering would insert a second log row
    // and repeat the caller's effects, or 409 a fenced retry.
    if (plan.primaryRecurring && options.seriesPolicy !== 'single' && process.env.GATE_ADMIN_COLLECTIVE_MOVE === 'true') {
      const replay = await rebooker.reschedule(serviceId, newDate, newWindow, reason, initiatedBy, { ...options, visitPolicy: 'single', skipVisitSeam: true });
      return { ...replay, visitMove: { visitId: plan.visitId, moved: [], failed: [], alreadyAtTarget: true, unchanged: plan.memberIds.map(String) } };
    }
    // The caller's `expect` fence still applies to a no-op (local codex
    // audit): every member already sits at the target, so the rebooker —
    // and its CAS on options.expect — never runs. Auto-dispatch pins the
    // ORIGINAL placement; a staff move that landed here first must surface
    // as stale, not as this run's success (stamps/notice from a stale
    // snapshot). Fail closed on an unreadable row.
    if (options.expect && Object.keys(options.expect).length) {
      const live = await db('scheduled_services').where({ id: serviceId }).first();
      if (!expectMatchesRow(live, options.expect)) {
        throw Object.assign(new Error('Cannot move this stop — it changed since it was read (another writer already placed it here)'), { statusCode: 409, code: 'VISIT_EXPECT_STALE', isOperational: true });
      }
    }
    // Repair pass (codex r37): after a parentRetargetFailed partial, every
    // child can already sit at the requested slot — the staff re-save the
    // needsAttention response prescribes lands HERE, and a plain no-op
    // would leave the stale parent and the retained 24h hold unchanged. A
    // parent that no longer matches the target is retargeted under the
    // stop locks and the retained cohort hold on these members released;
    // a healthy parent keeps the plain no-op. Best-effort — a failed
    // repair leaves the hold to its TTL, the safe direction.
    // Explicit outcome (codex r39): a silent early-return or swallowed error
    // would report a plain success and staff would lose the
    // VISIT_MOVE_INCOMPLETE signal while the parent stays stale.
    // 'not_needed' (parent healthy) · 'repaired' · 'failed' (parent
    // missing/non-open, members drifted, or the update threw).
    let repairOutcome = 'not_needed';
    try {
      await db.transaction(async (t) => {
        const repairKey = stopBaseKey({ propertyId: plan.propertyId, customerId: plan.customerId, scheduledDate: newDateStr });
        for (const key of [...new Set([plan.oldKey, repairKey])].sort()) await lockStop(t, key);
        const visit = await t('service_visits').where({ id: plan.visitId }).first();
        if (!visit || String(visit.status) !== 'open') { repairOutcome = 'failed'; return; }
        const rows = await t('scheduled_services').where({ visit_id: plan.visitId })
          .whereNotIn('status', TERMINAL_ROW_STATUSES).orderBy('id').forUpdate()
          .select('id', 'scheduled_date', 'window_start', 'window_end', 'status', 'technician_id');
        if (!rows.length || !rows.every((r) => dateOnly(r.scheduled_date) === newDateStr)) { repairOutcome = 'failed'; return; }
        // ONE-STOP invariant before any repair (codex r48): a same-day
        // partial window move can leave the moved primary and the stranded
        // sibling on DISCONNECTED windows that both read as at-target by
        // date alone — spanning them into one parent window would report a
        // broken stop repaired. Same technician + connected windows, the
        // grouping invariant everywhere else.
        if (rows.length >= 2 && (
          new Set(rows.map((r) => String(r.technician_id || ''))).size > 1
          || !windowedMembersConnected(rows)
        )) { repairOutcome = 'failed'; return; }
        // Live residue is derived from the STALE PARENT, not the plan
        // (codex r44): a same-day allowLive partial rewound the children
        // to 'confirmed' before this re-save, so plan.anyLive is false and
        // the dates match — but the parent still carries live stamps and
        // its tracker one-shots stay consumed. Cleared only when no member
        // is CURRENTLY live (a genuinely underway stop keeps its state).
        const anyLiveNow = rows.some((r) => ['en_route', 'on_site'].includes(String(r.status || '').toLowerCase()));
        const staleLiveResidue = !anyLiveNow && !!(visit.en_route_at || visit.arrived_at);
        const starts = rows.map((r) => r.window_start).filter(Boolean).sort();
        const ends = rows.map((r) => r.window_end).filter(Boolean).sort();
        const hhmm5 = (v) => (v ? String(v).slice(0, 5) : null);
        const stale = dateOnly(visit.scheduled_date) !== newDateStr
          || hhmm5(visit.window_start) !== hhmm5(starts[0] || null)
          || hhmm5(visit.window_end) !== hhmm5(ends.length ? ends[ends.length - 1] : null)
          || visit.stop_base_key !== repairKey
          // Tech-only moves (codex r39): a re-save after a failed retarget
          // of a reassignment finds date/window/key healthy — the parent's
          // technician is part of the tuple, mirroring the normal
          // retarget's options.technicianId patch.
          || (options.technicianId !== undefined && String(visit.technician_id || '') !== String(options.technicianId || ''))
          || staleLiveResidue;
        if (!stale) {
          // Healthy stop, but a RETAINED hold can still be parked on the
          // members (codex on-merge round: a full success whose release —
          // now the caller's sync — transiently failed). Clear stamps
          // older than the takeover grace; a live mover's stamp survives.
          const parked = await t('appointment_reminders')
            .whereIn('scheduled_service_id', rows.map((r) => r.id))
            .whereNotNull('move_hold_until')
            .forUpdate()
            .select('id', 'move_hold_until');
          const releasableParked = parked.filter((r) => {
            const until = new Date(r.move_hold_until).getTime();
            if (until <= Date.now()) return true;
            return Date.now() - (until - MOVE_HOLD_TTL_MS) >= MOVE_HOLD_TAKEOVER_AFTER_MS;
          });
          if (releasableParked.length) {
            await t('appointment_reminders').whereIn('id', releasableParked.map((r) => r.id))
              .update({ move_hold_until: null, move_hold_token: null });
            logger.info(`[visit-groups] no-op re-save of healthy visit ${plan.visitId} released ${releasableParked.length} retained hold row(s)`);
          }
          return;
        }
        const patch = { scheduled_date: newDateStr, window_start: starts[0] || null, window_end: ends.length ? ends[ends.length - 1] : null };
        if (repairKey !== visit.stop_base_key) { patch.stop_base_key = repairKey; patch.stop_seq = await nextStopSeq(t, repairKey); }
        if (options.technicianId !== undefined) {
          await assertAssignableTechnician(options.technicianId || null, { conn: t });
          patch.technician_id = options.technicianId || null;
        }
        // Mirror the normal retarget's lifecycle reset (codex r43): a
        // repaired LIVE move (allowLive) or date change must not leave the
        // parent marked underway with its tracker one-shots consumed at
        // the new stop.
        if (plan.anyLive || newDateStr !== plan.oldDate || staleLiveResidue) {
          patch.en_route_at = null;
          patch.arrived_at = null;
          await t('visit_effects').where({ visit_id: plan.visitId }).whereIn('effect_type', ['tracker_en_route', 'tracker_arrived']).del();
        }
        await t('service_visits').where({ id: plan.visitId }).update(patch);
        // The stop is whole again — release the RETAINED cohort hold on
        // these members. Same lease semantics as the claim (codex r38): a
        // stamp inside the takeover grace belongs to a LIVE concurrent
        // mover (its claim trx released the stop lock before its member
        // writes, so the stop locks here do NOT serialize against it) and
        // must survive; only retained (older) or expired stamps clear.
        const heldRows = await t('appointment_reminders')
          // The CURRENT locked membership, not the plan snapshot (codex
          // r43): a joiner that inherited the retained token in the gap
          // between plan and repair must release with the repaired stop.
          .whereIn('scheduled_service_id', rows.map((r) => r.id))
          .whereNotNull('move_hold_until')
          .forUpdate()
          .select('id', 'move_hold_until');
        const releasable = heldRows.filter((r) => {
          const until = new Date(r.move_hold_until).getTime();
          if (until <= Date.now()) return true; // expired residue
          const stampedAt = until - MOVE_HOLD_TTL_MS;
          return Date.now() - stampedAt >= MOVE_HOLD_TAKEOVER_AFTER_MS; // retained, not live
        });
        if (releasable.length) {
          await t('appointment_reminders').whereIn('id', releasable.map((r) => r.id))
            .update({ move_hold_until: null, move_hold_token: null });
        }
        repairOutcome = 'repaired';
        logger.info(`[visit-groups] no-op unit move repaired the stale parent of visit ${plan.visitId} and released its retained hold`);
      });
    } catch (repairErr) {
      repairOutcome = 'failed';
      logger.warn(`[visit-groups] no-op parent repair for visit ${plan.visitId} failed: ${repairErr.message} — a retained hold (if any) expires on its own`);
    }
    return {
      success: true,
      newDate,
      visitMove: {
        visitId: plan.visitId, moved: [], failed: [], alreadyAtTarget: true, unchanged: plan.memberIds.map(String),
        // A stale-but-unrepaired parent keeps the incomplete-move signal
        // (codex r39): callers preserve needsAttention, suppress the
        // customer text and pass preserveMoveHold on their reminder sync.
        ...(repairOutcome === 'failed' ? { parentRetargetFailed: true } : {}),
      },
    };
  }

  // ---- 2. move members: primary first, then siblings ----
  // A durable SEND HOLD is stamped on every member's reminder row before
  // the first member write (owner ruling 2026-08-30; codex r28/r29 P1):
  // the sent flags cannot carry this hold — the DB sync trigger
  // (sync_appointment_reminder_on_service_change) and the per-member
  // reminder sync recalculate them for the new slot as the move itself
  // writes — so the hold is its own column (move_hold_until), untouched by
  // the trigger and honored by every sender (deliverConfirmation's
  // rechecks, the 72h/24h sweep). Full success clears it (fenced on our
  // own stamp); a PARTIAL move leaves it, so nobody is auto-texted until
  // staff repair the stop — and it expires on its own in 24h so a
  // forgotten repair can never silence a customer forever. The stamp
  // itself failing ABORTS the move before anything is written.
  // COHORT IDENTITY is a cryptographically unique token written with the
  // stamp (codex r35 — a jittered expiry is NOT unique: two same-customer
  // moves inside one second can collide): the repair-release keys on the
  // token; the senders' hold checks and the lease/takeover math keep
  // reading move_hold_until alone.
  const reminderHoldUntil = new Date(Date.now() + MOVE_HOLD_TTL_MS);
  const reminderHoldToken = require('crypto').randomBytes(16).toString('hex');
  let reminderHoldIds = [];
  let reminderHoldMemberIds = [];
  try {
    await db.transaction(async (t) => {
      // The claim runs under the STOP LOCK with a fresh membership read
      // (local codex gate P1): the plan's own trx (and its stop lock)
      // committed before this one, so a row can JOIN the visit in the gap
      // — it is missing from plan.memberIds, no held sibling existed for
      // the join-inherit to copy, and a partial move would leave it
      // texting while the planned cohort is held. The hold covers the
      // UNION of the plan and the live membership: the late joiner stays
      // quiet with the cohort (the retarget detaches it with a warning —
      // that established contract is unchanged) and members that left are
      // fenced by the plan's own per-member checks.
      await lockStopForRow(t, serviceId);
      const membershipNow = (await openMembers(t, plan.visitId)).map((m) => String(m.id));
      const holdMemberIds = [...new Set([...plan.memberIds.map(String), ...membershipNow])];
      reminderHoldMemberIds = holdMemberIds;
      // EVERY represented member's row is held — including members already
      // at the target (codex r30 P1): they stay part of the whole-visit
      // quiet invariant while another member is mid-move or stranded.
      // FOR UPDATE + an active-hold refusal make this a LEASE (codex r30
      // P1): a concurrent mover's live stamp is never overwritten (its
      // partial outcome would otherwise lose its hold when our fenced
      // release ran), it is refused — that visit is mid-move elsewhere.
      // Cancelled rows are held too (codex r28): the schedule-change
      // trigger can reactivate one mid-move and it must inherit the quiet.
      reminderHoldIds = await claimReminderHoldInTx(t, holdMemberIds, { holdUntil: reminderHoldUntil, holdToken: reminderHoldToken });
    });
  } catch (err) {
    reminderHoldIds = [];
    reminderHoldMemberIds = [];
    // A membership change (or the stop moving) during the claim is a
    // PLAN-STALE abort, not a hold failure — surface it unwrapped so the
    // caller replans instead of retrying a 503 (local gate P1).
    if (err && (err.code === 'VISIT_MEMBERSHIP_CHANGED' || err.code === 'VISIT_STOP_MOVED')) {
      throw err.code === 'VISIT_STOP_MOVED'
        ? Object.assign(new Error('Cannot move this stop — it changed while the move was being prepared; reload and try again'), { statusCode: 409, code: 'VISIT_MEMBERSHIP_CHANGED', isOperational: true })
        : err;
    }
    throw Object.assign(new Error(`Cannot move this stop right now — its reminder hold could not be secured (${err.message}); try again`), { statusCode: 503, code: 'VISIT_MOVE_HOLD_FAILED', isOperational: true, ...(err.code === 'VISIT_MOVE_HOLD_ACTIVE' ? { reason: 'hold_active' } : {}) });
  }
  // Release the hold (fenced on our own stamp so a newer mover's hold is
  // never cleared). Runs on full success AND on an abort where nothing
  // committed; a failed release leaves the rows quiet until the stamp
  // expires (the safe direction) and reports.
  const releaseReminderHold = async (onFailure) => {
    try {
      // Keyed on the MEMBERS + our stamp (codex r28): a reminder row
      // created or re-stamped mid-move carries the same stamp and is
      // released with the rest; a newer mover's stamp is never touched.
      // Keyed on the TOKEN ALONE (uncapped r36 P1): the member-id snapshot
      // predates late joins that inherited this token — the crypto-unique
      // token IS the cohort, so every row carrying it releases together.
      await releaseReminderHoldByToken(reminderHoldToken);
    } catch (err) {
      onFailure(err);
    }
  };
  // A reminder row can appear (self-heal, trigger reactivation, the
  // member's own sync) AFTER the up-front claim (codex r28 P1): re-stamp
  // the member's row after its move so a late row inherits the quiet.
  // Best-effort — the senders' own hold checks are the authority.
  const restampMemberHold = async (memberId) => {
    try {
      await db('appointment_reminders').where({ scheduled_service_id: memberId })
        .where((q) => { q.whereNull('move_hold_until').orWhere('move_hold_until', '<', reminderHoldUntil); })
        .update({ move_hold_until: reminderHoldUntil, move_hold_token: reminderHoldToken });
    } catch (err) {
      logger.warn(`[visit-groups] reminder hold re-stamp for ${memberId} failed: ${err.message}`);
    }
  };
  const moved = [];
  const failed = [];
  const warnings = [...(plan.techClashWarnings || [])];
  let primaryResult = null;
  // technicianId is NOT forwarded to sibling moves (codex r15 P1): the
  // rebooker writes technician_id directly, bypassing the canonical
  // assignment writer (tech-day fences, unassigned_overdue resolution,
  // dispatch broadcast). Each moved sibling is re-pointed AFTER its move
  // through alignMemberTechnician → assignDispatchJob instead.
  const { expect: _expect, expectAnchor: _expectAnchor, expectOccurrenceIds: _expectOcc, expectSchedule: _expectSched, primaryViaSeries: _pvs, memberGuard: _guard, technicianId: _tech, ...siblingBase } = options;
  // Landed state per member (date + window at the target) once its move
  // committed — the contract later member moves verify the row against.
  const landedState = {};
  // Landed tuple = what the rebooker actually writes (codex r11): a
  // date-only move keeps BOTH bounds; a start-only window leaves the end
  // to the rebooker's derivation, so window_end is left OUT of the contract
  // (an undefined key is not compared) rather than asserted null.
  const targetTuple = (t) => {
    if (!t.window) return { scheduled_date: newDateStr, window_start: t.expect.window_start || null, window_end: t.expect.window_end || null };
    if (typeof t.window === 'string') { const [ts, te] = t.window.split('-'); return { scheduled_date: newDateStr, window_start: ts, window_end: te }; }
    return { scheduled_date: newDateStr, window_start: t.window.start || null };
  };
  for (const t of plan.targets.filter((x) => x.alreadyAtTarget)) landedState[t.id] = targetTuple(t);
  // Did this member's row land at its planned target (same visit, target
  // date, planned window bounds where the plan asserts them, planned tech)?
  // Read fresh from the root connection; a read failure reports NOT landed
  // (the caller then treats the move as failed — the conservative answer).
  const memberLandedAt = async (t) => {
    try {
      const row = await db('scheduled_services').where({ id: t.id })
        .first('scheduled_date', 'window_start', 'window_end', 'visit_id', 'technician_id');
      if (!row || String(row.visit_id || '') !== String(plan.visitId)) return false;
      if (dateOnly(row.scheduled_date) !== newDateStr) return false;
      const want = targetTuple(t);
      const norm = (v) => (v ? String(v).slice(0, 5) : null);
      if (want.window_start !== undefined && norm(row.window_start) !== norm(want.window_start)) return false;
      if (want.window_end !== undefined && norm(row.window_end) !== norm(want.window_end)) return false;
      // The technician is NOT part of the landing (local codex audit P1):
      // technicianId never rides the rebooker, so a correctly landed row
      // still carries its pre-move technician until alignMember re-points
      // it AFTER this verdict — and alignMember's own fence
      // (expectTechnicianId ⇒ ASSIGNMENT_STALE) is the technician verdict.
      return true;
    } catch (readErr) {
      // INDETERMINATE, never "not landed" (uncapped r36 P1): the move may
      // have committed with only the verification read failing — treating
      // it as false would take the primary's nothing-moved abort branch
      // and release the cohort hold over a possibly-moved stop.
      logger.warn(`[visit-groups] unit move landed-check for ${t.id} failed: ${readErr.message}`);
      throw Object.assign(new Error(`could not verify whether ${t.id} landed: ${readErr.message}`), { code: 'VISIT_LANDED_UNVERIFIABLE' });
    }
  };
  const ordered = [...pending.filter((x) => x.isPrimary), ...pending.filter((x) => !x.isPrimary)];
  // A sibling that did not land (or could not be re-pointed): partial +
  // warning — the staff contract (r3); the detach seam separates the row
  // that stayed behind. (Frozen visits are refused before the first write.)
  const failSibling = async (target, err, reason, extra = {}) => {
    failed.push({ id: target.id, reason, code: err.code || null, ...extra });
    logger.warn(`[visit-groups] unit move of visit ${plan.visitId}: member ${target.id} failed: ${reason}`);
  };
  for (const target of ordered) {
    // The primary keeps the caller's own fence; a caller that supplied none
    // (the public self-reschedule path) gets the LOCKED plan's fence, so two
    // concurrent submissions cannot both plan from the old visit and let
    // the second overwrite the first (codex r3).
    const callerFenced = options.expect || options.expectAnchor || options.expectSchedule;
    // The primary's occupancy probes hide the siblings (excludeServiceIds);
    // excludeExpect makes the rebooker lock those rows FOR UPDATE inside its
    // own move transaction and verify they still hold the plan snapshot
    // (membership + slot) — held through the conflict checks and the write,
    // so a sibling split and re-booked into the target can never hide
    // behind the exclusion (codex r4/r5). Mismatch → 409 VISIT_PLAN_STALE.
    // EVERY member move carries the contract for the OTHER participating
    // rows (codex r6): already-moved members at their landed target,
    // not-yet-moved members at their planned snapshot; a failed sibling
    // is dropped from the exclusion (it is real occupancy again). Under
    // auto-dispatch the operator opt-out flags ride in the contract and in
    // each sibling's own CAS, so an opt-out committed between plan and
    // move stops the automatic move instead of being overridden.
    const autoDispatch = String(initiatedBy) === 'auto_dispatch';
    const optOutFence = autoDispatch ? { auto_dispatch_locked: false, auto_dispatch_excluded: false } : {};
    const participating = plan.targets.filter((x) => x.id !== target.id && !failed.some((f) => f.id === x.id));
    const excludeExpect = participating.map((x) => ({ id: x.id, visit_id: plan.visitId, ...(landedState[x.id] || x.expect), ...optOutFence }));
    const excludeServiceIds = [...new Set([...(options.excludeServiceIds || []), ...participating.map((x) => x.id)].map(String))];
    // The primary's CAS always carries the unit fence (locked membership +
    // planned technician); a caller's own expect fields are MERGED on top,
    // never replace it (codex r8). A caller fencing via expectAnchor /
    // expectSchedule keeps those and still gets the unit keys.
    const primaryExpect = {
      ...(callerFenced ? {} : target.expect),
      visit_id: plan.visitId,
      technician_id: target.expect.technician_id,
      ...(options.expect || {}),
    };
    // technicianId never rides ANY member's rebooker call (local codex audit):
    // the primary too is re-pointed after its move through the canonical
    // assignment writer (tech-day fences, unassigned_overdue resolution,
    // dispatch broadcast). The rebooker's occupancy probe therefore runs on
    // the row's CURRENT technician; staff surfaces are advisory anyway.
    const { technicianId: _primaryTech, ...primaryBase } = options;
    // A unit move that ALSO changes technician re-points every member
    // through assignDispatchJob right after — that writer sends the
    // moved-off / new-visit pair, so the member's own rebooker call must not
    // first tell the old tech "visit moved" (tech-visit-notifications.js).
    const unitTechChanges = Object.prototype.hasOwnProperty.call(options, 'technicianId')
      && (options.technicianId || null) !== (target.expect.technician_id || null);
    const noticeOpts = unitTechChanges ? { suppressTechNotice: true } : {};
    const memberOpts = target.isPrimary
      ? { ...primaryBase, ...noticeOpts, expect: primaryExpect, visitPolicy: 'single', skipVisitSeam: true, excludeServiceIds, excludeExpect }
      // A sibling is ALWAYS a single-row move (codex r4): the dispatch
      // surface previewed/acknowledged series scope for the tapped row
      // only, so a recurring sibling must never shift its own future
      // series undisclosed.
      : { ...siblingBase, ...noticeOpts, expect: { ...target.expect, ...optOutFence }, seriesPolicy: 'single', visitPolicy: 'single', skipVisitSeam: true, excludeServiceIds, excludeExpect };
    // Callers sync reminders for the tapped row only (r2): every moved
    // sibling gets its reminder row synced here, notice suppressed — the
    // visit's one reminder text is the primary's. A sibling's own series
    // move (seriesMoveId) is finished by the series-effects reconciler like
    // any other committed series_moves row.
    // Re-point a moved MEMBER (primary included) at the requested technician through the
    // canonical writer (codex r15 P1). Its own transaction after the move
    // committed; 40P01 (tech-day fence vs a scheduling writer waiting on
    // our stop lock) retries. A failure leaves the row moved but on its old
    // technician — reported as a failed member (the detach seam separates
    // it from the re-pointed parent), never silently split-tech.
    const alignMember = async () => {
      if (options.technicianId === undefined) return;
      if (String(target.expect.technician_id || '') === String(options.technicianId || '')) return;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          // skipVisitSeam: the per-row seam would see a half-reassigned visit
          // (later siblings + the parent still on the old tech) and detach
          // this row for good (codex r16 P1); step 4 runs the seam for every
          // member AFTER the parent retarget carries the new technician.
          // expectTechnicianId (local audit): the planned pre-move technician
          // from the LOCKED plan is the baseline — an operator reassignment
          // that landed after the sibling's move is newer and wins; this
          // member is then reported failed/stale, never overwritten.
          await db.transaction(async (t) => {
            // The destination technician's slot-reserve lock (the rebooker's
            // and slot-reservation's key shape) serializes this check with
            // every scheduling writer on that tech-day; the tech lock is
            // taken BEFORE row locks, the rebooker's own order (local codex
            // audit r24). A clash leaves the row moved on its old technician
            // — a reported failed member, never a silent double-booking;
            // advisory staff surfaces warn and assign, as the rebooker would.
            if (options.technicianId) {
              const landed = landedState[target.id] || {};
              // Rung 1 first (occupancy.js ORDERING CONTRACT, codex r23 P1):
              // the date-wide occupancy lock guards the tech-blind global
              // predicate below — an unassigned or other-tech row committed
              // after the member's move would otherwise pass the tech-scoped
              // probe (AGENTS.md booking conflict-check class). Then the
              // destination tech's slot-reserve lock, then row locks — the
              // rebooker's own order.
              const { acquireOccupancyLock, findConflictingVisits } = require('./scheduling/occupancy');
              await acquireOccupancyLock(t, newDateStr);
              await t.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['slot-reserve', `${options.technicianId}:${newDateStr}`]);
              // the row's COMMITTED window (a start-only landing derived its end); the landed contract is the fallback
              const row = await t('scheduled_services').where({ id: target.id }).first('window_start', 'window_end', 'estimated_duration_minutes', 'service_type').catch(() => null);
              const windowStart = (row && row.window_start) || landed.window_start || target.startHHMM || null;
              const windowEnd = (row && row.window_end) || landed.window_end || null;
              const probeEnd = windowEnd ? String(windowEnd).slice(0, 5) : (windowStart ? shiftClock(String(windowStart).slice(0, 5), Number(row && row.estimated_duration_minutes) || 60) : null);
              // Only members this move still REPRESENTS are hidden from the
              // probes (local audit r32): a member reported failed (or one
              // that diverged) is real occupancy again and may have moved
              // into this target since — hiding it would allow a
              // double-booking. Failed ids are removed from the exclusion.
              const failedIds = new Set(failed.map((f) => String(f.id)));
              const probeExclude = plan.memberIds.map(String).filter((mid) => !failedIds.has(mid));
              const globalClash = windowStart && probeEnd ? await findConflictingVisits({
                db: t, date: newDateStr, windowStart: String(windowStart).slice(0, 5), windowEnd: probeEnd,
                excludeServiceIds: probeExclude, excludeStatuses: ['cancelled', 'completed'],
              }) : [];
              const clashId = (globalClash && globalClash.length ? globalClash[0].id : null) || await destinationTechClash(t, {
                technicianId: options.technicianId, date: newDateStr, windowStart, windowEnd,
                durationMinutes: row ? row.estimated_duration_minutes : null, excludeIds: probeExclude,
              });
              if (clashId && options.overlapAdvisory !== true) {
                throw Object.assign(new Error('That window conflicts with another job on the technician\'s route'), { statusCode: 409, isOperational: true, code: 'SLOT_TAKEN', conflictId: clashId });
              }
              if (clashId) warnings.push(`service ${target.id} overlaps another job on the destination technician's route (${clashId})`);
              // Destination capability fence for THIS member on the transaction
              // that assigns it (auto-dispatch's options.moveGuard). The member
              // guard ran under the planning lock, which is released by now, so
              // a category turned Off since planning is caught here, before the
              // assignment write; the row lands on its old technician and is
              // reported failed like any other refused member.
              if (typeof options.moveGuard === 'function') {
                const memberRow = row && row.service_type !== undefined
                  ? { id: target.id, ...row }
                  : await t('scheduled_services').where({ id: target.id }).first('id', 'service_type', 'technician_id');
                await options.moveGuard({ trx: t, technicianId: options.technicianId, service: memberRow || { id: target.id } });
              }
            }
            await alignMemberTechnician(t, target.id, options.technicianId || null, {
              skipVisitSeam: true,
              expectTechnicianId: target.expect.technician_id || null,
              // Staff UUID only — assignDispatchJob's actorId also stamps
              // dispatch_alerts.resolved_by; a system label never goes there.
              actorId: options.actorId || null,
              // The card's actor: the staff row when there is one, else the
              // rebooker's initiatedBy label (a customer's online move reads
              // "by the customer online", as the moved-off card below does).
              noticeActorId: options.actorId || initiatedBy || null,
            });
          });
          return;
        } catch (err) {
          lastErr = err;
          if (err && err.code === '40P01') continue;
          break;
        }
      }
      // The row moved but stays on its old technician: that tech's "visit
      // moved" card was suppressed on the member's rebooker call (the
      // reassignment was going to send the pair) — send it now so the move
      // is never silent for the person still holding the stop.
      const holder = target.committedTechnicianId !== undefined
        ? target.committedTechnicianId
        : (target.expect.technician_id || null);
      if (Object.prototype.hasOwnProperty.call(options, 'technicianId')
        && (options.technicianId || null) !== (target.expect.technician_id || null)
        && holder) {
        const win = targetTuple(target);
        // The snapshot asserts only what the plan knows (pre-push audit P1):
        // an object-shaped window carries no end, and a row without one had
        // none to plan from — the rebooker derives the end from the duration
        // either way — and asserting `null` there made the write-time check
        // drop this card against the committed end, leaving the holder
        // silent. The card's own text reads the committed row.
        const snapshot = { date: newDateStr, windowStart: win.window_start ?? null };
        if (win.window_end) snapshot.windowEnd = win.window_end;
        void require('./tech-visit-notifications').notifyVisitRescheduled({
          visitId: target.id,
          technicianId: holder,
          actorId: options.actorId || initiatedBy || null,
          previous: { date: target.expect.scheduled_date, windowStart: target.expect.window_start, windowEnd: target.expect.window_end },
          snapshot,
        });
      }
      await failSibling(target, { code: lastErr.code || 'ASSIGNMENT_FAILED' }, `moved but its technician reassignment failed: ${lastErr.message}`, { movedButUnassigned: true });
    };
    const syncSiblingReminder = async () => {
      try {
        // expectSchedule fences this sync against a NEWER move that landed
        // after the row moved (codex r3): a stale pass never overwrites it.
        // keepPendingConfirmation: nobody sends a replacement notice for a
        // sibling, so a still-pending creation confirmation stays pending
        // (delivered by the deferred sendConfirmation) instead of being
        // superseded and re-armed after the fact (codex r6/r7).
        await require('./appointment-reminders').handleReschedule(target.id, `${newDateStr}T${target.startHHMM || '08:00'}`, {
          sendNotification: false,
          keepPendingConfirmation: true,
          // This sync runs INSIDE the unit move — the repair-release must
          // not fire off it and un-hold the cohort mid-move (codex r34).
          preserveMoveHold: true,
          expectSchedule: { date: newDateStr, windowStart: target.startHHMM || null },
        });
      } catch (remErr) {
        logger.warn(`[visit-groups] unit move reminder sync for ${target.id} failed: ${remErr.message}`);
      }
    };
    try {
      const r = await rebooker.reschedule(target.id, newDate, target.window, reason, initiatedBy, memberOpts);
      moved.push(target.id);
      landedState[target.id] = targetTuple(target);
      // The status the rebooker's CAS actually matched outranks the plan
      // snapshot (codex r6): an operator confirm between plan and move must
      // not be rewound by a caller restoring 'pending'.
      if (r && r.previousStatus) target.previousStatus = String(r.previousStatus);
      // The holder on the COMMITTED row (codex r10 P1): a reassignment that
      // raced the plan can have landed a third technician — the fence in
      // alignMember then fails for exactly that reason, and the fallback
      // card must go to whoever holds the stop now, not the plan's tech.
      if (r && r.technicianId !== undefined) target.committedTechnicianId = r.technicianId || null;
      if (r && Array.isArray(r.warnings)) warnings.push(...r.warnings);
      if (target.isPrimary) primaryResult = r;
      await alignMember();
      if (!target.isPrimary) await syncSiblingReminder();
      await restampMemberHold(target.id);
    } catch (err) {
      // The rebooker COMMITS its move transaction and then runs post-commit
      // work (tech_status clear, follow-up shift, escalation, legacy
      // activation) that can reject after the row landed (codex r13 P1).
      // "Threw" therefore does not mean "did not move": re-read the row and
      // reconcile — a member that sits at its planned target is a committed
      // move (parent retarget + seams must still run for it); only a row
      // still at its old placement is a real failure.
      let landedVerdict;
      try {
        landedVerdict = await memberLandedAt(target);
      } catch (verifyErr) {
        // INDETERMINATE landing (uncapped r36 P1): the move may have
        // committed with only the verification read failing. Never take
        // the nothing-moved branch (which releases the cohort hold) —
        // report the member as failed/partial so the hold is RETAINED and
        // staff repair the stop; the reconciler/TTL are the backstops.
        if (target.isPrimary) {
          // The primary's outcome is unknowable right now: abort WITHOUT
          // the nothing-moved release — the hold stays until the board is
          // re-saved (or the TTL expires), so no stale text can go out
          // either way.
          throw Object.assign(new Error('Could not verify whether this stop moved — reload the board and re-save it; no automated texts will go out until the stop is verified.'), { statusCode: 503, code: 'VISIT_MOVE_UNVERIFIED', isOperational: true });
        }
        await failSibling(target, verifyErr, verifyErr.message);
        continue;
      }
      if (landedVerdict) {
        moved.push(target.id);
        landedState[target.id] = targetTuple(target);
        warnings.push(`${target.isPrimary ? 'the tapped service' : `service ${target.id}`} moved but its post-move cleanup failed: ${err.message}`);
        logger.warn(`[visit-groups] unit move of visit ${plan.visitId}: member ${target.id} landed but the rebooker rejected post-commit: ${err.message}`);
        if (target.isPrimary) primaryResult = { success: true, newDate };
        await alignMember();
        if (!target.isPrimary) await syncSiblingReminder();
        await restampMemberHold(target.id);
        continue;
      }
      if (target.isPrimary) {
        // The tapped row itself could not move — NOTHING has moved: the
        // hold must not outlive this abort (codex r28 P1); a failed release
        // self-heals when the stamp expires.
        await releaseReminderHold((rerr) => logger.warn(`[visit-groups] reminder-hold release after aborted move of visit ${plan.visitId} failed: ${rerr.message} — rows stay quiet until the hold expires`));
        throw err;
      }
      await failSibling(target, err, err.message);
    }
  }

  // ---- 3. retarget the parent from the rows that actually landed ----
  let parentRetargetFailed = false;
  const newKey = stopBaseKey({ propertyId: plan.propertyId, customerId: plan.customerId, scheduledDate: newDateStr });
  try {
    await db.transaction(async (t) => {
      for (const key of [...new Set([plan.oldKey, newKey])].sort()) await lockStop(t, key);
      const visit = await t('service_visits').where({ id: plan.visitId }).first();
      if (!visit || String(visit.status) !== 'open') {
        // The members moved but their parent is gone / no longer open: the
        // rows now hang off a parent that names another stop and the seams
        // below no-op on a non-open visit — a retarget FAILURE the caller
        // must see (parentRetargetFailed), never a silent success (local audit).
        throw Object.assign(new Error(`visit ${plan.visitId} is ${visit ? visit.status : 'missing'} — members moved but the visit record could not be retargeted`), { code: 'VISIT_PARENT_NOT_OPEN' });
      }
      // FOR UPDATE (codex r19): assignDispatchJob row-locks without the stop
      // lock, so the verified members stay locked through the parent write
      // and a reassignment linearizes AFTER this move (its seam then sees the
      // retargeted parent) instead of slipping between verify and update.
      const rows = await t('scheduled_services').where({ visit_id: plan.visitId })
        .whereNotIn('status', TERMINAL_ROW_STATUSES)
        .orderBy('id').forUpdate()
        .select('id', 'scheduled_date', 'window_start', 'window_end', 'technician_id');
      // Every member reported MOVED must still be a member of this visit
      // sitting at its landed target under these locks (codex r17): a
      // newer assignment/move between a member's move and this retarget can
      // detach it (its own seam) or move it again — the parent must not be
      // retargeted from whichever rows remain while `moved` claims a whole
      // visit. Divergent members become failed (partial), never silent.
      {
        const norm = (v) => (v ? String(v).slice(0, 5) : null);
        for (const id of [...moved]) {
          if (failed.some((f) => String(f.id) === String(id))) continue; // already reported (e.g. re-point failed)
          const r = rows.find((x) => String(x.id) === String(id));
          const want = landedState[id] || {};
          const ok = !!r && dateOnly(r.scheduled_date) === newDateStr
            && (want.window_start === undefined || norm(r.window_start) === norm(want.window_start))
            && (want.window_end === undefined || norm(r.window_end) === norm(want.window_end))
            && (options.technicianId === undefined || String(r.technician_id || '') === String(options.technicianId || ''));
          if (!ok) {
            moved.splice(moved.indexOf(id), 1);
            const reason = r ? 'moved again before the visit record was retargeted' : 'left the visit before the visit record was retargeted';
            failed.push({ id, reason, code: 'VISIT_MEMBER_DIVERGED' });
            logger.warn(`[visit-groups] unit move of visit ${plan.visitId}: member ${id} ${reason}`);
          }
        }
      }
      // A row that joined the visit AFTER the plan snapshot (the old stop
      // lock was released between plan and move — codex r2) is not part of
      // this move: detach it in place so it never trails a parent that
      // points at the new stop.
      const atTargetStop = (r) => {
        if (dateOnly(r.scheduled_date) !== newDateStr) return false;
        // A reassignment moved the planned members to options.technicianId;
        // a late joiner still on another tech is not at this stop (codex
        // r9) — detached below rather than left as a split-tech visit.
        if (options.technicianId !== undefined && String(r.technician_id || '') !== String(options.technicianId || '')) return false;
        if (!win.start) return true;
        // Same-day window move (codex r3): a late row still at the OLD window
        // never landed — compare against the moved primary's target window.
        const primaryTarget = plan.targets.find((x) => x.isPrimary);
        const [ts, te] = typeof primaryTarget.window === 'string' ? primaryTarget.window.split('-') : [primaryTarget.window && primaryTarget.window.start, null];
        return windowsOverlap(r.window_start, r.window_end, ts, te || ts);
      };
      const late = rows.filter((r) => !plan.memberIds.map(String).includes(String(r.id)) && !atTargetStop(r));
      if (late.length) {
        await t('scheduled_services').whereIn('id', late.map((r) => r.id)).update({ visit_id: null });
        // The detached row leaves THIS move's cohort too (codex on-merge
        // r2): it inherited the token at join, and a token still on a row
        // at the OLD stop would fail the finalizer's one-stop test and
        // strand the whole successful cohort held for 24h. Its own
        // reminders resume normally (it kept its old slot).
        await t('appointment_reminders')
          .whereIn('scheduled_service_id', late.map((r) => r.id))
          .where({ move_hold_token: reminderHoldToken })
          .update({ move_hold_until: null, move_hold_token: null });
        warnings.push(`${late.length} service(s) joined this stop during the move and were left at the old time — check the schedule`);
        logger.warn(`[visit-groups] unit move of visit ${plan.visitId}: detached late joiner(s) ${late.map((r) => r.id).join(',')}`);
      }
      // A planned member counts as landed only when its ACTUAL placement is
      // the one this move wrote for it (landedState: moved or already at
      // target) and it is not a failed member (local audit): on a same-day
      // window move a failed sibling still sits on the date at its OLD
      // window, and retargeting the parent from it would span both stops.
      const normHHMM = (v) => (v ? String(v).slice(0, 5) : null);
      const landedFor = (r) => {
        const want = landedState[r.id];
        if (!want) return false;
        if (failed.some((f) => String(f.id) === String(r.id))) return false;
        if (dateOnly(r.scheduled_date) !== newDateStr) return false;
        if (want.window_start !== undefined && normHHMM(r.window_start) !== normHHMM(want.window_start)) return false;
        if (want.window_end !== undefined && normHHMM(r.window_end) !== normHHMM(want.window_end)) return false;
        if (options.technicianId !== undefined && String(r.technician_id || '') !== String(options.technicianId || '')) return false;
        return true;
      };
      const landed = rows.filter((r) => (plan.memberIds.map(String).includes(String(r.id)) ? landedFor(r) : atTargetStop(r)));
      // ZERO landed rows is a retarget FAILURE, never a silent skip (codex
      // r43): e.g. every date move committed but every post-move alignment
      // failed — returning here left parentRetargetFailed false and the
      // "successful" seam then detached the moved children from the stale
      // parent and could dissolve the visit.
      if (!landed.length) {
        throw Object.assign(new Error(`no member of visit ${plan.visitId} could be verified at the target — the visit record was not retargeted`), { code: 'VISIT_PARENT_NO_LANDED' });
      }
      const starts = landed.map((r) => r.window_start).filter(Boolean).sort();
      const ends = landed.map((r) => r.window_end).filter(Boolean).sort();
      const patch = {
        scheduled_date: newDateStr,
        window_start: starts[0] || null,
        window_end: ends[ends.length - 1] || null,
      };
      if (newKey !== visit.stop_base_key) {
        patch.stop_base_key = newKey;
        patch.stop_seq = await nextStopSeq(t, newKey);
      }
      if (options.technicianId !== undefined) {
        await assertAssignableTechnician(options.technicianId || null, { conn: t });
        patch.technician_id = options.technicianId || null;
      }
      if (plan.anyLive || newDateStr !== plan.oldDate) {
        // The members' lifecycle was rewound by the rebooker; the visit's
        // must follow, and the day's tracker one-shots re-arm.
        patch.en_route_at = null;
        patch.arrived_at = null;
        await t('visit_effects').where({ visit_id: plan.visitId }).whereIn('effect_type', ['tracker_en_route', 'tracker_arrived']).del();
      }
      await t('service_visits').where({ id: plan.visitId }).update(patch);
    });
  } catch (err) {
    // Staff surface: the members moved; the office is told the visit
    // record lagged (warning + dispatch alert via the caller's warnings).
    parentRetargetFailed = true;
    warnings.push(`visit parent retarget failed: ${err.message}`);
    logger.warn(`[visit-groups] unit move of visit ${plan.visitId}: parent retarget failed: ${err.message}`);
  }

  // ---- 4. detach seam once for every member, then the union ----
  // ONLY after a successful parent retarget (codex r40 uncapped): with the
  // parent still describing the OLD stop, every moved child mismatches it
  // and the seam would detach them all — dissolving the visit and clearing
  // visit_id, so the prescribed re-save enters the UNGROUPED path and can
  // never retarget/reassemble the stop. Skipping the seam preserves the
  // cohort (the page/confirm/calendar/senders all fail closed on the
  // mismatched membership meanwhile), and the re-save's repair pass — or
  // the takeover unit move for stragglers — runs it after a retarget that
  // succeeded. When the retarget DID succeed, the seam keeps its r3
  // contract: landed members match the new parent and stay; a straggler
  // mismatches and is separated.
  if (!parentRetargetFailed) {
    for (const id of plan.memberIds) {
      try { await handleChildStopChanged(id); } catch (err) { logger.warn(`[visit-groups] unit move seam for ${id} failed: ${err.message}`); }
    }
    try {
      await db.transaction(async (t) => {
        const v = await t('service_visits').where({ id: plan.visitId }).first();
        if (v && String(v.status) === 'open') { await lockStop(t, v.stop_base_key); await recomputeVisitWindow(t, v.id); }
      });
    } catch (err) { logger.warn(`[visit-groups] unit move window recompute for ${plan.visitId} failed: ${err.message}`); }
  } else {
    logger.warn(`[visit-groups] unit move of visit ${plan.visitId}: detach seam SKIPPED — the parent retarget failed and the cohort must stay intact for the re-save repair`);
  }

  if (failed.length) {
    warnings.push(`${failed.length} grouped service(s) did not move with this stop — check the visit: ${failed.map((f) => f.reason).join('; ')}`);
    // Partial: the up-front confirmation claims STAY — nobody is auto-texted
    // (owner ruling 2026-08-30); the dispatcher owns the message after the
    // repair (needsAttention carries the straggler ids).
  } else if (parentRetargetFailed) {
    // Every member landed but the visit record still describes the old stop
    // (codex r29 P1): callers classify this as an incomplete move and hold
    // their notices — the reminder sweep must stay quiet too. The hold is
    // KEPT; the staff re-save that repairs the parent runs its own unit
    // move, whose full success releases (or the stamp expires in 24h).
    logger.warn(`[visit-groups] unit move of visit ${plan.visitId}: parent retarget failed — reminder hold kept`);
  } else {
    // Full success: the hold is NOT released here (codex on-merge round) —
    // releasing before the caller's own reminder bookkeeping (dispatch's
    // syncRescheduleReminder + reschedule notice) opens a gap the 15-min
    // sweep can text into, duplicating the route's notice. The caller's
    // post-move handleReschedule sync is the fenced finalizer: its
    // token-keyed repair-release verifies the one-stop + parent tuple and
    // clears the cohort; the healthy no-op repair and the 24h TTL are the
    // backstops if the sync never runs.
    logger.info(`[visit-groups] unit move of visit ${plan.visitId} complete — hold retained for the caller's reminder sync to release`);
  }
  // members: per-row pre-move state so a caller with its own post-move
  // bookkeeping (auto-dispatch restores 'pending' + stamps) can apply it
  // to EVERY row this move touched, not just the tapped one (codex r4).
  // `landed` = the slot the move wrote (date + window bounds the plan asserts)
  // so a caller's post-move bookkeeping can fence its writes on it (a newer
  // move/confirm after the unit move must never be rewound — local audit).
  const members = plan.targets.filter((x) => moved.includes(x.id)).map((x) => ({ id: x.id, isPrimary: x.isPrimary, previousStatus: x.previousStatus, landed: landedState[x.id] || null }));
  // unchanged: members the plan found already at the target (e.g. a
  // windowless sibling on a same-day window move) — represented by this
  // visit's move without a write, so batch callers treat them as covered
  // (codex r19): never re-moved or re-texted as a second stop.
  const unchanged = plan.targets.filter((x) => x.alreadyAtTarget).map((x) => String(x.id));
  // visitStart: the STOP's landed arrival start — the earliest start among
  // the members this move represents (moved + already-at-target) — so a
  // caller's ONE customer notice quotes the stop's window, not the tapped
  // member's (a later chained member moved to 11:00 can shift its 09:00
  // sibling to 10:00: the customer is told 10:00, codex #3609 r25 P1).
  const representedStarts = plan.targets
    .filter((x) => moved.includes(x.id) || x.alreadyAtTarget)
    .map((x) => (landedState[x.id] && landedState[x.id].window_start) || x.startHHMM || null)
    .filter(Boolean).map((v) => String(v).slice(0, 5)).sort();
  const visitStart = representedStarts[0] || null;
  const visitMove = { visitId: plan.visitId, moved, failed, members, unchanged, visitStart, ...(parentRetargetFailed ? { parentRetargetFailed: true } : {}) };
  return { ...(primaryResult || { success: true, newDate }), visitMove, ...(warnings.length ? { warnings } : {}) };
}

module.exports = {
  dateOnly,
  toMinutes,
  // Pure key builder, exported for the reminder cron's visit-scoped email
  // idempotency key (the undelivered-SMS recovery rebuilds it from the
  // visit row — GH codex #3699 r7 P1).
  dedupeKeyFor,
  windowedMembersConnected,
  liveStopStartHHMM,
  incompleteMoveMessage,
  appointmentSendHeld,
  createOrJoinVisit,
  maybeGroupRow,
  customerExcludedByAutopay,
  splitChild,
  handleChildTerminal,
  handleChildStopChanged,
  ensureLegacyCompletable,
  dissolveForLegacyCompletion,
  stopBaseKey,
  lockStop,
  lockStopForRow,
  openMembers,
  visitActivity,
  LIVE_COMPLETION_CLAIM_STATUSES,
  frozenVisitVerdict,
  assertRowMovableAlone,
  fanOutLiveTransition,
  moveVisitAsUnit,
  claimReminderHoldInTx,
  releaseReminderHoldByToken,
  MOVE_HOLD_TTL_MS,
  claimVisitNotification,
  beginVisitNotificationDispatch,
  notificationLeaseLive,
  renewNotificationLease,
  finalizeVisitNotification,
  visitSummariesForRows,
  _test: {
    shiftClock,
    expectMatchesRow,
    siblingEligibleFor,
    visitSummariesForRows,
    windowedMembersConnected,
    stopBaseKey,
    windowsOverlap,
    familiesCompatible,
    canJoin,
    canDissolve,
    canSplit,
    isRowVisitBlocked,
    toMinutes,
    effectTypeForKind,
    dedupeKeyFor,
  },
};
