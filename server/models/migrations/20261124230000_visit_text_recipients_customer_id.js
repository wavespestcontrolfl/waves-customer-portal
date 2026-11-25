'use strict';

/**
 * visit_text_recipients.customer_id: the customer whose call authorized this person (GATE_CALL_GIVEN_VISIT_TEXTS).
 *
 * The permission came from ONE customer's call about ONE of that customer's visits. A visit row can later be reassigned to
 * another customer; the person must not then be texted, or shown the tracker, for someone else's visit. So the row records the
 * customer, and every send, recheck, replay and tracker read requires row.customer_id to equal the visit's current customer_id
 * (a null customer_id is never eligible). Nullable so the migration is safe on any data: existing rows are backfilled from
 * their visit's customer; a row whose visit has no customer stays null and is ineligible. The row goes with its customer.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('visit_text_recipients'))) return;
  await knex.raw('ALTER TABLE visit_text_recipients ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE CASCADE');
  await knex.raw(`
    UPDATE visit_text_recipients r
       SET customer_id = s.customer_id
      FROM scheduled_services s
     WHERE s.id = r.scheduled_service_id
       AND r.customer_id IS NULL
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('visit_text_recipients'))) return;
  await knex.raw('ALTER TABLE visit_text_recipients DROP COLUMN IF EXISTS customer_id');
};
