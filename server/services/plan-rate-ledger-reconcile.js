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
 * Each run, for every live customer (customer-stages.js whereLiveCustomer:
 * active, a customer pipeline stage, not deleted)
 * whose lines add up to a different figure than the bill by a cent or more:
 * - Shortfall (bill above the lines): the gap is parked in the customer's
 *   'unattributed' line, the ops backfill's pre-seeded repair
 *   (ops/agents/backfill-plan-rate-ledger.js). The bill is the business fact and
 *   is never changed; the lines are only its attribution.
 * - Overshoot (lines above the bill): nothing is deleted or shrunk. Which line
 *   is stale is the owner's call.
 * Either way the owner gets one Billing alert per distinct gap, deduped on the
 * customer and both cent figures: an unfixed overshoot does not ring every
 * night, and a new gap on the same customer rings again.
 *
 * Alert lifecycle (docs/admin-notifications.md section 4, admin-alert-episodes.js,
 * live unless ALERT_EPISODES is killed): an overshoot alert closes itself once its
 * gap no longer stands (the lines were corrected, the bill changed, or the account
 * stopped being live), and the same gap coming back rings again; a person's own
 * dismissal of a gap that still stands stays dismissed. A shortfall alert asks a
 * person to check a repair this job already made, so only that person closes it.
 * ALERT_EPISODES killed: the plain deduped alert, nothing closes or reopens.
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
const { planRateLedgerReconcileLive, alertEpisodesLive } = require('../config/feature-gates');
const { UNATTRIBUTED } = require('./plan-rate-ledger');
const { whereLiveCustomer } = require('./customer-stages');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { raiseAdminAlert, composeAdminAlert } = require('./admin-alert-compose');
// Through the module object, as the schedule-integrity watchdog does, so a unit
// test can stand the episode helpers in for their SQL.
const alertEpisodes = require('./admin-alert-episodes');
const names = require('./admin-alert-names');
// The owner-facing name of a ledger line ("Earlier rate (not split by service)"
// for 'unattributed'), the same words the Intelligence Bar's rate-change card uses.
const { lineLabel, money } = require('./intelligence-bar/rate-change');

const REPAIR_SOURCE = 'invariant_repair';
const MAX_NEW_ALERTS_PER_RUN = 5;
// One key per distinct gap: <prefix><customer>:<bill cents>:<line sum cents>.
const SHORTFALL_PREFIX = 'plan-rate-invariant:shortfall:';
const OVERSHOOT_PREFIX = 'plan-rate-invariant:overshoot:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cents = (value) => Math.round(Number(value || 0) * 100);
const dollars = (amountCents) => money(amountCents / 100);

