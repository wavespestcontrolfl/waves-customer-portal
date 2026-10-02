'use strict';

/**
 * price_change_notices: one notice per change EVENT, per plan line for the
 * annual rate review.
 *
 * 20260712300000 made (customer_id, effective_date, current_amount_cents,
 * new_amount_cents) unique — one event per customer. The annual rate review
 * (20260930230000, services/rate-review-apply.js) writes one notice per
 * PLAN LINE, and two lines of one customer can share a date and amounts
 * (e.g. two lines both $117 → $121 on the same visit day): those are two
 * changes, and the account-wide key refused the second forever.
 *
 *   price_change_notices_event_uniq       legacy notices only
 *                                         (rate_review_row_id IS NULL):
 *                                         the same 4-column event key the
 *                                         monthly-batch send path relies on
 *   price_change_notices_plan_event_uniq  rate-review notices: the event key
 *                                         plus family_key
 *
 * A rate-review notice that repeats a LEGACY notice's event is still refused,
 * by scheduleRow's own check under the batch lock (a cross-shape rule no
 * single index can express); the legacy send path looks the event up across
 * both shapes before it inserts.
 *
 * Idempotent both ways. down() restores the account-wide key; it fails if
 * two plan lines already hold notices of the same event (drop one first).
 */
const TABLE = 'price_change_notices';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'rate_review_row_id')) || !(await knex.schema.hasColumn(TABLE, 'family_key'))) return;
  // knex's t.unique() made it a constraint; drop either shape.
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS price_change_notices_event_uniq`);
  await knex.raw('DROP INDEX IF EXISTS price_change_notices_event_uniq');
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS price_change_notices_event_uniq ON ${TABLE} (customer_id, effective_date, current_amount_cents, new_amount_cents) WHERE rate_review_row_id IS NULL`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS price_change_notices_plan_event_uniq ON ${TABLE} (customer_id, effective_date, current_amount_cents, new_amount_cents, family_key) WHERE rate_review_row_id IS NOT NULL`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw('DROP INDEX IF EXISTS price_change_notices_plan_event_uniq');
  await knex.raw('DROP INDEX IF EXISTS price_change_notices_event_uniq');
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT price_change_notices_event_uniq UNIQUE (customer_id, effective_date, current_amount_cents, new_amount_cents)`);
};
