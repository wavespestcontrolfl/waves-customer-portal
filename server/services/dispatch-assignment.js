const db = require('../models/db');
const { getIo } = require('../sockets');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { stampedDivergesSql, stampedLine2Sql } = require('./stamped-address');
const { assertAssignableTechnician } = require('./technician-eligibility');

const ADMIN_ROOM = 'dispatch:admins';
const ADMIN_EVENT = 'dispatch:job_update';
const TERMINAL_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];
const BOARD_HIDDEN_STATUSES = ['cancelled', 'rescheduled'];
const TERMINAL_RACE = 'TERMINAL_STATUS_RACE';
const ASSIGNMENT_RACE = 'ASSIGNMENT_RACE';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function addressFromRow(row) {
  if (!row?.address_line1) return '';
  const line2 = row.address_line2 ? ` ${row.address_line2}` : '';
  const city = row.city ? `, ${row.city}` : '';
  const stateZip = row.state ? `, ${row.state}${row.zip ? ` ${row.zip}` : ''}` : '';
  return `${row.address_line1}${line2}${city}${stateZip}`.trim();
}

function customerDisplayName(row) {
  const first = row?.first_name || '';
  const lastInitial = row?.last_name ? row.last_name.trim().charAt(0).toUpperCase() : '';
  if (first && lastInitial) return `${first} ${lastInitial}.`;
  return first || null;
}

async function buildDispatchJobUpdatePayload(jobId, actorId) {
  const row = await db('scheduled_services as s')
    .leftJoin('technicians as t', 's.technician_id', 't.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.id', jobId)
    .first(
      's.id as job_id',
      's.customer_id',
      's.technician_id as tech_id',
      // Same stamped-address rules as the board hydration query — these
      // payloads MERGE into board state on every assignment/status/reschedule
      // broadcast, so a plain c.* here would overwrite the corrected rental
      // address/pin with the primary home (codex round-7 P1).
      db.raw(`COALESCE(s.lat, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.latitude END) AS lat`),
      db.raw(`COALESCE(s.lng, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.longitude END) AS lng`),
      's.status',
      's.service_type',
      's.scheduled_date',
      's.window_start',
      's.window_end',
      's.notes',
      's.internal_notes',
      's.updated_at',
      't.name as tech_full_name',
      'c.first_name as cust_first_name',
      'c.first_name',
      'c.last_name',
      db.raw('COALESCE(s.service_address_line1, c.address_line1) as address_line1'),
      db.raw(`${stampedLine2Sql('s', 'c')} as address_line2`),
      db.raw('COALESCE(s.service_address_city, c.city) as city'),
      db.raw('COALESCE(s.service_address_state, c.state) as state'),
      db.raw('COALESCE(s.service_address_zip, c.zip) as zip')
    );

  if (!row) return null;
  const scheduledDate = dateOnly(row.scheduled_date);
  const boardVisible = scheduledDate === etDateString()
    && !BOARD_HIDDEN_STATUSES.includes(row.status);

  return {
    job_id: row.job_id,
    customer_id: row.customer_id,
    cust_first_name: row.cust_first_name,
    customer_name: customerDisplayName(row),
    address: addressFromRow(row),
    lat: row.lat == null ? null : Number(row.lat),
    lng: row.lng == null ? null : Number(row.lng),
    status: row.status,
    from_status: row.status,
    tech_id: row.tech_id,
    tech_full_name: row.tech_full_name,
    service_type: row.service_type,
    scheduled_date: scheduledDate,
    window_start: row.window_start,
    window_end: row.window_end,
    notes: row.notes,
    internal_notes: row.internal_notes,
    transitioned_by: actorId || null,
    updated_at: row.updated_at,
    board_visible: boardVisible,
  };
}

async function emitDispatchJobUpdate({ jobId, actorId }) {
  const payload = await buildDispatchJobUpdatePayload(jobId, actorId);
  if (!payload) return null;

  const io = getIo();
  if (!io) {
    logger.warn('[dispatch-assignment] io not initialized; skipping dispatch:job_update');
    return payload;
  }
  io.to(ADMIN_ROOM).emit(ADMIN_EVENT, payload);
  return payload;
}

