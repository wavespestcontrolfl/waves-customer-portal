/**
 * Equipment Maintenance & Fleet Tracking Service
 *
 * Handles maintenance scheduling, mileage tracking, cost analysis,
 * and alert generation for the Waves equipment fleet.
 */
const db = require('../models/db');
const logger = require('./logger');
const { v4: uuidv4 } = require('uuid');

// ─── Nightly Maintenance Check ───────────────────────────────────
/**
 * Check all active maintenance schedules and flag overdue items.
 * Called nightly by equipment-crons.js.
 */
async function checkMaintenanceDue() {
  const tag = '[equipment-maintenance] checkMaintenanceDue';
  try {
    const schedules = await db('maintenance_schedules')
      .join('equipment', 'maintenance_schedules.equipment_id', 'equipment.id')
      .where('maintenance_schedules.is_active', true)
      .whereIn('equipment.status', ['active', 'in_service'])
      .select(
        'maintenance_schedules.*',
        'equipment.name as equipment_name',
        'equipment.asset_tag',
        'equipment.current_miles',
        'equipment.current_hours',
        'equipment.category'
      );

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let overdueCount = 0;
    let dueSoonCount = 0;

    for (const schedule of schedules) {
      let isOverdue = false;
      let isDueSoon = false;

      // Check date-based due
      if (schedule.next_due_at) {
        const dueDate = new Date(schedule.next_due_at);
        dueDate.setHours(0, 0, 0, 0);
        const daysUntilDue = Math.floor((dueDate - today) / (1000 * 60 * 60 * 24));

        if (daysUntilDue <= 0) {
          isOverdue = true;
        } else if (daysUntilDue <= (schedule.notify_days_before || 7)) {
          isDueSoon = true;
        }
      }

      // Check miles-based due
      if (schedule.next_due_miles && schedule.current_miles) {
        const milesRemaining = schedule.next_due_miles - schedule.current_miles;
        if (milesRemaining <= 0) isOverdue = true;
        else if (milesRemaining <= 500) isDueSoon = true;
      }

      // Check hours-based due
      if (schedule.next_due_hours && schedule.current_hours) {
        const hoursRemaining = parseFloat(schedule.next_due_hours) - parseFloat(schedule.current_hours);
        if (hoursRemaining <= 0) isOverdue = true;
        else if (hoursRemaining <= 10) isDueSoon = true;
      }

      // Update overdue flag
      if (isOverdue !== schedule.is_overdue) {
        await db('maintenance_schedules')
          .where('id', schedule.id)
          .update({ is_overdue: isOverdue, updated_at: db.fn.now() });
      }

      // Generate alerts
      if (isOverdue) {
        overdueCount++;
        await generateMaintenanceAlert(schedule, true);
      } else if (isDueSoon) {
        dueSoonCount++;
        await generateMaintenanceAlert(schedule, false);
      }
    }

    // Check for follow-ups due
    const followUps = await db('maintenance_records')
      .where('follow_up_needed', true)
      .where('follow_up_date', '<=', today.toISOString().split('T')[0])
      .whereNotExists(function () {
        this.select('id').from('maintenance_alerts')
          .whereRaw('maintenance_alerts.equipment_id = maintenance_records.equipment_id')
          .where('alert_type', 'follow_up_due')
          .where('status', 'new')
          .whereRaw("maintenance_alerts.title LIKE '%' || maintenance_records.task_name || '%'");
      });

    for (const fu of followUps) {
      const equipment = await db('equipment').where('id', fu.equipment_id).first();
      if (equipment) {
        await db('maintenance_alerts').insert({
          id: uuidv4(),
          equipment_id: fu.equipment_id,
          alert_type: 'follow_up_due',
          severity: 'medium',
          title: `Follow-up Due: ${fu.task_name} — ${equipment.name} ${equipment.asset_tag || ''}`.trim(),
          description: fu.follow_up_notes || `Follow-up inspection due for ${fu.task_name}`,
          status: 'new',
          created_at: db.fn.now(),
          updated_at: db.fn.now(),
        });
      }
    }

    logger.info(`${tag} Complete: ${overdueCount} overdue, ${dueSoonCount} due soon, ${followUps.length} follow-ups`);
    return { overdueCount, dueSoonCount, followUpCount: followUps.length };
  } catch (err) {
    logger.error(`${tag} Error:`, err);
    throw err;
  }
}

