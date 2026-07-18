const db = require('../models/db');
const logger = require('./logger');
const {
  STAFF_WORK_DATE_SQL,
  staffWeekRange,
  staffWeekStartForWorkDate,
  staffWorkDate,
  staffWorkDateSql,
  validateWorkDate,
} = require('../utils/staff-time-work-date');
const {
  ACTIVE_WRITE_GENERATION,
  WEEKLY_OT_THRESHOLD_MINUTES,
} = require('../constants/staff-time');

const UNDO_STOP_WINDOW_MINUTES = 30;
const PAYROLL_SCALE = 100n;

// PostgreSQL NUMERIC(..., 2) and ROUND(numeric, 2) round exact decimal values
// half away from zero. JavaScript's binary floating-point Math.round can land
// one cent lower at boundaries such as 64.725. Keep payroll arithmetic in
// integer hundredths so writers and the rollout audit share one definition.
function payrollUnits(value) {
  if (value == null || value === '') return 0n;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? BigInt(Math.round(numeric * 100)) : 0n;
  }

  const negative = match[1] === '-';
  const fraction = match[3] || '';
  let units = BigInt(match[2]) * PAYROLL_SCALE
    + BigInt((fraction.slice(0, 2) || '').padEnd(2, '0'));
  if (fraction.length > 2 && fraction[2] >= '5') units += 1n;
  return negative ? -units : units;
}

function payrollNumber(units) {
  return Number(units) / Number(PAYROLL_SCALE);
}

function roundPayroll(value) {
  return payrollNumber(payrollUnits(value));
}

function roundedPayrollRatio(numeratorUnits, denominatorUnits, hundredthsFactor) {
  if (denominatorUnits === 0n) return 0;
  const scaled = numeratorUnits * hundredthsFactor;
  const negative = (scaled < 0n) !== (denominatorUnits < 0n);
  const absoluteScaled = scaled < 0n ? -scaled : scaled;
  const absoluteDenominator = denominatorUnits < 0n ? -denominatorUnits : denominatorUnits;
  let quotient = absoluteScaled / absoluteDenominator;
  const remainder = absoluteScaled % absoluteDenominator;
  if (remainder * 2n >= absoluteDenominator) quotient += 1n;
  return payrollNumber(negative ? -quotient : quotient);
}

// Payroll durations are stored at hundredths of a minute. A real positive
// interval shorter than half that resolution would normally round to 0.00,
// which the approval and rollout audit correctly reject. Preserve the fact
// that time elapsed by quantizing every positive interval to at least 0.01.
function roundCompletedDuration(clockIn, clockOut) {
  const elapsedMinutes = (new Date(clockOut) - new Date(clockIn)) / 60000;
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) {
    throw staffTimeHttpError(409, 'Timer timestamps are invalid; reload and retry the stop.');
  }
  return Math.max(0.01, roundPayroll(elapsedMinutes));
}

function completedDurationSql(trx, clockOut) {
  return trx.raw(
    'GREATEST(0.01::numeric, ROUND((EXTRACT(EPOCH FROM (? - clock_in)) / 60)::numeric, 2))',
    [clockOut],
  );
}

/**
 * Clock in a technician for a new shift.
 */
async function clockIn(technicianId, { lat, lng, notes, source } = {}) {
  // There is no active-shift row to lock on the first clock-in. Serialize the
  // check-and-insert on the stable technician row until the deferred partial
  // unique active-timer index can be installed after rollout.
  const entry = await db.transaction(async (trx) => {
    const technician = await trx('technicians')
      .where({ id: technicianId, active: true })
      .forUpdate()
      .first('id');
    if (!technician) {
      const error = staffTimeHttpError(
        409,
        'Staff account is inactive; clock-in was cancelled.',
      );
      error.code = 'ACCOUNT_INACTIVE';
      throw error;
    }

    const existing = await trx('time_entries')
      .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' })
      .first();
    if (existing) {
      throw new Error('Already clocked in. Clock out before starting a new shift.');
    }

    const now = new Date();
    const [created] = await trx('time_entries')
      .insert({
        technician_id: technicianId,
        entry_type: 'shift',
        status: 'active',
        clock_in: now,
        clock_in_lat: lat || null,
        clock_in_lng: lng || null,
        notes: notes || null,
        source: source || 'app',
        staff_write_generation: ACTIVE_WRITE_GENERATION,
      })
      .returning('*');
    return created;
  });

  logger.info(`[time-tracking] Tech ${technicianId} clocked in`, { entryId: entry.id });
  return entry;
}

async function lockActiveShift(trx, technicianId, shiftId) {
  let query = trx('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' });
  if (shiftId) query = query.where({ id: shiftId });
  return query.forUpdate().first();
}

function appendEntryNote(existing, note) {
  if (!note) return existing;
  return `${existing ? `${existing}; ` : ''}${note}`;
}

/**
 * Close a shift and every active child while holding the shift row lock.
 * startJob/startBreak/reopenStoppedEntry take the same lock before creating an
 * active child, so no child can commit after this transaction closes them.
 */
