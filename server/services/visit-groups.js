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
const TERMINAL_ROW_STATUSES = ['completed', 'cancelled', 'skipped'];
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
  if (TERMINAL_ROW_STATUSES.includes(String(row.status || ''))) {
    return { ok: false, reason: 'row_terminal' };
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
      if (TERMINAL_ROW_STATUSES.includes(String(r.status || ''))) {
        throw new Error('visit membership conflict: a row is already terminal');
      }
      if (!r.groupable || !r.group_family) {
        throw new Error('rows not mutually groupable: not_groupable');
      }
    }
    // One technician owns the visit (doc §2 rev 5): all non-null
    // assignments across the input rows must agree.
    const rowTechs = [...new Set(fresh.map((r) => r.technician_id).filter(Boolean).map(String))];
    if (rowTechs.length > 1) throw new Error('rows not mutually groupable: technician');
    for (const r of fresh.slice(1)) {
      const probe = canJoin(r, { ...first, status: 'open' });
      if (!probe.ok) throw new Error(`rows not mutually groupable: ${probe.reason}`);
    }

    let visit = null;
    if (attachedVisitIds.length === 1) {
      // Join-to-existing: some rows already belong to one visit — the rest
      // may only join THAT visit, and only while it is open and eligible.
      const target = await t('service_visits').where({ id: attachedVisitIds[0] }).first();
      if (!target || String(target.status) !== 'open' || target.stop_base_key !== baseKey) {
        throw new Error('visit membership conflict: attached visit not open for joining');
      }
      for (const r of fresh) {
        if (r.visit_id) continue; // already a member
        const probe = canJoin(r, target);
        if (!probe.ok) throw new Error(`rows not mutually groupable: ${probe.reason}`);
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
        if (fresh.every((r) => canJoin(r, v).ok)) { visit = v; break; }
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
    const liveAttempt = await t('service_completion_attempts')
      .whereIn('service_id', ids)
      .whereIn('status', ['pending', 'side_effects_pending', 'side_effects_running', 'succeeded'])
      .first('id')
      .catch(() => null);
    if (liveAttempt) {
      throw new Error('visit membership conflict: a completion attempt is in flight');
    }

    const unattachedIds = fresh.filter((r) => !r.visit_id).map((r) => r.id);
    const stamped = unattachedIds.length
      ? await t('scheduled_services')
        .whereIn('id', unattachedIds)
        .whereNull('visit_id')
        .update({ visit_id: visit.id, ...(visit.technician_id ? { technician_id: visit.technician_id } : {}) })
      : 0;
    if (Number(stamped) !== unattachedIds.length) {
      throw new Error('visit membership conflict: a row is attached to another visit');
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
      if (err && err.code === 'VISIT_STOP_MOVED') { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Explicit split (doc §2): move one child to a fresh visit (new stop_seq)
 * subject to the membership freeze. Dissolves the source when one row
 * remains AND dissolution conditions still hold; otherwise the source stays
 * a preserved one-service visit.
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

    const seq = await nextStopSeq(t, visit.stop_base_key);
    const [fresh] = await t('service_visits')
      .insert({
        customer_id: visit.customer_id,
        property_id: visit.property_id,
        scheduled_date: visit.scheduled_date,
        window_start: child.window_start || visit.window_start,
        window_end: child.window_end || visit.window_end,
        stop_base_key: visit.stop_base_key,
        stop_seq: seq,
        technician_id: child.technician_id || null,
        group_family: visit.group_family,
        status: 'open',
        created_by: createdBy || 'admin:unknown',
      })
      .returning('*');
    await t('scheduled_services').where({ id: child.id }).update({ visit_id: fresh.id });

    const remaining = await t('scheduled_services').where({ visit_id: visitId }).count('id as n').first();
    if (Number(remaining.n) <= 1) {
      const still = await visitActivity(visitId, t);
      if (canDissolve(still).ok) {
        await t('scheduled_services').where({ visit_id: visitId }).update({ visit_id: null });
        await t('service_visits').where({ id: visitId })
          .update({ status: 'dissolved', close_reason: 'operator', closed_at: t.fn.now() });
      }
    }
    return fresh;
  });
}

/**
 * Auto-dissolve when a cancel/skip leaves one untouched row (doc §2).
 */
async function dissolveIfLastRow({ visitId }) {
  return db.transaction(async (t) => {
    const visit = await t('service_visits').where({ id: visitId }).first();
    if (!visit || visit.status !== 'open') return false;
    await lockStop(t, visit.stop_base_key);
    const remaining = await t('scheduled_services').where({ visit_id: visitId }).count('id as n').first();
    if (Number(remaining.n) > 1) return false;
    const activity = await visitActivity(visitId, t);
    if (!canDissolve(activity).ok) return false;
    await t('scheduled_services').where({ visit_id: visitId }).update({ visit_id: null });
    await t('service_visits').where({ id: visitId })
      .update({ status: 'dissolved', close_reason: 'row_cancelled', closed_at: t.fn.now() });
    return true;
  });
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
        'ss.status', 'ss.visit_id', 'svc.groupable', 'svc.group_family');
    if (!row || row.visit_id || !row.groupable || !row.group_family) return null;
    if (TERMINAL_ROW_STATUSES.includes(String(row.status || ''))) return null;
    const partnersQ = database('scheduled_services as ss')
      .leftJoin('services as svc', 'ss.service_id', 'svc.id')
      .leftJoin('service_visits as sv', 'sv.id', 'ss.visit_id')
      .where('ss.customer_id', row.customer_id)
      .where('ss.scheduled_date', dateOnly(row.scheduled_date))
      .whereNot('ss.id', row.id)
      .whereNotIn('ss.status', TERMINAL_ROW_STATUSES)
      .where('svc.groupable', true)
      .where('svc.group_family', row.group_family)
      .where((q) => q.whereNull('ss.visit_id').orWhere('sv.status', 'open'))
      .select('ss.id');
    if (row.property_id) partnersQ.where('ss.property_id', row.property_id);
    else partnersQ.whereNull('ss.property_id');
    const partners = await partnersQ.limit(10);
    if (!partners.length) return null;
    return await createOrJoinVisit({
      rows: [{ id: row.id }, ...partners.map((p) => ({ id: p.id }))],
      createdBy: createdBy || 'dispatch',
      // Inside a caller transaction (converter/seeder), group on the SAME
      // trx — the new rows aren't visible outside it and a second
      // transaction would deadlock against its row locks.
      trx: database && database.isTransaction ? database : null,
    });
  } catch (err) {
    const logger = require('./logger');
    logger.warn(`[visit-groups] maybeGroupRow(${rowId}) skipped: ${err.message}`);
    return null;
  }
}

module.exports = {
  createOrJoinVisit,
  maybeGroupRow,
  splitChild,
  dissolveIfLastRow,
  visitActivity,
  _test: {
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
