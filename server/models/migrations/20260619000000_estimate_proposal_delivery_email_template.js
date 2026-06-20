/**
 * Commercial proposal delivery email template.
 *
 * Authored commercial proposals (multi-building PDF) are accepted manually —
 * there is no online checkout — so they need delivery copy distinct from the
 * residential `estimate.delivery` template, whose subject/intro/CTA tell the
 * customer to review and accept online. The proposal PDF rides along as an
 * email attachment; this template's CTA points at the proposal details view
 * and the body sets the "your account manager will follow up" expectation.
 *
 * Mirrors the publish pattern in 20260526000008_deepen_quote_estimate_email_templates.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const TEMPLATE = {
  key: 'estimate.proposal_delivery',
  name: 'Commercial Proposal Delivery',
  description: 'Delivery email for an authored commercial proposal (PDF attached, manual acceptance).',
  purpose: 'estimate',
  audience: 'lead',
  mode: 'service',
  stream: 'service_operational',
  ctaLabel: 'View proposal details',
  ctaUrlVariable: 'estimate_url',
  required: ['first_name'],
  optional: ['estimate_url', 'price_summary', 'service_summary', 'property_address', 'next_step_summary'],
  subject: 'Your Waves proposal is ready',
  preview: 'Your formal commercial proposal is attached as a PDF.',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, your formal Waves proposal is attached to this email as a PDF.' },
    {
      type: 'details',
      rows: [
        { label: 'Service', value: '{{service_summary}}' },
        { label: 'Property', value: '{{property_address}}' },
        { label: 'Proposal estimate', value: '{{price_summary}}' },
      ],
    },
    { type: 'paragraph', content: '{{next_step_summary}}' },
    { type: 'cta', label: 'View proposal details', url_variable: 'estimate_url' },
    { type: 'small_note', content: 'Questions? Reply to this email or call (941) 297-5749 and our team will help.' },
  ],
  fixture: {
    first_name: 'Taylor',
    estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
    price_summary: '$2,361/mo · $28,332/yr',
    service_summary: 'Commercial pest, lawn & mosquito',
    property_address: '100 Beach Rd, Siesta Key, FL 34242',
    next_step_summary: 'There is no online checkout for a commercial bid — your Waves account manager will follow up to answer questions and finalize the agreement.',
  },
};

function json(value) {
  return JSON.stringify(value || (Array.isArray(value) ? [] : {}));
}

function templateRow(t) {
  const allowed = [...(t.required || []), ...(t.optional || [])];
  return {
    template_key: t.key,
    name: t.name || t.key,
    description: t.description || null,
    mode: t.mode || 'service',
    purpose: t.purpose || 'estimate',
    legal_classification: t.legal || 'transactional_relationship',
    audience: t.audience || 'lead',
    message_priority: 'normal',
    content_sensitivity: 'normal',
    send_stream: t.stream || 'service_operational',
    suppression_group_key: t.stream || 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: t.ctaLabel || null,
    default_cta_url_variable: t.ctaUrlVariable || null,
    allowed_variables: json(allowed),
    required_variables: json(t.required || []),
    optional_variables: json(t.optional || []),
    status: 'active',
  };
}

async function publishTemplateVersion(knex, t) {
  let template = await knex('email_templates').where({ template_key: t.key }).first();
  const row = templateRow(t);

  if (!template) {
    [template] = await knex('email_templates').insert(row).returning('*');
  } else {
    await knex('email_templates').where({ id: template.id }).update({
      allowed_variables: row.allowed_variables,
      required_variables: row.required_variables,
      optional_variables: row.optional_variables,
      default_cta_label: row.default_cta_label,
      default_cta_url_variable: row.default_cta_url_variable,
      status: 'active',
      updated_at: new Date(),
    });
    template = await knex('email_templates').where({ id: template.id }).first();
  }

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const versionNumber = (latest?.version_number || 0) + 1;

  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: versionNumber,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: json(t.blocks || []),
    text_body: null,
    validation_snapshot: json({
      ok: true,
      referenced_variables: [...(t.required || []), ...(t.optional || [])].sort(),
      disallowed_variables: [],
      missing_required_in_template: [],
    }),
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
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      payload: json(t.fixture || {}),
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload: json(t.fixture || {}),
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

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('email_templates');
  if (!hasTable) return;
  await knex('email_templates').where({ template_key: 'estimate.proposal_delivery' }).del();
};
