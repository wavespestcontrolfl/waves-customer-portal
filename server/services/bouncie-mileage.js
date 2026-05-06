/**
 * Bouncie Enhanced Mileage Service
 *
 * Trip classification, job matching, daily/monthly summaries,
 * IRS mileage reporting, and dashboard analytics.
 *
 * This is a standalone service — does NOT modify existing bouncie.js.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Haversine distance in meters between two lat/lng points
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * IRS standard mileage rate for a given tax year
 */
function getIrsRate(year) {
  const rates = {
    2024: 0.67,
    2025: 0.70,
    2026: 0.70,
  };
  return rates[year] || rates[2026];
}

function tripDateForBouncieStart(startTime) {
  return startTime ? etDateString(new Date(startTime)) : etDateString();
}

// ─── Trip-to-Job Matching ────────────────────────────────────────

/**
 * Find the closest scheduled service / customer within 200m of trip endpoint
 * @param {number} endLat
 * @param {number} endLng
 * @param {string} tripDate - YYYY-MM-DD
 * @returns {{ customer_id, job_id, customer_name, distance_m } | null}
 */
async function matchTripToJob(endLat, endLng, tripDate) {
  if (!endLat || !endLng) return null;

  try {
    // Pull scheduled services for the date with customer addresses
    const services = await db('scheduled_services as ss')
      .join('customers as c', 'ss.customer_id', 'c.id')
      .where('ss.scheduled_date', tripDate)
      .whereNotNull('c.latitude')
      .whereNotNull('c.longitude')
      .select(
        'ss.id as job_id',
        'ss.customer_id',
        'c.first_name',
        'c.last_name',
        'c.latitude',
        'c.longitude'
      );

    let best = null;
    let bestDist = Infinity;

    for (const svc of services) {
      const dist = haversineMeters(
        endLat, endLng,
        parseFloat(svc.latitude), parseFloat(svc.longitude)
      );
      if (dist < 200 && dist < bestDist) {
        bestDist = dist;
        best = {
          customer_id: svc.customer_id,
          job_id: svc.job_id,
          customer_name: `${svc.first_name || ''} ${svc.last_name || ''}`.trim(),
          distance_m: Math.round(dist),
        };
      }
    }

    return best;
  } catch (err) {
    logger.error(`[bouncie-mileage] matchTripToJob error: ${err.message}`);
    return null;
  }
}

// ─── Trip Classification ─────────────────────────────────────────

/**
 * Classify a trip as business or personal based on geo-fences.
 *
 * Logic:
 * - If start OR end is within a 'personal' geo-fence → personal
 * - If start OR end is within a 'business' or 'supplier' fence → business
 * - Default: business (conservative for IRS — better to over-count than under)
 *
 * @returns {{ is_business: boolean, method: string, notes: string }}
 */
async function classifyTrip(startLat, startLng, endLat, endLng) {
  const defaultResult = { is_business: true, method: 'auto', notes: 'Default: classified as business (no fence match)' };

  if (!startLat || !startLng || !endLat || !endLng) {
    return { is_business: true, method: 'auto', notes: 'Missing coordinates — defaulting to business' };
  }

  try {
    const fences = await db('geo_fences').where('is_active', true);

    for (const fence of fences) {
      const fLat = parseFloat(fence.lat);
      const fLng = parseFloat(fence.lng);
      const radius = fence.radius_meters || 200;

      const startDist = haversineMeters(startLat, startLng, fLat, fLng);
      const endDist = haversineMeters(endLat, endLng, fLat, fLng);
      const startInside = startDist <= radius;
      const endInside = endDist <= radius;

      if ((startInside || endInside) && fence.fence_type === 'personal') {
        return {
          is_business: false,
          method: 'auto',
          notes: `Personal: matched geo-fence "${fence.name}" (${fence.fence_type})`,
        };
      }
    }

    // Check for business/supplier fences
    for (const fence of fences) {
      const fLat = parseFloat(fence.lat);
      const fLng = parseFloat(fence.lng);
      const radius = fence.radius_meters || 200;

      const startDist = haversineMeters(startLat, startLng, fLat, fLng);
      const endDist = haversineMeters(endLat, endLng, fLat, fLng);

      if ((startDist <= radius || endDist <= radius) &&
          (fence.fence_type === 'business' || fence.fence_type === 'supplier' || fence.fence_type === 'customer_zone')) {
        return {
          is_business: true,
          method: 'auto',
          notes: `Business: matched geo-fence "${fence.name}" (${fence.fence_type})`,
        };
      }
    }

    return defaultResult;
  } catch (err) {
    logger.error(`[bouncie-mileage] classifyTrip error: ${err.message}`);
    return defaultResult;
  }
}

