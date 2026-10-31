/**
 * Inbound referral confirm (GATE_REFERRAL_INBOUND_CONFIRM, owner 2026-10-26
 * "YES GO"): a plan customer who came in through a referral link or named a
 * referrer on the first call is listed on the Referrals queue. The office
 * confirms the referrer (services/referral-inbound.js makes the referral row
 * then) or marks the customer "not a referral".
 *
 * referral_inbound_reviews keeps that answer so the customer is never listed
 * again. One row per answer; ids and who only.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('referral_inbound_reviews')) return;
  await knex.schema.createTable('referral_inbound_reviews', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // The referred customer (the friend), not the referrer.
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('outcome', 20).notNullable();
    // The referral row a confirm made; null for a dismissal.
    t.uuid('referral_id').references('id').inTable('referrals').onDelete('SET NULL');
    t.uuid('reviewed_by'); // technicians.id of the admin
    t.timestamp('reviewed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index('customer_id');
  });
  await knex.raw(`
    ALTER TABLE referral_inbound_reviews
      ADD CONSTRAINT referral_inbound_reviews_outcome_check
      CHECK (outcome IN ('confirmed', 'dismissed'))
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('referral_inbound_reviews');
};