async function closeActiveShiftAtomically(technicianId, options = {}) {
  return db.transaction(async (trx) => {
    const activeShift = await lockActiveShift(trx, technicianId, options.shiftId);
    if (!activeShift) {
      if (options.missingError) throw new Error(options.missingError);
      return null;
    }

    // Capture the close time only after acquiring the lock. A child-start
    // transaction may have held it; using a pre-lock timestamp could produce
    // a negative duration for the child that just committed.
    const now = options.now || new Date();
    const childUpdates = {
      status: 'completed',
      clock_out: now,
      duration_minutes: completedDurationSql(trx, now),
      updated_at: now,
    };
    if (options.childNoteSuffix) {
      childUpdates.notes = trx.raw("COALESCE(notes, '') || ?", [options.childNoteSuffix]);
    }

    await trx('time_entries')
      .where({ technician_id: technicianId, status: 'active' })
      .whereIn('entry_type', ['job', 'break', 'drive', 'admin_time'])
      .update(childUpdates);

    const duration = roundCompletedDuration(activeShift.clock_in, now);
    const shiftUpdates = {
      status: 'completed',
      clock_out: now,
      duration_minutes: duration,
      notes: appendEntryNote(activeShift.notes, options.shiftNote),
      updated_at: now,
    };
    if (options.includeLocation) {
      shiftUpdates.clock_out_lat = options.lat || null;
      shiftUpdates.clock_out_lng = options.lng || null;
    }

    const [entry] = await trx('time_entries')
      .where({ id: activeShift.id, status: 'active' })
      .update(shiftUpdates)
      .returning('*');

    return {
      entry,
      activeShift,
      duration,
      workDate: staffWorkDate(activeShift.clock_in),
    };
  });
}

/**
 * Clock out a technician, closing any open sub-entries first.
 */
async function clockOut(technicianId, { lat, lng, notes } = {}) {
  const closed = await closeActiveShiftAtomically(technicianId, {
    includeLocation: true,
    lat,
    lng,
    shiftNote: notes,
    missingError: 'Not currently clocked in.',
  });

  // Compute daily summary
  await computeDailySummary(technicianId, closed.workDate);

  logger.info(`[time-tracking] Tech ${technicianId} clocked out`, {
    entryId: closed.entry.id,
    duration: closed.entry.duration_minutes,
  });
  return closed.entry;
}

/**
 * Start a job entry (tech must be clocked in).
 */
async function startJob(technicianId, jobId, { lat, lng } = {}) {
  // Keep replacement atomic across writer-generation cutovers. If this app
  // generation is stale, its insert is rejected by the active-write CHECK;
  // the transaction then rolls back the preceding close instead of leaving
  // the technician without an active job timer.
  const entry = await db.transaction(async (trx) => {
    const activeShift = await lockActiveShift(trx, technicianId);

    if (!activeShift) {
      throw new Error('Must be clocked in to start a job.');
    }

    // Close any other active job entry.
    const now = new Date();
    await trx('time_entries')
      .where({ technician_id: technicianId, entry_type: 'job', status: 'active' })
      .update({
        status: 'completed',
        clock_out: now,
        duration_minutes: completedDurationSql(trx, now),
        updated_at: now,
      });

    // Lookup job details.
    let customerId = null;
    let serviceType = null;
    if (jobId) {
      const job = await trx('scheduled_services').where({ id: jobId }).first();
      if (job) {
        customerId = job.customer_id;
        serviceType = job.service_type;
      }
    }

    const [created] = await trx('time_entries')
      .insert({
        technician_id: technicianId,
        entry_type: 'job',
        status: 'active',
        clock_in: now,
        clock_in_lat: lat || null,
        clock_in_lng: lng || null,
        job_id: jobId || null,
        customer_id: customerId,
        service_type: serviceType,
        source: 'app',
        staff_write_generation: ACTIVE_WRITE_GENERATION,
      })
      .returning('*');
    return created;
  });

  logger.info(`[time-tracking] Tech ${technicianId} started job`, { entryId: entry.id, jobId });
  if (jobId) {
    try {
      const trackTransitions = require('./track-transitions');
      // technicianId is the tech who actually started the job (the logged-in
      // tech, or the IMEI tech in the geofence-auto path) — pass it so the
      // arrival SMS names the acting tech, not the job's stale assignment.
      await trackTransitions.markOnProperty(jobId, { actingTechId: technicianId });
    } catch (err) {
      logger.error(`[time-tracking] markOnProperty failed for job ${jobId}: ${err.message}`);
    }
  }
  return entry;
}

/**
 * End the active job entry.
 */
async function endJob(technicianId, { lat, lng } = {}) {
  const entry = await endActiveChild(technicianId, 'job', { lat, lng });

  logger.info(`[time-tracking] Tech ${technicianId} ended job`, { entryId: entry.id, duration: entry.duration_minutes });
  return entry;
}

/**
 * Start a break.
 */
async function startBreak(technicianId) {
  const entry = await db.transaction(async (trx) => {
    const activeShift = await lockActiveShift(trx, technicianId);
    if (!activeShift) {
      throw new Error('Must be clocked in to start a break.');
    }

    const existingBreak = await trx('time_entries')
      .where({ technician_id: technicianId, entry_type: 'break', status: 'active' })
      .first('id');
    if (existingBreak) throw new Error('Already on break. End the current break first.');

    const [created] = await trx('time_entries')
      .insert({
        technician_id: technicianId,
        entry_type: 'break',
        status: 'active',
        clock_in: new Date(),
        source: 'app',
        staff_write_generation: ACTIVE_WRITE_GENERATION,
      })
      .returning('*');
    return created;
  });

  logger.info(`[time-tracking] Tech ${technicianId} started break`, { entryId: entry.id });
  return entry;
}

