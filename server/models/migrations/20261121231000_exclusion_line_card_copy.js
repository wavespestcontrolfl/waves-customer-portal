'use strict';

/**
 * Follow-up to 20261121230000_exclusion_service_line (rodent exclusion became its own
 * service line). That migration copied each technician's rodent CAPABILITY to exclusion
 * and left the service card alone ("an unset line adds no rule"). On a database whose
 * card already names a home or gap technician for the rodent line, that would drop the
 * card's rule for exclusion work the moment the code deploys: with the map live, an
 * exclusion job would be offered on every technician until staff set the new line.
 *
 * So the rodent card row is copied to an exclusion row, the same home and gap
 * technician. Exclusion was part of the rodent line until today, so the card places
 * exclusion work exactly as before, and staff split the two lines on the Team tab
 * when they are ready. An exclusion row that already exists is never overwritten.
 * No rodent row (production on 2026-11-21: the card is empty) = nothing is written.
 *
 * Idempotent. Down is a no-op: a copied row cannot be told from one set by hand, and
 * the down of 20261121230000 removes every exclusion row.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('service_line_techs'))) return;
  await knex.raw(`
    INSERT INTO service_line_techs (service_category, home_technician_id, gap_technician_id, updated_by, updated_at)
    SELECT 'exclusion', home_technician_id, gap_technician_id, updated_by, now()
      FROM service_line_techs
     WHERE service_category = 'rodent'
    ON CONFLICT (service_category) DO NOTHING
  `);
};

exports.down = async function down() {};
