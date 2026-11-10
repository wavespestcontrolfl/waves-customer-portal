'use strict';

/**
 * GATE_BOOKING_MAKE_ROOM on: scheduled_services.make_room_moves (jsonb, nullable). Set only on the estimate page's
 * make-room hold: { v: 1, date, techId, shiftMin, moves: [{ id, from: 'HH:MM', to: 'HH:MM', widthMin }] }, the regular
 * stops that give up the held hour by moving later the same day. reserveSlot writes it after
 * booking-make-room verifyMakeRoomHour judged the chain; extendReservation refreshes it; the estimate page's
 * filterCollidingSlots and reserveSlot's own probe read it so no other customer takes a move's destination while the
 * hold is live. Nothing moves a visit from this column yet: accepting such a hold fails closed (the later change
 * moves the stops inside the accept transaction).
 *
 * Nullable, no default, no backfill. Idempotent. down() drops the column.
 */

const TABLE = 'scheduled_services';
const COLUMN = 'make_room_moves';
const COLUMN_COMMENT = 'Make-room hold only: the regular stops that move later the same day to free the held hour ({ v, date, techId, shiftMin, moves: [{ id, from, to, widthMin }] }). NULL on every other row.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, (t) => { t.jsonb(COLUMN).nullable(); });
  }
  await knex.raw(`COMMENT ON COLUMN ${TABLE}.${COLUMN} IS '${COLUMN_COMMENT.replace(/'/g, "''")}'`);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COLUMN); });
  }
};