// ─── Record Maintenance ──────────────────────────────────────────
/**
 * Record a completed maintenance event, update schedule, update equipment condition.
 */
async function recordMaintenance({
  equipmentId, scheduleId, maintenanceType, taskName, description,
  performedBy, vendorName, milesAtService, hoursAtService,
  conditionBefore, conditionAfter, partsCost = 0, laborCost = 0,
  vendorCost = 0, partsUsed, downtimeHours = 0, followUpNeeded = false,
  followUpNotes, followUpDate, warrantyClaim = false, receiptUrl,
}) {
  const tag = '[equipment-maintenance] recordMaintenance';
  try {
    const totalCost = parseFloat(partsCost || 0) + parseFloat(laborCost || 0) + parseFloat(vendorCost || 0);

    const recordId = uuidv4();
    const record = {
      id: recordId,
      equipment_id: equipmentId,
      schedule_id: scheduleId || null,
      maintenance_type: maintenanceType || 'scheduled',
      task_name: taskName,
      description: description || null,
      performed_at: db.fn.now(),
      performed_by: performedBy || null,
      vendor_name: vendorName || null,
      miles_at_service: milesAtService || null,
      hours_at_service: hoursAtService || null,
      condition_before: conditionBefore || null,
      condition_after: conditionAfter || null,
      parts_cost: partsCost || 0,
      labor_cost: laborCost || 0,
      vendor_cost: vendorCost || 0,
      total_cost: totalCost,
      receipt_url: receiptUrl || null,
      downtime_hours: downtimeHours || 0,
      equipment_was_down: downtimeHours > 0,
      parts_used: partsUsed ? JSON.stringify(partsUsed) : null,
      follow_up_needed: followUpNeeded,
      follow_up_notes: followUpNotes || null,
      follow_up_date: followUpDate || null,
      warranty_claim: warrantyClaim,
      warranty_claim_status: warrantyClaim ? 'submitted' : null,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    };

    const [inserted] = await db('maintenance_records').insert(record).returning('*');

    // Update equipment condition
    const equipmentUpdates = { updated_at: db.fn.now() };
    if (conditionAfter) equipmentUpdates.condition_rating = conditionAfter;
    if (milesAtService) equipmentUpdates.current_miles = milesAtService;
    if (hoursAtService) equipmentUpdates.current_hours = hoursAtService;
    await db('equipment').where('id', equipmentId).update(equipmentUpdates);

    // Update schedule if linked
    if (scheduleId) {
      const schedule = await db('maintenance_schedules').where('id', scheduleId).first();
      if (schedule) {
        const scheduleUpdates = {
          last_performed_at: db.fn.now(),
          last_performed_by: performedBy || null,
          is_overdue: false,
          updated_at: db.fn.now(),
        };

        if (milesAtService) scheduleUpdates.last_performed_miles = milesAtService;
        if (hoursAtService) scheduleUpdates.last_performed_hours = hoursAtService;

        // Calculate next due
        if (schedule.interval_days) {
          const next = new Date();
          next.setDate(next.getDate() + schedule.interval_days);
          scheduleUpdates.next_due_at = next.toISOString().split('T')[0];
        } else if (schedule.interval_months) {
          const next = new Date();
          next.setMonth(next.getMonth() + schedule.interval_months);
          scheduleUpdates.next_due_at = next.toISOString().split('T')[0];
        }

        if (schedule.interval_miles && milesAtService) {
          scheduleUpdates.next_due_miles = parseInt(milesAtService) + schedule.interval_miles;
        }
        if (schedule.interval_hours && hoursAtService) {
          scheduleUpdates.next_due_hours = parseFloat(hoursAtService) + schedule.interval_hours;
        }

        await db('maintenance_schedules').where('id', scheduleId).update(scheduleUpdates);

        // Resolve any related alerts
        await db('maintenance_alerts')
          .where('schedule_id', scheduleId)
          .whereIn('status', ['new', 'acknowledged'])
          .update({
            status: 'resolved',
            resolved_at: db.fn.now(),
            resolved_by: performedBy || 'system',
            updated_at: db.fn.now(),
          });
      }
    }

    // Log downtime if equipment was down
    if (downtimeHours > 0) {
      await db('equipment_downtime_log').insert({
        id: uuidv4(),
        equipment_id: equipmentId,
        maintenance_record_id: recordId,
        reason: taskName,
        started_at: db.fn.now(),
        ended_at: db.fn.now(),
        duration_hours: downtimeHours,
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      });
    }

    logger.info(`${tag} Recorded: ${taskName} on ${equipmentId}, cost: $${totalCost}`);
    return inserted;
  } catch (err) {
    logger.error(`${tag} Error:`, err);
    throw err;
  }
}

