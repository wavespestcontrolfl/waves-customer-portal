/**
 * estimates.show_one_time_option — per-estimate opt-in for the one-time
 * pricing toggle on the customer view.
 *
 * When false (default): customer sees recurring-only view (3-frequency
 * slider + monthly price). No mention of the one-time fee.
 *
 * When true: customer sees a segmented toggle [Recurring | One-time $X]
 * above the price card. Switching to One-time hides the slider + add-ons
 * and shows the one-time price + visit-date picker only. Accept-path
 * treats one-time differently (no onboarding session, no tier upgrade,
 * no recurring schedule creation).
 *
 * Rollout:
 *   - Admin flips per-estimate via IB tool toggle_show_one_time_option
 *   - Target: customers who explicitly want to weigh both options.
 *     Default-off = "recurring is our recommendation; don't distract."
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.boolean('show_one_time_option').notNullable().defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('show_one_time_option');
  });
};
