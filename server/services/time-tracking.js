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
  UNPAID_MEAL_MIN_BREAK_MINUTES,
} = require('../constants/staff-time');
const { PAYROLL_SCALE, payrollUnits } = require('../utils/payroll-units');
const { lockPayrollMutationsShared } = require('./payroll-lock');
const { paidLineCoveringWeeks } = require('./payroll-paid-line-weeks');
const { unpaidMealUnits } = require('../utils/unpaid-meal');
const { autoLunchLive, shiftCloseReviewLive } = require('../config/feature-gates');
const { recordAuditEvent } = require('./audit-log');

const UNDO_STOP_WINDOW_MINUTES = 30;
const AUTO_LUNCH_OFF_MESSAGE = 'Auto lunch is not turned on, so there is no lunch to change.';

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

// Lock the stable technician row (an inactive account cannot clock in). There
// is no active-shift row to lock on the first clock-in, so check-and-insert is
// serialized on this row until the deferred partial unique active-timer index
// can be installed after rollout.
async function lockActiveTechnician(trx, technicianId) {
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
}

async function insertShift(trx, technicianId, { lat, lng, notes, source } = {}) {
  const [created] = await trx('time_entries')
    .insert({
      technician_id: technicianId,
      entry_type: 'shift',
      status: 'active',
      clock_in: new Date(),
      clock_in_lat: lat || null,
      clock_in_lng: lng || null,
      notes: notes || null,
      source: source || 'app',
      staff_write_generation: ACTIVE_WRITE_GENERATION,
    })
    .returning('*');
  return created;
}

/**
 * Clock in a technician for a new shift.
 */
