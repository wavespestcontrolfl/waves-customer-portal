/**
 * Deepen billing and payment lifecycle emails.
 *
 * Publishes new active template versions while keeping template keys stable.
 * Required variables stay compatible with existing send paths; new context is
 * optional so older callers still render cleanly.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_OPTIONAL = [
  'customer_name',
  'customer_portal_url',
  'company_phone',
  'company_email',
  'invoice_title',
  'invoice_number',
  'service_label',
  'service_date',
  'service_date_clause',
  'amount_due',
  'amount_paid',
  'due_date',
  'paid_at',
  'payment_method',
  'payment_method_brand',
  'payment_method_last4',
  'payment_method_type',
  'payment_method_label',
  'pay_url',
  'payment_url',
  'receipt_url',
  'invoice_url',
  'attachment_note',
  'memo',
  'retry_date',
  'failed_payment_date',
  'autopay_enabled_date',
  'payment_method_updated_date',
  'old_payment_method_label',
  'old_payment_method_last4',
  'new_payment_method_label',
  'new_payment_method_last4',
  'expiration_month',
  'expiration_year',
  'expiration_label',
  'plan_start_date',
  'total_balance',
  'payment_amount',
  'payment_frequency',
  'next_payment_date',
  'refund_amount',
  'refund_date',
  'refund_reason',
  'original_payment_date',
];

const TEMPLATES = [
  {
    key: 'invoice.sent',
    name: 'Invoice Sent',
    description: 'Professional billing email with a secure payment link.',
    purpose: 'invoice',
    sensitivity: 'financial',
    required: ['first_name', 'invoice_url', 'invoice_number', 'amount_due'],
    optional: ['due_date', 'service_label', 'service_date', 'attachment_note', 'customer_portal_url', 'company_phone'],
    subject: 'Invoice {{invoice_number}} from Waves',
    preview: 'Your invoice is ready, with the service details and secure payment link inside.',
    ctaLabel: 'View and pay invoice',
    ctaUrlVariable: 'invoice_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves invoice {{invoice_number}} is ready.' },
      { type: 'paragraph', content: 'The attached PDF has the full itemized breakdown. You can also review the invoice online and pay securely from the link below.' },
      { type: 'details', rows: [
        { label: 'Amount due', value: '{{amount_due}}' },
        { label: 'Due date', value: '{{due_date}}' },
        { label: 'Service', value: '{{service_label}}' },
        { label: 'Service date', value: '{{service_date}}' },
      ] },
      { type: 'cta', label: 'View and pay invoice', url_variable: 'invoice_url' },
      { type: 'small_note', content: '{{attachment_note}}' },
      { type: 'small_note', content: 'If you already paid, no action is needed. Questions about the invoice? Reply here and our billing team will help.' },
    ],
    fixture: { first_name: 'Taylor', invoice_url: 'https://portal.wavespestcontrol.com/pay/sample', invoice_number: 'WPC-2026-1042', amount_due: '$129.00', due_date: 'June 15, 2026', service_label: 'Quarterly Pest Control', service_date: 'June 8, 2026', attachment_note: 'Your PDF invoice is attached.', company_phone: '(941) 555-0100' },
  },
  {
    key: 'invoice.receipt',
    name: 'Payment Receipt',
    description: 'Payment receipt after a successful customer payment.',
    purpose: 'invoice',
    sensitivity: 'financial',
    required: ['first_name', 'receipt_url', 'invoice_number', 'amount_paid'],
    optional: ['paid_at', 'service_label', 'payment_method', 'memo', 'customer_portal_url'],
    subject: 'Receipt for {{invoice_number}}',
    preview: 'Thanks. Your Waves payment was received and your receipt is attached.',
    ctaLabel: 'View receipt',
    ctaUrlVariable: 'receipt_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, thank you. We received your payment for invoice {{invoice_number}}.' },
      { type: 'paragraph', content: 'A printable receipt is attached for your records, and the online receipt remains available from the secure link below.' },
      { type: 'details', rows: [
        { label: 'Amount paid', value: '{{amount_paid}}' },
        { label: 'Paid', value: '{{paid_at}}' },
        { label: 'Service', value: '{{service_label}}' },
        { label: 'Payment method', value: '{{payment_method}}' },
      ] },
      { type: 'callout', content: '{{memo}}' },
      { type: 'cta', label: 'View receipt', url_variable: 'receipt_url' },
      { type: 'small_note', content: 'Keep this email for your records. If something looks off, reply here and we will review it.' },
    ],
    fixture: { first_name: 'Taylor', receipt_url: 'https://portal.wavespestcontrol.com/receipt/sample', invoice_number: 'WPC-2026-1042', amount_paid: '$129.00', paid_at: 'June 8, 2026', service_label: 'Quarterly Pest Control', payment_method: 'Visa ending in 4242' },
  },
  {
    key: 'payment.failed',
    name: 'Payment Failed',
    description: 'Account-state notice when an autopay attempt fails.',
    purpose: 'payment',
    sensitivity: 'financial',
    required: ['first_name', 'payment_url'],
    optional: ['invoice_title', 'invoice_number', 'amount_due', 'failed_payment_date', 'retry_date', 'payment_method_label', 'customer_portal_url', 'company_phone'],
    subject: 'Payment issue on your Waves account',
    preview: 'Your recent payment did not go through. You can update payment securely.',
    ctaLabel: 'Fix payment',
    ctaUrlVariable: 'payment_url',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, we were not able to process a recent Waves payment.' },
      { type: 'paragraph', content: 'This can happen when a card expires, a bank flags the charge, or a temporary processor issue occurs. Your service team is not changing anything automatically because of this notice, but the balance should be resolved as soon as possible.' },
      { type: 'details', rows: [
        { label: 'Invoice', value: '{{invoice_title}}' },
        { label: 'Invoice #', value: '{{invoice_number}}' },
        { label: 'Amount', value: '{{amount_due}}' },
        { label: 'Attempted', value: '{{failed_payment_date}}' },
        { label: 'Payment method', value: '{{payment_method_label}}' },
        { label: 'Retry date', value: '{{retry_date}}' },
      ] },
      { type: 'cta', label: 'Fix payment', url_variable: 'payment_url' },
      { type: 'small_note', content: 'If you already updated your payment method or made the payment another way, no further action is needed.' },
    ],
    fixture: { first_name: 'Taylor', payment_url: 'https://portal.wavespestcontrol.com/pay/sample', invoice_title: 'Quarterly Pest Control', invoice_number: 'WPC-2026-1042', amount_due: '$129.00', failed_payment_date: 'June 8, 2026', retry_date: 'June 11, 2026', payment_method_label: 'Visa ending in 4242' },
  },
  {
    key: 'payment.autopay_enabled',
    name: 'Autopay Setup Confirmation',
    description: 'Confirmation sent when autopay is enabled or a recurring billing method is added.',
    purpose: 'payment',
    sensitivity: 'financial',
    required: ['first_name'],
    optional: ['autopay_enabled_date', 'payment_method_label', 'customer_portal_url', 'company_phone', 'company_email'],
    subject: 'Autopay is now active for your Waves account',
    preview: 'Autopay is active for future eligible Waves invoices.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, autopay is now active for your Waves account.' },
      { type: 'details', rows: [
        { label: 'Payment method', value: '{{payment_method_label}}' },
        { label: 'Enabled', value: '{{autopay_enabled_date}}' },
      ] },
      { type: 'paragraph', content: 'Future eligible invoices will be charged automatically after service is completed, unless a different billing arrangement applies.' },
      { type: 'paragraph', content: 'You can review invoices, payment methods, upcoming services, and account details anytime in your customer portal.' },
      { type: 'cta', label: 'Manage account', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'If you did not authorize autopay, reply to this email right away or call {{company_phone}}.' },
    ],
    fixture: { first_name: 'Taylor', payment_method_label: 'Visa ending in 4242', autopay_enabled_date: 'June 8, 2026', customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing', company_phone: '(941) 555-0100' },
  },
  {
    key: 'payment.method_updated',
    name: 'Autopay Updated',
    description: 'Confirmation sent when the default payment method changes.',
    purpose: 'payment',
    sensitivity: 'financial',
    required: ['first_name'],
    optional: ['payment_method_updated_date', 'old_payment_method_label', 'new_payment_method_label', 'customer_portal_url', 'company_phone'],
    subject: 'Your Waves payment method was updated',
    preview: 'Your saved payment method was updated successfully.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, your Waves payment method was updated successfully.' },
      { type: 'details', rows: [
        { label: 'New method', value: '{{new_payment_method_label}}' },
        { label: 'Previous method', value: '{{old_payment_method_label}}' },
        { label: 'Updated', value: '{{payment_method_updated_date}}' },
      ] },
      { type: 'paragraph', content: 'Future eligible payments will use the updated method unless you change it again or make a separate payment arrangement.' },
      { type: 'cta', label: 'Manage payment method', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'If you did not make this change, reply to this email right away or call {{company_phone}}.' },
    ],
    fixture: { first_name: 'Taylor', new_payment_method_label: 'Visa ending in 4242', old_payment_method_label: 'card ending in 1881', payment_method_updated_date: 'June 8, 2026', customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing', company_phone: '(941) 555-0100' },
  },
  {
    key: 'payment.method_expiring',
    name: 'Payment Method Expiring',
    description: 'Reminder sent before a saved autopay payment method expires.',
    purpose: 'payment',
    sensitivity: 'financial',
    required: ['first_name'],
    optional: ['payment_method_label', 'expiration_label', 'customer_portal_url', 'company_phone'],
    subject: 'Your Waves payment method is expiring soon',
    preview: 'Please update your saved payment method to avoid payment issues.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, the saved payment method on your Waves account is expiring soon.' },
      { type: 'details', rows: [
        { label: 'Payment method', value: '{{payment_method_label}}' },
        { label: 'Expiration', value: '{{expiration_label}}' },
      ] },
      { type: 'paragraph', content: 'Updating it now helps prevent failed payments and keeps future service billing from getting delayed.' },
      { type: 'cta', label: 'Update payment method', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'Need help updating it? Reply here or call {{company_phone}}.' },
    ],
    fixture: { first_name: 'Taylor', payment_method_label: 'Visa ending in 4242', expiration_label: '08/2026', customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing', company_phone: '(941) 555-0100' },
  },
  {
    key: 'payment.retry_notice',
    name: 'Payment Retry Notice',
    description: 'Notice sent after a failed payment when a retry has been scheduled.',
    purpose: 'payment',
    sensitivity: 'financial',
    required: ['first_name'],
    optional: ['invoice_title', 'invoice_number', 'amount_due', 'failed_payment_date', 'retry_date', 'payment_method_label', 'pay_url', 'customer_portal_url', 'company_phone'],
    subject: "We'll retry your Waves payment soon",
    preview: 'A payment retry has been scheduled. You can pay or update your method now.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, we were unable to process payment for your Waves invoice.' },
      { type: 'details', rows: [
        { label: 'Invoice', value: '{{invoice_title}}' },
        { label: 'Invoice #', value: '{{invoice_number}}' },
        { label: 'Amount due', value: '{{amount_due}}' },
        { label: 'Failed payment date', value: '{{failed_payment_date}}' },
        { label: 'Retry date', value: '{{retry_date}}' },
        { label: 'Payment method', value: '{{payment_method_label}}' },
      ] },
      { type: 'paragraph', content: 'We will retry the payment on {{retry_date}}. You can also pay now or update your payment method using the secure link below.' },
      { type: 'cta', label: 'Pay or update method', url_variable: 'pay_url' },
      { type: 'small_note', content: 'If you already made payment or updated your method, thank you - no further action is needed.' },
    ],
    fixture: { first_name: 'Taylor', invoice_title: 'Quarterly Pest Control', invoice_number: 'WPC-2026-1042', amount_due: '$129.00', failed_payment_date: 'June 8, 2026', retry_date: 'June 11, 2026', payment_method_label: 'Visa ending in 4242', pay_url: 'https://portal.wavespestcontrol.com/pay/sample' },
  },
  {
    key: 'payment.plan_confirmed',
    name: 'Payment Plan Confirmation',
    description: 'Confirmation sent when a customer payment plan is created or confirmed.',
    purpose: 'payment',
    sensitivity: 'financial',
    required: ['first_name'],
    optional: ['plan_start_date', 'total_balance', 'payment_amount', 'payment_frequency', 'next_payment_date', 'payment_method_label', 'customer_portal_url', 'company_phone'],
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
    fixture: { first_name: 'Taylor', total_balance: '$390.00', payment_amount: '$130.00', payment_frequency: 'monthly', next_payment_date: 'July 8, 2026', payment_method_label: 'Visa ending in 4242', customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing' },
  },
  {
    key: 'payment.refund_issued',
    name: 'Refund Issued',
    description: 'Notice sent when a refund is successfully issued.',
    purpose: 'payment',
    sensitivity: 'financial',
    required: ['first_name'],
    optional: ['refund_amount', 'refund_date', 'refund_reason', 'original_payment_date', 'payment_method_label', 'receipt_url', 'customer_portal_url'],
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
      { type: 'cta', label: 'View receipt', url_variable: 'receipt_url' },
      { type: 'small_note', content: 'If you do not see the refund after several business days, reply here and we will help trace it.' },
    ],
    fixture: { first_name: 'Taylor', refund_amount: '$49.00', refund_date: 'June 8, 2026', refund_reason: 'Account adjustment', original_payment_date: 'June 1, 2026', payment_method_label: 'Visa ending in 4242', customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing', receipt_url: 'https://portal.wavespestcontrol.com/receipt/sample' },
  },
];

const LATE_PAYMENT_STAGES = [
  {
    key: 'billing_late_payment_7_day',
    days: 7,
    subject: 'Friendly reminder: your Waves invoice is past due',
    preview: 'Your invoice is now 7 days past due.',
    opening: 'This is a friendly reminder that your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 7 days past due.',
    action: 'You can use the secure link below to review the invoice and make payment.',
    consequence: 'If you already made this payment, thank you - no further action is needed.',
  },
  {
    key: 'billing_late_payment_14_day',
    days: 14,
    subject: 'Your Waves invoice is 14 days overdue',
    preview: 'Please take care of this past-due invoice when you can.',
    opening: 'Your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 14 days overdue.',
    action: 'Please submit payment as soon as possible or reply here if something about the invoice needs review.',
    consequence: 'We can help with questions, receipt matching, or payment options if you need assistance.',
  },
  {
    key: 'billing_late_payment_30_day',
    days: 30,
    subject: 'Important: your Waves account has a past-due balance',
    preview: 'Your account has a past-due balance that needs attention.',
    opening: 'Your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 30 days overdue.',
    action: 'Please pay the invoice or contact us so we can keep your account in good standing.',
    consequence: 'Future service may be paused until the past-due balance is resolved.',
  },
  {
    key: 'billing_late_payment_60_day',
    days: 60,
    subject: 'Action needed: Waves invoice 60 days overdue',
    preview: 'Please pay or contact Waves today about this past-due invoice.',
    opening: 'Your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 60 days overdue.',
    action: 'Please pay today or reply to discuss payment options before the account remains on hold.',
    consequence: 'Your account may remain on service hold until the past-due balance is resolved.',
  },
  {
    key: 'billing_late_payment_90_day',
    days: 90,
    subject: 'Final notice: Waves invoice 90 days overdue',
    preview: 'Final notice for a Waves invoice that is 90 days overdue.',
    opening: 'This is a final notice that your Waves invoice for {{invoice_title}}{{service_date_clause}} is now 90 days overdue.',
    action: 'Please pay today or contact us immediately if you believe this notice was sent in error.',
    consequence: 'If payment is not received and we do not hear from you, this account may be sent to collections or further recovery action.',
  },
];

for (const stage of LATE_PAYMENT_STAGES) {
  TEMPLATES.push({
    key: stage.key,
    name: `Late Payment - ${stage.days} Day`,
    description: `Billing notice sent with the ${stage.days}-day late-payment SMS.`,
    purpose: 'billing',
    sensitivity: 'financial',
    required: ['first_name', 'invoice_title', 'pay_url', 'amount_due', 'due_date'],
    optional: ['service_date_clause', 'invoice_number', 'customer_portal_url', 'company_phone', 'company_email'],
    subject: stage.subject,
    preview: stage.preview,
    ctaLabel: 'Pay invoice',
    ctaUrlVariable: 'pay_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: stage.opening },
      { type: 'details', rows: [
        { label: 'Invoice #', value: '{{invoice_number}}' },
        { label: 'Amount due', value: '{{amount_due}}' },
        { label: 'Due date', value: '{{due_date}}' },
      ] },
      { type: 'paragraph', content: stage.action },
      { type: 'cta', label: 'Pay invoice', url_variable: 'pay_url' },
      { type: 'paragraph', content: stage.consequence },
      { type: 'small_note', content: 'Questions or need help? Reply to this email or call {{company_phone}}.' },
    ],
    fixture: {
      first_name: 'Taylor',
      invoice_title: 'Quarterly Pest Control',
      service_date_clause: ' completed on May 12, 2026',
      pay_url: 'https://portal.wavespestcontrol.com/pay/sample',
      amount_due: '$129.00',
      due_date: 'May 19, 2026',
      invoice_number: 'WPC-2026-1042',
      customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=billing',
      company_phone: '(941) 555-0100',
      company_email: SERVICE_FROM,
    },
  });
}

function json(value) {
  return JSON.stringify(value || (Array.isArray(value) ? [] : {}));
}

function templateRow(t, existing = {}) {
  const allowed = [...new Set([...(t.required || []), ...(t.optional || []), ...SHARED_OPTIONAL])];
  return {
    template_key: t.key,
    name: t.name || existing.name || t.key,
    description: t.description || existing.description || null,
    mode: existing.mode || 'service',
    purpose: t.purpose || existing.purpose || 'general',
    legal_classification: existing.legal_classification || 'transactional_relationship',
    audience: existing.audience || 'customer',
    message_priority: existing.message_priority || 'normal',
    content_sensitivity: t.sensitivity || existing.content_sensitivity || 'financial',
    send_stream: existing.send_stream || 'transactional_required',
    suppression_group_key: existing.suppression_group_key || 'transactional_required',
    layout_wrapper_id: existing.layout_wrapper_id || 'service_default_v1',
    from_name: existing.from_name || 'Waves Pest Control',
    from_email: existing.from_email || SERVICE_FROM,
    reply_to: existing.reply_to || SERVICE_FROM,
    default_cta_label: t.ctaLabel || existing.default_cta_label || null,
    default_cta_url_variable: t.ctaUrlVariable || existing.default_cta_url_variable || null,
    allowed_variables: json(allowed),
    required_variables: json(t.required || []),
    optional_variables: json(allowed.filter((key) => !(t.required || []).includes(key))),
    status: 'active',
  };
}

async function publishTemplateVersion(knex, t) {
  let template = await knex('email_templates').where({ template_key: t.key }).first();
  const row = templateRow(t, template || {});
  if (!template) {
    [template] = await knex('email_templates').insert(row).returning('*');
  } else {
    await knex('email_templates').where({ id: template.id }).update({
      ...row,
      updated_at: new Date(),
    });
    template = await knex('email_templates').where({ id: template.id }).first();
  }

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: json(t.blocks || []),
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
  const payload = json(t.fixture || {});
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      payload,
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload,
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
