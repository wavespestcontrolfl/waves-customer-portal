const cron = require('node-cron');
const db = require('../models/db');
const TwilioService = require('./twilio');
const SquareService = require('./square');
const logger = require('./logger');

function initScheduledJobs() {
  // =========================================================================
  // DAILY 8AM — Send service reminders for tomorrow's appointments
  // =========================================================================
  cron.schedule('0 8 * * *', async () => {
    logger.info('Running: service reminder job');
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const upcoming = await db('scheduled_services')
        .where({ scheduled_date: tomorrowStr })
        .whereIn('status', ['pending', 'confirmed'])
        .select('id', 'customer_id');

      for (const svc of upcoming) {
        try {
          await TwilioService.sendServiceReminder(svc.customer_id, svc.id);
        } catch (err) {
          logger.error(`Reminder failed for service ${svc.id}: ${err.message}`);
        }
      }

      logger.info(`Service reminders sent: ${upcoming.length}`);
    } catch (err) {
      logger.error(`Service reminder job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // 1ST OF MONTH 6AM — Process monthly autopay charges
  // =========================================================================
  cron.schedule('0 6 1 * *', async () => {
    logger.info('Running: monthly billing job');
    try {
      const activeCustomers = await db('customers')
        .where({ active: true })
        .whereNotNull('monthly_rate')
        .where('monthly_rate', '>', 0)
        .select('id', 'first_name', 'last_name', 'waveguard_tier');

      let successCount = 0;
      let failCount = 0;

      for (const customer of activeCustomers) {
        try {
          await SquareService.chargeMonthly(customer.id);
          successCount++;
        } catch (err) {
          failCount++;
          logger.error(`Monthly charge failed for ${customer.first_name} ${customer.last_name}: ${err.message}`);
          // TODO: Send failed payment notification, retry logic
        }
      }

      logger.info(`Monthly billing complete: ${successCount} succeeded, ${failCount} failed`);
    } catch (err) {
      logger.error(`Monthly billing job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  // =========================================================================
  // 28TH OF MONTH 10AM — Send billing reminders (for customers who opted in)
  // =========================================================================
  cron.schedule('0 10 28 * *', async () => {
    logger.info('Running: billing reminder job');
    try {
      const customers = await db('customers')
        .join('notification_prefs', 'customers.id', 'notification_prefs.customer_id')
        .where({ 'customers.active': true, 'notification_prefs.billing_reminder': true })
        .whereNotNull('customers.monthly_rate')
        .select('customers.id', 'customers.monthly_rate', 'customers.first_name');

      for (const cust of customers) {
        const nextMonth = new Date();
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        const chargeDate = `${nextMonth.toLocaleDateString('en-US', { month: 'long' })} 1`;

        try {
          await TwilioService.sendBillingReminder(cust.id, cust.monthly_rate, chargeDate);
        } catch (err) {
          logger.error(`Billing reminder failed for ${cust.id}: ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Billing reminder job failed: ${err.message}`);
    }
  }, { timezone: 'America/New_York' });

  logger.info('Scheduled jobs initialized');
}

module.exports = { initScheduledJobs };
