exports.up = async function (knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  const exists = await knex.schema.hasTable('invoices');
  if (!exists) {
    await knex.schema.createTable('invoices', t => {
      t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
      t.string('token', 64).notNullable().unique(); // public URL token — crypto random
      t.string('invoice_number', 30).notNullable().unique(); // WPC-2026-0001 format
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('service_record_id').references('id').inTable('service_records').onDelete('SET NULL');
      t.uuid('technician_id').references('id').inTable('technicians').onDelete('SET NULL');

      // Invoice details
      t.string('title', 300); // e.g. "Quarterly Pest Control — April 2026"
      t.date('service_date');
      t.date('due_date');
      t.text('notes'); // internal notes or customer-visible message
      t.text('tech_notes'); // pulled from service record

      // Line items stored as JSONB array:
      // [{ description, quantity, unit_price, amount, category }]
      t.jsonb('line_items').defaultTo('[]');

      // Financials
      t.decimal('subtotal', 10, 2).defaultTo(0);
      t.decimal('discount_amount', 10, 2).defaultTo(0);
      t.string('discount_label', 100); // "Gold WaveGuard — 15% off"
      t.decimal('tax_rate', 5, 4).defaultTo(0); // 0.0700 = 7%
      t.decimal('tax_amount', 10, 2).defaultTo(0);
      t.decimal('total', 10, 2).notNullable().defaultTo(0);

      // Status
      t.string('status', 20).defaultTo('draft');
      // draft → sent → viewed → paid | overdue | void
      t.timestamp('sent_at');
      t.timestamp('viewed_at');    // set when customer opens the /pay page
      t.timestamp('paid_at');
      t.integer('view_count').defaultTo(0);

      // Payment processing
      t.string('square_payment_id', 100);
      t.string('payment_method', 30); // 'card', 'apple_pay', 'google_pay', 'ach'
      t.string('card_brand', 20);
      t.string('card_last_four', 4);
      t.string('receipt_url', 500);

      // Service recap content (pulled from service record at creation)
      t.jsonb('products_applied').defaultTo('[]'); // from service_products
      t.jsonb('service_photos').defaultTo('[]');   // S3 URLs from service_photos
      t.string('service_type', 100);
      t.string('tech_name', 100);

      // SMS tracking
      t.timestamp('sms_sent_at');
      t.integer('sms_reminder_count').defaultTo(0);
      t.timestamp('last_reminder_at');

      t.timestamps(true, true);

      t.index('token');
      t.index('customer_id');
      t.index('status');
      t.index('due_date');
      t.index('service_record_id');
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('invoices');
};
