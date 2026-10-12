'use strict';

/**
 * The body of the Monday permit cron (scheduler.js `permit-sync`): the report
 * sync, then the permit detail collection, then ONE late second try of the
 * report sync when the first one failed.
 *
 * Why the late try (job_health 2026-10-12): the county's report service
 * fails in the 4:05 AM ET slot in ways a quick retry does not get past. That
 * morning the report form hung twice, then the download answered with an
 * HTML page instead of the CSV for both reports, all inside three minutes,
 * while the permit record pages on the same host answered 258 of 258 for the
 * next hour. A failed week has no second chance until the next Monday, so
 * the report sync runs once more after the detail step. Both report syncs
 * upsert by permit number over the full range, so a second run is harmless
 * and one success catches the tables up.
 *
 * The late try waits until LATE_RETRY_MIN_WAIT_MS after the failure. With
 * GATE_PERMIT_DETAIL_SYNC on, the detail step uses that time (it runs to its
 * own time budget); with it off, the step returns at once and the wait is a
 * plain timer. The caller holds the job lease for the whole sequence.
 */

const logger = require('../logger');

const LATE_RETRY_MIN_WAIT_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function logReportResult(res) {
  if (!res || res.skipped) return;
  const part = (r) => (r ? `${r.written}/${r.fetched} rows` : 'failed');
  logger.info(`Permit sync: pool ${part(res.pool)}; construction ${part(res.construction)}${res.errors.length ? `; errors: ${res.errors.join(' | ')}` : ''}`);
}

/**
 * Runs the sequence. Each step keeps its own try so a failure in one never
 * skips the other. Throws when a step is still failed at the end, so the
 * lease records it in job health (a swallowed error would read as success).
 */
async function runPermitSyncSteps({ now = Date.now, wait = sleep, lateRetryMinWaitMs = LATE_RETRY_MIN_WAIT_MS } = {}) {
  const { syncPermits } = require('./manatee-permit-sync');
  let reportError = null;
  let reportFailedAt = null;
  try {
    logReportResult(await syncPermits());
  } catch (err) {
    logger.error(`Permit sync failed: ${err.message}`);
    reportError = err;
    reportFailedAt = now();
  }

  // Permit detail collection (building facts off each new-home permit's ACA
  // record page → construction_permit_records). Runs AFTER the report sync
  // so this week's new permits are candidates. Inert unless
  // GATE_PERMIT_DETAIL_SYNC is exactly 'true' (checked inside
  // syncPermitDetails). Slow by design (sequential, >=2 s between requests,
  // per-run cap + time budget); never runs from a lookup.
  let detailError = null;
  try {
    await require('./manatee-permit-detail').syncPermitDetails();
  } catch (err) {
    logger.error(`Permit detail sync failed: ${err.message}`);
    detailError = err;
  }

  if (reportError) {
    const remaining = lateRetryMinWaitMs - (now() - reportFailedAt);
    if (remaining > 0) await wait(remaining);
    logger.warn('[permit-sync] report sync failed earlier in this run; trying it once more');
    try {
      logReportResult(await syncPermits());
      reportError = null;
    } catch (err) {
      logger.error(`Permit sync late retry failed: ${err.message}`);
      reportError = err;
    }
  }

  const failures = [];
  if (reportError) failures.push(`report sync: ${reportError.message}`);
  if (detailError) failures.push(`detail sync: ${detailError.message}`);
  if (failures.length) throw new Error(failures.join(' | '));
}

module.exports = { runPermitSyncSteps, LATE_RETRY_MIN_WAIT_MS };
