/**
 * Customer account credit + invoice prepaid support.
 *
 * Two pieces:
 *
 *  1. `customer_credit_ledger` — an append-only ledger of every credit
 *     movement on a customer's account. Each row is a signed `delta`
 *     (positive = credit added to the balance, negative = credit consumed)
 *     plus a `balance_after` snapshot for audit/history rendering. The
 *     cached running balance lives on the existing-but-previously-unused
 *     `customers.account_credits` column, written in the same transaction
 *     as every ledger insert so the two never drift.
 *
 *  2. Invoice prepaid columns — `credit_applied` tracks how much account
 *     credit has been consumed against an invoice (amount due = total -
 *     credit_applied), and `prepaid_at` / `prepaid_by` / `setup_fee_waived`
 *     record the prepaid transition. The new `prepaid` invoice status
 *     itself is enforced in services/invoice-helpers.js, not the schema
 *     (status is a free string column today).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_credit_ledger'))) {
    await knex.schema.createTable('customer_credit_ledger', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('customer_id').notNullable()
        .references('id').inTable('customers').onDelete('CASCADE');
      // Signed: + adds to the account balance, - consumes it.
      t.decimal('delta', 10, 2).notNullable();
      // Running balance immediately after this entry (audit + history UI).
      t.decimal('balance_after', 10, 2).notNullable();
      // Why the movement happened: 'manual' | 'adjustment' |
      // 'invoice_application' | 'invoice_prepaid' | 'referral' (referral
      // wiring is deferred; the value is reserved so a later PR doesn't
      // need a second migration).
      t.string('source', 40).notNullable();
      // Set when the movement is tied to a specific invoice (application
      // or prepaid coverage). Nullable for standalone credit issuance.
      t.uuid('invoice_id').nullable()
        .references('id').inTable('invoices').onDelete('SET NULL');
      // Reserved for the deferred referral integration.
      t.uuid('referral_id').nullable();
      t.text('note').nullable();
      // Operator name/email who recorded the movement (free string, mirrors
      // invoices.payment_recorded_by — no FK to a users table).
      t.string('created_by', 200).nullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.index(['customer_id', 'created_at']);
      t.index('invoice_id');
    });
  }

  const hasInvoiceCol = async (col) => knex.schema.hasColumn('invoices', col);
  if (await knex.schema.hasTable('invoices')) {
    if (!(await hasInvoiceCol('credit_applied'))) {
      await knex.schema.alterTable('invoices', (t) => {
        t.decimal('credit_applied', 10, 2).notNullable().defaultTo(0);
      });
    }
    if (!(await hasInvoiceCol('prepaid_at'))) {
      await knex.schema.alterTable('invoices', (t) => t.timestamp('prepaid_at'));
    }
    if (!(await hasInvoiceCol('prepaid_by'))) {
      await knex.schema.alterTable('invoices', (t) => t.string('prepaid_by', 200));
    }
    if (!(await hasInvoiceCol('setup_fee_waived'))) {
      await knex.schema.alterTable('invoices', (t) => {
        t.boolean('setup_fee_waived').notNullable().defaultTo(false);
      });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('customer_credit_ledger');
  if (await knex.schema.hasTable('invoices')) {
    const hasInvoiceCol = async (col) => knex.schema.hasColumn('invoices', col);
    for (const col of ['credit_applied', 'prepaid_at', 'prepaid_by', 'setup_fee_waived']) {
      if (await hasInvoiceCol(col)) {
        await knex.schema.alterTable('invoices', (t) => t.dropColumn(col));
      }
    }
  }
};
