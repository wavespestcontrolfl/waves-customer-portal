const cron = require('../utils/scheduled-cron');
const db = require('../models/db');
const logger = require('./logger');
const timeTracking = require('./time-tracking');
const timesheetBells = require('./timesheet-approval-bells');
const TwilioService = require('./twilio');
const {
  STAFF_WORK_DATE_SQL,
  addStaffWorkDays,
  staffWeekRange,
  staffWeekStartForWorkDate,
  staffWorkDate,
} = require('../utils/staff-time-work-date');
const { runExclusive } = require('../utils/cron-lock');
const { shiftCloseReviewLive } = require('../config/feature-gates');
const { usableCell } = require('./tech-line');
const { etDateString, formatETTime } = require('../utils/datetime-et');

const REMINDER_CARD_TYPE = 'tech_clock_out_reminder';
const AUTO_CLOSE_CARD_TYPE = 'tech_auto_clock_out';

// Log tag for a caught error: never err.message, which can carry a recipient
// number or the message body.
function errTag(err) {
  return err?.code || err?.name || 'error';
}

/**
 * One staff notice for a technician (GATE_SHIFT_CLOSE_REVIEW on), the same
 * routing as the 7 PM open-visit nudge (tech-open-visit-nudge.js): the owner
 * gets an internal text on their own cell (technicians.phone is the office
 * line, so it goes to ADAM_PHONE); every other technician gets a Today card
 * kept until "Got it" plus a best-effort push, and no SMS, because sendSMS
 * writes a customer-inbox thread for any number that is not an owner phone.
 * The card row carries a unique dedupe_key, so a re-run never doubles it.
 * Returns true when something was delivered.
 */
async function sendStaffNotice(tech, { type, dedupeKey, headline, message, payload = {} }) {
  if (tech.phone && TwilioService.isKnownOwnerPhone(tech.phone)) {
    const cell = usableCell(tech) || usableCell({ id: tech.id, phone: process.env.ADAM_PHONE });
    if (!cell) return false;
    await TwilioService.sendSMS(cell, message, { messageType: 'internal_alert', allowOwnerSms: true });
    return true;
  }
  const inserted = await db('tech_notifications')
    .insert({
      technician_id: tech.id,
      type,
      dedupe_key: dedupeKey,
      message,
      payload: JSON.stringify({ headline, ...payload }),
    })
    .onConflict('dedupe_key')
    .ignore()
    .returning('id');
  if (!inserted.length) return false;
  try {
    const PushService = require('./push-notifications');
    await PushService.sendToAdminUser(tech.id, {
      title: headline,
      body: 'Open Today for details.',
      url: '/tech',
      tag: dedupeKey,
    });
  } catch (err) {
    logger.warn(`[time-tracking-cron] push failed for ${tech.id} (card already written): ${errTag(err)}`);
  }
  return true;
}

