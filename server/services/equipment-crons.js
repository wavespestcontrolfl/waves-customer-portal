/**
 * Equipment Maintenance Cron Jobs
 *
 * Nightly maintenance checks and weekly warranty expiration alerts.
 * Call initEquipmentCrons() from your main scheduler or index.js.
 */
const cron = require('node-cron');
const logger = require('./logger');
const equipmentService = require('./equipment-maintenance');

function initEquipmentCrons() {
  // ─── Nightly 3:00 AM ET — Check maintenance due/overdue ──────
  cron.schedule('0 3 * * *', async () => {
    logger.info('[equipment-cron] Running nightly maintenance check');
    try {
      const result = await equipmentService.checkMaintenanceDue();
      logger.info(`[equipment-cron] Nightly check complete: ${result.overdueCount} overdue, ${result.dueSoonCount} due soon, ${result.followUpCount} follow-ups`);
    } catch (err) {
      logger.error('[equipment-cron] Nightly maintenance check failed:', err);
    }
  }, { timezone: 'America/New_York' });

  // ─── Weekly Monday 5:00 AM ET — Warranty expiration check ────
  cron.schedule('0 5 * * 1', async () => {
    logger.info('[equipment-cron] Running weekly warranty expiration check');
    try {
      const result = await equipmentService.checkWarrantyExpirations();
      logger.info(`[equipment-cron] Warranty check complete: ${result.alertCount} alerts generated`);
    } catch (err) {
      logger.error('[equipment-cron] Warranty expiration check failed:', err);
    }
  }, { timezone: 'America/New_York' });

  logger.info('[equipment-cron] Equipment maintenance crons initialized (3 AM nightly, 5 AM Monday warranty)');
}

module.exports = { initEquipmentCrons };
