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
  if (await knex.schema.hasTable('tool_health_events')) {
    await addColumnIfMissing(knex, 'tool_health_events', 'metadata', (t) => t.jsonb('metadata'));
  }

  if (!(await knex.schema.hasTable('service_report_pdf_jobs'))) {
    await knex.schema.createTable('service_report_pdf_jobs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('service_record_id').notNullable().references('id').inTable('service_records').onDelete('CASCADE');
      t.string('status', 24).notNullable().defaultTo('queued');
      t.integer('attempts').notNullable().defaultTo(0);
      t.integer('max_attempts').notNullable().defaultTo(3);
      t.timestamp('next_attempt_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_attempt_at');
      t.timestamp('locked_at');
      t.timestamp('succeeded_at');
      t.timestamp('failed_at');
      t.text('pdf_storage_key');
      t.text('last_error');
      t.jsonb('payload').notNullable().defaultTo(knex.raw("'{}'::jsonb"));
      t.timestamps(true, true);
      t.index(['status', 'next_attempt_at']);
      t.index(['service_record_id']);
    });
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_service_report_pdf_jobs_active_record
      ON service_report_pdf_jobs(service_record_id)
      WHERE status IN ('queued', 'rendering')
    `);
  }

  if (await knex.schema.hasTable('service_records')) {
    await knex.raw(`
      WITH first_capture AS (
        SELECT sr.id,
               LEAST(
                 COALESCE((
                   SELECT MIN(sp.applied_at)
                   FROM service_products sp
                   WHERE sp.service_record_id = sr.id
                     AND sp.applied_at >= sr.service_date::date
                     AND sp.applied_at < (sr.service_date::date + INTERVAL '2 days')
                 ), 'infinity'::timestamp),
                 COALESCE((SELECT MIN(sph.captured_at) FROM service_photos sph WHERE sph.service_record_id = sr.id), 'infinity'::timestamp),
                 COALESCE((SELECT MIN(sph.created_at) FROM service_photos sph WHERE sph.service_record_id = sr.id), 'infinity'::timestamp)
               ) AS inferred_started_at
        FROM service_records sr
        WHERE sr.status IN ('completed', 'complete')
      )
      UPDATE service_records sr
      SET started_at = fc.inferred_started_at
      FROM first_capture fc
      WHERE sr.id = fc.id
        AND fc.inferred_started_at <> 'infinity'::timestamp
        AND (
          sr.started_at IS NULL
          OR sr.started_at = date_trunc('day', sr.started_at)
        )
    `).catch(() => {});
  }

  if (await knex.schema.hasTable('products_catalog')) {
    await addColumnIfMissing(knex, 'products_catalog', 'ai_pct', (t) => t.decimal('ai_pct', 6, 3));
    await addColumnIfMissing(knex, 'products_catalog', 'epa_reg_number', (t) => t.string('epa_reg_number', 40));
    await addColumnIfMissing(knex, 'products_catalog', 'formulation', (t) => t.string('formulation', 80));

    await knex('products_catalog')
      .whereRaw('LOWER(name) = ?', ['bifen xts'])
      .where(function missingBifenFields() {
        this.whereRaw("NULLIF(TRIM(active_ingredient), '') IS NULL")
          .orWhereRaw("NULLIF(TRIM(epa_reg_number), '') IS NULL");
      })
      .update({
        active_ingredient: 'Bifenthrin',
        ai_pct: 25.1,
        epa_reg_number: '53883-219',
        formulation: 'EC concentrate',
      });

    await knex('products_catalog')
      .whereRaw("NULLIF(TRIM(active_ingredient), '') IS NULL")
      .update({ active_ingredient: 'Unknown - pending SDS' });
    await knex('products_catalog')
      .whereRaw("NULLIF(TRIM(epa_reg_number), '') IS NULL")
      .update({ epa_reg_number: 'N/A' });
    await knex('products_catalog')
      .whereRaw("NULLIF(TRIM(formulation), '') IS NULL")
      .update({ formulation: 'unspecified' });

    await knex.raw('ALTER TABLE products_catalog ALTER COLUMN active_ingredient SET NOT NULL').catch(() => {});
    await knex.raw('ALTER TABLE products_catalog ALTER COLUMN epa_reg_number SET NOT NULL').catch(() => {});
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('service_report_pdf_jobs')) {
    await knex.raw('DROP INDEX IF EXISTS idx_service_report_pdf_jobs_active_record');
    await knex.schema.dropTableIfExists('service_report_pdf_jobs');
  }
  if (await knex.schema.hasTable('tool_health_events')) {
    await dropColumnIfPresent(knex, 'tool_health_events', 'metadata');
  }
  if (await knex.schema.hasTable('products_catalog')) {
    await knex.raw('ALTER TABLE products_catalog ALTER COLUMN epa_reg_number DROP NOT NULL').catch(() => {});
    await knex.raw('ALTER TABLE products_catalog ALTER COLUMN active_ingredient DROP NOT NULL').catch(() => {});
    await dropColumnIfPresent(knex, 'products_catalog', 'ai_pct');
  }
};
