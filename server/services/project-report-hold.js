/**
 * WDO report payment hold — release sweep.
 *
 * A payment-held project report ("pay before you get the report") is parked
 * on the projects row itself (report_hold_* columns — the projects table IS
 * the release queue, mirroring receipt_delivery_jobs semantics without a
 * jobs table). This sweep is the single release authority:
 *
 *   1. Recover stale 'releasing' claims (a crashed release) back to 'held'.
 *   2. Find held projects whose linked invoice has SETTLED ('paid' or
 *      credit-covered 'prepaid' — ACH 'processing' does not release) and are
 *      due (next_attempt_at backoff), and deliver each via
 *      releaseHeldProjectReport (routes/admin-projects.js — it owns the WDO
 *      send machinery: signature gates, FDACS PDF build, filing archive,
 *      email + third-party copies + SMS).
 *
 * Runs on a 60s interval from index.js (same in-process pattern as the
 * receipt delivery queue), and payment paths nudge it via
 * scheduleHoldReleaseSweep so an online payment releases the report within
 * seconds instead of a minute. Every settlement path converges on
 * invoices.status in the DB, so the interval alone guarantees release for
 * paths with no nudge (terminal taps, statement settles, manual writes).
 */

const db = require('../models/db');
const logger = require('./logger');

const STALE_RELEASING_MINUTES = 10;

async function recoverStaleReleasingClaims() {
  return db('projects')
    .where({ report_hold_status: 'releasing' })
    .where('report_hold_locked_at', '<', db.raw(`now() - interval '${STALE_RELEASING_MINUTES} minutes'`))
    .update({
      report_hold_status: 'held',
      report_hold_locked_at: null,
      report_hold_next_attempt_at: db.fn.now(),
      updated_at: db.fn.now(),
    })
    .catch((err) => {
      // Pre-migration environments have no hold columns — the sweep is a no-op.
      if (!/column .*report_hold/i.test(err.message)) {
        logger.warn(`[report-hold] stale-claim recovery failed: ${err.message}`);
      }
      return 0;
    });
}

async function findDueHeldProjectIds(limit) {
  try {
    const rows = await db('projects as p')
      .join('invoices as i', 'p.invoice_id', 'i.id')
      .where('p.report_hold_status', 'held')
      .whereIn('i.status', ['paid', 'prepaid'])
      .where(function dueNow() {
        this.whereNull('p.report_hold_next_attempt_at')
          .orWhere('p.report_hold_next_attempt_at', '<=', db.fn.now());
      })
      .orderBy('p.report_hold_at', 'asc')
      .limit(limit)
      .select('p.id');
    return rows.map((r) => r.id);
  } catch (err) {
    if (!/column .*report_hold|relation .*invoices/i.test(err.message)) {
      logger.warn(`[report-hold] due-scan failed: ${err.message}`);
    }
    return [];
  }
}

async function sweepHeldReportReleases({ limit = 5 } = {}) {
  const recovered = await recoverStaleReleasingClaims();
  const dueIds = await findDueHeldProjectIds(limit);

  let released = 0;
  let deferred = 0;
  for (const projectId of dueIds) {
    try {
      // Lazy require breaks the require cycle (admin-projects requires many
      // services at load; nothing may require this sweep from that graph).
      const { releaseHeldProjectReport } = require('../routes/admin-projects');
      const result = await releaseHeldProjectReport(projectId, { source: 'payment_sweep' });
      if (result?.released) released += 1;
      else deferred += 1;
    } catch (err) {
      deferred += 1;
      logger.error(`[report-hold] release failed for project ${projectId}: ${err.message}`);
    }
  }

  if (recovered || dueIds.length) {
    logger.info(`[report-hold] sweep: ${dueIds.length} due, ${released} released, ${deferred} deferred, ${recovered} stale claim(s) recovered`);
  }
  return { recovered, due: dueIds.length, released, deferred };
}

// Fire-and-forget nudge for payment paths (webhook success, pay-page
// confirm, manual record-payment, credit coverage): run the sweep shortly
// after the settlement commits so an online payment releases its held report
// within seconds. Never awaited by callers — payment handlers must not gain
// latency or new failure modes from report delivery.
function scheduleHoldReleaseSweep({ delayMs = 2000, limit = 5 } = {}) {
  const run = () => {
    sweepHeldReportReleases({ limit }).catch((err) => {
      logger.error(`[report-hold] nudged sweep failed: ${err.message}`);
    });
  };
  if (delayMs > 0) setTimeout(run, delayMs).unref();
  else setImmediate(run);
}

module.exports = {
  sweepHeldReportReleases,
  scheduleHoldReleaseSweep,
  _internals: { recoverStaleReleasingClaims, findDueHeldProjectIds, STALE_RELEASING_MINUTES },
};
