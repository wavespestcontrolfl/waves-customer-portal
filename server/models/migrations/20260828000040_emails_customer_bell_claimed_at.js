// "Email from a customer" bell (owner ruling 2026-08-28): a per-email
// delivery claim so the notification fires AT MOST ONCE across the insert
// path, crash recovery, Gmail label/history replays, and concurrent pods —
// independent of whether a bell row exists (a push-only admin gets no bell
// row). The claim is an atomic conditional UPDATE on this column.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  if (await knex.schema.hasColumn('emails', 'customer_bell_claimed_at')) return;
  await knex.schema.alterTable('emails', (table) => {
    table.timestamp('customer_bell_claimed_at', { useTz: true }).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('emails'))) return;
  if (!(await knex.schema.hasColumn('emails', 'customer_bell_claimed_at'))) return;
  await knex.schema.alterTable('emails', (table) => {
    table.dropColumn('customer_bell_claimed_at');
  });
};
