/**
 * Nightly plan-rate ledger invariant reconcile (dark: GATE_PLAN_RATE_LEDGER_RECONCILE,
 * live only while GATE_PLAN_RATE_LEDGER is on too — planRateLedgerReconcileLive()).
 *
 * The invariant: a customer's customer_plan_rates lines add up to the billed
 * customers.monthly_rate, to the cent. With the ledger authoritative every app
 * writer keeps it (estimate accepts derive the rate from the lines; admin and
 * Intelligence Bar rate edits, offboarding, plan-sync, holds, the cancel
 * wind-down and the annual rate review write both together). A customer that
 * still diverges was written outside those paths: a script or a direct database
 * edit that set the rate alone (the 2026-08-13 case: an ops script raised a rate
 * and left the lines at the old figure), or an accept from before the flip that
 * the ops backfill never saw.
 * Until it is reconciled the customer bills a figure the lines cannot explain,
 * and the next recompute from the lines (an estimate accept, a plan hold or its
 * resume) bills their sum instead, silently dropping or adding the gap; the
 * annual rate review refuses such a customer outright (ledger_scalar_mismatch).
 * The only check so far was a local launchd job on the owner's Mac, which hung
 * from 2026-10-16 to 10-24; this is its durable home (job_health records every run).
 *
 * Each run, for every live customer (a customer pipeline stage, not deleted)
 * whose lines add up to a different figure than the bill by a cent or more:
 * - Shortfall (bill above the lines): the gap is parked in the customer's
 *   'unattributed' line, the ops backfill's pre-seeded repair
 *   (ops/agents/backfill-plan-rate-ledger.js). The bill is the business fact and
 *   is never changed; the lines are only its attribution.
 * - Overshoot (lines above the bill): nothing is deleted or shrunk. Which line
 *   is stale is the owner's call.
 * Either way the owner gets one Billing alert per distinct gap, deduped forever on
 * the customer and both cent figures: an unfixed overshoot does not ring every
 * night, and a new gap on the same customer rings again.
 *
 * Never changes customers.monthly_rate, never charges, never messages a customer.
 *
 * Locking: one transaction per customer takes rung 6 (the customer-comms key)
 * BEFORE the customers row lock, the order every ledger writer uses
 * (utils/customer-comms-lock.js LOCK ORDER CONTRACT, plan-rate-ledger.js
 * LOCKING), then re-reads the bill and the lines under both. A gap is only ever
 * judged on committed figures that no accept, edit, hold or wind-down can move
 * until this commits. The alert is written on the same transaction, so an alert
 * that cannot be written rolls the repair back and the next run tries both again.
 *
 * Alert budget (docs/admin-notifications.md section 4, Budget): at most
 * MAX_NEW_ALERTS_PER_RUN new alerts a run. Once they are spent the remaining
 * customers wait, untouched, for the next run, so a shortfall is never parked
 * without its alert. Meeting an already-alerted gap again costs nothing.
 */

const db = require('../models/db');
const logger = require('./logger');
const { planRateLedgerReconcileLive } = require('../config/feature-gates');
const { UNATTRIBUTED } = require('./plan-rate-ledger');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { raiseAdminAlert } = require('./admin-alert-compose');
const names = require('./admin-alert-names');
// The owner-facing name of a ledger line ("Earlier rate (not split by service)"
// for 'unattributed'), the same words the Intelligence Bar's rate-change card uses.
const { lineLabel, money } = require('./intelligence-bar/rate-change');

const REPAIR_SOURCE = 'invariant_repair';
const MAX_NEW_ALERTS_PER_RUN = 5;
const DEDUPE_PREFIX = 'plan-rate-invariant';

const cents = (value) => Math.round(Number(value || 0) * 100);
const dollars = (amountCents) => money(amountCents / 100);

