// Canonical "is a real customer" pipeline stages — shared so every KPI surface
// (dashboard tiles, Intelligence Bar, BI agent) counts customers the same way
// and can't drift. `customers.active` defaults to TRUE for CRM lead rows, so it
// does NOT distinguish customers from leads; pipeline_stage does. Mirrors the
// app's existing real-customer predicate (admin-customers.js, pipeline-manager.js,
// document-template-bulk-send.js) — owner-confirmed.
//
// NOTE: this excludes booked customers still stuck at new_lead (the lead-book
// reuse path doesn't promote pipeline_stage) — tracked as a data follow-up
// (promote stage on booking + backfill + persist customer_since).
const CUSTOMER_STAGES = ['active_customer', 'won', 'at_risk'];

const { etDateString } = require('../utils/datetime-et');

// A live customer right now = in a customer stage AND active AND not soft-deleted.
function whereLiveCustomer(qb) {
  return qb.where('active', true).whereNull('deleted_at').whereIn('pipeline_stage', CUSTOMER_STAGES);
}

// Conversion date for KPI windows (an ET DATE): member_since (the "became a
// customer" date) when set, else created_at as an ET date. The fallback is
// defensive — most customer-creation paths stamp member_since (book route,
// estimate-converter, stage routes, IB tools), but new/other paths (e.g.
// quick-add, imports) may not, and for a directly-created customer created_at IS
// the conversion date. So a row is never silently dropped from new-customer /
// retention / acquisition windows. created_at is timestamptz → AT TIME ZONE once.
const CONVERSION_DATE_SQL = "COALESCE(member_since, (created_at AT TIME ZONE 'America/New_York')::date)";

// Booking always means an ACTIVE customer — the promotion every booking path
// owes the customer row when a lead converts (mirrors the admin-leads
// schedule-appointment route; shared so the paths can't drift):
//  1) stage promotion only when still in a lead/churned stage — the create
//     paths insert 'won' directly and a live-stage customer is left alone;
//     member_since keeps a former customer's real start (churned/dormant
//     re-booking) but overwrites a lead's intake date with today's ET date.
//  2) reactivation — always flip a deactivated or churn-stamped row back to
//     active and clear churn, even one already in a customer stage.
// `database` is the knex instance or an open transaction; returns whether a
// write happened. No internal try/catch: inside a transaction a swallowed SQL
// error would leave the txn aborted and doom the commit — callers own
// containment.
async function promoteCustomerOnBooking(database, customerId) {
  if (!customerId) return false;
  const customer = await database('customers')
    .where({ id: customerId })
    .first('id', 'pipeline_stage', 'member_since', 'active', 'churned_at');
  if (!customer) return false;
  const inCustomerStage = CUSTOMER_STAGES.includes(customer.pipeline_stage);
  const updates = {};
  if (!inCustomerStage) {
    updates.pipeline_stage = 'won';
    updates.pipeline_stage_changed_at = new Date();
    updates.member_since = ['churned', 'dormant'].includes(customer.pipeline_stage)
      ? (customer.member_since || etDateString())
      : etDateString();
  }
  if (!inCustomerStage || customer.active === false || customer.churned_at) {
    updates.active = true;
    updates.churned_at = null;
    updates.churn_reason = null;
  }
  if (!Object.keys(updates).length) return false;
  updates.updated_at = new Date();
  await database('customers').where({ id: customerId }).update(updates);
  return true;
}

module.exports = { CUSTOMER_STAGES, whereLiveCustomer, CONVERSION_DATE_SQL, promoteCustomerOnBooking };
