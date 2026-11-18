/**
 * Referral code a customer typed on their estimate page (owner-approved
 * 2026-11-18, GATE_ESTIMATE_REFERRAL_CODE).
 *
 * The row is referral evidence, the third kind beside a referral link and a
 * referrer named on the first call (services/referral-inbound.js reads it).
 * It moves no money and holds no status: the answer lives where every
 * inbound referral's does, in referral_inbound_reviews and referrals.
 *
 * ONE code per estimate, ever (unique estimate_id).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('estimate_referral_codes')) return;
  await knex.schema.createTable('estimate_referral_codes', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('estimate_id').notNullable().unique()
      .references('id').inTable('estimates').onDelete('CASCADE');
    // As the referrer's record spells it.
    t.string('code', 32).notNullable();
    t.timestamps(true, true);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('estimate_referral_codes');
};
