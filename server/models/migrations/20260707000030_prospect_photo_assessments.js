/**
 * Prospect photo-assessment funnels (lawn assessment + pest identifier).
 *
 * 1. lawn_diagnostics gains the public-funnel columns: a submission `source`
 *    (tech vs public funnel), a `claim_token` that gates the teaser → contact
 *    capture unlock, funnel-stage timestamps (`claimed_at`,
 *    `report_first_viewed_at`), a sanitized `pricing_snapshot`, and an
 *    optional `customer_id` link so an assessment can attach to an existing
 *    customer as well as a lead.
 * 2. New `pest_identifications` (+ `pest_identification_photos`) tables mirror
 *    the lawn_diagnostics shape for the pest-identifier funnel, plus
 *    pest-specific triage columns (category / species_slug / service_line /
 *    urgency) the admin list filters on.
 */

const MODES = ['internal', 'prospect'];
const STATUSES = ['draft', 'analyzed', 'sent', 'archived'];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

const LAWN_FUNNEL_COLUMNS = [
  ['source', (t) => t.string('source', 30).notNullable().defaultTo('tech')],
  ['claim_token', (t) => t.string('claim_token', 32).nullable().unique()],
  ['claimed_at', (t) => t.timestamp('claimed_at', { useTz: true }).nullable()],
  ['report_first_viewed_at', (t) => t.timestamp('report_first_viewed_at', { useTz: true }).nullable()],
  ['pricing_snapshot', (t) => t.jsonb('pricing_snapshot').nullable()],
  ['customer_id', (t) => t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL')],
];

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('lawn_diagnostics')) {
    for (const [column, add] of LAWN_FUNNEL_COLUMNS) {
      if (!(await knex.schema.hasColumn('lawn_diagnostics', column))) {
        await knex.schema.alterTable('lawn_diagnostics', (t) => { add(t); });
      }
    }
    // Funnel/admin list scans filter by submission source over recency.
    await knex.raw('CREATE INDEX IF NOT EXISTS lawn_diagnostics_source_created_idx ON lawn_diagnostics (source, created_at)');
  }

  if (!(await knex.schema.hasTable('pest_identifications'))) {
    await knex.schema.createTable('pest_identifications', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('mode', 20).notNullable().defaultTo('prospect');
      t.string('status', 20).notNullable().defaultTo('draft');
      t.string('source', 30).notNullable().defaultTo('tech');
      t.uuid('lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');
      t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
      t.jsonb('contact_snapshot').nullable();
      t.jsonb('address_snapshot').nullable();
      t.uuid('created_by_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.jsonb('ai_analysis').notNullable().defaultTo('{}');
      t.jsonb('report_contract').notNullable().defaultTo('{}');
      t.decimal('ai_confidence', 4, 3).nullable();
      // Denormalized triage fields (also inside report_contract) so the admin
      // list can filter without unpacking JSON.
      t.string('category', 30).nullable();
      t.string('species_slug', 60).nullable();
      t.string('service_line', 30).nullable();
      t.string('urgency', 16).nullable();
      t.text('ai_summary').nullable();
      t.string('report_token', 32).nullable().unique();
      t.timestamp('report_expires_at', { useTz: true }).nullable();
      t.string('claim_token', 32).nullable().unique();
      t.timestamp('claimed_at', { useTz: true }).nullable();
      t.timestamp('report_first_viewed_at', { useTz: true }).nullable();
      t.jsonb('pricing_snapshot').nullable();
      t.timestamp('last_sent_at', { useTz: true }).nullable();
      t.timestamp('archived_at', { useTz: true }).nullable();
      t.timestamps(true, true);

      t.index(['mode', 'status']);
      t.index(['lead_id']);
      t.index(['source', 'created_at']);
    });

    await knex.raw(`
      ALTER TABLE pest_identifications
      ADD CONSTRAINT pest_identifications_mode_check CHECK (mode IN (${quoted(MODES)}))
    `);
    await knex.raw(`
      ALTER TABLE pest_identifications
      ADD CONSTRAINT pest_identifications_status_check CHECK (status IN (${quoted(STATUSES)}))
    `);
  }

  if (!(await knex.schema.hasTable('pest_identification_photos'))) {
    await knex.schema.createTable('pest_identification_photos', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('identification_id').notNullable().references('id').inTable('pest_identifications').onDelete('CASCADE');
      t.integer('photo_index').notNullable().defaultTo(0);
      t.string('s3_key', 500).nullable();
      t.string('mime_type', 80).notNullable().defaultTo('image/jpeg');
      t.jsonb('ai_analysis').nullable();
      t.boolean('customer_visible').notNullable().defaultTo(true);
      t.timestamps(true, true);

      t.index(['identification_id', 'photo_index']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pest_identification_photos');
  if (await knex.schema.hasTable('pest_identifications')) {
    await knex.raw('ALTER TABLE pest_identifications DROP CONSTRAINT IF EXISTS pest_identifications_status_check');
    await knex.raw('ALTER TABLE pest_identifications DROP CONSTRAINT IF EXISTS pest_identifications_mode_check');
    await knex.schema.dropTable('pest_identifications');
  }

  if (await knex.schema.hasTable('lawn_diagnostics')) {
    await knex.raw('DROP INDEX IF EXISTS lawn_diagnostics_source_created_idx');
    for (const [column] of LAWN_FUNNEL_COLUMNS) {
      if (await knex.schema.hasColumn('lawn_diagnostics', column)) {
        await knex.schema.alterTable('lawn_diagnostics', (t) => { t.dropColumn(column); });
      }
    }
  }
};
