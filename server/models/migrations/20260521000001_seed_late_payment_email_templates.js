/**
 * Seed editable late-payment email templates that pair with the existing
 * late_payment_7d / 14d / 30d / 60d / 90d SMS sequence.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const VARIABLES = [
  'first_name',
  'invoice_title',
  'service_date_clause',
  'pay_url',
  'amount_due',
  'due_date',
  'invoice_number',
  'customer_portal_url',
  'company_phone',
  'company_email',
];

const REQUIRED = [
  'first_name',
  'invoice_title',
  'pay_url',
  'amount_due',
  'due_date',
];

const OPTIONAL = VARIABLES.filter((key) => !REQUIRED.includes(key));

const TEMPLATES = [
  {
    key: 'billing_late_payment_7_day',
    name: 'Late Payment - 7 Day',
    description: 'Friendly billing notice sent with the 7-day late-payment SMS.',
    subject: 'Friendly reminder: your Waves invoice is past due',
    preview: 'Your Waves invoice is now 7 days past due.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'This is a friendly reminder that your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 7 days past due.' },
      { type: 'details', rows: [{ label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'paragraph', content: 'You can securely pay your invoice here:' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'small_note', content: 'If you already made this payment, thank you - no further action is needed.' },
      { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'billing_late_payment_14_day',
    name: 'Late Payment - 14 Day',
    description: 'Billing notice sent with the 14-day late-payment SMS.',
    subject: 'Your Waves invoice is 14 days overdue',
    preview: 'Your Waves invoice is now 14 days overdue.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 14 days overdue.' },
      { type: 'details', rows: [{ label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'paragraph', content: 'Please submit payment as soon as possible using the secure link below:' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'small_note', content: 'If there is an issue with the invoice or you need help making payment, reply to this email and we will help get it resolved.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'billing_late_payment_30_day',
    name: 'Late Payment - 30 Day',
    description: 'Important billing notice sent with the 30-day late-payment SMS.',
    subject: 'Important: your Waves account has a past-due balance',
    preview: 'Your Waves account has a past-due balance.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 30 days overdue.' },
      { type: 'details', rows: [{ label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'paragraph', content: 'Please pay your invoice here:' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'paragraph', content: 'To keep your account in good standing, please submit payment as soon as possible. Future service may be paused until the past-due balance is resolved.' },
      { type: 'small_note', content: 'Need help or want to discuss payment options? Reply to this email and our team will work with you.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'billing_late_payment_60_day',
    name: 'Late Payment - 60 Day',
    description: 'Service-hold billing notice sent with the 60-day late-payment SMS.',
    subject: 'Action needed: Waves invoice 60 days overdue',
    preview: 'Please pay or contact Waves today about this past-due invoice.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 60 days overdue.' },
      { type: 'details', rows: [{ label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'paragraph', content: 'Please pay or contact us today:' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'paragraph', content: 'Your account may remain on service hold until the past-due balance is resolved. If you need help or would like to discuss payment options, please reply to this email as soon as possible.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'billing_late_payment_90_day',
    name: 'Late Payment - 90 Day',
    description: 'Final billing notice sent with the 90-day late-payment SMS.',
    subject: 'Final notice: Waves invoice 90 days overdue',
    preview: 'Final notice for a Waves invoice that is 90 days overdue.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'This is a final notice that your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 90 days overdue.' },
      { type: 'details', rows: [{ label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'paragraph', content: 'Please pay today using the secure link below:' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'paragraph', content: 'If payment is not received or we do not hear from you, this account may be sent to collections or further recovery action.' },
      { type: 'small_note', content: 'If you believe this notice was sent in error, or if you need to discuss payment options, reply to this email today.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
];

function fixture(stageDays) {
  return {
    first_name: 'Taylor',
    invoice_title: 'Quarterly Pest Control',
    service_date_clause: ' completed on May 12, 2026',
    pay_url: 'https://portal.wavespestcontrol.com/pay/sample',
    amount_due: '$129.00',
    due_date: 'May 19, 2026',
    invoice_number: 'WPC-2026-1042',
    customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
    company_phone: '(941) 297-5749',
    company_email: SERVICE_FROM,
    overdue_stage_days: stageDays,
  };
}

function templateRow(t) {
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'billing',
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
    default_cta_label: 'Pay invoice',
    default_cta_url_variable: 'pay_url',
    allowed_variables: JSON.stringify(VARIABLES),
    required_variables: JSON.stringify(REQUIRED),
    optional_variables: JSON.stringify(OPTIONAL),
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

async function upsertTemplate(knex, t, index) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  let template = existing;
  const row = templateRow(t);

  if (template) {
    await knex('email_templates').where({ id: template.id }).update(row);
    template = await knex('email_templates').where({ id: template.id }).first();
  } else {
    [template] = await knex('email_templates').insert({
      ...row,
      created_at: new Date(),
    }).returning('*');
  }

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'active',
      subject: t.subject,
      preview_text: t.preview,
      blocks: JSON.stringify(t.blocks),
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
      subject: t.subject,
      preview_text: t.preview,
      blocks: JSON.stringify(t.blocks),
      text_body: null,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
  }

  const activeVersionId = version?.id || template.active_version_id;
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: activeVersionId,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  const payload = fixture([7, 14, 30, 60, 90][index]);
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      name: 'Happy path',
      payload: JSON.stringify(payload),
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload: JSON.stringify(payload),
      is_default: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  await ensureTransactionalGroup(knex);
  for (let i = 0; i < TEMPLATES.length; i += 1) {
    await upsertTemplate(knex, TEMPLATES[i], i);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates')
    .whereIn('template_key', TEMPLATES.map((t) => t.key))
    .del();
};

exports.__private = {
  TEMPLATES,
  VARIABLES,
  REQUIRED,
  OPTIONAL,
  templateRow,
};
