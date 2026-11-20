'use strict';

/**
 * estimate_roof_points: the technician-confirmed roof points frozen onto a customer estimate when it is sent (owner
 * ruling 2026-11-20, choice 4A). One row per estimate; a re-send replaces it, and a send with no confirmed points
 * deletes it.
 *   snapshot   { imageUrl, imageYear, pins: [{ n, x, y, type, label, action }] }: exactly what the customer page prints,
 *              copied from roof_entry_reads at send time so a later re-read, edit or label change never alters a sent
 *              estimate.
 *   read_id    the roof_entry_reads row the snapshot came from. Staff hiding that read hides the points at once (the
 *              page checks hide_on_estimate now); SET NULL keeps the frozen row if the read is ever deleted, and the
 *              page then shows it (nothing left to hide it with).
 *   address    the estimate's address at send time; the page prints nothing when the estimate has since moved.
 * Additive and idempotent. down() drops the table: the rows are copies, the source reads stay in roof_entry_reads.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('estimate_roof_points')) return;
  await knex.schema.createTable('estimate_roof_points', (table) => {
    table.uuid('estimate_id').primary().references('id').inTable('estimates').onDelete('CASCADE');
    table.uuid('read_id').nullable().references('id').inTable('roof_entry_reads').onDelete('SET NULL');
    table.text('address').nullable();
    table.jsonb('snapshot').notNullable();
    table.timestamp('frozen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('estimate_roof_points');
};
