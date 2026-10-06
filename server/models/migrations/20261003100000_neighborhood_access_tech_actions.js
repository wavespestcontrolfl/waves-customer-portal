/**
 * Neighborhood access: who in the field added a code, and who reported one
 * wrong (owner ruling 2026-10-03).
 *
 * A technician on an assigned visit may add a keypad code to that visit's
 * neighborhood (live at once) and mark a code wrong (it drops to
 * needs_confirm; the office decides whether to retire it). The office needs
 * to see who did either, so:
 *   - source_technician_id: the staff member who added the entry from a visit.
 *   - flagged_wrong_at / flagged_wrong_by: the newest "this code is wrong"
 *     report still standing. The office confirming, editing the value or
 *     retiring the entry clears it.
 *
 * Additive and nullable: nothing existing reads these columns.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('neighborhood_access', 'source_technician_id'))) {
    await knex.schema.alterTable('neighborhood_access', (t) => {
      t.uuid('source_technician_id').references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('flagged_wrong_at', { useTz: true });
      t.uuid('flagged_wrong_by').references('id').inTable('technicians').onDelete('SET NULL');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('neighborhood_access', 'source_technician_id')) {
    await knex.schema.alterTable('neighborhood_access', (t) => {
      t.dropColumn('flagged_wrong_by');
      t.dropColumn('flagged_wrong_at');
      t.dropColumn('source_technician_id');
    });
  }
};