// ─── Log Mileage ─────────────────────────────────────────────────
/**
 * Upsert daily mileage for a vehicle. Calculates IRS deduction at $0.70/mile.
 */
async function logMileage({
  vehicleId, logDate, odometerStart, odometerEnd,
  businessMiles, personalMiles = 0, fuelGallons, fuelCost,
  jobsServiced, jobIds, source = 'manual', loggedBy, notes,
}) {
  const tag = '[equipment-maintenance] logMileage';
  try {
    const totalMiles = odometerEnd - odometerStart;
    if (totalMiles < 0) throw new Error('Odometer end must be greater than start');

    const bMiles = businessMiles != null ? parseFloat(businessMiles) : totalMiles - parseFloat(personalMiles || 0);
    const pMiles = parseFloat(personalMiles || 0);
    const businessPct = totalMiles > 0 ? Math.round((bMiles / totalMiles) * 10000) / 100 : 100;
    const irsRate = 0.70;
    const irsDeduction = Math.round(bMiles * irsRate * 100) / 100;
    const fuelPricePerGallon = fuelGallons && fuelCost
      ? Math.round((parseFloat(fuelCost) / parseFloat(fuelGallons)) * 1000) / 1000
      : null;

    const data = {
      vehicle_id: vehicleId,
      log_date: logDate,
      odometer_start: odometerStart,
      odometer_end: odometerEnd,
      total_miles: totalMiles,
      source,
      business_miles: bMiles,
      personal_miles: pMiles,
      business_pct: businessPct,
      fuel_gallons: fuelGallons || null,
      fuel_cost: fuelCost || null,
      fuel_price_per_gallon: fuelPricePerGallon,
      jobs_serviced: jobsServiced || null,
      job_ids: jobIds ? JSON.stringify(jobIds) : null,
      irs_standard_rate: irsRate,
      irs_deduction_amount: irsDeduction,
      logged_by: loggedBy || null,
      notes: notes || null,
      updated_at: db.fn.now(),
    };

    // Upsert: update if exists for this vehicle+date, insert otherwise
    const existing = await db('vehicle_mileage_log')
      .where({ vehicle_id: vehicleId, log_date: logDate })
      .first();

    let result;
    if (existing) {
      [result] = await db('vehicle_mileage_log')
        .where('id', existing.id)
        .update(data)
        .returning('*');
    } else {
      data.created_at = db.fn.now();
      [result] = await db('vehicle_mileage_log')
        .insert(data)
        .returning('*');
    }

    // Update vehicle current_miles
    await db('equipment')
      .where('id', vehicleId)
      .update({ current_miles: odometerEnd, updated_at: db.fn.now() });

    logger.info(`${tag} Logged ${totalMiles} miles for ${vehicleId} on ${logDate}`);
    return result;
  } catch (err) {
    logger.error(`${tag} Error:`, err);
    throw err;
  }
}

