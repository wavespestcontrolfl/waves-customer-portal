/**
 * Strip "renewal" language from the annual-prepay year-end notices
 * (owner ruling 2026-07-13: "renewal" is reserved for termite bonds — the
 * one service with a real fixed term).
 *
 * The NOTICE itself stays — an annual-prepay term is a real paid year with
 * a real year-end date and a real next-year invoice — but the customer
 * -facing copy now describes it as the prepaid plan year ending, never as
 * a "membership renewal" (the membership itself is no-term).
 *
 *   1. membership.renewal_reminder email: publishes a new active version
 *      (deepen-migration pattern — versions are retained, operator edits
 *      live in their own versions). Template KEY and every payload
 *      variable are unchanged, so account-membership-email.js sends
 *      without modification.
 *   2. annual_prepay_renewal_reminder SMS: body reworded (tighten-copy
 *      migration pattern). RENEW/LAPSE/CHANGE were human-triage hints,
 *      not parsed keywords — no inbound handler keys on them.
 *
 * Internal identifiers (template keys, message_type, workflow names) keep
 * "renewal" — they are not customer-visible and renaming them would churn
 * logs and dedupe keys for zero customer effect.
 */

const EMAIL_TEMPLATE_KEY = 'membership.renewal_reminder';

const NEW_EMAIL_VERSION = {
  name: 'Annual Plan Year-End Notice',
  subject: 'Your prepaid Waves plan year ends soon',
  preview: 'Your prepaid plan year is coming to an end - here is what happens next.',
  blocks: [
    { type: 'paragraph', content: 'Hello {{first_name}}, your prepaid year with Waves is coming to an end - here is what happens next.' },
    { type: 'details', rows: [
      { label: 'Plan', value: '{{membership_name}}' },
      { label: 'Next year starts', value: '{{renewal_date}}' },
      { label: 'Notice window', value: '{{renewal_notice_window}}' },
      { label: 'Current rate', value: '{{monthly_rate}}' },
      { label: 'Billing cadence', value: '{{billing_cadence}}' },
      { label: 'Last scheduled service', value: '{{last_service_date}}' },
    ] },
    { type: 'paragraph', content: 'No action is needed if you want service to continue as scheduled.' },
    { type: 'paragraph', content: 'If you want to pause, cancel, change services, or talk through your options, reply before your next plan year begins.' },
    { type: 'cta', label: 'View membership', url_variable: 'customer_portal_url' },
  ],
};

const SMS_TEMPLATE_KEY = 'annual_prepay_renewal_reminder';

// GSM-7 only; no parsed keywords. Prior body (restored by down()) said
// "renews on {term_end}" and offered RENEW/LAPSE/CHANGE reply hints.
const NEW_SMS_BODY = 'Hello {first_name}! Your annual prepaid Waves plan continues for another year on {term_end}.{last_service_sentence}\n\nNo action needed to continue. Want to change or cancel? Just reply and our team will help.\n\nReply STOP to opt out.';
const PRIOR_SMS_BODY = 'Hello {first_name}! Your annual prepaid Waves plan renews on {term_end}.{last_service_sentence}\n\nReply RENEW, LAPSE, or CHANGE and our team will help.\n\nReply STOP to opt out.';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('email_templates') && await knex.schema.hasTable('email_template_versions')) {
    const template = await knex('email_templates').where({ template_key: EMAIL_TEMPLATE_KEY }).first();
    if (template) {
      const latest = await knex('email_template_versions')
        .where({ template_id: template.id })
        .orderBy('version_number', 'desc')
        .first();
      const [version] = await knex('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: NEW_EMAIL_VERSION.subject,
        preview_text: NEW_EMAIL_VERSION.preview,
        blocks: JSON.stringify(NEW_EMAIL_VERSION.blocks),
        text_body: null,
        published_at: new Date(),
      }).returning('*');

      await knex('email_template_versions')
        .where({ template_id: template.id })
        .whereNot({ id: version.id })
        .where({ status: 'active' })
        .update({ status: 'archived', updated_at: new Date() });

      await knex('email_templates').where({ id: template.id }).update({
        name: NEW_EMAIL_VERSION.name,
        active_version_id: version.id,
        status: 'active',
        last_published_at: new Date(),
        updated_at: new Date(),
      });
    }
  }

  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates')
      .where({ template_key: SMS_TEMPLATE_KEY })
      .update({ body: NEW_SMS_BODY, updated_at: new Date() });
  }
};

exports.down = async function down(knex) {
  // Email template versions are intentionally retained (deepen pattern) —
  // re-activating the prior version would need its id; operators can
  // restore any archived version from the admin editor.
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates')
      .where({ template_key: SMS_TEMPLATE_KEY })
      .update({ body: PRIOR_SMS_BODY, updated_at: new Date() });
  }
};

exports.__private = { NEW_EMAIL_VERSION, NEW_SMS_BODY, EMAIL_TEMPLATE_KEY, SMS_TEMPLATE_KEY };