/**
 * End the active break.
 */
async function endBreak(technicianId) {
  const entry = await endActiveChild(technicianId, 'break');

  logger.info(`[time-tracking] Tech ${technicianId} ended break`, { entryId: entry.id, duration: entry.duration_minutes });
  return entry;
}

async function endActiveChild(technicianId, entryType, { lat, lng } = {}) {
  const label = entryType === 'job' ? 'job' : 'break';
  return db.transaction(async (trx) => {
    const activeShift = await lockActiveShift(trx, technicianId);
    if (!activeShift) throw staffTimeHttpError(409, `No active ${label} to end.`);

    const child = await trx('time_entries')
      .where({ technician_id: technicianId, entry_type: entryType, status: 'active' })
      .forUpdate()
      .first();
    if (!child) throw staffTimeHttpError(409, `No active ${label} to end.`);

    const now = new Date();
    const duration = roundCompletedDuration(child.clock_in, now);
    const updates = {
      status: 'completed',
      clock_out: now,
      duration_minutes: duration,
      updated_at: now,
    };
    if (entryType === 'job') {
      updates.clock_out_lat = lat || null;
      updates.clock_out_lng = lng || null;
    }

    const [ended] = await trx('time_entries')
      .where({ id: child.id, status: 'active' })
      .update(updates)
      .returning('*');
    if (!ended) throw staffTimeHttpError(409, `${label} timer was already closed.`);
    return ended;
  });
}

function staffTimeHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
}

function isCompletedEntryIntervalValid(entry) {
  const clockInMs = new Date(entry?.clock_in).getTime();
  const clockOutMs = new Date(entry?.clock_out).getTime();
  const durationMinutes = Number(entry?.duration_minutes);
  if (
    !Number.isFinite(clockInMs)
    || !Number.isFinite(clockOutMs)
    || !Number.isFinite(durationMinutes)
    || clockOutMs <= clockInMs
    || durationMinutes <= 0
  ) return false;
  const expectedMinutes = (clockOutMs - clockInMs) / 60000;
  return Math.abs(durationMinutes - expectedMinutes) <= 0.02;
}

/**
 * Reopen a child timer stopped by the geofence workflow. The active-shift
 * lock serializes this with every child start and every shift close.
 */
async function reopenStoppedEntryInTransaction(trx, technicianId, entryId) {
  const activeShift = await lockActiveShift(trx, technicianId);
  if (!activeShift) {
    throw staffTimeHttpError(409, 'Must be clocked in to restore a stopped timer.');
  }

  const stopped = await trx('time_entries')
    .where({ id: entryId, technician_id: technicianId })
    .forUpdate()
    .first();
  if (!stopped) throw staffTimeHttpError(404, 'Stopped time entry not found.');
  if (!['job', 'break', 'drive', 'admin_time'].includes(stopped.entry_type)) {
    throw staffTimeHttpError(409, 'Only a stopped child timer can be restored.');
  }
  if (!['active', 'completed'].includes(stopped.status)) {
    throw staffTimeHttpError(409, 'Only a completed child timer can be restored.');
  }

  const shiftStartedAt = new Date(activeShift.clock_in).getTime();
  const childStartedAt = new Date(stopped.clock_in).getTime();
  if (
    !Number.isFinite(shiftStartedAt)
    || !Number.isFinite(childStartedAt)
    || childStartedAt < shiftStartedAt
  ) {
    throw staffTimeHttpError(409, 'Stopped timer belongs to an earlier shift.');
  }
  if (stopped.status === 'active') return stopped;

  const stoppedAt = new Date(stopped.clock_out).getTime();
  if (
    !Number.isFinite(stoppedAt)
    || Date.now() - stoppedAt > UNDO_STOP_WINDOW_MINUTES * 60 * 1000
    || stoppedAt > Date.now() + 60 * 1000
  ) {
    throw staffTimeHttpError(409, 'Stopped timer is too old to restore safely.');
  }

  const laterChild = await trx('time_entries')
    .where({ technician_id: technicianId, entry_type: stopped.entry_type })
    .whereNot({ id: entryId })
    .where('status', '!=', 'voided')
    .where('clock_in', '>=', stopped.clock_out)
    .first('id');
  if (laterChild) {
    throw staffTimeHttpError(409, 'A later timer exists; this stopped timer cannot be restored.');
  }

  const conflicting = await trx('time_entries')
    .where({
      technician_id: technicianId,
      entry_type: stopped.entry_type,
      status: 'active',
    })
    .whereNot({ id: entryId })
    .first('id');
  if (conflicting) {
    throw staffTimeHttpError(409, `Another ${stopped.entry_type} timer is already active.`);
  }

  const [reopened] = await trx('time_entries')
    .where({ id: entryId, technician_id: technicianId, status: 'completed' })
    .update({
      status: 'active',
      staff_write_generation: ACTIVE_WRITE_GENERATION,
      clock_out: null,
      clock_out_lat: null,
      clock_out_lng: null,
      duration_minutes: null,
      notes: trx.raw("COALESCE(notes, '') || ' [undo-stop]'"),
      updated_at: new Date(),
    })
    .returning('*');
  if (!reopened) throw staffTimeHttpError(409, 'Stopped timer is no longer restorable.');
  return reopened;
}

