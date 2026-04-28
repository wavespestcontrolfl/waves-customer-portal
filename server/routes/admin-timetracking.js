const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const timeTracking = require('../services/time-tracking');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { etParts, etDateString, addETDays, parseETDateTime, etWeekStart } = require('../utils/datetime-et');

// Pure calendar arithmetic on YYYY-MM-DD strings — no timezone enters
// because we never read hours. Use this anywhere we need a "+ N days
// from this calendar date" string, instead of stringing together
// addETDays + etDateString (which works but invites questions every
// time it's audited).
function addCalendarDaysToYMD(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// When an admin mutates time data on a week the tech has already
// signed (PUT/DELETE entries, daily reject/reopen, dispute), the
// previous attestation no longer reflects the on-record hours. Clear
// the sign-off so the tech has to re-sign after seeing the corrected
// data. No-ops on already-approved weeks (admin-side approval is the
// terminal lock; we don't reach into a locked row from here).
async function clearTechSignoffForWeek(technicianId, workDate, trx) {
  if (!technicianId || !workDate) return;
  // Two input shapes:
  //   - YYYY-MM-DD (work_date DATE column from daily summaries) — use as-is
  //   - timestamp string or Date (clock_in TIMESTAMP from time_entries) —
  //     convert through etDateString so we get the ET calendar date.
  //     A naive split('T')[0] would treat 03:30 UTC (which is the prior
  //     day in ET) as the same calendar day, clearing the wrong week.
  let dateStr;
  if (typeof workDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    dateStr = workDate;
  } else {
    dateStr = etDateString(new Date(workDate));
  }
  const weekStart = etWeekStart(parseETDateTime(`${dateStr}T12:00`));
  await (trx || db)('time_weekly_summary')
    .where({ technician_id: technicianId, week_start: weekStart })
    .whereNot({ status: 'approved' })
    .whereNotNull('tech_signed_at')
    .update({ tech_signed_at: null, tech_signature: null, updated_at: new Date() });
}

router.use(adminAuthenticate, requireTechOrAdmin);

// Allowlist of `technicians` columns safe to expose to tech-role
// callers (other techs hitting GET /technicians for a roster view).
// Allowlist over denylist — an unknown future column added to the
// table (auth tokens, password resets, anything HR adds) defaults to
// "not exposed" instead of "leaked until somebody updates the
// denylist." password_hash specifically lives on this table.
const PUBLIC_TECH_FIELDS = [
  'id', 'name', 'phone', 'email', 'role',
  'active', 'auto_flip_enabled',
  'avatar_url',
  'created_at', 'updated_at',
];

function sanitizeTechForNonAdmin(tech) {
  const out = {};
  for (const f of PUBLIC_TECH_FIELDS) {
    if (f in tech) out[f] = tech[f];
  }
  return out;
}

// Authoritative admin check — reads from req.technician.role (the
// full DB row attached by adminAuthenticate), not the parallel
// req.techRole convenience field, so renaming/drift on the convenience
// field can't cause this to fail open. Fails closed: any missing
// piece treats the caller as non-admin.
function isAdminCaller(req) {
  return !!(req.technician && req.technician.role === 'admin');
}

// Auto-create tables if missing
async function ensureTables() {
  if (!(await db.schema.hasTable('time_entries'))) {
    await db.schema.createTable('time_entries', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id').notNullable(); t.string('entry_type', 20).defaultTo('shift');
      t.string('status', 20).defaultTo('active'); t.timestamp('clock_in').notNullable();
      t.timestamp('clock_out'); t.decimal('duration_minutes', 8, 2); t.uuid('job_id'); t.uuid('customer_id');
      t.decimal('clock_in_lat', 10, 7); t.decimal('clock_in_lng', 10, 7);
      t.decimal('clock_out_lat', 10, 7); t.decimal('clock_out_lng', 10, 7);
      t.string('service_type', 50); t.string('pay_type', 20).defaultTo('regular');
      t.text('notes'); t.text('edit_reason'); t.string('edited_by', 100);
      t.string('source', 20).defaultTo('tech_app'); t.timestamps(true, true);
    });
    logger.info('[timetracking] Auto-created time_entries table');
  }
  if (!(await db.schema.hasTable('time_entry_daily_summary'))) {
    await db.schema.createTable('time_entry_daily_summary', t => {
      t.increments('id'); t.uuid('technician_id').notNullable(); t.date('work_date').notNullable();
      t.decimal('total_shift_minutes', 8, 2).defaultTo(0); t.decimal('total_job_minutes', 8, 2).defaultTo(0);
      t.decimal('total_drive_minutes', 8, 2).defaultTo(0); t.decimal('total_break_minutes', 8, 2).defaultTo(0);
      t.integer('job_count').defaultTo(0); t.decimal('overtime_minutes', 8, 2).defaultTo(0);
      t.decimal('utilization_pct', 5, 2); t.decimal('revenue_generated', 10, 2).defaultTo(0);
      t.string('status', 20).defaultTo('pending'); t.timestamps(true, true);
      t.unique(['technician_id', 'work_date']);
    });
    logger.info('[timetracking] Auto-created time_entry_daily_summary table');
  }
  if (!(await db.schema.hasTable('time_weekly_summary'))) {
    await db.schema.createTable('time_weekly_summary', t => {
      t.increments('id'); t.uuid('technician_id').notNullable(); t.date('week_start').notNullable();
      t.date('week_end').notNullable(); t.decimal('total_shift_minutes', 8, 2).defaultTo(0);
      t.decimal('regular_minutes', 8, 2).defaultTo(0); t.decimal('overtime_minutes', 8, 2).defaultTo(0);
      t.integer('days_worked').defaultTo(0); t.integer('job_count').defaultTo(0);
      t.string('status', 20).defaultTo('pending'); t.timestamps(true, true);
      t.unique(['technician_id', 'week_start']);
    });
    logger.info('[timetracking] Auto-created time_weekly_summary table');
  }
}

