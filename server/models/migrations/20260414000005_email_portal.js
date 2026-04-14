exports.up = async function (knex) {
  // Core email storage
  await knex.schema.createTable('emails', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('gmail_id').unique().notNullable();
    t.text('gmail_thread_id').notNullable();
    t.text('from_address').notNullable();
    t.text('from_name');
    t.text('to_address');
    t.text('subject');
    t.text('body_text');
    t.text('body_html');
    t.text('snippet');
    t.boolean('has_attachments').defaultTo(false);
    t.jsonb('label_ids');
    t.timestamp('received_at').notNullable();
    t.boolean('is_read').defaultTo(false);
    t.boolean('is_archived').defaultTo(false);
    t.boolean('is_starred').defaultTo(false);
    t.text('classification');
    t.float('classification_confidence');
    t.jsonb('extracted_data');
    t.uuid('customer_id').references('id').inTable('customers');
    t.uuid('lead_id');
    t.uuid('expense_id');
    t.text('auto_action');
    t.timestamps(true, true);
    t.index('gmail_thread_id');
    t.index('from_address');
    t.index('received_at');
    t.index('is_read');
    t.index('is_archived');
    t.index('classification');
    t.index('customer_id');
  });

  // Email attachments
  await knex.schema.createTable('email_attachments', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('email_id').references('id').inTable('emails').onDelete('CASCADE');
    t.text('gmail_attachment_id');
    t.text('filename');
    t.text('mime_type');
    t.integer('size_bytes');
    t.text('storage_path');
    t.boolean('is_invoice').defaultTo(false);
    t.jsonb('extracted_data');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('email_id');
  });

  // Vendor domain routing
  await knex.schema.createTable('vendor_email_domains', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('domain').unique().notNullable();
    t.text('vendor_name').notNullable();
    t.text('expense_category');
    t.text('primary_contact');
    t.text('auto_action').defaultTo('route_procurement');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Sync state tracking
  await knex.schema.createTable('email_sync_state', (t) => {
    t.increments('id');
    t.text('last_history_id');
    t.timestamp('last_sync_at');
    t.integer('emails_synced').defaultTo(0);
    t.text('errors');
    t.text('refresh_token');
    t.text('access_token');
    t.timestamp('token_expires_at');
  });

  // Seed vendor domains
  await knex('vendor_email_domains').insert([
    { domain: 'siteone.com', vendor_name: 'SiteOne Landscape Supply', expense_category: 'Products & Chemicals', primary_contact: 'Mark Mroczkowski' },
    { domain: 'siteonelandscape.com', vendor_name: 'SiteOne Landscape Supply', expense_category: 'Products & Chemicals', primary_contact: 'Mark Mroczkowski' },
    { domain: 'lesco.com', vendor_name: 'LESCO', expense_category: 'Products & Chemicals' },
    { domain: 'domyown.com', vendor_name: 'DoMyOwn', expense_category: 'Products & Chemicals' },
    { domain: 'arborjet.com', vendor_name: 'Arborjet', expense_category: 'Products & Chemicals' },
    { domain: 'twilio.com', vendor_name: 'Twilio', expense_category: 'Software & Services' },
    { domain: 'anthropic.com', vendor_name: 'Anthropic', expense_category: 'Software & Services' },
    { domain: 'railway.app', vendor_name: 'Railway', expense_category: 'Hosting & Infrastructure' },
    { domain: 'namecheap.com', vendor_name: 'Namecheap', expense_category: 'Hosting & Infrastructure' },
  ]);

  // Seed initial sync state row
  await knex('email_sync_state').insert({ emails_synced: 0 });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('email_attachments');
  await knex.schema.dropTableIfExists('emails');
  await knex.schema.dropTableIfExists('vendor_email_domains');
  await knex.schema.dropTableIfExists('email_sync_state');
};
