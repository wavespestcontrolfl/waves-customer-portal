/**
 * Seed the customer-facing SMS + email templates fired from the
 * payment_intent.processing webhook (ACH money is in flight, 3–5 business
 * days to clear). Both are editable from the Waves admin portal:
 *  - SMS: /admin/messaging templates list (sms_templates table)
 *  - Email: /admin/email templates library (email_templates + versions)
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SMS_TEMPLATE = {
  template_key: 'ach_payment_processing',
  name: 'ACH Payment Received - Processing',
  category: 'billing',
  body: "Hello {first_name}! Got it - we received your bank payment for invoice {invoice_number}. ACH transfers typically take 3-5 business days to clear; we'll send a receipt as soon as it does.\n\nQuestions or requests? Reply here.",
  variables: ['first_name', 'invoice_number'],
  sort_order: 52,
};

const EMAIL_TEMPLATE = {
  key: 'payment.ach_processing',
  name: 'ACH Payment Received - Processing',
  description: 'Acknowledgment sent when a customer initiates an ACH bank payment that is now in flight (typically 3-5 business days to clear).',
  required: ['first_name'],
  optional: [
    'invoice_title',
    'invoice_number',
    'amount_paid',
    'payment_initiated_date',
    'expected_clear_date',
    'pay_url',
    'customer_portal_url',
    'customer_name',
    'company_phone',
    'company_email',
  ],
  subject: 'We received your bank payment - processing',
  preview: 'Your Waves bank payment is on the way; it typically clears in 3-5 business days.',
  blocks: [
    { type: 'paragraph', content: 'Hello {{first_name}},' },
    { type: 'paragraph', content: 'Thank you - we received your bank payment for your Waves invoice and it is now processing.' },
    {
      type: 'details',
      rows: [
        { label: 'Invoice', value: '{{invoice_title}}' },
        { label: 'Invoice #', value: '{{invoice_number}}' },
        { label: 'Amount', value: '{{amount_paid}}' },
        { label: 'Initiated', value: '{{payment_initiated_date}}' },
        { label: 'Expected to clear', value: '{{expected_clear_date}}' },
      ],
    },
    { type: 'paragraph', content: 'ACH bank transfers typically take 3-5 business days to clear. We will send a receipt as soon as the payment posts.' },
    { type: 'small_note', content: 'No action is needed right now. If the payment fails or your bank returns it, we will let you know.' },
    { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
    { type: 'signature', content: 'Thank you, The Waves Team' },
  ],
};

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
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  invoice_title: 'Quarterly Pest Control Service',
  invoice_number: 'WPC-2026-0091',
  amount_paid: '$117.00',
  payment_initiated_date: 'May 22, 2026',
  expected_clear_date: 'May 28, 2026',
  pay_url: 'https://portal.wavespestcontrol.com/pay/example',
  company_phone: '(941) 318-7612',
  company_email: SERVICE_FROM,
};

function smsRow(cols, template, now) {
  const row = {
    template_key: template.template_key,
    name: template.name,
    category: template.category,
    body: template.body,
    variables: JSON.stringify(template.variables),
    sort_order: template.sort_order,
  };
  if (cols.updated_at) row.updated_at = now;
  return row;
}

function emailTemplateRow(t) {
  const allowed = [...new Set([...SHARED_EMAIL_VARIABLES, ...(t.required || []), ...(t.optional || [])])];
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

async function upsertSmsTemplate(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();
  const row = smsRow(cols, SMS_TEMPLATE, now);
  const existing = await knex('sms_templates').where({ template_key: SMS_TEMPLATE.template_key }).first();
  if (existing) {
    await knex('sms_templates').where({ template_key: SMS_TEMPLATE.template_key }).update(row);
    return;
  }
  await knex('sms_templates').insert({
    ...row,
    ...(cols.is_active ? { is_active: true } : {}),
    ...(cols.is_internal ? { is_internal: false } : {}),
    ...(cols.created_at ? { created_at: now } : {}),
  });
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

async function upsertEmailTemplate(knex) {
  const hasTables = (await knex.schema.hasTable('email_templates'))
    && (await knex.schema.hasTable('email_template_versions'))
    && (await knex.schema.hasTable('email_template_fixtures'));
  if (!hasTables) return;

  await ensureTransactionalGroup(knex);

  const row = emailTemplateRow(EMAIL_TEMPLATE);
  const existing = await knex('email_templates').where({ template_key: EMAIL_TEMPLATE.key }).first();
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
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'active',
      subject: EMAIL_TEMPLATE.subject,
      preview_text: EMAIL_TEMPLATE.preview || null,
      blocks: JSON.stringify(EMAIL_TEMPLATE.blocks || []),
      text_body: null,
      published_at: new Date(),
      updated_at: new Date(),
    });
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = Number(latest?.max || 0) + 1;
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      status: 'active',
      subject: EMAIL_TEMPLATE.subject,
      preview_text: EMAIL_TEMPLATE.preview || null,
      blocks: JSON.stringify(EMAIL_TEMPLATE.blocks || []),
      text_body: null,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
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
  await upsertSmsTemplate(knex);
  await upsertEmailTemplate(knex);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: SMS_TEMPLATE.template_key }).del();
  }
  if (await knex.schema.hasTable('email_templates')) {
    await knex('email_templates').where({ template_key: EMAIL_TEMPLATE.key }).del();
  }
};

exports.__private = {
  SMS_TEMPLATE,
  EMAIL_TEMPLATE,
  PREVIEW_PAYLOAD,
};
