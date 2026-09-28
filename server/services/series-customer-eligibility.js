// Table-driven customer eligibility for adding a recurring series' future
// visits without a person asking for that visit: the visit-count top-up
// (routes/admin-schedule.js#topupCustomerSkipReason) applies it, and the
// pest-rides-lawn preview (services/rider-series-preview.js) reads the same
// table so its verdicts match. One independent check per row, evaluated in
// order, so a new disqualifying condition is one more row, not one more `if`.
//
// service_paused_at is set two ways, and only one of them is a genuine
// scheduling hold (Codex GitHub round 2 P1). billing-cron sets it with
// reason 'autopay_final_failure' when the 3-retry ladder exhausts — that
// stops the DUES CRON only; migration 20260801200000 (billing-copy-no-
// false-interruption) is explicit that this reason has "no scheduling
// consumer" anywhere in the app, and visits continue on schedule. An
// operator can also set the SAME column by hand for a genuine whole-
// account hold (any OTHER reason value, e.g. the 2026-09-11 owner-directed
// pause) — billing-pause.js's own contract already draws this exact line
// ("ONLY 'autopay_final_failure' pauses auto-clear... a pause an operator
// set by hand is a human decision"). Reuse that constant rather than
// hand-rolling a second copy of the distinction. An unset/unknown reason
// on a paused row is treated as a hold (fail closed — never add visits for
// a customer someone paused without a legible, auto-clearable reason).
const { FORMER_CUSTOMER_STAGES } = require('./customer-stages');
const { AUTO_CLEARABLE_REASON } = require('./billing-pause');

const SERIES_CUSTOMER_COLUMNS = ['id', 'active', 'deleted_at', 'service_paused_at', 'service_pause_reason', 'pipeline_stage'];

const SERIES_CUSTOMER_INELIGIBILITY_RULES = [
  ['customer_deleted', (c) => !!c.deleted_at],
  ['customer_service_held', (c) => !!c.service_paused_at && c.service_pause_reason !== AUTO_CLEARABLE_REASON],
  ['customer_inactive', (c) => c.active === false],
  ['customer_churned', (c) => FORMER_CUSTOMER_STAGES.includes(c.pipeline_stage)],
];

function seriesCustomerSkipReason(customer) {
  if (!customer) return 'customer_not_found';
  const hit = SERIES_CUSTOMER_INELIGIBILITY_RULES.find(([, test]) => test(customer));
  return hit ? hit[0] : null;
}

// All-hits variant for the pest-rides-lawn preview (Codex P2 round on PR
// #5290): the top-up's own topupCustomerSkipReason stays first-hit
// (byte-identical, one skip reason is all a write path needs), but the
// preview's `reasons` array is documented to list EVERY applicable gate, not
// just the first — a customer can be both inactive AND churned, and an
// office list should show both rather than hide the second behind the
// first. Same rule set, same order, just not short-circuited.
function seriesCustomerSkipReasons(customer) {
  if (!customer) return ['customer_not_found'];
  return SERIES_CUSTOMER_INELIGIBILITY_RULES.filter(([, test]) => test(customer)).map(([reason]) => reason);
}

module.exports = {
  SERIES_CUSTOMER_COLUMNS,
  SERIES_CUSTOMER_INELIGIBILITY_RULES,
  seriesCustomerSkipReason,
  seriesCustomerSkipReasons,
};
