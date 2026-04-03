/**
 * Customer Documents — WDO reports, contracts, auto-generated service reports, compliance docs
 */
exports.up = async function (knex) {
  await knex.schema.createTable('customer_documents', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.enu('document_type', [
      'wdo_inspection', 'service_agreement', 'annual_summary',
      'pesticide_record', 'invoice', 'service_report',
      'insurance_cert', 'proposal', 'other',
    ]).notNullable();
    t.string('title', 255).notNullable();
    t.string('description', 500);
    t.string('s3_key', 300); // null for auto-generated docs
    t.string('file_name', 255).notNullable();
    t.integer('file_size_bytes');
    t.string('uploaded_by', 30).defaultTo('admin'); // admin, system, auto_generated
    t.uuid('linked_service_record_id').references('id').inTable('service_records').onDelete('SET NULL');
    t.date('expiration_date');
    t.boolean('is_shared_with_third_party').defaultTo(false);
    t.timestamps(true, true);

    t.index(['customer_id', 'document_type']);
    t.index('linked_service_record_id');
  });

  // Shared document links — temporary public access for realtors etc.
  await knex.schema.createTable('document_share_links', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('document_id').references('id').inTable('customer_documents').onDelete('CASCADE');
    t.string('share_token', 64).notNullable().unique();
    t.timestamp('expires_at').notNullable();
    t.integer('access_count').defaultTo(0);
    t.timestamps(true, true);

    t.index('share_token');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('document_share_links');
  await knex.schema.dropTableIfExists('customer_documents');
};