// ─── Webhook Trip Processing ─────────────────────────────────────

/**
 * Process a Bouncie tripCompleted webhook event.
 * Classifies the trip, matches to a job, and inserts into mileage_log.
 *
 * @param {object} event - Bouncie webhook payload
 */
async function processTripWebhook(event) {
  try {
    const trip = event.data || event;
    const imei = event.imei || trip.imei || trip.vehicleId || '';

    const startLat = trip.startLocation?.lat || trip.startLat || null;
    const startLng = trip.startLocation?.lon || trip.startLocation?.lng || trip.startLng || null;
    const endLat = trip.endLocation?.lat || trip.endLat || null;
    const endLng = trip.endLocation?.lon || trip.endLocation?.lng || trip.endLng || null;

    const distanceMeters = trip.distance || 0;
    const distanceMiles = parseFloat((distanceMeters * 0.000621371).toFixed(2));
    const durationSeconds = trip.duration || 0;
    const durationMinutes = Math.round(durationSeconds / 60);

    const tripDate = tripDateForBouncieStart(trip.startTime);

    const tripId = trip.transactionId || trip.id || `${imei}-${trip.startTime || Date.now()}`;

    // Dedup check
    const existing = await db('mileage_log').where('bouncie_trip_id', tripId).first();
    if (existing) {
      logger.info(`[bouncie-mileage] Trip ${tripId} already exists, skipping`);
      return existing;
    }

    // Classify trip
    const classification = await classifyTrip(startLat, startLng, endLat, endLng);

    // Match to job/customer
    const jobMatch = await matchTripToJob(endLat, endLng, tripDate);

    // If job matched, definitely business
    if (jobMatch) {
      classification.is_business = true;
      classification.notes = `Job match: ${jobMatch.customer_name} (${jobMatch.distance_m}m away)`;
    }

    const year = new Date(tripDate).getFullYear();
    const irsRate = getIrsRate(year);
    const deductionAmount = classification.is_business
      ? parseFloat((distanceMiles * irsRate).toFixed(2))
      : 0;

    // Find equipment by IMEI/vehicle_id
    const equipment = await db('equipment')
      .where('vin', imei)
      .orWhere('serial_number', imei)
      .first();

    const startAddr = trip.startLocation?.address ||
      (startLat && startLng ? `${startLat}, ${startLng}` : 'Unknown');
    const endAddr = trip.endLocation?.address ||
      (endLat && endLng ? `${endLat}, ${endLng}` : 'Unknown');

    // Count existing trips for today to set sequence
    const tripCount = await db('mileage_log')
      .where('vehicle_id', imei)
      .where('trip_date', tripDate)
      .count('id as cnt')
      .first();
    const sequence = (parseInt(tripCount.cnt) || 0) + 1;

    const [inserted] = await db('mileage_log')
      .insert({
        vehicle_id: imei,
        vehicle_name: equipment ? equipment.name : (trip.nickName || imei),
        trip_date: tripDate,
        start_address: startAddr,
        end_address: endAddr,
        distance_miles: distanceMiles,
        duration_minutes: durationMinutes,
        purpose: classification.is_business ? 'business' : 'personal',
        irs_rate: irsRate,
        deduction_amount: deductionAmount,
        bouncie_trip_id: tripId,
        source: 'bouncie',
        equipment_id: equipment ? equipment.id : null,
        customer_id: jobMatch ? jobMatch.customer_id : null,
        job_id: jobMatch ? jobMatch.job_id : null,
        start_lat: startLat,
        start_lng: startLng,
        end_lat: endLat,
        end_lng: endLng,
        start_odometer: trip.startOdometer || null,
        end_odometer: trip.endOdometer || null,
        max_speed_mph: trip.maxSpeed ? Math.round(trip.maxSpeed * 0.621371) : null,
        avg_speed_mph: (distanceMiles && durationMinutes)
          ? Math.round(distanceMiles / (durationMinutes / 60))
          : null,
        hard_brakes: trip.hardBrakes || 0,
        hard_accels: trip.hardAccelerations || trip.hardAccels || 0,
        idle_minutes: trip.idleTime ? Math.round(trip.idleTime / 60) : 0,
        fuel_consumed_gal: trip.fuelConsumed || null,
        fuel_economy_mpg: (trip.fuelConsumed && trip.fuelConsumed > 0)
          ? parseFloat((distanceMiles / trip.fuelConsumed).toFixed(1))
          : null,
        is_business: classification.is_business,
        classification_method: classification.method,
        classification_notes: classification.notes,
        route_date: tripDate,
        trip_sequence: sequence,
      })
      .returning('*');

    logger.info(`[bouncie-mileage] Processed trip ${tripId}: ${distanceMiles}mi, ${classification.is_business ? 'business' : 'personal'}`);

    // Update daily summary
    if (equipment) {
      await computeDailySummary(equipment.id, tripDate);
    }

    return inserted;
  } catch (err) {
    logger.error(`[bouncie-mileage] processTripWebhook error: ${err.message}`);
    throw err;
  }
}

