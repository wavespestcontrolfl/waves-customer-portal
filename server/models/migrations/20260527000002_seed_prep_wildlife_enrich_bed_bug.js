/**
 * Seed prep.wildlife template and publish enriched prep.bed_bug version.
 *
 * Uses publishTemplateVersion() to create new active versions while keeping
 * template keys stable.
 */

const SHARED_OPTIONAL = [
  'customer_name',
  'customer_email',
  'customer_phone',
  'customer_portal_url',
  'portal_url',
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
  'support_phone',
  'prep_url',
];

const TEMPLATES = [
  {
    key: 'prep.wildlife',
    name: 'Wildlife Trapping Prep Guide',
    description: 'Prep instructions for wildlife trap setup and monitoring.',
    purpose: 'prep',
    sensitivity: 'health_safety',
    required: ['first_name'],
    optional: ['prep_url', 'project_type', 'service_date', 'property_address', 'technician_name', 'customer_portal_url'],
    subject: 'How to prepare for your Waves wildlife trapping service',
    preview: 'Please review these steps before your Waves trapping service.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves wildlife trapping service is coming up.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'Before we arrive' },
      { type: 'paragraph', content: 'Secure all pets indoors for the duration of the trap monitoring period. Keep dogs leashed when outdoors near trap areas.' },
      { type: 'paragraph', content: 'Do not touch, move, or reset traps once placed. If an animal is caught, call Waves immediately and do not approach the animal.' },
      { type: 'paragraph', content: 'Keep children and pets away from trap placement areas at all times during the monitoring period.' },
      { type: 'callout', content: 'Florida regulations require trap checks at least every 24 hours. Your technician will monitor the traps on schedule. If you notice a caught animal between checks, call us right away.' },
      { type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' },
    ],
    fixture: {
      first_name: 'Taylor',
      prep_url: 'https://portal.wavespestcontrol.com/prep/wildlife',
      project_type: 'Wildlife Trapping',
      service_date: 'June 14',
      property_address: '123 Palm Ave, Bradenton, FL 34211',
    },
  },
  {
    key: 'prep.bed_bug',
    name: 'Bed Bug Prep Guide',
    description: 'Comprehensive prep instructions before a bed bug treatment.',
    purpose: 'prep',
    sensitivity: 'health_safety',
    required: ['first_name'],
    optional: ['prep_url', 'project_type', 'service_date', 'property_address', 'technician_name', 'customer_portal_url'],
    subject: 'Your bed bug treatment prep guide',
    preview: 'Please review these prep steps before your Waves treatment.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, please review these prep steps before your bed bug treatment. Thorough preparation is one of the most important factors in treatment success.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'How to prepare' },
      { type: 'paragraph', content: 'Launder ALL bedding, linens, pillowcases, and clothing from affected rooms in hot water and dry on the highest heat setting for at least 30 minutes. Place cleaned items in sealed plastic bags and keep them sealed until after treatment.' },
      { type: 'paragraph', content: 'Declutter around beds, nightstands, dressers, and closets. Place loose items in sealed bags or bins. Do NOT move items to other rooms — this can spread the infestation to new areas.' },
      { type: 'paragraph', content: 'Vacuum mattresses, box springs, bed frames, headboards, baseboards, furniture seams, and carpet edges thoroughly. Dispose of the vacuum bag or contents in a sealed bag outside immediately after.' },
      { type: 'paragraph', content: 'Pull beds and furniture 12–18 inches away from walls. Remove wall hangings, clocks, and decorations near beds.' },
      { type: 'paragraph', content: 'Secure pets and plan to keep people and animals out of treated areas until the technician confirms it is safe to return.' },
      { type: 'callout', content: 'Your follow-up treatment (typically 14 days after the initial visit) is critical for breaking the egg cycle. Repeat all of these prep steps before the follow-up visit.' },
      { type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' },
    ],
    fixture: {
      first_name: 'Taylor',
      prep_url: 'https://portal.wavespestcontrol.com/prep/bed-bug',
      project_type: 'Bed Bug Treatment',
      service_date: 'June 14',
      property_address: '123 Palm Ave, Bradenton, FL 34211',
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
    purpose: t.purpose || existing.purpose || 'general',
    legal_classification: existing.legal_classification || 'transactional_relationship',
    audience: existing.audience || 'customer',
    message_priority: existing.message_priority || 'normal',
    content_sensitivity: t.sensitivity || existing.content_sensitivity || 'normal',
    send_stream: existing.send_stream || 'service_operational',
    suppression_group_key: existing.suppression_group_key || existing.send_stream || 'service_operational',
    layout_wrapper_id: existing.layout_wrapper_id || 'service_default_v1',
    from_name: existing.from_name || 'Waves Pest Control',
    from_email: existing.from_email || 'contact@wavespestcontrol.com',
    reply_to: existing.reply_to || 'contact@wavespestcontrol.com',
    default_cta_label: existing.default_cta_label || null,
    default_cta_url_variable: existing.default_cta_url_variable || null,
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
