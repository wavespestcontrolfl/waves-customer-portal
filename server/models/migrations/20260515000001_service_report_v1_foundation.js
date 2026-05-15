/**
 * Service report v1 foundation.
 *
 * This repo models a serviced property as a customer profile, so the spec's
 * property_id foreign keys are represented as customer_id here. All changes are
 * additive and scoped by service_records.report_template_version.
 */

async function addColumnIfMissing(knex, table, name, add) {
  if (!(await knex.schema.hasColumn(table, name))) {
    await knex.schema.alterTable(table, (t) => add(t));
  }
}

async function dropColumnIfPresent(knex, table, name) {
  if (await knex.schema.hasColumn(table, name)) {
    await knex.schema.alterTable(table, (t) => t.dropColumn(name));
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_geometries'))) {
    await knex.schema.createTable('property_geometries', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.jsonb('geometry').notNullable();
      t.integer('version').notNullable().defaultTo(1);
      t.uuid('captured_by').references('id').inTable('technicians').onDelete('SET NULL');
      t.timestamp('captured_at').notNullable().defaultTo(knex.fn.now());
      t.timestamps(true, true);
      t.unique(['customer_id', 'version']);
      t.index(['customer_id']);
    });
  }

  if (!(await knex.schema.hasTable('property_zones'))) {
    await knex.schema.createTable('property_zones', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('letter', 1).notNullable();
      t.text('label').notNullable();
      t.string('category', 40).notNullable();
      t.jsonb('geometry').notNullable();
      t.specificType('service_lines', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]"));
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamps(true, true);
      t.unique(['customer_id', 'letter']);
    });
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_property_zones_customer_active ON property_zones(customer_id) WHERE is_active = true');
  }

  await addColumnIfMissing(knex, 'service_records', 'report_template_version', (t) => t.string('report_template_version', 60));
  await addColumnIfMissing(knex, 'service_records', 'service_line', (t) => t.string('service_line', 40));
  await addColumnIfMissing(knex, 'service_records', 'service_tier', (t) => t.string('service_tier', 40));
  await addColumnIfMissing(knex, 'service_records', 'visit_number', (t) => t.integer('visit_number'));
  await addColumnIfMissing(knex, 'service_records', 'started_at', (t) => t.timestamp('started_at'));
  await addColumnIfMissing(knex, 'service_records', 'ended_at', (t) => t.timestamp('ended_at'));
  await addColumnIfMissing(knex, 'service_records', 'conditions', (t) => t.jsonb('conditions'));
  await addColumnIfMissing(knex, 'service_records', 'pressure_index', (t) => t.decimal('pressure_index', 3, 1));
  await addColumnIfMissing(knex, 'service_records', 'service_data', (t) => t.jsonb('service_data').notNullable().defaultTo(knex.raw("'{}'::jsonb")));
  await addColumnIfMissing(knex, 'service_records', 'advisory', (t) => t.jsonb('advisory'));
  await addColumnIfMissing(knex, 'service_records', 'next_service_date', (t) => t.date('next_service_date'));
  await addColumnIfMissing(knex, 'service_records', 'map_svg_storage_key', (t) => t.text('map_svg_storage_key'));
  await addColumnIfMissing(knex, 'service_records', 'report_html_storage_key', (t) => t.text('report_html_storage_key'));
  await addColumnIfMissing(knex, 'service_records', 'pdf_storage_key', (t) => t.text('pdf_storage_key'));
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_service_records_report_v1 ON service_records(customer_id, service_date DESC) WHERE report_template_version = 'service_report_v1'");
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_service_records_pressure ON service_records(customer_id, service_line, service_date DESC) WHERE pressure_index IS NOT NULL');

  await addColumnIfMissing(knex, 'service_products', 'product_id', (t) => t.uuid('product_id').references('id').inTable('products_catalog').onDelete('SET NULL'));
  await addColumnIfMissing(knex, 'service_products', 'zone_ids', (t) => t.specificType('zone_ids', 'uuid[]').notNullable().defaultTo(knex.raw("'{}'::uuid[]")));
  await addColumnIfMissing(knex, 'service_products', 'targets', (t) => t.specificType('targets', 'text[]').notNullable().defaultTo(knex.raw("'{}'::text[]")));
  await addColumnIfMissing(knex, 'service_products', 'area_value', (t) => t.decimal('area_value', 10, 2));
  await addColumnIfMissing(knex, 'service_products', 'area_unit', (t) => t.string('area_unit', 30));
  await addColumnIfMissing(knex, 'service_products', 'applied_at', (t) => t.timestamp('applied_at').notNullable().defaultTo(knex.fn.now()));

  if (!(await knex.schema.hasTable('service_findings'))) {
    await knex.schema.createTable('service_findings', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
      t.uuid('zone_id').references('id').inTable('property_zones').onDelete('SET NULL');
      t.string('category', 60).notNullable();
      t.string('severity', 20).notNullable();
      t.text('title').notNullable();
      t.text('detail');
      t.text('recommendation');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['service_record_id']);
    });
  }

  if (await knex.schema.hasTable('service_photos')) {
    await addColumnIfMissing(knex, 'service_photos', 'zone_id', (t) => t.uuid('zone_id').references('id').inTable('property_zones').onDelete('SET NULL'));
    await addColumnIfMissing(knex, 'service_photos', 'finding_id', (t) => t.uuid('finding_id').references('id').inTable('service_findings').onDelete('SET NULL'));
    await addColumnIfMissing(knex, 'service_photos', 'storage_key', (t) => t.text('storage_key'));
    await addColumnIfMissing(knex, 'service_photos', 'thumbnail_key', (t) => t.text('thumbnail_key'));
    await addColumnIfMissing(knex, 'service_photos', 'state_badge', (t) => t.string('state_badge', 30));
    await addColumnIfMissing(knex, 'service_photos', 'gps_lat', (t) => t.decimal('gps_lat', 9, 6));
    await addColumnIfMissing(knex, 'service_photos', 'gps_lng', (t) => t.decimal('gps_lng', 9, 6));
    await addColumnIfMissing(knex, 'service_photos', 'captured_at', (t) => t.timestamp('captured_at'));
    await addColumnIfMissing(knex, 'service_photos', 'device', (t) => t.text('device'));
    await addColumnIfMissing(knex, 'service_photos', 'app_version', (t) => t.text('app_version'));
    await addColumnIfMissing(knex, 'service_photos', 'ai_tags', (t) => t.jsonb('ai_tags'));
    await addColumnIfMissing(knex, 'service_photos', 'annotation', (t) => t.jsonb('annotation'));
    await addColumnIfMissing(knex, 'service_photos', 'hash_sha256', (t) => t.string('hash_sha256', 64));
    await addColumnIfMissing(knex, 'service_photos', 'prev_hash_sha256', (t) => t.string('prev_hash_sha256', 64));
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_service_photos_zone ON service_photos(zone_id)');
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('service_photos')) {
    await knex.raw('DROP INDEX IF EXISTS idx_service_photos_zone');
    for (const column of [
      'prev_hash_sha256', 'hash_sha256', 'annotation', 'ai_tags',
      'app_version', 'device', 'captured_at', 'gps_lng', 'gps_lat',
      'state_badge', 'thumbnail_key', 'storage_key', 'finding_id', 'zone_id',
    ]) {
      await dropColumnIfPresent(knex, 'service_photos', column);
    }
  }

  await knex.schema.dropTableIfExists('service_findings');

  for (const column of ['applied_at', 'area_unit', 'area_value', 'targets', 'zone_ids', 'product_id']) {
    await dropColumnIfPresent(knex, 'service_products', column);
  }

  await knex.raw('DROP INDEX IF EXISTS idx_service_records_pressure');
  await knex.raw('DROP INDEX IF EXISTS idx_service_records_report_v1');
  for (const column of [
    'pdf_storage_key', 'report_html_storage_key', 'map_svg_storage_key',
    'next_service_date', 'advisory', 'service_data', 'pressure_index',
    'conditions', 'ended_at', 'started_at', 'visit_number', 'service_tier',
    'service_line', 'report_template_version',
  ]) {
    await dropColumnIfPresent(knex, 'service_records', column);
  }

  await knex.raw('DROP INDEX IF EXISTS idx_property_zones_customer_active');
  await knex.schema.dropTableIfExists('property_zones');
  await knex.schema.dropTableIfExists('property_geometries');
};