async function reopenStoppedEntry(technicianId, entryId) {
  return db.transaction((trx) => (
    reopenStoppedEntryInTransaction(trx, technicianId, entryId)
  ));
}

/**
 * Get current status for a technician.
 */
async function getStatus(technicianId) {
  const activeShift = await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' })
    .first();

  const activeJob = await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'job', status: 'active' })
    .first();

  const activeBreak = await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'break', status: 'active' })
    .first();

  // Today's summary
  const today = staffWorkDate(new Date());
  const todayEntries = await db('time_entries')
    .where({ technician_id: technicianId })
    .where('status', '!=', 'voided')
    .whereRaw(`${STAFF_WORK_DATE_SQL} = ?::date`, [today]);

  const todayShiftMin = todayEntries
    .filter(e => e.entry_type === 'shift')
    .reduce((sum, e) => sum + (parseFloat(e.duration_minutes) || 0), 0);
  const todayJobMin = todayEntries
    .filter(e => e.entry_type === 'job')
    .reduce((sum, e) => sum + (parseFloat(e.duration_minutes) || 0), 0);
  const todayJobCount = todayEntries.filter(e => e.entry_type === 'job' && e.status === 'completed').length;

  return {
    clockedIn: !!activeShift,
    shiftStart: activeShift ? activeShift.clock_in : null,
    shiftEntryId: activeShift ? activeShift.id : null,
    currentJob: activeJob ? {
      id: activeJob.id,
      jobId: activeJob.job_id,
      customerId: activeJob.customer_id,
      serviceType: activeJob.service_type,
      startedAt: activeJob.clock_in,
    } : null,
    onBreak: !!activeBreak,
    breakStart: activeBreak ? activeBreak.clock_in : null,
    todaySummary: {
      shiftMinutes: Math.round(todayShiftMin * 100) / 100,
      jobMinutes: Math.round(todayJobMin * 100) / 100,
      jobCount: todayJobCount,
    },
  };
}

/**
 * Admin edit an entry — preserves originals.
 */
async function adminEditEntry(entryId, { clock_in, clock_out, entry_type, notes, edit_reason, edited_by }) {
  const updated = await db.transaction(async (trx) => {
    // Read without a row lock first so we can acquire the advisory week locks
    // in the same order as approval. The locked re-read below detects a move
    // to another week between these statements instead of deadlocking.
    const preview = await trx('time_entries').where({ id: entryId }).first();
    if (!preview) throw staffTimeHttpError(404, 'Entry not found.');
    const previewWorkDate = staffWorkDate(preview.clock_in);
    const requestedWorkDate = clock_in
      ? staffWorkDate(new Date(clock_in))
      : previewWorkDate;
    const lockedWeeks = [previewWorkDate, requestedWorkDate]
      .map(staffWeekStartForWorkDate);
    await lockStaffWeeks(trx, preview.technician_id, lockedWeeks);

    const entry = await trx('time_entries').where({ id: entryId }).forUpdate().first();
    assertEntryStillInLockedWeek(entry, preview.technician_id, lockedWeeks[0]);
    await assertEntryMutable(trx, entry, 'edit', [
      staffWorkDate(entry.clock_in),
      requestedWorkDate,
    ]);

    const updates = {
      status: 'edited',
      // An admin edit is the resolution transition for a disputed entry.
      // Keep the entry and its day reviewable so the corrected week can be
      // signed and approved again.
      approval_status: 'pending',
      approved_by: null,
      approved_at: null,
      approval_notes: null,
      edit_reason,
      edited_by,
      edited_at: new Date(),
      updated_at: new Date(),
    };

    // Preserve originals (only on first edit)
    if (!entry.original_clock_in) {
      updates.original_clock_in = entry.clock_in;
      updates.original_clock_out = entry.clock_out;
    }

    if (clock_in) updates.clock_in = new Date(clock_in);
    if (clock_out) updates.clock_out = new Date(clock_out);
    if (entry_type) updates.entry_type = entry_type;
    if (notes !== undefined) updates.notes = notes;

    // A completed/edited payroll interval must be positive and internally
    // consistent. Recompute the duration from the final timestamps so edits
    // cannot introduce a negative or stale paid interval.
    const finalIn = updates.clock_in || entry.clock_in;
    const finalOut = updates.clock_out || entry.clock_out;
    const durationMinutes = (new Date(finalOut) - new Date(finalIn)) / 60000;
    updates.duration_minutes = Math.round(durationMinutes * 100) / 100;
    if (!isCompletedEntryIntervalValid({
      ...entry,
      ...updates,
      clock_in: finalIn,
      clock_out: finalOut,
    })) {
      throw staffTimeHttpError(
        400,
        'clock_out must be after clock_in and match a finite positive duration.',
      );
    }

    const [saved] = await trx('time_entries')
      .where({ id: entryId, status: entry.status })
      .whereRaw("approval_status IS DISTINCT FROM 'approved'")
      .update(updates)
      .returning('*');
    if (!saved) throw staffTimeHttpError(409, 'Entry changed; reload before editing.');
    const affectedWorkDates = [
      staffWorkDate(entry.clock_in),
      staffWorkDate(saved.clock_in),
    ];
    if (entry.approval_status === 'disputed') {
      await resolveDisputedDailyStatuses(trx, saved.technician_id, affectedWorkDates);
    }
    await recomputeEntryMutationSummaries(trx, saved.technician_id, affectedWorkDates);
    return saved;
  });

  logger.info(`[time-tracking] Entry ${entryId} edited by ${edited_by}`, { edit_reason });
  return updated;
}

