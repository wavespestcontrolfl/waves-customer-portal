/**
 * Reshape knowledge_bridge to the schema its consumers were written for.
 *
 * Migration 000015 created knowledge_bridge with a generic source/target
 * shape; 000018 intended to create the kb_entry_id/wiki_entry_id shape but
 * its create was skipped by an hasTable guard — in EVERY environment. All
 * three consumers (knowledge-bridge.js, agronomic-wiki.js,
 * lawn-intelligence.js) target the 000018 shape, so every bridge read and
 * write has thrown "column does not exist" since April. Verified 2026-07-18:
 * prod knowledge_bridge holds ZERO rows (every writer failed), so a
 * drop-and-recreate loses nothing. If any environment unexpectedly holds
 * rows, they are preserved under knowledge_bridge_v1_orphaned instead of
 * dropped.
 *
 * Post-deploy the table self-populates: the daily syncToClaudeopediaIfDue
 * cron creates data_enrichment links, and admin-triggered autoLink fills
 * product/condition/seasonal links.
 */

async function createIntendedShape(knex) {
  await knex.schema.createTable('knowledge_bridge', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Claudeopedia side
    t.uuid('kb_entry_id').references('id').inTable('knowledge_base').onDelete('CASCADE');
    t.string('kb_slug', 200);

    // Agronomic Wiki side
    t.uuid('wiki_entry_id').references('id').inTable('knowledge_entries').onDelete('CASCADE');
    t.string('wiki_slug', 200);

    // 'product_reference' | 'condition_treatment' | 'protocol_outcome' |
    // 'seasonal_guide' | 'cross_reference' | 'data_enrichment'
    t.string('link_type', 50).notNullable();

    t.decimal('relevance_score', 3, 2).defaultTo(0.5);
    t.text('link_reason');
    t.string('created_by', 50).defaultTo('system');
    t.boolean('bidirectional').defaultTo(true);

    t.timestamps(true, true);

    t.unique(['kb_entry_id', 'wiki_entry_id', 'link_type']);
    t.index(['kb_entry_id']);
    t.index(['wiki_entry_id']);
    t.index(['link_type']);
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_bridge'))) {
    await createIntendedShape(knex);
    return;
  }
  if (await knex.schema.hasColumn('knowledge_bridge', 'kb_entry_id')) return; // already reshaped

  const [{ count }] = await knex('knowledge_bridge').count('* as count');
  if (parseInt(count, 10) > 0) {
    console.warn(`[knowledge_bridge reshape] preserving ${count} unexpected v1 row(s) as knowledge_bridge_v1_orphaned`);
    await knex.schema.renameTable('knowledge_bridge', 'knowledge_bridge_v1_orphaned');
  } else {
    await knex.schema.dropTable('knowledge_bridge');
  }
  await createIntendedShape(knex);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('knowledge_bridge')) {
    if (!(await knex.schema.hasColumn('knowledge_bridge', 'kb_entry_id'))) return; // not ours
    await knex.schema.dropTable('knowledge_bridge');
  }
  if (await knex.schema.hasTable('knowledge_bridge_v1_orphaned')) {
    await knex.schema.renameTable('knowledge_bridge_v1_orphaned', 'knowledge_bridge');
    return;
  }
  // Recreate the 000015 source/target shape so the pre-migration state holds.
  await knex.schema.createTable('knowledge_bridge', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('source_type', 30).notNullable();
    t.uuid('source_id').notNullable();
    t.string('source_title', 300);
    t.string('target_type', 30).notNullable();
    t.uuid('target_id').notNullable();
    t.string('target_title', 300);
    t.string('link_type', 30).notNullable();
    t.decimal('confidence', 3, 2).defaultTo(0.5);
    t.boolean('auto_linked').defaultTo(true);
    t.timestamps(true, true);
    t.unique(['source_type', 'source_id', 'target_type', 'target_id']);
    t.index(['link_type']);
    t.index(['source_type', 'source_id']);
  });
};
