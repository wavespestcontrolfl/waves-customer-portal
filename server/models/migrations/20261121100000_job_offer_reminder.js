/**
 * Job offer flow, step 4b: the 2-day reminder (GATE_JOB_OFFER_REMINDER, default off).
 *
 * 1. job_offers.reminder_claimed_at. The reminder pass sets it when it takes an offer, before anything is sent. An
 *    offer is taken once, so a send that failed is never tried again and no applicant gets a second reminder.
 *    reminder_sent_at (created with the table) is set after the send, only when a text or an email went out or may
 *    have: the two facts stay apart, so the offer timeline never says "Reminder sent" for a reminder that did not go.
 * 2. The reminder text (`job_offer_reminder`). The seed only INSERTS a missing row: an existing row (an admin's own
 *    wording) is never touched, and one audit_log event records the row it adds.
 *
 * down() removes nothing. A claim is the one record that an offer's reminder was tried (a send can reach the applicant
 * with no reminder_sent_at stored), so the column stays: a rollback and a second up() cannot lead to a second
 * reminder. The text template row stays too: it is admin-editable once seeded, so a rollback must not delete
 * someone's wording. Both are inert without the code that reads them, and up() skips what is already there.
 */

const MIGRATION = '20261121100000_job_offer_reminder';
const AUDIT_ACTION = 'sms_template.job_offer_reminder_seeded';
const COLUMN = 'reminder_claimed_at';

const TEMPLATE = {
  template_key: 'job_offer_reminder',
  name: 'Job Offer Reminder',
  category: 'recruiting',
  body: "Hi {first_name}, it's Adam with Waves. Your job offer is still open until {expires_on}: {offer_link} Reply STOP to opt out.",
  variables: ['first_name', 'offer_link', 'expires_on'],
  sort_order: 47,
};

async function seedTemplate(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const existing = await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (existing) return; // an existing row is someone's wording: leave it alone
  const [row] = await knex('sms_templates').insert({
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: TEMPLATE.sort_order,
    is_active: true,
  }).returning('id');
  if (await knex.schema.hasTable('audit_log')) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system', action: AUDIT_ACTION,
      resource_type: 'sms_templates', resource_id: String((row && row.id) || row || TEMPLATE.template_key),
      metadata: { migration: MIGRATION, template_key: TEMPLATE.template_key, body: TEMPLATE.body },
      critical: true, trx: knex,
    });
  }
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('job_offers') && !(await knex.schema.hasColumn('job_offers', COLUMN))) {
    await knex.schema.alterTable('job_offers', (t) => {
      t.timestamp(COLUMN, { useTz: true }).nullable();
    });
  }
  await seedTemplate(knex);
};

// Removes nothing: the claims are the record that a reminder was tried, and the text template row is admin-editable.
exports.down = async function down() {};

exports._TEMPLATE = TEMPLATE;
exports._AUDIT_ACTION = AUDIT_ACTION;