// Live customers whose lines add up to a different figure than the bill, by
// whole cents (both columns are currency precision, so any difference is one
// the dues run bills). A customer with no lines is a designed state (a rate
// set before the ledger existed, handled by the accept-time empty-ledger
// cases), not a gap. A NULL bill counts as zero: lines above nothing are an
// overshoot. Ordered by id so a run that spends its alert budget always
// leaves the same customers for the next one.
function divergentCustomersQuery(database) {
  return database('customers as c')
    .join('customer_plan_rates as r', 'r.customer_id', 'c.id')
    .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
    .whereNull('c.deleted_at')
    .groupBy('c.id', 'c.monthly_rate')
    .havingRaw('ROUND(SUM(r.monthly_rate) * 100) <> ROUND(COALESCE(c.monthly_rate, 0) * 100)')
    .orderBy('c.id')
    .select('c.id');
}

// Insert the gap as the 'unattributed' line, or ADD it to that line when it
// exists, changing nothing else on the row (the backfill's merge). An existing
// line keeps its source and stamps because other code reads them as evidence:
// cancellation-resolution/facts.js treats a surviving human-source line
// (admin_edit, ib_update, ib_bulk_update) and its updated_at as the
// manual-override cooldown, and the rate review matches a line's
// source_estimate_id to the plan its notice named.
async function parkShortfall(trx, customerId, shortfallCents) {
  const now = new Date();
  await trx('customer_plan_rates')
    .insert({
      customer_id: customerId,
      family_key: UNATTRIBUTED,
      monthly_rate: (shortfallCents / 100).toFixed(2),
      source: REPAIR_SOURCE,
      effective_at: now,
      updated_at: now,
    })
    .onConflict(['customer_id', 'family_key'])
    .merge({ monthly_rate: trx.raw('customer_plan_rates.monthly_rate + excluded.monthly_rate') });
}

// One alert per distinct gap, raised on the repair's own transaction.
async function raiseGapAlert(trx, { customer, lines, billedCents, lineSumCents }) {
  const shortfall = billedCents > lineSumCents;
  const gapCents = Math.abs(billedCents - lineSumCents);
  const name = names.fullName(customer) || 'a customer';
  const bill = dollars(billedCents);
  const sum = dollars(lineSumCents);
  const gap = dollars(gapCents);
  const lineList = lines.map((row) => `${lineLabel(row.family_key)} ${dollars(cents(row.monthly_rate))}`).join(', ');
  const dedupeKey = `${DEDUPE_PREFIX}:${customer.id}:${billedCents}:${lineSumCents}`;
  // A NULL rate is compared as $0 but is not "a $0.00 bill": say there is none.
  const billWords = customer.monthly_rate == null ? 'there is no monthly rate on the account' : `the bill is ${bill} a month`;
  const spec = shortfall
    ? {
      action: names.fitAction('Billing', name, [(n) => `check ${n}'s monthly bill by service`, (n) => `check ${n}'s monthly bill`]),
      why: `Billed ${bill} a month but the service lines added up to ${sum}; the gap is now an unsplit line.`,
      doneWhen: 'plan_lines_checked',
    }
    : {
      action: names.fitAction('Billing', name, [(n) => `fix ${n}'s monthly bill by service`, (n) => `fix ${n}'s monthly bill`]),
      why: `The service lines add up to ${sum} but ${billWords}; nothing was deleted.`,
      doneWhen: 'plan_lines_match_bill',
    };
  const detail = shortfall
    ? `${name} is billed ${bill} a month, but the service lines behind that bill added up to ${sum} (${lineList}). `
      + 'The rate was changed somewhere that did not update the lines, such as a script or a direct database edit. '
      + `The nightly check added the ${gap} difference to the line for the earlier rate not split by service, so the lines add up to the bill again. `
      + 'The bill was not changed, nothing was charged, and the customer was not contacted. '
      + `Confirm ${bill} is the right monthly bill, and split the ${gap} onto its service once you know which one it is.`
    : `${name}'s service lines add up to ${sum} (${lineList}), but ${billWords}. `
      + 'A line is out of date, or the rate was lowered or cleared without updating the lines. '
      + 'Nothing was deleted or changed, nothing was charged, and the customer was not contacted. '
      + `Until it is fixed, the next estimate accept or plan hold for this customer rebuilds the bill from the lines, which add up to ${sum}. `
      + 'Correct the lines or the rate.';
  return raiseAdminAlert('billing', {
    area: 'Billing',
    severity: 'needs-you',
    who: 'person',
    link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
    subject: { type: 'customer', id: String(customer.id) },
    ...spec,
  }, {
    trx,
    bell: true,
    dedupeKey,
    detail,
    metadata: {
      dedupeKey,
      customerId: customer.id,
      gap: shortfall ? 'shortfall' : 'overshoot',
      billedCents,
      lineSumCents,
      parkedCents: shortfall ? gapCents : 0,
    },
  });
}

