exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.boolean('auto_share_social').notNullable().defaultTo(true);
    table.boolean('shared_to_social').notNullable().defaultTo(false);
    table.timestamp('shared_at', { useTz: true });
    table.string('social_share_status', 16).notNullable().defaultTo('pending');
    table.timestamp('social_share_attempted_at', { useTz: true });
    table.text('social_share_error');
    table.jsonb('social_share_result');
  });

  // Already-sent rows should not become eligible for social sharing.
  await knex('newsletter_sends')
    .whereNotNull('sent_at')
    .update({
      auto_share_social: false,
      social_share_status: 'skipped',
    });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.dropColumn('auto_share_social');
    table.dropColumn('shared_to_social');
    table.dropColumn('shared_at');
    table.dropColumn('social_share_status');
    table.dropColumn('social_share_attempted_at');
    table.dropColumn('social_share_error');
    table.dropColumn('social_share_result');
  });
};