// ─── Daily Summary ───────────────────────────────────────────────

/**
 * Compute (or recompute) the daily summary for a vehicle on a given date.
 * Aggregates all trips from mileage_log and upserts into mileage_daily_summary.
 *
 * @param {string} equipmentId - UUID
 * @param {string} date - YYYY-MM-DD
 */
async function computeDailySummary(equipmentId, date) {
  try {
    const trips = await db('mileage_log')
      .where('equipment_id', equipmentId)
      .where('trip_date', date);

    if (trips.length === 0) return null;

    const totalMiles = trips.reduce((sum, t) => sum + parseFloat(t.distance_miles || 0), 0);
    const businessTrips = trips.filter(t => t.is_business);
    const personalTrips = trips.filter(t => !t.is_business);
    const businessMiles = businessTrips.reduce((sum, t) => sum + parseFloat(t.distance_miles || 0), 0);
    const personalMiles = personalTrips.reduce((sum, t) => sum + parseFloat(t.distance_miles || 0), 0);
    const businessPct = totalMiles > 0 ? parseFloat(((businessMiles / totalMiles) * 100).toFixed(2)) : 100;

    const totalDriveMin = trips.reduce((sum, t) => sum + (t.duration_minutes || 0), 0);
    const totalIdleMin = trips.reduce((sum, t) => sum + (t.idle_minutes || 0), 0);
    const customerStops = trips.filter(t => t.customer_id).length;

    const totalFuel = trips.reduce((sum, t) => sum + parseFloat(t.fuel_consumed_gal || 0), 0);
    const avgMpg = totalFuel > 0 ? parseFloat((totalMiles / totalFuel).toFixed(1)) : null;

    const hardBrakes = trips.reduce((sum, t) => sum + (t.hard_brakes || 0), 0);
    const hardAccels = trips.reduce((sum, t) => sum + (t.hard_accels || 0), 0);
    const maxSpeed = Math.max(...trips.map(t => t.max_speed_mph || 0));

    const odometers = trips.filter(t => t.start_odometer || t.end_odometer);
    const odometerStart = odometers.length > 0
      ? Math.min(...odometers.map(t => t.start_odometer || Infinity))
      : null;
    const odometerEnd = odometers.length > 0
      ? Math.max(...odometers.map(t => t.end_odometer || 0))
      : null;

    const year = new Date(date).getFullYear();
    const irsRate = getIrsRate(year);
    const irsDeduction = parseFloat((businessMiles * irsRate).toFixed(2));

    // Count completed jobs and revenue for this vehicle's technician on this date
    const equipment = await db('equipment').where('id', equipmentId).first();
    let jobsCompleted = 0;
    let revenueGenerated = 0;

    if (equipment && equipment.assigned_to) {
      const jobs = await db('scheduled_services')
        .where('technician_id', equipment.assigned_to)
        .where('scheduled_date', date)
        .where('status', 'completed');
      jobsCompleted = jobs.length;
      revenueGenerated = jobs.reduce((sum, j) => sum + parseFloat(j.price || 0), 0);
    }

    const summary = {
      equipment_id: equipmentId,
      summary_date: date,
      technician_id: equipment ? equipment.assigned_to : null,
      total_miles: parseFloat(totalMiles.toFixed(2)),
      business_miles: parseFloat(businessMiles.toFixed(2)),
      personal_miles: parseFloat(personalMiles.toFixed(2)),
      business_pct: businessPct,
      trip_count: trips.length,
      total_drive_minutes: totalDriveMin,
      total_idle_minutes: totalIdleMin,
      customer_stops: customerStops,
      fuel_consumed_gal: totalFuel > 0 ? parseFloat(totalFuel.toFixed(3)) : null,
      avg_mpg: avgMpg,
      hard_brakes: hardBrakes,
      hard_accels: hardAccels,
      max_speed_mph: maxSpeed > 0 ? maxSpeed : null,
      odometer_start: odometerStart === Infinity ? null : odometerStart,
      odometer_end: odometerEnd || null,
      irs_rate: irsRate,
      irs_deduction: irsDeduction,
      jobs_completed: jobsCompleted,
      revenue_generated: parseFloat(revenueGenerated.toFixed(2)),
    };

    // Upsert
    const existing = await db('mileage_daily_summary')
      .where({ equipment_id: equipmentId, summary_date: date })
      .first();

    if (existing) {
      await db('mileage_daily_summary')
        .where('id', existing.id)
        .update({ ...summary, updated_at: db.fn.now() });
    } else {
      await db('mileage_daily_summary').insert(summary);
    }

    logger.info(`[bouncie-mileage] Daily summary for ${equipmentId} on ${date}: ${totalMiles.toFixed(1)}mi, ${trips.length} trips`);
    return summary;
  } catch (err) {
    logger.error(`[bouncie-mileage] computeDailySummary error: ${err.message}`);
    throw err;
  }
}

