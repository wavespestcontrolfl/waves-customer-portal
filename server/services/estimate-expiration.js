/**
 * Estimate expiration worker (Estimates v2 spec §5).
 *
 * Runs daily at 6am ET via scheduler.js. Flips any `sent` or `viewed`
 * estimate older than `ESTIMATE_EXPIRATION_DAYS` (default 7) to `expired`,
 * and also flips anything whose `expires_at` has passed regardless of
 * inactivity. Writes `declined_at = now()` only when the row also moves
 * to expired via the age rule (so Virginia can see when it flipped).
 *
 * Threshold lives in env so Virginia can tune without a deploy:
 *   ESTIMATE_EXPIRATION_DAYS=7
 */
const db = require('../models/db');
const logger = require('./logger');

function getThresholdDays() {
  const raw = parseInt(process.env.ESTIMATE_EXPIRATION_DAYS, 10);
  if (!Number.isFinite(raw) || raw <= 0) return 7;
  return raw;
}

async function runEstimateExpiration() {
  const thresholdDays = getThresholdDays();
  const ageCutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  // Rule 1: aged-out — sent/viewed with sent_at older than the cutoff and
  // no accept/decline yet. Only flips live rows.
  const agedResult = await db('estimates')
    .whereIn('status', ['sent', 'viewed'])
    .whereNotNull('sent_at')
    .where('sent_at', '<', ageCutoff)
    .whereNull('accepted_at')
    .whereNull('declined_at')
    .update({ status: 'expired', updated_at: now });

  // Rule 2: explicit expires_at — any non-terminal row whose expires_at has
  // passed. Accepted/declined estimates are left alone.
  const dateResult = await db('estimates')
    .whereNotNull('expires_at')
    .where('expires_at', '<', now)
    .whereNotIn('status', ['expired', 'accepted', 'declined'])
    .update({ status: 'expired', updated_at: now });

  logger.info(`[estimate-expiration] thresholdDays=${thresholdDays} aged=${agedResult} dateExpired=${dateResult}`);

  // Fire a single batched notification when anything flipped — one ping per
  // cron run, not per estimate, so Virginia doesn't get 5 bells at 6am.
  const total = (agedResult || 0) + (dateResult || 0);
  if (total > 0) {
    try {
      const { triggerNotification } = require('./notification-triggers');
      await triggerNotification('estimate_expired', { count: total });
    } catch (e) {
      logger.warn(`[estimate-expiration] notification trigger failed: ${e.message}`);
    }
  }

  return { aged: agedResult, dateExpired: dateResult };
}

module.exports = { runEstimateExpiration };
