/**
 * One-shot marker for the "credit already spent, reversal impossible"
 * alert (Codex #3178 P2).
 *
 * Account credit is fungible: once applied to an invoice, the balance can
 * be below the amount a cancelled booking should return, and the ledger
 * rightly refuses to go negative. That becomes an office decision — but the
 * hourly sweep re-selects the same offer forever, so without a durable
 * marker the office gets a fresh bell every hour and learns to ignore it.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('inspection_credit_offers'))) return;
  if (await knex.schema.hasColumn('inspection_credit_offers', 'reversal_alerted_at')) return;
  await knex.schema.alterTable('inspection_credit_offers', (t) => {
    t.timestamp('reversal_alerted_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('inspection_credit_offers'))) return;
  if (!(await knex.schema.hasColumn('inspection_credit_offers', 'reversal_alerted_at'))) return;
  await knex.schema.alterTable('inspection_credit_offers', (t) => {
    t.dropColumn('reversal_alerted_at');
  });
};