// ─── Monthly Summary ─────────────────────────────────────────────

/**
 * Compute (or recompute) the monthly summary for a vehicle.
 *
 * @param {string} equipmentId - UUID
 * @param {string} monthDate - any date in the month, e.g. '2026-03-01'
 */
async function computeMonthlySummary(equipmentId, monthDate) {
  try {
    const d = new Date(monthDate);
    const monthStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const monthEnd = nextMonth.toISOString().split('T')[0];

    const dailies = await db('mileage_daily_summary')
      .where('equipment_id', equipmentId)
      .where('summary_date', '>=', monthStart)
      .where('summary_date', '<', monthEnd)
      .orderBy('summary_date');

    if (dailies.length === 0) return null;

    const totalMiles = dailies.reduce((s, d) => s + parseFloat(d.total_miles || 0), 0);
    const businessMiles = dailies.reduce((s, d) => s + parseFloat(d.business_miles || 0), 0);
    const personalMiles = dailies.reduce((s, d) => s + parseFloat(d.personal_miles || 0), 0);
    const businessPct = totalMiles > 0 ? parseFloat(((businessMiles / totalMiles) * 100).toFixed(2)) : 100;
    const tripCount = dailies.reduce((s, d) => s + (d.trip_count || 0), 0);
    const driveDays = dailies.length;
    const avgDailyMiles = parseFloat((totalMiles / driveDays).toFixed(2));

    const totalFuel = dailies.reduce((s, d) => s + parseFloat(d.fuel_consumed_gal || 0), 0);
    const fuelCostEstimated = parseFloat((totalFuel * 3.50).toFixed(2)); // ~$3.50/gal estimate
    const avgMpg = totalFuel > 0 ? parseFloat((totalMiles / totalFuel).toFixed(1)) : null;

    const year = new Date(monthStart).getFullYear();
    const irsRate = getIrsRate(year);
    const irsDeduction = parseFloat((businessMiles * irsRate).toFixed(2));

    const hardBrakesTotal = dailies.reduce((s, d) => s + (d.hard_brakes || 0), 0);
    const hardAccelsTotal = dailies.reduce((s, d) => s + (d.hard_accels || 0), 0);

    // Driving score: start at 100, deduct for hard events
    // -2 per hard brake, -1 per hard accel, capped to [0, 100]
    const eventPenalty = (hardBrakesTotal * 2) + (hardAccelsTotal * 1);
    const rawScore = 100 - Math.min(eventPenalty, 100);
    const drivingScore = Math.max(0, Math.min(100, rawScore));

    const summary = {
      equipment_id: equipmentId,
      summary_month: monthStart,
      total_miles: parseFloat(totalMiles.toFixed(2)),
      business_miles: parseFloat(businessMiles.toFixed(2)),
      personal_miles: parseFloat(personalMiles.toFixed(2)),
      business_pct: businessPct,
      trip_count: tripCount,
      drive_days: driveDays,
      avg_daily_miles: avgDailyMiles,
      fuel_consumed_gal: totalFuel > 0 ? parseFloat(totalFuel.toFixed(3)) : null,
      fuel_cost_estimated: fuelCostEstimated,
      avg_mpg: avgMpg,
      irs_rate: irsRate,
      irs_deduction: irsDeduction,
      hard_brakes_total: hardBrakesTotal,
      hard_accels_total: hardAccelsTotal,
      driving_score: drivingScore,
    };

    // Upsert
    const existing = await db('mileage_monthly_summary')
      .where({ equipment_id: equipmentId, summary_month: monthStart })
      .first();

    if (existing) {
      await db('mileage_monthly_summary')
        .where('id', existing.id)
        .update({ ...summary, updated_at: db.fn.now() });
    } else {
      await db('mileage_monthly_summary').insert(summary);
    }

    logger.info(`[bouncie-mileage] Monthly summary for ${equipmentId} ${monthStart}: ${totalMiles.toFixed(1)}mi, score ${drivingScore}`);
    return summary;
  } catch (err) {
    logger.error(`[bouncie-mileage] computeMonthlySummary error: ${err.message}`);
    throw err;
  }
}

