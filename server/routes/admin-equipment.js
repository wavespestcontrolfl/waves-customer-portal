/**
 * Admin Equipment, Tank Mix Calculator & Job Costing Routes
 *
 * Equipment CRUD + maintenance logging
 * Tank mix recipes with auto-cost from products_catalog
 * Job costing with margin analysis
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// =========================================================================
// EQUIPMENT CRUD
// =========================================================================

// GET /equipment — list all with maintenance status
router.get('/equipment', async (req, res, next) => {
  try {
    const { category, status, assigned_to } = req.query;

    let query = db('equipment')
      .leftJoin('technicians', 'equipment.assigned_to', 'technicians.id')
      .select(
        'equipment.*',
        db.raw("COALESCE(technicians.name, 'Unassigned') as assigned_tech_name")
      )
      .orderBy('equipment.name');

    if (category) query = query.where('equipment.category', category);
    if (status) query = query.where('equipment.status', status);
    if (assigned_to) query = query.where('equipment.assigned_to', assigned_to);

    const equipment = await query;

    // Check maintenance status for each piece
    const enriched = equipment.map(eq => {
      const hoursUntilService = eq.next_service_hours
        ? parseFloat(eq.next_service_hours) - parseFloat(eq.current_hours || 0)
        : null;
      return {
        ...eq,
        hours_until_service: hoursUntilService,
        maintenance_due: hoursUntilService !== null && hoursUntilService <= 10,
        maintenance_overdue: hoursUntilService !== null && hoursUntilService <= 0,
      };
    });

    res.json({ equipment: enriched });
  } catch (err) {
    next(err);
  }
});

// POST /equipment — add new
router.post('/equipment', async (req, res, next) => {
  try {
    const {
      name, category, make, model, serial_number,
      purchase_date, purchase_price, current_hours,
      next_service_hours, next_service_type, assigned_to,
      status, depreciation_method, depreciation_annual,
      book_value, specs, notes,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Equipment name is required' });

    const [record] = await db('equipment').insert({
      name, category, make, model, serial_number,
      purchase_date: purchase_date || null,
      purchase_price: purchase_price || null,
      current_hours: current_hours || 0,
      next_service_hours: next_service_hours || null,
      next_service_type: next_service_type || null,
      assigned_to: assigned_to || null,
      status: status || 'active',
      depreciation_method: depreciation_method || 'section_179',
      depreciation_annual: depreciation_annual || null,
      book_value: book_value || purchase_price || null,
      specs: specs ? JSON.stringify(specs) : null,
      notes: notes || null,
    }).returning('*');

    logger.info(`Equipment added: ${record.name} (${record.id})`);
    res.status(201).json({ equipment: record });
  } catch (err) {
    next(err);
  }
});

// PUT /equipment/:id — update
router.put('/equipment/:id', async (req, res, next) => {
  try {
    const updates = { ...req.body, updated_at: db.fn.now() };
    if (updates.specs) updates.specs = JSON.stringify(updates.specs);
    delete updates.id;
    delete updates.created_at;

    const [record] = await db('equipment')
      .where({ id: req.params.id })
      .update(updates)
      .returning('*');

    if (!record) return res.status(404).json({ error: 'Equipment not found' });

    logger.info(`Equipment updated: ${record.name} (${record.id})`);
    res.json({ equipment: record });
  } catch (err) {
    next(err);
  }
});

// POST /equipment/:id/maintenance — log maintenance
router.post('/equipment/:id/maintenance', async (req, res, next) => {
  try {
    const equipment = await db('equipment').where({ id: req.params.id }).first();
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const {
      service_type, hours_at_service, cost,
      parts_used, performed_by, notes, service_date,
    } = req.body;

    const [log] = await db('equipment_maintenance_log').insert({
      equipment_id: req.params.id,
      service_type: service_type || 'general',
      hours_at_service: hours_at_service || equipment.current_hours,
      cost: cost || 0,
      parts_used: parts_used || null,
      performed_by: performed_by || req.technician?.name || null,
      notes: notes || null,
      service_date: service_date || etDateString(),
    }).returning('*');

    // Update equipment record
    const equipmentUpdates = {
      last_service_date: log.service_date,
      updated_at: db.fn.now(),
    };
    if (hours_at_service) equipmentUpdates.current_hours = hours_at_service;

    await db('equipment').where({ id: req.params.id }).update(equipmentUpdates);

    logger.info(`Maintenance logged for ${equipment.name}: ${service_type}`);
    res.status(201).json({ maintenance: log });
  } catch (err) {
    next(err);
  }
});

// POST /equipment/:id/calibration — log calibration
router.post('/equipment/:id/calibration', async (req, res, next) => {
  try {
    const equipment = await db('equipment').where({ id: req.params.id }).first();
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const {
      hours_at_service, notes, performed_by, service_date,
      flow_rate_oz_min, nozzle_type, pressure_psi,
    } = req.body;

    const calibrationNotes = [
      notes || '',
      flow_rate_oz_min ? `Flow rate: ${flow_rate_oz_min} oz/min` : '',
      nozzle_type ? `Nozzle: ${nozzle_type}` : '',
      pressure_psi ? `Pressure: ${pressure_psi} PSI` : '',
    ].filter(Boolean).join(' | ');

    const [log] = await db('equipment_maintenance_log').insert({
      equipment_id: req.params.id,
      service_type: 'calibration',
      hours_at_service: hours_at_service || equipment.current_hours,
      cost: 0,
      performed_by: performed_by || req.technician?.name || null,
      notes: calibrationNotes,
      service_date: service_date || etDateString(),
    }).returning('*');

    logger.info(`Calibration logged for ${equipment.name}`);
    res.status(201).json({ calibration: log });
  } catch (err) {
    next(err);
  }
});

// GET /equipment/:id/calibration-history — calibration records
router.get('/equipment/:id/calibration-history', async (req, res, next) => {
  try {
    const records = await db('equipment_maintenance_log')
      .where({ equipment_id: req.params.id, service_type: 'calibration' })
      .orderBy('service_date', 'desc');

    res.json({ calibrations: records });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// TANK MIXES
// =========================================================================

// GET /tank-mixes — list all
router.get('/tank-mixes', async (req, res, next) => {
  try {
    const { service_type, active } = req.query;
    let query = db('tank_mixes').orderBy('name');
    if (service_type) query = query.where('service_type', service_type);
    if (active !== undefined) query = query.where('active', active === 'true');

    const mixes = await query;
    res.json({ tank_mixes: mixes });
  } catch (err) {
    next(err);
  }
});

// Helper: calculate tank mix costs from products_catalog
async function calculateMixCosts(products, tankSizeGal, coverageSqft) {
  if (!products || !products.length) return { cost_per_tank: 0, cost_per_1000sf: 0 };

  let totalCostPerTank = 0;

  const enrichedProducts = [];
  for (const p of products) {
    let unitCost = 0;

    // Look up current price from products_catalog
    if (p.product_id) {
      const catalogProduct = await db('products_catalog')
        .where({ id: p.product_id })
        .first();
      if (catalogProduct && catalogProduct.best_price) {
        // cost_per_oz from best price / total oz in container
        const containerOz = parseFloat(catalogProduct.size_oz) || 128; // default 1 gal
        unitCost = parseFloat(catalogProduct.best_price) / containerOz;
      }
    }

    const ozPerTank = parseFloat(p.oz_per_tank) || 0;
    const productCost = unitCost * ozPerTank;
    totalCostPerTank += productCost;

    enrichedProducts.push({
      ...p,
      cost_per_oz: Math.round(unitCost * 10000) / 10000,
      cost_in_tank: Math.round(productCost * 100) / 100,
    });
  }

  const costPerTank = Math.round(totalCostPerTank * 100) / 100;
  const costPer1000 = coverageSqft > 0
    ? Math.round((totalCostPerTank / (coverageSqft / 1000)) * 10000) / 10000
    : 0;

  return {
    products: enrichedProducts,
    cost_per_tank: costPerTank,
    cost_per_1000sf: costPer1000,
  };
}

// POST /tank-mixes — create
router.post('/tank-mixes', async (req, res, next) => {
  try {
    const {
      name, service_type, tank_size_gal, products,
      water_gal, coverage_sqft, notes,
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Mix name is required' });

    const costs = await calculateMixCosts(
      products || [],
      tank_size_gal || 110,
      coverage_sqft || 0,
    );

    const [mix] = await db('tank_mixes').insert({
      name,
      service_type: service_type || null,
      tank_size_gal: tank_size_gal || 110,
      products: JSON.stringify(costs.products || products || []),
      water_gal: water_gal || null,
      coverage_sqft: coverage_sqft || null,
      cost_per_tank: costs.cost_per_tank,
      cost_per_1000sf: costs.cost_per_1000sf,
      notes: notes || null,
    }).returning('*');

    logger.info(`Tank mix created: ${mix.name}`);
    res.status(201).json({ tank_mix: mix });
  } catch (err) {
    next(err);
  }
});

// PUT /tank-mixes/:id — update
router.put('/tank-mixes/:id', async (req, res, next) => {
  try {
    const existing = await db('tank_mixes').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Tank mix not found' });

    const updates = { ...req.body, updated_at: db.fn.now() };
    delete updates.id;
    delete updates.created_at;

    // Recalculate costs if products changed
    if (updates.products) {
      const tankSize = updates.tank_size_gal || existing.tank_size_gal;
      const coverage = updates.coverage_sqft || existing.coverage_sqft;
      const costs = await calculateMixCosts(updates.products, tankSize, coverage);
      updates.products = JSON.stringify(costs.products || updates.products);
      updates.cost_per_tank = costs.cost_per_tank;
      updates.cost_per_1000sf = costs.cost_per_1000sf;
    } else if (updates.products !== undefined) {
      updates.products = JSON.stringify(updates.products);
    }

    const [mix] = await db('tank_mixes')
      .where({ id: req.params.id })
      .update(updates)
      .returning('*');

    res.json({ tank_mix: mix });
  } catch (err) {
    next(err);
  }
});

// POST /tank-mixes/:id/recalculate — recalculate costs from current inventory prices
router.post('/tank-mixes/:id/recalculate', async (req, res, next) => {
  try {
    const mix = await db('tank_mixes').where({ id: req.params.id }).first();
    if (!mix) return res.status(404).json({ error: 'Tank mix not found' });

    const products = typeof mix.products === 'string' ? JSON.parse(mix.products) : (mix.products || []);
    const costs = await calculateMixCosts(products, mix.tank_size_gal, mix.coverage_sqft);

    const [updated] = await db('tank_mixes')
      .where({ id: req.params.id })
      .update({
        products: JSON.stringify(costs.products || products),
        cost_per_tank: costs.cost_per_tank,
        cost_per_1000sf: costs.cost_per_1000sf,
        updated_at: db.fn.now(),
      })
      .returning('*');

    logger.info(`Tank mix recalculated: ${updated.name} — $${costs.cost_per_tank}/tank`);
    res.json({ tank_mix: updated });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// JOB COSTING
// =========================================================================

// GET /job-costs — list with date range filter
router.get('/job-costs', async (req, res, next) => {
  try {
    const { start_date, end_date, service_type, customer_id, page = 1, limit = 50 } = req.query;

    let query = db('job_costs')
      .leftJoin('customers', 'job_costs.customer_id', 'customers.id')
      .select(
        'job_costs.*',
        db.raw("COALESCE(customers.first_name || ' ' || customers.last_name, 'Unknown') as customer_name")
      )
      .orderBy('job_costs.service_date', 'desc');

    if (start_date) query = query.where('job_costs.service_date', '>=', start_date);
    if (end_date) query = query.where('job_costs.service_date', '<=', end_date);
    if (service_type) query = query.where('job_costs.service_type', service_type);
    if (customer_id) query = query.where('job_costs.customer_id', customer_id);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const jobs = await query.limit(parseInt(limit)).offset(offset);

    const [{ count }] = await db('job_costs').count('* as count');

    res.json({ job_costs: jobs, total: parseInt(count), page: parseInt(page) });
  } catch (err) {
    next(err);
  }
});

// POST /job-costs — create job cost record
router.post('/job-costs', async (req, res, next) => {
  try {
    const {
      service_record_id, customer_id, service_date, service_type,
      products_cost, labor_cost, drive_cost, equipment_cost,
      revenue, tank_mix_id, sqft_treated, products_used,
    } = req.body;

    if (!customer_id || !service_date) {
      return res.status(400).json({ error: 'customer_id and service_date are required' });
    }

    const prodCost = parseFloat(products_cost) || 0;
    const labCost = parseFloat(labor_cost) || 0;
    const drvCost = parseFloat(drive_cost) || 0;
    const eqCost = parseFloat(equipment_cost) || 0;
    const totalCost = prodCost + labCost + drvCost + eqCost;
    const rev = parseFloat(revenue) || 0;
    const grossProfit = rev - totalCost;
    const marginPct = rev > 0 ? Math.round((grossProfit / rev) * 10000) / 100 : 0;

    const [job] = await db('job_costs').insert({
      service_record_id: service_record_id || null,
      customer_id,
      service_date,
      service_type: service_type || null,
      products_cost: prodCost,
      labor_cost: labCost,
      drive_cost: drvCost,
      equipment_cost: eqCost,
      total_cost: totalCost,
      revenue: rev,
      gross_profit: grossProfit,
      margin_pct: marginPct,
      tank_mix_id: tank_mix_id || null,
      sqft_treated: sqft_treated || null,
      products_used: products_used ? JSON.stringify(products_used) : '[]',
    }).returning('*');

    logger.info(`Job cost recorded: ${service_type} on ${service_date} — margin ${marginPct}%`);
    res.status(201).json({ job_cost: job });
  } catch (err) {
    next(err);
  }
});

// GET /job-costs/summary — margins by service type, avg cost per service
router.get('/job-costs/summary', async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;

    let query = db('job_costs');
    if (start_date) query = query.where('service_date', '>=', start_date);
    if (end_date) query = query.where('service_date', '<=', end_date);

    const byType = await query.clone()
      .select('service_type')
      .count('* as total_jobs')
      .sum('revenue as total_revenue')
      .sum('total_cost as total_costs')
      .sum('gross_profit as total_profit')
      .avg('margin_pct as avg_margin')
      .avg('products_cost as avg_products_cost')
      .avg('labor_cost as avg_labor_cost')
      .avg('drive_cost as avg_drive_cost')
      .avg('equipment_cost as avg_equipment_cost')
      .groupBy('service_type')
      .orderBy('total_jobs', 'desc');

    const overall = await query.clone()
      .count('* as total_jobs')
      .sum('revenue as total_revenue')
      .sum('total_cost as total_costs')
      .sum('gross_profit as total_profit')
      .avg('margin_pct as avg_margin')
      .first();

    res.json({
      by_service_type: byType.map(row => ({
        ...row,
        avg_margin: row.avg_margin ? Math.round(parseFloat(row.avg_margin) * 100) / 100 : 0,
      })),
      overall: {
        ...overall,
        avg_margin: overall?.avg_margin ? Math.round(parseFloat(overall.avg_margin) * 100) / 100 : 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /job-costs/auto-calculate/:serviceRecordId — auto-calculate from service record
router.post('/job-costs/auto-calculate/:serviceRecordId', async (req, res, next) => {
  try {
    const serviceRecord = await db('service_records')
      .where({ id: req.params.serviceRecordId })
      .first();

    if (!serviceRecord) {
      return res.status(404).json({ error: 'Service record not found' });
    }

    // Defaults for SW Florida pest control / lawn care
    const IRS_MILEAGE_RATE = 0.67; // 2024 standard mileage rate
    const DEFAULT_TECH_HOURLY = 22; // avg tech rate
    const DEFAULT_SERVICE_MINUTES = 30;
    const DAILY_EQUIPMENT_COST = 15; // rough daily depreciation allocation

    // Labor cost
    const minutes = serviceRecord.duration_minutes || DEFAULT_SERVICE_MINUTES;
    const laborCost = Math.round((minutes / 60) * DEFAULT_TECH_HOURLY * 100) / 100;

    // Drive cost (estimate from mileage if available)
    const miles = serviceRecord.drive_miles || 8; // avg drive in SW FL
    const driveCost = Math.round(miles * IRS_MILEAGE_RATE * 100) / 100;

    // Equipment cost (daily depreciation split across avg jobs/day)
    const jobsPerDay = 8;
    const equipmentCost = Math.round((DAILY_EQUIPMENT_COST / jobsPerDay) * 100) / 100;

    // Products cost — try to calculate from tank mix and sqft
    let productsCost = 0;
    const sqft = serviceRecord.property_sqft || req.body.sqft_treated || 5000;

    if (req.body.tank_mix_id) {
      const mix = await db('tank_mixes').where({ id: req.body.tank_mix_id }).first();
      if (mix && mix.cost_per_1000sf) {
        productsCost = Math.round(parseFloat(mix.cost_per_1000sf) * (sqft / 1000) * 100) / 100;
      }
    }

    // Revenue from service record or body
    const revenue = parseFloat(req.body.revenue || serviceRecord.price || 0);

    const totalCost = productsCost + laborCost + driveCost + equipmentCost;
    const grossProfit = revenue - totalCost;
    const marginPct = revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : 0;

    const [job] = await db('job_costs').insert({
      service_record_id: req.params.serviceRecordId,
      customer_id: serviceRecord.customer_id,
      service_date: serviceRecord.service_date || etDateString(),
      service_type: serviceRecord.service_type || null,
      products_cost: productsCost,
      labor_cost: laborCost,
      drive_cost: driveCost,
      equipment_cost: equipmentCost,
      total_cost: totalCost,
      revenue,
      gross_profit: grossProfit,
      margin_pct: marginPct,
      tank_mix_id: req.body.tank_mix_id || null,
      sqft_treated: sqft,
      products_used: '[]',
    }).returning('*');

    logger.info(`Auto job cost: ${serviceRecord.service_type} — margin ${marginPct}%`);
    res.status(201).json({
      job_cost: job,
      calculation_details: {
        labor: { minutes, hourly_rate: DEFAULT_TECH_HOURLY, cost: laborCost },
        drive: { miles, rate_per_mile: IRS_MILEAGE_RATE, cost: driveCost },
        equipment: { daily_depreciation: DAILY_EQUIPMENT_COST, jobs_per_day: jobsPerDay, cost: equipmentCost },
        products: { sqft, cost: productsCost },
      },
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// DASHBOARD — equipment + margin overview
// =========================================================================

router.get('/dashboard', async (req, res, next) => {
  try {
    // Equipment status overview
    const equipmentByStatus = await db('equipment')
      .select('status')
      .count('* as count')
      .groupBy('status');

    // Upcoming maintenance (within 20 hours)
    const upcomingMaintenance = await db('equipment')
      .whereNotNull('next_service_hours')
      .whereRaw('"next_service_hours" - "current_hours" <= 20')
      .where('status', '!=', 'retired')
      .select('id', 'name', 'category', 'current_hours', 'next_service_hours', 'next_service_type')
      .orderByRaw('"next_service_hours" - "current_hours" ASC');

    // Recent maintenance
    const recentMaintenance = await db('equipment_maintenance_log')
      .join('equipment', 'equipment_maintenance_log.equipment_id', 'equipment.id')
      .select(
        'equipment_maintenance_log.*',
        'equipment.name as equipment_name'
      )
      .orderBy('equipment_maintenance_log.service_date', 'desc')
      .limit(10);

    // Margin summary — last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const marginSummary = await db('job_costs')
      .where('service_date', '>=', thirtyDaysAgo.toISOString().split('T')[0])
      .count('* as total_jobs')
      .sum('revenue as total_revenue')
      .sum('total_cost as total_costs')
      .sum('gross_profit as total_profit')
      .avg('margin_pct as avg_margin')
      .first();

    // Equipment total book value
    const [{ total_book_value }] = await db('equipment')
      .where('status', '!=', 'retired')
      .sum('book_value as total_book_value');

    const [{ total_purchase_value }] = await db('equipment')
      .where('status', '!=', 'retired')
      .sum('purchase_price as total_purchase_value');

    res.json({
      equipment_status: equipmentByStatus,
      upcoming_maintenance: upcomingMaintenance.map(eq => ({
        ...eq,
        hours_until_service: parseFloat(eq.next_service_hours) - parseFloat(eq.current_hours),
      })),
      recent_maintenance: recentMaintenance,
      margin_summary_30d: {
        ...marginSummary,
        avg_margin: marginSummary?.avg_margin
          ? Math.round(parseFloat(marginSummary.avg_margin) * 100) / 100
          : 0,
      },
      asset_value: {
        total_book_value: parseFloat(total_book_value) || 0,
        total_purchase_value: parseFloat(total_purchase_value) || 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
