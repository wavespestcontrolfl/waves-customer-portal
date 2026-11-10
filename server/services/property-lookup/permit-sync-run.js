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
 *
 * The daily catch-up (`runPermitReportCatchUp`, 7:41 AM ET on the six other
 * days) runs the report step again when Monday's did not commit. 2026-11-09:
 * the county refused the first report download of both sections with HTTP
 * 403, 0.7 s into the run, and nothing asked again for a week (the tables
 * stayed at Nov 2; also 2026-10-12, a web page for both reports). One
 * refused request now costs a day, not a week. The catch-up never runs the
 * detail step: Monday's run did, and next Monday reads the new permits.
 */

const logger = require('../logger');
const { gateEnvValue } = require('../../config/feature-gates');
const { etWeekStart, parseETDateTime } = require('../../utils/datetime-et');

const REPORT_FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_DETAIL_BUDGET_MS = 5 * 60 * 1000;
/**
 * Start of this week's Monday in ET (the week runs Monday to Sunday, so on a
 * Sunday it is six days back). A report commit at or after it is this
 * week's: the Monday run, or a catch-up after it. A fixed age would not do:
 * a catch-up that commits late in one week must not read as fresh after the
 * next Monday's run fails.
 */
function thisWeeksMondayStart(nowMs) {
  return parseETDateTime(`${etWeekStart(new Date(nowMs))}T00:00`);
}

async function reportAlreadyDone(sync, nowMs) {
  try {
    return await sync.reportSyncedSince(new Date(nowMs - REPORT_FRESH_MS));
  } catch (err) {
    // Unreadable: run the report step (a second run is harmless).
    logger.warn(`Permit sync retry: report freshness unreadable, running the report step (${err.message})`);
    return false;
  }
}

/**
 * True when the daily catch-up has work: the gate is on and a report section
 * has not committed since the start of this week's Monday (ET). A gate that is off answers
 * before any database read. An unreadable freshness check answers true: a
 * second report run is harmless (same rule as the deploy-kill retry).
 */
async function reportCatchUpDue({ now = Date.now } = {}) {
  if (!gateEnvValue('GATE_PERMIT_SYNC')) return false;
  const sync = require('./manatee-permit-sync');
  try {
    return !(await sync.reportSyncedSince(thisWeeksMondayStart(now())));
  } catch (err) {
    logger.warn(`Permit sync catch-up: report freshness unreadable, running the report step (${err.message})`);
    return true;
  }
}

/**
 * The catch-up body (scheduler.js runs it under the `permit-sync` lease, so
 * job health reads the result). Freshness is read again under the lease: a
 * tick that waited behind another instance's catch-up must not ask the
 * county for the same reports minutes later (2026-10-26: that got HTTP 403).
 * A failure throws, so the job stays failed until a run commits.
 */
async function runPermitReportCatchUp({ now = Date.now } = {}) {
  if (!(await reportCatchUpDue({ now }))) {
    logger.info('Permit sync catch-up: the report step already committed this week; nothing to do');
    return { skipped: 'fresh' };
  }
  const sync = require('./manatee-permit-sync');
  let res;
  try {
    res = await sync.syncPermits();
  } catch (err) {
    logger.error(`Permit sync catch-up failed: ${err.message}`);
    throw new Error(`report sync (catch-up): ${err.message}`);
  }
  if (res && !res.skipped) {
    const part = (r) => (r ? `${r.written}/${r.fetched} rows` : 'failed');
    logger.info(`Permit sync catch-up: pool ${part(res.pool)}; construction ${part(res.construction)}`);
  }
  return res;
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

module.exports = {
  runPermitSyncSteps,
  reportCatchUpDue,
  runPermitReportCatchUp,
  REPORT_FRESH_MS,
  RETRY_DETAIL_BUDGET_MS,
  thisWeeksMondayStart,
};
