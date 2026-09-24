/**
 * Admin tree & shrub photo assessments (third photo-assessment type).
 *
 * New `tree_shrub_identifications` (+ `tree_shrub_identification_photos`)
 * tables for admin-created tree & shrub assessments run on prospect/customer
 * photos (uploaded, or pulled from an inbound SMS thread) with no tech visit.
 *
 * Deliberately NOT the visit-keyed `tree_shrub_assessments` table: those rows
 * are keyed to a service record and feed the tech visit report + customer
 * trend history (buildTreeShrubAssessmentReportData reads every confirmed row
 * for the customer), so a prospect/admin assessment must never land there.
 *
 * Shape mirrors `pest_identifications` / `pest_identification_photos`
 * (20260707000030_prospect_photo_assessments.js) — same mode/status/source
 * lifecycle, contact/address snapshots, claim/report token columns (kept for
 * parity; no public tree & shrub report exists yet), and the same indexes.
 * The pest-specific triage columns are replaced by the tree & shrub list
 * fields: overall_score (0-100 health) and worst_signal (category key).
 */

const MODES = ['internal', 'prospect'];
const STATUSES = ['draft', 'analyzed', 'sent', 'archived'];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tree_shrub_identifications'))) {
    await knex.schema.createTable('tree_shrub_identifications', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('mode', 20).notNullable().defaultTo('prospect');
      t.string('status', 20).notNullable().defaultTo('draft');
      t.string('source', 30).notNullable().defaultTo('admin');
      t.uuid('lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');
      t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
      t.jsonb('contact_snapshot').nullable();
      t.jsonb('address_snapshot').nullable();
      t.uuid('created_by_technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
      t.jsonb('ai_analysis').notNullable().defaultTo('{}');
      t.jsonb('report_contract').notNullable().defaultTo('{}');
      // Denormalized list fields (also inside report_contract) so the admin
      // list can show the headline without unpacking JSON.
      t.integer('overall_score').nullable();
      t.string('worst_signal', 40).nullable();
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
      ALTER TABLE tree_shrub_identifications
      ADD CONSTRAINT tree_shrub_identifications_mode_check CHECK (mode IN (${quoted(MODES)}))
    `);
    await knex.raw(`
      ALTER TABLE tree_shrub_identifications
      ADD CONSTRAINT tree_shrub_identifications_status_check CHECK (status IN (${quoted(STATUSES)}))
    `);
  }

  if (!(await knex.schema.hasTable('tree_shrub_identification_photos'))) {
    await knex.schema.createTable('tree_shrub_identification_photos', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('identification_id').notNullable().references('id').inTable('tree_shrub_identifications').onDelete('CASCADE');
      t.integer('photo_index').notNullable().defaultTo(0);
      t.string('s3_key', 500).nullable();
      t.string('mime_type', 80).notNullable().defaultTo('image/jpeg');
      t.jsonb('ai_analysis').nullable();
      t.boolean('customer_visible').notNullable().defaultTo(true);
      t.timestamps(true, true);

      // Explicit name: knex's default for this pair runs past Postgres's
      // 63-character identifier limit and would be silently truncated.
      t.index(['identification_id', 'photo_index'], 'tree_shrub_ident_photos_ident_idx_photo_idx');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('tree_shrub_identification_photos');
  if (await knex.schema.hasTable('tree_shrub_identifications')) {
    await knex.raw('ALTER TABLE tree_shrub_identifications DROP CONSTRAINT IF EXISTS tree_shrub_identifications_status_check');
    await knex.raw('ALTER TABLE tree_shrub_identifications DROP CONSTRAINT IF EXISTS tree_shrub_identifications_mode_check');
    await knex.schema.dropTable('tree_shrub_identifications');
  }
};
