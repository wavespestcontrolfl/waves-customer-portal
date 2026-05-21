/**
 * Seed editable prep guide and portal invite templates.
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
  project_type: 'Rodent Exclusion',
  project_title: 'Rodent exclusion report',
  project_date: 'May 20, 2026',
  service_date: 'May 20, 2026',
  prepared_date: 'May 20, 2026',
  property_address: '123 Palm Ave, Bradenton, FL 34211',
  technician_name: 'Alex Rivera',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
};

function prepTemplate({
  key,
  name,
  subject,
  preview,
  description,
  intro,
  steps,
  note,
}) {
  return {
    key,
    name,
    category: 'prep',
    stream: 'service_operational',
    sensitivity: 'service',
    description,
    required: ['first_name'],
    optional: [
      'customer_name',
      'customer_portal_url',
      'project_type',
      'project_title',
      'service_date',
      'property_address',
      'technician_name',
      'company_phone',
      'company_email',
    ],
    subject,
    preview,
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: intro },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'How to prepare' },
      ...steps.map((content) => ({ type: 'paragraph', content })),
      { type: 'callout', content: note },
      { type: 'cta', label: 'Open customer portal', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  };
}

const TEMPLATES = [
  prepTemplate({
    key: 'prep.rodent',
    name: 'Rodent Service Prep Guide',
    subject: 'How to prepare for your Waves rodent service',
    preview: 'A few steps before your rodent service.',
    description: 'Prep instructions for rodent inspection, trapping, and exclusion work.',
    intro: 'Your Waves rodent service is coming up. A little prep helps our technician inspect entry points, place equipment, and complete exclusion work efficiently.',
    steps: [
      'Please clear access to attics, garages, crawlspaces, utility closets, and exterior perimeter areas where activity has been noticed.',
      'Store loose food, pet food, bird seed, and trash in sealed containers so new activity is easier to identify.',
      'Keep pets secured during the visit and do not move traps or monitoring devices unless your technician asks you to.',
    ],
    note: 'If you hear active movement inside a wall or attic before we arrive, reply with the location so the technician can prioritize that area.',
  }),
  prepTemplate({
    key: 'prep.flea',
    name: 'Flea Treatment Prep Guide',
    subject: 'How to prepare for your Waves flea treatment',
    preview: 'Prep steps for your upcoming flea treatment.',
    description: 'Prep instructions for interior and exterior flea treatments.',
    intro: 'Your Waves flea treatment is scheduled. The best results come from treating the home, pets, and activity areas together.',
    steps: [
      'Vacuum carpets, rugs, furniture edges, pet resting areas, and cracks along baseboards before service. Dispose of the vacuum contents outside.',
      'Wash pet bedding, blankets, and washable throws on a hot cycle before service when possible.',
      'Coordinate pet flea control with your veterinarian and keep people and pets off treated areas until they are dry.',
    ],
    note: 'Flea activity can continue briefly after treatment as immature fleas emerge. Continued vacuuming after service helps break the cycle.',
  }),
  prepTemplate({
    key: 'prep.mosquito',
    name: 'Mosquito Service Prep Guide',
    subject: 'How to prepare for your Waves mosquito service',
    preview: 'Prep steps for your mosquito service.',
    description: 'Prep instructions for mosquito reduction services.',
    intro: 'Your Waves mosquito service is coming up. Clearing access and reducing standing water helps the treatment cover the areas mosquitoes use most.',
    steps: [
      'Unlock gates and make sure the technician can access the yard, lanai, shrubs, shaded areas, and water-prone spots.',
      'Empty standing water from buckets, toys, plant saucers, tarps, bird baths, and other small containers before service.',
      'Bring pet bowls, toys, and small outdoor items inside or move them away from treatment areas.',
    ],
    note: 'If you have a pond, fountain, pool issue, or drainage concern, reply with details before the visit.',
  }),
  prepTemplate({
    key: 'prep.lawn',
    name: 'Lawn Treatment Prep Guide',
    subject: 'How to prepare for your Waves lawn treatment',
    preview: 'Prep steps for your lawn treatment.',
    description: 'Prep instructions for lawn fertilization, weed, and turf treatments.',
    intro: 'Your Waves lawn treatment is coming up. These steps help the technician treat the turf evenly and avoid delays.',
    steps: [
      'If mowing is due, mow at least 24 hours before service when possible. Avoid mowing immediately after treatment unless your technician gives different instructions.',
      'Unlock gates and move toys, hoses, furniture, and pet waste from the lawn before the visit.',
      'Keep irrigation off before and after treatment unless your technician leaves different watering instructions.',
    ],
    note: 'After service, follow any watering or dry-time instructions left by the technician for that specific treatment.',
  }),
  prepTemplate({
    key: 'prep.termite',
    name: 'Termite Treatment Prep Guide',
    subject: 'How to prepare for your Waves termite treatment',
    preview: 'Prep steps for termite treatment access.',
    description: 'Prep instructions for termite treatment and pre-treatment projects.',
    intro: 'Your Waves termite treatment is coming up. Clear access helps our team inspect and treat the required areas safely.',
    steps: [
      'Move stored items away from walls, garage edges, attic access, crawlspace access, or treatment areas listed by the technician.',
      'Unlock gates, garages, utility rooms, or other areas needed for the treatment.',
      'Keep people and pets away from active treatment areas until the technician confirms it is safe to return.',
    ],
    note: 'For construction or pre-treatment work, please make sure the site is accessible and ready for the treatment stage scheduled.',
  }),
  prepTemplate({
    key: 'prep.interior_pest',
    name: 'Interior Pest Treatment Prep Guide',
    subject: 'How to prepare for your Waves interior pest treatment',
    preview: 'Prep steps for interior pest treatment.',
    description: 'Prep instructions for general interior pest treatments.',
    intro: 'Your Waves interior pest treatment is scheduled. These steps help the technician treat the right areas while protecting household items.',
    steps: [
      'Clear access to baseboards, sinks, cabinets, pantry edges, bathrooms, garages, and any rooms where pest activity has been seen.',
      'Store food, dishes, utensils, toothbrushes, pet bowls, and small personal items away from treatment areas.',
      'Secure pets before the technician arrives and stay out of treated areas until they are dry or the technician says they are ready.',
    ],
    note: 'If activity is concentrated in a specific room, reply with that location so we can prioritize it during the visit.',
  }),
  {
    key: 'portal.invite',
    name: 'Customer Portal Invite',
    category: 'account',
    stream: 'transactional_required',
    sensitivity: 'account',
    description: 'Invitation to access the Waves customer portal from a project or account workflow.',
    required: ['first_name', 'portal_invite_url'],
    optional: [
      'customer_name',
      'customer_email',
      'customer_phone',
      'customer_portal_url',
      'property_address',
      'company_phone',
      'company_email',
    ],
    subject: 'Access your Waves customer portal',
    preview: 'Use your Waves customer portal for reports, services, invoices, and account settings.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'You can use your Waves customer portal to view upcoming services, service reports, invoices, prep instructions, and account settings.' },
      { type: 'details', rows: [
        { label: 'Customer', value: '{{customer_name}}' },
        { label: 'Email', value: '{{customer_email}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'cta', label: 'Open customer portal', url_variable: 'portal_invite_url' },
      { type: 'small_note', content: 'If you did not request portal access, reply to this email and our team will help.' },
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
    purpose: t.category,
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: t.sensitivity || 'service',
    send_stream: t.stream || 'service_operational',
    suppression_group_key: t.stream || 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: t.fromEmail || SERVICE_FROM,
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

async function ensureGroup(knex, row) {
  if (!(await knex.schema.hasTable('email_preference_groups'))) return;
  const existing = await knex('email_preference_groups').where({ key: row.key }).first();
  if (existing) {
    await knex('email_preference_groups').where({ key: row.key }).update({ ...row, updated_at: new Date() });
  } else {
    await knex('email_preference_groups').insert({ ...row, created_at: new Date(), updated_at: new Date() });
  }
}

async function ensureGroups(knex) {
  await ensureGroup(knex, {
    key: 'service_operational',
    name: 'Service and scheduling notices',
    description: 'Estimates, appointment prep, reports, onboarding, and service relationship emails.',
    send_stream: 'service_operational',
    user_can_unsubscribe: false,
    sort_order: 20,
  });
  await ensureGroup(knex, {
    key: 'transactional_required',
    name: 'Required account notices',
    description: 'Security, payment, legal, and account notices that must reach the customer.',
    send_stream: 'transactional_required',
    user_can_unsubscribe: false,
    sort_order: 10,
  });
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

  await ensureGroups(knex);
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
