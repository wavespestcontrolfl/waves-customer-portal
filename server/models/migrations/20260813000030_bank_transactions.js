/**
 * Bank Import (GATE_BANK_IMPORT) — staging table for imported bank/card
 * statement rows.
 *
 * STAGING ONLY: these rows never feed the P&L. The `expenses` table remains
 * the single ledger pnl-report.js reads; a staged debit only affects the
 * books when the operator (or an exact deterministic match) links it to an
 * expense row or creates one from it. Deposits matched to Stripe payouts are
 * transfers, never income — the link exists so they stop showing as
 * unexplained inflow, not so they're counted.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('bank_transactions')) return;
  await knex.schema.createTable('bank_transactions', t => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('account_label', 100).notNullable(); // operator-chosen, e.g. "capone-checking", "capone-card-1234"
    t.string('account_type', 10).notNullable();   // 'bank' | 'card' — drives payment_method on created expenses
    t.date('txn_date').notNullable();             // calendar day from the statement — date-only on purpose
    t.string('description', 500).notNullable();
    t.decimal('amount', 12, 2).notNullable();     // always positive; sign lives in `direction`
    t.string('direction', 6).notNullable();       // 'debit' (outflow) | 'credit' (inflow)
    t.string('source', 20).notNullable().defaultTo('csv');
    t.string('source_file', 300);
    // sha256 over (account|date|desc|amount|direction|per-file ordinal among
    // identical tuples) — makes re-uploading an overlapping statement a
    // no-op while keeping two genuinely identical same-day purchases apart.
    t.string('row_hash', 64).notNullable().unique();
    t.string('status', 20).notNullable().defaultTo('unmatched');
    t.uuid('matched_expense_id').references('id').inTable('expenses').onDelete('SET NULL');
    t.uuid('matched_payout_id').references('id').inTable('stripe_payouts').onDelete('SET NULL');
    t.string('match_method', 40);                 // payout_amount_date | expense_amount_date | manual | created
    t.jsonb('suggestion');                        // AI category proposal / transfer heuristic / ambiguous candidates
    t.timestamp('matched_at', { useTz: true });
    t.timestamps(true, true);
    t.index('txn_date');
    t.index('status');
    t.index('account_label');
  });
  await knex.raw(`
    ALTER TABLE bank_transactions
    ADD CONSTRAINT bank_transactions_direction_check CHECK (direction IN ('debit','credit')),
    ADD CONSTRAINT bank_transactions_account_type_check CHECK (account_type IN ('bank','card')),
    ADD CONSTRAINT bank_transactions_status_check CHECK (status IN ('unmatched','matched_expense','matched_payout','created_expense','ignored'))
  `);
  // One ledger row claims at most one bank row and vice versa — enforced by
  // the DATABASE, not just the matcher's read-then-write (concurrent passes
  // could otherwise link two bank rows to the same expense/payout and
  // overstate coverage). Partial: NULL FKs are unlimited.
  await knex.raw(`
    CREATE UNIQUE INDEX bank_transactions_matched_expense_uniq
      ON bank_transactions (matched_expense_id) WHERE matched_expense_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX bank_transactions_matched_payout_uniq
      ON bank_transactions (matched_payout_id) WHERE matched_payout_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('bank_transactions')) {
    await knex.schema.dropTable('bank_transactions');
  }
};
