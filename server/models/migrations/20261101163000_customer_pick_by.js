'use strict';

/**
 * Quick Move "let the customer pick a day" (GATE_QUICKMOVE_CUSTOMER_PICK, owner
 * approved 2026-11-01): the instant until which the customer may pick a new time
 * for a visit the office or technician handed to them.
 *
 * While customer_pick_by is in the future, Auto-Dispatch skips the visit and
 * does not ring "Recurring visit still needs a time"; the customer's reschedule
 * link accepts the windowless visit. A staff move or a customer pick clears it.
 * An Auto-Dispatch placement keeps it, so the later 72-hour reminder can tell
 * the customer the visit was booked for them.
 *
 * Nullable, no default, no rewrite of existing rows: a row without it behaves
 * exactly as before. Guarded; idempotent both ways.
 */
const TABLE = 'scheduled_services';
const COLUMN = 'customer_pick_by';
const COMMENT = 'Quick Move customer-pick hand-off: the customer may pick a new time until this instant. Auto-Dispatch skips the visit until then. NULL = not handed to the customer (or the hand-off ended).';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, (t) => { t.timestamp(COLUMN, { useTz: true }).nullable(); });
  }
  await knex.raw(`COMMENT ON COLUMN ${TABLE}.${COLUMN} IS '${COMMENT.replace(/'/g, "''")}'`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COLUMN); });
  }
};
