/**
 * Third-party Payer Phase 2 — accrual core (P1).
 *
 * `payer_statements`: one OPEN statement per (payer, period). A NET-terms payer
 * invoice is created as today (draft + payer_id snapshot) but ATTACHED to the
 * open statement via `invoices.payer_statement_id` and held from individual AP
 * delivery/collection — the statement is the unit of send/pay/AR/dunning.
 *
 * Design: docs/design/payer-net-statements-plan.md. This migration ships the
 * schema only; behaviour is gated behind GATE_PAYER_STATEMENTS, and statement
 * close/delivery/payment land in later phases. The `payments` settlement columns
 * are NOT added here — they belong to P3.
 *
 * `invoices.payer_statement_id` is ON DELETE RESTRICT (NOT SET NULL): it is the
 * accrual marker AND the send/pay fail-closed guard. A statement is never hard-
 * deleted; it is voided, or a child is explicitly detached in a transaction.
 * Mirrors invoices.payer_id RESTRICT.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payer_statements'))) {
    await knex.schema.createTable('payer_statements', (t) => {
      t.bigIncrements('id').primary();
      t.integer('payer_id').notNullable().references('id').inTable('payers').onDelete('RESTRICT');

      // Accrual window (date-only, Eastern Time — no timestamptz window leak).
      t.date('period_start').notNullable();
      t.date('period_end').notNullable();

      // open → finalized → sent → viewed → processing → paid, or → void.
      // `overdue` is DERIVED from due_date, never stored.
      t.string('status', 20).notNullable().defaultTo('open');
      // payer.payment_terms frozen at statement open (net15 | net30).
      t.string('terms_snapshot', 24).notNullable();

      // Rolled up from accrued invoices; recomputed while `open`, frozen at finalize.
      t.decimal('subtotal', 10, 2).notNullable().defaultTo(0);
      t.decimal('tax_amount', 10, 2).notNullable().defaultTo(0);
      t.decimal('total', 10, 2).notNullable().defaultTo(0);
      t.integer('invoice_count').notNullable().defaultTo(0);

      // Public pay token (like invoices.token); frozen AP bill-to at finalize.
      t.string('token', 64).notNullable().unique();
      t.jsonb('payer_snapshot');

      // Payment / lifecycle (set in later phases).
      t.date('due_date');
      t.string('stripe_payment_intent_id', 64);
      t.string('payment_method', 30);
      t.string('stripe_charge_id', 100);
      t.timestamp('finalized_at');
      t.timestamp('sent_at');
      t.timestamp('viewed_at');
      t.timestamp('paid_at');

      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());

      t.index(['payer_id', 'period_start'], 'payer_statements_payer_period_idx');
      t.index(['status'], 'payer_statements_status_idx');
      t.index(['due_date'], 'payer_statements_due_date_idx');
    });

    // At most ONE open statement per (payer, period) — the get-or-create target,
    // and the backstop if two concurrent accruals race the advisory lock. Knex
    // has no partial-index builder, so raw.
    await knex.raw(
      `CREATE UNIQUE INDEX payer_statements_one_open_per_period_idx
       ON payer_statements (payer_id, period_start) WHERE status = 'open'`,
    );
  }

  // invoices.payer_statement_id — accrual marker + send/pay fail-closed guard.
  if (await knex.schema.hasTable('invoices')
    && !(await knex.schema.hasColumn('invoices', 'payer_statement_id'))) {
    await knex.schema.alterTable('invoices', (t) => {
      t.bigInteger('payer_statement_id').references('id').inTable('payer_statements').onDelete('RESTRICT');
      t.index(['payer_statement_id'], 'invoices_payer_statement_id_idx');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('invoices', 'payer_statement_id')) {
    await knex.schema.alterTable('invoices', (t) => {
      t.dropIndex(['payer_statement_id'], 'invoices_payer_statement_id_idx');
      t.dropColumn('payer_statement_id');
    });
  }
  await knex.schema.dropTableIfExists('payer_statements');
};
