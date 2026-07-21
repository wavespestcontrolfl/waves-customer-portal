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
const { etDateString } = require('../utils/datetime-et');

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
        .whereNotNull('end_lng')
        // Never overwrite an operator's explicit classification. BOTH operator
        // methods are excluded: 'manual_review' (Tax Center) and 'manual' (the
        // admin-mileage reclassify route) — a hand-confirmed trip with no
        // customer must not be re-stamped as a job_match_suggested.
        .whereNotIn('classification_method', ['manual', 'manual_review'])
        .whereNot('purpose', 'personal');

      let matched = 0;

      for (const trip of unmatchedTrips) {
        try {
          const tripDate = !trip.trip_date
            ? etDateString()
            : typeof trip.trip_date === 'string'
              ? trip.trip_date
              : trip.trip_date.toISOString().split('T')[0];

          const jobMatch = await mileageService.matchTripToJob(
            parseFloat(trip.end_lat),
            parseFloat(trip.end_lng),
            tripDate
          );

          if (jobMatch) {
            // Attach the job context so the operator can review with it, but
            // do NOT auto-classify as business or write a deduction — a
            // proximity match is a SUGGESTION, not substantiation. The trip
            // stays unclassified at $0 until confirmed in the Tax Center
            // mileage review (PR #2931). Auto-deducting on a geographic match
            // turned false matches into tax deductions without review.
            // Re-assert the same guards as the load query IN the UPDATE — an
            // operator could classify this trip while matchTripToJob ran, and
            // an id-only update would overwrite their manual review with an
            // automated suggestion. A zero-row update means someone got there
            // first; don't count it.
            const changed = await db('mileage_log')
              .where('id', trip.id)
              .whereNull('customer_id')
              .whereNotIn('classification_method', ['manual', 'manual_review'])
              .whereNot('purpose', 'personal')
              .update({
                customer_id: jobMatch.customer_id,
                job_id: jobMatch.job_id,
                classification_method: 'job_match_suggested',
                classification_notes: `Suggested business — re-matched: ${jobMatch.customer_name} (${jobMatch.distance_m}m, weekly cron). Confirm in Tax Center.`,
                updated_at: db.fn.now(),
              });
            if (changed) matched++;
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
