/**
 * Commission ledger (owner rulings 2026-10-29, D5 part 3b-2 of the first-technician pay plan).
 * Dark behind GATE_PAYROLL_COMMISSION_LEDGER; additive.
 *
 * commission_sales: one row per accepted estimate a technician sold (estimates.sold_by_technician_id,
 * part 3b-1), written by the pay run sync. accepted_on is the Eastern date of estimates.accepted_at and
 * window_end the last day of the 12 months that pay commission (accepted_on + 12 months - 1 day);
 * rate_bps is the rate in basis points (1000 = 10%). A sale is evidence of who sold what and when, so it
 * is insert-only: a trigger refuses DELETE and any UPDATE, except the automatic customer_id SET NULL
 * when a customer row is deleted.
 *
 * commission_entries: one row per sale and customer payment. counted_cents is the part of the payment
 * that counts (net of refunds, sales tax and the card surcharge, and only the sold lines of the invoice)
 * and commission_cents is rate_bps of it. refund_counted_cents is the refunded base this entry has deducted so
 * far; invoice_id, share_own_cents, share_all_cents, pre_tax_cents and tax_cents are the attribution fixed when the
 * payment was first counted (an entry is never recomputed from today's visits, add-on rows or invoice lines). A refund is deducted while the sale's 12 months run or when the payment record last changed inside them
 * (payments keep no refund date), and an entry never deducts a refund seen only after them. payment_id has no foreign key on purpose: a payment row can
 * never be blocked by this table, and a payment that is gone counts 0.
 *
 * The pay lines the ledger writes are payroll_pay_lines (kind 'commission', source_type
 * 'commission_payment', source_id '<entry id>:<n>'); nothing else changes in payroll tables.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('commission_sales', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('estimate_id').notNullable().unique().references('id').inTable('estimates').onDelete('RESTRICT');
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
    t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    t.date('accepted_on').notNullable();
    t.date('window_end').notNullable();
    t.integer('rate_bps').notNullable().defaultTo(1000);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['technician_id'], 'commission_sales_technician_idx');
  });
  await knex.raw(`ALTER TABLE commission_sales
    ADD CONSTRAINT commission_sales_rate_check CHECK (rate_bps BETWEEN 1 AND 10000),
    ADD CONSTRAINT commission_sales_window_check CHECK (window_end > accepted_on)`);
  await knex.raw(`CREATE FUNCTION protect_commission_sales() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.customer_id IS NULL
        AND (to_jsonb(NEW) - 'customer_id') = (to_jsonb(OLD) - 'customer_id') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'A commission sale cannot be changed or deleted';
    END $$`);
  await knex.raw('CREATE TRIGGER protect_commission_sales BEFORE UPDATE OR DELETE ON commission_sales FOR EACH ROW EXECUTE FUNCTION protect_commission_sales()');

  await knex.schema.createTable('commission_entries', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('sale_id').notNullable().references('id').inTable('commission_sales').onDelete('RESTRICT');
    t.uuid('payment_id').notNullable();
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('RESTRICT');
    t.date('payment_on').notNullable();
    t.bigInteger('counted_cents').notNullable();
    t.bigInteger('commission_cents').notNullable();
    t.bigInteger('refund_counted_cents').notNullable().defaultTo(0);
    // The attribution, fixed when the payment is first counted: the invoice it belongs to and that invoice's share of the
    // estimate and cash figures (pre-tax and tax, in cents) as computed then. No foreign key: an invoice is never blocked.
    t.uuid('invoice_id').notNullable();
    t.bigInteger('share_own_cents').notNullable();
    t.bigInteger('share_all_cents').notNullable();
    t.bigInteger('pre_tax_cents').notNullable();
    t.bigInteger('tax_cents').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.unique(['sale_id', 'payment_id'], { indexName: 'commission_entries_sale_payment_unique' });
    t.index(['technician_id', 'payment_on'], 'commission_entries_technician_payment_idx');
  });
  await knex.raw(`ALTER TABLE commission_entries
    ADD CONSTRAINT commission_entries_counted_check CHECK (counted_cents >= 0),
    ADD CONSTRAINT commission_entries_commission_check CHECK (commission_cents >= 0),
    ADD CONSTRAINT commission_entries_refund_counted_check CHECK (refund_counted_cents >= 0),
    ADD CONSTRAINT commission_entries_share_own_check CHECK (share_own_cents >= 0),
    ADD CONSTRAINT commission_entries_share_all_check CHECK (share_all_cents > 0),
    ADD CONSTRAINT commission_entries_pre_tax_check CHECK (pre_tax_cents > 0),
    ADD CONSTRAINT commission_entries_tax_check CHECK (tax_cents >= 0)`);
};

exports.down = async function down(knex) {
  // Sales and entries are payroll evidence: preserve them and roll forward.
  if (await knex.schema.hasTable('commission_sales') && await knex('commission_sales').first('id')) {
    throw new Error('commission_sales holds entries. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.schema.dropTableIfExists('commission_entries');
  await knex.raw('DROP TRIGGER IF EXISTS protect_commission_sales ON commission_sales');
  await knex.raw('DROP FUNCTION IF EXISTS protect_commission_sales()');
  await knex.schema.dropTableIfExists('commission_sales');
};
