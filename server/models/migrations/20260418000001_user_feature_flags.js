/**
 * Per-user feature flag storage. Minimal schema: no percentage rollouts,
 * environments, or variants. One row per (user, flag_key). Absence = disabled.
 * See feedback_feature_flag_design memory for the design rules.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('user_feature_flags', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable();
    table.string('flag_key', 64).notNullable();
    table.boolean('enabled').notNullable().defaultTo(false);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['user_id', 'flag_key']);
    table.index('flag_key');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('user_feature_flags');
};