// ---------------------------------------------------------------------------
// GET /  — Dashboard: who's clocked in, today's labor, weekly stats
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    await ensureTables();
    const today = etDateString(new Date());

    // Active shifts
    const activeShifts = await db('time_entries')
      .where({ entry_type: 'shift', status: 'active' })
      .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
      .select(
        'time_entries.*',
        'technicians.name as tech_name',
      );

    // Enrich each with current job/break status
    const liveStatus = await Promise.all(activeShifts.map(async (shift) => {
      const currentJob = await db('time_entries')
        .where({ technician_id: shift.technician_id, entry_type: 'job', status: 'active' })
        .leftJoin('customers', 'time_entries.customer_id', 'customers.id')
        .select('time_entries.*', 'customers.first_name', 'customers.last_name')
        .first();
      const onBreak = await db('time_entries')
        .where({ technician_id: shift.technician_id, entry_type: 'break', status: 'active' })
        .first();
      return {
        ...shift,
        currentJob: currentJob || null,
        onBreak: !!onBreak,
      };
    }));

    // Today's daily summaries
    const todaySummaries = await db('time_entry_daily_summary')
      .where({ work_date: today })
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select('time_entry_daily_summary.*', 'technicians.name as tech_name');

    // This week's summaries — Monday-anchored week in ET.
    const now = new Date();
    const dayOfWeek = etParts(now).dayOfWeek;
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStartStr = etDateString(addETDays(now, mondayOffset));

    const weekDailies = await db('time_entry_daily_summary')
      .where('work_date', '>=', weekStartStr)
      .where('work_date', '<=', today)
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select('time_entry_daily_summary.*', 'technicians.name as tech_name');

    // All technicians for status display. pay_rate flows through
    // so the dashboard can compute labor cost at per-tech rates
    // instead of the legacy hardcoded $35 — admin only. Tech-role
    // callers (dispatch, status displays) get the same row shape with
    // pay_rate stripped so they never see coworker wages.
    const techCols = ['id', 'name', 'role'];
    if (isAdminCaller(req)) techCols.push('pay_rate');
    const allTechs = await db('technicians')
      .where({ active: true })
      .select(techCols);

    res.json({
      activeShifts: liveStatus,
      todaySummaries,
      weekDailies,
      allTechs,
      today,
      weekStart: weekStartStr,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /entries — paginated entries with filters
// ---------------------------------------------------------------------------
router.get('/entries', async (req, res, next) => {
  try {
    const { technicianId, startDate, endDate, entryType, status, limit, offset } = req.query;
    const result = await timeTracking.getEntries({
      technicianId,
      startDate,
      endDate,
      entryType,
      status,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /entries/:id — single entry
// ---------------------------------------------------------------------------
router.get('/entries/:id', async (req, res, next) => {
  try {
    const entry = await db('time_entries')
      .where('time_entries.id', req.params.id)
      .leftJoin('customers', 'time_entries.customer_id', 'customers.id')
      .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
      .leftJoin('scheduled_services', 'time_entries.job_id', 'scheduled_services.id')
      .select(
        'time_entries.*',
        'customers.first_name as customer_first_name',
        'customers.last_name as customer_last_name',
        'technicians.name as tech_name',
        'scheduled_services.service_type as job_service_type',
      )
      .first();
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /entries/:id — admin edit (requires edit_reason)
// ---------------------------------------------------------------------------
router.put('/entries/:id', async (req, res, next) => {
  try {
    const { clock_in, clock_out, entry_type, notes, edit_reason } = req.body;
    if (!edit_reason) return res.status(400).json({ error: 'edit_reason is required' });

    const updated = await timeTracking.adminEditEntry(req.params.id, {
      clock_in,
      clock_out,
      entry_type,
      notes,
      edit_reason,
      edited_by: req.technicianId,
    });
    if (updated && updated.technician_id) {
      await clearTechSignoffForWeek(updated.technician_id, updated.clock_in);
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /entries/:id — void entry
// ---------------------------------------------------------------------------
router.delete('/entries/:id', async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const voided = await timeTracking.voidEntry(req.params.id, {
      reason: reason || 'Admin voided',
      voided_by: req.technicianId,
    });
    if (voided && voided.technician_id) {
      await clearTechSignoffForWeek(voided.technician_id, voided.clock_in);
    }
    res.json(voided);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /daily — daily summaries with filters
// ---------------------------------------------------------------------------
router.get('/daily', async (req, res, next) => {
  try {
    const { technicianId, startDate, endDate, status } = req.query;
    const summaries = await timeTracking.getDailySummaries({ technicianId, startDate, endDate, status });
    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Helpers — audit + SMS for approval actions
// ---------------------------------------------------------------------------
async function recordApprovalAudit(summary, action, adminId, reason) {
  try {
    await db('timesheet_approvals').insert({
      daily_summary_id: summary.id,
      technician_id: summary.technician_id,
      work_date: summary.work_date,
      action,
      admin_id: adminId || null,
      reason: reason || null,
      prior_status: summary.status || null,
    });
  } catch (e) {
    logger.error(`[timetracking] approval audit failed: ${e.message}`);
  }
}

async function notifyTechOfApproval(summary, action, reason) {
  try {
    const tech = await db('technicians').where({ id: summary.technician_id }).first();
    if (!tech?.phone) return;
    const dateStr = new Date(summary.work_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    const hrs = ((summary.total_shift_minutes || 0) / 60).toFixed(2);
    const TwilioService = require('../services/twilio');
    let body;
    if (action === 'approved') {
      body = `Waves: Your timesheet for ${dateStr} (${hrs} hrs) has been approved.`;
    } else if (action === 'rejected') {
      body = `Waves: Your timesheet for ${dateStr} needs a correction${reason ? ` — ${reason}` : ''}. Open the tech app to review and resubmit.`;
    } else {
      body = `Waves: Your timesheet for ${dateStr} has been reopened.`;
    }
    await TwilioService.sendSMS(tech.phone, body);
  } catch (e) {
    logger.error(`[timetracking] tech SMS failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// PUT /daily/:id/approve — approve a daily summary
// ---------------------------------------------------------------------------
router.put('/daily/:id/approve', async (req, res, next) => {
  try {
    const prior = await db('time_entry_daily_summary').where({ id: req.params.id }).first();
    if (!prior) return res.status(404).json({ error: 'Summary not found' });
    const [updated] = await db('time_entry_daily_summary')
      .where({ id: req.params.id })
      .update({
        status: 'approved',
        approved_by: req.technicianId,
        approved_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');
    await recordApprovalAudit(prior, 'approved', req.technicianId, null);
    notifyTechOfApproval(updated, 'approved');
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /daily/:id/reject — reject a daily summary with reason
// ---------------------------------------------------------------------------
router.put('/daily/:id/reject', async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'reason required' });
    }
    const prior = await db('time_entry_daily_summary').where({ id: req.params.id }).first();
    if (!prior) return res.status(404).json({ error: 'Summary not found' });
    const [updated] = await db('time_entry_daily_summary')
      .where({ id: req.params.id })
      .update({
        status: 'rejected',
        approved_by: req.technicianId,
        approved_at: new Date(),
        notes: reason,
        updated_at: new Date(),
      })
      .returning('*');
    await recordApprovalAudit(prior, 'rejected', req.technicianId, reason);
    await clearTechSignoffForWeek(updated.technician_id, updated.work_date);
    notifyTechOfApproval(updated, 'rejected', reason);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /daily/:id/reopen — return an approved/rejected summary to pending
// ---------------------------------------------------------------------------
router.put('/daily/:id/reopen', async (req, res, next) => {
  try {
    const prior = await db('time_entry_daily_summary').where({ id: req.params.id }).first();
    if (!prior) return res.status(404).json({ error: 'Summary not found' });
    const [updated] = await db('time_entry_daily_summary')
      .where({ id: req.params.id })
      .update({
        status: 'pending',
        approved_by: null,
        approved_at: null,
        updated_at: new Date(),
      })
      .returning('*');
    await recordApprovalAudit(prior, 'reopened', req.technicianId, req.body?.reason || null);
    await clearTechSignoffForWeek(updated.technician_id, updated.work_date);
    notifyTechOfApproval(updated, 'reopened');
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /daily/:id/history — approval audit trail for a summary
// ---------------------------------------------------------------------------
router.get('/daily/:id/history', async (req, res, next) => {
  try {
    const rows = await db('timesheet_approvals')
      .where({ daily_summary_id: req.params.id })
      .leftJoin('technicians', 'technicians.id', 'timesheet_approvals.admin_id')
      .select(
        'timesheet_approvals.id',
        'timesheet_approvals.action',
        'timesheet_approvals.reason',
        'timesheet_approvals.prior_status',
        'timesheet_approvals.created_at',
        'technicians.name as admin_name',
      )
      .orderBy('timesheet_approvals.created_at', 'desc');
    res.json({ history: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /daily/bulk-approve — approve multiple daily summaries
// ---------------------------------------------------------------------------
router.post('/daily/bulk-approve', async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    const priors = await db('time_entry_daily_summary')
      .whereIn('id', ids).where('status', 'pending').select('*');
    const count = await db('time_entry_daily_summary')
      .whereIn('id', ids)
      .where('status', 'pending')
      .update({
        status: 'approved',
        approved_by: req.technicianId,
        approved_at: new Date(),
        updated_at: new Date(),
      });
    // Audit + notify each
    for (const prior of priors) {
      await recordApprovalAudit(prior, 'approved', req.technicianId, null);
      notifyTechOfApproval({ ...prior, status: 'approved' }, 'approved');
    }
    res.json({ approved: count });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /weekly — weekly summaries
// ---------------------------------------------------------------------------
router.get('/weekly', async (req, res, next) => {
  try {
    const { technicianId, startDate, endDate } = req.query;
    const summaries = await timeTracking.getWeeklySummaries({ technicianId, startDate, endDate });
    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /payroll-export — CSV export for a week
// ---------------------------------------------------------------------------
router.get('/payroll-export', async (req, res, next) => {
  try {
    const { weekStart } = req.query;
    if (!weekStart) return res.status(400).json({ error: 'weekStart required (YYYY-MM-DD, Monday)' });

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    const weekEndStr = weekEnd.toISOString().split('T')[0];

    const dailies = await db('time_entry_daily_summary')
      .where('work_date', '>=', weekStart)
      .where('work_date', '<=', weekEndStr)
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select('time_entry_daily_summary.*', 'technicians.name as tech_name')
      .orderBy(['technicians.name', 'work_date']);

    // Build CSV
    const headers = [
      'Tech Name', 'Date', 'Shift Hours', 'Job Hours', 'Drive Hours', 'Break Hours',
      'Admin Hours', 'OT Hours', 'Jobs', 'Revenue', 'RPMH', 'Utilization %', 'Status',
    ];
    const rows = dailies.map(d => [
      d.tech_name,
      d.work_date,
      (parseFloat(d.total_shift_minutes || 0) / 60).toFixed(2),
      (parseFloat(d.total_job_minutes || 0) / 60).toFixed(2),
      (parseFloat(d.total_drive_minutes || 0) / 60).toFixed(2),
      (parseFloat(d.total_break_minutes || 0) / 60).toFixed(2),
      (parseFloat(d.total_admin_minutes || 0) / 60).toFixed(2),
      (parseFloat(d.overtime_minutes || 0) / 60).toFixed(2),
      d.job_count,
      parseFloat(d.revenue_generated || 0).toFixed(2),
      parseFloat(d.rpmh_actual || 0).toFixed(2),
      parseFloat(d.utilization_pct || 0).toFixed(1),
      d.status,
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payroll_${weekStart}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /analytics — actual vs estimated, utilization, RPMH, overtime
// ---------------------------------------------------------------------------
router.get('/analytics', async (req, res, next) => {
  try {
    const { startDate, endDate, technicianId } = req.query;
    const start = startDate || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const end = endDate || etDateString();

    // Actual vs estimated by service type
    let svcQuery = db('time_entries')
      .where('time_entries.entry_type', 'job')
      .where('time_entries.status', '!=', 'voided')
      .whereNotNull('time_entries.duration_minutes')
      .whereNotNull('time_entries.job_id')
      .where('time_entries.clock_in', '>=', start)
      .where('time_entries.clock_in', '<=', end + ' 23:59:59')
      .leftJoin('scheduled_services', 'time_entries.job_id', 'scheduled_services.id')
      .select(
        db.raw("COALESCE(time_entries.service_type, scheduled_services.service_type, 'Unknown') as svc_type"),
        db.raw('AVG(time_entries.duration_minutes) as avg_actual'),
        db.raw('COUNT(*) as job_count'),
        db.raw('AVG(scheduled_services.estimated_duration) as avg_estimated'),
      )
      .groupByRaw("COALESCE(time_entries.service_type, scheduled_services.service_type, 'Unknown')");

    if (technicianId) svcQuery = svcQuery.where('time_entries.technician_id', technicianId);
    const serviceTypeStats = await svcQuery;

    // Utilization by tech
    let utilQuery = db('time_entry_daily_summary')
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select(
        'technicians.name as tech_name',
        'time_entry_daily_summary.technician_id',
        db.raw('AVG(utilization_pct) as avg_utilization'),
        db.raw('SUM(total_shift_minutes) as total_shift'),
        db.raw('SUM(total_job_minutes) as total_job'),
        db.raw('SUM(revenue_generated) as total_revenue'),
        db.raw('SUM(overtime_minutes) as total_ot'),
        db.raw('SUM(job_count) as total_jobs'),
      )
      .groupBy('technicians.name', 'time_entry_daily_summary.technician_id');

    if (technicianId) utilQuery = utilQuery.where('time_entry_daily_summary.technician_id', technicianId);
    const utilizationByTech = await utilQuery;

    // RPMH by tech (recent weeks)
    const fourWeeksAgo = new Date(Date.now() - 28 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const rpmhByTech = await db('time_weekly_summary')
      .where('week_start', '>=', fourWeeksAgo)
      .leftJoin('technicians', 'time_weekly_summary.technician_id', 'technicians.id')
      .select(
        'technicians.name as tech_name',
        'time_weekly_summary.technician_id',
        'time_weekly_summary.week_start',
        'time_weekly_summary.avg_rpmh',
        'time_weekly_summary.total_revenue',
        'time_weekly_summary.total_shift_minutes',
        'time_weekly_summary.overtime_minutes',
      )
      .orderBy(['technicians.name', 'time_weekly_summary.week_start']);

    // Weekly overtime trend
    const overtimeTrend = await db('time_weekly_summary')
      .where('week_start', '>=', new Date(Date.now() - 12 * 7 * 24 * 3600 * 1000).toISOString().split('T')[0])
      .leftJoin('technicians', 'time_weekly_summary.technician_id', 'technicians.id')
      .select(
        'technicians.name as tech_name',
        'time_weekly_summary.week_start',
        'time_weekly_summary.overtime_minutes',
        'time_weekly_summary.utilization_pct',
      )
      .orderBy('time_weekly_summary.week_start');

    res.json({
      serviceTypeStats,
      utilizationByTech,
      rpmhByTech,
      overtimeTrend,
      dateRange: { start, end },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /analytics/comparison — service type time comparison by tech
// ---------------------------------------------------------------------------
router.get('/analytics/comparison', async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0];
    const end = endDate || etDateString();

    const comparison = await db('time_entries')
      .where('time_entries.entry_type', 'job')
      .where('time_entries.status', '!=', 'voided')
      .whereNotNull('time_entries.duration_minutes')
      .where('time_entries.clock_in', '>=', start)
      .where('time_entries.clock_in', '<=', end + ' 23:59:59')
      .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
      .leftJoin('scheduled_services', 'time_entries.job_id', 'scheduled_services.id')
      .select(
        'technicians.name as tech_name',
        'time_entries.technician_id',
        db.raw("COALESCE(time_entries.service_type, scheduled_services.service_type, 'Unknown') as svc_type"),
        db.raw('AVG(time_entries.duration_minutes) as avg_actual'),
        db.raw('COUNT(*) as job_count'),
        db.raw('AVG(scheduled_services.estimated_duration) as avg_estimated'),
      )
      .groupBy('technicians.name', 'time_entries.technician_id',
        db.raw("COALESCE(time_entries.service_type, scheduled_services.service_type, 'Unknown')"))
      .orderBy(['technicians.name', 'svc_type']);

    res.json(comparison);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// TECHNICIAN MANAGEMENT — CRUD
// ═══════════════════════════════════════════════════════════════════

// GET /technicians — list all technicians (including inactive).
// Tech-role tokens get the rows with payroll/PII columns stripped;
// admin tokens get the full rows. Keeping the route accessible to
// techs preserves the pre-existing dispatch/team-roster use cases
// without exposing each coworker's wage, DOB, address, etc.
router.get('/technicians', async (req, res, next) => {
  try {
    const techs = await db('technicians').orderBy('active', 'desc').orderBy('name');
    // Presign photo_s3_key into avatar_url for the response. After
    // PR #344 photo uploads write only photo_s3_key (no row-level URL
    // baked in); consumers (TeamTab list, dispatch board /board)
    // resolve to a fresh presigned URL inside their own auth boundary.
    // This route is admin-authed so presigning is safe.
    const { resolveTechPhotoUrl } = require('../services/tech-photo');
    const callerIsAdmin = isAdminCaller(req);
    const enriched = await Promise.all(techs.map(async (t) => {
      const row = {
        ...t,
        avatar_url: await resolveTechPhotoUrl(t.photo_s3_key, t.avatar_url),
      };
      return callerIsAdmin ? row : sanitizeTechForNonAdmin(row);
    }));
    res.json({ technicians: enriched });
  } catch (err) { next(err); }
});

// Map camelCase payroll-profile fields from the client to snake_case
// columns. Each mapping is conditional — undefined leaves the column
// alone, explicit '' or null clears it. ssn_last4 is normalized to
// the trailing 4 digits in case the form passed a longer string.
function applyPayrollProfileFields(updates, body) {
  const map = {
    payRate: 'pay_rate',
    hireDate: 'hire_date',
    jobTitle: 'job_title',
    employmentType: 'employment_type',
    address: 'address',
    dob: 'dob',
    emergencyContactName: 'emergency_contact_name',
    emergencyContactPhone: 'emergency_contact_phone',
  };
  for (const [k, col] of Object.entries(map)) {
    if (body[k] !== undefined) updates[col] = body[k] === '' ? null : body[k];
  }
  if (body.ssnLast4 !== undefined) {
    const digits = String(body.ssnLast4 || '').replace(/\D/g, '').slice(-4);
    updates.ssn_last4 = digits || null;
  }
}

// POST /technicians — add a new technician. Admin only because the
// payload now carries payroll/PII fields (pay_rate, DOB, address,
// SSN-4, emergency contact). Pre-existing route protection was
// requireTechOrAdmin; tightening to requireAdmin since we widened
// the body shape.
router.post('/technicians', requireAdmin, async (req, res, next) => {
  try {
    const { name, phone, email, autoFlipEnabled } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const insertRow = {
      name: name.trim(),
      phone: phone || null,
      email: email || null,
      active: true,
    };
    // Honor the create-form's auto-flip checkbox. Without this, an
    // operator unchecking "Auto-flip enabled" during creation would
    // see the value silently dropped and the row created at the
    // column DEFAULT (TRUE), needing a second edit to actually opt
    // the tech out. Falsy explicit value → false; undefined → leave
    // it to the column DEFAULT.
    if (autoFlipEnabled !== undefined) insertRow.auto_flip_enabled = !!autoFlipEnabled;
    applyPayrollProfileFields(insertRow, req.body);
    const [tech] = await db('technicians').insert(insertRow).returning('*');
    // Log id + structural state only; the row now carries payroll/PII
    // so names stay out of logs per AGENTS.md.
    logger.info(`[team] Added technician id=${tech.id} (auto_flip_enabled=${tech.auto_flip_enabled})`);
    res.json({ success: true, technician: tech });
  } catch (err) { next(err); }
});

// PUT /technicians/:id — update a technician. Admin only — same
// reasoning as POST: techs must not be able to edit their own (or
// anyone else's) pay rate, DOB, SSN, address, or emergency contact.
router.put('/technicians/:id', requireAdmin, async (req, res, next) => {
  try {
    const { name, phone, email, active, autoFlipEnabled } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (active !== undefined) updates.active = active;
    // Per-tech auto-flip opt-out (Phase 2E). When false, the geofence
    // EXIT auto-flip pipeline skips this tech entirely with
    // action_taken='auto_flip_skipped_tech_disabled'. Default TRUE on
    // the column so existing rows keep current behavior.
    if (autoFlipEnabled !== undefined) updates.auto_flip_enabled = !!autoFlipEnabled;
    applyPayrollProfileFields(updates, req.body);
    updates.updated_at = new Date();
    await db('technicians').where({ id: req.params.id }).update(updates);
    const tech = await db('technicians').where({ id: req.params.id }).first();
    logger.info(`[team] Updated technician id=${tech.id} (active=${tech.active}, auto_flip_enabled=${tech.auto_flip_enabled})`);
    res.json({ success: true, technician: tech });
  } catch (err) { next(err); }
});

// GET /technicians/:id/earnings — hours × pay_rate breakdown for a
// window. OT pays at 1.5×. Falls back to $35/hr if pay_rate is unset
// (matches the legacy hardcoded LABOR_RATE so dashboards stay
// consistent). Admin only — payroll info, even one tech's own, isn't
// a tech-role surface.
//
// Window is selected via either:
//   - period=this-week | last-week  (server anchors on ET, preferred)
//   - from=YYYY-MM-DD & to=YYYY-MM-DD (explicit, for ad-hoc windows)
//
// Clients should prefer ?period= so week boundaries don't drift on
// browsers outside ET or near midnight.
router.get('/technicians/:id/earnings', requireAdmin, async (req, res, next) => {
  try {
    const tech = await db('technicians').where({ id: req.params.id }).first();
    if (!tech) return res.status(404).json({ error: 'Technician not found' });

    let { from, to } = req.query;
    const { period } = req.query;
    if (period === 'this-week' || period === 'last-week') {
      const offsetDays = period === 'last-week' ? -7 : 0;
      const anchor = addETDays(new Date(), offsetDays);
      from = etWeekStart(anchor);
      // Pure calendar +6 on the YYYY-MM-DD Monday string — no
      // timezone ambiguity since we never read hours.
      to = addCalendarDaysToYMD(from, 6);
    }
    if (!from || !to) return res.status(400).json({ error: 'from+to (YYYY-MM-DD) or period=this-week|last-week required' });

    const rows = await db('time_entry_daily_summary')
      .where({ technician_id: tech.id })
      .where('work_date', '>=', from)
      .where('work_date', '<=', to)
      .select('work_date', 'total_shift_minutes', 'overtime_minutes');

    const totalMin = rows.reduce((s, r) => s + parseFloat(r.total_shift_minutes || 0), 0);
    const otMin = rows.reduce((s, r) => s + parseFloat(r.overtime_minutes || 0), 0);
    const regMin = Math.max(0, totalMin - otMin);

    const rate = parseFloat(tech.pay_rate) > 0 ? parseFloat(tech.pay_rate) : 35;
    const regularPay = (regMin / 60) * rate;
    const overtimePay = (otMin / 60) * rate * 1.5;

    res.json({
      technicianId: tech.id,
      technicianName: tech.name,
      from,
      to,
      payRate: rate,
      payRateSource: parseFloat(tech.pay_rate) > 0 ? 'tech' : 'default',
      regularMinutes: regMin,
      overtimeMinutes: otMin,
      totalMinutes: totalMin,
      regularPay: Number(regularPay.toFixed(2)),
      overtimePay: Number(overtimePay.toFixed(2)),
      grossPay: Number((regularPay + overtimePay).toFixed(2)),
      daysWorked: rows.length,
    });
  } catch (err) { next(err); }
});

// POST /technicians/:id/photo — upload tech profile photo.
//
// Multipart upload. Stores the binary in S3 at
// tech-photos/<technician_id>/<timestamp>-<safename> and sets
// technicians.photo_s3_key (canonical S3 reference).
//
// Read pattern: consumers (track-public.js, documents.js,
// review-request.js) presign technicians.photo_s3_key on demand
// at the trusted-context boundary they already authenticate. There
// is NO public unauthenticated proxy — adding one would put a new
// route outside AGENTS.md's allowed-list of public-by-token routes
// (P0; Codex caught this on PR #344). UUIDs are not secrets —
// booking responses already expose technician_id to unauth callers.
//
// photo_url is left untouched. It coexists as a fallback for
// techs whose photo lives at an external URL (e.g., Google Business
// profile). Read sites use photo_s3_key first, fall back to
// photo_url.
//
// Re-uploading a photo for the same tech overwrites photo_s3_key
// (old S3 object stays orphaned — cleanup is a separate concern).
//
// Lazy multer init: defining the route requires `upload`, which is
// declared further down the file (with the company-documents block).
// Reuse it inline below — same multer instance, same 25 MB cap.
const PHOTO_PREFIX = 'tech-photos/';
router.post(
  '/technicians/:id/photo',
  // Self-or-admin guard: tech-role tokens can update their own photo
  // (matches a likely future tech-side avatar flow), but they must not
  // mutate another tech's row — the row now carries payroll/PII so
  // arbitrary cross-tech writes need to be blocked even when the only
  // mutating column here is photo_s3_key. Admin tokens can update
  // anyone's photo as before.
  (req, res, next) => {
    if (isAdminCaller(req)) return next();
    if (req.params.id && req.technicianId && req.params.id === req.technicianId) return next();
    return res.status(403).json({ error: 'Can only update your own photo' });
  },
  (req, res, next) => upload.single('photo')(req, res, next),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file provided' });
      if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });

      const tech = await db('technicians').where({ id: req.params.id }).first('id', 'name');
      if (!tech) return res.status(404).json({ error: 'Technician not found' });

      const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `${PHOTO_PREFIX}${tech.id}/${Date.now()}-${safeName}`;
      await s3.send(new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));

      await db('technicians').where({ id: tech.id }).update({
        photo_s3_key: key,
        updated_at: new Date(),
      });

      logger.info(`[team] Uploaded photo for ${tech.name}: ${key}`);

      // Return the row with avatar_url presigned from the new
      // photo_s3_key — same shape as GET /technicians, so the
      // client can render the new photo immediately without a
      // follow-up GET. Sanitize for non-admin callers since the
      // technicians row now carries payroll/PII columns; this route
      // is requireTechOrAdmin pre-this-PR and we keep that gate so a
      // tech-side avatar update path (if/when we add one) doesn't
      // 403, but tech-role responses get the same private columns
      // stripped as GET /technicians does.
      const updated = await db('technicians').where({ id: tech.id }).first();
      const { resolveTechPhotoUrl } = require('../services/tech-photo');
      updated.avatar_url = await resolveTechPhotoUrl(updated.photo_s3_key, updated.avatar_url);

      const responseRow = isAdminCaller(req) ? updated : sanitizeTechForNonAdmin(updated);
      res.json({ success: true, technician: responseRow });
    } catch (err) {
      logger.error(`[team] Tech photo upload failed: ${err.message}`);
      next(err);
    }
  }
);

// DELETE /technicians/:id — hard delete the technician row.
// If related records exist (time entries, assignments) the DB FK
// will error; the client surfaces that message. Admin only — the
// row now carries payroll/PII and the ?force=true branch can purge
// related records, so tech-role tokens have no business calling
// this.
router.delete('/technicians/:id', requireAdmin, async (req, res, next) => {
  const force = String(req.query.force || '') === 'true';
  try {
    if (!force) {
      const deleted = await db('technicians').where({ id: req.params.id }).del();
      if (!deleted) return res.status(404).json({ error: 'Technician not found' });
      logger.info(`[team] Deleted technician: ${req.params.id}`);
      return res.json({ success: true });
    }

    // Force delete — cascade-clean every FK reference using information_schema.
    const techId = req.params.id;
    const tech = await db('technicians').where({ id: techId }).first();
    if (!tech) return res.status(404).json({ error: 'Technician not found' });

    const fks = await db.raw(`
      SELECT tc.table_name, kcu.column_name, c.is_nullable
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
       AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema = tc.table_schema
      JOIN information_schema.columns c
        ON c.table_name = tc.table_name
       AND c.column_name = kcu.column_name
       AND c.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND ccu.table_name = 'technicians'
        AND ccu.column_name = 'id'
    `);

    const purged = [];
    await db.transaction(async (trx) => {
      for (const row of fks.rows) {
        const { table_name, column_name, is_nullable } = row;
        if (is_nullable === 'YES') {
          const n = await trx(table_name).where({ [column_name]: techId }).update({ [column_name]: null });
          purged.push({ table: table_name, column: column_name, action: 'nulled', rows: n });
        } else {
          const n = await trx(table_name).where({ [column_name]: techId }).del();
          purged.push({ table: table_name, column: column_name, action: 'deleted', rows: n });
        }
      }
      await trx('technicians').where({ id: techId }).del();
    });

    logger.warn(`[team] FORCE deleted technician ${tech.email || techId}: ${JSON.stringify(purged)}`);
    res.json({ success: true, forced: true, cleaned: purged });
  } catch (err) {
    if (err.code === '23503' && !force) {
      return res.status(409).json({ error: 'Technician has linked records (time entries or jobs). Deactivate instead, or retry with ?force=true to purge related data.' });
    }
    next(err);
  }
});

// =============================================================================
// COMPANY DOCUMENTS — admin-only internal docs (SOPs, onboarding, offer letters)
// =============================================================================
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB max

const s3 = new S3Client({
  region: config.s3.region,
  credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
});
const DOC_PREFIX = 'company-documents/';

async function ensureDocTable() {
  if (!(await db.schema.hasTable('company_documents'))) {
    await db.schema.createTable('company_documents', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('title', 200).notNullable();
      t.string('category', 50).notNullable().defaultTo('general');
      t.text('description');
      t.string('file_name', 255).notNullable();
      t.string('file_type', 50);
      t.integer('file_size');
      t.string('s3_key', 500).notNullable();
      t.uuid('uploaded_by');
      t.boolean('is_archived').defaultTo(false);
      t.timestamps(true, true);
    });
  }
}

// GET /documents — list all (admin only). Optional filters:
//   category=<one of DOC_CATEGORIES> | 'all'
//   technicianId=<uuid> — docs bound to that tech
//   technicianId='company' — only company-wide docs (technician_id IS NULL)
// requireAdmin: documents now hold per-tech HR records (W-4, I-9,
// license, cert expirations). Tech-role tokens must not be able to
// list/read/upload/edit those, even their own — pre-existing tech
// access to company-wide SOPs is acceptable collateral here.
router.get('/documents', requireAdmin, async (req, res, next) => {
  try {
    await ensureDocTable();
    const { category, technicianId } = req.query;
    let query = db('company_documents')
      .leftJoin('technicians', 'company_documents.technician_id', 'technicians.id')
      .where('company_documents.is_archived', false)
      .select('company_documents.*', 'technicians.name as technician_name')
      .orderBy('company_documents.created_at', 'desc');
    if (category && category !== 'all') query = query.where('company_documents.category', category);
    if (technicianId === 'company') {
      query = query.whereNull('company_documents.technician_id');
    } else if (technicianId) {
      query = query.where('company_documents.technician_id', technicianId);
    }
    const docs = await query;
    res.json({ documents: docs });
  } catch (err) { next(err); }
});

// POST /documents/upload — upload a file. Optional binding:
//   technicianId — bind to one tech (omit / empty for company-wide)
//   expirationDate — YYYY-MM-DD for licenses, certs, I-9s with reverify dates
router.post('/documents/upload', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    await ensureDocTable();
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const { title, category, description, technicianId, expirationDate } = req.body;
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const key = `${DOC_PREFIX}${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const [doc] = await db('company_documents').insert({
      title: title || req.file.originalname,
      category: category || 'general',
      description: description || null,
      file_name: req.file.originalname,
      file_type: ext,
      file_size: req.file.size,
      s3_key: key,
      uploaded_by: req.technicianId || null,
      technician_id: technicianId || null,
      expiration_date: expirationDate || null,
    }).returning('*');

    // Log structural metadata only — titles and filenames for HR
    // documents (W-4, I-9, licenses) commonly embed employee names
    // and other PII per AGENTS.md guidance, so keep them out of logs.
    logger.info(`[docs] Uploaded id=${doc.id} category=${doc.category} ext=${ext} size=${req.file.size}B${doc.technician_id ? ` tech=${doc.technician_id}` : ''}`);
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

// GET /documents/:id/download — get presigned download URL
router.get('/documents/:id/download', requireAdmin, async (req, res, next) => {
  try {
    const doc = await db('company_documents').where({ id: req.params.id }).first();
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: doc.s3_key,
    }), { expiresIn: 3600 });

    res.json({ url, fileName: doc.file_name });
  } catch (err) { next(err); }
});

// PUT /documents/:id — update metadata. Pass technicianId='' to
// unbind from a tech back to company-wide; expirationDate='' to
// clear an expiration.
router.put('/documents/:id', requireAdmin, async (req, res, next) => {
  try {
    const { title, category, description, technicianId, expirationDate } = req.body;
    const updates = { updated_at: new Date() };
    if (title !== undefined) updates.title = title;
    if (category !== undefined) updates.category = category;
    if (description !== undefined) updates.description = description;
    if (technicianId !== undefined) updates.technician_id = technicianId === '' ? null : technicianId;
    if (expirationDate !== undefined) updates.expiration_date = expirationDate === '' ? null : expirationDate;
    await db('company_documents').where({ id: req.params.id }).update(updates);
    const doc = await db('company_documents').where({ id: req.params.id }).first();
    res.json(doc);
  } catch (err) { next(err); }
});

// DELETE /documents/:id — archive (soft delete)
router.delete('/documents/:id', requireAdmin, async (req, res, next) => {
  try {
    await db('company_documents').where({ id: req.params.id }).update({ is_archived: true, updated_at: new Date() });
    logger.info(`[docs] Archived document: ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
