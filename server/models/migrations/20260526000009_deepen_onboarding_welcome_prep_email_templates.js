/**
 * Deepen onboarding, welcome, and prep guide emails.
 *
 * Publishes new active template versions while keeping template keys stable.
 * Required variables stay narrow; richer context is optional so existing send
 * paths continue to work.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

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
  'setup_steps',
  'next_step_summary',
  'plan_name',
  'prep_url',
];

const TEMPLATES = [
  {
    key: 'onboarding.24h_reminder',
    name: 'Onboarding 24h Reminder',
    description: 'Reminder for customers who accepted an estimate but have not finished setup.',
    purpose: 'onboarding',
    required: ['first_name', 'onboarding_url'],
    optional: ['plan_name', 'setup_steps', 'next_step_summary', 'support_phone'],
    subject: 'Finish setting up your Waves service',
    preview: 'A few details are still needed before we can finalize your first service.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, thanks again for choosing Waves.' },
      { type: 'paragraph', content: 'Your service setup is almost finished. We still need a few details before we can finalize your first visit and make sure the right instructions are on file.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{plan_name}}' },
        { label: 'Setup items', value: '{{setup_steps}}' },
      ] },
      { type: 'paragraph', content: '{{next_step_summary}}' },
      { type: 'cta', label: 'Finish setup', url_variable: 'onboarding_url' },
      { type: 'small_note', content: 'Questions or changes? Reply here and our team will help before your first service is confirmed.' },
    ],
    fixture: {
      first_name: 'Taylor',
      onboarding_url: 'https://portal.wavespestcontrol.com/onboard/sample',
      plan_name: 'WaveGuard Gold',
      setup_steps: 'Payment method, service preferences, property details',
      next_step_summary: 'Most customers finish setup in about two minutes.',
      support_phone: '(941) 555-0100',
    },
  },
  {
    key: 'onboarding.72h_reminder',
    name: 'Onboarding 72h Reminder',
    description: 'Second setup reminder for customers who have not completed onboarding.',
    purpose: 'onboarding',
    required: ['first_name', 'onboarding_url'],
    optional: ['plan_name', 'setup_steps', 'next_step_summary', 'support_phone'],
    subject: 'Still here when you are ready',
    preview: 'Finish setup when you are ready and we will confirm your first service.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves setup is still open.' },
      { type: 'paragraph', content: 'Once it is complete, we can keep your first service moving and make sure your property notes, contact preferences, and payment details are correct.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{plan_name}}' },
        { label: 'Remaining setup', value: '{{setup_steps}}' },
      ] },
      { type: 'paragraph', content: '{{next_step_summary}}' },
      { type: 'cta', label: 'Finish setup', url_variable: 'onboarding_url' },
      { type: 'small_note', content: 'If anything is holding you up, reply here. We can answer questions or update the setup details for you.' },
    ],
    fixture: {
      first_name: 'Taylor',
      onboarding_url: 'https://portal.wavespestcontrol.com/onboard/sample',
      plan_name: 'WaveGuard Gold',
      setup_steps: 'Payment method and property details',
      next_step_summary: 'No rush, but finishing setup helps us confirm your first service accurately.',
      support_phone: '(941) 555-0100',
    },
  },
  {
    key: 'onboarding.expiring_notice',
    name: 'Onboarding Link Expiring',
    description: 'Account-state notice before an onboarding link expires.',
    purpose: 'onboarding',
    required: ['first_name', 'onboarding_url', 'expires_at'],
    optional: ['plan_name', 'setup_steps', 'next_step_summary', 'support_phone'],
    subject: 'Your Waves setup link expires {{expires_at}}',
    preview: 'Finish setup before the link expires so we can confirm service.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves setup link expires {{expires_at}}.' },
      { type: 'paragraph', content: 'Finishing setup keeps your service details, plan, and first-visit information moving without needing a new link.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{plan_name}}' },
        { label: 'Remaining setup', value: '{{setup_steps}}' },
      ] },
      { type: 'paragraph', content: '{{next_step_summary}}' },
      { type: 'cta', label: 'Finish setup', url_variable: 'onboarding_url' },
      { type: 'small_note', content: 'Need more time? Reply here before the link expires and we will help.' },
    ],
    fixture: {
      first_name: 'Taylor',
      onboarding_url: 'https://portal.wavespestcontrol.com/onboard/sample',
      expires_at: 'June 12',
      plan_name: 'WaveGuard Gold',
      setup_steps: 'Payment method and property details',
      next_step_summary: 'Complete the remaining details from the link below.',
      support_phone: '(941) 555-0100',
    },
  },
  {
    key: 'welcome.new_recurring',
    name: 'New Recurring Customer Welcome',
    description: 'Welcome and first-service expectations for a new recurring customer.',
    purpose: 'onboarding',
    required: ['first_name'],
    optional: ['portal_url', 'plan_name', 'service_date', 'property_address', 'support_phone'],
    subject: 'Welcome to Waves, {{first_name}}',
    preview: 'What to expect from your first recurring service visit.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, welcome to Waves. We are glad to have you on our route.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{plan_name}}' },
        { label: 'First service', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'paragraph', content: 'On the first recurring visit, your technician will inspect the property, treat the service areas, and note anything that needs attention on future visits.' },
      { type: 'paragraph', content: 'After service, you can review reports, upcoming visits, invoices, and account details in the customer portal.' },
      { type: 'cta', label: 'Open portal', url_variable: 'portal_url' },
      { type: 'small_note', content: 'Between services, reply to a Waves message if you need help or notice new activity.' },
    ],
    fixture: {
      first_name: 'Taylor',
      portal_url: 'https://portal.wavespestcontrol.com',
      plan_name: 'WaveGuard Gold',
      service_date: 'June 14',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      support_phone: '(941) 555-0100',
    },
  },
  {
    key: 'prep.bed_bug',
    name: 'Bed Bug Prep Guide',
    description: 'Service prep instructions before a bed bug treatment.',
    purpose: 'prep',
    sensitivity: 'health_safety',
    required: ['first_name'],
    optional: ['prep_url', 'project_type', 'service_date', 'property_address', 'technician_name', 'customer_portal_url'],
    subject: 'Your bed bug treatment prep guide',
    preview: 'Please review these prep steps before your Waves treatment.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, please review these prep steps before your bed bug treatment.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'Before we arrive' },
      { type: 'paragraph', content: 'Remove bedding from treated beds, bag washable items, and wash/dry on high heat when possible.' },
      { type: 'paragraph', content: 'Clear access around beds, baseboards, furniture edges, closets, and rooms where activity has been noticed.' },
      { type: 'paragraph', content: 'Keep people and pets out of treatment areas until your technician says they are ready.' },
      { type: 'callout', content: 'Prep matters for this service. If you cannot complete a step, reply before the visit so we can plan around it.' },
      { type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' },
    ],
    fixture: { first_name: 'Taylor', prep_url: 'https://portal.wavespestcontrol.com/prep/bed-bug', project_type: 'Bed Bug Treatment', service_date: 'June 14', property_address: '123 Palm Ave' },
  },
  {
    key: 'prep.cockroach',
    name: 'Cockroach Prep Guide',
    description: 'Service prep instructions before a cockroach treatment.',
    purpose: 'prep',
    sensitivity: 'health_safety',
    required: ['first_name'],
    optional: ['prep_url', 'project_type', 'service_date', 'property_address', 'technician_name', 'customer_portal_url'],
    subject: 'Your cockroach treatment prep guide',
    preview: 'Please review these prep steps before your Waves treatment.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, please review these prep steps before your cockroach treatment.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'Before we arrive' },
      { type: 'paragraph', content: 'Clear access under sinks, around appliances, pantry edges, bathrooms, and any areas where activity has been seen.' },
      { type: 'paragraph', content: 'Store food, dishes, toothbrushes, pet bowls, and small personal items away from treatment areas.' },
      { type: 'paragraph', content: 'Avoid store-bought sprays before or between visits unless your technician recommends one. They can scatter activity.' },
      { type: 'callout', content: 'Reply with the rooms or cabinets where activity is worst so the technician can prioritize those areas.' },
      { type: 'cta', label: 'Open prep guide', url_variable: 'prep_url' },
    ],
    fixture: { first_name: 'Taylor', prep_url: 'https://portal.wavespestcontrol.com/prep/cockroach', project_type: 'Cockroach Treatment', service_date: 'June 14', property_address: '123 Palm Ave' },
  },
  {
    key: 'prep.rodent',
    name: 'Rodent Service Prep Guide',
    description: 'Prep instructions for rodent inspection, trapping, and exclusion work.',
    purpose: 'prep',
    required: ['first_name'],
    optional: ['customer_portal_url', 'project_type', 'service_date', 'property_address', 'technician_name'],
    subject: 'How to prepare for your Waves rodent service',
    preview: 'A few steps before your rodent service.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves rodent service is coming up.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'How to prepare' },
      { type: 'paragraph', content: 'Clear access to attics, garages, crawlspaces, utility closets, and exterior perimeter areas where activity has been noticed.' },
      { type: 'paragraph', content: 'Store loose food, pet food, bird seed, and trash in sealed containers so new activity is easier to identify.' },
      { type: 'paragraph', content: 'Keep pets secured during the visit and do not move traps or monitoring devices unless your technician asks you to.' },
      { type: 'callout', content: 'If you hear active movement inside a wall or attic before we arrive, reply with the location so the technician can prioritize that area.' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'customer_portal_url' },
    ],
    fixture: { first_name: 'Taylor', customer_portal_url: 'https://portal.wavespestcontrol.com/login', project_type: 'Rodent Exclusion', service_date: 'June 14', property_address: '123 Palm Ave' },
  },
  {
    key: 'prep.flea',
    name: 'Flea Treatment Prep Guide',
    description: 'Prep instructions for interior and exterior flea treatments.',
    purpose: 'prep',
    required: ['first_name'],
    optional: ['customer_portal_url', 'project_type', 'service_date', 'property_address', 'technician_name'],
    subject: 'How to prepare for your Waves flea treatment',
    preview: 'Prep steps for your upcoming flea treatment.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves flea treatment is scheduled.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'How to prepare' },
      { type: 'paragraph', content: 'Vacuum carpets, rugs, furniture edges, pet resting areas, and cracks along baseboards before service. Dispose of the vacuum contents outside.' },
      { type: 'paragraph', content: 'Wash pet bedding, blankets, and washable throws on a hot cycle before service when possible.' },
      { type: 'paragraph', content: 'Coordinate pet flea control with your veterinarian and keep people and pets off treated areas until they are dry.' },
      { type: 'callout', content: 'Flea activity can continue briefly after treatment as immature fleas emerge. Continued vacuuming after service helps break the cycle.' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'customer_portal_url' },
    ],
    fixture: { first_name: 'Taylor', customer_portal_url: 'https://portal.wavespestcontrol.com/login', project_type: 'Flea Treatment', service_date: 'June 14', property_address: '123 Palm Ave' },
  },
  {
    key: 'prep.mosquito',
    name: 'Mosquito Service Prep Guide',
    description: 'Prep instructions for mosquito reduction services.',
    purpose: 'prep',
    required: ['first_name'],
    optional: ['customer_portal_url', 'project_type', 'service_date', 'property_address', 'technician_name'],
    subject: 'How to prepare for your Waves mosquito service',
    preview: 'Prep steps for your mosquito service.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves mosquito service is coming up.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'How to prepare' },
      { type: 'paragraph', content: 'Unlock gates and make sure the technician can access the yard, lanai, shrubs, shaded areas, and water-prone spots.' },
      { type: 'paragraph', content: 'Empty standing water from buckets, toys, plant saucers, tarps, bird baths, and other small containers before service.' },
      { type: 'paragraph', content: 'Bring pet bowls, toys, and small outdoor items inside or move them away from treatment areas.' },
      { type: 'callout', content: 'If you have a pond, fountain, pool issue, or drainage concern, reply with details before the visit.' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'customer_portal_url' },
    ],
    fixture: { first_name: 'Taylor', customer_portal_url: 'https://portal.wavespestcontrol.com/login', project_type: 'Mosquito Service', service_date: 'June 14', property_address: '123 Palm Ave' },
  },
  {
    key: 'prep.lawn',
    name: 'Lawn Treatment Prep Guide',
    description: 'Prep instructions for lawn fertilization, weed, and turf treatments.',
    purpose: 'prep',
    required: ['first_name'],
    optional: ['customer_portal_url', 'project_type', 'service_date', 'property_address', 'technician_name'],
    subject: 'How to prepare for your Waves lawn treatment',
    preview: 'Prep steps for your lawn treatment.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves lawn treatment is coming up.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'How to prepare' },
      { type: 'paragraph', content: 'If mowing is due, mow at least 24 hours before service when possible. Avoid mowing immediately after treatment unless your technician gives different instructions.' },
      { type: 'paragraph', content: 'Unlock gates and move toys, hoses, furniture, and pet waste from the lawn before the visit.' },
      { type: 'paragraph', content: 'Keep irrigation off before and after treatment unless your technician leaves different watering instructions.' },
      { type: 'callout', content: 'After service, follow any watering or dry-time instructions left by the technician for that specific treatment.' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'customer_portal_url' },
    ],
    fixture: { first_name: 'Taylor', customer_portal_url: 'https://portal.wavespestcontrol.com/login', project_type: 'Lawn Treatment', service_date: 'June 14', property_address: '123 Palm Ave' },
  },
  {
    key: 'prep.termite',
    name: 'Termite Treatment Prep Guide',
    description: 'Prep instructions for termite treatment and pre-treatment projects.',
    purpose: 'prep',
    required: ['first_name'],
    optional: ['customer_portal_url', 'project_type', 'service_date', 'property_address', 'technician_name'],
    subject: 'How to prepare for your Waves termite treatment',
    preview: 'Prep steps for termite treatment access.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves termite treatment is coming up.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'How to prepare' },
      { type: 'paragraph', content: 'Move stored items away from walls, garage edges, attic access, crawlspace access, or treatment areas listed by the technician.' },
      { type: 'paragraph', content: 'Unlock gates, garages, utility rooms, or other areas needed for the treatment.' },
      { type: 'paragraph', content: 'Keep people and pets away from active treatment areas until the technician confirms it is safe to return.' },
      { type: 'callout', content: 'For construction or pre-treatment work, please make sure the site is accessible and ready for the treatment stage scheduled.' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'customer_portal_url' },
    ],
    fixture: { first_name: 'Taylor', customer_portal_url: 'https://portal.wavespestcontrol.com/login', project_type: 'Termite Treatment', service_date: 'June 14', property_address: '123 Palm Ave' },
  },
  {
    key: 'prep.interior_pest',
    name: 'Interior Pest Treatment Prep Guide',
    description: 'Prep instructions for general interior pest treatments.',
    purpose: 'prep',
    required: ['first_name'],
    optional: ['customer_portal_url', 'project_type', 'service_date', 'property_address', 'technician_name'],
    subject: 'How to prepare for your Waves interior pest treatment',
    preview: 'Prep steps for interior pest treatment.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves interior pest treatment is scheduled.' },
      { type: 'details', rows: [
        { label: 'Service', value: '{{project_type}}' },
        { label: 'Service date', value: '{{service_date}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'heading', content: 'How to prepare' },
      { type: 'paragraph', content: 'Clear access to baseboards, sinks, cabinets, pantry edges, bathrooms, garages, and any rooms where pest activity has been seen.' },
      { type: 'paragraph', content: 'Store food, dishes, utensils, toothbrushes, pet bowls, and small personal items away from treatment areas.' },
      { type: 'paragraph', content: 'Secure pets before the technician arrives and stay out of treated areas until they are dry or the technician says they are ready.' },
      { type: 'callout', content: 'If activity is concentrated in a specific room, reply with that location so we can prioritize it during the visit.' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'customer_portal_url' },
    ],
    fixture: { first_name: 'Taylor', customer_portal_url: 'https://portal.wavespestcontrol.com/login', project_type: 'Interior Pest Treatment', service_date: 'June 14', property_address: '123 Palm Ave' },
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
    from_email: existing.from_email || SERVICE_FROM,
    reply_to: existing.reply_to || SERVICE_FROM,
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