/**
 * Void an entry.
 */
async function voidEntry(entryId, { reason, voided_by }) {
  const updated = await db.transaction(async (trx) => {
    const preview = await trx('time_entries').where({ id: entryId }).first();
    if (!preview) throw staffTimeHttpError(404, 'Entry not found.');
    const previewWeek = staffWeekStartForWorkDate(staffWorkDate(preview.clock_in));
    await lockStaffWeek(trx, preview.technician_id, previewWeek);

    const entry = await trx('time_entries').where({ id: entryId }).forUpdate().first();
    assertEntryStillInLockedWeek(entry, preview.technician_id, previewWeek);
    await assertEntryMutable(trx, entry, 'void', [staffWorkDate(entry.clock_in)]);

    const [saved] = await trx('time_entries')
      .where({ id: entryId, status: entry.status })
      .whereRaw("approval_status IS DISTINCT FROM 'approved'")
      .update({
        status: 'voided',
        approval_status: 'pending',
        approved_by: null,
        approved_at: null,
        approval_notes: null,
        edit_reason: reason,
        edited_by: voided_by,
        edited_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');
    if (!saved) throw staffTimeHttpError(409, 'Entry changed; reload before voiding.');
    const affectedWorkDates = [staffWorkDate(entry.clock_in)];
    if (entry.approval_status === 'disputed') {
      await resolveDisputedDailyStatuses(trx, saved.technician_id, affectedWorkDates);
    }
    await recomputeEntryMutationSummaries(trx, saved.technician_id, affectedWorkDates);
    return saved;
  });

  logger.info(`[time-tracking] Entry ${entryId} voided by ${voided_by}`, { reason });
  return updated;
}

function assertEntryStillInLockedWeek(entry, technicianId, weekStart) {
  if (!entry) throw staffTimeHttpError(404, 'Entry not found.');
  const currentWeek = staffWeekStartForWorkDate(staffWorkDate(entry.clock_in));
  if (entry.technician_id !== technicianId || currentWeek !== weekStart) {
    throw staffTimeHttpError(409, 'Entry changed; reload before editing it.');
  }
}

async function assertEntryMutable(trx, entry, action, affectedWorkDates) {
  if (!entry) throw staffTimeHttpError(404, 'Entry not found.');
  if (entry.status === 'active') {
    throw staffTimeHttpError(409, `End or clock out the active timer before ${action}ing it.`);
  }
  if (entry.status === 'voided') {
    throw staffTimeHttpError(409, 'Cannot change a voided entry.');
  }
  if (entry.approval_status === 'approved') {
    throw staffTimeHttpError(409, 'Unlock the approved week before changing its entries.');
  }

  const workDates = [...new Set(
    (affectedWorkDates || [staffWorkDate(entry.clock_in)]).map(validateWorkDate),
  )].sort();
  for (const workDate of workDates) {
    const daily = await trx('time_entry_daily_summary')
      .where({ technician_id: entry.technician_id, work_date: workDate })
      .forUpdate()
      .first('id', 'status');
    if (daily?.status === 'approved') {
      throw staffTimeHttpError(409, 'Reopen the approved day before changing its entries.');
    }
  }

  const weekStarts = [...new Set(workDates.map(staffWeekStartForWorkDate))].sort();
  for (const weekStart of weekStarts) {
    const weekly = await trx('time_weekly_summary')
      .where({ technician_id: entry.technician_id, week_start: weekStart })
      .forUpdate()
      .first('id', 'status');
    if (weekly?.status === 'approved') {
      throw staffTimeHttpError(409, 'Unlock the approved week before changing its entries.');
    }
  }
}

async function lockStaffWeek(trx, technicianId, weekStart) {
  const { start } = staffWeekRange(weekStart);
  const lockKey = `staff-time-week:${technicianId}:${start}`;
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))',
    [lockKey],
  );
  return start;
}

async function lockStaffWeeks(trx, technicianId, weekStarts) {
  const starts = [...new Set(weekStarts.map(week => staffWeekRange(week).start))].sort();
  for (const start of starts) {
    await lockStaffWeek(trx, technicianId, start);
  }
  return starts;
}

async function resolveDisputedDailyStatuses(trx, technicianId, workDates) {
  const dates = [...new Set(workDates.map(validateWorkDate))].sort();
  for (const workDate of dates) {
    const remainingDispute = await trx('time_entries')
      .where({ technician_id: technicianId, approval_status: 'disputed' })
      .where('status', '!=', 'voided')
      .whereRaw(`${STAFF_WORK_DATE_SQL} = ?::date`, [workDate])
      .first('id');
    if (remainingDispute) continue;

    await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId, work_date: workDate, status: 'disputed' })
      .update({
        status: 'pending',
        approved_by: null,
        approved_at: null,
        updated_at: new Date(),
      });
  }
}

