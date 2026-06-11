const TEMPLATE = {
  template_key: 'marketing.products_solutions',
  name: 'Products & Solutions Guide',
  category: 'marketing',
  document_type: 'customer_guide',
  description: 'Customer-facing guide for Waves product standards, treatment solutions, and safety expectations.',
  tags: ['marketing', 'products', 'solutions', 'safety', 'customer_guide'],
  requires_signature: false,
  default_delivery_channel: 'both',
  reminder_schedule_days: [],
  expire_after_days: 14,
  title: 'Waves Products & Solutions Guide',
  body: [
    'Waves Products & Solutions Guide',
    '',
    'Prepared for: {{customer.name}}',
    'Property: {{customer.address}}',
    '',
    'A cleaner way to understand pest control',
    '',
    'Waves does not believe in one-size-fits-all treatments. Every service starts with what we see at the property: pest activity, entry points, moisture, landscape pressure, season, and safety needs. From there, we choose targeted products and service methods that make sense for that home or business.',
    '',
    'What we solve',
    '',
    '1. Exterior pest pressure',
    'A protective exterior service helps reduce ants, roaches, spiders, silverfish, centipedes, and other common Southwest Florida pests before they move indoors. Treatments focus on foundations, entry points, window and door frames, eaves, garage thresholds, and other pest travel zones.',
    '',
    '2. Interior activity',
    'When pests are already inside, we use targeted crack-and-crevice, void, bait, or spot-treatment methods instead of broad, unnecessary application. The goal is to solve the active issue while keeping treatment focused where pests live, travel, or hide.',
    '',
    '3. Specialty pest problems',
    'Some issues need a specific plan, not a general spray. Fleas, mosquitoes, rodents, termites, bed bugs, stinging insects, and recurring ant or roach activity may require inspection, preparation steps, monitoring, follow-up timing, exclusion, or specialty products.',
    '',
    '4. Lawn and landscape pressure',
    'For lawn, tree, and shrub services, the right solution depends on grass type, weeds, insects, fungus pressure, soil and irrigation conditions, seasonal rules, and local ordinance limits. We document what we see so future visits can track response instead of guessing.',
    '',
    'Representative product standard',
    '',
    'Demand CS is one example of a product Waves may use for exterior perimeter pest pressure. It is an encapsulated perimeter insecticide with lambda-cyhalothrin 9.7% and EPA Reg. #100-1066. It is used by licensed applicators for residual exterior pest control and applied according to label directions.',
    '',
    'Product selection can change based on the pest, the property, application area, label requirements, resistance concerns, weather, and customer-specific safety notes. Your service report or customer portal will show what was actually applied at your property.',
    '',
    'Our product standards',
    '',
    '- EPA-registered products when registration is required.',
    '- Label-compliant rates, methods, and re-entry guidance.',
    '- Targeted applications matched to pest biology and property conditions.',
    '- Licensed technician application and documentation.',
    '- Clear post-service notes so you know what was done and why.',
    '',
    'People and pet guidance',
    '',
    'For most liquid treatments, people and pets should stay away from treated surfaces until dry. Your technician will provide specific guidance based on the product, treatment area, and service conditions. If your household has pets, children, allergies, aquariums, medical sensitivities, or special access needs, tell us before service so we can plan around them.',
    '',
    'What makes the Waves approach different',
    '',
    '- We inspect before we treat.',
    '- We choose products for the situation, not the cheapest routine.',
    '- We document products, target areas, findings, and next steps.',
    '- We support customers after service if activity continues.',
    '- We keep the focus on practical results, safety, and clear communication.',
    '',
    'Next step',
    '',
    'If you want a plan for this property, reply to the message that sent this guide or call Waves. We can review the pest pressure, match the right service, and explain what we would use before anything is applied.',
  ].join('\n'),
  variables: ['customer.name', 'customer.address'],
};

function json(value) {
  return JSON.stringify(value);
}

async function nextVersionNumber(knex, templateId) {
  const row = await knex('document_template_versions')
    .where({ template_id: templateId })
    .max('version_number as max_version')
    .first();
  return Number(row?.max_version || 0) + 1;
}

async function upsertProductsSolutionsTemplate(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  const hasVersions = await knex.schema.hasTable('document_template_versions');
  if (!hasTemplates || !hasVersions) return;

  const info = await knex('document_templates').columnInfo().catch(() => ({}));
  const basePayload = {
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    document_type: TEMPLATE.document_type,
    status: 'active',
    description: TEMPLATE.description,
    requires_signature: TEMPLATE.requires_signature,
    audience: 'customer',
    variables: json(TEMPLATE.variables),
    tags: json(TEMPLATE.tags),
  };
  if (info.default_delivery_channel) basePayload.default_delivery_channel = TEMPLATE.default_delivery_channel;
  if (info.reminder_schedule_days) basePayload.reminder_schedule_days = json(TEMPLATE.reminder_schedule_days);
  if (info.expire_after_days) basePayload.expire_after_days = TEMPLATE.expire_after_days;

  let template = await knex('document_templates').where({ template_key: TEMPLATE.template_key }).first();
  if (!template) {
    [template] = await knex('document_templates').insert({
      template_key: TEMPLATE.template_key,
      ...basePayload,
    }).returning('*');
  } else {
    await knex('document_templates').where({ id: template.id }).update({
      ...basePayload,
      updated_at: knex.fn.now(),
    });
    template = await knex('document_templates').where({ id: template.id }).first();
  }

  const activeVersion = await knex('document_template_versions')
    .where({ id: template.active_version_id })
    .first();
  let version = activeVersion;
  if (!version || version.title !== TEMPLATE.title || version.body !== TEMPLATE.body) {
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: await nextVersionNumber(knex, template.id),
      title: TEMPLATE.title,
      body: TEMPLATE.body,
      signer_disclosure: null,
      variables: json(TEMPLATE.variables),
      required_fields: json([]),
      published_at: knex.fn.now(),
    }).returning('*');
  }

  if (version?.id && template.active_version_id !== version.id) {
    await knex('document_templates').where({ id: template.id }).update({
      active_version_id: version.id,
      status: 'active',
      updated_at: knex.fn.now(),
    });
  }
}

exports.up = async function up(knex) {
  await upsertProductsSolutionsTemplate(knex);
};

exports.down = async function down(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  if (!hasTemplates) return;
  await knex('document_templates').where({ template_key: TEMPLATE.template_key }).del();
};

exports.__private = { TEMPLATE, upsertProductsSolutionsTemplate };
