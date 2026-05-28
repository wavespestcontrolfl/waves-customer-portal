/**
 * protected_pages — the do-not-auto-optimize registry. The autonomous content
 * engine must never draft over money pages, high-traffic pages, high-conversion
 * pages, legally sensitive pages, or anything manually protected. Money-page
 * URL families are also matched by pattern in protected-pages.js, but this
 * table captures the data-driven (high-traffic / high-conversion) and manual
 * entries that patterns can't express.
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('protected_pages');
  if (exists) return;
  await knex.schema.createTable('protected_pages', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('page_url').notNullable().unique();
    t.string('reason', 32).notNullable()
      .checkIn(['money_page', 'high_traffic', 'high_conversion', 'legal', 'strategic', 'manual']);
    t.string('added_by', 60).defaultTo('system');
    t.text('notes');
    t.jsonb('signal_metadata').notNullable().defaultTo('{}'); // impressions/clicks at time of auto-add
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['reason'], 'protected_pages_reason_idx');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('protected_pages');
};
