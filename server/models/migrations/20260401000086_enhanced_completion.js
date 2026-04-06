exports.up = async function (knex) {
  // Add columns to service_records
  const srCols = await knex('service_records').columnInfo().catch(() => ({}));
  if (Object.keys(srCols).length) {
    await knex.schema.alterTable('service_records', t => {
      if (!srCols.structured_notes) t.jsonb('structured_notes').nullable();
      if (!srCols.ai_report) t.jsonb('ai_report').nullable();
      if (!srCols.areas_serviced) t.jsonb('areas_serviced').nullable();
      if (!srCols.customer_interaction) t.string('customer_interaction', 50).nullable();
      if (!srCols.is_callback) t.boolean('is_callback').defaultTo(false);
    });
  }

  // Add columns to service_products
  const spCols = await knex('service_products').columnInfo().catch(() => ({}));
  if (Object.keys(spCols).length) {
    await knex.schema.alterTable('service_products', t => {
      if (!spCols.application_method) t.string('application_method', 50).nullable();
      if (!spCols.application_area) t.string('application_area', 50).nullable();
      if (!spCols.epa_reg_number) t.string('epa_reg_number', 50).nullable();
    });
  }

  // Create service_photos table
  if (!(await knex.schema.hasTable('service_photos'))) {
    await knex.schema.createTable('service_photos', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
      t.string('filename', 255).notNullable();
      t.string('filepath', 500).notNullable();
      t.text('caption').nullable();
      t.integer('file_size').nullable();
      t.uuid('uploaded_by').nullable();
      t.timestamps(true, true);
      t.index(['service_record_id']);
    });
  }

  // Create satisfaction_queue table
  if (!(await knex.schema.hasTable('satisfaction_queue'))) {
    await knex.schema.createTable('satisfaction_queue', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
      t.string('service_type', 100).nullable();
      t.string('technician_name', 100).nullable();
      t.timestamp('scheduled_for').nullable();
      t.string('status', 20).notNullable().defaultTo('pending');
      t.integer('rating').nullable();
      t.boolean('directed_to_review').defaultTo(false);
      t.boolean('review_clicked').defaultTo(false);
      t.text('feedback_text').nullable();
      t.timestamps(true, true);
      t.index(['status', 'scheduled_for']);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('satisfaction_queue');
  await knex.schema.dropTableIfExists('service_photos');
};