// ─── Dashboard ───────────────────────────────────────────────────

/**
 * Get dashboard stats: today's driving, MTD stats, live vehicle location
 */
async function getDashboard() {
  try {
    const today = etDateString();
    const monthStart = today.slice(0, 7) + '-01';

    // Today's trips
    const todayTrips = await db('mileage_log').where('trip_date', today);
    const todayMiles = todayTrips.reduce((s, t) => s + parseFloat(t.distance_miles || 0), 0);
    const todayBusinessMiles = todayTrips.filter(t => t.is_business).reduce((s, t) => s + parseFloat(t.distance_miles || 0), 0);
    const todayDriveMin = todayTrips.reduce((s, t) => s + (t.duration_minutes || 0), 0);
    const todayIdleMin = todayTrips.reduce((s, t) => s + (t.idle_minutes || 0), 0);
    const todayCustomerStops = todayTrips.filter(t => t.customer_id).length;
    const todayIrsDeduction = todayTrips.reduce((s, t) => s + parseFloat(t.deduction_amount || 0), 0);

    // MTD
    const mtdTrips = await db('mileage_log')
      .where('trip_date', '>=', monthStart)
      .where('trip_date', '<=', today);
    const mtdMiles = mtdTrips.reduce((s, t) => s + parseFloat(t.distance_miles || 0), 0);
    const mtdBusinessMiles = mtdTrips.filter(t => t.is_business).reduce((s, t) => s + parseFloat(t.distance_miles || 0), 0);
    const mtdIrsDeduction = mtdTrips.reduce((s, t) => s + parseFloat(t.deduction_amount || 0), 0);
    const mtdFuel = mtdTrips.reduce((s, t) => s + parseFloat(t.fuel_consumed_gal || 0), 0);
    const uniqueDays = new Set(mtdTrips.map(t => t.trip_date)).size;
    const avgDailyMiles = uniqueDays > 0 ? parseFloat((mtdMiles / uniqueDays).toFixed(1)) : 0;

    // Live vehicle (try loading existing bouncie service)
    let liveVehicle = null;
    try {
      const bouncieService = require('./bouncie');
      const svc = bouncieService.default || bouncieService;
      const instance = typeof svc === 'function' ? new svc() : svc;
      if (instance && typeof instance.getVehicles === 'function') {
        const vehicles = await instance.getVehicles();
        liveVehicle = vehicles[0] || null;
      }
    } catch (_) {
      // bouncie service may not be available
    }

    return {
      today: {
        date: today,
        total_miles: parseFloat(todayMiles.toFixed(2)),
        business_miles: parseFloat(todayBusinessMiles.toFixed(2)),
        trip_count: todayTrips.length,
        drive_minutes: todayDriveMin,
        idle_minutes: todayIdleMin,
        customer_stops: todayCustomerStops,
        irs_deduction: parseFloat(todayIrsDeduction.toFixed(2)),
      },
      mtd: {
        month: monthStart,
        total_miles: parseFloat(mtdMiles.toFixed(2)),
        business_miles: parseFloat(mtdBusinessMiles.toFixed(2)),
        trip_count: mtdTrips.length,
        irs_deduction: parseFloat(mtdIrsDeduction.toFixed(2)),
        fuel_consumed_gal: parseFloat(mtdFuel.toFixed(3)),
        drive_days: uniqueDays,
        avg_daily_miles: avgDailyMiles,
      },
      live_vehicle: liveVehicle,
    };
  } catch (err) {
    logger.error(`[bouncie-mileage] getDashboard error: ${err.message}`);
    throw err;
  }
}

