/**
 * Customer email contract hardening.
 *
 * Tightens the next set of customer-facing template contracts after the
 * cleanup export review: prep CTAs, payment/account required fields, receipt
 * memo suppression, and a clearer onboarding reminder subject.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const SUPPORT_PHONE = '(941) 297-5749';

const SHARED_OPTIONAL = [
  'customer_name',
  'customer_email',
  'customer_phone',
  'customer_portal_url',
  'portal_url',
  'portal_invite_url',
  'portal_requests_url',
  'manage_preferences_url',
  'company_phone',
  'company_email',
  'property_label',
  'property_address',
  'account_section',
  'change_summary',
  'changed_items_summary',
  'changed_at',
  'request_id',
  'request_type',
  'request_subject',
  'request_summary',
  'request_status',
  'submitted_at',
  'updated_at',
  'response_time',
  'membership_name',
  'membership_tier',
  'membership_status',
  'membership_change_summary',
  'old_membership_tier',
  'new_membership_tier',
  'old_monthly_rate',
  'new_monthly_rate',
  'monthly_rate',
  'billing_cadence',
  'included_services',
  'effective_date',
  'renewal_date',
  'renewal_days_out',
  'renewal_notice_window',
  'last_service_date',
  'paused_until',
  'pause_reason',
  'cancellation_effective_date',
  'reactivated_at',
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
  'retry_date',
  'failed_payment_date',
  'autopay_enabled_date',
  'payment_method_updated_date',
  'old_payment_method_label',
  'new_payment_method_label',
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
  'report_url',
  'report_type',
  'project_type',
  'project_title',
  'project_date',
  'inspection_date',
  'prep_url',
  'technician_name',
  'finding_summary',
  'application_summary',
  'reentry_summary',
  'pressure_summary',
  'pdf_note',
  'plan_name',
  'setup_steps',
  'next_step_summary',
  'onboarding_url',
  'expires_at',
];

const PAYMENT_CONTRACTS = {
  'payment.autopay_enabled': ['first_name', 'payment_method_label', 'autopay_enabled_date', 'customer_portal_url'],
  'payment.method_updated': ['first_name', 'new_payment_method_label', 'payment_method_updated_date', 'customer_portal_url'],
  'payment.method_expiring': ['first_name', 'payment_method_label', 'expiration_label', 'customer_portal_url'],
  'payment.failed': ['first_name', 'payment_url', 'amount_due'],
  'payment.retry_notice': ['first_name', 'pay_url', 'amount_due', 'failed_payment_date', 'retry_date'],
  'payment.plan_confirmed': ['first_name', 'total_balance', 'payment_amount', 'payment_frequency', 'next_payment_date', 'customer_portal_url'],
  'payment.refund_issued': ['first_name', 'refund_amount', 'refund_date'],
};

const MEMBERSHIP_CONTRACTS = {
  'membership.started': ['first_name', 'membership_name', 'membership_status', 'effective_date', 'customer_portal_url'],
  'membership.updated': ['first_name', 'membership_change_summary', 'effective_date', 'customer_portal_url'],
  'membership.renewal_reminder': ['first_name', 'membership_name', 'renewal_date', 'customer_portal_url'],
  'membership.canceled': ['first_name', 'membership_name', 'membership_status', 'cancellation_effective_date'],
  'membership.paused': ['first_name', 'membership_name', 'membership_status'],
  'membership.reactivated': ['first_name', 'membership_name', 'membership_status', 'reactivated_at', 'customer_portal_url'],
};

const ACCOUNT_CONTRACTS = {
  'portal.invite': ['first_name', 'portal_invite_url', 'customer_name', 'customer_email'],
  'account.updated': ['first_name', 'change_summary', 'customer_portal_url'],
  'account.request_received': ['first_name', 'request_subject', 'request_status', 'portal_requests_url'],
  'account.request_updated': ['first_name', 'request_subject', 'request_status', 'portal_requests_url'],
};

const PREP_TEMPLATES = [
  'prep.bed_bug',
  'prep.cockroach',
  'prep.rodent',
  'prep.flea',
  'prep.mosquito',
  'prep.lawn',
  'prep.termite',
  'prep.interior_pest',
];

const PREP_REQUIRED = ['first_name', 'prep_url', 'project_type', 'service_date', 'property_address'];

function json(value) {
  return JSON.stringify(value || (Array.isArray(value) ? [] : {}));
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function extractVariables(input, out = new Set()) {
  const text = typeof input === 'string' ? input : JSON.stringify(input || '');
  text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
    out.add(key);
    return '';
  });
  return out;
}

function normalizeBlocks(blocks) {
  return asArray(blocks).map((block) => {
    if (block?.type === 'cta') {
      return {
        ...block,
        label: 'Open prep guide',
        url_variable: 'prep_url',
        url: '',
      };
    }
    return block;
  });
}

function variablesFor(template, version, required) {
  const set = new Set([
    ...SHARED_OPTIONAL,
    ...asArray(template.allowed_variables),
    ...required,
  ]);
  extractVariables(version.subject, set);
  extractVariables(version.preview_text, set);
  extractVariables(version.text_body, set);
  for (const block of asArray(version.blocks)) extractVariables(block, set);
  return [...set].sort();
}

function demoPayload(templateKey) {
  const base = {
    first_name: 'Taylor',
    customer_name: 'Taylor Morgan',
    customer_email: 'contact@wavespestcontrol.com',
    customer_phone: SUPPORT_PHONE,
    customer_portal_url: 'https://portal.wavespestcontrol.com',
    portal_url: 'https://portal.wavespestcontrol.com',
    portal_invite_url: 'https://portal.wavespestcontrol.com/login',
    portal_requests_url: 'https://portal.wavespestcontrol.com',
    manage_preferences_url: 'https://portal.wavespestcontrol.com',
    company_phone: SUPPORT_PHONE,
    company_email: SERVICE_FROM,
    property_address: '123 Harbor View Dr, Sarasota, FL 34236',
    property_label: '123 Harbor View Dr, Sarasota, FL 34236',
    project_type: 'Quarterly Pest Protection',
    service_label: 'Quarterly Pest Protection',
    service_date: 'June 3, 2026',
    prep_url: 'https://portal.wavespestcontrol.com/login',
    payment_method_label: 'Visa ending in 4242',
    new_payment_method_label: 'Visa ending in 4242',
    old_payment_method_label: 'card ending in 1881',
    autopay_enabled_date: 'June 3, 2026',
    payment_method_updated_date: 'June 3, 2026',
    expiration_label: '08/2026',
    payment_url: 'https://portal.wavespestcontrol.com/pay/demo-invoice',
    pay_url: 'https://portal.wavespestcontrol.com/pay/demo-invoice',
    amount_due: '$129.00',
    failed_payment_date: 'June 3, 2026',
    retry_date: 'June 6, 2026',
    total_balance: '$390.00',
    payment_amount: '$130.00',
    payment_frequency: 'monthly',
    next_payment_date: 'July 3, 2026',
    refund_amount: '$49.00',
    refund_date: 'June 3, 2026',
    refund_reason: 'Account adjustment',
    invoice_number: '#1042',
    receipt_url: 'https://portal.wavespestcontrol.com/receipt/demo-receipt',
    invoice_url: 'https://portal.wavespestcontrol.com/pay/demo-invoice',
    membership_name: 'WaveGuard Gold',
    membership_status: 'Active',
    membership_change_summary: 'Your membership details were updated.',
    effective_date: 'June 3, 2026',
    renewal_date: 'July 3, 2026',
    cancellation_effective_date: 'June 30, 2026',
    reactivated_at: 'June 3, 2026',
    request_subject: 'Move upcoming quarterly service',
    request_status: 'New',
    change_summary: 'Your appointment reminder preference was updated.',
    plan_name: 'WaveGuard Gold',
    setup_steps: 'Payment method, service preferences, and property details',
    next_step_summary: 'Most customers finish setup in about two minutes.',
    onboarding_url: 'https://portal.wavespestcontrol.com/onboard/demo',
  };
  if (templateKey === 'membership.canceled') base.membership_status = 'Canceled';
  if (templateKey === 'membership.paused') base.membership_status = 'Paused';
  return base;
}

async function updateRequiredOnly(knex, templateKey, required) {
  const template = await knex('email_templates').where({ template_key: templateKey }).first();
  if (!template?.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version) return;
  const allowed = variablesFor(template, version, required);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: json(allowed),
    required_variables: json(required),
    optional_variables: json(allowed.filter((key) => !required.includes(key))),
    updated_at: new Date(),
  });
  await upsertFixture(knex, template.id, demoPayload(templateKey));
}

async function updatePrepTemplate(knex, templateKey) {
  const template = await knex('email_templates').where({ template_key: templateKey }).first();
  if (!template?.active_version_id) return;
  const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!current) return;
  const blocks = normalizeBlocks(current.blocks);
  const allowed = variablesFor(template, { ...current, blocks }, PREP_REQUIRED);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: json(allowed),
    required_variables: json(PREP_REQUIRED),
    optional_variables: json(allowed.filter((key) => !PREP_REQUIRED.includes(key))),
    default_cta_label: null,
    default_cta_url_variable: null,
    updated_at: new Date(),
  });
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: current.subject,
    preview_text: current.preview_text,
    blocks: json(blocks),
    text_body: current.text_body,
    published_at: new Date(),
  }).returning('*');
  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });
  await upsertFixture(knex, template.id, demoPayload(templateKey));
}

async function updateInvoiceReceipt(knex) {
  const templateKey = 'invoice.receipt';
  const template = await knex('email_templates').where({ template_key: templateKey }).first();
  if (!template?.active_version_id) return;
  const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!current) return;
  const blocks = asArray(current.blocks).filter((block) => {
    if (block?.type !== 'callout') return true;
    return !String(block.content || '').includes('{{memo}}');
  });
  const required = ['first_name', 'receipt_url', 'invoice_number', 'amount_paid'];
  const allowed = variablesFor(template, { ...current, blocks }, required).filter((key) => key !== 'memo');
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: json(allowed),
    required_variables: json(required),
    optional_variables: json(allowed.filter((key) => !required.includes(key))),
    updated_at: new Date(),
  });
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: current.subject,
    preview_text: current.preview_text,
    blocks: json(blocks),
    text_body: current.text_body,
    published_at: new Date(),
  }).returning('*');
  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });
  await upsertFixture(knex, template.id, {
    first_name: 'Taylor',
    receipt_url: 'https://portal.wavespestcontrol.com/receipt/demo-receipt',
    invoice_number: '#1042',
    amount_paid: '$129.00',
    paid_at: 'June 3, 2026',
    service_label: 'Quarterly Pest Protection',
    payment_method: 'Visa ending in 4242',
  });
}

async function updateOnboarding72h(knex) {
  const template = await knex('email_templates').where({ template_key: 'onboarding.72h_reminder' }).first();
  if (!template?.active_version_id) return;
  const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!current) return;
  const subject = 'Finish setup for your Waves service';
  const required = ['first_name', 'onboarding_url', 'plan_name', 'setup_steps'];
  const allowed = variablesFor(template, { ...current, subject }, required);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: json(allowed),
    required_variables: json(required),
    optional_variables: json(allowed.filter((key) => !required.includes(key))),
    updated_at: new Date(),
  });
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject,
    preview_text: current.preview_text,
    blocks: json(current.blocks),
    text_body: current.text_body,
    published_at: new Date(),
  }).returning('*');
  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });
  await upsertFixture(knex, template.id, demoPayload('onboarding.72h_reminder'));
}

async function upsertFixture(knex, templateId, payload) {
  const fixture = await knex('email_template_fixtures')
    .where({ template_id: templateId, is_default: true })
    .first();
  if (fixture) {
    await knex('email_template_fixtures').where({ id: fixture.id }).update({
      payload: json(payload),
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: templateId,
      name: 'Happy path',
      payload: json(payload),
      is_default: true,
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  await updateInvoiceReceipt(knex);
  await updateOnboarding72h(knex);

  for (const key of PREP_TEMPLATES) await updatePrepTemplate(knex, key);
  for (const [key, required] of Object.entries(PAYMENT_CONTRACTS)) await updateRequiredOnly(knex, key, required);
  for (const [key, required] of Object.entries(MEMBERSHIP_CONTRACTS)) await updateRequiredOnly(knex, key, required);
  for (const [key, required] of Object.entries(ACCOUNT_CONTRACTS)) await updateRequiredOnly(knex, key, required);
};

exports.down = async function down() {
  // Historical template versions are intentionally retained.
};
