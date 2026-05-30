exports.up = async function up(knex) {
  if (await knex.schema.hasTable('referral_program_settings')) {
    await knex('referral_program_settings')
      .where({ id: 1 })
      .where(function currentDefaultOnly() {
        this.where('referrer_reward_cents', 5000).orWhereNull('referrer_reward_cents');
      })
      .update({
        referrer_reward_cents: 2500,
        updated_at: knex.fn.now(),
      });
  }

  if (await knex.schema.hasTable('referral_settings')) {
    await knex('referral_settings')
      .where({ key: 'reward_per_referral_cents', value: '5000' })
      .update({
        value: '2500',
        updated_at: knex.fn.now(),
      });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('referral_program_settings')) {
    await knex('referral_program_settings')
      .where({ id: 1, referrer_reward_cents: 2500 })
      .update({
        referrer_reward_cents: 5000,
        updated_at: knex.fn.now(),
      });
  }

  if (await knex.schema.hasTable('referral_settings')) {
    await knex('referral_settings')
      .where({ key: 'reward_per_referral_cents', value: '2500' })
      .update({
        value: '5000',
        updated_at: knex.fn.now(),
      });
  }
};