// ─── Cost of Ownership ──────────────────────────────────────────
/**
 * Calculate total cost of ownership for an equipment item.
 */
async function costOfOwnership(equipmentId) {
  const tag = '[equipment-maintenance] costOfOwnership';
  try {
    const equipment = await db('equipment').where('id', equipmentId).first();
    if (!equipment) throw new Error('Equipment not found');

    // Total maintenance cost
    const maintenanceAgg = await db('maintenance_records')
      .where('equipment_id', equipmentId)
      .select(
        db.raw('COALESCE(SUM(total_cost), 0) as total_maintenance'),
        db.raw('COUNT(*) as record_count'),
        db.raw('COALESCE(SUM(downtime_hours), 0) as total_downtime_hours')
      )
      .first();

    // Fuel costs (vehicles only)
    const fuelAgg = await db('vehicle_mileage_log')
      .where('vehicle_id', equipmentId)
      .select(
        db.raw('COALESCE(SUM(fuel_cost), 0) as total_fuel'),
        db.raw('COALESCE(SUM(total_miles), 0) as total_miles'),
        db.raw('COALESCE(SUM(business_miles), 0) as total_business_miles'),
        db.raw('COALESCE(SUM(irs_deduction_amount), 0) as total_irs_deduction')
      )
      .first();

    const purchasePrice = parseFloat(equipment.purchase_price || 0);
    const totalMaintenance = parseFloat(maintenanceAgg.total_maintenance);
    const totalFuel = parseFloat(fuelAgg.total_fuel);
    const totalCost = purchasePrice + totalMaintenance + totalFuel;

    // Age in months
    const purchaseDate = equipment.purchase_date ? new Date(equipment.purchase_date) : new Date(equipment.created_at);
    const now = new Date();
    const ageMonths = Math.max(1, (now.getFullYear() - purchaseDate.getFullYear()) * 12 + (now.getMonth() - purchaseDate.getMonth()));
    const monthlyCost = Math.round((totalCost / ageMonths) * 100) / 100;

    const totalMiles = parseFloat(fuelAgg.total_miles);
    const costPerMile = totalMiles > 0 ? Math.round((totalCost / totalMiles) * 100) / 100 : null;

    return {
      equipment_id: equipmentId,
      equipment_name: equipment.name,
      asset_tag: equipment.asset_tag,
      category: equipment.category,
      purchase_price: purchasePrice,
      purchase_date: equipment.purchase_date,
      age_months: ageMonths,
      total_maintenance: totalMaintenance,
      maintenance_count: parseInt(maintenanceAgg.record_count),
      total_fuel: totalFuel,
      total_cost: totalCost,
      monthly_cost: monthlyCost,
      cost_per_mile: costPerMile,
      total_miles: totalMiles,
      total_business_miles: parseFloat(fuelAgg.total_business_miles),
      total_irs_deduction: parseFloat(fuelAgg.total_irs_deduction),
      total_downtime_hours: parseFloat(maintenanceAgg.total_downtime_hours),
      condition_rating: equipment.condition_rating,
      salvage_value: parseFloat(equipment.salvage_value || 0),
    };
  } catch (err) {
    logger.error(`${tag} Error:`, err);
    throw err;
  }
}

// ─── Generate Maintenance Alert ──────────────────────────────────
/**
 * Create a maintenance alert, deduplicating by schedule + type.
 */
