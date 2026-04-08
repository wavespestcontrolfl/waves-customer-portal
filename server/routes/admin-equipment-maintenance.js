/**
 * Admin Equipment Maintenance & Fleet Tracking Routes
 *
 * Full CRUD for equipment, maintenance schedules, records,
 * vehicle mileage, downtime tracking, and fleet analytics.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const equipmentService = require('../services/equipment-maintenance');

router.use(adminAuthenticate, requireTechOrAdmin);

// ═══════════════════════════════════════════════════════════════════
// EQUIPMENT CRUD
// ═══════════════════════════════════════════════════════════════════

// GET / — list equipment with filters
router.get('/', async (req, res, next) => {
  try {
    const { category, status, assigned_to, search } = req.query;

    let query = db('equipment')
      .leftJoin('technicians', 'equipment.assigned_to', 'technicians.id')
      .select(
        'equipment.*',
        db.raw("COALESCE(technicians.name, 'Unassigned') as assigned_tech_name")
      )
      .whereNot('equipment.status', 'retired')
      .orderBy('equipment.name');

    if (category) query = query.where('equipment.category', category);
    if (status) query = query.where('equipment.status', status);
    if (assigned_to) query = query.where('equipment.assigned_to', assigned_to);
    if (search) {
      query = query.where(function () {
        this.whereILike('equipment.name', `%${search}%`)
          .orWhereILike('equipment.asset_tag', `%${search}%`)
          .orWhereILike('equipment.make', `%${search}%`)
          .orWhereILike('equipment.model', `%${search}%`);
      });
    }

    const equipment = await query;

    // Enrich with next maintenance info
    const enriched = await Promise.all(equipment.map(async (eq) => {
      const nextSchedule = await db('maintenance_schedules')
        .where('equipment_id', eq.id)
        .where('is_active', true)
        .orderByRaw('CASE WHEN is_overdue THEN 0 ELSE 1 END, next_due_at ASC NULLS LAST')
        .first();

      const overdueCount = await db('maintenance_schedules')
        .where('equipment_id', eq.id)
        .where('is_overdue', true)
        .where('is_active', true)
        .count('id as count')
        .first();

      const monthlyAgg = await db('maintenance_records')
        .where('equipment_id', eq.id)
        .select(db.raw('COALESCE(AVG(total_cost), 0) as avg_cost'))
        .first();

      return {
        ...eq,
        next_maintenance: nextSchedule ? {
          task_name: nextSchedule.task_name,
          next_due_at: nextSchedule.next_due_at,
          is_overdue: nextSchedule.is_overdue,
          priority: nextSchedule.priority,
        } : null,
        overdue_count: parseInt(overdueCount.count),
        avg_maintenance_cost: parseFloat(monthlyAgg.avg_cost),
      };
    }));

    res.json({ equipment: enriched });
  } catch (err) {
    next(err);
  }
});

// GET /:id — equipment detail with schedules, records, cost of ownership
router.get('/:id', async (req, res, next) => {
  try {
    const equipment = await db('equipment')
      .leftJoin('technicians', 'equipment.assigned_to', 'technicians.id')
      .select('equipment.*', db.raw("COALESCE(technicians.name, 'Unassigned') as assigned_tech_name"))
      .where('equipment.id', req.params.id)
      .first();

    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const schedules = await db('maintenance_schedules')
      .where('equipment_id', req.params.id)
      .where('is_active', true)
      .orderByRaw('CASE WHEN is_overdue THEN 0 ELSE 1 END, next_due_at ASC NULLS LAST');

    const recentRecords = await db('maintenance_records')
      .where('equipment_id', req.params.id)
      .orderBy('performed_at', 'desc')
      .limit(20);

    let costData = null;
    try {
      costData = await equipmentService.costOfOwnership(req.params.id);
    } catch (e) { /* non-fatal */ }

    res.json({ equipment, schedules, recentRecords, costOfOwnership: costData });
  } catch (err) {
    next(err);
  }
});

