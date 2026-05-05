const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

const WEEKLY_OT_THRESHOLD = 2400; // 40 hours in minutes

/**
 * Clock in a technician for a new shift.
 */
async function clockIn(technicianId, { lat, lng, notes, source } = {}) {
  // Check for existing active shift
  const existing = await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' })
    .first();

  if (existing) {
    throw new Error('Already clocked in. Clock out before starting a new shift.');
  }

  const [entry] = await db('time_entries')
    .insert({
      technician_id: technicianId,
      entry_type: 'shift',
      status: 'active',
      clock_in: new Date(),
      clock_in_lat: lat || null,
      clock_in_lng: lng || null,
      notes: notes || null,
      source: source || 'app',
    })
    .returning('*');

  logger.info(`[time-tracking] Tech ${technicianId} clocked in`, { entryId: entry.id });
  return entry;
}

/**
 * Clock out a technician, closing any open sub-entries first.
 */
async function clockOut(technicianId, { lat, lng, notes } = {}) {
  const activeShift = await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' })
    .first();

  if (!activeShift) {
    throw new Error('Not currently clocked in.');
  }

  const now = new Date();

  // Close any open job entries
  await db('time_entries')
    .where({ technician_id: technicianId, status: 'active' })
    .whereIn('entry_type', ['job', 'break', 'drive', 'admin_time'])
    .update({
      status: 'completed',
      clock_out: now,
      duration_minutes: db.raw("EXTRACT(EPOCH FROM (? - clock_in)) / 60", [now]),
      updated_at: now,
    });

  // Close the shift
  const duration = (now - new Date(activeShift.clock_in)) / 60000;
  const [entry] = await db('time_entries')
    .where({ id: activeShift.id })
    .update({
      status: 'completed',
      clock_out: now,
      clock_out_lat: lat || null,
      clock_out_lng: lng || null,
      duration_minutes: Math.round(duration * 100) / 100,
      notes: notes ? `${activeShift.notes ? activeShift.notes + '; ' : ''}${notes}` : activeShift.notes,
      updated_at: now,
    })
    .returning('*');

  // Compute daily summary
  const workDate = new Date(activeShift.clock_in).toISOString().split('T')[0];
  await computeDailySummary(technicianId, workDate);

  logger.info(`[time-tracking] Tech ${technicianId} clocked out`, { entryId: entry.id, duration: entry.duration_minutes });
  return entry;
}

/**
 * Start a job entry (tech must be clocked in).
 */
async function startJob(technicianId, jobId, { lat, lng } = {}) {
  const activeShift = await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' })
    .first();

  if (!activeShift) {
    throw new Error('Must be clocked in to start a job.');
  }

  // Close any other active job entry
  const now = new Date();
  await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'job', status: 'active' })
    .update({
      status: 'completed',
      clock_out: now,
      duration_minutes: db.raw("EXTRACT(EPOCH FROM (? - clock_in)) / 60", [now]),
      updated_at: now,
    });

  // Lookup job details
  let customerId = null;
  let serviceType = null;
  if (jobId) {
    const job = await db('scheduled_services').where({ id: jobId }).first();
    if (job) {
      customerId = job.customer_id;
      serviceType = job.service_type;
    }
  }

  const [entry] = await db('time_entries')
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
    })
    .returning('*');

  logger.info(`[time-tracking] Tech ${technicianId} started job`, { entryId: entry.id, jobId });
  if (jobId) {
    try {
      const trackTransitions = require('./track-transitions');
      await trackTransitions.markOnProperty(jobId);
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
  const activeJob = await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'job', status: 'active' })
    .first();

  if (!activeJob) {
    throw new Error('No active job to end.');
  }

  const now = new Date();
  const duration = (now - new Date(activeJob.clock_in)) / 60000;

  const [entry] = await db('time_entries')
    .where({ id: activeJob.id })
    .update({
      status: 'completed',
      clock_out: now,
      clock_out_lat: lat || null,
      clock_out_lng: lng || null,
      duration_minutes: Math.round(duration * 100) / 100,
      updated_at: now,
    })
    .returning('*');

  logger.info(`[time-tracking] Tech ${technicianId} ended job`, { entryId: entry.id, duration: entry.duration_minutes });
  return entry;
}

