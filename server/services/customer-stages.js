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

// Stages meaning the row WAS a customer, so an existing member_since is their
// real start and every reactivation path must PRESERVE it (a member_since on a
// pre-sale lead stage is just an intake date and gets overwritten on
// conversion). Shared so booking promotion, proposal wins, estimate
// conversion, lead booking, IB edits, and the stage routes can't drift.
// ⚠️ Deliberately NOT used by churn analytics (retention cohort, churn
// pareto, MRR bridge churn attribution): `past_customer` is an archival
// label for stale/one-time relationships (owner ruling 2026-08-07), NOT a
// churn event — those surfaces stay keyed on churned/dormant + churned_at so
// bulk re-stages can never fake a churn spike.
const FORMER_CUSTOMER_STAGES = ['churned', 'past_customer', 'dormant'];

// customers.created_via — PROVENANCE of a machine-minted row, stamped by the
// creating path itself. Row SHAPE cannot carry this: several lead-creation
// paths write an address-less, ZIP-less, active new_lead row (the Twilio
// tracking webhook AND a form submitted without an address), so anything that
// must tell them apart has to read a stamp, not infer one. Consumers treat a
// NULL as "unknown provenance" and stay conservative.
const CREATED_VIA = {
  // routes/twilio-webhook.js domain/van tracking branch: the placeholder row
  // minted for an unknown number that just texted/called a tracking number,
  // before anyone knows who they are.
  TWILIO_TRACKING_SHELL: 'twilio_tracking_shell',
};

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

// Lifecycle field stamps to apply when a customer's pipeline_stage CHANGES —
// the single source of truth for member_since / churned_at / active
// consistency, shared by the admin stage routes, the general customer edit,
// and the Intelligence Bar single-update path (bulk mirrors it in SQL).
// `today` is the ET calendar date — member_since and churned_at are DATE
// columns, so a JS Date would land on the wrong day after ET midnight.
// Returns {} for a no-op (same-stage) save so it never resets
// pipeline_stage_changed_at or restamps churned_at on a churned→churned
// re-save.
function stageLifecycleStamps(oldStage, newStage, customer, { today, churnReason } = {}) {
  if (newStage === oldStage) {
    // No-op (same-stage) save: never restamp churned_at / pipeline_stage_changed_at,
    // but still let an admin correct/add a churn reason on an already-churned row.
    return (newStage === 'churned' && churnReason) ? { churn_reason: churnReason } : {};
  }
  const stamps = { pipeline_stage_changed_at: new Date() };
  if (newStage === 'churned') {
    // Always timestamp the churn so retention can see it; reason optional. Set
    // the reason explicitly (to the new value or null) so a stale reason from a
    // prior churn never carries over to a fresh one.
    stamps.churned_at = today;
    stamps.churn_reason = churnReason || null;
  } else {
    // Reactivation / any non-churned target: clear a stale churn stamp so a
    // reactivated customer never carries a leftover churned_at. Keyed on the
    // STAMP's presence, not just oldStage, since churned_at can exist on a
    // non-churned row (e.g. a deactivation backfill). EXCEPTION: moving to
    // past_customer is an archival relabel, not a reactivation — the real
    // cancellation history survives the filing change (codex #3282 P2); it
    // still clears later if the row genuinely reactivates out of the archive.
    if (newStage !== 'past_customer' && (oldStage === 'churned' || customer.churned_at)) {
      stamps.churned_at = null;
      stamps.churn_reason = null;
    }
    if (CUSTOMER_STAGES.includes(newStage)) {
      // Entering a live customer stage is a (re)activation: the row must be
      // live for whereLiveCustomer or the UI shows an active stage the
      // metrics can't see (codex #3282 audit P1 — churned rows archived as
      // past_customer kept active=false through a later stage reactivation).
      stamps.active = true;
      if (![...CUSTOMER_STAGES, ...FORMER_CUSTOMER_STAGES].includes(oldStage)) {
        // Converting from a lead stage → member_since is the conversion date,
        // overwriting any lead-intake date a capture path stamped earlier.
        stamps.member_since = today;
      } else if (!customer.member_since) {
        // Re-activating a former customer with no recorded start — best effort.
        stamps.member_since = today;
      }
    }
  }
  return stamps;
}

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
    updates.member_since = FORMER_CUSTOMER_STAGES.includes(customer.pipeline_stage)
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

module.exports = {
  CUSTOMER_STAGES, FORMER_CUSTOMER_STAGES, CREATED_VIA, whereLiveCustomer, CONVERSION_DATE_SQL,
  stageLifecycleStamps, promoteCustomerOnBooking,
};
