'use strict';

/**
 * The weekly permit-sync job body (scheduler.js runs it under ONE
 * `permit-sync` lease): the report step (manatee-permit-sync.js, about
 * 3 minutes), then the detail step (manatee-permit-detail.js, up to its
 * 60-minute budget while the backlog of unread new-home permits lasts).
 *
 * After a deploy kill (`afterKill`, from registerDeployKillRetry) the retry
 * is shaped to fit between deploys. 2026-10-26: the 7:41 AM run finished
 * the report step at 7:44, then deploys 5 to 18 minutes apart killed the
 * detail step and every retry. Each retry re-ran the whole report first
 * (two of them got HTTP 403 from the county for asking again within
 * minutes) and then a fresh 60-minute detail run, so all 4 retries died and
 * the job read failed for the week. Now a retry:
 *   - skips the report step when both report sections already committed in
 *     the last REPORT_FRESH_MS (the killed run, or an earlier retry, did it);
 *   - runs the detail step for at most RETRY_DETAIL_BUDGET_MS. Each permit's
 *     result is written as it is read, so the killed run's reads are kept
 *     and the next weekly run picks up the rest (newest permits first).
 */

const logger = require('../logger');

const REPORT_FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_DETAIL_BUDGET_MS = 5 * 60 * 1000;

async function reportAlreadyDone(sync, nowMs) {
  try {
    return await sync.reportSyncedSince(new Date(nowMs - REPORT_FRESH_MS));
  } catch (err) {
    // Unreadable: run the report step (a second run is harmless).
    logger.warn(`Permit sync retry: report freshness unreadable, running the report step (${err.message})`);
    return false;
  }
}

async function runPermitSyncSteps({ afterKill = false, now = Date.now } = {}) {
  const sync = require('./manatee-permit-sync');
  const failures = [];
  if (afterKill && await reportAlreadyDone(sync, now())) {
    logger.info('Permit sync retry: the report step already finished this morning; running the detail step only');
  } else {
    try {
      const res = await sync.syncPermits();
      if (res && !res.skipped) {
        const part = (r) => (r ? `${r.written}/${r.fetched} rows` : 'failed');
        logger.info(`Permit sync: pool ${part(res.pool)}; construction ${part(res.construction)}${res.errors.length ? `; errors: ${res.errors.join(' | ')}` : ''}`);
      }
    } catch (err) {
      logger.error(`Permit sync failed: ${err.message}`);
      failures.push(`report sync: ${err.message}`);
    }
  }
  // Permit detail collection (building facts off each new-home permit's
  // ACA record page → construction_permit_records). Runs AFTER the
  // report sync so this week's new permits are candidates. Inert unless
  // GATE_PERMIT_DETAIL_SYNC is exactly 'true' (checked inside
  // syncPermitDetails). Slow by design (sequential, >=2 s between
  // requests, per-run cap + time budget); never runs from a lookup.
  try {
    await require('./manatee-permit-detail').syncPermitDetails(afterKill ? { maxBudgetMs: RETRY_DETAIL_BUDGET_MS } : {});
  } catch (err) {
    logger.error(`Permit detail sync failed: ${err.message}`);
    failures.push(`detail sync: ${err.message}`);
  }
  // Both steps ran; a failure in either still reaches the lease so job
  // health records it (a swallowed error would read as success).
  if (failures.length) throw new Error(failures.join(' | '));
}

module.exports = { runPermitSyncSteps, REPORT_FRESH_MS, RETRY_DETAIL_BUDGET_MS };
