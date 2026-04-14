/**
 * Bouncie Mileage Cron Jobs
 *
 * Scheduled tasks for mileage sync, summary computation, and job re-matching.
 * Uses node-cron with America/New_York timezone.
 */

const cron = require('node-cron');
const db = require('../models/db');
const logger = require('./logger');
const mileageService = require('./bouncie-mileage');

/**
 * Initialize all Bouncie mileage cron jobs.
 * Call once at server startup.
 */
function initBouncieMileageCrons() {
  logger.info('[bouncie-crons] Initializing Bouncie mileage cron jobs');

  // ── Daily 1:00 AM ET — Sync yesterday's trips + compute daily summary ──
  cron.schedule('0 1 * * *', async () => {
    logger.info('[bouncie-crons] Daily sync started');

    try {
      // Calculate yesterday's date
      const now = new Date();
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().split('T')[0];

      // Sync from Bouncie API using existing bouncie service
      let syncResult = null;
      try {
        const BouncieService = require('./bouncie');
        const bouncie = BouncieService.default || BouncieService;
        const instance = typeof bouncie === 'function' ? new bouncie() : bouncie;

        if (instance && typeof instance.syncMileage === 'function') {
          syncResult = await instance.syncMileage(dateStr, dateStr);
          logger.info(`[bouncie-crons] Sync result: ${JSON.stringify(syncResult)}`);
        }
      } catch (syncErr) {
        logger.error(`[bouncie-crons] Bouncie sync error: ${syncErr.message}`);
      }

      // Compute daily summaries for all vehicles that had trips yesterday
      const vehiclesWithTrips = await db('mileage_log')
        .where('trip_date', dateStr)
        .whereNotNull('equipment_id')
        .distinct('equipment_id')
        .pluck('equipment_id');

      for (const equipmentId of vehiclesWithTrips) {
        try {
          await mileageService.computeDailySummary(equipmentId, dateStr);
        } catch (err) {
          logger.error(`[bouncie-crons] Daily summary failed for ${equipmentId}: ${err.message}`);
        }
      }

      logger.info(`[bouncie-crons] Daily sync complete: ${vehiclesWithTrips.length} vehicle(s) summarized`);
    } catch (err) {
      logger.error(`[bouncie-crons] Daily sync error: ${err.message}`);
    }
  }, {
    timezone: 'America/New_York',
  });

  // ── Monthly 1st at 2:00 AM ET — Compute previous month's monthly summary ──
  cron.schedule('0 2 1 * *', async () => {
    logger.info('[bouncie-crons] Monthly summary started');

    try {
      // Previous month
      const now = new Date();
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const monthStr = prevMonth.toISOString().split('T')[0];

      // Find all equipment that had daily summaries last month
      const nextMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const nextMonthStr = nextMonth.toISOString().split('T')[0];

      const equipmentIds = await db('mileage_daily_summary')
        .where('summary_date', '>=', monthStr)
        .where('summary_date', '<', nextMonthStr)
        .distinct('equipment_id')
        .pluck('equipment_id');

      for (const equipmentId of equipmentIds) {
        try {
          await mileageService.computeMonthlySummary(equipmentId, monthStr);
        } catch (err) {
          logger.error(`[bouncie-crons] Monthly summary failed for ${equipmentId}: ${err.message}`);
        }
      }

      logger.info(`[bouncie-crons] Monthly summary complete: ${equipmentIds.length} vehicle(s)`);
    } catch (err) {
      logger.error(`[bouncie-crons] Monthly summary error: ${err.message}`);
    }
  }, {
    timezone: 'America/New_York',
  });

  // ── Weekly Sunday 3:00 AM ET — Re-attempt job matching on unmatched trips ──
  cron.schedule('0 3 * * 0', async () => {
    logger.info('[bouncie-crons] Weekly job re-matching started');

    try {
      // Find trips from the past 7 days with no customer match
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const startDate = sevenDaysAgo.toISOString().split('T')[0];

      const unmatchedTrips = await db('mileage_log')
        .whereNull('customer_id')
        .where('trip_date', '>=', startDate)
        .whereNotNull('end_lat')
        .whereNotNull('end_lng');

      let matched = 0;

      for (const trip of unmatchedTrips) {
        try {
          const tripDate = !trip.trip_date
            ? new Date().toISOString().split('T')[0]
            : typeof trip.trip_date === 'string'
              ? trip.trip_date
              : trip.trip_date.toISOString().split('T')[0];

          const jobMatch = await mileageService.matchTripToJob(
            parseFloat(trip.end_lat),
            parseFloat(trip.end_lng),
            tripDate
          );

          if (jobMatch) {
            await db('mileage_log')
              .where('id', trip.id)
              .update({
                customer_id: jobMatch.customer_id,
                job_id: jobMatch.job_id,
                is_business: true,
                classification_notes: `Re-matched: ${jobMatch.customer_name} (${jobMatch.distance_m}m, weekly cron)`,
                deduction_amount: parseFloat(trip.distance_miles) * mileageService.getIrsRate(new Date(tripDate).getFullYear()),
                updated_at: db.fn.now(),
              });
            matched++;
          }
        } catch (err) {
          logger.error(`[bouncie-crons] Re-match failed for trip ${trip.id}: ${err.message}`);
        }
      }

      // Recompute daily summaries for affected dates
      if (matched > 0) {
        const affectedDates = await db('mileage_log')
          .where('trip_date', '>=', startDate)
          .whereNotNull('equipment_id')
          .distinct('equipment_id', 'trip_date');

        for (const row of affectedDates) {
          try {
            const dateStr = typeof row.trip_date === 'string'
              ? row.trip_date
              : row.trip_date.toISOString().split('T')[0];
            await mileageService.computeDailySummary(row.equipment_id, dateStr);
          } catch (_) {}
        }
      }

      logger.info(`[bouncie-crons] Weekly re-matching complete: ${matched}/${unmatchedTrips.length} trips matched`);
    } catch (err) {
      logger.error(`[bouncie-crons] Weekly re-matching error: ${err.message}`);
    }
  }, {
    timezone: 'America/New_York',
  });

  logger.info('[bouncie-crons] All Bouncie mileage crons registered');
}

module.exports = { initBouncieMileageCrons };
