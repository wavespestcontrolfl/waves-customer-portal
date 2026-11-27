// Sticky stop for a person a caller named (owner 2026-11-27): the account holder (in the app) or staff can stop or
// restart the visit texts for one person on the customer's list. A stop is never a delete.
// customer_reminder_contacts.stopped_at / stopped_by: the stop on the list (who made it: 'customer' | 'staff').
// visit_text_recipients.stopped_at: the same stop stamped on that number's visit rows, so it moves with a visit when two
// customer records are merged (the list itself stays on the old record).
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('customer_reminder_contacts')) {
    await knex.raw('ALTER TABLE customer_reminder_contacts ADD COLUMN IF NOT EXISTS stopped_at timestamptz');
    await knex.raw('ALTER TABLE customer_reminder_contacts ADD COLUMN IF NOT EXISTS stopped_by varchar(20)');
  }
  if (await knex.schema.hasTable('visit_text_recipients')) {
    await knex.raw('ALTER TABLE visit_text_recipients ADD COLUMN IF NOT EXISTS stopped_at timestamptz');
  }
};

// A saved stop is a person's (or staff's) choice: a rollback never erases one. The tables are locked and checked in the
// same transaction that drops the columns, so no stop can be saved between the check and the drop.
exports.down = async function down(knex) {
  await knex.transaction(async (trx) => {
    const tables = [];
    for (const t of ['customer_reminder_contacts', 'visit_text_recipients']) {
      if (await trx.schema.hasTable(t) && await trx.schema.hasColumn(t, 'stopped_at')) tables.push(t);
    }
    if (!tables.length) return;
    await trx.raw(`LOCK TABLE ${tables.join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
    for (const t of tables) {
      if (await trx(t).whereNotNull('stopped_at').first(trx.raw('1 AS x'))) {
        throw new Error(`${t} has saved stops; refusing a rollback that would drop them`);
      }
    }
    if (tables.includes('visit_text_recipients')) await trx.raw('ALTER TABLE visit_text_recipients DROP COLUMN IF EXISTS stopped_at');
    if (tables.includes('customer_reminder_contacts')) {
      await trx.raw('ALTER TABLE customer_reminder_contacts DROP COLUMN IF EXISTS stopped_by');
      await trx.raw('ALTER TABLE customer_reminder_contacts DROP COLUMN IF EXISTS stopped_at');
    }
  });
};
