/**
 * Third-party "Bill-To" payers.
 *
 * Models the case where the person who receives the service (the customer of
 * record / "ship-to") is NOT the person who pays (the "bill-to"): builders /
 * GCs paying for a homeowner's new-construction pretreatment, property
 * managers paying for many tenants, realtors paying a closing WDO, HOAs, etc.
 *
 * A payer is a lightweight reusable Bill-To account — NOT a customer. The
 * homeowner stays the customer of record (MRR / acceptance / reporting stay
 * keyed on the customer); AR routes to the payer.
 *
 * Resolution order for any invoice:
 *   scheduled_services.payer_id  (this job bills to X)  ??
 *   customers.payer_id           (this account's default payer)  ??
 *   self  (homeowner pays — unchanged legacy behavior)
 *
 * invoices.payer_id / po_number are SNAPSHOT at creation so a historical
 * invoice keeps its bill-to even if the link later changes.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payers'))) {
    await knex.schema.createTable('payers', (t) => {
      t.increments('id').primary();
      t.string('display_name', 160).notNullable();
      t.string('company_name', 200);
      t.string('ap_email', 200);
      t.string('ap_phone', 40);
      t.string('billing_address_line1', 200);
      t.string('billing_city', 120);
      t.string('billing_state', 8);
      t.string('billing_zip', 16);
      // 'due_on_receipt' (Phase 1 behaviour: invoice the payer immediately,
      // just rerouted) | 'net15' | 'net30' (Phase 2: accrue to a consolidated
      // statement). Column ships now so the schema is ready; only
      // due_on_receipt is wired in Phase 1.
      t.string('payment_terms', 24).notNullable().defaultTo('due_on_receipt');
      t.boolean('requires_po').notNullable().defaultTo(false);
      t.boolean('tax_exempt').notNullable().defaultTo(false);
      t.string('tax_exempt_cert', 120);
      t.string('stripe_customer_id', 64);
      t.boolean('active').notNullable().defaultTo(true);
      t.text('notes');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
    await knex.schema.alterTable('payers', (t) => {
      t.index(['active'], 'payers_active_idx');
    });
  }

  // customers.payer_id — default bill-to for the account (nullable = self-pay).
  if (await knex.schema.hasTable('customers')
    && !(await knex.schema.hasColumn('customers', 'payer_id'))) {
    await knex.schema.alterTable('customers', (t) => {
      t.integer('payer_id').references('id').inTable('payers').onDelete('SET NULL');
      t.index(['payer_id'], 'customers_payer_id_idx');
    });
  }

  // scheduled_services.payer_id + po_number — per-job override of the account
  // default (nullable = inherit from customer).
  if (await knex.schema.hasTable('scheduled_services')) {
    const hasPayer = await knex.schema.hasColumn('scheduled_services', 'payer_id');
    const hasPo = await knex.schema.hasColumn('scheduled_services', 'po_number');
    if (!hasPayer || !hasPo) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        if (!hasPayer) {
          t.integer('payer_id').references('id').inTable('payers').onDelete('SET NULL');
          t.index(['payer_id'], 'scheduled_services_payer_id_idx');
        }
        if (!hasPo) t.string('po_number', 64);
      });
    }
  }

  // invoices.payer_id + po_number — frozen bill-to snapshot on the document.
  // payer_snapshot freezes the payer's bill-to DETAILS (name/company/email/
  // address) at creation so an issued invoice/receipt keeps its original
  // Bill-To even if the payer row is later renamed, edited, or deactivated.
  if (await knex.schema.hasTable('invoices')) {
    const hasPayer = await knex.schema.hasColumn('invoices', 'payer_id');
    const hasPo = await knex.schema.hasColumn('invoices', 'po_number');
    const hasSnap = await knex.schema.hasColumn('invoices', 'payer_snapshot');
    if (!hasPayer || !hasPo || !hasSnap) {
      await knex.schema.alterTable('invoices', (t) => {
        if (!hasPayer) {
          // RESTRICT (not SET NULL): invoices.payer_id is the flag EVERY
          // fail-closed guard keys off (SMS/receipt suppression, pay-token
          // suppression, billing/balance filters, dispatch collection gate).
          // SET NULL on a payer delete would strand payer_snapshot while making
          // the invoice look self-pay — re-exposing the payer's invoice/pay/
          // receipt surfaces to the homeowner. An issued invoice's bill-to is
          // immutable; payers are deactivated (active=false), never hard-deleted
          // (no DELETE route exists), so this only blocks a raw delete of a
          // payer that still has billing history.
          t.integer('payer_id').references('id').inTable('payers').onDelete('RESTRICT');
          t.index(['payer_id'], 'invoices_payer_id_idx');
        }
        if (!hasPo) t.string('po_number', 64);
        if (!hasSnap) t.jsonb('payer_snapshot');
      });
    }
  }
};

exports.down = async function down(knex) {
  for (const [table, cols] of [
    ['invoices', ['payer_id', 'po_number', 'payer_snapshot']],
    ['scheduled_services', ['payer_id', 'po_number']],
    ['customers', ['payer_id']],
  ]) {
    if (!(await knex.schema.hasTable(table))) continue;
    for (const col of cols) {
      if (await knex.schema.hasColumn(table, col)) {
        // eslint-disable-next-line no-await-in-loop
        await knex.schema.alterTable(table, (t) => t.dropColumn(col));
      }
    }
  }
  if (await knex.schema.hasTable('payers')) {
    await knex.schema.dropTable('payers');
  }
};
