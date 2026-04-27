/**
 * Drop now-inert user_feature_flags rows for the 12 retired V1→V2 +
 * limited-rollout flag keys. None of these keys are read by client
 * code anymore — see PR history for each retirement:
 *
 *   #297  dashboard-v2, customers-v2, estimates-v2, comms-v2,
 *         mobile-shell-v2, admin-shell-v2 (admin V1→V2 default)
 *   #302  ff_customer_login_v2, ff_customer_pay_v2,
 *         ff_customer_receipt_v2 (customer-facing V1 retirement)
 *   #304  dispatch-v2 (dispatch V1 retirement)
 *   #309  newsletter-v1 (newsletter rollout + consolidation)
 *   #310  credentials_v1 (credentials rollout)
 *
 * The rows were left in place during each retirement PR for "no
 * behavior change" minimum-scope discipline. This migration is the
 * cosmetic follow-up — there's no behavior change because the table
 * has an index on flag_key but no client code queries any of these
 * keys, so the rows just take up space in the per-user lookup.
 *
 * Idempotent: re-running deletes 0 rows.
 * Irreversible (down is a no-op) — the rows are gone for good but
 * also meaningless; nothing in the app cares.
 */

const RETIRED_FLAG_KEYS = [
  'dashboard-v2',
  'dispatch-v2',
  'customers-v2',
  'estimates-v2',
  'comms-v2',
  'mobile-shell-v2',
  'admin-shell-v2',
  'ff_customer_login_v2',
  'ff_customer_pay_v2',
  'ff_customer_receipt_v2',
  'newsletter-v1',
  'credentials_v1',
];

exports.up = async function (knex) {
  const deleted = await knex('user_feature_flags')
    .whereIn('flag_key', RETIRED_FLAG_KEYS)
    .del();
  console.log(
    `[20260427000002] Deleted ${deleted} inert user_feature_flags row(s) ` +
    `for retired keys: ${RETIRED_FLAG_KEYS.join(', ')}`
  );
};

exports.down = async function () {
  // Cosmetic cleanup migration — deleted rows are unrecoverable but
  // also irrelevant (no client code reads any of these keys). No-op.
};
