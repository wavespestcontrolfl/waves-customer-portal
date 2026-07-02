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
const { excludePendingFirstBookings } = require('./estimate-conversion-guard');

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
  // no accept/decline yet. Only flips live rows. Archived rows are parked
  // status-neutral (manual archive + converted-customer sweep) — expiring
  // them would rewrite their status and ping Virginia about dead courtships.
  const agedResult = await db('estimates')
    .whereIn('status', ['sent', 'viewed'])
    .whereNull('archived_at')
    .whereNotNull('sent_at')
    .where('sent_at', '<', ageCutoff)
    .whereNull('accepted_at')
    .whereNull('declined_at')
    // Hold: a first-booking customer's estimate stays live until the visit
    // resolves — the archive sweep (which runs before this in the 6am chain)
    // claims it on completion; expiring it here would strand a booked
    // conversion at `expired`, where the sweep's sent/viewed filter can
    // never reclaim it. The hold self-lifts if the booking dies.
    .modify(excludePendingFirstBookings)
    .update({ status: 'expired', updated_at: now });

  // Rule 2: explicit expires_at — any non-terminal row whose expires_at has
  // passed. Accepted/declined estimates are left alone.
  const dateResult = await db('estimates')
    .whereNotNull('expires_at')
    .whereNull('archived_at')
    .where('expires_at', '<', now)
    .whereNotIn('status', ['expired', 'accepted', 'declined'])
    // Same first-booking hold as Rule 1 — an explicit expires_at date set
    // before the customer booked doesn't make expiring their live courtship
    // any less wrong.
    .modify(excludePendingFirstBookings)
    .update({ status: 'expired', updated_at: now });

  logger.info(`[estimate-expiration] thresholdDays=${thresholdDays} aged=${agedResult} dateExpired=${dateResult}`);

  // Refund acceptance deposits stranded on terminal estimates — money
  // received while the estimate was live (paid then abandoned, or paid then
  // declined) has no other refund path once the row goes declined/expired.
  // Self-healing daily sweep: covers today's flips AND any prior strand
  // (failed inline decline sweep, admin-side terminal status change).
  try {
    const { sweepTerminalEstimateDeposits } = require('./estimate-deposits');
    await sweepTerminalEstimateDeposits();
  } catch (e) {
    logger.error(`[estimate-expiration] terminal-estimate deposit sweep failed: ${e.message}`);
  }

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