async function clockIn(technicianId, { lat, lng, notes, source } = {}) {
  const entry = await db.transaction(async (trx) => {
    await lockActiveTechnician(trx, technicianId);

    const existing = await trx('time_entries')
      .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' })
      .first();
    if (existing) {
      const alreadyClockedIn = new Error('Already clocked in. Clock out before starting a new shift.');
      alreadyClockedIn.code = 'ALREADY_CLOCKED_IN';
      throw alreadyClockedIn;
    }

    return insertShift(trx, technicianId, { lat, lng, notes, source });
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

// The last moment this technician really did something inside an open shift
// that the system is about to close for them (GATE_SHIFT_CLOSE_REVIEW, census
// H8): the later of (a) their latest completed visit and (b) the end of their
// latest finished job / drive / break / admin entry that started in the shift.
// Both are capped at `forcedAt`. Returns null when neither exists after the
// shift's clock_in, and the caller keeps the forced time. An entry still
// running is not activity: its end is exactly what is unknown.
async function lastRealActivityAt(trx, shift, forcedAt) {
  const visit = await trx('scheduled_services')
    .where({ technician_id: shift.technician_id, status: 'completed' })
    .where('completed_at', '>', shift.clock_in)
    .where('completed_at', '<=', forcedAt)
    .max('completed_at as at')
    .first();
  const entry = await trx('time_entries')
    .where({ technician_id: shift.technician_id })
    .whereIn('entry_type', ['job', 'drive', 'break', 'admin_time'])
    .whereIn('status', ['completed', 'edited'])
    .where('clock_in', '>=', shift.clock_in)
    .where('clock_out', '>', shift.clock_in)
    .where('clock_out', '<=', forcedAt)
    .max('clock_out as at')
    .first();
  const times = [visit?.at, entry?.at].filter(Boolean).map((value) => new Date(value));
  if (!times.length) return null;
  return new Date(Math.max(...times.map((value) => value.getTime())));
}

/**
 * Close a shift and every active child while holding the shift row lock.
 * startJob/startBreak take the same lock before creating an
 * active child, so no child can commit after this transaction closes them.
 *
 * options.autoCloseReason ('cron_11pm' | 'over_14_hours') marks a close the
 * system makes for a technician who did not clock out. With
 * GATE_SHIFT_CLOSE_REVIEW on, that close ends at the last real activity
 * (lastRealActivityAt) instead of now, and the shift is flagged for admin
 * review (auto_closed_at, auto_close_reason). Off, the option does nothing.
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
    const markAutoClose = Boolean(options.autoCloseReason) && shiftCloseReviewLive();
    const activityAt = markAutoClose ? await lastRealActivityAt(trx, activeShift, now) : null;
    const closeAt = activityAt || now;
    const trimmed = Boolean(activityAt) && activityAt.getTime() < new Date(now).getTime();

    if (trimmed) {
      // A timer that began after the last real activity has no real end to
      // pay: it would run past the shift it sits in. Void it, as the office
      // would on review.
      await trx('time_entries')
        .where({ technician_id: technicianId, status: 'active' })
        .whereIn('entry_type', ['job', 'break', 'drive', 'admin_time'])
        .where('clock_in', '>=', closeAt)
        .update({
          status: 'voided',
          edit_reason: 'Automatic clock-out: started after the last recorded activity',
          updated_at: now,
        });
    }

    const childUpdates = {
      status: 'completed',
      clock_out: closeAt,
      duration_minutes: completedDurationSql(trx, closeAt),
      updated_at: now,
    };
    if (options.childNoteSuffix) {
      childUpdates.notes = trx.raw("COALESCE(notes, '') || ?", [options.childNoteSuffix]);
    }

    await trx('time_entries')
      .where({ technician_id: technicianId, status: 'active' })
      .whereIn('entry_type', ['job', 'break', 'drive', 'admin_time'])
      .update(childUpdates);

    const duration = roundCompletedDuration(activeShift.clock_in, closeAt);
    const shiftUpdates = {
      status: 'completed',
      clock_out: closeAt,
      duration_minutes: duration,
      notes: appendEntryNote(
        activeShift.notes,
        trimmed && options.shiftNote ? `${options.shiftNote}, ended at last recorded activity` : options.shiftNote,
      ),
      updated_at: now,
    };
    if (markAutoClose) {
      shiftUpdates.auto_closed_at = now;
      shiftUpdates.auto_close_reason = options.autoCloseReason;
    }
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
      closedAt: closeAt,
      forcedAt: now,
      autoClosed: markAutoClose,
      trimmed,
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
// scopeReq: the HTTP request when a technician starts the timer themselves.
// The locked job read then applies the current-live-assignment predicate, so
// a technician cannot start a timer (and the arrival transition/SMS) on a
// visit that is not theirs (codex #5568 r7 P1). An admin request is unscoped.
async function startJob(technicianId, jobId, { lat, lng, scopeReq = null } = {}) {
  // Keep replacement atomic across writer-generation cutovers. If this app
  // generation is stale, its insert is rejected by the active-write CHECK;
  // the transaction then rolls back the preceding close instead of leaving
  // the technician without an active job timer.
  const entry = await db.transaction(async (trx) => {
    const activeShift = await lockActiveShift(trx, technicianId);

    if (!activeShift) {
      throw new Error('Must be clocked in to start a job.');
    }

    // Job lookup FIRST, and LOCKED (codex P2 #3152 round 25): the
    // time-on-site correction's linked-timer sync holds this visit's
    // scheduled_services row lock across its membership check and audited
    // edit — an unlocked insert here could land a new job timer between
    // that check and the edit, making the sync report success against a
    // set that just changed. Taking the same row lock serializes timer
    // creation with the sync (either the insert commits first and the
    // membership check sees it, or it waits until the sync's report is
    // already honest at its commit point). Ordered before the
    // time_entries writes below so every path locks scheduled_services
    // before touching time_entries.
    let customerId = null;
    let serviceType = null;
    if (jobId) {
      const jobQuery = trx('scheduled_services').where('scheduled_services.id', jobId);
      if (scopeReq) require('./technician-visit-scope').technicianLiveVisitFilter(scopeReq, jobQuery);
      const job = await jobQuery.forUpdate().first();
      if (!job && scopeReq && require('./technician-visit-scope').isTechnicianRequest(scopeReq)) {
        throw Object.assign(new Error('Job not found'), { status: 404, code: 'job_not_assigned' });
      }
      if (job) {
        customerId = job.customer_id;
        serviceType = job.service_type;
        // A completed visit takes no new job timer (GitHub r2 P1 #5886).
        // The office can complete a visit its technician arrived at (the
        // invoice-issued closeout, which refuses a visit whose timer is
        // RUNNING); a timer start that picked the visit just
        // before that commit would otherwise start a timer on it afterwards
        // and count until auto clock-out. Decided on the row lock just
        // taken — the same lock the completion holds while it checks for a
        // running timer — so exactly one of the two wins. Before any
        // time_entries write, so the technician's current timer is untouched.
        if (job.status === 'completed') {
          throw Object.assign(new Error('This visit is already completed.'), { status: 409, code: 'job_already_completed' });
        }
        // A live street-level address hold cannot be worked yet: refuse before any timer is created
        // (the same 409 the status routes give). Re-read under the row lock just taken.
        if (await require('./street-level-hold').isStreetLevelHoldVisit(jobId, trx)) {
          throw Object.assign(new Error(require('./street-level-hold').HOLD_REFUSAL), { status: 409, code: 'street_level_hold' });
        }
      }
    } else if (scopeReq && require('./technician-visit-scope').isTechnicianRequest(scopeReq)) {
      // A technician-scoped start must name a visit (codex #5568 r16 P2): a
      // null or empty job id would skip the assignment lookup above, close
      // the current job entry below and insert an unowned one. Same miss as
      // a visit that is not theirs.
      throw Object.assign(new Error('Job not found'), { status: 404, code: 'job_not_assigned' });
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
      // tech) — pass it so the
      // arrival SMS names the acting tech, not the job's stale assignment.
      const result = await trackTransitions.markOnProperty(jobId, {
        actingTechId: technicianId,
        // A technician's own start stays bound to their assignment through
        // the arrival transition (codex #5568 r9).
        ...(scopeReq && require('./technician-visit-scope').isTechnicianRequest(scopeReq) ? { expectTechnicianId: technicianId } : {}),
      });
      // A grouped stop that did not fully sync is NOT success (codex #3603
      // r6): the durable office surface is the transition-failure alert.
      await require('./track-transition-alerts').recordTrackTransitionResultFailure({
        jobId, action: 'mark_on_property', actorId: technicianId, result,
      });
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

  const autoLunchOn = autoLunchLive();
  const todayDay = autoLunchOn
    ? await db('time_entry_daily_summary')
      .where({ technician_id: technicianId, work_date: today })
      .first('no_lunch')
    : null;

  const mealFloor = UNPAID_MEAL_MIN_BREAK_MINUTES * 100;
  const todayRecordedMeal = autoLunchOn
    ? Number(todayEntries
      .filter(e => e.entry_type === 'break' && e.status !== 'active')
      .map(e => payrollUnits(e.duration_minutes))
      .filter(units => units >= BigInt(mealFloor))
      .reduce((sum, units) => sum + units, 0n)) / 100
    : 0;

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
    // "No lunch today" control: the card shows it only while the gate is on.
    // recordedMealMinutes: completed breaks of 30+ minutes today. They stay
    // unpaid whatever "No lunch" says, so the card shows them.
    autoLunch: autoLunchOn
      ? { enabled: true, noLunch: Boolean(todayDay?.no_lunch), recordedMealMinutes: todayRecordedMeal }
      : { enabled: false, noLunch: false, recordedMealMinutes: 0 },
  };
}

// An admin who CHANGES the clock-out of an automatically closed shift has
// reviewed it (GATE_SHIFT_CLOSE_REVIEW): the flag clears with the edit. The
// entry editor sends clock_out on every save, so an unchanged value (a
// notes-only edit) is not a review; Confirm accepts an unchanged time.
function autoCloseReviewedBy(entry, updates, editedBy) {
  if (!updates.clock_out || !entry.auto_closed_at || entry.auto_close_reviewed_at) return {};
  if (entry.clock_out && new Date(updates.clock_out).getTime() === new Date(entry.clock_out).getTime()) return {};
  return { auto_close_reviewed_at: new Date(), auto_close_reviewed_by: editedBy || null };
}

/**
 * Admin edit an entry — preserves originals.
 */
async function adminEditEntry(entryId, {
  clock_in, clock_out, entry_type, notes, edit_reason, edited_by,
  target_duration_minutes, expected_updated_at,
}) {
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
    // Optimistic version check (codex P2 #3152 round 22): an automated
    // caller (the time-on-site linked-timer sync) states the updated_at it
    // observed — if a payroll admin edited the entry between that snapshot
    // and this locked read, the edit is rejected instead of silently
    // replacing the newer manual correction. Callers that pass nothing
    // (the interactive admin edit route) keep last-write-wins.
    if (expected_updated_at !== undefined) {
      const observed = expected_updated_at ? new Date(expected_updated_at).getTime() : null;
      const current = entry.updated_at ? new Date(entry.updated_at).getTime() : null;
      if (observed !== current) {
        throw staffTimeHttpError(409, 'Entry changed since it was read; reload before editing.');
      }
    }

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
    // Duration-based edit (codex P1 #3152, pre-push audit): the caller
    // states the INTERVAL and the clock_out is derived from the LOCKED
    // row's start (or the clock_in supplied in this same edit) — a
    // clock_out precomputed from an unlocked snapshot races a concurrent
    // clock_in edit and saves a duration different from the one intended.
    // Explicit clock_out wins when both are passed.
    if (!clock_out && Number.isFinite(Number(target_duration_minutes)) && Number(target_duration_minutes) > 0) {
      const baseIn = updates.clock_in || entry.clock_in;
      const derivedOut = new Date(new Date(baseIn).getTime() + Number(target_duration_minutes) * 60000);
      // Never fabricate future paid time (codex P1 #3152 round 24): a
      // corrected duration exceeding the elapsed span since clock_in would
      // derive a clock_out ahead of the wall clock — the visit lifecycle
      // clamps ITS end for exactly this input, and payroll must not record
      // minutes that have not happened. Rejected, not clamped: a clamped
      // timer would silently disagree with the operator's stated minutes.
      if (derivedOut.getTime() > Date.now()) {
        throw staffTimeHttpError(400, 'Target duration extends the entry into the future; correct the timer manually once the interval has elapsed.');
      }
      updates.clock_out = derivedOut;
    }
    if (entry_type) updates.entry_type = entry_type;
    if (notes !== undefined) updates.notes = notes;
    Object.assign(updates, autoCloseReviewedBy(entry, updates, edited_by));

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

// An added missed shift is a completed day, so a span past this is a typo (a
// wrong date or an AM/PM slip), not a shift. The edit path has no such cap.
const MAX_ADDED_SHIFT_MINUTES = 16 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

function parseAddedInstant(value, label) {
  if (typeof value !== 'string' || !INSTANT_RE.test(value.trim())) {
    throw staffTimeHttpError(400, `${label} must be a date and time with a time zone.`);
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw staffTimeHttpError(400, `${label} must be a date and time with a time zone.`);
  }
  return parsed;
}

// Validate the requested interval before any lock is taken. Returns the parsed
// instants and the stored duration (hundredths of a minute, like adminEditEntry).
function validateAddedShiftInterval(clockInValue, clockOutValue, now = new Date()) {
  const clockIn = parseAddedInstant(clockInValue, 'clock_in');
  const clockOut = parseAddedInstant(clockOutValue, 'clock_out');
  if (clockOut.getTime() <= clockIn.getTime()) {
    throw staffTimeHttpError(400, 'clock_out must be after clock_in.');
  }
  if (clockOut.getTime() > now.getTime()) {
    throw staffTimeHttpError(400, 'A missed shift cannot end in the future.');
  }
  const durationMinutes = Math.round(((clockOut - clockIn) / 60000) * 100) / 100;
  if (durationMinutes > MAX_ADDED_SHIFT_MINUTES) {
    throw staffTimeHttpError(400, 'A missed shift cannot be longer than 16 hours. Check the dates and AM/PM.');
  }
  return { clockIn, clockOut, durationMinutes };
}

// Lock the technician row. Clock-in locks the same row before it checks for an
// open shift, so an added shift and a live clock-in cannot both pass the
// overlap check.
async function lockTechnicianForAddedShift(trx, technicianId) {
  if (typeof technicianId !== 'string' || !UUID_RE.test(technicianId)) {
    throw staffTimeHttpError(404, 'Technician not found.');
  }
  const technician = await trx('technicians')
    .where({ id: technicianId })
    .forUpdate()
    .first('id', 'active');
  if (!technician) throw staffTimeHttpError(404, 'Technician not found.');
  if (!technician.active) {
    throw staffTimeHttpError(409, 'That staff account is inactive; reactivate it before adding a shift.');
  }
}

async function assertNoShiftOverlap(trx, technicianId, clockIn, clockOut) {
  const clash = await trx('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift' })
    .whereNot({ status: 'voided' })
    .where('clock_in', '<', clockOut)
    .where((q) => q.whereNull('clock_out').orWhere('clock_out', '>', clockIn))
    .first('id');
  if (clash) {
    throw staffTimeHttpError(409, 'That time overlaps a shift already on this technician. Edit that shift instead.');
  }
}

/**
 * Admin adds a shift the technician never clocked (a missed day). Treated like
 * an edited shift: same week/day/pay guards as adminEditEntry, the row carries
 * the edit markers (status 'edited', edited_by, edit_reason, edited_at), the
 * summaries are recomputed and the week's sign-off is cleared.
 */
async function adminAddEntry({
  technician_id, clock_in, clock_out, notes, edit_reason, edited_by,
}) {
  if (typeof edit_reason !== 'string' || !edit_reason.trim()) {
    throw staffTimeHttpError(400, 'edit_reason is required.');
  }
  const interval = validateAddedShiftInterval(clock_in, clock_out);
  const workDate = staffWorkDate(interval.clockIn);

  const created = await db.transaction(async (trx) => {
    await lockStaffWeeks(trx, technician_id, [staffWeekStartForWorkDate(workDate)]);
    await lockTechnicianForAddedShift(trx, technician_id);
    await assertEntryMutable(trx, {
      technician_id,
      clock_in: interval.clockIn,
      status: 'completed',
      approval_status: 'pending',
    }, 'add', [workDate]);
    await assertNoShiftOverlap(trx, technician_id, interval.clockIn, interval.clockOut);

    const now = new Date();
    const [saved] = await trx('time_entries')
      .insert({
        technician_id,
        entry_type: 'shift',
        status: 'edited',
        approval_status: 'pending',
        clock_in: interval.clockIn,
        clock_out: interval.clockOut,
        duration_minutes: interval.durationMinutes,
        notes: notes ? String(notes).trim() || null : null,
        source: 'admin_added',
        edit_reason: edit_reason.trim(),
        edited_by: edited_by || null,
        edited_at: now,
      })
      .returning('*');
    await recordAuditEvent({
      trx,
      critical: true,
      actor_type: 'admin',
      actor_id: edited_by || null,
      action: 'payroll.time_entry_added',
      resource_type: 'time_entries',
      resource_id: saved.id,
      metadata: { technician_id, work_date: workDate, duration_minutes: interval.durationMinutes },
    });
    await recomputeEntryMutationSummaries(trx, technician_id, [workDate]);
    return saved;
  });

  logger.info(`[time-tracking] Shift ${created.id} added by ${edited_by}`, { edit_reason });
  return created;
}

/**
 * Confirm an automatically closed shift as it stands (GATE_SHIFT_CLOSE_REVIEW).
 * Changes no time: it only records that an admin looked, which lets the
 * technician's pay run line through. Works on a locked week too, because the
 * week's minutes do not change.
 */
async function confirmAutoClose(entryId, { reviewed_by } = {}) {
  const [saved] = await db('time_entries')
    .where({ id: entryId, entry_type: 'shift' })
    .whereNotNull('auto_closed_at')
    .whereNull('auto_close_reviewed_at')
    .whereNot({ status: 'voided' })
    .update({
      auto_close_reviewed_at: new Date(),
      auto_close_reviewed_by: reviewed_by || null,
    })
    .returning('*');
  if (!saved) throw staffTimeHttpError(409, 'That clock-out is not waiting for review.');
  logger.info(`[time-tracking] Automatic clock-out ${entryId} confirmed by ${reviewed_by}`);
  return saved;
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

  // A pay run finalizes under the exclusive payroll lock. Taking it shared here,
  // before the daily and weekly row locks, makes an edit and a finalize wait for
  // each other (edits do not block one another), so hours cannot move into a week
  // while it is being paid. Lock order: staff-week locks and the entry row (the
  // callers), then this lock, then the summary rows. Finalize takes this lock and
  // then weekly rows only.
  await lockPayrollMutationsShared(trx);

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
  // A paid week is closed even when it never had an approved timesheet (a week
  // paid for time off alone). Not behind GATE_PAYROLL_TIME_OFF: it must keep
  // protecting such a week if the gate is turned off later.
  const paid = await trx('payroll_checks')
    .where({ technician_id: entry.technician_id, status: 'finalized' })
    .whereIn('week_start', weekStarts)
    .first('id');
  if (paid) {
    throw staffTimeHttpError(409, 'This week is already paid. Void its pay run before changing its entries.');
  }
  // A paid pay line took its overtime from these hours (GATE_PAYROLL_PAY_LINES), even
  // when the week had no check of its own. Not behind the gate, like the check above.
  if (await paidLineCoveringWeeks(trx, entry.technician_id, weekStarts)) {
    throw staffTimeHttpError(409, 'A paid pay line took its overtime from this week. Void the pay run that paid it before changing its entries.');
  }
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
    await resetWeekSignOff(trx, technicianId, weekStart);
  }
}

// Clear the technician's weekly sign-off on an unapproved week. Shared by the
// entry edits and the No lunch change: the tech attested a different pay basis.
async function resetWeekSignOff(trx, technicianId, weekStart) {
  await trx('time_weekly_summary')
    .where({ technician_id: technicianId, week_start: weekStart })
    .whereNot({ status: 'approved' })
    .whereNotNull('tech_signed_at')
    .update({ tech_signed_at: null, tech_signature: null, updated_at: new Date() });
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

// The unpaid meal of one work day from its entries (GATE_AUTO_LUNCH), in
// payroll units. Shared by the daily compute and the weekly refresh so the
// two cannot drift. Only completed breaks count.
function dayUnpaidMealUnits(dayEntries, totalShiftUnits, noLunch, enabled) {
  return unpaidMealUnits({
    totalShiftUnits,
    breakDurationUnits: dayEntries
      .filter(e => e.entry_type === 'break' && e.status !== 'active')
      .map(e => payrollUnits(e.duration_minutes)),
    noLunch,
    enabled,
  });
}

// A DATE cell as YYYY-MM-DD. node-postgres builds DATE values at local
// midnight, so read the local parts (a UTC read could shift the day).
function dateCellYmd(value) {
  if (value instanceof Date) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }
  return String(value).slice(0, 10);
}

/**
 * Mark one ET work day "No lunch today" (or undo it). The flag lives on the
 * day's summary row; computeDailySummaryInTransaction reads it and never
 * overwrites it. The day and its week are recomputed under the same staff
 * week lock the entry writers take. An approved day or week is refused.
 *
 * `editedBy` + `editReason` (admin route only) append who changed what and
 * why to the day's notes, the day-level counterpart of an entry's
 * edited_by / edit_reason.
 */
async function setDayNoLunch(technicianId, workDate, noLunch, { editedBy = null, editReason = null } = {}) {
  const day = validateWorkDate(workDate);
  const weekStart = staffWeekStartForWorkDate(day);
  const flag = Boolean(noLunch);
  // No lunch only means something while GATE_AUTO_LUNCH is on. Checked here
  // and again once the week lock is held, so a flip to off while this call
  // waited for the lock still writes nothing.
  if (!autoLunchLive()) throw staffTimeHttpError(409, AUTO_LUNCH_OFF_MESSAGE);
  const result = await db.transaction(async (trx) => {
    await lockStaffWeek(trx, technicianId, weekStart);
    if (!autoLunchLive()) throw staffTimeHttpError(409, AUTO_LUNCH_OFF_MESSAGE);

    const weekly = await trx('time_weekly_summary')
      .where({ technician_id: technicianId, week_start: weekStart })
      .forUpdate()
      .first('id', 'status');
    if (weekly?.status === 'approved') {
      throw staffTimeHttpError(409, 'Unlock the approved week before changing lunch.');
    }

    const readDay = () => trx('time_entry_daily_summary')
      .where({ technician_id: technicianId, work_date: day })
      .forUpdate()
      .first('id', 'status', 'notes', 'no_lunch');
    let daily = await readDay();
    if (!daily) {
      // The tech can tap before the first clock-out writes the day's row.
      await computeDailySummaryInTransaction(trx, technicianId, day);
      daily = await readDay();
    }
    if (daily?.status === 'approved') {
      throw staffTimeHttpError(409, 'Reopen the approved day before changing lunch.');
    }

    const updates = { no_lunch: flag, updated_at: new Date() };
    if (editedBy) {
      updates.notes = appendEntryNote(
        daily.notes,
        `No lunch ${flag ? 'set' : 'cleared'} by ${editedBy}${editReason ? `: ${editReason}` : ''}`,
      );
    }
    await trx('time_entry_daily_summary').where({ id: daily.id }).update(updates);

    const summary = await computeDailySummaryInTransaction(trx, technicianId, day);
    await computeWeeklySummaryInTransaction(trx, technicianId, weekStart, { lock: false });
    // The tech attested the week on the old pay basis. Clear the sign-off when
    // the flag changed, even if the totals did not (a short day, or a recorded
    // meal that already covers the deduction), as an entry edit does.
    if (Boolean(daily.no_lunch) !== flag) {
      await resetWeekSignOff(trx, technicianId, weekStart);
    }
    return summary;
  });
  logger.info(`[time-tracking] No-lunch ${flag ? 'set' : 'cleared'} for tech ${technicianId} on ${day}`, {
    editedBy,
    editReason,
  });
  return result;
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

  // Unpaid meal (GATE_AUTO_LUNCH). Only completed breaks count; the day's
  // no_lunch flag is set by the tech or an admin and is never rewritten here.
  // Gate off: no flag read and a zero unpaid meal, byte-identical to before.
  const autoLunchOn = autoLunchLive();
  const existingDay = autoLunchOn && totalShiftUnits > 0n
    ? await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId, work_date: workDate })
      .first('no_lunch')
    : null;
  const unpaidMeal = payrollNumber(dayUnpaidMealUnits(
    breakEntries,
    totalShiftUnits,
    Boolean(existingDay?.no_lunch),
    autoLunchOn,
  ));

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
    unpaid_meal_minutes: unpaidMeal,
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

/**
 * Re-derive the unpaid meal of every NON-approved day in a week from its
 * entries and the CURRENT gate, so a gate flip (or a rule change) never leaves
 * a stale deduction in the weekly totals. Writes the daily row when the value
 * differs and updates the in-memory row the caller sums. An approved day keeps
 * its stored snapshot. Runs under the caller's staff week lock.
 *
 * With the gate off and no stored deduction there is nothing to correct, so
 * no query runs (the gate-off path stays byte-identical).
 */
async function refreshDailyUnpaidMeals(trx, technicianId, start, end, dailies) {
  const open = dailies.filter(d => d.status !== 'approved');
  const enabled = autoLunchLive();
  if (!open.length) return;
  if (!enabled && !open.some(d => payrollUnits(d.unpaid_meal_minutes) > 0n)) return;

  const rows = await trx('time_entries')
    .where({ technician_id: technicianId })
    .where('status', '!=', 'voided')
    .whereIn('entry_type', ['shift', 'break'])
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
    .select('entry_type', 'status', 'duration_minutes', trx.raw(`${STAFF_WORK_DATE_SQL}::text AS work_date`));
  const byDate = new Map();
  for (const row of rows) {
    const key = String(row.work_date).slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(row);
  }

  for (const daily of open) {
    const dayEntries = byDate.get(dateCellYmd(daily.work_date)) || [];
    const shiftUnits = dayEntries
      .filter(e => e.entry_type === 'shift')
      .reduce((sum, e) => sum + payrollUnits(e.duration_minutes), 0n);
    const derived = dayUnpaidMealUnits(dayEntries, shiftUnits, Boolean(daily.no_lunch), enabled);
    if (derived === payrollUnits(daily.unpaid_meal_minutes)) continue;
    const value = payrollNumber(derived);
    await trx('time_entry_daily_summary')
      .where({ id: daily.id })
      .whereRaw("status IS DISTINCT FROM 'approved'")
      .update({ unpaid_meal_minutes: value, updated_at: new Date() });
    daily.unpaid_meal_minutes = value;
  }
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

  await refreshDailyUnpaidMeals(trx, technicianId, start, weekEndStr, dailies);

  const sumDailyUnits = (field) => dailies.reduce(
    (sum, daily) => sum + payrollUnits(daily[field]),
    0n,
  );
  const totalShiftUnits = sumDailyUnits('total_shift_minutes');
  const totalJobUnits = sumDailyUnits('total_job_minutes');
  const totalDriveUnits = sumDailyUnits('total_drive_minutes');
  const totalRevenueUnits = sumDailyUnits('revenue_generated');
  const unpaidMealUnitsTotal = sumDailyUnits('unpaid_meal_minutes');
  const totalShift = payrollNumber(totalShiftUnits);
  const totalJob = payrollNumber(totalJobUnits);
  const totalDrive = payrollNumber(totalDriveUnits);
  const totalRevenue = payrollNumber(totalRevenueUnits);
  const jobCount = dailies.reduce((s, d) => s + Number(d.job_count || 0), 0);
  const daysWorked = dailies.filter(d => payrollUnits(d.total_shift_minutes) > 0n).length;

  // Regular and overtime split PAID minutes: shift minutes less the unpaid
  // meal of each day (0 while GATE_AUTO_LUNCH is off). A day never pays below 0.
  const dayPaidUnits = (daily) => {
    const shiftUnits = payrollUnits(daily.total_shift_minutes);
    const unpaidUnits = payrollUnits(daily.unpaid_meal_minutes);
    const paid = shiftUnits - unpaidUnits;
    return paid > 0n ? paid : 0n;
  };
  const paidUnits = dailies.reduce((sum, daily) => sum + dayPaidUnits(daily), 0n);
  const overtimeThresholdUnits = BigInt(WEEKLY_OT_THRESHOLD_MINUTES) * PAYROLL_SCALE;
  const regularUnits = paidUnits < overtimeThresholdUnits
    ? paidUnits
    : overtimeThresholdUnits;
  const overtimeUnits = paidUnits > overtimeThresholdUnits
    ? paidUnits - overtimeThresholdUnits
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
    const dayPaid = dayPaidUnits(d);
    runningUnits += dayPaid;
    const dayOvertimeUnits = runningUnits > overtimeThresholdUnits
      ? (dayPaid < runningUnits - overtimeThresholdUnits
        ? dayPaid
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
    unpaid_meal_minutes: payrollNumber(unpaidMealUnitsTotal),
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
    'unpaid_meal_minutes',
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
      autoCloseReason: 'over_14_hours',
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
  closeActiveShiftAtomically,
  getStatus,
  adminEditEntry,
  adminAddEntry,
  confirmAutoClose,
  voidEntry,
  computeDailySummary,
  computeDailySummaryInTransaction,
  setDayNoLunch,
  computeWeeklySummary,
  computeWeeklySummaryInTransaction,
  lockStaffWeek,
  isCompletedEntryIntervalValid,
  getEntries,
  getDailySummaries,
  getWeeklySummaries,
  autoClockOutCheck,
};
