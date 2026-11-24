'use strict';

/**
 * Seed the two emails of the one-time job to plan offer (owner 2026-11-19, "build"):
 *
 *   nurture.plan_offer           day 3 after a paid one-time general pest or cockroach job, for a customer
 *                                with no plan: the Quarterly Pest Control Service estimate, setup fee $0.
 *   nurture.plan_offer_reminder  day 21: one reminder that the estimate ends on day 30.
 *
 * Both are seeded DRAFT. assertTemplateSendable (email-template-library.js) refuses a draft, so no code path
 * can send either one to a customer, and this PR adds no sender. The owner reads the words in the template
 * editor (its preview and its test send use the sample values seeded below), edits them there and approves
 * them before any customer send exists. The customer send is a later PR, through the email division ledger
 * (sendWithLedger).
 *
 * The rows follow nurture.expired_1 (20260928235000): the marketing_nurture stream and suppression group
 * (an unsubscribe applies), commercial_marketing, and service chrome pinned with service_pinned_v1. No
 * email_template_automations row is written: the automation executor must never send a marketing template.
 *
 * Insert-once: an existing template is left alone with everything under it, so a re-run never overwrites an
 * office edit. One email_template.seeded audit row per inserted template. down() is a documented no-op: a seed
 * rollback must not delete admin-owned content, and a draft sends nothing.
 *
 * Price copy is "per application" (AGENTS.md), never "per visit" and never a monthly total.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const MIGRATION_ID = '20261119210000_seed_onetime_plan_offer_email_templates';
const AUDIT_ACTION = 'email_template.seeded';
const CTA_LABEL = 'View estimate and book';
const CTA_URL_VARIABLE = 'estimate_url';
const SIGNATURE = { type: 'signature', content: 'Thank you, The Waves Team' };

const TEMPLATES = [
  {
    key: 'nurture.plan_offer',
    name: 'Nurture · Plan Offer After a One-Time Job',
    description: 'Day 3 after a paid one-time general pest or cockroach job, for a customer with no plan: the Quarterly Pest Control Service estimate with the setup fee at $0. Draft until the owner approves the words.',
    required: [
      'first_name', 'visit_weekday', 'visit_date_short', 'address_short', 'price_per_application', 'setup_fee',
      'next_visit_window', 'offer_end_date', 'estimate_url',
    ],
    subject: 'Your pest control plan estimate, with no setup fee',
    preview: 'Your {{visit_date_short}} visit counts as your first plan visit.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}},' },
      { type: 'paragraph', content: 'Thanks for having us out on {{visit_weekday}}, {{visit_date_short}}.' },
      { type: 'paragraph', content: "If you'd like us to keep the house protected all year, your estimate is below. That visit counts as your first plan visit. So there is no setup fee, and nothing to pay today." },
      { type: 'heading', content: 'Quarterly Pest Control Service' },
      {
        type: 'details',
        rows: [
          { label: 'Home', value: '{{address_short}}' },
          { label: 'Price', value: '{{price_per_application}} per application' },
          { label: 'Visits', value: 'Every 3 months' },
          { label: 'One-time setup fee', value: '$0 (normally {{setup_fee}})' },
          { label: 'Due today', value: '$0' },
          { label: 'Next visit', value: 'You pick, {{next_visit_window}}' },
        ],
      },
      { type: 'cta', label: CTA_LABEL, url_variable: CTA_URL_VARIABLE },
      { type: 'paragraph', content: 'You pay after each visit. Nothing is charged today.' },
      { type: 'paragraph', content: 'This estimate is good through {{offer_end_date}}.' },
      { type: 'paragraph', content: 'If you see activity between visits, a re-service is free.' },
      SIGNATURE,
      { type: 'small_note', content: 'This is an offer from Waves. You got it because we serviced your home on {{visit_date_short}}.' },
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', visit_weekday: 'Tuesday', visit_date_short: 'Nov 17', address_short: '12 Example Test Ln',
        price_per_application: '$100', setup_fee: '$99', next_visit_window: 'Feb 2 to Feb 16',
        offer_end_date: 'December 17', estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      },
    },
  },
  {
    key: 'nurture.plan_offer_reminder',
    name: 'Nurture · Plan Offer Reminder',
    description: 'Day 21 after the one-time job: one reminder that the Quarterly Pest Control Service estimate with the $0 setup fee ends on day 30. Draft until the owner approves the words.',
    required: ['first_name', 'price_per_application', 'offer_end_date', 'estimate_url'],
    subject: 'Your plan estimate ends {{offer_end_date}}',
    preview: 'No setup fee, and nothing to pay today.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}},' },
      { type: 'paragraph', content: 'Your estimate for Quarterly Pest Control Service is still open. It is {{price_per_application}} per application, with no setup fee and nothing to pay today.' },
      { type: 'cta', label: CTA_LABEL, url_variable: CTA_URL_VARIABLE },
      { type: 'paragraph', content: 'It ends {{offer_end_date}}.' },
      SIGNATURE,
      { type: 'small_note', content: 'This is an offer from Waves.' },
    ],
    fixtures: {
      full: {
        first_name: 'Jordan', price_per_application: '$100', offer_end_date: 'December 17',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      },
    },
  },
];

function templateRow(t) {
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'nurture',
    legal_classification: 'commercial_marketing',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'normal',
    send_stream: 'marketing_nurture',
    suppression_group_key: 'marketing_nurture',
    // Service chrome on a marketing stream: without this pin the library renders the newsletter wrapper.
    // The unsubscribe requirement is not affected; it keys on the suppression group.
    layout_wrapper_id: 'service_pinned_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: CTA_LABEL,
    default_cta_url_variable: CTA_URL_VARIABLE,
    allowed_variables: JSON.stringify(t.required),
    required_variables: JSON.stringify(t.required),
    optional_variables: JSON.stringify([]),
    status: 'draft',
  };
}

// Insert-once for the template, its version and its fixtures alike. A draft template carries a draft version
// and no active_version_id: publishVersion is the only path that makes either one active.
async function insertTemplate(knex, t, { hasFixtures, hasAuditLog }) {
  if (await knex('email_templates').where({ template_key: t.key }).first('id')) return;
  const now = new Date();
  const [template] = await knex('email_templates').insert({ ...templateRow(t), created_at: now, updated_at: now }).returning('*');
  await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'draft',
    subject: t.subject,
    preview_text: t.preview,
    blocks: JSON.stringify(t.blocks),
    text_body: null,
    created_at: now,
    updated_at: now,
  });
  if (hasFixtures) {
    for (const [name, payload] of Object.entries(t.fixtures)) {
      await knex('email_template_fixtures').insert({
        template_id: template.id, name, payload: JSON.stringify(payload), is_default: name === 'full',
        created_at: now, updated_at: now,
      });
    }
  }
  if (hasAuditLog) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: AUDIT_ACTION,
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: t.key, migration: MIGRATION_ID },
      trx: knex,
      critical: true,
    });
  }
}

exports.up = async function up(knex) {
  const hasTemplateTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTemplateTables) return;
  const tables = {
    hasFixtures: await knex.schema.hasTable('email_template_fixtures'),
    hasAuditLog: await knex.schema.hasTable('audit_log'),
  };
  for (const template of TEMPLATES) {
    await insertTemplate(knex, template, tables);
  }
};

exports.down = async function down() {
  // No-op on purpose (see the header): a seed rollback must not delete admin-owned content.
};

exports.TEMPLATES = TEMPLATES;
exports.__private = { templateRow };
