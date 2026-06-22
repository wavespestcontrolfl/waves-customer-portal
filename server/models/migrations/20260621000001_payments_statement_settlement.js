/**
 * Third-party Payer Phase 2 — P3 (pay + settle): payments ledger shape.
 *
 * A statement spans MANY customers, but `payments.customer_id` is NOT NULL today
 * and revenue/health paths key off `customer_id`. A statement settlement writes
 * ONE `payments` row for the whole statement, so:
 *   - `+ statement_id` (FK→payer_statements, SET NULL) — the settlement marker
 *   - `+ payer_id`     (FK→payers,           SET NULL) — the AP party that paid
 *   - `customer_id` becomes NULLABLE — the statement row carries no single
 *     homeowner (`customer_id = NULL`, `payer_id` + `statement_id` set).
 *
 * Every customer-keyed payments reader must exclude these payer rows (a
 * `payer_id IS NULL` / `customer_id IS NOT NULL` guard) so payer money is never
 * counted as a homeowner's payment — mirrors the Phase-1 payer-invoice exclusion.
 * `amount` on a card statement row is the CHARGED (surcharged) total; the
 * base/surcharge split rides the existing `*_cents` columns (surcharge_compliance).
 *
 * Schema only; behaviour gated behind GATE_PAYER_STATEMENTS. Design:
 * docs/design/payer-net-statements-plan.md ("Changed: payments").
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;

  if (!(await knex.schema.hasColumn('payments', 'statement_id'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.bigInteger('statement_id').references('id').inTable('payer_statements').onDelete('SET NULL');
      t.index(['statement_id'], 'payments_statement_id_idx');
    });
  }

  if (!(await knex.schema.hasColumn('payments', 'payer_id'))) {
    await knex.schema.alterTable('payments', (t) => {
      t.integer('payer_id').references('id').inTable('payers').onDelete('SET NULL');
      t.index(['payer_id'], 'payments_payer_id_idx');
    });
  }

  // customer_id NOT NULL → nullable (raw: knex has no alter-nullability builder).
  // Idempotent — ALTER ... DROP NOT NULL is a no-op if already nullable.
  await knex.raw('ALTER TABLE payments ALTER COLUMN customer_id DROP NOT NULL');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;

  if (await knex.schema.hasColumn('payments', 'statement_id')) {
    await knex.schema.alterTable('payments', (t) => {
      t.dropIndex(['statement_id'], 'payments_statement_id_idx');
      t.dropColumn('statement_id');
    });
  }
  if (await knex.schema.hasColumn('payments', 'payer_id')) {
    await knex.schema.alterTable('payments', (t) => {
      t.dropIndex(['payer_id'], 'payments_payer_id_idx');
      t.dropColumn('payer_id');
    });
  }
  // Intentionally NOT restoring customer_id NOT NULL: payer-scoped settlement rows
  // may have been written with customer_id = NULL, so re-adding the constraint
  // would fail. The looser constraint is safe to keep.
};
