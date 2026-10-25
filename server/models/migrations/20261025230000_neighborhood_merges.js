/**
 * Neighborhood merge (GATE_NEIGHBORHOOD_MERGE, owner 2026-10-25).
 *
 * One gated community often reaches the directory as several entries, one per
 * county plat name ("Country Club East Lwr", "Country Club East at Lakewood
 * Ranch"), so a gate code saved on one never shows at stops on the others.
 * The office merges an entry into another (services/neighborhood-merge.js):
 *
 *   - neighborhoods.merged_into_id: where a merged-away entry went. The row
 *     stays (inactive) so its name keeps matching the county and caller names;
 *     lockCommunity follows the pointer, so a new home with the old name lands
 *     on the entry it was merged into.
 *   - neighborhood_merges: one row per merge with the journal its undo needs
 *     (the homes, entries and ledger rows it moved, the labels and statuses it
 *     changed). Never a code or an address. One live (not undone) merge per
 *     merged-away entry.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('neighborhoods', 'merged_into_id'))) {
    await knex.schema.alterTable('neighborhoods', (t) => {
      t.uuid('merged_into_id').references('id').inTable('neighborhoods').onDelete('SET NULL');
      t.index(['merged_into_id']);
    });
  }
  if (!(await knex.schema.hasTable('neighborhood_merges'))) {
    await knex.schema.createTable('neighborhood_merges', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('source_id').notNullable().references('id').inTable('neighborhoods').onDelete('CASCADE');
      t.uuid('target_id').notNullable().references('id').inTable('neighborhoods').onDelete('CASCADE');
      // { properties: [id], entries: [{ id, gate_label }], retired: [{ id, status }], filings: [customer_id] }
      t.jsonb('journal').notNullable();
      t.uuid('merged_by'); // technicians.id of the admin; null when an ops script ran it
      t.timestamp('merged_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('undone_by');
      t.timestamp('undone_at', { useTz: true });
      t.index(['target_id']);
    });
    await knex.raw(
      'CREATE UNIQUE INDEX neighborhood_merges_live_source_uniq ON neighborhood_merges (source_id) WHERE undone_at IS NULL',
    );
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('neighborhood_merges');
  if (await knex.schema.hasColumn('neighborhoods', 'merged_into_id')) {
    await knex.schema.alterTable('neighborhoods', (t) => {
      t.dropIndex(['merged_into_id']);
      t.dropColumn('merged_into_id');
    });
  }
};
