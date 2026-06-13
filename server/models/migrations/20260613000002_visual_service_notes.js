exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('visual_service_moments'))) {
    await knex.schema.createTable('visual_service_moments', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('job_id').notNullable().references('id').inTable('scheduled_services').onDelete('CASCADE');
      t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
      t.uuid('property_id').nullable();
      t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.uuid('route_id').nullable();
      t.string('tag_code', 80).notNullable();
      t.string('tag_label', 120).notNullable();
      t.string('tag_group', 40).notNullable();
      t.string('service_type', 40).notNullable().defaultTo('other');
      t.string('location_area', 80).nullable();
      t.text('note').nullable();
      t.string('media_type', 20).notNullable().defaultTo('none');
      t.text('media_url').nullable();
      t.string('media_storage_key', 500).nullable();
      t.text('thumbnail_url').nullable();
      t.string('thumbnail_storage_key', 500).nullable();
      t.integer('media_duration_seconds').nullable();
      t.string('upload_status', 20).notNullable().defaultTo('uploaded');
      t.string('processing_status', 20).notNullable().defaultTo('none');
      t.string('visibility_status', 30).notNullable().defaultTo('internal_only');
      t.text('ai_caption').nullable();
      t.text('customer_caption').nullable();
      t.decimal('gps_latitude', 10, 7).nullable();
      t.decimal('gps_longitude', 10, 7).nullable();
      t.timestamp('captured_at').notNullable().defaultTo(knex.fn.now());
      t.timestamps(true, true);
      t.timestamp('deleted_at').nullable();
      t.jsonb('metadata').notNullable().defaultTo(knex.raw("'{}'::jsonb"));

      t.index(['job_id', 'deleted_at']);
      t.index(['customer_id', 'captured_at']);
      t.index(['technician_id', 'captured_at']);
      t.index(['visibility_status', 'deleted_at']);
      t.index(['tag_code']);
    });
  }

  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings')
      .insert([
        {
          key: 'visualServiceNotesEnabled',
          value: 'false',
          category: 'visual_service_notes',
          description: 'Global enable flag for optional Visual Service Notes. User feature flag visual_service_notes_enabled can also enable it per user.',
        },
        {
          key: 'visualServiceNotesRequired',
          value: 'false',
          category: 'visual_service_notes',
          description: 'Future-only setting for requiring Visual Service Notes. Default false and not enforced in MVP.',
        },
      ])
      .onConflict('key')
      .ignore();
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings')
      .whereIn('key', ['visualServiceNotesEnabled', 'visualServiceNotesRequired'])
      .del();
  }
  await knex.schema.dropTableIfExists('visual_service_moments');
};
