/**
 * Day 60 and Day 90 invoice follow-up templates for the Day 90 ladder
 * (GATE_DUNNING_LADDER_90, #5126). Wording drafted by Claude and approved
 * by the owner 2026-09-28. Day 90 is the only final notice and mentions
 * collections (owner choice B). It says "past due" rather than a day count:
 * about 1 invoice in 10 is due 30 days after it is sent, so the ladder's
 * Day 90 is not always 90 days past due.
 *
 * Insert-only: an existing row with the same key is left exactly as it is,
 * so a template an administrator already created or edited is never
 * overwritten. Texts carry no signature (owner ruling 2026-09-26) and stay
 * GSM-7. The templates are inert until the ladder gate is on.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SMS_TEMPLATES = [
  {
    template_key: 'invoice_followup_60day',
    name: 'Invoice — 60-Day Reminder',
    category: 'billing',
    description: 'Day 60 of the invoice follow-up ladder (GATE_DUNNING_LADDER_90).',
    body: "Hello {first_name}, your Waves invoice for {invoice_title}{service_date_clause} is still unpaid. Please pay today, or reply and we'll work out a payment plan: {pay_url}",
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
  },
  {
    template_key: 'invoice_followup_90day',
    name: 'Invoice — 90-Day Final Notice',
    category: 'billing',
    description: 'Day 90 of the invoice follow-up ladder, the only final notice (GATE_DUNNING_LADDER_90).',
    body: 'Hello {first_name}, final notice from Waves: your invoice for {invoice_title}{service_date_clause} is past due and may be sent to collections. Please pay today, or reply to work out a plan: {pay_url}',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
  },
];

const VARIABLES = [
  'first_name', 'invoice_title', 'invoice_number', 'amount_due', 'due_date',
  'service_date', 'service_date_clause', 'pay_url', 'customer_portal_url',
];
const REQUIRED = ['first_name', 'invoice_title', 'amount_due', 'pay_url'];
const OPTIONAL = VARIABLES.filter((key) => !REQUIRED.includes(key));

const DETAILS = {
  type: 'details',
  rows: [
    { label: 'Invoice #', value: '{{invoice_number}}' },
    { label: 'Amount due', value: '{{amount_due}}' },
    { label: 'Due date', value: '{{due_date}}' },
  ],
};

const EMAIL_TEMPLATES = [
  {
    key: 'invoice.followup_60_day',
    name: 'Invoice Follow-Up - 60 Day',
    description: 'Email sent with the Day 60 invoice follow-up text (GATE_DUNNING_LADDER_90).',
    subject: 'Your Waves invoice is still unpaid',
    preview: 'Please pay today, or reply to set up a payment plan.',
    stageDays: 60,
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves invoice for {{invoice_title}}{{service_date_clause}} still has an open balance of {{amount_due}}.' },
      DETAILS,
      { type: 'paragraph', content: "Please pay today, or reply to this email and we'll work out a payment plan." },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'small_note', content: 'If payment is not received or we do not hear from you, future service may be paused until the balance is resolved.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'invoice.followup_90_day',
    name: 'Invoice Follow-Up - 90 Day',
    description: 'Final notice email sent with the Day 90 invoice follow-up text (GATE_DUNNING_LADDER_90).',
    subject: 'Final notice: your Waves invoice is unpaid',
    preview: 'This is our final reminder about your open Waves invoice.',
    stageDays: 90,
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'This is our final notice about your Waves invoice for {{invoice_title}}{{service_date_clause}}, which still has an open balance of {{amount_due}}.' },
      DETAILS,
      { type: 'paragraph', content: 'Please pay today, or reply to this email so we can work out a plan.' },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'small_note', content: 'If we do not hear from you, future service may be paused and the balance may be sent to collections.' },
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
    default_cta_label: 'Pay invoice',
    default_cta_url_variable: 'pay_url',
    allowed_variables: JSON.stringify(VARIABLES),
    required_variables: JSON.stringify(REQUIRED),
    optional_variables: JSON.stringify(OPTIONAL),
    status: 'active',
  };
}

async function insertSmsTemplates(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const day30 = await knex('sms_templates').where({ template_key: 'invoice_followup_30day' }).first('sort_order');
  const sortOrder = Number.isInteger(day30?.sort_order) ? day30.sort_order : 100;
  for (const t of SMS_TEMPLATES) {
    const existing = await knex('sms_templates').where({ template_key: t.template_key }).first('id');
    if (existing) continue;
    await knex('sms_templates').insert({
      ...t,
      variables: JSON.stringify(t.variables),
      is_active: true,
      sort_order: sortOrder,
    });
  }
}

async function insertEmailTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first('id');
  if (existing) return;
  const now = new Date();
  const [template] = await knex('email_templates')
    .insert({ ...templateRow(t), created_at: now, updated_at: now })
    .returning('*');
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: 1,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview,
    blocks: JSON.stringify(t.blocks),
    text_body: null,
    published_at: now,
    created_at: now,
    updated_at: now,
  }).returning('*');
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: now,
    updated_at: now,
  });
  await knex('email_template_fixtures').insert({
    template_id: template.id,
    name: 'Happy path',
    payload: JSON.stringify(fixture(t.stageDays)),
    is_default: true,
    created_at: now,
    updated_at: now,
  });
}

exports.up = async function up(knex) {
  await insertSmsTemplates(knex);
  const hasEmailTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasEmailTables) return;
  for (const t of EMAIL_TEMPLATES) await insertEmailTemplate(knex, t);
};

// Rollback is a documented no-op (waves-db SKILL.md §4): `up` is insert-only
// and preserves anything an administrator created or edited under these
// keys, and a rollback that deleted the rows would erase exactly those
// edits (deleting an email template cascades to every version and fixture,
// drafts included). The seeded rows are inert while GATE_DUNNING_LADDER_90
// is off; an administrator who wants them gone deactivates or deletes them
// in the template editor.
exports.down = async function down() {};

exports.__private = { SMS_TEMPLATES, EMAIL_TEMPLATES, VARIABLES, REQUIRED };
