/**
 * Tracks per-promoter referral invites for double-tap / cooldown protection.
 * Lets POST /api/referrals/invite dedupe identical sends within 24h.
 */
exports.up = async function(knex) {
  const exists = await knex.schema.hasTable('referral_invites');
  if (exists) return;

  await knex.schema.createTable('referral_invites', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('promoter_id').notNullable();
    t.string('phone', 32).notNullable();
    t.timestamp('sent_at').notNullable().defaultTo(knex.fn.now());
    t.index(['promoter_id', 'phone', 'sent_at'], 'idx_referral_invites_promoter_phone_time');
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('referral_invites');
};
