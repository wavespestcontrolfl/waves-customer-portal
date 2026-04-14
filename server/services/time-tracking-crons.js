const cron = require('node-cron');
const db = require('../models/db');
const logger = require('./logger');
const timeTracking = require('./time-tracking');
const TwilioService = require('./twilio');

/**
 * Initialize all time-tracking cron jobs.
 * Call this from your main scheduler / index.js setup.
 */
function initTimeTrackingCrons() {
  // -------------------------------------------------------------------------
  // 1. Midnight ET — compute daily summaries for the previous day
  // -------------------------------------------------------------------------
  cron.schedule('0 0 * * *', async () => {
    logger.info('[time-tracking-cron] Running nightly daily summary computation');
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().split('T')[0];

      const techs = await db('technicians').where({ active: true }).select('id', 'name');
      let computed = 0;

      for (const tech of techs) {
        try {
          // Check if there were any entries that day
          const hasEntries = await db('time_entries')
            .where({ technician_id: tech.id })
            .where('status', '!=', 'voided')
            .whereRaw("DATE(clock_in) = ?", [dateStr])
            .first();

          if (hasEntries) {
            await timeTracking.computeDailySummary(tech.id, dateStr);
            computed++;
          }
        } catch (err) {
          logger.error(`[time-tracking-cron] Daily summary failed for tech ${tech.name}`, { error: err.message });
        }
      }

      logger.info(`[time-tracking-cron] Daily summaries computed: ${computed} techs for ${dateStr}`);
    } catch (err) {
      logger.error('[time-tracking-cron] Nightly daily summary job failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  // -------------------------------------------------------------------------
  // 2. Monday 1 AM ET — compute weekly summaries for the previous week
  // -------------------------------------------------------------------------
  cron.schedule('0 1 * * 1', async () => {
    logger.info('[time-tracking-cron] Running weekly summary computation');
    try {
      // Previous week's Monday
      const lastMonday = new Date();
      lastMonday.setDate(lastMonday.getDate() - 7);
      // Ensure we land on Monday
      const day = lastMonday.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      lastMonday.setDate(lastMonday.getDate() + diff);
      const weekStartStr = lastMonday.toISOString().split('T')[0];

      const techs = await db('technicians').where({ active: true }).select('id', 'name');
      let computed = 0;

      for (const tech of techs) {
        try {
          const hasDailies = await db('time_entry_daily_summary')
            .where({ technician_id: tech.id })
            .where('work_date', '>=', weekStartStr)
            .where('work_date', '<=', new Date(lastMonday.getTime() + 6 * 86400000).toISOString().split('T')[0])
            .first();

          if (hasDailies) {
            await timeTracking.computeWeeklySummary(tech.id, weekStartStr);
            computed++;
          }
        } catch (err) {
          logger.error(`[time-tracking-cron] Weekly summary failed for tech ${tech.name}`, { error: err.message });
        }
      }

      logger.info(`[time-tracking-cron] Weekly summaries computed: ${computed} techs for week of ${weekStartStr}`);
    } catch (err) {
      logger.error('[time-tracking-cron] Weekly summary job failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  // -------------------------------------------------------------------------
  // 3. 9 PM ET — reminder to clock out (SMS via TwilioService)
  // -------------------------------------------------------------------------
  cron.schedule('0 21 * * *', async () => {
    logger.info('[time-tracking-cron] Running 9 PM clock-out reminder check');
    try {
      const activeShifts = await db('time_entries')
        .where({ entry_type: 'shift', status: 'active' })
        .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
        .select('time_entries.*', 'technicians.name as tech_name', 'technicians.phone as tech_phone');

      for (const shift of activeShifts) {
        const hoursIn = (Date.now() - new Date(shift.clock_in).getTime()) / 3600000;
        if (hoursIn >= 8 && shift.tech_phone) {
          try {
            await TwilioService.sendSMS(shift.tech_phone,
              `Hey ${shift.tech_name}, you've been clocked in for ${Math.round(hoursIn)} hours. ` +
              `Don't forget to clock out when you're done! Your shift will auto-close at 11 PM if still active.`
            );
            logger.info(`[time-tracking-cron] Sent clock-out reminder to ${shift.tech_name}`);
          } catch (smsErr) {
            logger.error(`[time-tracking-cron] Failed to send reminder SMS to ${shift.tech_name}`, { error: smsErr.message });
          }
        }
      }
    } catch (err) {
      logger.error('[time-tracking-cron] 9 PM reminder job failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  // -------------------------------------------------------------------------
  // 4. 11 PM ET — force auto-clock-out for anyone still clocked in
  // -------------------------------------------------------------------------
  cron.schedule('0 23 * * *', async () => {
    logger.info('[time-tracking-cron] Running 11 PM force auto-clock-out');
    try {
      const activeShifts = await db('time_entries')
        .where({ entry_type: 'shift', status: 'active' })
        .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
        .select('time_entries.*', 'technicians.name as tech_name', 'technicians.phone as tech_phone');

      for (const shift of activeShifts) {
        try {
          const now = new Date();

          // Close sub-entries
          await db('time_entries')
            .where({ technician_id: shift.technician_id, status: 'active' })
            .whereIn('entry_type', ['job', 'break', 'drive', 'admin_time'])
            .update({
              status: 'completed',
              clock_out: now,
              duration_minutes: db.raw("CASE WHEN clock_in IS NOT NULL THEN EXTRACT(EPOCH FROM (? - clock_in)) / 60 ELSE 0 END", [now]),
              notes: db.raw("COALESCE(notes, '') || ' [auto-closed 11PM]'"),
              updated_at: now,
            });

          // Close shift
          const duration = (now - new Date(shift.clock_in)) / 60000;
          await db('time_entries')
            .where({ id: shift.id })
            .update({
              status: 'completed',
              clock_out: now,
              duration_minutes: Math.round(duration * 100) / 100,
              notes: (shift.notes ? shift.notes + '; ' : '') + 'AUTO CLOCK-OUT: 11 PM cron',
              updated_at: now,
            });

          const workDate = new Date(shift.clock_in).toISOString().split('T')[0];
          await timeTracking.computeDailySummary(shift.technician_id, workDate);

          // Notify tech
          if (shift.tech_phone) {
            try {
              await TwilioService.sendSMS(shift.tech_phone,
                `Hi ${shift.tech_name}, your shift has been automatically closed at 11 PM. ` +
                `Total: ${(duration / 60).toFixed(1)} hours. If this is incorrect, contact admin.`
              );
            } catch (smsErr) {
              logger.error(`[time-tracking-cron] Failed to send auto-close SMS`, { error: smsErr.message });
            }
          }

          logger.info(`[time-tracking-cron] Force clocked out ${shift.tech_name}`, { duration: Math.round(duration) });
        } catch (entryErr) {
          logger.error(`[time-tracking-cron] Failed to force clock-out shift ${shift.id}`, { error: entryErr.message });
        }
      }
    } catch (err) {
      logger.error('[time-tracking-cron] 11 PM force clock-out job failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  logger.info('[time-tracking-cron] All time tracking cron jobs initialized');
}

module.exports = { initTimeTrackingCrons };
