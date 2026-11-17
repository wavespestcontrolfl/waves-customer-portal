/**
 * Seed the four customer emails for a failed bank (ACH) payment, one per escalation stage of stripe-webhook's
 * handleAchFailure; stage 3 has two (Auto Pay moved to the card, or no card). Owner 2026-11-16, dark behind
 * GATE_ACH_FAILURE_EMAIL. The matching texts (ach_retry_notice, ach_card_fallback, ach_suspended) stay off (owner
 * 2026-09-28); this email is their only notice.
 *
 * Same shape as 20260522000002_seed_ach_processing_acknowledgment_templates (email half): transactional_required
 * stream, the transactional preference group first, one active version, one preview fixture. Editable from
 * the admin email templates library. The copy is NOT the texts' wording: their lines on a retry in 3 business days,
 * a switch to the card at the second failure and a bank update link at the third do not match the code, so each
 * email says only what happens.
 *
 * NEW keys, seeded directly (same convention as 20261008100000_membership_tier_upgraded_email_template). Idempotent:
 * a template row is inserted only when its key is absent, and its version only when it has no active version, so a
 * re-run never overwrites an operator's edits. The preference group is inserted only when missing (it exists in
 * production; it is never rewritten). Each seeded template writes one audit_log event (email_template.seeded).
 * down() is a documented NO-OP: once seeded the templates are admin-editable, and removing them on rollback would
 * destroy those edits; the sender is dark behind its gate, so an unused template row is inert.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_BLOCKS_HEAD = [{ type: 'paragraph', content: 'Hello {{first_name}},' }];
const SHARED_BLOCKS_TAIL = [
  { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
  { type: 'signature', content: 'Thank you, The Waves Team' },
];

const GO_TO_BILLING = { type: 'cta', label: 'Go to billing', url_variable: 'billing_url' };
// Every line below is what handleAchFailure (and the charge path) does at that stage, read from the code on
// 2026-11-16: stage 1 changes nothing and promises no retry (only a monthly Auto Pay payment is retried; an invoice
// payment is not); stage 2 sets ach_status needs_verification, so collection refuses the bank until a bank is saved
// again (billing-v2) and nothing moves to a card; stage 3 sets ach_status suspended (the pay page offers card only)
// and moves Auto Pay to a consented card when one exists, else turns Auto Pay off.
const EMAIL_TEMPLATES = [
  {
    key: 'payment.ach_retry_notice',
    name: 'Bank Payment Failed - First Notice',
    description: 'First failed bank (ACH) payment in 90 days: the customer can pay or update the payment method. No retry is promised: only a monthly Auto Pay payment is retried.',
    required: ['first_name', 'billing_url'],
    optional: [],
    subject: 'Your bank payment did not go through',
    preview: 'You can pay now or update your payment method on your billing page.',
    blocks: [
      ...SHARED_BLOCKS_HEAD,
      { type: 'paragraph', content: 'Your bank payment did not go through. You can pay now or update your payment method on your billing page.' },
      GO_TO_BILLING,
      ...SHARED_BLOCKS_TAIL,
    ],
  },
  {
    key: 'payment.ach_card_fallback',
    name: 'Bank Payment Failed - Bank Paused',
    description: 'Second failed bank (ACH) payment in 90 days: bank payments pause until the customer saves a bank account again. Nothing moves to the card.',
    required: ['first_name', 'billing_url'],
    optional: [],
    subject: 'Your bank payment did not go through again',
    preview: 'Bank payments are paused until you add your bank account again.',
    blocks: [
      ...SHARED_BLOCKS_HEAD,
      { type: 'paragraph', content: 'Your bank payment failed a second time, so bank payments are paused for now. To use your bank, add your bank account again on your billing page. You can also pay by card there. Credit card payments include a surcharge.' },
      GO_TO_BILLING,
      ...SHARED_BLOCKS_TAIL,
    ],
  },
  {
    key: 'payment.ach_suspended',
    name: 'Bank Payment Failed - Auto Pay On Card',
    description: 'Third or later failed bank (ACH) payment in 90 days, customer on Auto Pay: bank payments stop and Auto Pay moved to the consented card on file.',
    required: ['first_name', 'billing_url'],
    optional: [],
    subject: 'Your Auto Pay now uses your card',
    preview: 'Your bank payment failed again, so your Auto Pay now uses your card on file.',
    blocks: [
      ...SHARED_BLOCKS_HEAD,
      { type: 'paragraph', content: 'Your bank payment failed again, so bank payments are now off on your account. Your Auto Pay now uses your card on file. Credit card payments include a surcharge.' },
      GO_TO_BILLING,
      ...SHARED_BLOCKS_TAIL,
    ],
  },
  {
    key: 'payment.ach_suspended_no_card',
    name: 'Bank Payment Failed - Card Needed',
    description: 'Third or later failed bank (ACH) payment in 90 days with no card moved to Auto Pay: bank payments stop, and Auto Pay (when it was on) is off until the customer turns it on with a card.',
    required: ['first_name', 'billing_url'],
    optional: [],
    subject: 'Bank payments are off on your account',
    preview: 'Your bank payment failed again, so bank payments are now off on your account.',
    blocks: [
      ...SHARED_BLOCKS_HEAD,
      { type: 'paragraph', content: 'Your bank payment failed again, so bank payments are now off on your account. Please pay by card on your billing page. If you used Auto Pay, it is off for now. You can turn it back on with a card. Credit card payments include a surcharge.' },
      GO_TO_BILLING,
      ...SHARED_BLOCKS_TAIL,
    ],
  },
];

const SHARED_EMAIL_VARIABLES = [
  'first_name',
  'customer_name',
  'customer_portal_url',
  'company_phone',
  'company_email',
];

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
  billing_url: 'https://portal.wavespestcontrol.com/?tab=billing',
  company_phone: '(941) 318-7612',
  company_email: SERVICE_FROM,
};

function emailTemplateRow(t) {
  const allowed = [...new Set([...SHARED_EMAIL_VARIABLES, ...t.required, ...t.optional])];
  const required = [...new Set(t.required)];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'payment',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'financial',
    send_stream: 'transactional_required',
    suppression_group_key: 'transactional_required',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: null,
    default_cta_url_variable: null,
    allowed_variables: JSON.stringify(allowed),
    required_variables: JSON.stringify(required),
    optional_variables: JSON.stringify(optional),
    status: 'active',
    updated_at: new Date(),
  };
}

const MIGRATION = '20261116120000_seed_ach_failure_email_templates';

// Inserted only when missing: the group already exists in production (every transactional_required template uses
// it), and an operator's edits to it are never rewritten.
async function ensureTransactionalGroup(knex) {
  if (!(await knex.schema.hasTable('email_preference_groups'))) return;
  const existing = await knex('email_preference_groups').where({ key: 'transactional_required' }).first();
  if (existing) return;
  await knex('email_preference_groups').insert({
    key: 'transactional_required',
    name: 'Required account notices',
    description: 'Security, payment, legal, and account notices that must reach the customer.',
    send_stream: 'transactional_required',
    user_can_unsubscribe: false,
    sort_order: 10,
    created_at: new Date(),
    updated_at: new Date(),
  });
}

async function seedEmailTemplate(knex, definition) {
  let template = await knex('email_templates').where({ template_key: definition.key }).first();
  if (!template) {
    [template] = await knex('email_templates').insert({ ...emailTemplateRow(definition), created_at: new Date() }).returning('*');
  }
  if (template.active_version_id) return; // seeded already: never overwrite operator edits
  const latest = await knex('email_template_versions').where({ template_id: template.id }).max('version_number as max').first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: Number(latest?.max || 0) + 1,
    status: 'active',
    subject: definition.subject,
    preview_text: definition.preview || null,
    blocks: JSON.stringify(definition.blocks),
    text_body: null,
    published_at: new Date(),
    created_at: new Date(),
    updated_at: new Date(),
  }).returning('*');
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });
  if (await knex.schema.hasTable('email_template_fixtures')) {
    const hasFixture = await knex('email_template_fixtures').where({ template_id: template.id }).first('id');
    if (!hasFixture) {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: 'Happy path',
        is_default: true,
        payload: JSON.stringify(PREVIEW_PAYLOAD),
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }
  // audit_log is append-only and written through services/audit-log.js.
  if (await knex.schema.hasTable('audit_log')) {
    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system',
      action: 'email_template.seeded',
      resource_type: 'email_template',
      resource_id: template.id,
      metadata: { templateKey: definition.key, versionId: version.id, migration: MIGRATION },
      trx: knex,
      critical: true,
    });
  }
}

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  await ensureTransactionalGroup(knex);
  for (const definition of EMAIL_TEMPLATES) {
    await seedEmailTemplate(knex, definition);
  }
};

// Documented no-op: see the header.
exports.down = async function down() {};

exports.__private = {
  EMAIL_TEMPLATES,
  PREVIEW_PAYLOAD,
};
