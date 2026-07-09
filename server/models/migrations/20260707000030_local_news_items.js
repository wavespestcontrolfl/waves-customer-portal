/**
 * Bank for the Learn tab's Local Suncoast News card.
 *
 * Upstream publisher RSS feeds only carry each outlet's most recent items,
 * and the strict relevance filter passes few of them — served straight from
 * the feeds, the card drains back to "0 items" as stories rotate out.
 * Stories that pass the filter are persisted here at ingest so
 * /api/feed/local can always serve the newest N ever seen.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('local_news_items')) return;
  await knex.schema.createTable('local_news_items', (table) => {
    table.increments('id').primary();
    // Canonical article URL (safeLink-validated at ingest) — the dedupe key
    // across feed refreshes.
    table.text('link').notNullable().unique();
    table.text('title').notNullable();
    table.text('description').notNullable().defaultTo('');
    table.text('image');
    table.text('source_name').notNullable();
    table.timestamp('pub_date', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['pub_date'], 'local_news_items_pub_date_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('local_news_items');
};
