// May the app price, or offer, a NEW residential plan for this customer with
// nobody watching?
//
// planStartBlocker(database, customerId) answers null when no record in the
// database stands against it, or the first reason that does:
//   'not_live'    no such customer, an inactive account, or a deleted one
//   'commercial'  a commercial account or property (never a residential plan)
//   'has_plan'    the customer already holds a plan (customerHoldsPlan below)
// A failed read THROWS. An outage is never "nothing stands against it": the
// caller is a job that tries again, or a pricer that must return no price.
//
// It is a rule about the records of the account at the moment of the call. It
// does not decide who gets an offer on a given day (a former plan customer, a
// complaint, an open estimate, the wait after a job): those are the sender's
// rules. It takes no lock: a caller that writes (an accept, a mint) keeps its
// own guard at the write.
//
// The phone-yes accept has its own check for its own flow (existingPlan in
// call-phone-yes-accept.js: the membership, the two annual-prepay reads and
// the calendar, less the visit the accept is about). It is live and is not
// changed here.
const PLAN_START_BLOCKERS = Object.freeze(['not_live', 'commercial', 'has_plan']);

// A legacy plan visit that is live now. Such a visit carries no recurring flag
// (NULL) and a recurring_parent_id, and it is a plan visit all the same: the
// plan's own row rule counts it (isPlanSeriesRow in
// recurring-series-cancel-reseed.js; PLAN_ROW_SQL in rate-review.js is its SQL
// form), and that rule drops a free re-service callback and an included
// follow-up. "Live" is the calendar read's own row rule (isLiveObligationRow):
// not terminal, not a callback, not a one-time booking source, and today or
// later in Eastern time, or in progress now. The calendar read itself
// (loadLiveRecurringObligationRows) asks for is_recurring = true, so it never
// returns this shape.
async function hasLiveLegacyPlanVisit(database, customerId) {
  const { TERMINAL_STATUSES, isLiveObligationRow } = require('./waveguard-existing-services');
  const { isPlanSeriesRow } = require('./recurring-series-cancel-reseed');
  const { etDateString } = require('../utils/datetime-et');
  const rows = await database('scheduled_services')
    .where({ customer_id: customerId })
    .whereNull('is_recurring')
    .whereNotNull('recurring_parent_id')
    .whereNotIn('status', TERMINAL_STATUSES)
    .select('id', 'scheduled_date', 'status', 'source', 'is_recurring', 'recurring_parent_id', 'is_callback', 'followup_included');
  const today = etDateString();
  // Two rules, each from its owner: a plan row, and live. The plan's row rule
  // also holds the shape (a booster, or a row with no parent, is no plan row),
  // so the answer does not rest on the SQL filter alone.
  return rows.some((row) => isPlanSeriesRow(row) && isLiveObligationRow(row, today));
}

// Does the customer already hold a plan? `customer` is the customers row of a
// live account, as read from the database. Every record of a plan counts, and
// one alone is enough. Each is read by the module that owns it:
// - the account: a membership tier, or a legacy monthly rate with no tier, by
//   the predicate the setup-fee decision reads (isMembershipCustomerRow). Also
//   a monthly rate beside a tier value that names no plan ('None',
//   'One-Time'): that predicate reads such a row as "no plan", and a rate on
//   the account is a billed plan amount whatever the tier column says;
// - the calendar: any live recurring obligation, at any property. The test is
//   the live rows, never the owned keys: a recurring palm injection or a
//   termite bond maps to no service family and is still the customer's plan.
//   A legacy plan visit counts too (hasLiveLegacyPlanVisit). One row rule
//   judges both shapes (isLiveObligationRow), so a visit that rides a job
//   without being a plan visit (a callback, an included follow-up, a one-time
//   booking) is not a plan, whatever its flag says;
// - an ongoing series BETWEEN visits: its root says the plan goes on (a cancel
//   of the series clears the flag; the nightly top-up extends the series),
//   also on a day with no visit of it on the calendar. The top-up's own
//   selector, as the billing rules read it (unpricedOngoingSeries in
//   billing-mode-rules.js). A root the top-up skips today (a plan hold, an
//   annual prepay, a second series) is still a plan record, so the skip rules
//   are not applied;
// - the plan-rate ledger: any billed component, also one the ledger could not
//   name. The read asks for a strict table probe: with GATE_PLAN_RATE_LEDGER
//   off the ledger answers a failed probe as "no ledger", and here a billed
//   rate is evidence in either mode;
// - annual prepay: a term whose paid coverage is live, or a prepay invoice
//   still payable (a payment starts the term and seeds its visits), by the
//   churn guard's own two reads (customer-lifecycle-guard.js).
async function customerHoldsPlan(database, customer) {
  const existing = require('./waveguard-existing-services');
  if (existing.isMembershipCustomerRow(customer)) return true;
  // Any billed amount on the account, in whatever way the account is billed.
  // This asks "is there a plan record", fail closed. It does not sort the
  // account into a way of billing (that is resolveBillingLane's question).
  if (Number(customer.monthly_rate) > 0) return true;
  if ((await existing.loadLiveRecurringObligationRows(database, customer.id)).length) return true;
  if (await hasLiveLegacyPlanVisit(database, customer.id)) return true;
  const ongoingSeries = await require('./recurring-series-topup').eligibleSeriesParentIds(database, { customerId: customer.id });
  if (ongoingSeries.length) return true;
  const billedRates = (await require('./plan-rate-ledger').loadComponents(database, customer.id, { strictProbe: true }))
    .filter((row) => Number(row.monthly_rate) > 0);
  if (billedRates.length) return true;
  if (await require('./customer-lifecycle-guard').findActivePrepayTerm(database, customer.id)) return true;
  return Boolean(await require('./admin-cancellation').findPendingPrepayInvoice(customer.id, null, database));
}

async function planStartBlocker(database, customerId) {
  if (!database || !customerId) throw new Error('planStartBlocker needs a database handle and a customer id');
  const customer = await database('customers').where({ id: customerId }).first();
  // The live rule of the offer surfaces (resolvePortalOfferPremises in
  // service-report/cross-sell.js). The calendar read answers no row for an
  // inactive account, so the plan check below cannot answer for one.
  if (!customer || customer.active === false || customer.deleted_at) return 'not_live';
  // The account-level rule (the 'commercial' tier, or a commercial or business
  // property type) and the pricing engine's own rule for a property type. The
  // membership predicate reads the 'commercial' tier as "no plan", so without
  // this a commercial account between visits would read as a home with no
  // plan.
  const { isCommercialAccount } = require('./self-booking-plan-sync');
  const { isCommercialProperty } = require('./pricing-engine/commercial-helpers');
  if (isCommercialAccount(customer) || isCommercialProperty({ propertyType: customer.property_type })) return 'commercial';
  return (await customerHoldsPlan(database, customer)) ? 'has_plan' : null;
}

module.exports = { planStartBlocker, PLAN_START_BLOCKERS };
