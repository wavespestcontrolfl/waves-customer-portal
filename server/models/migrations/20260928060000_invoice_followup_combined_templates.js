/**
 * Combined invoice follow-up templates (dunning unification PR 2b,
 * GATE_DUNNING_COMBINED_MESSAGE). When a customer has 2+ overdue invoices
 * whose follow-up touches are due in the same run, invoice-followups.js
 * sends ONE combined text and ONE combined email quoting every included
 * invoice instead of one per invoice. Wording drafted by Claude; OWNER
 * APPROVAL PENDING — do not flip the gate until it is signed off. Day 90 is
 * the only final notice and names collections, matching the approved
 * single-invoice Day 90 wording (owner ruling 2026-09-27, choice B).
 *
 * Insert-only, same convention as 20260928050000_invoice_followup_day60_
 * day90_templates.js: an existing row with the same key is left exactly as
 * it is, so an administrator's own edit is never overwritten. Texts carry
 * no signature (owner ruling 2026-09-26) and stay GSM-7. Inert until the
 * gate is on.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SMS_TEMPLATES = [
  {
    template_key: 'invoice_followup_combined_3day',
    name: 'Invoice — Combined 3-Day Reminder',
    category: 'billing',
    description: 'Day 3 combined follow-up text for a customer with 2+ overdue invoices due the same run (GATE_DUNNING_COMBINED_MESSAGE).',
    body: "Hello {first_name}, you have {invoice_count} open Waves invoices totaling ${total_due}. You can pay them all here: {pay_url}\n\nIf something looks off, reply and we'll sort it out.",
    variables: ['first_name', 'invoice_count', 'total_due', 'pay_url'],
  },
  {
    template_key: 'invoice_followup_combined_10day',
    name: 'Invoice — Combined 10-Day Reminder',
    category: 'billing',
    description: 'Day 10 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    body: 'Hello {first_name}, your {invoice_count} Waves invoices totaling ${total_due} are still open. Pay here: {pay_url}',
    variables: ['first_name', 'invoice_count', 'total_due', 'pay_url'],
  },
  {
    template_key: 'invoice_followup_combined_17day',
    name: 'Invoice — Combined 17-Day Check-In',
    category: 'billing',
    description: 'Day 17 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    body: "Hello {first_name}, checking in on your {invoice_count} open Waves invoices (${total_due} total). You can pay here: {pay_url}\n\nIf something is holding it up, reply and we'll help.",
    variables: ['first_name', 'invoice_count', 'total_due', 'pay_url'],
  },
  {
    template_key: 'invoice_followup_combined_30day',
    name: 'Invoice — Combined 30-Day Reminder',
    category: 'billing',
    description: 'Day 30 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    body: "Hello {first_name}, your {invoice_count} Waves invoices totaling ${total_due} are still unpaid. Please pay here to keep your account in good standing: {pay_url}\n\nNeed a payment plan? Reply here.",
    variables: ['first_name', 'invoice_count', 'total_due', 'pay_url'],
  },
  {
    template_key: 'invoice_followup_combined_60day',
    name: 'Invoice — Combined 60-Day Reminder',
    category: 'billing',
    description: 'Day 60 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    body: "Hello {first_name}, your {invoice_count} Waves invoices totaling ${total_due} are still unpaid. Please pay today, or reply and we'll work out a payment plan: {pay_url}",
    variables: ['first_name', 'invoice_count', 'total_due', 'pay_url'],
  },
  {
    template_key: 'invoice_followup_combined_90day',
    name: 'Invoice — Combined 90-Day Final Notice',
    category: 'billing',
    description: 'Day 90 combined follow-up text, the only final notice (GATE_DUNNING_COMBINED_MESSAGE).',
    body: 'Hello {first_name}, final notice from Waves: your {invoice_count} unpaid invoices (${total_due} total) are past due and may be sent to collections. Please pay today, or reply to work out a plan: {pay_url}',
    variables: ['first_name', 'invoice_count', 'total_due', 'pay_url'],
  },
];

// Top-level payload variables the combined email actually requires/accepts,
// plus the per-invoice fields the `invoices` array's rowTemplate resolves
// against ITS OWN item (never present at the top level of the send
// payload) — declared here so validationFor's referenced/allowed checks
// pass, but kept OUT of REQUIRED so requiredPayloadMissing never demands
// them from the top-level payload (email-template-library.js).
const VARIABLES = [
  'first_name', 'invoice_count', 'total_due', 'pay_url', 'customer_portal_url',
  'invoice_number', 'invoice_title', 'amount_due',
];
const REQUIRED = ['first_name', 'invoice_count', 'total_due', 'pay_url'];
const OPTIONAL = VARIABLES.filter((key) => !REQUIRED.includes(key));

// One row per included invoice, generated at send time from the `invoices`
// payload array (email-template-library.js's rowsFromVariable/rowTemplate —
// additive to the existing 'details' block, not a new block type).
const INVOICE_DETAILS = {
  type: 'details',
  rowsFromVariable: 'invoices',
  rowTemplate: { label: '{{invoice_title}} (#{{invoice_number}})', value: '{{amount_due}}' },
};

// The matching single-invoice step's own CTA sentence + small note (20260527000008
// for 3/7/14/30, 20260928050000 for 60/90) — the combined email reuses them
// verbatim so the account-level message reads the same as the invoice-level one.
const EMAIL_TEMPLATES = [
  {
    key: 'invoice.followup_combined_3_day',
    name: 'Invoice Follow-Up - Combined 3 Day',
    description: 'Combined email sent with the Day 3 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    subject: 'You have {{invoice_count}} open Waves invoices',
    preview: 'Your Waves invoices still have an open balance.',
    stageDays: 3,
    ctaSentence: 'You can securely pay all of your invoices here:',
    smallNote: 'If something looks off, reply to this email and we will help sort it out.',
  },
  {
    key: 'invoice.followup_combined_10_day',
    name: 'Invoice Follow-Up - Combined 10 Day',
    description: 'Combined email sent with the Day 10 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    subject: 'You have {{invoice_count}} open Waves invoices',
    preview: 'Please review and pay your open Waves invoices.',
    stageDays: 10,
    ctaSentence: 'Please use the secure link below to make payment:',
    smallNote: 'Already paid? Thank you - no further action is needed.',
  },
  {
    key: 'invoice.followup_combined_17_day',
    name: 'Invoice Follow-Up - Combined 17 Day',
    description: 'Combined email sent with the Day 17 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    subject: 'You have {{invoice_count}} open Waves invoices',
    preview: 'Please pay your open Waves invoices or contact us for help.',
    stageDays: 17,
    ctaSentence: 'Please pay your invoices or reply to this email if there is anything we should review.',
    smallNote: 'We can help with questions, receipt matching, or payment options if needed.',
  },
  {
    key: 'invoice.followup_combined_30_day',
    name: 'Invoice Follow-Up - Combined 30 Day',
    description: 'Combined email sent with the Day 30 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    subject: 'Your Waves invoices are still unpaid',
    preview: 'Please pay your open Waves invoices to keep your account in good standing.',
    stageDays: 30,
    ctaSentence: 'Please pay now or reply to discuss payment options.',
    smallNote: 'If payment is not received or we do not hear from you, future service may be paused until the balance is resolved.',
  },
  {
    key: 'invoice.followup_combined_60_day',
    name: 'Invoice Follow-Up - Combined 60 Day',
    description: 'Combined email sent with the Day 60 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    subject: 'Your Waves invoices are still unpaid',
    preview: 'Please pay today, or reply to set up a payment plan.',
    stageDays: 60,
    ctaSentence: "Please pay today, or reply to this email and we'll work out a payment plan.",
    smallNote: 'If payment is not received or we do not hear from you, future service may be paused until the balance is resolved.',
  },
  {
    key: 'invoice.followup_combined_90_day',
    name: 'Invoice Follow-Up - Combined 90 Day',
    description: 'Final notice combined email sent with the Day 90 combined follow-up text (GATE_DUNNING_COMBINED_MESSAGE).',
    subject: 'Final notice: your Waves invoices are unpaid',
    preview: 'This is our final reminder about your open Waves invoices.',
    stageDays: 90,
    ctaSentence: 'Please pay today, or reply to this email so we can work out a plan.',
    smallNote: 'If we do not hear from you, future service may be paused and the balance may be sent to collections.',
  },
];

function blocksFor(t) {
  return [
    { type: 'paragraph', content: 'Hello {{first_name}},' },
    { type: 'paragraph', content: 'You have {{invoice_count}} open Waves invoices totaling {{total_due}}.' },
    INVOICE_DETAILS,
    { type: 'paragraph', content: t.ctaSentence },
    { type: 'cta', label: 'Pay all invoices', url_variable: 'pay_url' },
    { type: 'small_note', content: t.smallNote },
    { type: 'signature', content: 'Thank you, The Waves Team' },
  ];
}

function fixture(stageDays) {
  return {
    first_name: 'Taylor',
    invoice_count: 2,
    total_due: '$258.00',
    pay_url: 'https://portal.wavespestcontrol.com/pay/sample',
    customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
    invoices: [
      { invoice_number: 'WPC-2026-1042', invoice_title: 'Quarterly Pest Control', amount_due: '$129.00' },
      { invoice_number: 'WPC-2026-1078', invoice_title: 'Lawn Care', amount_due: '$129.00' },
    ],
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
    default_cta_label: 'Pay all invoices',
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
    blocks: JSON.stringify(blocksFor(t)),
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

// Rollback is a documented no-op (waves-db SKILL.md §4), same reasoning as
// 20260928050000_invoice_followup_day60_day90_templates.js: `up` is
// insert-only and preserves anything an administrator created or edited
// under these keys, and the seeded rows are inert while
// GATE_DUNNING_COMBINED_MESSAGE is off.
exports.down = async function down() {};

exports.__private = {
  SMS_TEMPLATES, EMAIL_TEMPLATES, VARIABLES, REQUIRED, OPTIONAL, blocksFor, fixture, INVOICE_DETAILS,
};
