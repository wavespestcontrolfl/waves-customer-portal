// Sticky stop, final columns (owner 2026-11-27). The stop moves from stopped_at / stopped_by (20261128090000) to
// texts_stopped_at / texts_stopped_by, plus texts_restarted_at (the customer's own last Restart, which outranks a stop
// that came from a record merged into it). 20261128090000's down drops only its own two columns, which this up
// empties, so no rollback of that file can erase a saved stop; this file's own down refuses while any stop is saved.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_reminder_contacts'))) return;
  await knex.raw('ALTER TABLE customer_reminder_contacts ADD COLUMN IF NOT EXISTS texts_stopped_at timestamptz');
  await knex.raw('ALTER TABLE customer_reminder_contacts ADD COLUMN IF NOT EXISTS texts_stopped_by varchar(20)');
  await knex.raw('ALTER TABLE customer_reminder_contacts ADD COLUMN IF NOT EXISTS texts_restarted_at timestamptz');
  if (await knex.schema.hasColumn('customer_reminder_contacts', 'stopped_at')) {
    await knex.raw(`UPDATE customer_reminder_contacts SET texts_stopped_at = stopped_at, texts_stopped_by = stopped_by,
      stopped_at = NULL, stopped_by = NULL WHERE stopped_at IS NOT NULL AND texts_stopped_at IS NULL`);
  }
};

// A saved stop is a person's (or staff's) choice: a rollback never erases one. The table is locked and checked in the
// same transaction that drops this file's columns.
exports.down = async function down(knex) {
  await knex.transaction(async (trx) => {
    if (!(await trx.schema.hasTable('customer_reminder_contacts'))) return;
    if (!(await trx.schema.hasColumn('customer_reminder_contacts', 'texts_stopped_at'))) return;
    await trx.raw('LOCK TABLE customer_reminder_contacts IN SHARE ROW EXCLUSIVE MODE');
    if (await trx('customer_reminder_contacts').whereNotNull('texts_stopped_at').first(trx.raw('1 AS x'))) {
      throw new Error('customer_reminder_contacts has saved stops; refusing a rollback that would drop them');
    }
    await trx.raw('ALTER TABLE customer_reminder_contacts DROP COLUMN IF EXISTS texts_restarted_at');
    await trx.raw('ALTER TABLE customer_reminder_contacts DROP COLUMN IF EXISTS texts_stopped_by');
    await trx.raw('ALTER TABLE customer_reminder_contacts DROP COLUMN IF EXISTS texts_stopped_at');
  });
};
