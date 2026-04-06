/**
 * Migration 067 — SEO Target Keywords enhancements
 *
 * Adds missing columns to seo_target_keywords for full CRUD management:
 *   current_position, best_position, has_content, content_url,
 *   search_volume (alias for monthly_volume), difficulty, status, notes
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('seo_target_keywords', t => {
    t.integer('current_position');
    t.integer('best_position');
    t.boolean('has_content').defaultTo(false);
    t.string('content_url', 500);
    t.integer('search_volume');            // duplicates monthly_volume for clarity
    t.integer('difficulty').defaultTo(0);  // 0-100
    t.string('status', 20).defaultTo('new'); // tracking, won, lost, new
    t.text('notes');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('seo_target_keywords', t => {
    t.dropColumn('current_position');
    t.dropColumn('best_position');
    t.dropColumn('has_content');
    t.dropColumn('content_url');
    t.dropColumn('search_volume');
    t.dropColumn('difficulty');
    t.dropColumn('status');
    t.dropColumn('notes');
  });
};
