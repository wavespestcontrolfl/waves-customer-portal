/**
 * GA4 Cron Jobs
 *
 * Daily sync of GA4 analytics data into the local database.
 * Call initGA4Crons() from the main scheduler or startup.
 */

const cron = require('node-cron');
const logger = require('../logger');
const GA4 = require('./google-analytics');

/**
 * Initialize GA4 cron jobs.
 * - Daily at 6:30 AM ET: sync last 3 days of GA4 data.
 */
function initGA4Crons() {
  // 6:30 AM ET = 10:30 UTC (EST) or 11:30 UTC (EDT)
  // Use America/New_York timezone
  cron.schedule('30 6 * * *', async () => {
    logger.info('[GA4 Cron] Starting daily GA4 data sync (last 3 days)');
    try {
      const result = await GA4.syncDailyData(3);
      if (result.synced) {
        logger.info(`[GA4 Cron] Sync complete: ${result.rows || 0} rows, period ${result.period?.start} to ${result.period?.end}`);
      } else {
        logger.warn(`[GA4 Cron] Sync skipped: ${result.error || 'not configured'}`);
      }
    } catch (err) {
      logger.error(`[GA4 Cron] Sync failed: ${err.message}`);
    }
  }, {
    timezone: 'America/New_York',
  });

  logger.info('[GA4 Cron] Scheduled: daily GA4 sync at 6:30 AM ET');
}

module.exports = { initGA4Crons };
