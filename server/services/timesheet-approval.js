/**
 * Weekly timesheet approval workflow.
 *
 * Builds on top of existing time-tracking service. Admin approves a tech's week,
 * which locks every time_entry in that window (approval_status='approved') and
 * flips the time_weekly_summary row to 'approved'. Disputes flag a single entry
 * so the tech can fix it and re-submit. Unlock reopens the whole week for edits.
 */
const db = require('../models/db');
const crypto = require('crypto');
const logger = require('./logger');
const timeTracking = require('./time-tracking');
const {
  STAFF_WORK_DATE_SQL,
  staffWeekRange,
  staffWeekStartForWorkDate,
  staffWorkDate,
  validateWorkDate,
} = require('../utils/staff-time-work-date');

function weekRange(weekStart) {
  return staffWeekRange(weekStart);
}

function approvalHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isOperational = true;
  return error;
}

function validateCanonicalWeek(weekStart) {
  let range;
  try {
    range = weekRange(weekStart);
  } catch (error) {
    throw approvalHttpError(400, error.message);
  }
  const { start, end } = range;
  if (staffWeekStartForWorkDate(start) !== start) {
    throw approvalHttpError(400, 'weekStart must be a Monday.');
  }
  return { start, end };
}

function validateApprovalWeek(weekStart, now = new Date()) {
  const { start, end } = validateCanonicalWeek(weekStart);
  if (end >= staffWorkDate(now)) {
    throw approvalHttpError(409, 'Only a completed Monday-Sunday week can be approved.');
  }
  return { start, end };
}

function validateSignableWeek(weekStart, now = new Date()) {
  const range = validateCanonicalWeek(weekStart);
  if (range.end >= staffWorkDate(now)) {
    throw approvalHttpError(409, 'Only a completed Monday-Sunday week can be signed.');
  }
  return range;
}

function normalizedEntryApprovalStatus(entry) {
  return entry.approval_status || 'pending';
}

function dateOnly(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value == null ? null : String(value).slice(0, 10);
}