async function generateMaintenanceAlert(schedule, isOverdue) {
  try {
    const alertType = isOverdue ? 'maintenance_overdue' : 'maintenance_due';
    const severity = isOverdue
      ? (schedule.priority === 'critical' ? 'critical' : 'high')
      : (schedule.priority === 'high' ? 'medium' : 'low');

    // Check for existing unresolved alert for this schedule
    const existing = await db('maintenance_alerts')
      .where('schedule_id', schedule.id)
      .where('alert_type', alertType)
      .whereIn('status', ['new', 'acknowledged'])
      .first();

    if (existing) return existing;

    const prefix = isOverdue ? 'OVERDUE' : 'DUE SOON';
    const title = `${prefix}: ${schedule.task_name} — ${schedule.equipment_name} ${schedule.asset_tag || ''}`.trim();

    let description = '';
    if (schedule.next_due_at) {
      const dueDate = new Date(schedule.next_due_at);
      description += `Due date: ${dueDate.toLocaleDateString()}. `;
    }
    if (schedule.next_due_miles) description += `Due at ${schedule.next_due_miles.toLocaleString()} miles. `;
    if (schedule.next_due_hours) description += `Due at ${schedule.next_due_hours} hours. `;
    if (schedule.estimated_cost) description += `Est. cost: $${schedule.estimated_cost}. `;

    const alert = {
      id: uuidv4(),
      equipment_id: schedule.equipment_id,
      schedule_id: schedule.id,
      alert_type: alertType,
      severity,
      title,
      description: description.trim(),
      status: 'new',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    };

    const [inserted] = await db('maintenance_alerts').insert(alert).returning('*');
    logger.info(`[equipment-maintenance] Alert created: ${title}`);
    return inserted;
  } catch (err) {
    logger.error('[equipment-maintenance] generateMaintenanceAlert error:', err);
    throw err;
  }
}

// ─── Fleet Overview ──────────────────────────────────────────────
/**
 * Get fleet health stats for the dashboard.
 */
async function getFleetOverview() {
  try {
    const totalAssets = await db('equipment')
      .whereNot('status', 'retired')
      .count('id as count')
      .first();

    const overdueSchedules = await db('maintenance_schedules')
      .where('is_overdue', true)
      .where('is_active', true)
      .count('id as count')
      .first();

    const now = new Date();
    const yearStart = `${now.getFullYear()}-01-01`;

    const ytdMaintenance = await db('maintenance_records')
      .where('performed_at', '>=', yearStart)
      .select(db.raw('COALESCE(SUM(total_cost), 0) as total'))
      .first();

    const ytdMileage = await db('vehicle_mileage_log')
      .where('log_date', '>=', yearStart)
      .select(
        db.raw('COALESCE(SUM(total_miles), 0) as total_miles'),
        db.raw('COALESCE(SUM(business_miles), 0) as business_miles'),
        db.raw('COALESCE(SUM(fuel_cost), 0) as total_fuel'),
        db.raw('COALESCE(SUM(fuel_gallons), 0) as total_gallons'),
        db.raw('COALESCE(SUM(irs_deduction_amount), 0) as total_irs_deduction')
      )
      .first();

    const activeDowntime = await db('equipment_downtime_log')
      .whereNull('ended_at')
      .count('id as count')
      .first();

    const alerts = await db('maintenance_alerts')
      .where('status', 'new')
      .count('id as count')
      .first();

    const lowCondition = await db('equipment')
      .where('condition_rating', '<=', 5)
      .whereNot('status', 'retired')
      .count('id as count')
      .first();

    return {
      total_assets: parseInt(totalAssets.count),
      overdue_maintenance: parseInt(overdueSchedules.count),
      ytd_maintenance_spend: parseFloat(ytdMaintenance.total),
      ytd_total_miles: parseFloat(ytdMileage.total_miles),
      ytd_business_miles: parseFloat(ytdMileage.business_miles),
      ytd_fuel_cost: parseFloat(ytdMileage.total_fuel),
      ytd_fuel_gallons: parseFloat(ytdMileage.total_gallons),
      ytd_irs_deduction: parseFloat(ytdMileage.total_irs_deduction),
      active_downtime: parseInt(activeDowntime.count),
      open_alerts: parseInt(alerts.count),
      low_condition_count: parseInt(lowCondition.count),
    };
  } catch (err) {
    logger.error('[equipment-maintenance] getFleetOverview error:', err);
    throw err;
  }
}

