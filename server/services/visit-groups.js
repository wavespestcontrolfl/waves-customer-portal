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

const OPEN_STATUSES = ['open'];
// Terminal scheduled_services statuses (CHECK constraint,
// 20260426000004): rows in these states never join a visit.
const TERMINAL_ROW_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];
// A 'rescheduled' row is a live visit AWAITING RE-PLACEMENT
// (recurring-appointment-seeder.js:834) — its date/window are stale, so it
// never JOINS a visit; it is not terminal for member counting.
const JOIN_INELIGIBLE_STATUSES = [...TERMINAL_ROW_STATUSES, 'rescheduled'];
const ACTIVE_PACKET_STATUSES = ['accepted', 'processing'];

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
async function openMembers(t, visitId) {
  return t('scheduled_services').where({ visit_id: visitId })
    .whereNotIn('status', TERMINAL_ROW_STATUSES)
    .select('id', 'window_start', 'window_end', 'technician_id', 'status');
}

/**
 * Assign a visit's technician onto one member through the canonical
 * assignment writer (codex #3590 r13 P1): assignDispatchJob clears the
 * unassigned-pool route_order, resolves unassigned_overdue alerts, holds
 * the tech-day fence and broadcasts after commit — a bare technician_id
 * write left dispatch state disagreeing with visit ownership. Runs on the
 * caller's transaction; no-op when the row already carries the tech.
 */