async function assignDispatchJob({ jobId, technicianId, actorId, emit = true, trx = null, skipVisitSeam = false, expectTechnicianId, noticeSnapshot = null, noticeActorId } = {}) {
  if (!jobId) throw httpError(400, 'jobId is required');
  if (technicianId === undefined) throw httpError(400, 'technicianId required');
  if (technicianId !== null && typeof technicianId !== 'string') {
    throw httpError(400, 'technicianId must be a UUID string or null');
  }
  const newTechId = technicianId || null;
  const conn = trx || db;

  const job = await conn('scheduled_services').where({ id: jobId }).first();
  if (!job) throw httpError(404, 'Job not found');
  if (TERMINAL_STATUSES.includes(job.status)) {
    throw httpError(409, `Cannot reassign a ${job.status} job`);
  }
  // Planned-baseline fence (codex #3609 local audit): a caller that planned
  // this reassignment from an earlier read (the unit mover's locked plan)
  // passes the technician it expected to find; a newer operator assignment
  // must not be overwritten with the older plan. The in-trx CAS below then
  // pins that same baseline through the locks.
  if (expectTechnicianId !== undefined && (job.technician_id || null) !== (expectTechnicianId || null)) {
    throw Object.assign(httpError(409, 'Job was reassigned concurrently - the planned technician is stale'), { code: 'ASSIGNMENT_STALE' });
  }

  // Save-time eligibility (422 TECH_NOT_ASSIGNABLE): a stale board that still
  // offers a tech who has since gone prospective/inactive/office-only cannot
  // complete the assignment.
  const tech = newTechId ? await assertAssignableTechnician(newTechId, { conn }) : null;

  if ((job.technician_id || null) === newTechId) {
    return {
      job: { ...job, technician_id: newTechId },
      technicianName: tech?.name || null,
      changed: false,
    };
  }

  const fromTechId = job.technician_id || null;
  let updatedRow;
  const applyAssignment = async (assignmentTrx) => {
    // Re-checked FOR SHARE on the writing trx: a Team-tab offboarding or
    // field-eligibility removal (FOR UPDATE) cannot slip between the
    // pre-transaction read above and this commit.
    if (newTechId) await assertAssignableTechnician(newTechId, { conn: assignmentTrx });
    // Tech-day membership fence (scheduling/tech-day-lock.js): reassignment
    // moves the stop between two tech-days on the same date — the nightly
    // reorder's membership read is only safe against writers holding the
    // same 'slot-reserve' lock. Date key comes from Postgres itself
    // (to_char) so it collides with the other holders' keys regardless of
    // how the driver parses DATE columns. route_order: null drops the OLD
    // tech's sequence number — consumers append NULLs last; carrying the
    // stale number would interleave it into the new tech's run.
    const { lockTechDays } = require('./scheduling/tech-day-lock');
    const dayRow = await assignmentTrx('scheduled_services')
      .where({ id: jobId })
      .first(assignmentTrx.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));
    if (dayRow?.day) {
      await lockTechDays(assignmentTrx, [
        { techId: fromTechId, date: dayRow.day },
        { techId: newTechId, date: dayRow.day },
      ]);
    }
    // CAS on the PRE-LOCK tech + day (uncapped audit r29 P1): job and
    // fromTechId were read before the advisory locks, so a writer that
    // committed while we waited may have already assigned this job (its
    // fresh route_order must NOT be cleared by our stale no-op) or moved it
    // to a third tech/day whose fence we never took. A miss below is a
    // conflict, never a silent apply.
    const rows = await assignmentTrx('scheduled_services')
      .where({ id: jobId })
      .whereNotIn('status', TERMINAL_STATUSES)
      .whereRaw('technician_id IS NOT DISTINCT FROM ?', [fromTechId])
      .modify((q) => { if (dayRow?.day) q.whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [dayRow.day]); })
      .update({ technician_id: newTechId, route_order: null, updated_at: assignmentTrx.fn.now() })
      .returning('*');
    if (rows.length === 0) {
      const live = await assignmentTrx('scheduled_services')
        .where({ id: jobId })
        .first('status');
      if (!live || TERMINAL_STATUSES.includes(live.status)) {
        throw Object.assign(new Error('terminal status race'), { code: TERMINAL_RACE });
      }
      throw Object.assign(new Error('assignment race'), { code: ASSIGNMENT_RACE });
    }
    updatedRow = rows[0];

    if (!fromTechId && newTechId) {
      const { resolveAlert } = require('./dispatch-alerts');
      const openAlerts = await assignmentTrx('dispatch_alerts')
        .where({ type: 'unassigned_overdue', job_id: jobId })
        .whereNull('resolved_at')
        .select('id');
      for (const { id } of openAlerts) {
        await resolveAlert({ id, resolvedBy: actorId, trx: assignmentTrx });
      }
    }
  };

  try {
    if (trx) await applyAssignment(trx);
    else await db.transaction(applyAssignment);
  } catch (err) {
    if (err && err.code === TERMINAL_RACE) {
      throw httpError(409, 'Cannot reassign - job transitioned to a terminal state concurrently');
    }
    if (err && err.code === ASSIGNMENT_RACE) {
      throw httpError(409, 'Job was reassigned or rescheduled concurrently - reload and retry');
    }
    throw err;
  }

  // Tech-facing notice (tech-visit-notifications.js): the previous holder
  // hears the stop left their route, the new one hears it arrived. Runs after
  // the outermost commit, best-effort; silent for the actor's own move, for a
  // non-assignable recipient, and while GATE_TECH_VISIT_NOTIFICATIONS is off.
  // `noticeSnapshot`: a caller whose SAME transaction also rewrites the
  // schedule after this call (the edit modal: tech + date in one save)
  // passes the final date/window it is about to write, so the new tech's
  // card names the schedule that will commit, not the row as it stood here.
  // `noticeActorId`: who the CARD names when that is not the staff row in
  // `actorId` — a customer moving a grouped stop online (visit-groups).
  // `actorId` also stamps dispatch_alerts.resolved_by and the broadcast, so
  // a system label must never ride it (codex r9 P2).
  const rowSnapshot = { date: updatedRow.scheduled_date, windowStart: updatedRow.window_start, windowEnd: updatedRow.window_end };
  const overrides = Object.fromEntries(Object.entries(noticeSnapshot || {}).filter(([, v]) => v !== undefined));
  void require('./tech-visit-notifications').notifyAssignmentChange({
    visitId: jobId, fromTechId, toTechId: newTechId, actorId: noticeActorId === undefined ? actorId : noticeActorId, trx,
    snapshot: { ...rowSnapshot, ...overrides },
  });

  if (emit) {
    const emitUpdate = () => emitDispatchJobUpdate({ jobId, actorId })
      .catch((err) => logger.error(`[dispatch-assignment] broadcast failed for ${jobId}: ${err.message}`));
    // Hooks wait for the OUTERMOST commit — a savepoint's own promise
    // resolves at savepoint release (codex #3590 r14).
    const { commitPromiseOf } = require('../utils/trx-commit-promise');
    const commitPromise = commitPromiseOf(trx);
    if (commitPromise) {
      commitPromise.then(emitUpdate).catch((err) => {
        logger.error(`[dispatch-assignment] transaction failed before broadcast for ${jobId}: ${err.message}`);
      });
    } else {
      await emitUpdate();
    }
  }

  // Visit-group seam (visit-group-scope.md §2, rev-5 item 6): the visit
  // owns the technician — a routine single-row reassignment that now
  // conflicts with its visit's tech detaches the row (full visit-level
  // assignment lands with the grouped route card PR). Best-effort,
  // post-commit; skipped inside a caller trx (uncommitted row invisible
  // to the helper's own transaction) — those callers re-run assignment
  // through this writer on commit paths that matter.
  const runVisitSeam = () => require('./visit-groups').handleChildStopChanged(jobId)
    .catch((vgErr) => logger.warn(`[dispatch-assignment] visit-group seam failed for ${jobId}: ${vgErr.message}`));
  // skipVisitSeam (codex #3609 r16): the unit mover re-points EVERY member
  // and the parent itself, then runs the seam once per member after the
  // retarget — a per-row seam here would observe a half-reassigned visit
  // (mixed technicians) and detach the first sibling for good.
  // Assignment-only cohort repair (codex #3609 on-merge r2): fixing a
  // straggler's technician changes no slot, so no handleReschedule
  // finalizer runs — without this, a repaired stop's retained reminder
  // hold outlived the fix until the 24h TTL. The shared verified release
  // (one-stop + parent-tuple checks inside) is a no-op when no hold or an
  // unrepaired cohort exists. Best-effort, post-commit.
  const runHoldRepair = () => require('./appointment-reminders').releaseMoveHoldIfRepaired(jobId)
    .catch((hrErr) => logger.warn(`[dispatch-assignment] move-hold repair check failed for ${jobId}: ${hrErr.message}`));
  const seamCommitPromise = skipVisitSeam ? null : require('../utils/trx-commit-promise').commitPromiseOf(trx);
  if (skipVisitSeam) {
    // no seam — the caller owns it (the unit mover's own finalizers run)
  } else if (seamCommitPromise) {
    // Transactional callers (admin-schedule assign) — run after THEIR
    // outermost commit, same pattern as the broadcast above (codex #3590
    // r4: the canonical schedule-assignment route always passes a trx;
    // r14: savepoint callers hook the enclosing transaction).
    seamCommitPromise.then(runVisitSeam).then(runHoldRepair).catch(() => {});
  } else {
    await runVisitSeam();
    await runHoldRepair();
  }

  return {
    job: updatedRow,
    technicianName: tech?.name || null,
    changed: true,
  };
}

module.exports = {
  assignDispatchJob,
  emitDispatchJobUpdate,
  buildDispatchJobUpdatePayload,
  _test: {
    dateOnly,
    addressFromRow,
    customerDisplayName,
  },
};
