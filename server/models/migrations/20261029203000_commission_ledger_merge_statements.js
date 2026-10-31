/**
 * Commission ledger follow-up (D5 part 3b-2, Codex round 1 on #7033). Two changes to 20261029200000, which is
 * frozen once pushed:
 *
 * 1. A customer merge may move a sale. customer-dedupe.js repoints every customer_id column to the account that
 *    survives a merge, and its revert repoints the same rows back. The sale trigger refused that UPDATE, so one
 *    recorded sale made every merge of its customer fail. The trigger now allows an UPDATE that changes customer_id
 *    only. Every other column of a sale stays fixed, and DELETE is still refused.
 *
 * 2. One payer statement payment pays many invoices. settleStatementPaid (payer-statement-settle.js) writes ONE
 *    payments row for a whole NET-terms statement (customer_id NULL, statement_id set) and marks the statement's
 *    child invoices paid. An entry is now one per sale, payment AND invoice. statement_part_cents (the invoice's
 *    total) over statement_total_cents (the positive totals of the statement's invoices) is the invoice's part of
 *    the statement payment, fixed when the payment is first counted. Both are NULL for a payment of one invoice.
 */
const STRICT_TRIGGER = `CREATE OR REPLACE FUNCTION protect_commission_sales() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.customer_id IS NULL
        AND (to_jsonb(NEW) - 'customer_id') = (to_jsonb(OLD) - 'customer_id') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'A commission sale cannot be changed or deleted';
    END $$`;

exports.up = async function up(knex) {
  await knex.raw(`CREATE OR REPLACE FUNCTION protect_commission_sales() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'customer_id') = (to_jsonb(OLD) - 'customer_id') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'A commission sale cannot be changed or deleted';
    END $$`);
  await knex.schema.alterTable('commission_entries', (t) => {
    t.bigInteger('statement_part_cents').nullable();
    t.bigInteger('statement_total_cents').nullable();
  });
  await knex.raw(`ALTER TABLE commission_entries
    DROP CONSTRAINT IF EXISTS commission_entries_sale_payment_unique,
    ADD CONSTRAINT commission_entries_sale_payment_invoice_unique UNIQUE (sale_id, payment_id, invoice_id),
    ADD CONSTRAINT commission_entries_statement_part_check CHECK (
      (statement_part_cents IS NULL AND statement_total_cents IS NULL)
      OR (statement_part_cents > 0 AND statement_total_cents >= statement_part_cents))`);
};

exports.down = async function down(knex) {
  // Statement entries are payroll evidence that the older shape cannot hold: preserve them and roll forward.
  if (await knex('commission_entries').whereNotNull('statement_total_cents').first('id')) {
    throw new Error('commission_entries holds payer statement entries. Preserve the schema and roll forward; do not drop them.');
  }
  await knex.raw(`ALTER TABLE commission_entries
    DROP CONSTRAINT IF EXISTS commission_entries_statement_part_check,
    DROP CONSTRAINT IF EXISTS commission_entries_sale_payment_invoice_unique,
    ADD CONSTRAINT commission_entries_sale_payment_unique UNIQUE (sale_id, payment_id)`);
  await knex.schema.alterTable('commission_entries', (t) => {
    t.dropColumn('statement_part_cents');
    t.dropColumn('statement_total_cents');
  });
  await knex.raw(STRICT_TRIGGER);
};
