/**
 * Job applications — the pre-hire intake behind the public careers funnel
 * (GATE_JOB_APPLICATIONS, dark by default).
 *
 * Mirrors the pest_identifications shape: contact/answers as jsonb snapshots,
 * an AI screen stored as jsonb with denormalized ai_score/ai_recommendation
 * so the admin list can filter without unpacking JSON. Applicants are NOT
 * customers or leads — this table never references either (the call pipeline's
 * job_applicant rule: an applicant never mints a customer).
 *
 * The AI screen is ranking assist only; every status transition is the
 * owner's decision via the admin API (status_history keeps the audit trail).
 */

const ROLES = ['technician', 'sales', 'other'];
const STATUSES = ['new', 'reviewed', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('job_applications')) return;

  await knex.schema.createTable('job_applications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('role', 20).notNullable().defaultTo('technician');
    t.string('status', 20).notNullable().defaultTo('new');
    t.string('language', 5).notNullable().defaultTo('en');
    t.jsonb('contact_snapshot').notNullable().defaultTo('{}');
    t.jsonb('answers').notNullable().defaultTo('{}');
    t.jsonb('source').nullable();
    t.jsonb('ai_screen').nullable();
    t.integer('ai_score').nullable();
    t.string('ai_recommendation', 20).nullable();
    t.jsonb('status_history').notNullable().defaultTo('[]');
    t.timestamps(true, true);

    t.index(['status', 'created_at']);
    t.index(['ai_score']);
  });

  await knex.raw(`
    ALTER TABLE job_applications
    ADD CONSTRAINT job_applications_role_check CHECK (role IN (${quoted(ROLES)}))
  `);
  await knex.raw(`
    ALTER TABLE job_applications
    ADD CONSTRAINT job_applications_status_check CHECK (status IN (${quoted(STATUSES)}))
  `);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('job_applications')) {
    await knex.raw('ALTER TABLE job_applications DROP CONSTRAINT IF EXISTS job_applications_status_check');
    await knex.raw('ALTER TABLE job_applications DROP CONSTRAINT IF EXISTS job_applications_role_check');
    await knex.schema.dropTable('job_applications');
  }
};