async function recomputeEntryMutationSummaries(trx, technicianId, workDates) {
  const dates = [...new Set(workDates.map(validateWorkDate))].sort();
  for (const workDate of dates) {
    await computeDailySummaryInTransaction(trx, technicianId, workDate);
  }
  const weeks = [...new Set(dates.map(staffWeekStartForWorkDate))].sort();
  for (const weekStart of weeks) {
    await computeWeeklySummaryInTransaction(trx, technicianId, weekStart, { lock: false });
    // An edit or void invalidates the employee's attestation even when rounded
    // totals happen to remain unchanged (for example, a notes-only correction).
    await trx('time_weekly_summary')
      .where({ technician_id: technicianId, week_start: weekStart })
      .whereNot({ status: 'approved' })
      .whereNotNull('tech_signed_at')
      .update({ tech_signed_at: null, tech_signature: null, updated_at: new Date() });
  }
}

function withoutKeys(source, keys) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !keys.includes(key)),
  );
}

/**
 * Compute a daily summary and its weekly roll-up atomically. Every writer for
 * a technician/week takes the same transaction-scoped advisory lock, while
 * conditional ON CONFLICT merges leave approved snapshots immutable.
 */
async function computeDailySummary(technicianId, date) {
  const workDate = validateWorkDate(date);
  const weekStart = staffWeekStartForWorkDate(workDate);
  const summary = await db.transaction(async (trx) => {
    await lockStaffWeek(trx, technicianId, weekStart);
    const daily = await computeDailySummaryInTransaction(trx, technicianId, workDate);
    await computeWeeklySummaryInTransaction(trx, technicianId, weekStart, { lock: false });
    return daily;
  });
  logger.info(`[time-tracking] Daily summary computed for tech ${technicianId} on ${workDate}`);
  return summary;
}

async function computeDailySummaryInTransaction(trx, technicianId, workDate) {
  const entries = await trx('time_entries')
    .where({ technician_id: technicianId })
    .where('status', '!=', 'voided')
    .whereRaw(`${STAFF_WORK_DATE_SQL} = ?::date`, [workDate]);

  const shiftEntries = entries.filter(e => e.entry_type === 'shift');
  const jobEntries = entries.filter(e => e.entry_type === 'job' && e.status !== 'active');
  const driveEntries = entries.filter(e => e.entry_type === 'drive');
  const breakEntries = entries.filter(e => e.entry_type === 'break');
  const adminEntries = entries.filter(e => e.entry_type === 'admin_time');

  const sumUnits = (arr) => arr.reduce(
    (sum, entry) => sum + payrollUnits(entry.duration_minutes),
    0n,
  );

  const totalShiftUnits = sumUnits(shiftEntries);
  const totalJobUnits = sumUnits(jobEntries);
  const totalDriveUnits = sumUnits(driveEntries);
  const totalBreakUnits = sumUnits(breakEntries);
  const totalAdminUnits = sumUnits(adminEntries);
  const totalShift = payrollNumber(totalShiftUnits);
  const totalJob = payrollNumber(totalJobUnits);
  const totalDrive = payrollNumber(totalDriveUnits);
  const totalBreak = payrollNumber(totalBreakUnits);
  const totalAdmin = payrollNumber(totalAdminUnits);
  const jobCount = jobEntries.length;

  const firstIn = shiftEntries.length > 0
    ? shiftEntries.reduce((min, e) => (e.clock_in < min ? e.clock_in : min), shiftEntries[0].clock_in)
    : null;
  const lastOut = shiftEntries.length > 0
    ? shiftEntries.reduce((max, e) => (e.clock_out > max ? e.clock_out : max), shiftEntries[0].clock_out)
    : null;

  // Utilization = job time / shift time
  const utilization = totalShiftUnits > 0n
    ? roundedPayrollRatio(totalJobUnits, totalShiftUnits, 10000n)
    : 0;

  // Revenue from completed jobs that day
  const jobIds = jobEntries.filter(e => e.job_id).map(e => e.job_id);
  let revenueUnits = 0n;
  if (jobIds.length > 0) {
    const jobs = await trx('scheduled_services')
      .whereIn('id', jobIds)
      .select('estimated_price');
    revenueUnits = jobs.reduce(
      (sum, job) => sum + payrollUnits(job.estimated_price),
      0n,
    );
  }
  const revenue = payrollNumber(revenueUnits);

  // RPMH = revenue per man-hour
  const rpmh = totalShiftUnits > 0n
    ? roundedPayrollRatio(revenueUnits, totalShiftUnits, 6000n)
    : 0;

  const now = new Date();
  const summaryData = {
    technician_id: technicianId,
    work_date: workDate,
    total_shift_minutes: totalShift,
    total_job_minutes: totalJob,
    total_drive_minutes: totalDrive,
    total_break_minutes: totalBreak,
    total_admin_minutes: totalAdmin,
    job_count: jobCount,
    first_clock_in: firstIn,
    last_clock_out: lastOut,
    overtime_minutes: 0, // Calculated at weekly level for FL
    utilization_pct: utilization,
    revenue_generated: revenue,
    rpmh_actual: rpmh,
    updated_at: now,
  };
  const mergeData = withoutKeys(summaryData, ['technician_id', 'work_date']);
  const [written] = await trx('time_entry_daily_summary')
    .insert({ ...summaryData, created_at: now })
    .onConflict(['technician_id', 'work_date'])
    .merge(mergeData)
    .whereRaw("time_entry_daily_summary.status IS DISTINCT FROM 'approved'")
    .returning('*');

  if (written) return written;
  return trx('time_entry_daily_summary')
    .where({ technician_id: technicianId, work_date: workDate })
    .first();
}

