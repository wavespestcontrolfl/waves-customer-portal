/**
 * Seed the four customer emails for a failed bank (ACH) payment, one per escalation stage of stripe-webhook's
 * handleAchFailure; stage 3 has two (Auto Pay moved to the card, or no card). Owner 2026-11-16, dark behind
 * GATE_ACH_FAILURE_EMAIL. The matching texts (ach_retry_notice, ach_card_fallback, ach_suspended) stay off (owner
 * 2026-09-28); this email is their only notice.
 *
 * Same shape as 20260522000002_seed_ach_processing_acknowledgment_templates (email half): transactional_required
 * stream, the transactional preference group upserted first, one active version, one preview fixture. Editable from
 * the admin email templates library. The copy is NOT the texts' wording: their lines on a retry in 3 business days,
 * a switch to the card at the second failure and a bank update link at the third do not match the code, so each
 * email says only what happens.
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
    preview: 'You can pay now or update your payment method in your account.',
    blocks: [
      ...SHARED_BLOCKS_HEAD,
      { type: 'paragraph', content: 'Your bank payment did not go through. You can pay now or update your payment method in your account.' },
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
    preview: 'Bank payments are paused on your account until you add your bank account again.',
    blocks: [
      ...SHARED_BLOCKS_HEAD,
      { type: 'paragraph', content: 'Your bank payment did not go through again, so bank payments are paused on your account. To pay by bank again, add your bank account again in your account. You can also pay by card there. Credit card payments include a surcharge.' },
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
    preview: 'Your bank payment did not go through again, so your Auto Pay now uses your card on file.',
    blocks: [
      ...SHARED_BLOCKS_HEAD,
      { type: 'paragraph', content: 'Your bank payment did not go through again, so bank payments are now off on your account. Your Auto Pay now uses your card on file. Credit card payments include a surcharge.' },
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
    preview: 'Your bank payment did not go through again, so bank payments are now off on your account.',
    blocks: [
      ...SHARED_BLOCKS_HEAD,
      { type: 'paragraph', content: 'Your bank payment did not go through again, so bank payments are now off on your account. Please pay by card in your account. If you used Auto Pay, it is off for now. You can turn it back on with a card. Credit card payments include a surcharge.' },
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

async function ensureTransactionalGroup(knex) {
  if (!(await knex.schema.hasTable('email_preference_groups'))) return;
  const row = {
    key: 'transactional_required',
    name: 'Required account notices',
    description: 'Security, payment, legal, and account notices that must reach the customer.',
    send_stream: 'transactional_required',
    user_can_unsubscribe: false,
    sort_order: 10,
    updated_at: new Date(),
  };
  const existing = await knex('email_preference_groups').where({ key: row.key }).first();
  if (existing) {
    await knex('email_preference_groups').where({ key: row.key }).update(row);
  } else {
    await knex('email_preference_groups').insert({ ...row, created_at: new Date() });
  }
}

async function upsertEmailTemplate(knex, definition) {
  const row = emailTemplateRow(definition);
  const existing = await knex('email_templates').where({ template_key: definition.key }).first();
  let template = existing;
  if (template) {
    await knex('email_templates').where({ id: template.id }).update(row);
    template = await knex('email_templates').where({ id: template.id }).first();
  } else {
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  const versionFields = {
    status: 'active',
    subject: definition.subject,
    preview_text: definition.preview || null,
    blocks: JSON.stringify(definition.blocks),
    text_body: null,
    published_at: new Date(),
    updated_at: new Date(),
  };
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update(versionFields);
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: Number(latest?.max || 0) + 1,
      ...versionFields,
      created_at: new Date(),
    }).returning('*');
  }

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version?.id || template.active_version_id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  const payload = JSON.stringify(PREVIEW_PAYLOAD);
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      name: 'Happy path',
      payload,
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload,
      is_default: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = (await knex.schema.hasTable('email_templates'))
    && (await knex.schema.hasTable('email_template_versions'))
    && (await knex.schema.hasTable('email_template_fixtures'));
  if (!hasTables) return;
  await ensureTransactionalGroup(knex);
  for (const definition of EMAIL_TEMPLATES) {
    await upsertEmailTemplate(knex, definition);
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('email_templates')) {
    await knex('email_templates').whereIn('template_key', EMAIL_TEMPLATES.map((t) => t.key)).del();
  }
};

exports.__private = {
  EMAIL_TEMPLATES,
  PREVIEW_PAYLOAD,
};
