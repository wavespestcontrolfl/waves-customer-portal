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

module.exports = { CUSTOMER_STAGES, whereLiveCustomer, CONVERSION_DATE_SQL };