/**
 * Compute weekly summary. FL has no daily OT — only federal 40hr/week.
 */
async function computeWeeklySummary(technicianId, weekStart) {
  const { start } = staffWeekRange(weekStart);
  const summary = await db.transaction(async (trx) => (
    computeWeeklySummaryInTransaction(trx, technicianId, start)
  ));
  logger.info(`[time-tracking] Weekly summary computed for tech ${technicianId}, week of ${start}`);
  return summary;
}

async function computeWeeklySummaryInTransaction(
  trx,
  technicianId,
  weekStart,
  { lock = true } = {},
) {
  const { start, end: weekEndStr } = staffWeekRange(weekStart);
  if (lock) await lockStaffWeek(trx, technicianId, start);

  const dailies = await trx('time_entry_daily_summary')
    .where({ technician_id: technicianId })
    .where('work_date', '>=', start)
    .where('work_date', '<=', weekEndStr)
    .orderBy('work_date', 'asc')
    .forUpdate();

  const sumDailyUnits = (field) => dailies.reduce(
    (sum, daily) => sum + payrollUnits(daily[field]),
    0n,
  );
  const totalShiftUnits = sumDailyUnits('total_shift_minutes');
  const totalJobUnits = sumDailyUnits('total_job_minutes');
  const totalDriveUnits = sumDailyUnits('total_drive_minutes');
  const totalRevenueUnits = sumDailyUnits('revenue_generated');
  const totalShift = payrollNumber(totalShiftUnits);
  const totalJob = payrollNumber(totalJobUnits);
  const totalDrive = payrollNumber(totalDriveUnits);
  const totalRevenue = payrollNumber(totalRevenueUnits);
  const jobCount = dailies.reduce((s, d) => s + Number(d.job_count || 0), 0);
  const daysWorked = dailies.filter(d => payrollUnits(d.total_shift_minutes) > 0n).length;

  const overtimeThresholdUnits = BigInt(WEEKLY_OT_THRESHOLD_MINUTES) * PAYROLL_SCALE;
  const regularUnits = totalShiftUnits < overtimeThresholdUnits
    ? totalShiftUnits
    : overtimeThresholdUnits;
  const overtimeUnits = totalShiftUnits > overtimeThresholdUnits
    ? totalShiftUnits - overtimeThresholdUnits
    : 0n;

  const avgRpmh = totalShiftUnits > 0n
    ? roundedPayrollRatio(totalRevenueUnits, totalShiftUnits, 6000n)
    : 0;
  const utilization = totalShiftUnits > 0n
    ? roundedPayrollRatio(totalJobUnits, totalShiftUnits, 10000n)
    : 0;

  // Also update daily OT allocation (assign OT to later days)
  let runningUnits = 0n;
  const sortedDailies = [...dailies].sort((a, b) => a.work_date < b.work_date ? -1 : 1);
  for (const d of sortedDailies) {
    const dayShiftUnits = payrollUnits(d.total_shift_minutes);
    runningUnits += dayShiftUnits;
    const dayOvertimeUnits = runningUnits > overtimeThresholdUnits
      ? (dayShiftUnits < runningUnits - overtimeThresholdUnits
        ? dayShiftUnits
        : runningUnits - overtimeThresholdUnits)
      : 0n;
    const dayOT = payrollNumber(dayOvertimeUnits);
    if (dayOvertimeUnits !== payrollUnits(d.overtime_minutes)) {
      await trx('time_entry_daily_summary')
        .where({ id: d.id })
        .whereRaw("status IS DISTINCT FROM 'approved'")
        .update({ overtime_minutes: dayOT });
    }
  }

  const now = new Date();
  const summaryData = {
    technician_id: technicianId,
    week_start: start,
    week_end: weekEndStr,
    total_shift_minutes: totalShift,
    total_job_minutes: totalJob,
    total_drive_minutes: totalDrive,
    regular_minutes: payrollNumber(regularUnits),
    overtime_minutes: payrollNumber(overtimeUnits),
    days_worked: daysWorked,
    job_count: jobCount,
    total_revenue: totalRevenue,
    avg_rpmh: avgRpmh,
    utilization_pct: utilization,
    updated_at: now,
  };
  const existingWeekly = await trx('time_weekly_summary')
    .where({ technician_id: technicianId, week_start: start })
    .forUpdate()
    .first();
  const attestedFields = [
    'total_shift_minutes',
    'total_job_minutes',
    'total_drive_minutes',
    'regular_minutes',
    'overtime_minutes',
    'days_worked',
    'job_count',
    'total_revenue',
    'avg_rpmh',
    'utilization_pct',
  ];
  const countFields = new Set(['days_worked', 'job_count']);
  const attestedTotalsChanged = existingWeekly && attestedFields.some((field) => (
    countFields.has(field)
      ? Number(existingWeekly[field] || 0) !== Number(summaryData[field] || 0)
      : roundPayroll(existingWeekly[field]) !== roundPayroll(summaryData[field])
  ));
  const mergeData = withoutKeys(summaryData, ['technician_id', 'week_start']);
  if (existingWeekly?.status !== 'approved' && attestedTotalsChanged) {
    mergeData.tech_signed_at = null;
    mergeData.tech_signature = null;
  }
  const [written] = await trx('time_weekly_summary')
    .insert({ ...summaryData, created_at: now })
    .onConflict(['technician_id', 'week_start'])
    .merge(mergeData)
    .whereRaw("time_weekly_summary.status IS DISTINCT FROM 'approved'")
    .returning('*');

  if (written) return written;
  return trx('time_weekly_summary')
    .where({ technician_id: technicianId, week_start: start })
    .first();
}

