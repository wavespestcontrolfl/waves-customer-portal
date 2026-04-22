/**
 * Estimate view log — one row per open of /estimate/:token.
 *
 * `estimates.viewed_at` + `view_count` + `last_viewed_at` already exist and
 * capture aggregate engagement. This table captures every individual open
 * (ip + user_agent) for the Estimates v2 status-pills spec so we can render
 * per-viewer history and feed future engagement scoring.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('estimate_views', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
    t.timestamp('viewed_at').notNullable().defaultTo(knex.fn.now());
    t.string('ip', 64);
    t.text('user_agent');
    t.index(['estimate_id', 'viewed_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('estimate_views');
};
