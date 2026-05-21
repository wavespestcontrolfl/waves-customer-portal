/**
 * Seed editable payment lifecycle templates around autopay, saved payment
 * methods, retry notices, payment plans, and refunds.
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
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  payment_method_brand: 'Visa',
  payment_method_last4: '4242',
  payment_method_type: 'card',
  payment_method_label: 'Visa ending in 4242',
  new_payment_method_brand: 'Visa',
  new_payment_method_last4: '4242',
  new_payment_method_type: 'card',
  new_payment_method_label: 'Visa ending in 4242',
  old_payment_method_last4: '1881',
  old_payment_method_label: 'card ending in 1881',
  autopay_enabled_date: 'May 20, 2026',
  payment_method_updated_date: 'May 20, 2026',
  amount_due: '$129.00',
  invoice_title: 'Quarterly Pest Control Service',
  invoice_number: 'INV-1001',
  failed_payment_date: 'May 20, 2026',
  retry_date: 'May 23, 2026',
  expiration_month: '08',
  expiration_year: '2026',
  expiration_label: '08/2026',
  plan_start_date: 'May 20, 2026',
  total_balance: '$390.00',
  payment_amount: '$130.00',
  payment_frequency: 'monthly',
  next_payment_date: 'June 20, 2026',
  refund_amount: '$49.00',
  refund_date: 'May 20, 2026',
  refund_reason: 'Account adjustment',
  original_payment_date: 'May 12, 2026',
  receipt_url: 'https://portal.wavespestcontrol.com/receipt/example',
  pay_url: 'https://portal.wavespestcontrol.com/pay/example',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
};

const TEMPLATES = [
  {
    key: 'payment.autopay_enabled',
    name: 'Autopay Setup Confirmation',
    description: 'Confirmation sent when autopay is enabled or a recurring billing method is added.',
    required: ['first_name'],
    optional: [
      'autopay_enabled_date',
      'customer_portal_url',
      'payment_method_brand',
      'payment_method_last4',
      'payment_method_type',
      'payment_method_label',
      'customer_name',
      'company_phone',
      'company_email',
    ],
    subject: 'Autopay is now active for your Waves account',
    preview: 'Autopay is active for future eligible Waves invoices.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Autopay is now active for your Waves account.' },
      { type: 'paragraph', content: 'Your future eligible invoices will be automatically charged to {{payment_method_label}} after service is completed, unless another billing arrangement applies.' },
      { type: 'paragraph', content: 'You can view your account, upcoming services, invoices, and payment method anytime in your customer portal.' },
      { type: 'cta', label: 'Manage account', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'payment.method_updated',
    name: 'Autopay Updated',
    description: 'Confirmation sent when the default payment method changes.',
    required: ['first_name'],
    optional: [
      'payment_method_updated_date',
      'old_payment_method_last4',
      'old_payment_method_label',
      'new_payment_method_brand',
      'new_payment_method_last4',
      'new_payment_method_type',
      'new_payment_method_label',
      'customer_portal_url',
      'customer_name',
      'company_phone',
      'company_email',
    ],
    subject: 'Your Waves payment method was updated',
    preview: 'Your Waves payment method was updated successfully.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves payment method was updated successfully.' },
      { type: 'paragraph', content: 'Your account is now set to use {{new_payment_method_label}} for future eligible payments.' },
      { type: 'details', rows: [{ label: 'Previous method', value: '{{old_payment_method_label}}' }, { label: 'Updated', value: '{{payment_method_updated_date}}' }] },
      { type: 'paragraph', content: 'You can review your invoices, upcoming services, and payment settings in your customer portal.' },
      { type: 'cta', label: 'Manage payment method', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'If you did not make this change, please contact us right away by replying to this email.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'payment.method_expiring',
    name: 'Payment Method Expiring',
    description: 'Reminder sent before a saved autopay payment method expires.',
    required: ['first_name'],
    optional: [
      'payment_method_brand',
      'payment_method_last4',
      'payment_method_type',
      'payment_method_label',
      'expiration_month',
      'expiration_year',
      'expiration_label',
      'customer_portal_url',
      'customer_name',
      'company_phone',
      'company_email',
    ],
    subject: 'Your Waves payment method is expiring soon',
    preview: 'Please update your Waves payment method before it expires.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'The payment method on file for your Waves account is expiring soon.' },
      { type: 'details', rows: [{ label: 'Payment method', value: '{{payment_method_label}}' }, { label: 'Expiration', value: '{{expiration_label}}' }] },
      { type: 'paragraph', content: 'Please update your payment method to avoid failed payments or interruptions to your service.' },
      { type: 'cta', label: 'Update payment method', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'payment.retry_notice',
    name: 'Payment Retry Notice',
    description: 'Notice sent after a failed payment when a retry has been scheduled.',
    required: ['first_name'],
    optional: [
      'invoice_title',
      'invoice_number',
      'amount_due',
      'failed_payment_date',
      'retry_date',
      'payment_method_brand',
      'payment_method_last4',
      'payment_method_type',
      'payment_method_label',
      'pay_url',
      'customer_portal_url',
      'customer_name',
      'company_phone',
      'company_email',
    ],
    subject: "We'll retry your Waves payment soon",
    preview: "We'll retry your Waves payment soon.",
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'We were unable to process payment for your Waves invoice:' },
      { type: 'details', rows: [{ label: 'Invoice', value: '{{invoice_title}}' }, { label: 'Invoice #', value: '{{invoice_number}}' }, { label: 'Amount due', value: '{{amount_due}}' }, { label: 'Failed payment date', value: '{{failed_payment_date}}' }, { label: 'Payment method', value: '{{payment_method_label}}' }] },
      { type: 'paragraph', content: "We'll retry the payment on {{retry_date}}. You can also pay now or update your payment method using the link below." },
      { type: 'cta', label: 'Pay or update payment method', url_variable: 'pay_url' },
      { type: 'small_note', content: 'If you already updated your payment method or made payment, thank you - no further action is needed.' },
      { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'payment.plan_confirmed',
    name: 'Payment Plan Confirmation',
    description: 'Confirmation sent when a customer payment plan is created or confirmed.',
    required: ['first_name'],
    optional: [
      'plan_start_date',
      'total_balance',
      'payment_amount',
      'payment_frequency',
      'next_payment_date',
      'payment_method_brand',
      'payment_method_last4',
      'payment_method_type',
      'payment_method_label',
      'customer_portal_url',
      'customer_name',
      'company_phone',
      'company_email',
    ],
    subject: 'Your Waves payment plan is confirmed',
    preview: 'Your Waves payment plan has been confirmed.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves payment plan has been confirmed.' },
      { type: 'details', rows: [{ label: 'Balance included', value: '{{total_balance}}' }, { label: 'Payment amount', value: '{{payment_amount}}' }, { label: 'Payment frequency', value: '{{payment_frequency}}' }, { label: 'Next payment date', value: '{{next_payment_date}}' }, { label: 'Payment method', value: '{{payment_method_label}}' }] },
      { type: 'paragraph', content: 'Please keep your payment method up to date so your plan remains active.' },
      { type: 'cta', label: 'View account', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'payment.refund_issued',
    name: 'Refund Issued',
    description: 'Notice sent when a refund is successfully issued.',
    required: ['first_name'],
    optional: [
      'refund_amount',
      'refund_date',
      'refund_reason',
      'original_payment_date',
      'payment_method_brand',
      'payment_method_last4',
      'payment_method_type',
      'payment_method_label',
      'receipt_url',
      'customer_portal_url',
      'customer_name',
      'company_phone',
      'company_email',
    ],
    subject: 'Your Waves refund has been issued',
    preview: 'A refund has been issued for your Waves account.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'A refund has been issued for your Waves account.' },
      { type: 'details', rows: [{ label: 'Refund amount', value: '{{refund_amount}}' }, { label: 'Refund date', value: '{{refund_date}}' }, { label: 'Reason', value: '{{refund_reason}}' }, { label: 'Original payment date', value: '{{original_payment_date}}' }] },
      { type: 'paragraph', content: 'The refund will be returned to {{payment_method_label}}. Depending on your bank or card provider, it may take a few business days to appear.' },
      { type: 'cta', label: 'View account', url_variable: 'customer_portal_url' },
      { type: 'cta', label: 'View receipt', url_variable: 'receipt_url' },
      { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
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

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'active',
      subject: t.subject,
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
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
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
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
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  await ensureTransactionalGroup(knex);
  for (const template of TEMPLATES) {
    await upsertTemplate(knex, template);
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
  SHARED_VARIABLES,
  PREVIEW_PAYLOAD,
  templateRow,
};