/**
 * Start a break.
 */
async function startBreak(technicianId) {
  const activeShift = await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'shift', status: 'active' })
    .first();

  if (!activeShift) {
    throw new Error('Must be clocked in to start a break.');
  }

  const [entry] = await db('time_entries')
    .insert({
      technician_id: technicianId,
      entry_type: 'break',
      status: 'active',
      clock_in: new Date(),
      source: 'app',
    })
    .returning('*');

  logger.info(`[time-tracking] Tech ${technicianId} started break`, { entryId: entry.id });
  return entry;
}

/**
 * End the active break.
 */
async function endBreak(technicianId) {
  const activeBreak = await db('time_entries')
    .where({ technician_id: technicianId, entry_type: 'break', status: 'active' })
    .first();

  if (!activeBreak) {
    throw new Error('No active break to end.');
  }

  const now = new Date();
  const duration = (now - new Date(activeBreak.clock_in)) / 60000;

  const [entry] = await db('time_entries')
    .where({ id: activeBreak.id })
    .update({
      status: 'completed',
      clock_out: now,
      duration_minutes: Math.round(duration * 100) / 100,
      updated_at: now,
    })
    .returning('*');

  logger.info(`[time-tracking] Tech ${technicianId} ended break`, { entryId: entry.id, duration: entry.duration_minutes });
  return entry;
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
  const today = etDateString();
  const todayEntries = await db('time_entries')
    .where({ technician_id: technicianId })
    .where('status', '!=', 'voided')
    .whereRaw("DATE(clock_in) = ?", [today]);

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
  const entry = await db('time_entries').where({ id: entryId }).first();
  if (!entry) throw new Error('Entry not found.');
  if (entry.status === 'voided') throw new Error('Cannot edit a voided entry.');

  const updates = {
    status: 'edited',
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

  // Recompute duration if both times are set
  const finalIn = updates.clock_in || entry.clock_in;
  const finalOut = updates.clock_out || entry.clock_out;
  if (finalIn && finalOut) {
    updates.duration_minutes = Math.round(((new Date(finalOut) - new Date(finalIn)) / 60000) * 100) / 100;
  }

  const [updated] = await db('time_entries')
    .where({ id: entryId })
    .update(updates)
    .returning('*');

  // Recompute daily summary
  const workDate = new Date(updated.clock_in).toISOString().split('T')[0];
  await computeDailySummary(updated.technician_id, workDate);

  logger.info(`[time-tracking] Entry ${entryId} edited by ${edited_by}`, { edit_reason });
  return updated;
}

/**
 * Void an entry.
 */
async function voidEntry(entryId, { reason, voided_by }) {
  const entry = await db('time_entries').where({ id: entryId }).first();
  if (!entry) throw new Error('Entry not found.');

  const [updated] = await db('time_entries')
    .where({ id: entryId })
    .update({
      status: 'voided',
      edit_reason: reason,
      edited_by: voided_by,
      edited_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*');

  // Recompute daily summary
  const workDate = new Date(updated.clock_in).toISOString().split('T')[0];
  await computeDailySummary(updated.technician_id, workDate);

  logger.info(`[time-tracking] Entry ${entryId} voided by ${voided_by}`, { reason });
  return updated;
}

/**
 * Compute daily summary for a technician on a specific date.
 */
async function computeDailySummary(technicianId, date) {
  const entries = await db('time_entries')
    .where({ technician_id: technicianId })
    .where('status', '!=', 'voided')
    .whereRaw("DATE(clock_in) = ?", [date]);

  const shiftEntries = entries.filter(e => e.entry_type === 'shift');
  const jobEntries = entries.filter(e => e.entry_type === 'job' && e.status !== 'active');
  const driveEntries = entries.filter(e => e.entry_type === 'drive');
  const breakEntries = entries.filter(e => e.entry_type === 'break');
  const adminEntries = entries.filter(e => e.entry_type === 'admin_time');

  const sum = (arr) => arr.reduce((s, e) => s + (parseFloat(e.duration_minutes) || 0), 0);

  const totalShift = sum(shiftEntries);
  const totalJob = sum(jobEntries);
  const totalDrive = sum(driveEntries);
  const totalBreak = sum(breakEntries);
  const totalAdmin = sum(adminEntries);
  const jobCount = jobEntries.length;

  const firstIn = shiftEntries.length > 0
    ? shiftEntries.reduce((min, e) => (e.clock_in < min ? e.clock_in : min), shiftEntries[0].clock_in)
    : null;
  const lastOut = shiftEntries.length > 0
    ? shiftEntries.reduce((max, e) => (e.clock_out > max ? e.clock_out : max), shiftEntries[0].clock_out)
    : null;

  // Utilization = job time / shift time
  const utilization = totalShift > 0 ? Math.round((totalJob / totalShift) * 10000) / 100 : 0;

  // Revenue from completed jobs that day
  const jobIds = jobEntries.filter(e => e.job_id).map(e => e.job_id);
  let revenue = 0;
  if (jobIds.length > 0) {
    const jobs = await db('scheduled_services').whereIn('id', jobIds).select('price');
    revenue = jobs.reduce((s, j) => s + (parseFloat(j.price) || 0), 0);
  }

  // RPMH = revenue per man-hour
  const shiftHours = totalShift / 60;
  const rpmh = shiftHours > 0 ? Math.round((revenue / shiftHours) * 100) / 100 : 0;

  const summaryData = {
    technician_id: technicianId,
    work_date: date,
    total_shift_minutes: Math.round(totalShift * 100) / 100,
    total_job_minutes: Math.round(totalJob * 100) / 100,
    total_drive_minutes: Math.round(totalDrive * 100) / 100,
    total_break_minutes: Math.round(totalBreak * 100) / 100,
    total_admin_minutes: Math.round(totalAdmin * 100) / 100,
    job_count: jobCount,
    first_clock_in: firstIn,
    last_clock_out: lastOut,
    overtime_minutes: 0, // Calculated at weekly level for FL
    utilization_pct: utilization,
    revenue_generated: revenue,
    rpmh_actual: rpmh,
    updated_at: new Date(),
  };

  // Upsert
  const existing = await db('time_entry_daily_summary')
    .where({ technician_id: technicianId, work_date: date })
    .first();

  if (existing) {
    await db('time_entry_daily_summary').where({ id: existing.id }).update(summaryData);
  } else {
    summaryData.created_at = new Date();
    await db('time_entry_daily_summary').insert(summaryData);
  }

  logger.info(`[time-tracking] Daily summary computed for tech ${technicianId} on ${date}`);
  return summaryData;
}

/**
 * Compute weekly summary. FL has no daily OT — only federal 40hr/week.
 */
async function computeWeeklySummary(technicianId, weekStart) {
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  const weekEndStr = weekEnd.toISOString().split('T')[0];

  const dailies = await db('time_entry_daily_summary')
    .where({ technician_id: technicianId })
    .where('work_date', '>=', weekStart)
    .where('work_date', '<=', weekEndStr);

  const totalShift = dailies.reduce((s, d) => s + parseFloat(d.total_shift_minutes || 0), 0);
  const totalJob = dailies.reduce((s, d) => s + parseFloat(d.total_job_minutes || 0), 0);
  const totalDrive = dailies.reduce((s, d) => s + parseFloat(d.total_drive_minutes || 0), 0);
  const totalRevenue = dailies.reduce((s, d) => s + parseFloat(d.revenue_generated || 0), 0);
  const jobCount = dailies.reduce((s, d) => s + (d.job_count || 0), 0);
  const daysWorked = dailies.filter(d => parseFloat(d.total_shift_minutes || 0) > 0).length;

  const regularMinutes = Math.min(totalShift, WEEKLY_OT_THRESHOLD);
  const overtimeMinutes = Math.max(0, totalShift - WEEKLY_OT_THRESHOLD);

  const shiftHours = totalShift / 60;
  const avgRpmh = shiftHours > 0 ? Math.round((totalRevenue / shiftHours) * 100) / 100 : 0;
  const utilization = totalShift > 0 ? Math.round((totalJob / totalShift) * 10000) / 100 : 0;

  // Also update daily OT allocation (assign OT to later days)
  let runningMinutes = 0;
  const sortedDailies = [...dailies].sort((a, b) => a.work_date < b.work_date ? -1 : 1);
  for (const d of sortedDailies) {
    const dayShift = parseFloat(d.total_shift_minutes || 0);
    const prevRunning = runningMinutes;
    runningMinutes += dayShift;
    const dayOT = runningMinutes > WEEKLY_OT_THRESHOLD
      ? Math.min(dayShift, runningMinutes - WEEKLY_OT_THRESHOLD)
      : 0;
    if (dayOT !== parseFloat(d.overtime_minutes || 0)) {
      await db('time_entry_daily_summary').where({ id: d.id }).update({ overtime_minutes: dayOT });
    }
  }

  const summaryData = {
    technician_id: technicianId,
    week_start: weekStart,
    week_end: weekEndStr,
    total_shift_minutes: Math.round(totalShift * 100) / 100,
    total_job_minutes: Math.round(totalJob * 100) / 100,
    total_drive_minutes: Math.round(totalDrive * 100) / 100,
    regular_minutes: regularMinutes,
    overtime_minutes: overtimeMinutes,
    days_worked: daysWorked,
    job_count: jobCount,
    total_revenue: totalRevenue,
    avg_rpmh: avgRpmh,
    utilization_pct: utilization,
    updated_at: new Date(),
  };

  const existing = await db('time_weekly_summary')
    .where({ technician_id: technicianId, week_start: weekStart })
    .first();

  if (existing) {
    await db('time_weekly_summary').where({ id: existing.id }).update(summaryData);
  } else {
    summaryData.created_at = new Date();
    await db('time_weekly_summary').insert(summaryData);
  }

  logger.info(`[time-tracking] Weekly summary computed for tech ${technicianId}, week of ${weekStart}`);
  return summaryData;
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
  if (startDate) query = query.where('time_entries.clock_in', '>=', startDate);
  if (endDate) query = query.where('time_entries.clock_in', '<=', endDate + ' 23:59:59');
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
    const now = new Date();

    // Close any sub-entries
    await db('time_entries')
      .where({ technician_id: shift.technician_id, status: 'active' })
      .whereIn('entry_type', ['job', 'break', 'drive', 'admin_time'])
      .update({
        status: 'completed',
        clock_out: now,
        duration_minutes: db.raw("EXTRACT(EPOCH FROM (? - clock_in)) / 60", [now]),
        notes: db.raw("COALESCE(notes, '') || ' [auto-closed]'"),
        updated_at: now,
      });

    const duration = (now - new Date(shift.clock_in)) / 60000;
    await db('time_entries')
      .where({ id: shift.id })
      .update({
        status: 'completed',
        clock_out: now,
        duration_minutes: Math.round(duration * 100) / 100,
        notes: (shift.notes ? shift.notes + '; ' : '') + 'AUTO CLOCK-OUT: exceeded 14-hour limit',
        updated_at: now,
      });

    const workDate = new Date(shift.clock_in).toISOString().split('T')[0];
    await computeDailySummary(shift.technician_id, workDate);

    results.push({ technicianId: shift.technician_id, entryId: shift.id, duration });
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
  getStatus,
  adminEditEntry,
  voidEntry,
  computeDailySummary,
  computeWeeklySummary,
  getEntries,
  getDailySummaries,
  getWeeklySummaries,
  autoClockOutCheck,
};