function timestamp(value) {
  if (value == null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : String(value);
}

function reviewSnapshotToken({ weekly, dailies, entries }) {
  const payload = {
    weekly: weekly ? {
      id: weekly.id,
      technician_id: weekly.technician_id,
      week_start: dateOnly(weekly.week_start),
      week_end: dateOnly(weekly.week_end),
      total_shift_minutes: number(weekly.total_shift_minutes),
      total_job_minutes: number(weekly.total_job_minutes),
      total_drive_minutes: number(weekly.total_drive_minutes),
      regular_minutes: number(weekly.regular_minutes),
      overtime_minutes: number(weekly.overtime_minutes),
      days_worked: Number(weekly.days_worked || 0),
      job_count: Number(weekly.job_count || 0),
      total_revenue: number(weekly.total_revenue),
      avg_rpmh: number(weekly.avg_rpmh),
      utilization_pct: number(weekly.utilization_pct),
      status: weekly.status || 'pending',
      approved_by: weekly.approved_by || null,
      approved_at: timestamp(weekly.approved_at),
      approval_notes: weekly.approval_notes || null,
      tech_signed_at: timestamp(weekly.tech_signed_at),
      tech_signature: weekly.tech_signature || null,
    } : null,
    dailies: [...(dailies || [])]
      .sort((a, b) => dateOnly(a.work_date).localeCompare(dateOnly(b.work_date)))
      .map(daily => ({
        id: daily.id,
        work_date: dateOnly(daily.work_date),
        total_shift_minutes: number(daily.total_shift_minutes),
        total_job_minutes: number(daily.total_job_minutes),
        total_drive_minutes: number(daily.total_drive_minutes),
        total_break_minutes: number(daily.total_break_minutes),
        total_admin_minutes: number(daily.total_admin_minutes),
        overtime_minutes: number(daily.overtime_minutes),
        job_count: Number(daily.job_count || 0),
        revenue_generated: number(daily.revenue_generated),
        status: daily.status || 'pending',
      })),
    entries: [...(entries || [])]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map(entry => ({
        id: entry.id,
        entry_type: entry.entry_type,
        status: entry.status,
        approval_status: normalizedEntryApprovalStatus(entry),
        clock_in: timestamp(entry.clock_in),
        clock_out: timestamp(entry.clock_out),
        duration_minutes: number(entry.duration_minutes),
        job_id: entry.job_id || null,
        notes: entry.notes || null,
        edit_reason: entry.edit_reason || null,
      })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function hasSameTypeOverlap(entries) {
  for (const entryType of ['shift', 'job', 'break']) {
    const ordered = entries
      .filter(entry => entry.entry_type === entryType)
      .sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
    let priorMaxOut = Number.NEGATIVE_INFINITY;
    for (const entry of ordered) {
      const clockIn = new Date(entry.clock_in).getTime();
      const clockOut = new Date(entry.clock_out).getTime();
      if (clockIn < priorMaxOut) return true;
      priorMaxOut = Math.max(priorMaxOut, clockOut);
    }
  }
  return false;
}

function dailySummaryWorkDate(value) {
  if (typeof value === 'string') return validateWorkDate(value.slice(0, 10));
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getUTCFullYear(),
      String(value.getUTCMonth() + 1).padStart(2, '0'),
      String(value.getUTCDate()).padStart(2, '0'),
    ].join('-');
  }
  throw approvalHttpError(409, 'Daily summary contains an invalid work date.');
}

/**
 * Record the technician's attestation while holding the same week lock used by
 * edits, disputes, recomputation, and admin approval. The totals the tech reads
 * here therefore cannot change before the signature is committed.
 */
async function signWeek({ technicianId, weekStart, signature, reviewToken, now = new Date() }) {
  const normalizedSignature = String(signature || '').trim().slice(0, 200);
  if (!normalizedSignature) throw approvalHttpError(400, 'signature required (typed name)');
  if (!reviewToken || typeof reviewToken !== 'string') {
    throw approvalHttpError(400, 'reviewToken is required; reload the timecard before signing.');
  }
  const { start, end } = validateSignableWeek(weekStart, now);

  const result = await db.transaction(async (trx) => {
    await timeTracking.lockStaffWeek(trx, technicianId, start);
    const entries = await trx('time_entries')
      .where({ technician_id: technicianId })
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
      .where('status', '!=', 'voided')
      .orderBy('clock_in')
      .forUpdate();
    let dailies = await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .orderBy('work_date')
      .forUpdate();
    const workDates = [...new Set([
      ...entries.map(entry => staffWorkDate(entry.clock_in)),
      ...dailies.map(daily => dailySummaryWorkDate(daily.work_date)),
    ])].sort();
    for (const workDate of workDates) {
      await timeTracking.computeDailySummaryInTransaction(trx, technicianId, workDate);
    }
    const weekly = await timeTracking.computeWeeklySummaryInTransaction(
      trx,
      technicianId,
      start,
      { lock: false },
    );
    dailies = await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .orderBy('work_date')
      .forUpdate();

    if (
      entries.some(entry => normalizedEntryApprovalStatus(entry) === 'disputed')
      || dailies.some(daily => ['disputed', 'rejected'].includes(daily.status))
    ) {
      throw approvalHttpError(409, 'Resolve disputed or rejected time before signing the week.');
    }
    if (!dailies.some(daily => (
      Number(daily.total_shift_minutes || 0) > 0 || Number(daily.job_count || 0) > 0
    ))) throw approvalHttpError(404, 'No worked time on that week');
    if (!weekly) throw approvalHttpError(404, 'No timecard for that week');
    if (weekly.status === 'approved') {
      throw approvalHttpError(409, 'Week already approved by admin — cannot sign after lock');
    }
    if (reviewSnapshotToken({ weekly, dailies, entries }) !== reviewToken) {
      throw approvalHttpError(
        409,
        'Timecard changed after review; reload the latest totals before signing.',
      );
    }
    if (weekly.tech_signed_at) return { weekly, alreadySigned: true };

    const signedAt = new Date();
    const [signed] = await trx('time_weekly_summary')
      .where({ id: weekly.id })
      .whereNot({ status: 'approved' })
      .whereNull('tech_signed_at')
      .update({
        tech_signed_at: signedAt,
        tech_signature: normalizedSignature,
        updated_at: signedAt,
      })
      .returning('*');
    if (signed) return { weekly: signed, alreadySigned: false };

    const fresh = await trx('time_weekly_summary').where({ id: weekly.id }).first();
    if (fresh?.tech_signed_at) return { weekly: fresh, alreadySigned: true };
    throw approvalHttpError(
      409,
      'Week was approved before sign-off completed — refresh and try again',
    );
  });

  if (!result.alreadySigned) {
    logger.info(`[timesheet-approval] Week ${start} signed by tech ${technicianId}`, {
      weeklyId: result.weekly.id,
    });
  }
  return result;
}

async function loadWeekSnapshot(connection, technicianId, start, end) {
  const weekly = await connection('time_weekly_summary')
    .where({ technician_id: technicianId, week_start: start })
    .first();
  const dailies = await connection('time_entry_daily_summary')
    .where({ technician_id: technicianId })
    .where('work_date', '>=', start)
    .where('work_date', '<=', end)
    .orderBy('work_date');
  const entries = await connection('time_entries')
    .where({ technician_id: technicianId })
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
    .where('status', '!=', 'voided')
    .orderBy('clock_in');
  return { weekly, dailies, entries };
}

async function refreshWeekForReview(technicianId, start, end) {
  return db.transaction(async (trx) => {
    await timeTracking.lockStaffWeek(trx, technicianId, start);
    const entries = await trx('time_entries')
      .where({ technician_id: technicianId })
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
      .where('status', '!=', 'voided')
      .orderBy('clock_in')
      .forUpdate();
    let dailies = await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .orderBy('work_date')
      .forUpdate();
    const workDates = [...new Set([
      ...entries.map(entry => staffWorkDate(entry.clock_in)),
      ...dailies.map(daily => dailySummaryWorkDate(daily.work_date)),
    ])].sort();
    for (const workDate of workDates) {
      await timeTracking.computeDailySummaryInTransaction(trx, technicianId, workDate);
    }
    const weekly = await timeTracking.computeWeeklySummaryInTransaction(
      trx,
      technicianId,
      start,
      { lock: false },
    );
    dailies = await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .orderBy('work_date')
      .forUpdate();
    return { weekly, dailies, entries };
  });
}

/**
 * Get all pending weeks across active techs. Ensures the weekly summary row
 * exists (computes it on demand if there are daily summaries but no roll-up).
 */
async function getPendingWeeks(weekStart) {
  const { start, end } = validateCanonicalWeek(weekStart);
  // Include deactivated technicians and completed entries whose summary write
  // was interrupted. Both still represent payroll that must be reviewed.
  const dailyCandidates = await db('time_entry_daily_summary')
    .where('work_date', '>=', start)
    .where('work_date', '<=', end)
    .whereRaw(`(
      COALESCE(total_shift_minutes, 0) <> 0
      OR COALESCE(total_job_minutes, 0) <> 0
      OR COALESCE(total_drive_minutes, 0) <> 0
      OR COALESCE(total_break_minutes, 0) <> 0
      OR COALESCE(total_admin_minutes, 0) <> 0
      OR COALESCE(job_count, 0) <> 0
    )`)
    .select('technician_id');
  const entryCandidates = await db('time_entries')
    .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
    .where('status', '!=', 'voided')
    .select('technician_id');
  const technicianIds = [...new Set(
    [...dailyCandidates, ...entryCandidates].map(row => row.technician_id),
  )];
  if (!technicianIds.length) return [];
  const technicianRows = await db('technicians')
    .whereIn('id', technicianIds)
    .select('id', 'name');
  const names = new Map(technicianRows.map(row => [row.id, row.name]));
  const techs = technicianIds.map(id => ({ id, name: names.get(id) }));

  const results = [];
  for (const tech of techs) {
    let weekly = await db('time_weekly_summary')
      .where({ technician_id: tech.id, week_start: start })
      .first();

    let snapshot;
    if (!weekly || weekly.status !== 'approved') {
      try {
        snapshot = await refreshWeekForReview(tech.id, start, end);
        weekly = snapshot.weekly;
      } catch (err) {
        logger.warn(`[timesheet-approval] refreshWeekForReview failed for ${tech.name || tech.id}: ${err.message}`);
        continue;
      }
    }
    if (!weekly) continue;
    if (!snapshot) snapshot = await loadWeekSnapshot(db, tech.id, start, end);
    // The approved row may have advanced between the optimistic status read
    // and this snapshot load. Return and hash the same weekly revision so an
    // unlock token can never authorize data that was not shown to the admin.
    weekly = snapshot.weekly;
    const hasWorkedTime = snapshot.entries.length > 0 || snapshot.dailies.some(daily => (
      Number(daily.total_shift_minutes || 0) !== 0
      || Number(daily.total_job_minutes || 0) !== 0
      || Number(daily.total_drive_minutes || 0) !== 0
      || Number(daily.total_break_minutes || 0) !== 0
      || Number(daily.total_admin_minutes || 0) !== 0
      || Number(daily.job_count || 0) !== 0
    ));
    if (!hasWorkedTime) continue;

    results.push({
      ...weekly,
      tech_name: tech.name || 'Inactive technician',
      review_token: reviewSnapshotToken(snapshot),
    });
  }
  return results;
}

/**
 * Full week detail — weekly summary + daily breakdown + flagged entries.
 */
async function getWeekDetail(technicianId, weekStart) {
  const { start, end } = validateCanonicalWeek(weekStart);

  let weekly = await db('time_weekly_summary')
    .where({ technician_id: technicianId, week_start: start })
    .first();
  let snapshot;
  if (!weekly || weekly.status !== 'approved') {
    snapshot = await refreshWeekForReview(technicianId, start, end);
    weekly = snapshot.weekly;
  } else {
    snapshot = await loadWeekSnapshot(db, technicianId, start, end);
    weekly = snapshot.weekly;
  }
  const { dailies, entries } = snapshot;

  const tech = await db('technicians').where({ id: technicianId }).first();

  const reviewToken = reviewSnapshotToken({ weekly, dailies, entries });
  return {
    tech,
    weekly: weekly ? { ...weekly, review_token: reviewToken } : weekly,
    dailies,
    entries,
    reviewToken,
  };
}

/**
 * Approve the full week for a tech. Locks every non-voided entry in the window,
 * flips the daily and weekly summary status, stamps approved_by/at.
 */
async function approveWeek({ technicianId, weekStart, adminId, notes, reviewToken }) {
  const { start, end } = validateApprovalWeek(weekStart);
  if (!reviewToken || typeof reviewToken !== 'string') {
    throw approvalHttpError(400, 'reviewToken is required; reload the week before approval.');
  }
  const now = new Date();

  await db.transaction(async (trx) => {
    await timeTracking.lockStaffWeek(trx, technicianId, start);

    // Lock the source entries before computing the snapshot. Shift/child close
    // paths update the same rows, so approval either observes their completed
    // state or waits and then observes it; it can never approve an open timer.
    const entries = await trx('time_entries')
      .where({ technician_id: technicianId })
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
      .where('status', '!=', 'voided')
      .orderByRaw("CASE WHEN entry_type = 'shift' THEN 0 ELSE 1 END")
      .orderBy('clock_in')
      .orderBy('id')
      .forUpdate();
    if (!entries.length) {
      throw approvalHttpError(404, 'No time entries exist for that week.');
    }
    if (entries.some(entry => entry.status === 'active')) {
      throw approvalHttpError(409, 'End every active timer before approving the week.');
    }
    if (entries.some(entry => !['completed', 'edited'].includes(entry.status))) {
      throw approvalHttpError(409, 'Week contains an entry that is not ready for approval.');
    }
    if (entries.some(entry => !timeTracking.isCompletedEntryIntervalValid(entry))) {
      throw approvalHttpError(
        409,
        'Week contains an invalid time interval; correct it before approval.',
      );
    }
    const shifts = entries.filter(entry => entry.entry_type === 'shift');
    const orphanChild = entries.find(entry => (
      ['job', 'break', 'drive', 'admin_time'].includes(entry.entry_type)
      && !shifts.some(shift => (
        new Date(entry.clock_in).getTime() >= new Date(shift.clock_in).getTime()
        && new Date(entry.clock_out).getTime() <= new Date(shift.clock_out).getTime()
      ))
    ));
    if (orphanChild) {
      throw approvalHttpError(
        409,
        'Week contains child time outside a completed shift; correct it before approval.',
      );
    }
    if (hasSameTypeOverlap(entries)) {
      throw approvalHttpError(
        409,
        'Week contains overlapping shift, job, or break time; correct it before approval.',
      );
    }
    if (entries.some(entry => normalizedEntryApprovalStatus(entry) === 'disputed')) {
      throw approvalHttpError(409, 'Resolve every disputed entry before approving the week.');
    }
    if (entries.some(entry => !['pending', 'approved'].includes(normalizedEntryApprovalStatus(entry)))) {
      throw approvalHttpError(409, 'Week contains an entry with an invalid approval state.');
    }

    let dailies = await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .orderBy('work_date')
      .forUpdate();
    if (dailies.some(daily => !['pending', 'approved'].includes(daily.status))) {
      throw approvalHttpError(409, 'Resolve rejected or disputed days before approving the week.');
    }

    // A shift/child close commits its entry rows before it starts summary work.
    // Rebuild every source and existing-summary date here so approval cannot
    // overtake that follow-up work and freeze stale daily totals.
    const workDates = [...new Set([
      ...entries.map(entry => staffWorkDate(entry.clock_in)),
      ...dailies.map(daily => dailySummaryWorkDate(daily.work_date)),
    ])].sort();
    for (const workDate of workDates) {
      await timeTracking.computeDailySummaryInTransaction(trx, technicianId, workDate);
    }

    dailies = await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .orderBy('work_date')
      .forUpdate();
    if (!dailies.length) {
      throw approvalHttpError(404, 'No daily summaries exist for that week.');
    }
    if (dailies.some(daily => !['pending', 'approved'].includes(daily.status))) {
      throw approvalHttpError(409, 'Daily summary state changed while approval was being prepared.');
    }

    // Recompute under the same technician/week advisory lock and transaction
    // used for the state transition. Conditional summary upserts will not
    // rewrite an already-approved snapshot.
    const weekly = await timeTracking.computeWeeklySummaryInTransaction(
      trx,
      technicianId,
      start,
      { lock: false },
    );
    if (!weekly) throw approvalHttpError(404, 'No weekly summary exists for that week.');
    dailies = await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .orderBy('work_date')
      .forUpdate();
    const currentReviewToken = reviewSnapshotToken({ weekly, dailies, entries });
    if (currentReviewToken !== reviewToken) {
      throw approvalHttpError(
        409,
        'Timesheet changed after review; reload and review the latest totals before approval.',
      );
    }

    if (weekly.status === 'approved') {
      const entriesConsistent = entries.every(
        entry => normalizedEntryApprovalStatus(entry) === 'approved',
      );
      const dailiesConsistent = dailies.every(daily => daily.status === 'approved');
      if (!entriesConsistent || !dailiesConsistent) {
        throw approvalHttpError(
          409,
          'Approved week is inconsistent; unlock it before reconciling approval state.',
        );
      }
      return;
    }
    if (weekly.status !== 'pending') {
      throw approvalHttpError(409, `Week is ${weekly.status || 'not pending'} and cannot be approved.`);
    }
    const entriesPending = entries.every(
      entry => normalizedEntryApprovalStatus(entry) === 'pending',
    );
    const dailiesPending = dailies.every(daily => daily.status === 'pending');
    if (!entriesPending || !dailiesPending) {
      throw approvalHttpError(
        409,
        'Pending week has inconsistent approval state; reopen its days or unlock the week first.',
      );
    }

    await trx('time_entries')
      .whereIn('id', entries.map(entry => entry.id))
      .update({
        approval_status: 'approved',
        approved_by: adminId || null,
        approved_at: now,
        approval_notes: notes || null,
        updated_at: now,
      });

    await trx('time_entry_daily_summary')
      .whereIn('id', dailies.map(daily => daily.id))
      .update({
        status: 'approved',
        approved_by: adminId || null,
        approved_at: now,
        updated_at: now,
      });

    const [approvedWeekly] = await trx('time_weekly_summary')
      .where({ id: weekly.id, status: 'pending' })
      .update({
        status: 'approved',
        approved_by: adminId || null,
        approved_at: now,
        approval_notes: notes || null,
        updated_at: now,
      })
      .returning('*');
    if (!approvedWeekly) {
      throw approvalHttpError(409, 'Week changed while approval was being saved; reload and retry.');
    }
  });

  logger.info(`[timesheet-approval] Week ${start} approved for tech ${technicianId} by ${adminId}`);
  return getWeekDetail(technicianId, weekStart);
}

/**
 * Approve multiple techs' weeks in one shot.
 */
async function bulkApproveWeeks({ technicianIds, weekStart, adminId, notes, reviewTokens = {} }) {
  const results = { approved: 0, failed: [] };
  for (const techId of technicianIds) {
    try {
      await approveWeek({
        technicianId: techId,
        weekStart,
        adminId,
        notes,
        reviewToken: reviewTokens[techId],
      });
      results.approved++;
    } catch (err) {
      results.failed.push({ technicianId: techId, error: err.message });
    }
  }
  return results;
}

/**
 * Flag a single entry as disputed. Does NOT lock the rest of the week —
 * the tech can edit this entry and admin re-reviews.
 */
async function disputeEntry({ entryId, adminId, reason }) {
  if (!reason) throw approvalHttpError(400, 'reason required when disputing an entry');

  const entry = await db.transaction(async (trx) => {
    const preview = await trx('time_entries').where({ id: entryId }).first();
    if (!preview) throw approvalHttpError(404, 'Entry not found');
    const workDate = staffWorkDate(preview.clock_in);
    const weekStart = staffWeekStartForWorkDate(workDate);
    await timeTracking.lockStaffWeek(trx, preview.technician_id, weekStart);

    const locked = await trx('time_entries').where({ id: entryId }).forUpdate().first();
    if (!locked) throw approvalHttpError(404, 'Entry not found');
    if (
      locked.technician_id !== preview.technician_id
      || staffWeekStartForWorkDate(staffWorkDate(locked.clock_in)) !== weekStart
    ) {
      throw approvalHttpError(409, 'Entry changed; reload before disputing it.');
    }
    if (!['completed', 'edited'].includes(locked.status)) {
      throw approvalHttpError(409, 'Only a completed entry can be disputed.');
    }

    const daily = await trx('time_entry_daily_summary')
      .where({ technician_id: locked.technician_id, work_date: workDate })
      .forUpdate()
      .first('id', 'status');
    const weekly = await trx('time_weekly_summary')
      .where({ technician_id: locked.technician_id, week_start: weekStart })
      .forUpdate()
      .first('id', 'status');
    if (
      normalizedEntryApprovalStatus(locked) === 'approved'
      || daily?.status === 'approved'
      || weekly?.status === 'approved'
    ) {
      throw approvalHttpError(409, 'Unlock the approved week before disputing an entry.');
    }

    const now = new Date();
    const [updated] = await trx('time_entries')
      .where({ id: entryId, status: locked.status })
      .whereRaw("approval_status IS DISTINCT FROM 'approved'")
      .update({
        approval_status: 'disputed',
        approval_notes: reason,
        approved_by: adminId || null,
        approved_at: now,
        updated_at: now,
      })
      .returning('*');
    if (!updated) throw approvalHttpError(409, 'Entry changed; reload before disputing it.');

    if (daily) {
      await trx('time_entry_daily_summary')
        .where({ id: daily.id })
        .whereRaw("status IS DISTINCT FROM 'approved'")
        .update({ status: 'disputed', updated_at: now });
    }
    if (weekly) {
      await trx('time_weekly_summary')
        .where({ id: weekly.id })
        .whereNot({ status: 'approved' })
        .update({ tech_signed_at: null, tech_signature: null, updated_at: now });
    }
    return updated;
  });

  logger.info(`[timesheet-approval] Entry ${entryId} disputed by ${adminId}: ${reason}`);
  return entry;
}

/**
 * Reopen an approved week so the tech or admin can edit entries again.
 */
async function unlockWeek({ technicianId, weekStart, adminId, reason, reviewToken }) {
  const { start, end } = validateCanonicalWeek(weekStart);
  if (!reviewToken || typeof reviewToken !== 'string') {
    throw approvalHttpError(400, 'reviewToken is required; reload the approved week before unlock.');
  }
  const now = new Date();

  await db.transaction(async (trx) => {
    await timeTracking.lockStaffWeek(trx, technicianId, start);
    const weekly = await trx('time_weekly_summary')
      .where({ technician_id: technicianId, week_start: start })
      .forUpdate()
      .first();
    if (!weekly || weekly.status !== 'approved') {
      throw approvalHttpError(
        409,
        'Only the currently approved weekly snapshot can be unlocked; reload the week.',
      );
    }
    const dailies = await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .orderBy('work_date')
      .forUpdate();
    const entries = await trx('time_entries')
      .where({ technician_id: technicianId })
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
      .where('status', '!=', 'voided')
      .orderBy('clock_in')
      .forUpdate();
    if (reviewSnapshotToken({ weekly, dailies, entries }) !== reviewToken) {
      throw approvalHttpError(
        409,
        'Approved timesheet changed after review; reload before unlocking the current snapshot.',
      );
    }

    await trx('time_entries')
      .where({ technician_id: technicianId })
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
      .where('status', '!=', 'voided')
      .update({
        approval_status: 'pending',
        approved_by: null,
        approved_at: null,
        approval_notes: reason ? `[unlock] ${reason}` : null,
        updated_at: now,
      });

    await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .update({ status: 'pending', approved_by: null, approved_at: null, updated_at: now });

    // Clear tech sign-off too — once we've reopened entries, the
    // tech's previous "I attest" is stale by definition. Admins
    // who unlock should expect a fresh sign-off after the tech
    // fixes whatever broke.
    const updated = await trx('time_weekly_summary')
      .where({ id: weekly.id, status: 'approved' })
      .update({
        status: 'pending',
        approved_by: null,
        approved_at: null,
        tech_signed_at: null,
        tech_signature: null,
        updated_at: now,
      });
    if (updated !== 1) {
      throw approvalHttpError(409, 'Weekly snapshot changed before unlock; reload the week.');
    }
  });

  logger.info(`[timesheet-approval] Week ${start} unlocked for tech ${technicianId} by ${adminId}: ${reason || 'no reason'}`);
  return getWeekDetail(technicianId, weekStart);
}

/**
 * Weekly-level payroll CSV — one row per tech per week with totals and OT.
 */
async function generateWeeklyPayrollExport(weekStart, now = new Date()) {
  const { start, end } = validateApprovalWeek(weekStart, now);

  return db.transaction(async (trx) => {
    // Candidate discovery and approval verification must observe one point in
    // time. READ COMMITTED could discover one set of workers and then export a
    // different weekly-summary state after a concurrent edit commits.
    await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');

    // A payroll file is an all-or-nothing artifact. Discover worked technicians
    // independently of weekly summaries so a missing or still-pending roll-up
    // cannot silently disappear from the export.
    const dailyCandidates = await trx('time_entry_daily_summary')
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .whereRaw(`(
        COALESCE(total_shift_minutes, 0) <> 0
        OR COALESCE(total_job_minutes, 0) <> 0
        OR COALESCE(total_drive_minutes, 0) <> 0
        OR COALESCE(total_break_minutes, 0) <> 0
        OR COALESCE(total_admin_minutes, 0) <> 0
        OR COALESCE(job_count, 0) <> 0
      )`)
      .select('technician_id');
    const entryCandidates = await trx('time_entries')
      .whereRaw(`${STAFF_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`, [start, end])
      .where('status', '!=', 'voided')
      .select('technician_id');
    const technicianIds = [...new Set(
      [...dailyCandidates, ...entryCandidates].map(row => row.technician_id),
    )];
    if (!technicianIds.length) {
      throw approvalHttpError(409, 'No worked time exists for that payroll week.');
    }

    const rows = await trx('time_weekly_summary')
      .leftJoin('technicians', 'time_weekly_summary.technician_id', 'technicians.id')
      .where('time_weekly_summary.week_start', start)
      .whereIn('time_weekly_summary.technician_id', technicianIds)
      .select(
        'technicians.name as tech_name',
        'time_weekly_summary.*'
      )
      .orderBy('technicians.name');
    const approvedTechnicianIds = new Set(
      rows
        .filter(row => row.status === 'approved')
        .map(row => row.technician_id),
    );
    const everyWorkedTechnicianApproved = technicianIds.every(
      technicianId => approvedTechnicianIds.has(technicianId),
    );
    if (!everyWorkedTechnicianApproved || rows.some(row => row.status !== 'approved')) {
      throw approvalHttpError(
        409,
        'Payroll export is blocked until every worked technician has an approved weekly snapshot.',
      );
    }

    const headers = [
      'Tech', 'Week Start', 'Regular Hours', 'OT Hours', 'Total Hours',
      'Jobs', 'Revenue', 'RPMH', 'Utilization %', 'Status',
    ];

    const csvRows = rows.map(r => {
      const totalMin = parseFloat(r.total_shift_minutes || 0);
      const otMin = parseFloat(r.overtime_minutes || 0);
      const regMin = Math.max(0, totalMin - otMin);
      return [
        (r.tech_name || '').replace(/,/g, ' '),
        dateOnly(r.week_start),
        (regMin / 60).toFixed(2),
        (otMin / 60).toFixed(2),
        (totalMin / 60).toFixed(2),
        r.job_count || 0,
        parseFloat(r.total_revenue || 0).toFixed(2),
        parseFloat(r.avg_rpmh || 0).toFixed(2),
        parseFloat(r.utilization_pct || 0).toFixed(1),
        r.status || 'pending',
      ];
    });

    return [headers.join(','), ...csvRows.map(r => r.join(','))].join('\n');
  });
}

module.exports = {
  signWeek,
  getPendingWeeks,
  getWeekDetail,
  approveWeek,
  bulkApproveWeeks,
  disputeEntry,
  unlockWeek,
  generateWeeklyPayrollExport,
  _test: {
    hasSameTypeOverlap,
    reviewSnapshotToken,
    validateCanonicalWeek,
    validateApprovalWeek,
    validateSignableWeek,
  },
};
