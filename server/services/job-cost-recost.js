/**
 * Nightly re-cost after the trip link (L11b, GATE_TECH_OPEN_TIME on top of GATE_TECH_COST_RATES).
 *
 * A visit is costed when it is completed. The trip link writes its GPS leg (drive minutes and miles) at
 * 01:40 ET the next night, so the GPS branch of loadDriveLeg (job-costing.js) never reached a real visit's
 * cost. After the trip link has run, this re-costs the visits it just linked, so their drive minutes and
 * miles are the measured ones. Legs first, then costs (scheduler.js runs them in that order).
 *
 * Only a completed visit with a technician whose cost card is in effect on the visit date is re-costed: with
 * no card, costing would not change. A re-cost is cost only: revenue is kept as recorded
 * (keepRecordedRevenue). calculateJobCost also runs syncCustomerAdAttribution for a completed visit, as the
 * admin recalculation does. Finding: that sync is idempotent. It re-sums the customer's completed job_costs
 * rows under a lock on the primary ad_service_attribution row and rewrites the same funnel fields
 * (completed_revenue, gross_profit, margin, projected LTV, updated_at); it sends nothing and raises nothing,
 * so a second run with unchanged costs writes the same values. With changed costs it moves gross profit to
 * the new truth, which is the point.
 */
const db = require('../models/db');
const logger = require('./logger');
const { dateString, loadVisitRates } = require('./tech-cost-rates');

const LOG = '[job-cost-recost]';

function gateOn(name) {
  try {
    const gates = require('../config/feature-gates');
    return typeof gates[name] === 'function' && gates[name]() === true;
  } catch {
    return false;
  }
}

/**
 * Re-cost these scheduled services, one after the other. Failures are logged (id and error code only) and
 * do not stop the loop. With dryRun, nothing is costed: `recosted` counts the visits that would be.
 * @returns {Promise<{recosted:number, skipped:number, failed:number}>}
 */
async function recostVisits(conn, scheduledServiceIds, { dryRun = false } = {}) {
  const { calculateJobCost } = require('./job-costing');
  const out = { recosted: 0, skipped: 0, failed: 0 };
  for (const id of scheduledServiceIds) {
    try {
      const svc = await conn('scheduled_services').where({ id }).first('id', 'status', 'technician_id', 'scheduled_date');
      if (!svc || svc.status !== 'completed' || !svc.technician_id) {
        out.skipped += 1;
        continue;
      }
      // No card in effect (or no rate from it) = costing would not change.
      if (!(await loadVisitRates(conn, svc.technician_id, dateString(svc.scheduled_date)))) {
        out.skipped += 1;
        continue;
      }
      if (!dryRun) await calculateJobCost(id, conn, { keepRecordedRevenue: true });
      out.recosted += 1;
    } catch (err) {
      out.failed += 1;
      logger.warn(`${LOG} visit ${id} failed (${(err && (err.code || err.name)) || 'error'})`);
    }
  }
  return out;
}

/**
 * The nightly run: the visits whose legs sit on the same ET days the trip link links tonight.
 * Gate off (either gate) = returns before any query. Throws when any visit failed, after the whole loop,
 * so the job health reads red.
 */
async function recostNightly({ now = new Date(), conn = db } = {}) {
  if (!gateOn('techOpenTimeLive') || !gateOn('techCostRatesLive')) return { skipped: 'gated' };
  const tripLink = require('./trip-link');
  const days = tripLink.nightlyDays(now, await tripLink.lateArrivals(conn, now));
  const ids = await conn('visit_gps_legs').whereIn('service_date', days).pluck('scheduled_service_id');
  const result = await recostVisits(conn, ids, { now });
  logger.info(`${LOG} done`, { days, ...result });
  if (result.failed > 0) throw new Error(`${LOG} ${result.failed} visit(s) failed to re-cost`);
  return { days, ...result };
}

module.exports = { recostVisits, recostNightly };
