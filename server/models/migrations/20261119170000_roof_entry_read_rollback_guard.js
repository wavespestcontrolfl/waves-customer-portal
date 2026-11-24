'use strict';

/**
 * Rollback guard for roof_entry_reads (GATE_ROOF_ENTRY_READ, owner 2026-11-19). It changes nothing going up. It exists only
 * for its down.
 *
 * The problem: migration 20261119160000 replaced the copy index (keyed on the nullable estimate / customer foreign keys)
 * with one on the immutable context_key. Its down recreates the OLD index, which can fail: deleting an estimate sets the
 * foreign key null (ON DELETE SET NULL), so two copies of one source, (A, C) and (null, C), can end up with equal old-style
 * keys. The frozen 160000 down cannot be edited, so this migration's down runs first and detaches the colliding copies.
 *
 * Down: for every copy that has an older copy of the same source with the same estimate/customer (as the old index reads
 * them, null = ''), clear its source_id. No row is deleted and no technician count or flags are touched; only the duplicate
 * loses its link to the paid read it copied, which the pre-160000 application code does not use. Of two colliding rows the
 * one with the lower id keeps its link.
 *
 * Ordering: knex rolls the LAST batch back in reverse file order, so this down runs before 160000's down when both are in
 * that batch (a rollback of the batch that ran them together), or when this migration is the newer one and is rolled back
 * first (a later batch). If 160000 were somehow rolled back while this one stays applied, run this down first.
 */
exports.up = async function up() {
  // Intentionally empty: nothing to add. See the header.
};

exports.down = async function down(knex) {
  await knex.raw(`
    UPDATE roof_entry_reads r
       SET source_id = NULL
     WHERE r.source_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM roof_entry_reads o
          WHERE o.source_id = r.source_id
            AND o.id < r.id
            AND COALESCE(o.estimate_id::text, '') = COALESCE(r.estimate_id::text, '')
            AND COALESCE(o.customer_id::text, '') = COALESCE(r.customer_id::text, '')
       )
  `);
};
