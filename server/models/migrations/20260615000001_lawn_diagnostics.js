const DIAGNOSTIC_MODES = ['internal', 'prospect'];
const DIAGNOSTIC_STATUSES = ['draft', 'analyzed', 'sent', 'archived'];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_diagnostics'))) {
    await knex.schema.createTable('lawn_diagnostics', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('mode', 20).notNullable().defaultTo('internal');
      t.string('status', 20).notNullable().defaultTo('draft');
      t.uuid('lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');
      t.jsonb('contact_snapshot').nullable();
      t.jsonb('address_snapshot').nullable();
      t.uuid('created_by_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.jsonb('ai_analysis').notNullable().defaultTo('{}');
      t.jsonb('report_contract').notNullable().defaultTo('{}');
      t.decimal('ai_confidence', 4, 3).nullable();
      t.integer('overall_score').nullable();
      t.text('ai_summary').nullable();
      t.string('report_token', 32).unique();
      t.timestamp('report_expires_at', { useTz: true }).nullable();
      t.timestamp('last_sent_at', { useTz: true }).nullable();
      t.timestamp('archived_at', { useTz: true }).nullable();
      t.timestamps(true, true);

      t.index(['mode', 'status']);
      t.index(['created_by_technician_id', 'created_at']);
      t.index(['lead_id']);
    });

    await knex.raw(`
      ALTER TABLE lawn_diagnostics
      ADD CONSTRAINT lawn_diagnostics_mode_check CHECK (mode IN (${quoted(DIAGNOSTIC_MODES)}))
    `);
    await knex.raw(`
      ALTER TABLE lawn_diagnostics
      ADD CONSTRAINT lawn_diagnostics_status_check CHECK (status IN (${quoted(DIAGNOSTIC_STATUSES)}))
    `);
  }

  if (!(await knex.schema.hasTable('lawn_diagnostic_photos'))) {
    await knex.schema.createTable('lawn_diagnostic_photos', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('diagnostic_id').notNullable().references('id').inTable('lawn_diagnostics').onDelete('CASCADE');
      t.integer('photo_index').notNullable().defaultTo(0);
      t.string('s3_key', 500).nullable();
      t.string('mime_type', 80).notNullable().defaultTo('image/jpeg');
      t.jsonb('quality_check').nullable();
      t.jsonb('ai_analysis').nullable();
      t.jsonb('composite_scores').nullable();
      t.boolean('customer_visible').notNullable().defaultTo(true);
      t.timestamps(true, true);

      t.index(['diagnostic_id', 'photo_index']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('lawn_diagnostic_photos');
  if (await knex.schema.hasTable('lawn_diagnostics')) {
    await knex.raw('ALTER TABLE lawn_diagnostics DROP CONSTRAINT IF EXISTS lawn_diagnostics_status_check');
    await knex.raw('ALTER TABLE lawn_diagnostics DROP CONSTRAINT IF EXISTS lawn_diagnostics_mode_check');
    await knex.schema.dropTable('lawn_diagnostics');
  }
};
