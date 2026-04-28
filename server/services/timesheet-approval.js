/**
 * Weekly timesheet approval workflow.
 *
 * Builds on top of existing time-tracking service. Admin approves a tech's week,
 * which locks every time_entry in that window (approval_status='approved') and
 * flips the time_weekly_summary row to 'approved'. Disputes flag a single entry
 * so the tech can fix it and re-submit. Unlock reopens the whole week for edits.
 */
const db = require('../models/db');
const logger = require('./logger');
const timeTracking = require('./time-tracking');
const { etDateString, parseETDateTime, etWeekStart } = require('../utils/datetime-et');

function weekRange(weekStart) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  return { start: weekStart, end: end.toISOString().split('T')[0] };
}

/**
 * Get all pending weeks across active techs. Ensures the weekly summary row
 * exists (computes it on demand if there are daily summaries but no roll-up).
 */
async function getPendingWeeks(weekStart) {
  const { start, end } = weekRange(weekStart);
  const techs = await db('technicians').where({ active: true }).select('id', 'name');

  const results = [];
  for (const tech of techs) {
    const hasDailies = await db('time_entry_daily_summary')
      .where({ technician_id: tech.id })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .first();
    if (!hasDailies) continue;

    let weekly = await db('time_weekly_summary')
      .where({ technician_id: tech.id, week_start: start })
      .first();

    if (!weekly) {
      try {
        await timeTracking.computeWeeklySummary(tech.id, start);
        weekly = await db('time_weekly_summary')
          .where({ technician_id: tech.id, week_start: start })
          .first();
      } catch (err) {
        logger.warn(`[timesheet-approval] computeWeeklySummary failed for ${tech.name}: ${err.message}`);
        continue;
      }
    }
    if (!weekly) continue;

    results.push({ ...weekly, tech_name: tech.name });
  }
  return results;
}

/**
 * Full week detail — weekly summary + daily breakdown + flagged entries.
 */
async function getWeekDetail(technicianId, weekStart) {
  const { start, end } = weekRange(weekStart);

  let weekly = await db('time_weekly_summary')
    .where({ technician_id: technicianId, week_start: start })
    .first();
  if (!weekly) {
    await timeTracking.computeWeeklySummary(technicianId, start);
    weekly = await db('time_weekly_summary')
      .where({ technician_id: technicianId, week_start: start })
      .first();
  }

  const dailies = await db('time_entry_daily_summary')
    .where({ technician_id: technicianId })
    .where('work_date', '>=', start)
    .where('work_date', '<=', end)
    .orderBy('work_date');

  const entries = await db('time_entries')
    .where({ technician_id: technicianId })
    .whereRaw("DATE(clock_in) >= ?", [start])
    .whereRaw("DATE(clock_in) <= ?", [end])
    .where('status', '!=', 'voided')
    .orderBy('clock_in');

  const tech = await db('technicians').where({ id: technicianId }).first();

  return { tech, weekly, dailies, entries };
}

/**
 * Approve the full week for a tech. Locks every non-voided entry in the window,
 * flips the daily and weekly summary status, stamps approved_by/at.
 */
async function approveWeek({ technicianId, weekStart, adminId, notes }) {
  const { start, end } = weekRange(weekStart);
  const now = new Date();

  // Make sure weekly summary exists and reflects the latest dailies
  await timeTracking.computeWeeklySummary(technicianId, start);

  await db.transaction(async (trx) => {
    await trx('time_entries')
      .where({ technician_id: technicianId })
      .whereRaw("DATE(clock_in) >= ?", [start])
      .whereRaw("DATE(clock_in) <= ?", [end])
      .where('status', '!=', 'voided')
      .update({
        approval_status: 'approved',
        approved_by: adminId || null,
        approved_at: now,
        approval_notes: notes || null,
        updated_at: now,
      });

    await trx('time_entry_daily_summary')
      .where({ technician_id: technicianId })
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .update({
        status: 'approved',
        approved_by: adminId || null,
        approved_at: now,
        updated_at: now,
      });

    await trx('time_weekly_summary')
      .where({ technician_id: technicianId, week_start: start })
      .update({
        status: 'approved',
        approved_by: adminId || null,
        approved_at: now,
        updated_at: now,
      });
  });

  logger.info(`[timesheet-approval] Week ${start} approved for tech ${technicianId} by ${adminId}`);
  return getWeekDetail(technicianId, weekStart);
}

