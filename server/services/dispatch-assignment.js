const db = require('../models/db');
const { getIo } = require('../sockets');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

const ADMIN_ROOM = 'dispatch:admins';
const ADMIN_EVENT = 'dispatch:job_update';
const TERMINAL_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show'];
const BOARD_HIDDEN_STATUSES = ['cancelled', 'rescheduled'];
const TERMINAL_RACE = 'TERMINAL_STATUS_RACE';

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
      db.raw('COALESCE(s.lat, c.latitude) AS lat'),
      db.raw('COALESCE(s.lng, c.longitude) AS lng'),
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
      'c.address_line1',
      'c.address_line2',
      'c.city',
      'c.state',
      'c.zip'
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

async function assignDispatchJob({ jobId, technicianId, actorId, emit = true, trx = null } = {}) {
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

  let tech = null;
  if (newTechId) {
    tech = await conn('technicians').where({ id: newTechId }).first();
    if (!tech) throw httpError(400, 'Unknown technician');
    if (!tech.active) throw httpError(400, 'Technician is inactive');
  }

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
    const rows = await assignmentTrx('scheduled_services')
      .where({ id: jobId })
      .whereNotIn('status', TERMINAL_STATUSES)
      .update({ technician_id: newTechId, updated_at: assignmentTrx.fn.now() })
      .returning('*');
    if (rows.length === 0) {
      throw Object.assign(new Error('terminal status race'), { code: TERMINAL_RACE });
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
    throw err;
  }

  if (emit) {
    const emitUpdate = () => emitDispatchJobUpdate({ jobId, actorId })
      .catch((err) => logger.error(`[dispatch-assignment] broadcast failed for ${jobId}: ${err.message}`));
    if (trx?.executionPromise) {
      trx.executionPromise.then(emitUpdate).catch((err) => {
        logger.error(`[dispatch-assignment] transaction failed before broadcast for ${jobId}: ${err.message}`);
      });
    } else {
      await emitUpdate();
    }
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
