/**
 * One open start_program attempt per customer, enforced by the database.
 *
 * ib_action_phases (migration 20261011020000) is the program ledger. Two concurrent confirms for one customer could both
 * pass the "no open row" precheck and both insert a `booking` row. A partial unique index closes that: a second open
 * row for the same customer fails with a unique violation, which the writer maps to program_start_in_progress.
 * "Open" = booking or booked_pending_bill; billed and abandoned rows are history and unconstrained.
 *
 * The earlier migration is already pushed, so this one is separate. Any duplicate open rows (none can exist in a
 * deployment that never ran the ledger, but the migration must not fail on one) keep the newest and are closed as
 * abandoned before the index is built. Two-way door: down drops the index.
 */
const INDEX = 'ib_action_phases_one_open_per_customer';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ib_action_phases'))) return;
  await knex.raw(`
    UPDATE ib_action_phases SET phase = 'abandoned', updated_at = now()
    WHERE phase IN ('booking', 'booked_pending_bill')
      AND id NOT IN (
        SELECT DISTINCT ON (customer_id) id FROM ib_action_phases
        WHERE phase IN ('booking', 'booked_pending_bill')
        ORDER BY customer_id, created_at DESC, id DESC
      )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX}
    ON ib_action_phases (customer_id)
    WHERE phase IN ('booking', 'booked_pending_bill')
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX}`);
};

exports.INDEX = INDEX;
