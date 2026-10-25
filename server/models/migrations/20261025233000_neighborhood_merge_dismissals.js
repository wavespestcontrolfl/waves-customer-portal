/**
 * Suggested merges on the Gate codes page (GATE_NEIGHBORHOOD_MERGE, owner
 * ruling 2026-10-25: "suggested merges list ... a person always taps it").
 *
 * The page lists entries whose names read as one community (a phase, a
 * spelling, "X at Y"); the office merges one or marks the pair "not the same".
 * neighborhood_merge_dismissals keeps that answer so the pair is never
 * suggested again. One row per (merged-away, kept) pair; ids and who only.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('neighborhood_merge_dismissals')) return;
  await knex.schema.createTable('neighborhood_merge_dismissals', (t) => {
    t.uuid('source_id').notNullable().references('id').inTable('neighborhoods').onDelete('CASCADE');
    t.uuid('target_id').notNullable().references('id').inTable('neighborhoods').onDelete('CASCADE');
    t.uuid('dismissed_by'); // technicians.id of the admin
    t.timestamp('dismissed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['source_id', 'target_id']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('neighborhood_merge_dismissals');
};
