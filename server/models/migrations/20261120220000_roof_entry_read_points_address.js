'use strict';

/**
 * roof_entry_reads.points_address (owner ruling 2026-11-20, choice 4A): the read's estimate's address at the moment the
 * technician's points were last saved (saveTechCount writes it in the same statement as the points). A send freezes the
 * points onto the customer estimate only while the estimate still has this address (estimate-roof-points.js), so an
 * estimate moved to another home never shows the old roof. Null = no points saved since this column existed: such a read
 * is never frozen until its points are saved again.
 * Additive and idempotent (hasColumn guards both ways).
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('roof_entry_reads', 'points_address')) return;
  await knex.schema.alterTable('roof_entry_reads', (t) => {
    t.text('points_address').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('roof_entry_reads', 'points_address'))) return;
  await knex.schema.alterTable('roof_entry_reads', (t) => {
    t.dropColumn('points_address');
  });
};
