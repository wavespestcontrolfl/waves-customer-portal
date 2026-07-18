/**
 * Invoice-first email for the WDO report payment hold ("pay before you get
 * the report"). The gated send delivers the invoice PDF + pay link ONLY —
 * no report link, no FDACS attachment — and tells the customer the report
 * is emailed automatically the moment the invoice is paid. The combined
 * project.report_with_invoice template can't be reused here because its
 * body and CTA are built around report_url, which a held send must never
 * carry.
 *
 * Mirrors the seeding pattern in
 * 20260529000002_project_report_with_invoice_email_template.js.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_OPTIONAL = [
  'customer_name',
  'customer_email',
  'customer_phone',
  'customer_portal_url',
  'company_phone',
  'company_email',
  'report_type',
  'inspection_date',
  'project_date',
  'property_address',
  'technician_name',
  'project_type',
  'project_title',
];

const TEMPLATE = {
  key: 'project.invoice_before_report',
  name: 'Project Invoice — Report Held Until Paid',
  description: 'Invoice + pay link for an inspection whose report is delivered automatically once the invoice is paid.',
  purpose: 'billing',
  sensitivity: 'property_sensitive',
  required: ['first_name', 'report_type', 'pay_url'],
  optional: [
    'inspection_date',
    'project_date',
    'project_type',
    'project_title',
    'property_address',
    'technician_name',
    'company_phone',
    'pay_url',
    'invoice_url',
    'invoice_number',
    'amount_due',
  ],
  subject: 'Your Waves {{report_type}} is complete — invoice {{invoice_number}}',
  preview: 'Pay your invoice online and your report is emailed to you automatically.',
  ctaLabel: 'Pay invoice',
  ctaUrlVariable: 'pay_url',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, your Waves {{report_type}} is complete and your invoice is ready. Your invoice PDF is attached to this email.' },
    { type: 'paragraph', content: 'As soon as your invoice is paid, your official report is emailed to you automatically — no extra steps needed.' },
    { type: 'details', rows: [
      { label: 'Project', value: '{{project_title}}' },
      { label: 'Report type', value: '{{report_type}}' },
      { label: 'Date', value: '{{inspection_date}}' },
      { label: 'Property', value: '{{property_address}}' },
      { label: 'Invoice', value: '{{invoice_number}}' },
      { label: 'Amount due', value: '{{amount_due}}' },
    ] },
    { type: 'cta', label: 'Pay invoice {{amount_due}}', url_variable: 'pay_url' },
    { type: 'small_note', content: 'Questions about your invoice or report? Reply here or call {{company_phone}}.' },
  ],
  fixture: {
    first_name: 'Taylor',
    report_type: 'WDO Inspection',
    project_title: 'WDO inspection report',
    inspection_date: 'June 8, 2026',
    project_date: 'June 8, 2026',
    property_address: '13649 Luxe Ave, Bradenton, FL 34211',
    technician_name: 'Alex',
    company_phone: '(941) 555-0100',
    pay_url: 'https://portal.wavespestcontrol.com/pay/sample',
    invoice_number: 'WPC-2026-0001',
    amount_due: '$250.00',
  },
};

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
    purpose: t.purpose || existing.purpose || 'report',
    legal_classification: existing.legal_classification || 'transactional_relationship',
    audience: existing.audience || 'customer',
    message_priority: existing.message_priority || 'normal',
    content_sensitivity: t.sensitivity || existing.content_sensitivity || 'property_sensitive',
    send_stream: existing.send_stream || 'service_operational',
    suppression_group_key: existing.suppression_group_key || 'service_operational',
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
    await knex('email_templates').where({ id: template.id }).update({ ...row, updated_at: new Date() });
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
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({ payload, updated_at: new Date() });
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
  await publishTemplateVersion(knex, TEMPLATE);
};

exports.down = async function down() {
  // Historical template versions are intentionally retained.
};
