/**
 * Ranked alternates for the flagship lineup (owner spec 2026-07-28,
 * portfolio selector). The autopilot stores the next-best floor-passing
 * candidates alongside the locked event_ids so the proof diagnostics can
 * show them and a dead locked event has named replacements. Additive.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_sends');
  if (!hasTable) return;
  const has = await knex.schema.hasColumn('newsletter_sends', 'alternate_event_ids');
  if (!has) {
    await knex.schema.alterTable('newsletter_sends', (t) => t.jsonb('alternate_event_ids'));
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('newsletter_sends');
  if (!hasTable) return;
  const has = await knex.schema.hasColumn('newsletter_sends', 'alternate_event_ids');
  if (has) {
    await knex.schema.alterTable('newsletter_sends', (t) => t.dropColumn('alternate_event_ids'));
  }
};
