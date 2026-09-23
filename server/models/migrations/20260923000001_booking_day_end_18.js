/**
 * Booking day-end extension to 18:00 — picker-windows PR 2 (owner ruling
 * 2026-09-23) adds 12:00 PM and 5:00 PM to the customer-facing offered start
 * times. A 5:00 PM start with the standard 60-minute visit ends at 6:00 PM,
 * so the customer-facing service day close moves from 17:00 to 18:00
 * alongside it (offer/commit parity).
 *
 * booking_config is a singleton row; this updates it in place, guarded to
 * the known prior value so it is a no-op if the owner already hand-edited
 * day_end. `down` is deliberately a no-op (see below).
 */
const TABLE = 'booking_config';
const OLD_DAY_END = '17:00:00';
const NEW_DAY_END = '18:00:00';

exports.up = async function up(knex) {
  await knex(TABLE).where('day_end', OLD_DAY_END).update({ day_end: NEW_DAY_END });
};

// Intentionally a no-op. `up` only touches rows still at the pre-ruling
// 17:00 value, but nothing distinguishes a row `up` wrote from one the owner
// had already set to 18:00 by hand — a reverting UPDATE would overwrite that
// override, changing configuration this migration never changed. day_end is
// an owner-visible admin setting; a rollback leaves it as-is for the owner to
// adjust deliberately.
exports.down = async function down() {};
