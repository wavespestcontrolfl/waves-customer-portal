/**
 * Customer email QA cleanup.
 *
 * Publishes tightened active versions for the templates that surfaced the
 * highest-risk review issues: billing copy, report summaries, and
 * security/account notices.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const SUPPORT_PHONE = '(941) 297-5749';

const SHARED_OPTIONAL = [
  'customer_name',
  'customer_portal_url',
  'company_phone',
  'company_email',
  'invoice_title',
  'invoice_number',
  'service_label',
  'service_date',
  'amount_due',
  'amount_paid',
  'due_date',
  'paid_at',
  'payment_method',
  'payment_method_label',
  'payment_url',
  'pay_url',
  'receipt_url',
  'invoice_url',
  'attachment_note',
  'memo',
  'retry_date',
  'failed_payment_date',
  'plan_start_date',
  'total_balance',
  'payment_amount',
  'payment_frequency',
  'next_payment_date',
  'refund_amount',
  'refund_date',
  'refund_reason',
  'original_payment_date',
  'report_url',
  'report_type',
  'property_address',
  'technician_name',
  'finding_summary',
  'application_summary',
  'reentry_summary',
  'pressure_summary',
  'pdf_note',
  'project_title',
  'change_summary',
  'changed_items_summary',
];

const TEMPLATES = [
  {
    key: 'invoice.sent',
    required: ['first_name', 'invoice_url', 'invoice_number', 'amount_due'],
    subject: 'Your Waves invoice is ready',
    preview: 'Review your invoice details and pay securely online.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves invoice is ready.' },
      { type: 'details', rows: [
        { label: 'Invoice', value: '{{invoice_number}}' },
        { label: 'Amount due', value: '{{amount_due}}' },
        { label: 'Due date', value: '{{due_date}}' },
        { label: 'Service', value: '{{service_label}}' },
        { label: 'Service date', value: '{{service_date}}' },
      ] },
      { type: 'paragraph', content: 'You can review the full itemized breakdown and pay securely from the link below.' },
      { type: 'cta', label: 'View and pay invoice', url_variable: 'invoice_url' },
      { type: 'small_note', content: '{{attachment_note}}' },
      { type: 'small_note', content: 'If you already paid, no action is needed. Questions? Reply here and our billing team will help.' },
    ],
    fixture: {
      first_name: 'Taylor',
      invoice_url: 'https://portal.wavespestcontrol.com/pay/demo-invoice',
      invoice_number: '#1042',
      amount_due: '$129.00',
      due_date: 'June 15, 2026',
      service_label: 'Quarterly Pest Protection',
      service_date: 'June 8, 2026',
      attachment_note: 'Your PDF invoice is attached.',
      company_phone: SUPPORT_PHONE,
    },
  },
  {
    key: 'invoice.receipt',
    required: ['first_name', 'receipt_url', 'invoice_number', 'amount_paid'],
    subject: 'Your Waves payment receipt',
    preview: 'Your payment was received and your receipt is ready.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, thank you. We received your Waves payment.' },
      { type: 'details', rows: [
        { label: 'Invoice', value: '{{invoice_number}}' },
        { label: 'Amount paid', value: '{{amount_paid}}' },
        { label: 'Paid', value: '{{paid_at}}' },
        { label: 'Service', value: '{{service_label}}' },
        { label: 'Payment method', value: '{{payment_method}}' },
      ] },
      { type: 'callout', content: '{{memo}}' },
      { type: 'cta', label: 'View receipt', url_variable: 'receipt_url' },
      { type: 'small_note', content: 'Keep this email for your records. If something looks off, reply here and we will review it.' },
    ],
    fixture: {
      first_name: 'Taylor',
      receipt_url: 'https://portal.wavespestcontrol.com/receipt/demo-receipt',
      invoice_number: '#1042',
      amount_paid: '$129.00',
      paid_at: 'June 8, 2026',
      service_label: 'Quarterly Pest Protection',
      payment_method: 'Visa ending in 4242',
    },
  },
  {
    key: 'payment.failed',
    required: ['first_name', 'payment_url'],
    subject: 'Payment issue on your Waves account',
    preview: 'Your recent payment did not go through. You can fix it securely online.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, we were not able to process a recent Waves payment.' },
      { type: 'details', rows: [
        { label: 'Invoice', value: '{{invoice_title}}' },
        { label: 'Invoice number', value: '{{invoice_number}}' },
        { label: 'Amount due', value: '{{amount_due}}' },
        { label: 'Attempted', value: '{{failed_payment_date}}' },
        { label: 'Payment method', value: '{{payment_method_label}}' },
        { label: 'Next retry', value: '{{retry_date}}' },
      ] },
      { type: 'paragraph', content: 'This can happen when a card expires, a bank flags the charge, or a temporary processor issue occurs.' },
      { type: 'cta', label: 'Fix payment', url_variable: 'payment_url' },
      { type: 'small_note', content: 'If you already updated your payment method or paid another way, no further action is needed.' },
    ],
    fixture: {
      first_name: 'Taylor',
      payment_url: 'https://portal.wavespestcontrol.com/pay/demo-invoice',
      invoice_title: 'Quarterly Pest Protection',
      invoice_number: '#1042',
      amount_due: '$129.00',
      failed_payment_date: 'June 8, 2026',
      retry_date: 'June 11, 2026',
      payment_method_label: 'Visa ending in 4242',
    },
  },
  {
    key: 'payment.retry_notice',
    required: ['first_name', 'pay_url'],
    subject: "We'll retry your Waves payment soon",
    preview: 'A payment retry has been scheduled. You can pay or update your method now.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, we were unable to process payment for your Waves invoice.' },
      { type: 'details', rows: [
        { label: 'Invoice', value: '{{invoice_title}}' },
        { label: 'Invoice number', value: '{{invoice_number}}' },
        { label: 'Amount due', value: '{{amount_due}}' },
        { label: 'Failed payment date', value: '{{failed_payment_date}}' },
        { label: 'Retry date', value: '{{retry_date}}' },
        { label: 'Payment method', value: '{{payment_method_label}}' },
      ] },
      { type: 'paragraph', content: 'We will retry the payment on {{retry_date}}. You can also pay now or update your payment method using the secure link below.' },
      { type: 'cta', label: 'Pay or update method', url_variable: 'pay_url' },
      { type: 'small_note', content: 'If you already made payment or updated your method, thank you - no further action is needed.' },
    ],
    fixture: {
      first_name: 'Taylor',
      invoice_title: 'Quarterly Pest Protection',
      invoice_number: '#1042',
      amount_due: '$129.00',
      failed_payment_date: 'June 8, 2026',
      retry_date: 'June 11, 2026',
      payment_method_label: 'Visa ending in 4242',
      pay_url: 'https://portal.wavespestcontrol.com/pay/demo-invoice',
    },
  },
  {
    key: 'payment.plan_confirmed',
    required: ['first_name', 'total_balance', 'payment_amount', 'payment_frequency', 'next_payment_date'],
    subject: 'Your Waves payment plan is confirmed',
    preview: 'Your payment plan details are confirmed.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, your Waves payment plan is confirmed.' },
      { type: 'details', rows: [
        { label: 'Balance included', value: '{{total_balance}}' },
        { label: 'Payment amount', value: '{{payment_amount}}' },
        { label: 'Frequency', value: '{{payment_frequency}}' },
        { label: 'Next payment', value: '{{next_payment_date}}' },
        { label: 'Payment method', value: '{{payment_method_label}}' },
      ] },
      { type: 'paragraph', content: 'Please keep your payment method up to date so the plan can stay active and your account remains in good standing.' },
      { type: 'cta', label: 'View account', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'Need to change the plan or have a billing question? Reply here before the next payment date.' },
    ],
    fixture: {
      first_name: 'Taylor',
      total_balance: '$390.00',
      payment_amount: '$130.00',
      payment_frequency: 'monthly',
      next_payment_date: 'July 8, 2026',
      payment_method_label: 'Visa ending in 4242',
      customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
    },
  },
  {
    key: 'payment.refund_issued',
    required: ['first_name', 'refund_amount', 'refund_date'],
    subject: 'Your Waves refund has been issued',
    preview: 'A refund has been issued for your Waves account.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, a refund has been issued for your Waves account.' },
      { type: 'details', rows: [
        { label: 'Refund amount', value: '{{refund_amount}}' },
        { label: 'Refund date', value: '{{refund_date}}' },
        { label: 'Reason', value: '{{refund_reason}}' },
        { label: 'Original payment date', value: '{{original_payment_date}}' },
        { label: 'Refunded to', value: '{{payment_method_label}}' },
      ] },
      { type: 'paragraph', content: 'Most banks and card providers take a few business days to post refunds after they are issued.' },
      { type: 'cta', label: 'View account', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'If you do not see the refund after several business days, reply here and we will help trace it.' },
    ],
    fixture: {
      first_name: 'Taylor',
      refund_amount: '$49.00',
      refund_date: 'June 8, 2026',
      refund_reason: 'Account adjustment',
      original_payment_date: 'June 1, 2026',
      payment_method_label: 'Visa ending in 4242',
      customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
    },
  },
  {
    key: 'service.report_ready',
    required: ['first_name', 'report_url', 'service_label'],
    subject: 'Your Waves {{service_label}} report is ready',
    preview: 'Review your completed service summary, findings, recommendations, and advisories.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your {{service_label}} report is ready.' },
      { type: 'paragraph', content: '{{technician_name}} completed the visit. The secure report includes the service summary, photos when available, findings, recommendations, and any customer advisories.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{service_label}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
        { label: 'Findings', value: '{{finding_summary}}' },
        { label: 'Applications', value: '{{application_summary}}' },
      ] },
      { type: 'callout', content: '{{reentry_summary}}' },
      { type: 'paragraph', content: '{{pressure_summary}}' },
      { type: 'cta', label: 'View full report', url_variable: 'report_url' },
      { type: 'small_note', content: '{{pdf_note}}' },
    ],
    fixture: {
      first_name: 'Taylor',
      report_url: 'https://portal.wavespestcontrol.com/report/demo-service',
      service_label: 'Quarterly Pest Protection',
      service_date: 'June 8, 2026',
      technician_name: 'Alex',
      property_address: '123 Harbor View Dr, Sarasota, FL 34236',
      finding_summary: 'No action-required findings were documented.',
      application_summary: 'Two exterior applications documented.',
      reentry_summary: 'Exterior treated areas are ready after they are dry.',
      pressure_summary: 'Pest pressure is trending down compared with the last visit.',
      pdf_note: 'Your PDF service report is attached.',
      company_phone: SUPPORT_PHONE,
    },
  },
  {
    key: 'project.report_ready',
    required: ['first_name', 'report_url', 'report_type'],
    subject: 'Your Waves {{report_type}} report is ready',
    preview: 'Your specialty report is posted with the visit summary, findings, photos, and recommendations.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves {{report_type}} report is posted.' },
      { type: 'paragraph', content: 'The report includes the project summary, documented findings, photos when available, recommendations, and any next steps from the visit.' },
      { type: 'details', rows: [
        { label: 'Project', value: '{{project_title}}' },
        { label: 'Report type', value: '{{report_type}}' },
        { label: 'Date', value: '{{inspection_date}}' },
        { label: 'Property', value: '{{property_address}}' },
        { label: 'Technician', value: '{{technician_name}}' },
      ] },
      { type: 'cta', label: 'View report', url_variable: 'report_url' },
      { type: 'small_note', content: 'If you have questions about the report or want help with recommended next steps, reply here or call {{company_phone}}.' },
    ],
    fixture: {
      first_name: 'Taylor',
      report_url: 'https://portal.wavespestcontrol.com/report/demo-project',
      report_type: 'rodent exclusion',
      project_title: 'Rodent exclusion report',
      inspection_date: 'June 8, 2026',
      property_address: '123 Harbor View Dr, Sarasota, FL 34236',
      technician_name: 'Alex',
      company_phone: SUPPORT_PHONE,
    },
  },
  {
    key: 'account.updated',
    required: ['first_name', 'change_summary'],
    subject: 'Your Waves account settings were updated',
    preview: 'A setting or contact preference changed on your Waves account.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves account was updated.' },
      { type: 'callout', content: 'If you did not make this change, reply to this email right away or call {{company_phone}}.' },
      { type: 'details', rows: [
        { label: 'Update', value: '{{change_summary}}' },
        { label: 'Details', value: '{{changed_items_summary}}' },
        { label: 'Property', value: '{{property_label}}' },
      ] },
      { type: 'cta', label: 'Open customer portal', url_variable: 'customer_portal_url' },
    ],
    fixture: {
      first_name: 'Taylor',
      change_summary: 'Your appointment reminder preference was updated.',
      changed_items_summary: '72-hour reminder: On to Off',
      property_label: '123 Harbor View Dr, Sarasota, FL 34236',
      customer_portal_url: 'https://portal.wavespestcontrol.com/account',
      company_phone: SUPPORT_PHONE,
    },
  },
];

const LATE_PAYMENT_STAGES = [
  ['billing_late_payment_7_day', 7, 'Friendly reminder: your Waves invoice is past due', 'This is a friendly reminder that invoice {{invoice_number}}, due {{due_date}}, is now 7 days past due.', 'You can use the secure link below to review the invoice and make payment.', 'If you already made this payment, thank you - no further action is needed.'],
  ['billing_late_payment_14_day', 14, 'Your Waves invoice is 14 days overdue', 'Invoice {{invoice_number}}, due {{due_date}}, is now 14 days overdue.', 'Please submit payment as soon as possible or reply here if something about the invoice needs review.', 'We can help with questions, receipt matching, or payment options if you need assistance.'],
  ['billing_late_payment_30_day', 30, 'Important: your Waves account has a past-due balance', 'Invoice {{invoice_number}}, due {{due_date}}, is now 30 days overdue.', 'Please pay the invoice or contact us so we can keep your account in good standing.', 'Future service may be paused until the past-due balance is resolved.'],
  ['billing_late_payment_60_day', 60, 'Action needed: Waves invoice 60 days overdue', 'Invoice {{invoice_number}}, due {{due_date}}, is now 60 days overdue.', 'Please pay today or reply to discuss payment options before the account remains on hold.', 'Your account may remain on service hold until the past-due balance is resolved.'],
  ['billing_late_payment_90_day', 90, 'Final notice: Waves invoice 90 days overdue', 'Final notice: invoice {{invoice_number}}, due {{due_date}}, is now 90 days overdue.', 'Please pay today or contact us immediately if you believe this notice was sent in error.', 'If payment is not received and we do not hear from you, this account may be sent to collections or further recovery action.'],
];

for (const [key, days, subject, opening, action, consequence] of LATE_PAYMENT_STAGES) {
  TEMPLATES.push({
    key,
    required: ['first_name', 'invoice_number', 'pay_url', 'amount_due', 'due_date'],
    subject,
    preview: `Your invoice is now ${days} days past due.`,
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: opening },
      { type: 'details', rows: [
        { label: 'Invoice', value: '{{invoice_number}}' },
        { label: 'Amount due', value: '{{amount_due}}' },
        { label: 'Due date', value: '{{due_date}}' },
      ] },
      { type: 'paragraph', content: action },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'paragraph', content: consequence },
      { type: 'small_note', content: 'Questions or need help? Reply to this email or call {{company_phone}}.' },
    ],
    fixture: {
      first_name: 'Taylor',
      invoice_number: '#1042',
      pay_url: 'https://portal.wavespestcontrol.com/pay/demo-invoice',
      amount_due: '$129.00',
      due_date: 'May 19, 2026',
      customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
      company_phone: SUPPORT_PHONE,
      company_email: SERVICE_FROM,
    },
  });
}

function json(value) {
  return JSON.stringify(value || (Array.isArray(value) ? [] : {}));
}

function templateRow(template, existing) {
  const required = template.required || [];
  const referenced = new Set([...required, ...SHARED_OPTIONAL]);
  for (const block of template.blocks || []) {
    if (block.url_variable) referenced.add(block.url_variable);
    for (const row of block.rows || []) {
      for (const part of [row.label, row.value]) {
        String(part || '').replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => referenced.add(key));
      }
    }
    String(block.content || '').replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => referenced.add(key));
  }
  String(template.subject || '').replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => referenced.add(key));
  return {
    allowed_variables: json([...referenced].sort()),
    required_variables: json(required),
    optional_variables: json([...referenced].filter((key) => !required.includes(key)).sort()),
    default_cta_label: null,
    default_cta_url_variable: null,
    from_email: existing.from_email || SERVICE_FROM,
    reply_to: existing.reply_to || SERVICE_FROM,
    status: 'active',
  };
}

async function publishTemplateVersion(knex, template) {
  const existing = await knex('email_templates').where({ template_key: template.key }).first();
  if (!existing) return;
  const row = templateRow(template, existing);
  await knex('email_templates').where({ id: existing.id }).update({
    ...row,
    updated_at: new Date(),
  });
  const latest = await knex('email_template_versions')
    .where({ template_id: existing.id })
    .orderBy('version_number', 'desc')
    .first();
  const [version] = await knex('email_template_versions').insert({
    template_id: existing.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: template.subject,
    preview_text: template.preview || null,
    blocks: json(template.blocks || []),
    text_body: null,
    published_at: new Date(),
  }).returning('*');
  await knex('email_template_versions')
    .where({ template_id: existing.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });
  await knex('email_templates').where({ id: existing.id }).update({
    active_version_id: version.id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });
  const fixture = await knex('email_template_fixtures')
    .where({ template_id: existing.id, is_default: true })
    .first();
  if (fixture) {
    await knex('email_template_fixtures').where({ id: fixture.id }).update({
      payload: json(template.fixture || {}),
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: existing.id,
      name: 'Happy path',
      payload: json(template.fixture || {}),
      is_default: true,
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  for (const template of TEMPLATES) {
    await publishTemplateVersion(knex, template);
  }
};

exports.down = async function down() {
  // Historical template versions are intentionally retained.
};