// ─── IRS Report ──────────────────────────────────────────────────

/**
 * Generate IRS mileage report data for a given tax year.
 * Monthly breakdown + YTD totals.
 *
 * @param {number} year
 * @returns {{ year, irs_rate, months: [], ytd: {} }}
 */
async function getIrsReport(year) {
  try {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const irsRate = getIrsRate(year);

    const trips = await db('mileage_log')
      .where('trip_date', '>=', yearStart)
      .where('trip_date', '<=', yearEnd)
      .orderBy('trip_date');

    // Group by month
    const monthMap = {};
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, '0')}`;
      monthMap[key] = { month: key, total_miles: 0, business_miles: 0, personal_miles: 0, trip_count: 0, irs_deduction: 0 };
    }

    let ytdTotal = 0;
    let ytdBusiness = 0;
    let ytdPersonal = 0;
    let ytdTrips = 0;

    for (const trip of trips) {
      const tripDate = typeof trip.trip_date === 'string' ? trip.trip_date : trip.trip_date.toISOString().split('T')[0];
      const monthKey = tripDate.slice(0, 7);
      const miles = parseFloat(trip.distance_miles || 0);
      const isBiz = trip.is_business !== false && trip.purpose !== 'personal';

      if (monthMap[monthKey]) {
        monthMap[monthKey].total_miles += miles;
        monthMap[monthKey].trip_count += 1;
        if (isBiz) {
          monthMap[monthKey].business_miles += miles;
        } else {
          monthMap[monthKey].personal_miles += miles;
        }
      }

      ytdTotal += miles;
      ytdTrips += 1;
      if (isBiz) ytdBusiness += miles;
      else ytdPersonal += miles;
    }

    // Calculate deductions
    const months = Object.values(monthMap).map(m => ({
      ...m,
      total_miles: parseFloat(m.total_miles.toFixed(2)),
      business_miles: parseFloat(m.business_miles.toFixed(2)),
      personal_miles: parseFloat(m.personal_miles.toFixed(2)),
      irs_deduction: parseFloat((m.business_miles * irsRate).toFixed(2)),
    }));

    return {
      year,
      irs_rate: irsRate,
      months,
      ytd: {
        total_miles: parseFloat(ytdTotal.toFixed(2)),
        business_miles: parseFloat(ytdBusiness.toFixed(2)),
        personal_miles: parseFloat(ytdPersonal.toFixed(2)),
        trip_count: ytdTrips,
        irs_deduction: parseFloat((ytdBusiness * irsRate).toFixed(2)),
        business_pct: ytdTotal > 0 ? parseFloat(((ytdBusiness / ytdTotal) * 100).toFixed(1)) : 100,
      },
    };
  } catch (err) {
    logger.error(`[bouncie-mileage] getIrsReport error: ${err.message}`);
    throw err;
  }
}

// ─── CSV Export ───────────────────────────────────────────────────

/**
 * Generate a CSV string for IRS mileage documentation.
 * Columns: Date, Start Address, End Address, Business Miles, Purpose, Deduction
 *
 * @param {number} year
 * @returns {string} CSV content
 */
async function exportIrsCsv(year) {
  try {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const irsRate = getIrsRate(year);

    const trips = await db('mileage_log')
      .where('trip_date', '>=', yearStart)
      .where('trip_date', '<=', yearEnd)
      .where('is_business', true)
      .orderBy('trip_date')
      .orderBy('trip_sequence');

    const header = 'Date,Start Address,End Address,Business Miles,Purpose,Deduction';
    const rows = trips.map(t => {
      const date = typeof t.trip_date === 'string' ? t.trip_date : t.trip_date.toISOString().split('T')[0];
      const startAddr = (t.start_address || '').replace(/"/g, '""');
      const endAddr = (t.end_address || '').replace(/"/g, '""');
      const miles = parseFloat(t.distance_miles || 0).toFixed(2);
      const purpose = t.classification_notes || t.purpose || 'business';
      const deduction = parseFloat((parseFloat(t.distance_miles || 0) * irsRate).toFixed(2));
      return `${date},"${startAddr}","${endAddr}",${miles},"${purpose.replace(/"/g, '""')}",${deduction}`;
    });

    let csv = header + '\n' + rows.join('\n');

    // Add totals row
    const totalMiles = trips.reduce((s, t) => s + parseFloat(t.distance_miles || 0), 0);
    const totalDeduction = parseFloat((totalMiles * irsRate).toFixed(2));
    csv += `\n\nTOTAL,,,"${totalMiles.toFixed(2)}","IRS Rate: $${irsRate}/mile","$${totalDeduction.toFixed(2)}"`;

    return csv;
  } catch (err) {
    logger.error(`[bouncie-mileage] exportIrsCsv error: ${err.message}`);
    throw err;
  }
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
  haversineMeters,
  getIrsRate,
  tripDateForBouncieStart,
  matchTripToJob,
  classifyTrip,
  processTripWebhook,
  computeDailySummary,
  computeMonthlySummary,
  getDashboard,
  getIrsReport,
  exportIrsCsv,
};