// ─── Report Equipment Issue (Tech PWA) ───────────────────────────
/**
 * Technician reports an equipment issue from the field.
 */
async function reportEquipmentIssue({ equipmentId, technicianId, description, severity = 'medium' }) {
  const tag = '[equipment-maintenance] reportEquipmentIssue';
  try {
    const equipment = await db('equipment').where('id', equipmentId).first();
    if (!equipment) throw new Error('Equipment not found');

    let techName = 'Unknown Tech';
    if (technicianId) {
      const tech = await db('technicians').where('id', technicianId).first();
      if (tech) techName = tech.name;
    }

    const alert = {
      id: uuidv4(),
      equipment_id: equipmentId,
      alert_type: 'condition_low',
      severity,
      title: `Issue Reported: ${equipment.name} ${equipment.asset_tag || ''} — by ${techName}`.trim(),
      description: description || 'Equipment issue reported from the field.',
      status: 'new',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    };

    const [inserted] = await db('maintenance_alerts').insert(alert).returning('*');

    // Lower condition rating if severity is high/critical
    if (severity === 'high' || severity === 'critical') {
      const newRating = Math.max(1, (equipment.condition_rating || 5) - 2);
      await db('equipment').where('id', equipmentId).update({
        condition_rating: newRating,
        updated_at: db.fn.now(),
      });
    }

    logger.info(`${tag} Issue reported on ${equipment.name} by ${techName}: ${description}`);
    return inserted;
  } catch (err) {
    logger.error(`${tag} Error:`, err);
    throw err;
  }
}

// ─── Check Warranty Expirations ──────────────────────────────────
/**
 * Check for warranties expiring within 30 days. Called weekly.
 */
async function checkWarrantyExpirations() {
  const tag = '[equipment-maintenance] checkWarrantyExpirations';
  try {
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    const today = new Date().toISOString().split('T')[0];
    const futureDate = thirtyDaysFromNow.toISOString().split('T')[0];

    const expiringWarranties = await db('equipment')
      .whereNotNull('warranty_expiration')
      .where('warranty_expiration', '>=', today)
      .where('warranty_expiration', '<=', futureDate)
      .whereNot('status', 'retired');

    let alertCount = 0;
    for (const eq of expiringWarranties) {
      // Deduplicate
      const existing = await db('maintenance_alerts')
        .where('equipment_id', eq.id)
        .where('alert_type', 'warranty_expiring')
        .whereIn('status', ['new', 'acknowledged'])
        .first();

      if (existing) continue;

      await db('maintenance_alerts').insert({
        id: uuidv4(),
        equipment_id: eq.id,
        alert_type: 'warranty_expiring',
        severity: 'medium',
        title: `Warranty Expiring: ${eq.name} ${eq.asset_tag || ''} — ${new Date(eq.warranty_expiration).toLocaleDateString()}`.trim(),
        description: `Warranty expires on ${new Date(eq.warranty_expiration).toLocaleDateString()}. ${eq.warranty_details || ''}`.trim(),
        status: 'new',
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      });
      alertCount++;
    }

    logger.info(`${tag} ${alertCount} warranty expiration alerts generated`);
    return { alertCount };
  } catch (err) {
    logger.error(`${tag} Error:`, err);
    throw err;
  }
}

module.exports = {
  checkMaintenanceDue,
  recordMaintenance,
  logMileage,
  costOfOwnership,
  generateMaintenanceAlert,
  getFleetOverview,
  reportEquipmentIssue,
  checkWarrantyExpirations,
};
