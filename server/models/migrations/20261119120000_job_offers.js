/**
 * Job offers (GATE_JOB_OFFERS, dark by default; owner "build" 2026-11-19, plan
 * "Job Offer Flow Plan"): the owner opens an Offer form on a Recruiting
 * application, reads the exact letter and presses Send; the applicant reads his
 * personal terms and the issued Technician Terms on a private link, then signs,
 * asks for another start date, or declines.
 *
 * One row per offer. A draft and an offer that is out (sent, date_requested) are each unique per
 * application; a revised offer is a NEW row that points back at the one it
 * replaces (supersedes_id / superseded_by_id), so every version the applicant
 * ever saw stays on file. Everything the applicant sees is frozen at send in
 * `snapshot` (+ `snapshot_hash`), with the issued Terms version named by
 * `terms_version_id` / `terms_content_hash`; the signature record hashes both.
 *
 * Columns for later steps (technician_id, activated_at, checklist,
 * reminder_sent_at) are created now so those steps need no ALTER.
 *
 * Also seeds the one applicant text this step sends (`job_offer_sent`). The seed
 * only INSERTS a missing row: an existing row (an admin's own wording) is never
 * touched, and one audit_log event records each row it adds.
 *
 * down() drops the table. It leaves the text template row alone: the row is
 * admin-editable once seeded, so a rollback must not delete someone's wording.
 */

const MIGRATION = '20261119120000_job_offers';
const AUDIT_ACTION = 'sms_template.job_offer_sent_seeded';

const STATUSES = ['draft', 'sent', 'accepted', 'declined', 'date_requested', 'expired', 'withdrawn', 'superseded'];

const TEMPLATES = [
  {
    template_key: 'job_offer_sent',
    name: 'Job Offer Sent',
    category: 'recruiting',
    body: "Hi {first_name}, it's Adam with Waves. Your job offer is ready to read and sign: {offer_link} It stays open until {expires_on}. Reply STOP to opt out.",
    variables: ['first_name', 'offer_link', 'expires_on'],
    sort_order: 46,
  },
];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

async function createTable(knex) {
  await knex.schema.createTable('job_offers', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('application_id').notNullable().references('id').inTable('job_applications').onDelete('CASCADE');
    t.string('status', 20).notNullable().defaultTo('draft');

    // Bearer link: 32 random bytes as hex, set at send.
    t.string('token', 64).nullable().unique();
    t.timestamp('token_created_at', { useTz: true }).nullable();

    t.string('job_title', 100).notNullable().defaultTo('Pest Control Technician');
    t.date('start_date').notNullable();
    t.decimal('hourly_rate', 8, 2).notNullable();
    t.decimal('step_rate', 8, 2).nullable();
    t.date('step_effective_on').nullable();
    t.string('hours_line', 300).notNullable();
    t.string('report_to', 120).notNullable();
    t.string('pay_day_line', 500).nullable();
    t.timestamp('expires_at', { useTz: true }).nullable();

    // The issued Technician Terms the offer was sent with (frozen at send).
    t.uuid('terms_template_id').nullable();
    t.uuid('terms_version_id').nullable();
    t.string('terms_content_hash', 64).nullable();
    t.jsonb('snapshot').nullable();
    t.string('snapshot_hash', 64).nullable();

    t.timestamp('sent_at', { useTz: true }).nullable();
    t.uuid('sent_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('opened_at', { useTz: true }).nullable();
    t.timestamp('last_viewed_at', { useTz: true }).nullable();
    t.timestamp('text_consent_at', { useTz: true }).nullable();
    t.timestamp('reminder_sent_at', { useTz: true }).nullable();

    t.timestamp('signed_at', { useTz: true }).nullable();
    t.string('signed_name', 120).nullable();
    t.string('signed_ip', 64).nullable();
    t.string('signed_user_agent', 300).nullable();
    t.string('signature_hash', 64).nullable();

    t.timestamp('declined_at', { useTz: true }).nullable();
    t.string('decline_reason', 500).nullable();

    t.timestamp('date_requested_at', { useTz: true }).nullable();
    t.date('requested_start_date').nullable();
    t.string('date_request_note', 500).nullable();

    t.timestamp('withdrawn_at', { useTz: true }).nullable();
    t.uuid('withdrawn_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');

    t.uuid('supersedes_id').nullable().references('id').inTable('job_offers').onDelete('SET NULL');
    t.uuid('superseded_by_id').nullable().references('id').inTable('job_offers').onDelete('SET NULL');

    t.uuid('technician_id').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamp('activated_at', { useTz: true }).nullable();
    t.jsonb('checklist').notNullable().defaultTo('{}');

    t.uuid('created_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    t.timestamps(true, true);

    t.index(['application_id', 'created_at'], 'job_offers_application_created_idx');
    t.index(['status', 'expires_at'], 'job_offers_status_expires_idx');
    t.index(['status', 'start_date'], 'job_offers_status_start_idx');
  });

  await knex.raw(`ALTER TABLE job_offers ADD CONSTRAINT job_offers_status_check CHECK (status IN (${quoted(STATUSES)}))`);
  // At most one DRAFT and at most one offer that is OUT (sent, or answered with a date request) per application. They
  // are separate on purpose: a revised offer is a new draft while the old one stays out until the draft is sent, so a
  // single index over all three statuses would refuse the revise.
  await knex.raw(`CREATE UNIQUE INDEX job_offers_one_draft_per_application
    ON job_offers (application_id) WHERE status = 'draft'`);
  await knex.raw(`CREATE UNIQUE INDEX job_offers_one_out_per_application
    ON job_offers (application_id) WHERE status IN ('sent', 'date_requested')`);
}

async function seedTemplates(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  for (const tpl of TEMPLATES) {
    const existing = await knex('sms_templates').where({ template_key: tpl.template_key }).first();
    if (existing) continue; // an existing row is someone's wording: leave it alone
    const [row] = await knex('sms_templates').insert({
      template_key: tpl.template_key,
      name: tpl.name,
      category: tpl.category,
      body: tpl.body,
      variables: JSON.stringify(tpl.variables),
      sort_order: tpl.sort_order,
      is_active: true,
    }).returning('id');
    if (hasAudit) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system', action: AUDIT_ACTION,
        resource_type: 'sms_templates', resource_id: String((row && row.id) || row || tpl.template_key),
        metadata: { migration: MIGRATION, template_key: tpl.template_key, body: tpl.body },
        critical: true, trx: knex,
      });
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('job_offers'))) {
    await createTable(knex);
  }
  await seedTemplates(knex);
};

// The text template row stays: it is admin-editable once seeded.
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('job_offers');
};

exports._TEMPLATES = TEMPLATES;
exports._STATUSES = STATUSES;
exports._AUDIT_ACTION = AUDIT_ACTION;
