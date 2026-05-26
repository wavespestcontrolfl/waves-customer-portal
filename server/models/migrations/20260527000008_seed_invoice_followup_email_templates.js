/**
 * Seed editable invoice follow-up email templates that pair with the
 * invoice_followup_3day / 7day / 14day / 30day SMS sequence.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const VARIABLES = [
  'first_name',
  'invoice_title',
  'invoice_number',
  'amount_due',
  'due_date',
  'service_date',
  'service_date_clause',
  'pay_url',
  'customer_portal_url',
];

const REQUIRED = [
  'first_name',
  'invoice_title',
  'amount_due',
  'pay_url',
];

const OPTIONAL = VARIABLES.filter((key) => !REQUIRED.includes(key));

const TEMPLATES = [
  {
    key: 'invoice.followup_3_day',
    name: 'Invoice Follow-Up - 3 Day',
    description: 'Friendly email nudge sent with the 3-day invoice follow-up SMS.',
    subject: 'Reminder: your Waves invoice is still open',
    preview: 'Your Waves invoice still has an open balance.',
    cta: 'Pay invoice',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves invoice for {{invoice_title}}{{service_date_clause}} still has an open balance of {{amount_due}}.' },
      { type: 'details', rows: [{ label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'paragraph', content: 'You can securely pay your invoice here:' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'small_note', content: 'If something looks off, reply to this email and we will help sort it out.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'invoice.followup_7_day',
    name: 'Invoice Follow-Up - 7 Day',
    description: 'Reminder email sent with the 7-day invoice follow-up SMS.',
    subject: 'Your Waves invoice is still open',
    preview: 'Please review and pay your open Waves invoice.',
    cta: 'Pay invoice',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Quick reminder: your Waves invoice for {{invoice_title}}{{service_date_clause}} is still open.' },
      { type: 'details', rows: [{ label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'paragraph', content: 'Please use the secure link below to make payment:' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'small_note', content: 'Already paid? Thank you - no further action is needed.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'invoice.followup_14_day',
    name: 'Invoice Follow-Up - 14 Day',
    description: 'Firmer email sent with the 14-day invoice follow-up SMS.',
    subject: 'Action requested: Waves invoice still open',
    preview: 'Please pay your open Waves invoice or contact us for help.',
    cta: 'Pay invoice',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Checking in on your Waves invoice for {{invoice_title}}{{service_date_clause}}. Our records still show an open balance of {{amount_due}}.' },
      { type: 'details', rows: [{ label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'paragraph', content: 'Please pay the invoice or reply to this email if there is anything we should review.' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'small_note', content: 'We can help with questions, receipt matching, or payment options if needed.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'invoice.followup_30_day',
    name: 'Invoice Follow-Up - 30 Day',
    description: 'Final invoice follow-up email sent with the 30-day SMS.',
    subject: 'Final reminder: Waves invoice still open',
    preview: 'Final reminder for an open Waves invoice.',
    cta: 'Pay invoice',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Final reminder: your Waves invoice for {{invoice_title}}{{service_date_clause}} still has an open balance of {{amount_due}}.' },
      { type: 'details', rows: [{ label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Due date', value: '{{due_date}}' }] },
      { type: 'paragraph', content: 'Please pay now or reply to discuss payment options.' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'small_note', content: 'If payment is not received or we do not hear from you, future service may be paused until the balance is resolved.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
];

function fixture(stageDays) {
  return {
    first_name: 'Taylor',
    invoice_title: 'Quarterly Pest Control',
    invoice_number: 'WPC-2026-1042',
    amount_due: '$129.00',
    due_date: 'May 19, 2026',
    service_date: 'May 12, 2026',
    service_date_clause: ' completed on May 12, 2026',
    pay_url: 'https://portal.wavespestcontrol.com/pay/sample',
    customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
    followup_stage_days: stageDays,
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
    default_cta_label: t.cta,
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
  const payload = fixture([3, 7, 14, 30][index]);
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
