/**
 * Service-details packet delivery email template.
 *
 * The estimate page's per-service "email me the full details" button
 * (GATE_SERVICE_DETAILS_PDF) sends the service's details PDF — process,
 * inclusions, and the public product registry (active ingredients, EPA reg
 * numbers, label/SDS links) — as an attachment. Customer-initiated,
 * transactional, delivered only to the email already on the estimate.
 *
 * Mirrors the publish pattern in
 * 20260619000000_estimate_proposal_delivery_email_template.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const TEMPLATE = {
  key: 'estimate.service_details',
  name: 'Estimate Service Details Packet',
  description: 'Customer-requested per-service details PDF (process + products/labels) from the estimate page.',
  purpose: 'estimate',
  audience: 'lead',
  mode: 'service',
  stream: 'service_operational',
  ctaLabel: 'Back to your estimate',
  ctaUrlVariable: 'estimate_url',
  required: ['first_name', 'service_name'],
  optional: ['estimate_url'],
  subject: 'Your {{service_name}} details from Waves',
  preview: 'The full details you asked for — how visits work, products, labels & safety sheets.',
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, here are the full {{service_name}} details you asked for — attached as a PDF.' },
    { type: 'paragraph', content: 'Inside: exactly how your visits work, what’s included, and every product we may use with its active ingredient, EPA registration number, and links to the label and safety data sheet.' },
    { type: 'cta', label: 'Back to your estimate', url_variable: 'estimate_url' },
    { type: 'small_note', content: 'Questions about anything in the packet? Reply to this email or call (941) 297-5749 and you’ll get a straight answer.' },
  ],
  fixture: {
    first_name: 'Taylor',
    service_name: 'Pest Protection',
    estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
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
  await knex('email_templates').where({ template_key: 'estimate.service_details' }).del();
};
