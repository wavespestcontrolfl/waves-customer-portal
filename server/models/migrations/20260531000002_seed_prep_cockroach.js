/**
 * Seed the cockroach prep guide template.
 *
 * Mirrors the canonical prep-guide seed (20260521000004): editable
 * email_templates row + active email_template_versions block content +
 * default fixture. Powers the admin "Send prep guide" action for the
 * cockroach project type (wired via PREP_TEMPLATE_BY_PROJECT_TYPE ->
 * prep.cockroach in server/services/project-email.js). Idempotent.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_VARIABLES = [
  'first_name',
  'customer_name',
  'customer_email',
  'customer_phone',
  'customer_portal_url',
  'portal_invite_url',
  'company_phone',
  'company_email',
  'property_address',
  'project_type',
  'project_title',
  'project_date',
  'service_date',
  'prepared_date',
  'technician_name',
];

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_email: 'stan@example.com',
  customer_phone: '(941) 555-0101',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  portal_invite_url: 'https://portal.wavespestcontrol.com/login',
  project_type: 'Cockroach Treatment',
  project_title: 'Cockroach treatment report',
  project_date: 'May 20, 2026',
  service_date: 'May 20, 2026',
  prepared_date: 'May 20, 2026',
  property_address: '123 Palm Ave, Bradenton, FL 34211',
  technician_name: 'Alex Rivera',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
};

const TEMPLATE = {
  key: 'prep.cockroach',
  name: 'Cockroach Treatment Prep Guide',
  category: 'prep',
  stream: 'service_operational',
  sensitivity: 'service',
  description: 'Prep instructions for cockroach inspection and treatment.',
  required: ['first_name'],
  optional: [
    'customer_name',
    'customer_portal_url',
    'prep_url',
    'project_type',
    'project_title',
    'service_date',
    'property_address',
    'technician_name',
    'company_phone',
    'company_email',
  ],
  subject: 'How to prepare for your Waves cockroach service',
  preview: 'A few steps before your cockroach service.',
  intro: 'Your Waves cockroach service is coming up. A little prep makes the treatment far more effective and helps keep results lasting.',
  steps: [
    'Clear access to under sinks and the inside of lower cabinets in the kitchen and bathrooms so the technician can treat harborage areas, and store food, dishes, and pet bowls away from those areas.',
    'Wipe up crumbs and spills, take out the trash, and remove cardboard, paper bags, and clutter where roaches like to hide. Report or address any moisture issues such as leaks or standing water.',
    'Secure pets before the technician arrives, and after service avoid cleaning or wiping down treated areas like cabinet edges and baseboards so the treatment and any gel bait stay in place.',
  ],
  note: 'Some activity for a short period after treatment is normal as roaches contact the products and feed on bait. German cockroach infestations usually need a follow-up visit, which we will schedule with you.',
};

function blocks(t) {
  return [
    { type: 'paragraph', content: 'Hello {{first_name}},' },
    { type: 'paragraph', content: t.intro },
    { type: 'details', rows: [
      { label: 'Service', value: '{{project_type}}' },
      { label: 'Service date', value: '{{service_date}}' },
      { label: 'Property', value: '{{property_address}}' },
    ] },
    { type: 'heading', content: 'How to prepare' },
    ...t.steps.map((content) => ({ type: 'paragraph', content })),
    { type: 'callout', content: t.note },
    { type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' },
    { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
    { type: 'signature', content: 'Thank you, The Waves Team' },
  ];
}

function templateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...(t.required || []), ...(t.optional || [])])];
  const required = [...new Set(t.required || [])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: 'service',
    purpose: t.category,
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: t.sensitivity || 'service',
    send_stream: t.stream || 'service_operational',
    suppression_group_key: t.stream || 'service_operational',
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
      blocks: JSON.stringify(blocks(t)),
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
      blocks: JSON.stringify(blocks(t)),
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

  await upsertTemplate(knex, TEMPLATE);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates').where({ template_key: TEMPLATE.key }).del();
};

exports.__private = {
  TEMPLATE,
  SHARED_VARIABLES,
  PREVIEW_PAYLOAD,
  templateRow,
  blocks,
};