/**
 * Approve multiple techs' weeks in one shot.
 */
async function bulkApproveWeeks({ technicianIds, weekStart, adminId, notes }) {
  const results = { approved: 0, failed: [] };
  for (const techId of technicianIds) {
    try {
      await approveWeek({ technicianId: techId, weekStart, adminId, notes });
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
  if (!reason) throw new Error('reason required when disputing an entry');

  const entry = await db('time_entries').where({ id: entryId }).first();
  if (!entry) throw new Error('Entry not found');

  const now = new Date();
  await db('time_entries').where({ id: entryId }).update({
    approval_status: 'disputed',
    approval_notes: reason,
    approved_by: adminId || null,
    approved_at: now,
    updated_at: now,
  });

  const workDate = new Date(entry.clock_in).toISOString().split('T')[0];
  await db('time_entry_daily_summary')
    .where({ technician_id: entry.technician_id, work_date: workDate })
    .update({ status: 'disputed', updated_at: now });

  // Disputing an entry mutates the on-record hours for the week, so
  // any prior tech sign-off on this week is now stale — clear it so
  // the tech re-signs after the correction.
  const weekStart = etWeekStart(parseETDateTime(`${etDateString(new Date(entry.clock_in))}T12:00`));
  await db('time_weekly_summary')
    .where({ technician_id: entry.technician_id, week_start: weekStart })
    .whereNot({ status: 'approved' })
    .whereNotNull('tech_signed_at')
    .update({ tech_signed_at: null, tech_signature: null, updated_at: now });

  logger.info(`[timesheet-approval] Entry ${entryId} disputed by ${adminId}: ${reason}`);
  return db('time_entries').where({ id: entryId }).first();
}

/**
 * Reopen an approved week so the tech or admin can edit entries again.
 */
async function unlockWeek({ technicianId, weekStart, adminId, reason }) {
  const { start, end } = weekRange(weekStart);
  const now = new Date();

  await db.transaction(async (trx) => {
    await trx('time_entries')
      .where({ technician_id: technicianId })
      .whereRaw("DATE(clock_in) >= ?", [start])
      .whereRaw("DATE(clock_in) <= ?", [end])
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
    await trx('time_weekly_summary')
      .where({ technician_id: technicianId, week_start: start })
      .update({
        status: 'pending',
        approved_by: null,
        approved_at: null,
        tech_signed_at: null,
        tech_signature: null,
        updated_at: now,
      });
  });

  logger.info(`[timesheet-approval] Week ${start} unlocked for tech ${technicianId} by ${adminId}: ${reason || 'no reason'}`);
  return getWeekDetail(technicianId, weekStart);
}

/**
 * Weekly-level payroll CSV — one row per tech per week with totals and OT.
 */
async function generateWeeklyPayrollExport(weekStart) {
  const { start } = weekRange(weekStart);

  const rows = await db('time_weekly_summary')
    .leftJoin('technicians', 'time_weekly_summary.technician_id', 'technicians.id')
    .where({ week_start: start })
    .select(
      'technicians.name as tech_name',
      'time_weekly_summary.*'
    )
    .orderBy('technicians.name');

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
      r.week_start,
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
}

module.exports = {
  getPendingWeeks,
  getWeekDetail,
  approveWeek,
  bulkApproveWeeks,
  disputeEntry,
  unlockWeek,
  generateWeeklyPayrollExport,
};
