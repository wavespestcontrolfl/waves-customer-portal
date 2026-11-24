'use strict';

/**
 * technicians.shift_start / shift_end hold whole minutes below 24:00
 * (GATE_TECH_SHIFT_HOURS; follows 20261120213000_technician_shift_hours).
 *
 * The Team tab and the API write 'HH:MM' from 00:00 to 23:59 only, and the
 * reader (technician-eligibility.js storedShift) and the editor work in whole
 * minutes. The first CHECK alone lets a direct write store values they cannot
 * represent:
 *   - an end of 24:00 (a valid Postgres time), which the reader takes as no
 *     set hours;
 *   - seconds: 08:00:10 to 08:00:50 loads in the editor as two equal times,
 *     which blocks every save of that technician.
 * This second CHECK refuses both, so the columns hold only what the editor can
 * show. The start needs no bound of its own: the first CHECK puts it before
 * the end.
 *
 * A separate constraint, because the first migration is already pushed and
 * stays as it is. Idempotent. No row has hours when it runs: the columns
 * arrive in the same deploy, and nothing writes them while the gate is off.
 */
const CONSTRAINT = 'technicians_shift_hours_minutes_check';

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE technicians DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`
    ALTER TABLE technicians
    ADD CONSTRAINT ${CONSTRAINT}
    CHECK (
      (shift_start IS NULL OR EXTRACT(SECOND FROM shift_start) = 0)
      AND (shift_end IS NULL OR (EXTRACT(SECOND FROM shift_end) = 0 AND shift_end < TIME '24:00'))
    )
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE technicians DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
};