// POST / — create equipment
router.post('/', async (req, res, next) => {
  try {
    const data = { ...req.body };
    if (!data.name) return res.status(400).json({ error: 'Equipment name is required' });

    delete data.id;
    data.created_at = db.fn.now();
    data.updated_at = db.fn.now();
    if (data.specs) data.specs = JSON.stringify(data.specs);

    const [record] = await db('equipment').insert(data).returning('*');
    logger.info(`Equipment created: ${record.name} (${record.id})`);
    res.status(201).json({ equipment: record });
  } catch (err) {
    next(err);
  }
});

// PUT /:id — update equipment
router.put('/:id', async (req, res, next) => {
  try {
    const data = { ...req.body, updated_at: db.fn.now() };
    delete data.id;
    delete data.created_at;
    if (data.specs) data.specs = JSON.stringify(data.specs);

    const [record] = await db('equipment')
      .where({ id: req.params.id })
      .update(data)
      .returning('*');

    if (!record) return res.status(404).json({ error: 'Equipment not found' });
    logger.info(`Equipment updated: ${record.name} (${record.id})`);
    res.json({ equipment: record });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — soft delete (retire)
router.delete('/:id', async (req, res, next) => {
  try {
    const [record] = await db('equipment')
      .where({ id: req.params.id })
      .update({ status: 'retired', updated_at: db.fn.now() })
      .returning('*');

    if (!record) return res.status(404).json({ error: 'Equipment not found' });
    logger.info(`Equipment retired: ${record.name} (${record.id})`);
    res.json({ equipment: record, message: 'Equipment retired' });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// MAINTENANCE SCHEDULES
// ═══════════════════════════════════════════════════════════════════

// GET /:id/schedules — maintenance schedules for equipment
router.get('/:id/schedules', async (req, res, next) => {
  try {
    const schedules = await db('maintenance_schedules')
      .where('equipment_id', req.params.id)
      .where('is_active', true)
      .orderByRaw('CASE WHEN is_overdue THEN 0 ELSE 1 END, next_due_at ASC NULLS LAST');

    res.json({ schedules });
  } catch (err) {
    next(err);
  }
});

// POST /:id/schedules — create maintenance schedule
router.post('/:id/schedules', async (req, res, next) => {
  try {
    const data = { ...req.body };
    if (!data.task_name) return res.status(400).json({ error: 'Task name is required' });

    data.equipment_id = req.params.id;
    delete data.id;
    data.created_at = db.fn.now();
    data.updated_at = db.fn.now();

    const [record] = await db('maintenance_schedules').insert(data).returning('*');
    logger.info(`Maintenance schedule created: ${record.task_name} for ${req.params.id}`);
    res.status(201).json({ schedule: record });
  } catch (err) {
    next(err);
  }
});

// PUT /schedules/:scheduleId — update schedule
router.put('/schedules/:scheduleId', async (req, res, next) => {
  try {
    const data = { ...req.body, updated_at: db.fn.now() };
    delete data.id;
    delete data.created_at;

    const [record] = await db('maintenance_schedules')
      .where({ id: req.params.scheduleId })
      .update(data)
      .returning('*');

    if (!record) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ schedule: record });
  } catch (err) {
    next(err);
  }
});

// GET /schedules/due — all due/overdue schedules
router.get('/schedules/due', async (req, res, next) => {
  try {
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const schedules = await db('maintenance_schedules')
      .join('equipment', 'maintenance_schedules.equipment_id', 'equipment.id')
      .where('maintenance_schedules.is_active', true)
      .where(function () {
        this.where('maintenance_schedules.is_overdue', true)
          .orWhere('maintenance_schedules.next_due_at', '<=', thirtyDaysFromNow.toISOString().split('T')[0]);
      })
      .select(
        'maintenance_schedules.*',
        'equipment.name as equipment_name',
        'equipment.asset_tag',
        'equipment.category'
      )
      .orderByRaw('CASE WHEN is_overdue THEN 0 ELSE 1 END, next_due_at ASC NULLS LAST');

    res.json({ schedules });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// MAINTENANCE RECORDS
// ═══════════════════════════════════════════════════════════════════

// GET /:id/records — maintenance history for equipment
router.get('/:id/records', async (req, res, next) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const records = await db('maintenance_records')
      .where('equipment_id', req.params.id)
      .orderBy('performed_at', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    const total = await db('maintenance_records')
      .where('equipment_id', req.params.id)
      .count('id as count')
      .first();

    res.json({ records, total: parseInt(total.count) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/records — log maintenance
router.post('/:id/records', async (req, res, next) => {
  try {
    const record = await equipmentService.recordMaintenance({
      equipmentId: req.params.id,
      ...req.body,
    });
    res.status(201).json({ record });
  } catch (err) {
    next(err);
  }
});

// GET /records/recent — recent across all equipment
router.get('/records/recent', async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const records = await db('maintenance_records')
      .join('equipment', 'maintenance_records.equipment_id', 'equipment.id')
      .select(
        'maintenance_records.*',
        'equipment.name as equipment_name',
        'equipment.asset_tag',
        'equipment.category'
      )
      .orderBy('maintenance_records.performed_at', 'desc')
      .limit(parseInt(limit));

    res.json({ records });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// VEHICLE MILEAGE
// ═══════════════════════════════════════════════════════════════════

// GET /:id/mileage — vehicle mileage log
router.get('/:id/mileage', async (req, res, next) => {
  try {
    const { start_date, end_date, limit = 90 } = req.query;

    let query = db('vehicle_mileage_log')
      .where('vehicle_id', req.params.id)
      .orderBy('log_date', 'desc')
      .limit(parseInt(limit));

    if (start_date) query = query.where('log_date', '>=', start_date);
    if (end_date) query = query.where('log_date', '<=', end_date);

    const logs = await query;

    const summary = await db('vehicle_mileage_log')
      .where('vehicle_id', req.params.id)
      .select(
        db.raw('COALESCE(SUM(total_miles), 0) as total_miles'),
        db.raw('COALESCE(SUM(business_miles), 0) as business_miles'),
        db.raw('COALESCE(SUM(personal_miles), 0) as personal_miles'),
        db.raw('COALESCE(SUM(fuel_cost), 0) as total_fuel_cost'),
        db.raw('COALESCE(SUM(fuel_gallons), 0) as total_fuel_gallons'),
        db.raw('COALESCE(SUM(irs_deduction_amount), 0) as total_irs_deduction'),
        db.raw('COALESCE(SUM(jobs_serviced), 0) as total_jobs_serviced'),
        db.raw('COUNT(*) as log_count')
      )
      .first();

    const avgMpg = parseFloat(summary.total_fuel_gallons) > 0
      ? Math.round((parseFloat(summary.total_miles) / parseFloat(summary.total_fuel_gallons)) * 10) / 10
      : null;

    res.json({
      logs,
      summary: {
        ...summary,
        total_miles: parseFloat(summary.total_miles),
        business_miles: parseFloat(summary.business_miles),
        personal_miles: parseFloat(summary.personal_miles),
        total_fuel_cost: parseFloat(summary.total_fuel_cost),
        total_fuel_gallons: parseFloat(summary.total_fuel_gallons),
        total_irs_deduction: parseFloat(summary.total_irs_deduction),
        avg_mpg: avgMpg,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /:id/mileage — log mileage
router.post('/:id/mileage', async (req, res, next) => {
  try {
    const result = await equipmentService.logMileage({
      vehicleId: req.params.id,
      ...req.body,
    });
    res.status(201).json({ mileage: result });
  } catch (err) {
    next(err);
  }
});

// GET /mileage/summary — fleet mileage summary with IRS deductions
router.get('/mileage/summary', async (req, res, next) => {
  try {
    const { year } = req.query;
    const targetYear = year || new Date().getFullYear();
    const yearStart = `${targetYear}-01-01`;
    const yearEnd = `${targetYear}-12-31`;

    const vehicles = await db('vehicle_mileage_log')
      .join('equipment', 'vehicle_mileage_log.vehicle_id', 'equipment.id')
      .where('vehicle_mileage_log.log_date', '>=', yearStart)
      .where('vehicle_mileage_log.log_date', '<=', yearEnd)
      .groupBy('equipment.id', 'equipment.name', 'equipment.asset_tag')
      .select(
        'equipment.id',
        'equipment.name',
        'equipment.asset_tag',
        db.raw('COALESCE(SUM(total_miles), 0) as total_miles'),
        db.raw('COALESCE(SUM(business_miles), 0) as business_miles'),
        db.raw('COALESCE(SUM(personal_miles), 0) as personal_miles'),
        db.raw('COALESCE(SUM(fuel_cost), 0) as total_fuel_cost'),
        db.raw('COALESCE(SUM(fuel_gallons), 0) as total_fuel_gallons'),
        db.raw('COALESCE(SUM(irs_deduction_amount), 0) as total_irs_deduction'),
        db.raw('COALESCE(SUM(jobs_serviced), 0) as total_jobs')
      );

    const fleetTotals = vehicles.reduce((acc, v) => ({
      total_miles: acc.total_miles + parseFloat(v.total_miles),
      business_miles: acc.business_miles + parseFloat(v.business_miles),
      personal_miles: acc.personal_miles + parseFloat(v.personal_miles),
      total_fuel_cost: acc.total_fuel_cost + parseFloat(v.total_fuel_cost),
      total_fuel_gallons: acc.total_fuel_gallons + parseFloat(v.total_fuel_gallons),
      total_irs_deduction: acc.total_irs_deduction + parseFloat(v.total_irs_deduction),
      total_jobs: acc.total_jobs + parseInt(v.total_jobs),
    }), { total_miles: 0, business_miles: 0, personal_miles: 0, total_fuel_cost: 0, total_fuel_gallons: 0, total_irs_deduction: 0, total_jobs: 0 });

    res.json({ year: targetYear, vehicles, fleet_totals: fleetTotals });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// DOWNTIME
// ═══════════════════════════════════════════════════════════════════

// POST /:id/downtime — log downtime
router.post('/:id/downtime', async (req, res, next) => {
  try {
    const data = {
      id: require('uuid').v4(),
      equipment_id: req.params.id,
      reason: req.body.reason,
      started_at: req.body.started_at || db.fn.now(),
      ended_at: req.body.ended_at || null,
      duration_hours: req.body.duration_hours || null,
      jobs_affected: req.body.jobs_affected || 0,
      revenue_impact: req.body.revenue_impact || 0,
      backup_equipment_used: req.body.backup_equipment_used || null,
      operational_notes: req.body.operational_notes || null,
      maintenance_record_id: req.body.maintenance_record_id || null,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    };

    const [record] = await db('equipment_downtime_log').insert(data).returning('*');

    // Generate downtime alert
    const equipment = await db('equipment').where('id', req.params.id).first();
    if (equipment) {
      await db('maintenance_alerts').insert({
        id: require('uuid').v4(),
        equipment_id: req.params.id,
        alert_type: 'downtime_started',
        severity: 'high',
        title: `Downtime Started: ${equipment.name} ${equipment.asset_tag || ''} — ${req.body.reason}`.trim(),
        description: req.body.operational_notes || `Equipment is down: ${req.body.reason}`,
        status: 'new',
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      });
    }

    res.status(201).json({ downtime: record });
  } catch (err) {
    next(err);
  }
});

// PUT /downtime/:id/resolve — resolve downtime
router.put('/downtime/:id/resolve', async (req, res, next) => {
  try {
    const downtime = await db('equipment_downtime_log').where('id', req.params.id).first();
    if (!downtime) return res.status(404).json({ error: 'Downtime record not found' });

    const endedAt = new Date();
    const startedAt = new Date(downtime.started_at);
    const durationHours = Math.round(((endedAt - startedAt) / (1000 * 60 * 60)) * 10) / 10;

    const [record] = await db('equipment_downtime_log')
      .where('id', req.params.id)
      .update({
        ended_at: endedAt,
        duration_hours: req.body.duration_hours || durationHours,
        jobs_affected: req.body.jobs_affected || downtime.jobs_affected,
        revenue_impact: req.body.revenue_impact || downtime.revenue_impact,
        operational_notes: req.body.operational_notes || downtime.operational_notes,
        updated_at: db.fn.now(),
      })
      .returning('*');

    // Resolve downtime alert
    await db('maintenance_alerts')
      .where('equipment_id', downtime.equipment_id)
      .where('alert_type', 'downtime_started')
      .where('status', 'new')
      .update({ status: 'resolved', resolved_at: db.fn.now(), updated_at: db.fn.now() });

    res.json({ downtime: record });
  } catch (err) {
    next(err);
  }
});

// GET /downtime/active — currently down equipment
router.get('/downtime/active', async (req, res, next) => {
  try {
    const active = await db('equipment_downtime_log')
      .join('equipment', 'equipment_downtime_log.equipment_id', 'equipment.id')
      .whereNull('equipment_downtime_log.ended_at')
      .select(
        'equipment_downtime_log.*',
        'equipment.name as equipment_name',
        'equipment.asset_tag',
        'equipment.category'
      )
      .orderBy('equipment_downtime_log.started_at', 'desc');

    res.json({ downtime: active });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════════

// GET /analytics/overview — fleet health stats
router.get('/analytics/overview', async (req, res, next) => {
  try {
    const overview = await equipmentService.getFleetOverview();
    res.json(overview);
  } catch (err) {
    next(err);
  }
});

// GET /analytics/costs — cost of ownership all equipment
router.get('/analytics/costs', async (req, res, next) => {
  try {
    const equipment = await db('equipment').whereNot('status', 'retired').orderBy('name');
    const costs = await Promise.all(
      equipment.map(eq => equipmentService.costOfOwnership(eq.id).catch(() => null))
    );
    res.json({ costs: costs.filter(Boolean) });
  } catch (err) {
    next(err);
  }
});

// GET /analytics/reliability — downtime ranking
router.get('/analytics/reliability', async (req, res, next) => {
  try {
    const reliability = await db('equipment_downtime_log')
      .join('equipment', 'equipment_downtime_log.equipment_id', 'equipment.id')
      .groupBy('equipment.id', 'equipment.name', 'equipment.asset_tag', 'equipment.category')
      .select(
        'equipment.id',
        'equipment.name',
        'equipment.asset_tag',
        'equipment.category',
        db.raw('COUNT(*) as incident_count'),
        db.raw('COALESCE(SUM(equipment_downtime_log.duration_hours), 0) as total_downtime_hours'),
        db.raw('COALESCE(SUM(equipment_downtime_log.jobs_affected), 0) as total_jobs_affected'),
        db.raw('COALESCE(SUM(equipment_downtime_log.revenue_impact), 0) as total_revenue_impact')
      )
      .orderBy('total_downtime_hours', 'desc');

    res.json({ reliability });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════════════════════════════════

// GET /alerts — maintenance alerts
router.get('/alerts', async (req, res, next) => {
  try {
    const { status = 'new' } = req.query;

    let query = db('maintenance_alerts')
      .join('equipment', 'maintenance_alerts.equipment_id', 'equipment.id')
      .select(
        'maintenance_alerts.*',
        'equipment.name as equipment_name',
        'equipment.asset_tag',
        'equipment.category'
      )
      .orderByRaw("CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END")
      .orderBy('maintenance_alerts.created_at', 'desc');

    if (status !== 'all') {
      query = query.where('maintenance_alerts.status', status);
    }

    const alerts = await query;
    res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

// PUT /alerts/:id — update alert status
router.put('/alerts/:id', async (req, res, next) => {
  try {
    const { status, resolved_by } = req.body;
    const updates = { status, updated_at: db.fn.now() };
    if (status === 'resolved') {
      updates.resolved_at = db.fn.now();
      updates.resolved_by = resolved_by || 'admin';
    }

    const [record] = await db('maintenance_alerts')
      .where('id', req.params.id)
      .update(updates)
      .returning('*');

    if (!record) return res.status(404).json({ error: 'Alert not found' });
    res.json({ alert: record });
  } catch (err) {
    next(err);
  }
});

// POST /issue — tech reports equipment issue
router.post('/issue', async (req, res, next) => {
  try {
    const { equipmentId, technicianId, description, severity } = req.body;
    if (!equipmentId || !description) {
      return res.status(400).json({ error: 'Equipment ID and description are required' });
    }

    const alert = await equipmentService.reportEquipmentIssue({
      equipmentId,
      technicianId,
      description,
      severity: severity || 'medium',
    });

    res.status(201).json({ alert });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
