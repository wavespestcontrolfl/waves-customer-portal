/**
 * Admin Equipment Maintenance & Fleet Tracking Routes
 *
 * Full CRUD for equipment, maintenance schedules, records,
 * vehicle mileage, downtime tracking, and fleet analytics.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const truckKit = require('../services/truck-kit');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const equipmentService = require('../services/equipment-maintenance');

router.use(adminAuthenticate, requireTechOrAdmin);
// These reports feed the owner-only Costs workspace. The shared fleet
// overview, equipment details, and operational record writers remain staff tools.
router.use(['/analytics/costs', '/analytics/reliability', '/mileage/summary'], requireAdmin);

// Last-resort table bootstrap for local/dev environments where migrations have
// not run yet. Keep this schema aligned with 20260401000097_equipment_maintenance.
let _maintTablesChecked = false;
router.use(async (req, res, next) => {
  if (!_maintTablesChecked) {
    _maintTablesChecked = true;
    try {
      const tables = [
        `CREATE TABLE IF NOT EXISTS maintenance_schedules (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          equipment_id uuid NOT NULL, task_name varchar(200) NOT NULL, description text,
          interval_miles integer, interval_hours integer, interval_days integer, interval_months integer,
          last_performed_at timestamptz, last_performed_miles integer, last_performed_hours decimal(10,1),
          last_performed_by varchar(200), next_due_at date, next_due_miles integer, next_due_hours decimal(10,1),
          is_overdue boolean DEFAULT false, priority varchar(20) DEFAULT 'normal',
          notify_days_before integer DEFAULT 7, notify_technician boolean DEFAULT true, notify_admin boolean DEFAULT true,
          estimated_cost decimal(10,2), estimated_downtime_hours decimal(6,1),
          is_active boolean DEFAULT true, created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS maintenance_records (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          equipment_id uuid NOT NULL, schedule_id uuid, maintenance_type varchar(20) DEFAULT 'scheduled',
          task_name varchar(200) NOT NULL, description text, performed_at timestamptz DEFAULT NOW(),
          performed_by varchar(200), vendor_name varchar(200),
          miles_at_service integer, hours_at_service decimal(10,1),
          condition_before integer, condition_after integer,
          parts_cost decimal(10,2) DEFAULT 0, labor_cost decimal(10,2) DEFAULT 0,
          vendor_cost decimal(10,2) DEFAULT 0, total_cost decimal(10,2) DEFAULT 0,
          receipt_url varchar(500), downtime_hours decimal(8,1) DEFAULT 0,
          equipment_was_down boolean DEFAULT false, parts_used jsonb,
          follow_up_needed boolean DEFAULT false, follow_up_notes text, follow_up_date date,
          warranty_claim boolean DEFAULT false, warranty_claim_status varchar(30),
          created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS equipment_downtime_log (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          equipment_id uuid NOT NULL, maintenance_record_id uuid,
          reason varchar(200), started_at timestamptz NOT NULL, ended_at timestamptz,
          duration_hours decimal(8,1), jobs_affected integer DEFAULT 0,
          revenue_impact decimal(10,2) DEFAULT 0, backup_equipment_used varchar(200),
          operational_notes text, created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS vehicle_mileage_log (
          id serial PRIMARY KEY,
          vehicle_id uuid NOT NULL,
          log_date date NOT NULL,
          odometer_start integer, odometer_end integer,
          total_miles decimal(8,1), source varchar(30) DEFAULT 'manual',
          gps_data jsonb, business_miles decimal(8,1),
          personal_miles decimal(8,1) DEFAULT 0, business_pct decimal(5,2),
          fuel_gallons decimal(6,2), fuel_cost decimal(8,2),
          fuel_price_per_gallon decimal(5,3), jobs_serviced integer,
          job_ids jsonb, irs_standard_rate decimal(5,2) DEFAULT 0.70,
          irs_deduction_amount decimal(10,2), logged_by varchar(200),
          notes text, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW(),
          UNIQUE(vehicle_id, log_date)
        )`,
        `CREATE TABLE IF NOT EXISTS maintenance_alerts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          equipment_id uuid NOT NULL, schedule_id uuid,
          alert_type varchar(30) NOT NULL, severity varchar(10) DEFAULT 'info',
          title varchar(300) NOT NULL, description text,
          status varchar(20) DEFAULT 'new',
          resolved_by varchar(200), resolved_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT NOW(), updated_at timestamptz NOT NULL DEFAULT NOW()
        )`,
      ];
      for (const sql of tables) {
        await db.raw(sql).catch(e => console.error('[equipment] Table create error:', e.message));
      }
    } catch (e) { console.error('[equipment] Auto-create error:', e.message); }
  }
  next();
});

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
      .orderBy('equipment.name');

    if (category) query = query.where('equipment.category', category);
    if (status) query = query.where('equipment.status', status);
    else query = query.whereNotIn('equipment.status', ['retired', 'sold', 'lost']);
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
router.get('/:id([0-9a-fA-F-]{36})', async (req, res, next) => {
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

// Asset rows are the office's (the same rule as routes/admin-equipment.js):
// a technician token never creates, edits or retires one. These handlers
// spread the body, so kit_key and the custody columns would be reachable.
// Truck, holder, status, category and kit key change only through the
// guarded Assets route (routes/admin-equipment.js: one live truck per
// technician, no move or retirement while a tool alert is open, truck locks).
// This older writer spreads the body, so it refuses those columns outright.
const GUARDED_COLUMNS = ['assigned_vehicle_id', 'assigned_to', 'status', 'category', 'kit_key'];
const GUARDED_ERROR = `Set ${GUARDED_COLUMNS.join(', ')} on Equipment → Assets (PUT /api/admin/equipment/equipment/:id)`;
const carriesGuarded = (body) => GUARDED_COLUMNS.some((key) => body && body[key] !== undefined);

// POST / — create equipment
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const data = { ...req.body };
    if (!data.name) return res.status(400).json({ error: 'Equipment name is required' });
    if (carriesGuarded(data)) return res.status(400).json({ error: GUARDED_ERROR });

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
router.put('/:id([0-9a-fA-F-]{36})', requireAdmin, async (req, res, next) => {
  try {
    if (carriesGuarded(req.body)) return res.status(400).json({ error: GUARDED_ERROR });
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
router.delete('/:id([0-9a-fA-F-]{36})', requireAdmin, async (req, res, next) => {
  try {
    // Retiring a tool with an open truck check alert goes through the
    // alert's outcome (Retired / Lost), never around it; the probe and the
    // write hold the item's truck lock so a check in flight finishes first.
    const record = await db.transaction(async (trx) => {
      const item = await trx('equipment').where({ id: req.params.id }).first('assigned_vehicle_id', 'category');
      // A tool locks its truck; a truck locks itself (a check in flight on
      // it must finish or fail ownership before the truck retires). The
      // assignment is read again under the lock: a tool that moved trucks
      // meanwhile is not retired on a truck nobody locked.
      const itemTruck = item?.assigned_vehicle_id || null;
      const truckId = item?.category === 'vehicle' ? req.params.id : itemTruck;
      if (truckId) await truckKit.lockTruck(trx, truckId);
      const again = await trx('equipment').where({ id: req.params.id }).first('assigned_vehicle_id', 'category');
      if (item && (!again || (again.assigned_vehicle_id || null) !== itemTruck)) return 'moved';
      // A truck with tools still on it is not retired from here either.
      if (item?.category === 'vehicle' && await trx('equipment').where({ assigned_vehicle_id: req.params.id }).first('id')) return 'riders';
      if (await truckKit.openToolAlertFor(req.params.id, trx)) return 'open-alert';
      const [row] = await trx('equipment')
        .where({ id: req.params.id })
        .update({ status: 'retired', updated_at: db.fn.now() })
        .returning('*');
      return row || null;
    });
    if (record === 'moved') return res.status(409).json({ error: 'Another save moved this item to a different truck. Reload and try again.' });
    if (record === 'riders') return res.status(409).json({ error: 'Items still ride on this truck. Move them to another truck first.' });
    if (record === 'open-alert') return res.status(409).json({ error: 'This item has an open truck check alert. Resolve it with an outcome first.' });

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
router.get('/:id([0-9a-fA-F-]{36})/schedules', async (req, res, next) => {
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
router.post('/:id([0-9a-fA-F-]{36})/schedules', async (req, res, next) => {
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
router.get('/:id([0-9a-fA-F-]{36})/records', async (req, res, next) => {
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
router.post('/:id([0-9a-fA-F-]{36})/records', async (req, res, next) => {
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
router.get('/:id([0-9a-fA-F-]{36})/mileage', async (req, res, next) => {
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
router.post('/:id([0-9a-fA-F-]{36})/mileage', async (req, res, next) => {
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
router.post('/:id([0-9a-fA-F-]{36})/downtime', async (req, res, next) => {
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

// Resolving a truck-check alert (services/truck-kit.js) may carry an outcome:
// lost and retired also set the item's status; found, repaired and replaced
// only close the alert. The truck's office bell closes once no tool alert on
// it is open. Admin only: an item's status is an office call.
const TOOL_OUTCOME_STATUS = { found: null, repaired: null, replaced: null, lost: 'lost', retired: 'retired' };
const OPEN_TOOL_ALERT_STATUSES = ['new', 'acknowledged'];

// Why a status change on an alert is refused, or null. A truck-check alert
// closes from the office (the technician's own path is the next truck check,
// which finds the tool), only by resolving it, only with an outcome from the
// fixed list; a plain maintenance alert keeps its old reach.
function alertTransitionRefusal({ toolAlert, status, outcome, techRole }) {
  if ((toolAlert || outcome !== undefined) && techRole !== 'admin') return { code: 403, error: 'Admin access required' };
  if (outcome !== undefined) {
    if (!toolAlert) return { code: 400, error: 'outcome applies to truck check alerts only' };
    if (!Object.prototype.hasOwnProperty.call(TOOL_OUTCOME_STATUS, outcome)) {
      return { code: 400, error: 'outcome must be found, repaired, replaced, lost or retired' };
    }
    if (status !== 'resolved') return { code: 400, error: 'an outcome resolves the alert' };
  }
  // (The Fleet tab lists status=new only, so an acknowledged tool alert
  // would vanish while still holding the tool and the bell.)
  if (toolAlert && status !== 'resolved') return { code: 400, error: 'a truck check alert closes only by resolving it with an outcome' };
  if (toolAlert && outcome === undefined) {
    return { code: 400, error: 'resolving a truck check alert needs an outcome: found, repaired, replaced, lost or retired' };
  }
  return null;
}

// PUT /alerts/:id — update alert status
router.put('/alerts/:id', async (req, res, next) => {
  try {
    const { status, resolved_by, outcome } = req.body;
    const existing = await db('maintenance_alerts').where('id', req.params.id).first();
    if (!existing) return res.status(404).json({ error: 'Alert not found' });
    const toolAlert = truckKit.TOOL_ALERT_TYPES.includes(existing.alert_type);
    const refusal = alertTransitionRefusal({ toolAlert, status, outcome, techRole: req.techRole });
    if (refusal) return res.status(refusal.code).json({ error: refusal.error });
    const updates = { status, updated_at: db.fn.now() };
    if (status === 'resolved') {
      updates.resolved_at = db.fn.now();
      // The outcome is part of the record: "admin: lost" says what happened
      // to the tool even after the item's status changes again.
      // Attribution is the signed-in admin, never client text.
      const actor = req.technicianId ? `admin ${req.technicianId}` : (resolved_by || 'admin');
      updates.resolved_by = outcome ? `${actor}: ${outcome}` : actor;
    }

    // The alert, the item's status and the bell close commit together, under
    // the truck's lock so a running truck check and this resolve never
    // interleave (the check would re-ring a bell no open alert could clear).
    const record = await db.transaction(async (trx) => {
      let item = null;
      if (toolAlert) {
        // Same lock order as an asset save: the item row first, then its
        // truck, then the assignment re-read under both.
        await truckKit.lockTruck(trx, existing.equipment_id);
        item = await trx('equipment').where('id', existing.equipment_id).first('assigned_vehicle_id');
        if (item?.assigned_vehicle_id) {
          await truckKit.lockTruck(trx, item.assigned_vehicle_id);
          const again = await trx('equipment').where('id', existing.equipment_id).first('assigned_vehicle_id');
          if ((again?.assigned_vehicle_id || null) !== (item.assigned_vehicle_id || null)) return 'moved';
        }
      }
      // A stale office button never re-closes a tool alert a truck check
      // already closed (it would mark a found tool lost): resolve only an
      // open one, and answer 409 when none matches.
      // ... and a closed tool alert never reopens either: every tool-alert
      // transition needs the row still open.
      let query = trx('maintenance_alerts').where('id', req.params.id);
      if (toolAlert) query = query.whereIn('status', OPEN_TOOL_ALERT_STATUSES);
      const [row] = await query.update(updates).returning('*');
      if (!row) return toolAlert ? 'closed' : null;
      if (status === 'resolved' && toolAlert) {
        const nextStatus = outcome ? TOOL_OUTCOME_STATUS[outcome] : null;
        if (nextStatus) await trx('equipment').where('id', row.equipment_id).update({ status: nextStatus, updated_at: db.fn.now() });
        // And an audit row carries the outcome with the alert and the item.
        // critical: a failed audit write propagates and rolls the resolve
        // back, instead of leaving the transaction aborted behind a swallowed
        // error.
        await require('../services/audit-log').recordAuditEvent({
          actor_type: 'admin', actor_id: req.technicianId || null, action: 'tool_alert_resolved', resource_type: 'maintenance_alerts', resource_id: row.id,
          metadata: { outcome, equipment_id: row.equipment_id, alert_type: row.alert_type, item_status: nextStatus }, critical: true, trx,
        });
        if (item?.assigned_vehicle_id) await truckKit.closeTruckBellIfClear(item.assigned_vehicle_id, new Date(), trx);
      }
      return row;
    });

    if (record === 'closed') return res.status(409).json({ error: 'That alert is already closed (the truck check found the tool, or the office resolved it). Reload the list.' });
    if (record === 'moved') return res.status(409).json({ error: 'Another save moved this item to a different truck. Reload the list.' });
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
