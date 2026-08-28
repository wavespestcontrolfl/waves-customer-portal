/**
 * Negative payment-lifecycle templates (owner ruling 2026-08-27): the
 * positive counterparts (payment.autopay_enabled / payment.method_updated)
 * shipped in 20260521000002; these cover Auto Pay turned OFF and a saved
 * method REMOVED — portal actions and Stripe-dashboard detaches alike.
 * Sent by server/services/payment-lifecycle-email.js behind
 * GATE_PAYMENT_METHOD_CHANGE_EMAILS. Pause is deliberately not emailed.
 *
 * Same row contract as the 0521 seed (transactional_required stream, first_name
 * the only required variable, editable in the admin template library).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_VARIABLES = [
  'first_name',
  'customer_name',
  'customer_portal_url',
  'payment_method_brand',
  'payment_method_last4',
  'payment_method_type',
  'payment_method_label',
  'company_phone',
  'company_email',
];

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
  payment_method_brand: 'Visa',
  payment_method_last4: '4242',
  payment_method_type: 'card',
  payment_method_label: 'Visa ending in 4242',
  autopay_disabled_date: 'August 28, 2026',
  payment_method_removed_date: 'August 28, 2026',
  autopay_removed_note: '',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
};

const TEMPLATES = [
  {
    key: 'payment.autopay_disabled',
    name: 'Autopay Turned Off',
    description: 'Confirmation sent when the customer turns Auto Pay off.',
    required: ['first_name'],
    optional: ['autopay_disabled_date'],
    subject: 'Auto Pay is now off for your Waves account',
    preview: 'Automatic charges will not run until you turn Auto Pay back on.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, Auto Pay has been turned off for your Waves account.' },
      { type: 'details', rows: [
        { label: 'Payment method', value: '{{payment_method_label}}' },
        { label: 'Turned off', value: '{{autopay_disabled_date}}' },
      ] },
      { type: 'paragraph', content: 'Your saved payment method stays on file, but charges will not run automatically. Invoices for completed service will be sent to you to pay.' },
      { type: 'paragraph', content: 'You can turn Auto Pay back on anytime in your customer portal.' },
      { type: 'cta', label: 'Manage Auto Pay', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'If you did not make this change, reply to this email right away or call {{company_phone}}.' },
    ],
    fixture: { ...PREVIEW_PAYLOAD },
  },
  {
    key: 'payment.method_removed',
    name: 'Payment Method Removed',
    description: 'Confirmation sent when a saved payment method is removed from the account.',
    required: ['first_name'],
    optional: ['payment_method_removed_date', 'autopay_removed_note'],
    subject: 'A payment method was removed from your Waves account',
    preview: 'A saved payment method was removed from your account.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, a saved payment method was removed from your Waves account.' },
      { type: 'details', rows: [
        { label: 'Removed method', value: '{{payment_method_label}}' },
        { label: 'Removed', value: '{{payment_method_removed_date}}' },
      ] },
      { type: 'paragraph', content: '{{autopay_removed_note}}' },
      { type: 'paragraph', content: 'You can review and manage your saved payment methods anytime in your customer portal.' },
      { type: 'cta', label: 'Manage payment methods', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'If you did not make this change, reply to this email right away or call {{company_phone}}.' },
    ],
    fixture: {
      ...PREVIEW_PAYLOAD,
      autopay_removed_note: 'Auto Pay was turned off because it was using this payment method. Add a payment method and turn Auto Pay back on anytime in your customer portal.',
    },
  },
];

function templateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...(t.required || []), ...(t.optional || [])])];
  const required = [...new Set(t.required || [])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
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

async function upsertTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  let template = existing;
  const row = templateRow(t);

  if (template) {
    await knex('email_templates').where({ id: template.id }).update(row);
    template = await knex('email_templates').where({ id: template.id }).first();
  } else {
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .max('version_number as max')
    .first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: Number(latest?.max || 0) + 1,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: JSON.stringify(t.blocks || []),
    text_body: null,
    published_at: new Date(),
  }).returning('*');

  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    status: 'active',
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  const payload = JSON.stringify(t.fixture || {});
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({ payload, updated_at: new Date() });
  } else {
    await knex('email_template_fixtures').insert({ template_id: template.id, name: 'Happy path', payload, is_default: true });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;
  for (const template of TEMPLATES) {
    await upsertTemplate(knex, template);
  }
};

exports.down = async function down() {
  // Template rows and their version history are intentionally retained.
};

exports.__private = { TEMPLATES, SHARED_VARIABLES, PREVIEW_PAYLOAD, templateRow };