// One customer, under rung 6 and the customers row lock. Returns
// { outcome: 'not_live' | 'converged' | 'parked' | 'overshoot', alert? }.
async function reconcileCustomer(database, customerId) {
  return database.transaction(async (trx) => {
    await lockCustomerComms(trx, customerId);
    const customer = await trx('customers')
      .where({ id: customerId })
      .forUpdate()
      .first('id', 'first_name', 'last_name', 'monthly_rate', 'pipeline_stage', 'deleted_at');
    if (!customer || customer.deleted_at || !CUSTOMER_STAGES.includes(customer.pipeline_stage)) {
      return { outcome: 'not_live' };
    }
    const lines = await trx('customer_plan_rates')
      .where({ customer_id: customerId })
      .orderBy('family_key')
      .select('family_key', 'monthly_rate', 'source');
    const billedCents = cents(customer.monthly_rate);
    const lineSumCents = lines.reduce((sum, row) => sum + cents(row.monthly_rate), 0);
    // Judged again under the locks: a writer that committed since the scan
    // may already have brought the two together, or cleared the lines.
    if (!lines.length || billedCents === lineSumCents) return { outcome: 'converged' };
    const shortfallCents = billedCents - lineSumCents;
    if (shortfallCents > 0) await parkShortfall(trx, customerId, shortfallCents);
    const alert = await raiseGapAlert(trx, { customer, lines, billedCents, lineSumCents });
    return { outcome: shortfallCents > 0 ? 'parked' : 'overshoot', alert };
  });
}

async function runPlanRateLedgerReconcile({ database = db } = {}) {
  // Off (either gate): nothing is read, written or raised.
  if (!planRateLedgerReconcileLive()) return { skipped: true, reason: 'gated_off' };
  const candidates = await divergentCustomersQuery(database);
  const result = {
    skipped: false,
    checked: candidates.length,
    parked: 0,
    overshoots: 0,
    // Nothing to do once locked: the gap had closed or the lines were cleared
    // (converged), or the customer had left the live stages (notLive).
    converged: 0,
    notLive: 0,
    alerted: 0,
    alreadyAlerted: 0,
    deferred: 0,
    failed: 0,
  };
  for (const { id } of candidates) {
    if (result.alerted >= MAX_NEW_ALERTS_PER_RUN) {
      result.deferred += 1;
      continue;
    }
    try {
      const { outcome, alert } = await reconcileCustomer(database, id);
      if (outcome === 'parked') result.parked += 1;
      else if (outcome === 'overshoot') result.overshoots += 1;
      else if (outcome === 'not_live') result.notLive += 1;
      else result.converged += 1;
      if (alert && alert.deduped === true) result.alreadyAlerted += 1;
      else if (alert && alert.id != null) result.alerted += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`[plan-rate-reconcile] customer ${id} not reconciled: ${err.message}`);
    }
  }
  if (result.failed) {
    // Every other customer was still reconciled; the run reads as failed in job_health.
    logger.error(`[plan-rate-reconcile] run: ${JSON.stringify(result)}`);
    throw Object.assign(new Error(`plan-rate ledger reconcile: ${result.failed} customer(s) failed`), { result });
  }
  return result;
}

module.exports = {
  runPlanRateLedgerReconcile,
  MAX_NEW_ALERTS_PER_RUN,
  REPAIR_SOURCE,
  _private: { divergentCustomersQuery, reconcileCustomer },
};
