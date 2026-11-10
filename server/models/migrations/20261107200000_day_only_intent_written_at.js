'use strict';

/**
 * GATE_DAY_ONLY_PROMISE part B2: scheduled_services.customer_asked_time_at (timestamptz, nullable). The moment the office's or
 * customer's "customer asked for this time" intent (customer_asked_time) was written, from the database clock (now()), so the
 * intent can hold only for the move it was written with: services/time-promise.js currentIntent reads it, and an explicit
 * true or false is stale once a slot-changing reschedule_log row is newer than it. NULL = written at booking (B1's create
 * path) or never written; such an intent holds only while no slot change is logged at all.
 *
 * Nothing reads the column while GATE_DAY_ONLY_PROMISE is off. Nullable, no default, no backfill (no row needs one: an
 * existing intent without a time reads as "written at booking"). Idempotent. down() drops the column.
 */

const TABLE = 'scheduled_services';
const COLUMN = 'customer_asked_time_at';
const COLUMN_COMMENT = 'When customer_asked_time was written (database now()). The intent holds only until a newer slot-changing reschedule_log row; NULL = written at booking, holds only while no slot change is logged.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, (t) => { t.timestamp(COLUMN, { useTz: true }).nullable(); });
  }
  await knex.raw(`COMMENT ON COLUMN ${TABLE}.${COLUMN} IS '${COLUMN_COMMENT.replace(/'/g, "''")}'`);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(TABLE, COLUMN)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COLUMN); });
  }
};

exports._test = { TABLE, COLUMN };
