const cron = require('node-cron');
const db = require('../models/db');
const logger = require('./logger');
const timeTracking = require('./time-tracking');
const TwilioService = require('./twilio');
const { etDateString, etWeekStart, addETDays, parseETDateTime } = require('../utils/datetime-et');

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
      const dateStr = etDateString(addETDays(new Date(), -1));

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
  // 2. Monday 5 AM ET — compute weekly summaries + SMS Virginia for approval
  // -------------------------------------------------------------------------
  cron.schedule('0 5 * * 1', async () => {
    logger.info('[time-tracking-cron] Running weekly summary + approval SMS');
    try {
      // Previous week's Monday (ET calendar)
      const weekStartStr = etWeekStart(addETDays(new Date(), -7));
      const weekEndStr = etDateString(addETDays(parseETDateTime(weekStartStr + 'T12:00'), 6));

      const techs = await db('technicians').where({ active: true }).select('id', 'name');
      let computed = 0;
      let pendingCount = 0;

      for (const tech of techs) {
        try {
          const hasDailies = await db('time_entry_daily_summary')
            .where({ technician_id: tech.id })
            .where('work_date', '>=', weekStartStr)
            .where('work_date', '<=', weekEndStr)
            .first();

          if (hasDailies) {
            const weekly = await timeTracking.computeWeeklySummary(tech.id, weekStartStr);
            computed++;
            if (weekly && weekly.status !== 'approved') pendingCount++;
          }
        } catch (err) {
          logger.error(`[time-tracking-cron] Weekly summary failed for tech ${tech.name}`, { error: err.message });
        }
      }

      logger.info(`[time-tracking-cron] Weekly summaries computed: ${computed} techs for week of ${weekStartStr}`);

      // SMS Virginia if there are weeks awaiting approval
      if (pendingCount > 0) {
        const WAVES_OFFICE_PHONE = process.env.WAVES_OFFICE_PHONE || '+19413187612';
        const portalBase = process.env.PORTAL_BASE_URL || 'https://portal.wavespestcontrol.com';
        const link = `${portalBase}/admin/timetracking?tab=approvals&weekStart=${weekStartStr}`;
        try {
          await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
            `📋 ${pendingCount} tech timesheet${pendingCount === 1 ? '' : 's'} ready to approve for week of ${weekStartStr}. Review: ${link}`
          );
          logger.info(`[time-tracking-cron] Approval SMS sent to Virginia (${pendingCount} pending)`);
        } catch (smsErr) {
          logger.error('[time-tracking-cron] Approval SMS failed', { error: smsErr.message });
        }
      }
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

          const workDate = etDateString(new Date(shift.clock_in));
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
