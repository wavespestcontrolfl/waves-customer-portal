/**
 * Referral Credit estimator preset: $50 → $25.
 *
 * 20260529000006_referral_rewards_25_25 moved the live referral program
 * (referral_settings.referrer_reward_cents + referee credit) from $50/$50
 * to $25/$25, but the `discounts` catalog row behind the estimator's
 * manual-discount preset picker kept the original $50 seed — so the
 * estimate builder was still offering "Referral Credit — $50.00" while
 * every other surface (portal referral tab, invite SMS/email, dispatch
 * completion credit) pays $25 (owner report 2026-07-11).
 *
 * Guarded to the stale seed value: a row an operator already corrected
 * through the admin discount library is left alone.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('discounts'))) return;
  await knex('discounts')
    .where({ discount_key: 'referral', amount: 50 })
    .update({
      amount: 25,
      description: '$25 credit for each successful referral',
      updated_at: new Date(),
    });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('discounts'))) return;
  await knex('discounts')
    .where({ discount_key: 'referral', amount: 25 })
    .update({
      amount: 50,
      description: '$50 credit for each successful referral',
      updated_at: new Date(),
    });
};
