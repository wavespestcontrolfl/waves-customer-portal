'use strict';

/**
 * roof_entry_reads.hide_on_estimate becomes one choice per estimate (owner ruling 2026-11-20, choice 4A, part 2).
 *
 * Part 1 saved the "show these points on the customer estimate" switch on one read. Part 2 saves it on every read of
 * the estimate and starts each new read with it, and the customer page hides the points when any read of the estimate
 * is hidden. Rows written under part 1 can disagree inside one estimate: the page would hide the points while the staff
 * panel, opened on a read that is not hidden, shows the switch on. This makes those rows agree, on the side the page
 * already takes: an estimate with a hidden read gets every read hidden. Reads with no estimate keep their own value.
 *
 * Idempotent (a second run finds nothing to change). down() does nothing: the per-read values are not kept, and part 1's
 * code reads the uniform rows as it read any others.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE roof_entry_reads r
       SET hide_on_estimate = true
     WHERE r.estimate_id IS NOT NULL
       AND r.hide_on_estimate = false
       AND EXISTS (
         SELECT 1 FROM roof_entry_reads h
          WHERE h.estimate_id = r.estimate_id
            AND h.hide_on_estimate = true
       )
  `);
};

exports.down = async function down() {
  // Intentionally empty: see the header.
};