// The 9 PM reminder with GATE_SHIFT_CLOSE_REVIEW on: owner text or Today card.
async function remindToClockOut(shift, hoursIn) {
  if (hoursIn < 8) return;
  try {
    const delivered = await sendStaffNotice(
      { id: shift.technician_id, name: shift.tech_name, phone: shift.tech_phone },
      {
        type: REMINDER_CARD_TYPE,
        dedupeKey: `${REMINDER_CARD_TYPE}:${shift.technician_id}:${etDateString(new Date())}`,
        headline: 'Clock out when you are done',
        message: `Hey ${shift.tech_name}, you've been clocked in for ${Math.round(hoursIn)} hours. ` +
          `Don't forget to clock out when you're done! Your shift will auto-close at 11 PM if still active.`,
      },
    );
    if (delivered) logger.info(`[time-tracking-cron] Sent clock-out reminder to technician ${shift.technician_id}`);
  } catch (noticeErr) {
    logger.error(`[time-tracking-cron] Failed to send reminder to technician ${shift.technician_id}: ${errTag(noticeErr)}`);
  }
}

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
      const dateStr = addStaffWorkDays(staffWorkDate(new Date()), -1);

      const techs = await db('technicians').where({ active: true }).select('id', 'name');
      let computed = 0;

      for (const tech of techs) {
        try {
          // Check if there were any entries that day
          const hasEntries = await db('time_entries')
            .where({ technician_id: tech.id })
            .where('status', '!=', 'voided')
            .whereRaw(`${STAFF_WORK_DATE_SQL} = ?::date`, [dateStr])
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
  // 2. Monday 5 AM ET — compute weekly summaries + raise the approval bell
  // -------------------------------------------------------------------------
  cron.schedule('0 5 * * 1', async () => {
    logger.info('[time-tracking-cron] Running weekly summary + approval bell');
    try {
      // Previous week's Monday (ET calendar)
      const previousWeekDate = addStaffWorkDays(staffWorkDate(new Date()), -7);
      const weekStartStr = staffWeekStartForWorkDate(previousWeekDate);
      const { end: weekEndStr } = staffWeekRange(weekStartStr);

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

      // One admin bell while any week waits for approval; none (and an open one closes) when none does.
      if (pendingCount > 0) {
        await timesheetBells.raiseWeekBell(weekStartStr, pendingCount);
      } else {
        await timesheetBells.closeWeekBell(weekStartStr);
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
      await runExclusive('time-tracking-9pm-reminder', async () => {
      const activeShifts = await db('time_entries')
        .where({ entry_type: 'shift', status: 'active' })
        .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
        .select('time_entries.*', 'technicians.name as tech_name', 'technicians.phone as tech_phone');

      for (const shift of activeShifts) {
        const hoursIn = (Date.now() - new Date(shift.clock_in).getTime()) / 3600000;
        if (shiftCloseReviewLive()) {
          await remindToClockOut(shift, hoursIn);
          continue;
        }
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
      });
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
      await runExclusive('time-tracking-11pm-autoclose', async () => {
      const activeShifts = await db('time_entries')
        .where({ entry_type: 'shift', status: 'active' })
        .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
        .select('time_entries.*', 'technicians.name as tech_name', 'technicians.phone as tech_phone');

      for (const shift of activeShifts) {
        try {
          const closed = await timeTracking.closeActiveShiftAtomically(shift.technician_id, {
            shiftId: shift.id,
            childNoteSuffix: ' [auto-closed 11PM]',
            shiftNote: 'AUTO CLOCK-OUT: 11 PM cron',
            autoCloseReason: 'cron_11pm',
          });
          if (!closed) continue;

          await timeTracking.computeDailySummary(shift.technician_id, closed.workDate);

          // Notify tech
          if (closed.autoClosed) {
            // Gate on: the close was marked for review, and the notice goes
            // to the staff channel (owner text or Today card), not a customer thread.
            const hours = (closed.duration / 60).toFixed(1);
            const message = closed.trimmed
              ? `Hi ${shift.tech_name}, you were still clocked in at 11 PM, so your shift was closed automatically at ` +
                `${formatETTime(new Date(closed.closedAt))}, your last recorded activity. Total: ${hours} hours. ` +
                `The office will review it. If this is incorrect, contact admin.`
              : `Hi ${shift.tech_name}, your shift has been automatically closed at 11 PM. ` +
                `Total: ${hours} hours. The office will review it. If this is incorrect, contact admin.`;
            try {
              await sendStaffNotice(
                { id: shift.technician_id, name: shift.tech_name, phone: shift.tech_phone },
                {
                  type: AUTO_CLOSE_CARD_TYPE,
                  dedupeKey: `${AUTO_CLOSE_CARD_TYPE}:${shift.id}`,
                  headline: 'Your shift was closed automatically',
                  message,
                  payload: { shift_id: shift.id, hours },
                },
              );
            } catch (noticeErr) {
              logger.error(`[time-tracking-cron] Failed to send auto-close notice: ${errTag(noticeErr)}`);
            }
          } else if (shift.tech_phone) {
            try {
              await TwilioService.sendSMS(shift.tech_phone,
                `Hi ${shift.tech_name}, your shift has been automatically closed at 11 PM. ` +
                `Total: ${(closed.duration / 60).toFixed(1)} hours. If this is incorrect, contact admin.`
              );
            } catch (smsErr) {
              logger.error(`[time-tracking-cron] Failed to send auto-close SMS`, { error: smsErr.message });
            }
          }

          logger.info(`[time-tracking-cron] Force clocked out ${shift.tech_name}`, {
            duration: Math.round(closed.duration),
          });
        } catch (entryErr) {
          logger.error(`[time-tracking-cron] Failed to force clock-out shift ${shift.id}`, { error: entryErr.message });
        }
      }
      });
    } catch (err) {
      logger.error('[time-tracking-cron] 11 PM force clock-out job failed', { error: err.message });
    }
  }, { timezone: 'America/New_York' });

  logger.info('[time-tracking-cron] All time tracking cron jobs initialized');
}

module.exports = { initTimeTrackingCrons };