/**
 * Get paginated time entries with joins.
 */
async function getEntries({ technicianId, startDate, endDate, entryType, status, limit = 50, offset = 0 } = {}) {
  let query = db('time_entries')
    .leftJoin('customers', 'time_entries.customer_id', 'customers.id')
    .leftJoin('scheduled_services', 'time_entries.job_id', 'scheduled_services.id')
    .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
    .select(
      'time_entries.*',
      'customers.first_name as customer_first_name',
      'customers.last_name as customer_last_name',
      'technicians.name as tech_name',
      'scheduled_services.service_type as job_service_type',
    );

  if (technicianId) query = query.where('time_entries.technician_id', technicianId);
  const qualifiedWorkDate = staffWorkDateSql('time_entries.clock_in');
  if (startDate) query = query.whereRaw(`${qualifiedWorkDate} >= ?::date`, [startDate]);
  if (endDate) query = query.whereRaw(`${qualifiedWorkDate} <= ?::date`, [endDate]);
  if (entryType) query = query.where('time_entries.entry_type', entryType);
  if (status) query = query.where('time_entries.status', status);

  const total = await query.clone().clearSelect().count('time_entries.id as count').first();

  const entries = await query
    .orderBy('time_entries.clock_in', 'desc')
    .limit(limit)
    .offset(offset);

  return { entries, total: parseInt(total.count), limit, offset };
}

/**
 * Get daily summaries.
 */
async function getDailySummaries({ technicianId, startDate, endDate, status } = {}) {
  let query = db('time_entry_daily_summary')
    .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
    .select('time_entry_daily_summary.*', 'technicians.name as tech_name');

  if (technicianId) query = query.where('time_entry_daily_summary.technician_id', technicianId);
  if (startDate) query = query.where('work_date', '>=', startDate);
  if (endDate) query = query.where('work_date', '<=', endDate);
  if (status) query = query.where('time_entry_daily_summary.status', status);

  return query.orderBy('work_date', 'desc');
}

/**
 * Get weekly summaries.
 */
async function getWeeklySummaries({ technicianId, startDate, endDate } = {}) {
  let query = db('time_weekly_summary')
    .leftJoin('technicians', 'time_weekly_summary.technician_id', 'technicians.id')
    .select('time_weekly_summary.*', 'technicians.name as tech_name');

  if (technicianId) query = query.where('time_weekly_summary.technician_id', technicianId);
  if (startDate) query = query.where('week_start', '>=', startDate);
  if (endDate) query = query.where('week_start', '<=', endDate);

  return query.orderBy('week_start', 'desc');
}

/**
 * Auto clock-out check: find shifts >14 hours and force close them.
 */
async function autoClockOutCheck() {
  const cutoff = new Date(Date.now() - 14 * 60 * 60 * 1000); // 14 hours ago

  const staleShifts = await db('time_entries')
    .where({ entry_type: 'shift', status: 'active' })
    .where('clock_in', '<', cutoff);

  const results = [];
  for (const shift of staleShifts) {
    const closed = await closeActiveShiftAtomically(shift.technician_id, {
      shiftId: shift.id,
      childNoteSuffix: ' [auto-closed]',
      shiftNote: 'AUTO CLOCK-OUT: exceeded 14-hour limit',
    });
    if (!closed) continue;

    await computeDailySummary(shift.technician_id, closed.workDate);

    results.push({
      technicianId: shift.technician_id,
      entryId: shift.id,
      duration: closed.duration,
    });
    logger.warn(`[time-tracking] Auto clock-out for tech ${shift.technician_id}`, { entryId: shift.id });
  }

  return results;
}

module.exports = {
  clockIn,
  clockOut,
  startJob,
  endJob,
  startBreak,
  endBreak,
  reopenStoppedEntry,
  reopenStoppedEntryInTransaction,
  closeActiveShiftAtomically,
  getStatus,
  adminEditEntry,
  voidEntry,
  computeDailySummary,
  computeDailySummaryInTransaction,
  computeWeeklySummary,
  computeWeeklySummaryInTransaction,
  lockStaffWeek,
  isCompletedEntryIntervalValid,
  getEntries,
  getDailySummaries,
  getWeeklySummaries,
  autoClockOutCheck,
};
