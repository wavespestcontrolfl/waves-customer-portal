/**
 * A customer changes how often we visit for pest control, in one touch (GATE_PEST_FREQUENCY_CHANGE, dark).
 * Owner 2026-11-12, decision page "Frequency Change and Night Chat", answers A A:
 *   - price: the customer's own per-visit price along the pricing engine's frequency curve
 *     (PEST.frequencyDiscounts v2: every two months 0.88, monthly 0.78 of the quarterly price);
 *   - direction: more visits in one touch. Fewer visits is a message to the office (the client's part).
 * It replaces the 2026-08-06 ruling (customer-pricing-ai.js: the app never re-prices a service the customer
 * has) for pest frequency changes only.
 *
 * Who can use it. Fail closed: every other account keeps the office path.
 *   - the one-touch add-service limits (accountCanOneTap: no monthly-membership lane, a WaveGuard member,
 *     not billed to another payer);
 *   - billed for each visit (per_application or per_visit), with no annual prepay term and no price-change
 *     notice still to be applied;
 *   - exactly one ongoing general pest plan (catalog pest_general_quarterly / _bimonthly / _monthly on its
 *     own cadence) whose upcoming visits carry one price, and no add-on line, payer, re-service or money.
 *
 * What a change does, in ONE transaction (routes/admin-schedule.js changeSeriesFrequencyWithLocks): the
 * plan's template takes the new cadence, service and per-visit price; the pending visits the new schedule
 * replaces are cancelled as a plan trim; the nightly top-up's own loop books the new visits. A first visit
 * that is days away, confirmed or moved on purpose stays exactly as booked, at its own price. The customer's
 * own money fields then follow: the per-application fee when it was this plan's price, and the plan-rate
 * ledger's pest line with the monthly rate, by the real change in yearly cost.
 * It charges nothing and sends the customer nothing. The office gets one notice.
 *
 * preview() runs the same transaction and rolls it back, so the dates it shows are the dates confirm()
 * books. confirm() refuses when its result is not the one the customer was shown (`version`).
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { PEST } = require('./pricing-engine/constants');
const { resolveBillingLane } = require('./billing-lane');
const PlanRateLedger = require('./plan-rate-ledger');
const { auditPestFrequencyChange } = require('./audit-log');
const { pestFrequencyChangeAllowlist } = require('../config/feature-gates');

// Each cadence's catalog service, and the one-touch choices from it (more visits only).
const CATALOG_KEY = { quarterly: 'pest_general_quarterly', bimonthly: 'pest_general_bimonthly', monthly: 'pest_general_monthly' };
const MORE_VISITS = { quarterly: ['bimonthly', 'monthly'], bimonthly: ['monthly'], monthly: [] };
const CADENCE_WORDS = { quarterly: 'every three months', bimonthly: 'every two months', monthly: 'every month' };
const PER_VISIT_LANES = new Set(['per_application', 'per_visit']);
const UPCOMING_STATUSES = ['pending', 'confirmed'];
// A technician is on the way to, or at, a visit of the plan (the statuses the bar's re-price tool reads the same way).
const IN_PROGRESS_STATUSES = ['en_route', 'on_site', 'in_progress'];
// A first visit nearer than this stays as booked, and no new visit is placed nearer than this.
const KEEP_DAYS = 7;
// The new schedule replaces the first pending visit only when it brings the next visit this much sooner.
const SOONER_BY_DAYS = 14;
const LEDGER_FAMILY = 'pest_control';
const LEDGER_SOURCE = 'frequency_change';
const DRY_RUN = Symbol('pest-frequency-dry-run');

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}
const notAvailable = (reason) => httpError(409, 'This change is not available online for this plan.', { code: 'FREQUENCY_CHANGE_UNAVAILABLE', reason });

const cents = (value) => (value == null || value === '' ? null : Math.round(Number(value) * 100));
const round2 = (value) => Math.round(value * 100) / 100;

// One choice, priced: the customer's own per-visit price moved along the engine's curve, in cents as the
// engine rounds a per-visit price (service-pricing.js). From quarterly the factor is the curve's own;
// from every two months it is the ratio of the two (monthly 0.78 over 0.88).
function pricedOption(plan, to) {
  const curve = PEST.frequencyDiscounts.v2;
  const perVisit = round2(plan.perVisit * curve[to] / curve[plan.frequency]);
  const visitsPerYear = PEST.frequencies[to];
  return { frequency: to, visitsPerYear, perVisit, perYear: round2(perVisit * visitsPerYear) };
}

// Any money or billing state on an upcoming visit that a new schedule must not touch: the Schedule screen's
// own re-price block reader (prepaid, annual term, card hold, card-request fee, a live invoice).
async function visitsHoldMoney(conn, visits) {
  const { findBillingCoveredVisits } = require('../routes/admin-schedule');
  return (await findBillingCoveredVisits(conn, visits, { liveInvoice: true })).size > 0;
}

async function hasAddonLines(conn, visitIds) {
  return !!(await conn('scheduled_service_addons').whereIn('scheduled_service_id', visitIds).first('id'));
}

// A price change the customer was told about and that is not applied yet (the yearly rate review) names the
// plan as it was; the office settles that one first.
async function hasOpenPriceNotice(conn, customerId) {
  return !!(await conn('price_change_notices').where({ customer_id: customerId }).whereNull('applied_at').first('id'));
}

async function hasAnnualPrepayTerm(conn, customerId) {
  const { refreshableTermsForCustomer } = require('./annual-prepay-renewals');
  return (await refreshableTermsForCustomer(customerId, conn)).length > 0;
}

// The customer's one general pest plan: its root, its upcoming visits and its catalog service, or the reason
// there is no plan this button can change.
async function readPlanRows(conn, customerId, catalog) {
  const today = etDateString();
  const upcomingPlanRows = () => conn('scheduled_services').where({ customer_id: customerId, is_recurring: true })
    .whereIn('status', UPCOMING_STATUSES).where('scheduled_date', '>=', today);
  const pestRows = await upcomingPlanRows().whereIn('service_id', catalog.map((row) => row.id)).select('id', 'recurring_parent_id');
  const rootIds = [...new Set(pestRows.map((row) => String(row.recurring_parent_id || row.id)))];
  if (rootIds.length !== 1) return { reason: rootIds.length ? 'several_plans' : 'no_plan' };

  const root = await conn('scheduled_services').where({ id: rootIds[0] }).first();
  if (!root) return { reason: 'plan_shape' };
  // A visit of this plan under way by its STATUS is not among the upcoming rows read below, whatever its
  // date (a visit never closed keeps the status): the plan waits until that visit is done.
  const underWay = await conn('scheduled_services')
    .where(function () { this.where('recurring_parent_id', root.id).orWhere('id', root.id); })
    .whereIn('status', IN_PROGRESS_STATUSES).first('id');
  if (underWay) return { reason: 'visit_under_way' };
  const frequency = root.recurring_pattern;
  const service = catalog.find((row) => row.service_key === CATALOG_KEY[frequency]);
  const visits = await upcomingPlanRows()
    .where(function () { this.where('recurring_parent_id', root.id).orWhere('id', root.id); })
    .orderBy('scheduled_date', 'asc').orderBy('created_at', 'asc');
  // An ongoing plan of the customer's own, on a cadence with its catalog service, every upcoming visit a
  // plain visit of that service: no payer, not a re-service, no live tracker. Not a plan whose first visit
  // was cancelled: the series price guard holds every extension of one (series-price-guards.js).
  const plain = [
    String(root.customer_id) === String(customerId), root.is_recurring, !root.recurring_parent_id, root.recurring_ongoing === true, !!service,
    root.status !== 'cancelled',
    ...visits.map((visit) => visit.recurring_pattern === frequency && String(visit.service_id) === String(service?.id)
      && !visit.payer_id && visit.is_callback !== true && (visit.track_state || 'scheduled') === 'scheduled'),
  ].every(Boolean);
  if (!plain) return { reason: 'plan_shape' };
  // A booster (an extra visit beside the cadence) and an add-on line keep their own dates and prices. A
  // follow-up visit linked to an upcoming visit (a call-booked second visit) leaves with it when that visit
  // is cancelled: the new schedule never replaces a visit that has one.
  const visitIds = visits.map((visit) => visit.id);
  const booster = await conn('scheduled_services').where({ recurring_parent_id: root.id, is_recurring: false })
    .whereIn('status', UPCOMING_STATUSES).where('scheduled_date', '>=', today).first('id');
  const linkedFollowUp = await conn('scheduled_services').whereIn('parent_service_id', visitIds).whereIn('status', UPCOMING_STATUSES).first('id');
  if (booster || linkedFollowUp || await hasAddonLines(conn, [root.id, ...visitIds])) return { reason: 'plan_shape' };
  const prices = [...new Set(visits.map((visit) => cents(visit.estimated_price)))];
  if (prices.length !== 1 || !(prices[0] > 0)) return { reason: 'visit_prices' };
  return { root, visits, service, frequency, perVisit: prices[0] / 100 };
}

// What keeps a plain plan on the office path: money on a visit, an annual prepay term, a price-change notice
// still to apply, or the one-touch account limits. The reason, or null.
async function officePathReason(conn, customerId, visits) {
  if (await visitsHoldMoney(conn, visits)) return 'visit_holds_money';
  if (await hasAnnualPrepayTerm(conn, customerId)) return 'annual_prepay';
  if (await hasOpenPriceNotice(conn, customerId)) return 'price_notice_open';
  const { accountCanOneTap } = require('./one-tap-purchase');
  return (await accountCanOneTap(customerId)) ? null : 'account';
}

// The customer's general pest plan as the button reads it, with its choices, or the reason it has none.
// `conn` is db for a look, or the change's transaction once its locks are held.
// PEST_FREQUENCY_CHANGE_CUSTOMER_ALLOWLIST only ever narrows the gate (the first production test).
async function readPlan(conn, customerId) {
  const allowlist = pestFrequencyChangeAllowlist();
  if (allowlist && !allowlist.has(String(customerId).toLowerCase())) return { plan: null, reason: 'allowlist' };
  const customer = await conn('customers').where({ id: customerId }).whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'active', 'billing_mode', 'waveguard_tier', 'monthly_rate', 'per_application_fee');
  if (!customer || customer.active === false) return { plan: null, reason: 'customer' };
  const lane = resolveBillingLane(customer);
  if (!PER_VISIT_LANES.has(lane.mode)) return { plan: null, reason: 'billing_lane' };
  const catalog = await conn('services').whereIn('service_key', Object.values(CATALOG_KEY));
  const rows = await readPlanRows(conn, customerId, catalog);
  const reason = rows.reason || await officePathReason(conn, customerId, rows.visits);
  if (reason) return { plan: null, reason };

  const visitsPerYear = PEST.frequencies[rows.frequency];
  const plan = { customer, lane, ...rows, visitsPerYear, perYear: round2(rows.perVisit * visitsPerYear) };
  // A choice whose catalog service is missing or switched off is not offered.
  const sellable = (service) => !!service && service.is_active !== false && service.is_archived !== true;
  plan.options = MORE_VISITS[rows.frequency]
    .map((to) => ({ ...pricedOption(plan, to), service: catalog.find((row) => row.service_key === CATALOG_KEY[to]) }))
    .filter((option) => sellable(option.service));
  return { plan, reason: null };
}

const publicOption = ({ frequency, visitsPerYear, perVisit, perYear }) => ({ frequency, visitsPerYear, perVisit, perYear });

// GET: what the plan card shows. A plan with no choice left (monthly) still answers available, with no options.
async function status(customerId) {
  const { plan } = await readPlan(db, customerId);
  if (!plan) return { available: false };
  return { available: true, current: publicOption(plan), options: plan.options.map(publicOption) };
}

// The series template of the new plan: the catalog service, and one plain per-visit price with every stored
// discount field cleared. The same columns a price edit of a visit with no add-on line writes (admin-schedule.js
// computeSingleServiceEstimatedPricePlan); all of them, because the template overlay replaces only the keys
// it is given and the plan's first visit may carry a structured price.
function templateFields(option) {
  return {
    service_type: option.service.name,
    service_id: option.service.id,
    service_key_snapshot: option.service.service_key,
    service_category_snapshot: option.service.category || null,
    is_callback: false,
    estimated_price: option.perVisit,
    primary_line_price: option.perVisit,
    discount_type: null, discount_amount: null, discount_dollars: null, discount_id: null, discount_name: null,
    discount_service_key_filter: null, discount_service_category_filter: null, discount_max_dollars: null,
    line_discount_id: null, line_discount_name: null, line_discount_type: null, line_discount_amount: null, line_discount_dollars: null,
  };
}

// What the customer is shown and what a change wrote, in one shape. `version` names exactly this outcome:
// the plan, the choice and its price, the visit kept, the visits replaced and the dates booked.
function outcomeOf(plan, option, change) {
  const newVisits = change.spawnedVisits.map((visit) => dateOnlyString(visit.scheduledDate)).sort();
  const keptVisit = change.kept ? { date: change.kept.date, perVisit: plan.perVisit } : null;
  const replacedVisits = change.cancelled.map((visit) => visit.date);
  const version = crypto.createHash('sha256').update(JSON.stringify({
    root: String(plan.root.id), from: plan.frequency, fromPrice: cents(plan.perVisit), to: option.frequency, toPrice: cents(option.perVisit),
    service: String(option.service.id), kept: change.kept ? [String(change.kept.id), change.kept.date] : null,
    replaced: change.cancelled.map((visit) => [String(visit.id), visit.date]), newVisits,
  })).digest('hex');
  return { ...publicOption(option), today: publicOption(plan), keptVisit, replacedVisits, newVisits, version };
}

// The customer's own money fields, moved with the plan inside the change's transaction (the top-up holds
// the customer row lock). Neither bills a per-visit customer's priced visit (billing-lane.js
// completionInvoiceAmount), so a step that cannot run leaves both as they were and the office notice says so.
async function moveCustomerMoneyFields(trx, plan, option) {
  const moved = { perApplicationFee: false, monthlyRate: null };
  if (plan.lane.mode !== 'per_application') return moved;
  const customer = await trx('customers').where({ id: plan.customer.id }).first('per_application_fee', 'monthly_rate');
  // The acceptance-stamped fee is the fallback price of an unpriced visit: it follows only when it was this plan's price.
  if (cents(customer.per_application_fee) === cents(plan.perVisit)) {
    await trx('customers').where({ id: plan.customer.id }).update({ per_application_fee: option.perVisit, updated_at: new Date() });
    moved.perApplicationFee = true;
  }
  const previousScalar = round2(Number(customer.monthly_rate) || 0);
  if (previousScalar <= 0) return moved;
  const newScalar = round2(previousScalar + (option.perYear - plan.perYear) / 12);
  try {
    // A savepoint: a refused line edit (a held service, an unsplit ledger) undoes only itself.
    await trx.transaction(async (sp) => {
      await PlanRateLedger.setLineForScalarWrite(sp, plan.customer.id, { familyKey: LEDGER_FAMILY, previousScalar, newScalar }, { source: LEDGER_SOURCE });
      await sp('customers').where({ id: plan.customer.id }).update({ monthly_rate: newScalar, updated_at: new Date() });
    });
    moved.monthlyRate = { from: previousScalar, to: newScalar };
  } catch (err) {
    logger.warn(`[pest-frequency] plan rate left unchanged for customer ${plan.customer.id}: ${err.code || err.name || 'error'}`);
  }
  return moved;
}

async function recordChange(trx, { plan, option, outcome, change, money, consent }) {
  const summary = {
    series_root_id: String(plan.root.id), from: plan.frequency, to: option.frequency,
    per_visit_before: plan.perVisit, per_visit_after: option.perVisit, per_year_before: plan.perYear, per_year_after: option.perYear,
    kept_visit: outcome.keptVisit, replaced_visit_ids: change.cancelled.map((visit) => String(visit.id)),
    new_visit_ids: change.spawnedVisits.map((visit) => String(visit.scheduledServiceId)), new_visit_dates: outcome.newVisits,
    per_application_fee_moved: money.perApplicationFee, monthly_rate: money.monthlyRate, version: outcome.version,
  };
  // The staff-facing line in the customer's activity, and the consent record (who, when, from where).
  await trx('activity_log').insert({
    customer_id: plan.customer.id,
    action: 'pest_frequency_changed',
    description: `Customer changed pest control from ${CADENCE_WORDS[plan.frequency]} to ${CADENCE_WORDS[option.frequency]} in the portal: $${plan.perVisit.toFixed(2)} to $${option.perVisit.toFixed(2)} a visit; ${change.cancelled.length} visit(s) replaced, ${change.spawnedVisits.length} booked`,
    metadata: JSON.stringify(summary),
  });
  await auditPestFrequencyChange({ customerId: plan.customer.id, seriesRootId: plan.root.id, metadata: summary, ...consent, trx });
}

// One office notice per change (decision page: "The office gets one notice for each change"). An FYI that is
// kept as a row and rings, like a customer's own contact-details change (contact-correction.js). Best-effort.
async function notifyOffice({ plan, option, outcome, money }) {
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction, fullName } = require('./admin-alert-names');
    const rate = money.monthlyRate
      ? `Monthly rate on the customer record: $${money.monthlyRate.from.toFixed(2)} to $${money.monthlyRate.to.toFixed(2)}.`
      : 'The monthly rate on the customer record was not changed.';
    await raiseAdminAlert('schedule', {
      area: 'Schedule',
      action: fitAction('Schedule', fullName(plan.customer), [
        (who) => `${who} changed how often we visit`,
        (who) => `${who} changed visit frequency`,
      ]),
      why: `Pest control is now ${CADENCE_WORDS[option.frequency]} at $${option.perVisit.toFixed(2)} a visit, changed in the portal.`,
      severity: 'fyi',
      link: `/admin/customers?customerId=${encodeURIComponent(plan.customer.id)}`,
      subject: { type: 'customer', id: String(plan.customer.id) },
      doneWhen: 'already_done',
      who: 'person',
    }, {
      bell: true,
      fyiRow: true,
      dedupeKey: `pest-frequency-change:${outcome.version}`,
      detail: [
        `Before: ${CADENCE_WORDS[plan.frequency]}, $${plan.perVisit.toFixed(2)} a visit, $${plan.perYear.toFixed(2)} a year.`,
        `Now: ${CADENCE_WORDS[option.frequency]}, $${option.perVisit.toFixed(2)} a visit, $${option.perYear.toFixed(2)} a year.`,
        outcome.keptVisit ? `The ${outcome.keptVisit.date} visit stays as booked at $${outcome.keptVisit.perVisit.toFixed(2)}.` : null,
        outcome.replacedVisits.length ? `Replaced visits: ${outcome.replacedVisits.join(', ')}.` : null,
        `New visits: ${outcome.newVisits.join(', ')}.`,
        rate,
        'Nothing was charged and no message went to the customer.',
      ].filter(Boolean).join(' '),
      metadata: { customerId: String(plan.customer.id), seriesRootId: String(plan.root.id) },
    });
  } catch (err) {
    logger.warn(`[pest-frequency] office notice failed for customer ${plan.customer.id}: ${err.code || err.name || 'error'}`);
  }
}

function chosenOption(read, to) {
  const option = read.plan?.options.find((candidate) => candidate.frequency === to);
  if (!option) throw notAvailable(read.reason || 'choice');
  return option;
}

// The change itself. A look first (which plan), then one transaction: the plan's locks in the top-up's
// order, the plan read again under them, the re-booking, and (a real change only) the money fields and the
// record. A dry run stops after the re-booking and rolls everything back.
async function run(customerId, to, { expectedVersion = null, consent = {} } = {}) {
  const dryRun = expectedVersion == null;
  const seen = await readPlan(db, customerId);
  chosenOption(seen, to);
  const Schedule = require('../routes/admin-schedule');
  const claimToken = dryRun ? null : require('./job-status').nextClaimTs();
  let done = null;
  try {
    await db.transaction(async (trx) => {
      await Schedule.acquireRecurringSeriesMaintenanceLock(trx, seen.plan.root.id);
      await lockCustomerComms(trx, customerId);
      const read = await readPlan(trx, customerId);
      const option = chosenOption(read, to);
      const { plan } = read;
      if (String(plan.root.id) !== String(seen.plan.root.id)) throw notAvailable('plan_changed');
      const change = await Schedule.changeSeriesFrequencyWithLocks(trx, plan.root.id, {
        pattern: to, templateFields: templateFields(option), keepDays: KEEP_DAYS, soonerByDays: SOONER_BY_DAYS, claimToken, dryRun,
      });
      const outcome = outcomeOf(plan, option, change);
      done = { plan, option, change, outcome };
      if (dryRun) throw DRY_RUN;
      if (outcome.version !== expectedVersion) {
        throw httpError(409, 'Your schedule changed since you looked at it. Please review the new dates.', { code: 'PREVIEW_CHANGED' });
      }
      done.money = await moveCustomerMoneyFields(trx, plan, option);
      await recordChange(trx, { ...done, consent });
    });
  } catch (err) {
    if (err === DRY_RUN) return done;
    // The schedule's own refusals are worded for the office: the customer gets the one neutral answer,
    // and the reason goes to the log.
    const scheduleRefusal = (err.status === 409 || err.statusCode === 409)
      && err.code !== 'PREVIEW_CHANGED' && err.code !== 'FREQUENCY_CHANGE_UNAVAILABLE';
    if (!scheduleRefusal) throw err;
    logger.info(`[pest-frequency] customer ${customerId}: the schedule refused the change (${err.code || 'conflict'})`);
    throw notAvailable(err.code || 'schedule');
  }
  return done;
}

// POST preview: the outcome of the choice, with nothing written.
async function preview(customerId, to) {
  return (await run(customerId, to)).outcome;
}

// POST confirm: the change, when its outcome is the one the customer was shown.
async function confirm(customerId, to, { version, ip = null, userAgent = null } = {}) {
  if (typeof version !== 'string' || !version) throw httpError(400, 'version required');
  const done = await run(customerId, to, { expectedVersion: version, consent: { ip, userAgent } });
  const Schedule = require('../routes/admin-schedule');
  await Schedule.settleSeriesFrequencyChange(done.change);
  await notifyOffice(done);
  logger.info(`[pest-frequency] customer ${customerId}: ${done.plan.frequency} to ${to}; ${done.change.cancelled.length} replaced, ${done.change.spawnedVisits.length} booked`);
  return { success: true, ...done.outcome };
}

module.exports = {
  status, preview, confirm,
  _private: { readPlan, pricedOption, templateFields, outcomeOf, moveCustomerMoneyFields, KEEP_DAYS, SOONER_BY_DAYS, CATALOG_KEY },
};
