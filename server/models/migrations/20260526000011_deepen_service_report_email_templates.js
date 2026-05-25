/**
 * Deepen service and project report-ready emails.
 *
 * Appointment confirmations/reminders are currently SMS-only. This migration
 * focuses on the customer-facing service email templates that already exist.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_OPTIONAL = [
  'customer_name',
  'customer_email',
  'customer_phone',
  'customer_portal_url',
  'company_phone',
  'company_email',
  'report_url',
  'report_type',
  'service_label',
  'service_date',
  'inspection_date',
  'project_date',
  'property_address',
  'technician_name',
  'finding_summary',
  'application_summary',
  'reentry_summary',
  'pressure_summary',
  'pdf_note',
  'project_type',
  'project_title',
];

const TEMPLATES = [
  {
    key: 'service.report_ready',
    name: 'Service Report Ready',
    description: 'Email sent when a completed service report is ready.',
    purpose: 'report',
    sensitivity: 'property_sensitive',
    required: ['first_name', 'report_url', 'service_label'],
    optional: [
      'service_date',
      'technician_name',
      'property_address',
      'finding_summary',
      'application_summary',
      'reentry_summary',
      'pressure_summary',
      'pdf_note',
      'company_phone',
    ],
    subject: 'Your Waves {{service_label}} report is ready',
    preview: 'Review your completed service summary, findings, recommendations, and advisories.',
    ctaLabel: 'View full report',
    ctaUrlVariable: 'report_url',
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
      { type: 'small_note', content: 'Questions about the report or a recommendation? Reply here or call {{company_phone}}.' },
    ],
    fixture: {
      first_name: 'Taylor',
      report_url: 'https://portal.wavespestcontrol.com/report/sample',
      service_label: 'Residential Pest Control',
      service_date: 'June 8, 2026',
      technician_name: 'Alex',
      property_address: 'Sarasota, FL',
      finding_summary: 'No action-required findings were documented.',
      application_summary: '2 applications documented',
      reentry_summary: 'Exterior treated areas are ready after they are dry.',
      pressure_summary: 'Pest pressure is trending down compared with the last visit.',
      pdf_note: 'Your PDF service report is attached.',
      company_phone: '(941) 555-0100',
    },
  },
  {
    key: 'project.report_ready',
    name: 'Project Report Ready',
    description: 'Email sent when an inspection or specialty project report is posted.',
    purpose: 'report',
    sensitivity: 'property_sensitive',
    required: ['first_name', 'report_url', 'report_type'],
    optional: [
      'inspection_date',
      'project_date',
      'project_type',
      'project_title',
      'property_address',
      'technician_name',
      'company_phone',
    ],
    subject: 'Your Waves {{report_type}} report is ready',
    preview: 'Your specialty report is posted with the visit summary, findings, photos, and recommendations.',
    ctaLabel: 'View report',
    ctaUrlVariable: 'report_url',
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
      report_url: 'https://portal.wavespestcontrol.com/report/project/sample',
      report_type: 'Rodent Exclusion',
      project_title: 'Rodent exclusion report',
      inspection_date: 'June 8, 2026',
      project_date: 'June 8, 2026',
      property_address: '13649 Luxe Ave, Bradenton, FL 34211',
      technician_name: 'Alex',
      company_phone: '(941) 555-0100',
    },
  },
];

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
