exports.up = async function (knex) {
  await knex.schema.createTable('invoice_attachments', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('invoice_id').notNullable().references('id').inTable('invoices').onDelete('CASCADE');
    t.uuid('customer_id').references('id').inTable('customers').onDelete('CASCADE');
    t.string('file_name', 255).notNullable();
    t.string('mime_type', 100).notNullable();
    t.integer('file_size_bytes').notNullable().defaultTo(0);
    t.string('s3_key', 500).notNullable();
    t.uuid('uploaded_by_tech_id').references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamps(true, true);

    t.index(['invoice_id', 'created_at']);
    t.index('customer_id');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('invoice_attachments');
};
