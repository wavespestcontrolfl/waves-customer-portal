exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('company_documents'))) {
    await knex.schema.createTable('company_documents', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('title', 200).notNullable();
      t.string('category', 50).notNullable().defaultTo('general');
      // categories: sop, onboarding, offer_letter, policy, training, safety, general
      t.text('description');
      t.string('file_name', 255).notNullable();
      t.string('file_type', 50); // pdf, docx, xlsx, png, etc.
      t.integer('file_size'); // bytes
      t.string('s3_key', 500).notNullable();
      t.uuid('uploaded_by'); // technician id (admin)
      t.boolean('is_archived').defaultTo(false);
      t.timestamps(true, true);
    });
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('company_documents');
};
