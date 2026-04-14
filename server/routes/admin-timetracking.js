const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const timeTracking = require('../services/time-tracking');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

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
    const today = new Date().toISOString().split('T')[0];

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

    // This week's summaries
    const dayOfWeek = new Date().getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() + mondayOffset);
    const weekStartStr = weekStart.toISOString().split('T')[0];

    const weekDailies = await db('time_entry_daily_summary')
      .where('work_date', '>=', weekStartStr)
      .where('work_date', '<=', today)
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select('time_entry_daily_summary.*', 'technicians.name as tech_name');

    // All technicians for status display
    const allTechs = await db('technicians').where({ active: true }).select('id', 'name', 'role');

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
// PUT /daily/:id/approve — approve a daily summary
// ---------------------------------------------------------------------------
router.put('/daily/:id/approve', async (req, res, next) => {
  try {
    const [updated] = await db('time_entry_daily_summary')
      .where({ id: req.params.id })
      .update({
        status: 'approved',
        approved_by: req.technicianId,
        approved_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');
    if (!updated) return res.status(404).json({ error: 'Summary not found' });
    res.json(updated);
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
    const count = await db('time_entry_daily_summary')
      .whereIn('id', ids)
      .where('status', 'pending')
      .update({
        status: 'approved',
        approved_by: req.technicianId,
        approved_at: new Date(),
        updated_at: new Date(),
      });
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
    const end = endDate || new Date().toISOString().split('T')[0];

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
    const end = endDate || new Date().toISOString().split('T')[0];

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

// GET /technicians — list all technicians (including inactive)
router.get('/technicians', async (req, res, next) => {
  try {
    const techs = await db('technicians').orderBy('active', 'desc').orderBy('name');
    res.json({ technicians: techs });
  } catch (err) { next(err); }
});

// POST /technicians — add a new technician
router.post('/technicians', async (req, res, next) => {
  try {
    const { name, phone, email } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const [tech] = await db('technicians').insert({
      name: name.trim(),
      phone: phone || null,
      email: email || null,
      active: true,
    }).returning('*');
    logger.info(`[team] Added technician: ${tech.name}`);
    res.json({ success: true, technician: tech });
  } catch (err) { next(err); }
});

// PUT /technicians/:id — update a technician
router.put('/technicians/:id', async (req, res, next) => {
  try {
    const { name, phone, email, active } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (active !== undefined) updates.active = active;
    updates.updated_at = new Date();
    await db('technicians').where({ id: req.params.id }).update(updates);
    const tech = await db('technicians').where({ id: req.params.id }).first();
    logger.info(`[team] Updated technician: ${tech.name} (active=${tech.active})`);
    res.json({ success: true, technician: tech });
  } catch (err) { next(err); }
});

// DELETE /technicians/:id — deactivate (soft delete)
router.delete('/technicians/:id', async (req, res, next) => {
  try {
    await db('technicians').where({ id: req.params.id }).update({ active: false, updated_at: new Date() });
    logger.info(`[team] Deactivated technician: ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