async function alignMemberTechnician(t, rowId, technicianId) {
  const { assignDispatchJob } = require('./dispatch-assignment');
  await assignDispatchJob({ jobId: rowId, technicianId, actorId: null, emit: true, trx: t });
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
  const [effects, packets, children] = await Promise.all([
    trx('visit_effects').where({ visit_id: visitId }).whereNot('status', 'pending').first(),
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
    const baseKey = stopBaseKey({
      propertyId: peek[0].property_id,
      customerId: peek[0].customer_id,
      scheduledDate: peek[0].scheduled_date,
    });
    await lockStop(t, baseKey);

    const fresh = await loadRows(t, { lock: true });
    if (fresh.length !== ids.length) throw new Error('createOrJoinVisit: row not found');
    const [first] = fresh;
    const lockedKey = stopBaseKey({
      propertyId: first.property_id,
      customerId: first.customer_id,
      scheduledDate: first.scheduled_date,
    });
    if (lockedKey !== baseKey) {
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
      .whereIn('status', ['pending', 'side_effects_pending', 'side_effects_running', 'succeeded'])
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

    const remaining = await t('scheduled_services')
      .where({ visit_id: visitId })
      .whereNotIn('status', TERMINAL_ROW_STATUSES)
      .count('id as n').first();
    let dissolved = false;
    if (Number(remaining.n) <= 1) {
      const still = await visitActivity(visitId, t);
      if (canDissolve(still).ok) {
        await t('scheduled_services').where({ visit_id: visitId }).update({ visit_id: null });
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
async function ensureLegacyCompletable(scheduledServiceId) {
  const row = await db('scheduled_services').where({ id: scheduledServiceId }).first('id', 'visit_id');
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.visit_id) return { ok: true };
  const visit = await db('service_visits').where({ id: row.visit_id }).first('id', 'status');
  if (!visit) return { ok: false, reason: 'orphan', visitId: row.visit_id }; // fail closed
  if (String(visit.status) === 'dissolved') return { ok: true };
  if (['closing', 'closed'].includes(String(visit.status))) {
    return { ok: false, reason: 'visit_' + visit.status, visitId: visit.id };
  }
  const packet = await db('visit_completion_packets').where({ visit_id: visit.id }).first('id');
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
async function maybeGroupRow(rowId, { createdBy, database = db } = {}) {
  const { gates } = require('../config/feature-gates');
  if (!gates.visitGroups) return null;
  try {
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
      // Inside a caller transaction (converter/seeder) the work must run
      // on that trx (its uncommitted rows are invisible elsewhere), but a
      // grouping failure must not abort the caller's transaction (25P02
      // poisons every later statement) — so run inside a SAVEPOINT
      // (knex nested transaction) and let the catch below swallow the
      // rolled-back savepoint (codex #3590 r4).
      return await database.transaction((sp) => createOrJoinVisit({ rows, createdBy: createdBy || 'dispatch', trx: sp }));
    }
    return await createOrJoinVisit({ rows, createdBy: createdBy || 'dispatch' });
  } catch (err) {
    const logger = require('./logger');
    logger.warn(`[visit-groups] maybeGroupRow(${rowId}) skipped: ${err.message}`);
    return null;
  }
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
const LIVE_TRANSITION_FROM = Object.freeze({
  en_route: ['pending', 'confirmed', 'rescheduled'],
  on_site: ['pending', 'confirmed', 'rescheduled', 'en_route'],
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
 * Returns 'owner' | 'taken' | 'detached' | 'error' | null (no visit).
 */
async function claimVisitNotification(row, kind) {
  if (!row || !row.visit_id) return null;
  const effectType = kind === 'en_route' ? 'tracker_en_route' : 'tracker_arrived';
  const logger = require('./logger');
  try {
    return await db.transaction(async (t) => {
      const visit = await t('service_visits').where({ id: row.visit_id }).first();
      if (!visit || String(visit.status) !== 'open') return 'detached';
      await lockStop(t, visit.stop_base_key);
      const fresh = await t('scheduled_services').where({ id: row.id }).forUpdate().first('id', 'visit_id');
      if (!fresh || String(fresh.visit_id || '') !== String(visit.id)) return 'detached';
      const rows = await t('visit_effects')
        .insert({
          visit_id: visit.id,
          effect_type: effectType,
          dedupe_key: `${visit.id}:${effectType}`,
          status: 'claimed',
          attempts: 0,
          claimed_at: new Date(),
        })
        .onConflict(['visit_id', 'effect_type', 'dedupe_key'])
        .ignore()
        .returning('id');
      return rows && rows.length ? 'owner' : 'taken';
    });
  } catch (err) {
    logger.warn(`[visit-groups] notification claim ${effectType} for visit ${row.visit_id} failed: ${err.message}`);
    return 'error';
  }
}

/**
 * Advance the claimed ledger row with the owner's ACTUAL attempt outcome
 * (codex r4/r5): sent / suppressed / failed; attempts counted; a sent row
 * is never downgraded. Non-attempt outcomes are a no-op. Its own checked
 * step: a failure here leaves the row `claimed`, so the caller reports the
 * stop incomplete instead of advertising a status that was never written.
 */
async function finalizeVisitNotification(visitId, kind, smsOutcome, at = new Date()) {
  const effectType = kind === 'en_route' ? 'tracker_en_route' : 'tracker_arrived';
  if (!visitId || !NOTIFICATION_ATTEMPT_OUTCOMES.has(String(smsOutcome))) return { ok: true, skipped: true, effectType, status: null };
  const status = smsOutcome === 'sent' ? 'sent' : smsOutcome === 'retry' ? 'failed' : 'suppressed';
  try {
    await db('visit_effects')
      .insert({
        visit_id: visitId,
        effect_type: effectType,
        dedupe_key: `${visitId}:${effectType}`,
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
      .where('visit_effects.status', '<>', 'sent');
    return { ok: true, effectType, status };
  } catch (err) {
    require('./logger').warn(`[visit-groups] visit ${visitId} ${kind}: visit_effects finalize failed: ${err.message}`);
    return { ok: false, effectType, status, reason: `effect finalize failed: ${err.message}` };
  }
}

const NOTIFICATION_ATTEMPT_OUTCOMES = new Set(['sent', 'suppressed', 'retry', 'gate_off']);

async function fanOutLiveTransition({ primary, kind, actorType = 'tech', actorId = null, smsOutcome = null, notificationOwner = false }) {
  const toStatus = kind === 'en_route' ? 'en_route' : kind === 'on_site' ? 'on_site' : null;
  if (!primary || !primary.visit_id || !toStatus) return null;
  const targetTrack = kind === 'en_route' ? 'en_route' : 'on_property';
  const logger = require('./logger');
  const lifecycleAt = new Date();
  let fan = null;
  try {
    fan = await db.transaction(async (t) => {
      const visit = await t('service_visits').where({ id: primary.visit_id }).first();
      if (!visit || String(visit.status) !== 'open') return null;
      await lockStop(t, visit.stop_base_key);
      // Revalidate the PRIMARY under the stop lock (codex #3603 r2): a split
      // or stop change can detach it between the tracker's row load and
      // this lock — the tracker CAS does not predicate on visit_id. Only a
      // primary that is still this visit's member, on the same technician,
      // and actually at the target status leads its siblings.
      const lockedPrimary = await t('scheduled_services').where({ id: primary.id }).forUpdate()
        .first('id', 'visit_id', 'technician_id', 'status');
      if (!lockedPrimary
          || String(lockedPrimary.visit_id || '') !== String(visit.id)
          || String(lockedPrimary.technician_id || '') !== String(primary.technician_id || '')
          || String(lockedPrimary.status) !== toStatus) {
        logger.warn(`[visit-groups] ${kind} fan-out for ${primary.id}: primary no longer leads visit ${visit.id} (visit=${lockedPrimary && lockedPrimary.visit_id}, status=${lockedPrimary && lockedPrimary.status}) — skipped`);
        return null;
      }
      const siblings = await t('scheduled_services')
        .where({ visit_id: visit.id })
        .whereNot('id', primary.id)
        .whereNotIn('status', TERMINAL_ROW_STATUSES)
        .forUpdate()
        .select('id', 'status', 'technician_id', 'track_state', 'source_action', 'customer_confirmed',
          'actual_start_time', 'check_in_time', 'arrived_at');
      const { transitionJobStatus } = require('./job-status');
      const { isPendingOutboundReviewBooking } = require('./call-booking-source-actions');
      const moved = [];
      const trackers = [];
      const covered = [];
      const skipped = [];
      for (const s of siblings) {
        // Exact technician equality — an unassigned sibling is NOT the
        // primary's tech's to advance (codex r1): the visit owns assignment,
        // so a null here is an inconsistency to surface, not a wildcard.
        if (String(s.technician_id || '') !== String(primary.technician_id || '')) {
          skipped.push({ id: s.id, reason: 'technician' });
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
      const r = kind === 'en_route'
        ? await trackTransitions.markEnRoute(id, { actorType, actorId, suppressCustomerSms: true, _visitSibling: true })
        : await trackTransitions.markOnProperty(id, { actingTechId: actorId, actorType, actorId, suppressArrivalSms: true, _visitSibling: true });
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
  if (fan.covered.length) {
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
    const fin = await finalizeVisitNotification(fan.visitId, kind, smsOutcome, lifecycleAt);
    if (fin.ok) effect = { effectType: fin.effectType, status: fin.status };
    else trackerFailures.push({ id: 'effect_finalize', reason: fin.reason });
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

module.exports = {
  createOrJoinVisit,
  maybeGroupRow,
  splitChild,
  handleChildTerminal,
  handleChildStopChanged,
  ensureLegacyCompletable,
  dissolveForLegacyCompletion,
  stopBaseKey,
  lockStopForRow,
  openMembers,
  visitActivity,
  fanOutLiveTransition,
  claimVisitNotification,
  finalizeVisitNotification,
  visitSummariesForRows,
  _test: {
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
  },
};
