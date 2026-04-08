/**
 * Admin Mileage Routes
 *
 * Dashboard, trip management, IRS reporting, geo-fence CRUD, analytics.
 * All endpoints require admin authentication.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const mileageService = require('../services/bouncie-mileage');

router.use(adminAuthenticate, requireTechOrAdmin);

// ─── Dashboard ───────────────────────────────────────────────────
// GET /admin/mileage/dashboard
router.get('/dashboard', async (req, res, next) => {
  try {
    const dashboard = await mileageService.getDashboard();
    res.json(dashboard);
  } catch (err) {
    next(err);
  }
});

// ─── Trips ───────────────────────────────────────────────────────
// GET /admin/mileage/trips
router.get('/trips', async (req, res, next) => {
  try {
    const {
      start_date, end_date, vehicle_id, is_business, customer_id,
      page = 1, limit = 50,
    } = req.query;

    let query = db('mileage_log')
      .leftJoin('customers', 'mileage_log.customer_id', 'customers.id')
      .select(
        'mileage_log.*',
        db.raw("COALESCE(customers.first_name || ' ' || customers.last_name, '') as customer_name")
      )
      .orderBy('mileage_log.trip_date', 'desc')
      .orderBy('mileage_log.trip_sequence', 'desc');

    if (start_date) query = query.where('mileage_log.trip_date', '>=', start_date);
    if (end_date) query = query.where('mileage_log.trip_date', '<=', end_date);
    if (vehicle_id) query = query.where('mileage_log.vehicle_id', vehicle_id);
    if (is_business !== undefined) {
      query = query.where('mileage_log.is_business', is_business === 'true');
    }
    if (customer_id) query = query.where('mileage_log.customer_id', customer_id);

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [countResult] = await query.clone().clearSelect().clearOrder().count('mileage_log.id as total');
    const total = parseInt(countResult.total);

    const trips = await query.limit(parseInt(limit)).offset(offset);

    res.json({
      trips,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PUT /admin/mileage/trips/:id — reclassify or link to job/customer
router.put('/trips/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { is_business, customer_id, job_id, notes } = req.body;

    const trip = await db('mileage_log').where('id', id).first();
    if (!trip) return res.status(404).json({ error: 'Trip not found' });

    const updates = { updated_at: db.fn.now() };

    if (is_business !== undefined) {
      updates.is_business = is_business;
      updates.purpose = is_business ? 'business' : 'personal';
      updates.classification_method = 'manual';
      updates.classification_notes = notes || (is_business ? 'Manually classified as business' : 'Manually classified as personal');

      // Recalculate deduction
      const irsRate = mileageService.getIrsRate(new Date(trip.trip_date).getFullYear());
      updates.deduction_amount = is_business
        ? parseFloat((parseFloat(trip.distance_miles) * irsRate).toFixed(2))
        : 0;
      updates.irs_rate = irsRate;
    }

    if (customer_id !== undefined) updates.customer_id = customer_id || null;
    if (job_id !== undefined) updates.job_id = job_id || null;
    if (notes && is_business === undefined) updates.classification_notes = notes;

    await db('mileage_log').where('id', id).update(updates);

    // Recompute daily summary if equipment linked
    if (trip.equipment_id) {
      const tripDate = typeof trip.trip_date === 'string' ? trip.trip_date : trip.trip_date.toISOString().split('T')[0];
      await mileageService.computeDailySummary(trip.equipment_id, tripDate);
    }

    const updated = await db('mileage_log').where('id', id).first();
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ─── Daily Summaries ─────────────────────────────────────────────
// GET /admin/mileage/daily
router.get('/daily', async (req, res, next) => {
  try {
    const { start_date, end_date, equipment_id } = req.query;

    let query = db('mileage_daily_summary')
      .leftJoin('equipment', 'mileage_daily_summary.equipment_id', 'equipment.id')
      .select('mileage_daily_summary.*', 'equipment.name as vehicle_name')
      .orderBy('mileage_daily_summary.summary_date', 'desc');

    if (start_date) query = query.where('summary_date', '>=', start_date);
    if (end_date) query = query.where('summary_date', '<=', end_date);
    if (equipment_id) query = query.where('mileage_daily_summary.equipment_id', equipment_id);

    const summaries = await query;
    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

// ─── Monthly Summaries ───────────────────────────────────────────
// GET /admin/mileage/monthly
router.get('/monthly', async (req, res, next) => {
  try {
    const { equipment_id, year } = req.query;

    let query = db('mileage_monthly_summary')
      .leftJoin('equipment', 'mileage_monthly_summary.equipment_id', 'equipment.id')
      .select('mileage_monthly_summary.*', 'equipment.name as vehicle_name')
      .orderBy('mileage_monthly_summary.summary_month', 'desc');

    if (equipment_id) query = query.where('mileage_monthly_summary.equipment_id', equipment_id);
    if (year) {
      query = query.where('summary_month', '>=', `${year}-01-01`)
                    .where('summary_month', '<=', `${year}-12-31`);
    }

    const summaries = await query;
    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

// ─── IRS Report ──────────────────────────────────────────────────
// GET /admin/mileage/irs-report
router.get('/irs-report', async (req, res, next) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const report = await mileageService.getIrsReport(year);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// GET /admin/mileage/irs-report/export — CSV download
router.get('/irs-report/export', async (req, res, next) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const csv = await mileageService.exportIrsCsv(year);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="waves_mileage_irs_${year}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ─── Manual Sync ─────────────────────────────────────────────────
// POST /admin/mileage/sync
router.post('/sync', async (req, res, next) => {
  try {
    const BouncieService = require('../services/bouncie');
    const bouncie = BouncieService.default || BouncieService;
    const instance = typeof bouncie === 'function' ? new bouncie() : bouncie;

    const today = new Date().toISOString().split('T')[0];
    const startDate = req.body.start_date || today;
    const endDate = req.body.end_date || today;

    let result = { message: 'Sync initiated' };
    if (instance && typeof instance.syncMileage === 'function') {
      result = await instance.syncMileage(startDate, endDate);
    }

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ─── Live Vehicle ────────────────────────────────────────────────
// GET /admin/mileage/live
router.get('/live', async (req, res, next) => {
  try {
    const BouncieService = require('../services/bouncie');
    const bouncie = BouncieService.default || BouncieService;
    const instance = typeof bouncie === 'function' ? new bouncie() : bouncie;

    let vehicles = [];
    if (instance && typeof instance.getVehicles === 'function') {
      vehicles = await instance.getVehicles();
    }

    res.json(vehicles);
  } catch (err) {
    next(err);
  }
});

// ─── Geo-Fences ──────────────────────────────────────────────────
// GET /admin/mileage/geo-fences
router.get('/geo-fences', async (req, res, next) => {
  try {
    const fences = await db('geo_fences')
      .where('is_active', true)
      .orderBy('name');
    res.json(fences);
  } catch (err) {
    next(err);
  }
});

// POST /admin/mileage/geo-fences
router.post('/geo-fences', async (req, res, next) => {
  try {
    const { name, fence_type, lat, lng, radius_meters, notes } = req.body;

    if (!name || !fence_type || !lat || !lng) {
      return res.status(400).json({ error: 'name, fence_type, lat, and lng are required' });
    }

    const [fence] = await db('geo_fences')
      .insert({
        name,
        fence_type,
        lat,
        lng,
        radius_meters: radius_meters || 200,
        notes: notes || null,
      })
      .returning('*');

    res.status(201).json(fence);
  } catch (err) {
    next(err);
  }
});

// PUT /admin/mileage/geo-fences/:id
router.put('/geo-fences/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, fence_type, lat, lng, radius_meters, notes } = req.body;

    const fence = await db('geo_fences').where('id', id).first();
    if (!fence) return res.status(404).json({ error: 'Geo-fence not found' });

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (fence_type !== undefined) updates.fence_type = fence_type;
    if (lat !== undefined) updates.lat = lat;
    if (lng !== undefined) updates.lng = lng;
    if (radius_meters !== undefined) updates.radius_meters = radius_meters;
    if (notes !== undefined) updates.notes = notes;

    await db('geo_fences').where('id', id).update(updates);
    const updated = await db('geo_fences').where('id', id).first();
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/mileage/geo-fences/:id — soft delete
router.delete('/geo-fences/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const fence = await db('geo_fences').where('id', id).first();
    if (!fence) return res.status(404).json({ error: 'Geo-fence not found' });

    await db('geo_fences').where('id', id).update({ is_active: false });
    res.json({ success: true, message: 'Geo-fence deactivated' });
  } catch (err) {
    next(err);
  }
});

// ─── Analytics ───────────────────────────────────────────────────
// GET /admin/mileage/analytics
router.get('/analytics', async (req, res, next) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const irsRate = mileageService.getIrsRate(year);
    const estimatedHourlyVehicleCost = 5.78; // insurance + depreciation + maintenance per drive hour

    // All trips this year
    const trips = await db('mileage_log')
      .where('trip_date', '>=', yearStart)
      .where('trip_date', '<=', yearEnd);

    const totalMiles = trips.reduce((s, t) => s + parseFloat(t.distance_miles || 0), 0);
    const totalDriveMin = trips.reduce((s, t) => s + (t.duration_minutes || 0), 0);
    const totalDriveHours = totalDriveMin / 60;
    const totalFuel = trips.reduce((s, t) => s + parseFloat(t.fuel_consumed_gal || 0), 0);
    const fuelCostEstimate = totalFuel * 3.50;

    // Actual vehicle costs (fuel + hourly vehicle overhead)
    const vehicleOverhead = totalDriveHours * estimatedHourlyVehicleCost;
    const actualTotalCost = fuelCostEstimate + vehicleOverhead;
    const actualCostPerMile = totalMiles > 0 ? parseFloat((actualTotalCost / totalMiles).toFixed(4)) : 0;

    // IRS deduction
    const businessMiles = trips.filter(t => t.is_business).reduce((s, t) => s + parseFloat(t.distance_miles || 0), 0);
    const irsDeduction = parseFloat((businessMiles * irsRate).toFixed(2));

    // IRS vs actual comparison
    const irsAdvantage = parseFloat((irsDeduction - actualTotalCost).toFixed(2));

    // Monthly breakdown
    const monthlyBreakdown = [];
    for (let m = 1; m <= 12; m++) {
      const mKey = `${year}-${String(m).padStart(2, '0')}`;
      const mTrips = trips.filter(t => {
        const td = typeof t.trip_date === 'string' ? t.trip_date : t.trip_date.toISOString().split('T')[0];
        return td.startsWith(mKey);
      });
      const mMiles = mTrips.reduce((s, t) => s + parseFloat(t.distance_miles || 0), 0);
      const mDriveMin = mTrips.reduce((s, t) => s + (t.duration_minutes || 0), 0);
      const mFuel = mTrips.reduce((s, t) => s + parseFloat(t.fuel_consumed_gal || 0), 0);
      const mFuelCost = mFuel * 3.50;
      const mOverhead = (mDriveMin / 60) * estimatedHourlyVehicleCost;
      const mActualCost = mFuelCost + mOverhead;
      const mBizMiles = mTrips.filter(t => t.is_business).reduce((s, t) => s + parseFloat(t.distance_miles || 0), 0);

      monthlyBreakdown.push({
        month: mKey,
        miles: parseFloat(mMiles.toFixed(2)),
        business_miles: parseFloat(mBizMiles.toFixed(2)),
        trips: mTrips.length,
        fuel_cost: parseFloat(mFuelCost.toFixed(2)),
        vehicle_overhead: parseFloat(mOverhead.toFixed(2)),
        actual_cost: parseFloat(mActualCost.toFixed(2)),
        irs_deduction: parseFloat((mBizMiles * irsRate).toFixed(2)),
        cost_per_mile: mMiles > 0 ? parseFloat((mActualCost / mMiles).toFixed(4)) : 0,
      });
    }

    res.json({
      year,
      irs_rate: irsRate,
      estimated_hourly_vehicle_cost: estimatedHourlyVehicleCost,
      totals: {
        total_miles: parseFloat(totalMiles.toFixed(2)),
        business_miles: parseFloat(businessMiles.toFixed(2)),
        total_trips: trips.length,
        total_drive_hours: parseFloat(totalDriveHours.toFixed(1)),
        fuel_consumed_gal: parseFloat(totalFuel.toFixed(3)),
        fuel_cost_estimate: parseFloat(fuelCostEstimate.toFixed(2)),
        vehicle_overhead: parseFloat(vehicleOverhead.toFixed(2)),
        actual_total_cost: parseFloat(actualTotalCost.toFixed(2)),
        actual_cost_per_mile: actualCostPerMile,
        irs_deduction: irsDeduction,
        irs_advantage: irsAdvantage,
      },
      monthly: monthlyBreakdown,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