// Live customers (whereLiveCustomer: active, a customer stage, not deleted —
// an inactive account is not billed by the dues run and comes back into this
// check the first night after it is reactivated) whose lines add up to a
// different figure than the bill, by whole cents (both columns are currency
// precision, so any difference is one the dues run bills). A customer with no
// lines is a designed state (a rate set before the ledger existed, handled by
// the accept-time empty-ledger cases), not a gap: the sum over no lines is
// NULL and never compares unequal. A NULL bill counts as zero: lines above
// nothing are an overshoot. The sum is a correlated subquery, so the live
// rule's unqualified columns only ever see customers. Ordered by id so a run
// that spends its alert budget always leaves the same customers for the next.
function divergentCustomersQuery(database) {
  return database('customers')
    .modify(whereLiveCustomer)
    .whereRaw('(SELECT ROUND(SUM(r.monthly_rate) * 100) FROM customer_plan_rates r WHERE r.customer_id = customers.id) <> ROUND(COALESCE(customers.monthly_rate, 0) * 100)')
    .orderBy('id')
    .select('id');
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

// The alert's eight parts for one gap, named for `name`.
function gapSpec(customer, name, { shortfall, bill, sum, billWords }) {
  return {
    area: 'Billing',
    severity: 'needs-you',
    who: 'person',
    link: `/admin/customers?customerId=${encodeURIComponent(customer.id)}`,
    subject: { type: 'customer', id: String(customer.id) },
    ...(shortfall
      ? {
        action: names.fitAction('Billing', name, [(n) => `check ${n}'s monthly bill by service`, (n) => `check ${n}'s monthly bill`]),
        why: `Billed ${bill} a month but the service lines added up to ${sum}; the gap is now an unsplit line.`,
        doneWhen: 'plan_lines_checked',
      }
      : {
        action: names.fitAction('Billing', name, [(n) => `fix ${n}'s monthly bill by service`, (n) => `fix ${n}'s monthly bill`]),
        why: `The service lines add up to ${sum} but ${billWords}; nothing was deleted.`,
        doneWhen: 'plan_lines_match_bill',
      }),
  };
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
  const dedupeKey = `${shortfall ? SHORTFALL_PREFIX : OVERSHOOT_PREFIX}${customer.id}:${billedCents}:${lineSumCents}`;
  // A NULL rate is compared as $0 but is not "a $0.00 bill": say there is none.
  const billWords = customer.monthly_rate == null ? 'there is no monthly rate on the account' : `the bill is ${bill} a month`;
  const figures = { shortfall, bill, sum, billWords };
  // A name the alert rules refuse (an emoji, brackets, an exclamation mark)
  // must not cost the gap its alert, nor fail, every night, the repair the
  // alert rides on: the headline says "a customer" and the detail keeps the name.
  let spec = gapSpec(customer, name, figures);
  let composed;
  try {
    composed = composeAdminAlert(spec);
  } catch (err) {
    if (err.code !== 'ADMIN_ALERT_RULE') throw err;
    spec = gapSpec(customer, 'a customer', figures);
    composed = composeAdminAlert(spec);
  }
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
  const opts = {
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
  };
  // ALERT_EPISODES killed: the plain deduped alert; nothing closes or reopens.
  if (!alertEpisodesLive()) return raiseAdminAlert('billing', spec, opts);
  // Episodes: a standing alert is a silent dedupe; one this job closed when its
  // gap cleared rings again if the same gap comes back.
  return alertEpisodes.raiseAdminAlertWithReopen('billing', composed.headline, composed.why, {
    ...opts, link: composed.link, metadata: { ...opts.metadata, ...composed.metadata },
  });
}

// The close half of the episode: every open overshoot alert whose gap no
// longer stands is closed, with what changed as its resolution. Judged on the
// customer as it is now (not on this run's candidates, which a spent alert
// budget leaves unprocessed), and writes nothing but admin notifications: an
// alert closed a moment before its gap returns is re-raised, and rings again,
// on the next run. Shortfall alerts are never closed here (see the header).
async function closeSettledOvershootAlerts(database, now = new Date()) {
  const open = (await alertEpisodes.openAdminAlertKeys(database, OVERSHOOT_PREFIX))
    .map((key) => {
      const [customerId, billedCents, lineSumCents] = key.slice(OVERSHOOT_PREFIX.length).split(':');
      return { key, customerId, billedCents: Number(billedCents), lineSumCents: Number(lineSumCents) };
    })
    .filter((alert) => UUID.test(alert.customerId));
  if (!open.length) return 0;
  const rows = await database('customers')
    .whereIn('id', [...new Set(open.map((alert) => alert.customerId))])
    .modify(whereLiveCustomer)
    .select('id', 'monthly_rate', database.raw('(SELECT ROUND(SUM(r.monthly_rate) * 100) FROM customer_plan_rates r WHERE r.customer_id = customers.id) AS line_sum_cents'));
  const current = new Map(rows.map((row) => [String(row.id).toLowerCase(), {
    billedCents: cents(row.monthly_rate),
    lineSumCents: row.line_sum_cents == null ? null : Number(row.line_sum_cents),
  }]));
  const byReason = new Map();
  for (const alert of open) {
    const state = current.get(alert.customerId.toLowerCase());
    let reason = null;
    if (!state) reason = 'the account is no longer a live customer';
    else if (state.lineSumCents == null) reason = 'the plan lines were cleared';
    else if (state.lineSumCents === state.billedCents) reason = 'the plan lines add up to the bill';
    else if (state.billedCents !== alert.billedCents || state.lineSumCents !== alert.lineSumCents) reason = 'the gap changed';
    if (reason) byReason.set(reason, [...(byReason.get(reason) || []), alert.key]);
  }
  let closed = 0;
  for (const [reason, keys] of byReason) {
    closed += Number(await alertEpisodes.closeAdminAlertKeys(database, keys, reason, { now, resolution: `Cleared: ${reason}` })) || 0;
  }
  return closed;
}

// One customer, under rung 6 and the customers row lock. Returns
// { outcome: 'not_live' | 'converged' | 'parked' | 'overshoot', alert? }.
async function reconcileCustomer(database, customerId) {
  return database.transaction(async (trx) => {
    await lockCustomerComms(trx, customerId);
    // The live rule is part of the locked read: FOR UPDATE re-evaluates it on
    // the row version it waited for, so an account deactivated, churned or
    // deleted since the scan reads as absent and is left alone.
    const customer = await trx('customers')
      .where({ id: customerId })
      .modify(whereLiveCustomer)
      .forUpdate()
      .first('id', 'first_name', 'last_name', 'monthly_rate');
    if (!customer) return { outcome: 'not_live' };
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
    // Real rings (a new alert, or a closed one rung again), which spend the
    // budget; a silent dedupe onto a standing alert does not.
    alerted: 0,
    alreadyAlerted: 0,
    deferred: 0,
    closed: 0,
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
      if (alert) {
        // The reopen helper reports `rang`; the plain raise rang when it wrote a row.
        const rang = typeof alert.rang === 'boolean'
          ? alert.rang
          : (!alert.suppressed && alert.deduped !== true && alert.id != null);
        if (rang) result.alerted += 1;
        else if (alert.deduped === true) result.alreadyAlerted += 1;
      }
    } catch (err) {
      result.failed += 1;
      logger.error(`[plan-rate-reconcile] customer ${id} not reconciled: ${err.message}`);
    }
  }
  if (alertEpisodesLive()) result.closed = await closeSettledOvershootAlerts(database);
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
  _private: { divergentCustomersQuery, reconcileCustomer, closeSettledOvershootAlerts },
};
