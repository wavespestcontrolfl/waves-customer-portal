const TEMPLATES = [
  {
    template_key: 'marketing.pest_products_safety',
    name: 'Pest Control Products & Safety Guide',
    category: 'marketing',
    document_type: 'customer_guide',
    description: 'Bulk-send customer guide focused on pest control product safety, effectiveness, and transparency.',
    tags: ['marketing', 'products', 'pest_control', 'safety', 'effectiveness'],
    requires_signature: false,
    default_delivery_channel: 'both',
    reminder_schedule_days: [],
    expire_after_days: 14,
    title: 'Waves Pest Control Products & Safety Guide',
    body: [
      'Waves Pest Control Products & Safety Guide',
      '',
      'Prepared for: {{customer.name}}',
      'Property: {{customer.address}}',
      '',
      'What customers usually want to know',
      '',
      'Most customers ask two practical questions: is the treatment appropriate for my home, and will it work? Waves answers those questions by matching products and methods to the pest, the property, the treatment zone, season, access conditions, and any household safety notes you share with us.',
      '',
      'Safety standards',
      '',
      '- Products are applied by trained technicians according to label directions.',
      '- Treatments are targeted to the areas where pests live, travel, enter, or hide.',
      '- People and pets are kept away from treated surfaces until the product-specific re-entry guidance is met.',
      '- Special conditions such as pets, children, aquariums, allergies, medical sensitivities, gardens, or access limitations should be shared before service.',
      '- Your service report documents what was applied and where it was used.',
      '',
      'Effectiveness expectations',
      '',
      'Pest control is not always instant. Some products work when pests contact treated surfaces, return to nesting areas, or interact with bait placements. Activity can continue for a short period after service, especially when pressure is high, pests are hidden, or weather and moisture are changing. Follow-up timing depends on the pest and the treatment plan.',
      '',
      'How Waves chooses the right solution',
      '',
      '- Exterior perimeter applications help reduce pests before they move indoors.',
      '- Crack-and-crevice and spot treatments focus on active indoor areas without broad unnecessary application.',
      '- Baits, monitors, exclusion, sanitation guidance, and follow-up visits may be used when they fit the pest biology better than a routine spray.',
      '- Specialty issues such as rodents, termites, mosquitoes, fleas, bed bugs, stinging insects, and recurring roach or ant activity may require a specific plan.',
      '',
      'What to expect after service',
      '',
      'Your technician will explain any important post-service instructions. If activity continues after the expected window, contact Waves so we can review the service notes and determine whether monitoring, a follow-up, or an adjustment is appropriate.',
    ].join('\n'),
    variables: ['customer.name', 'customer.address'],
  },
  {
    template_key: 'marketing.lawn_products_safety',
    name: 'Lawn Care Products & Safety Guide',
    category: 'marketing',
    document_type: 'customer_guide',
    description: 'Bulk-send customer guide focused on lawn care product safety, effectiveness, and treatment expectations.',
    tags: ['marketing', 'products', 'lawn_care', 'safety', 'effectiveness'],
    requires_signature: false,
    default_delivery_channel: 'both',
    reminder_schedule_days: [],
    expire_after_days: 14,
    title: 'Waves Lawn Care Products & Safety Guide',
    body: [
      'Waves Lawn Care Products & Safety Guide',
      '',
      'Prepared for: {{customer.name}}',
      'Property: {{customer.address}}',
      '',
      'A practical guide to lawn treatments',
      '',
      'Lawn care works best when product selection is tied to turf type, season, weed pressure, insect pressure, fungus pressure, irrigation, mowing, soil conditions, and local rules. Waves documents these conditions so each visit builds on the last one instead of treating the lawn as a one-time snapshot.',
      '',
      'Safety standards',
      '',
      '- Products are selected and applied according to label directions and local restrictions.',
      '- Application timing considers weather, heat, rain, irrigation, and turf stress.',
      '- People and pets should stay off treated areas until the product-specific re-entry guidance is met.',
      '- Tell us about pets, children, edible gardens, allergies, wells, ponds, drainage concerns, or access limitations before service.',
      '- Product use and treatment areas are documented in the service report.',
      '',
      'Effectiveness expectations',
      '',
      'Lawn results are gradual. Weed control, fungus suppression, insect management, color response, and turf recovery can take time and depend heavily on watering, mowing height, heat, rainfall, shade, disease pressure, and the condition of the lawn before treatment. Some problems need multiple visits or seasonal timing to improve.',
      '',
      'How Waves chooses the right solution',
      '',
      '- Weed controls are matched to weed type, turf tolerance, weather, and label limits.',
      '- Fungicide and insecticide choices depend on signs observed in the lawn and seasonal risk.',
      '- Fertility and soil-support products are used to support turf density, recovery, and color when conditions allow.',
      '- Irrigation and mowing guidance may be as important as the product itself.',
      '',
      'What to expect after service',
      '',
      'Your technician will leave service notes with product and watering guidance when relevant. If the lawn changes after service, send photos or reply to the message that sent this guide so Waves can compare the issue to the documented treatment plan.',
    ].join('\n'),
    variables: ['customer.name', 'customer.address'],
  },
];

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

async function upsertTemplate(knex, seed) {
  const info = await knex('document_templates').columnInfo().catch(() => ({}));
  const basePayload = {
    name: seed.name,
    category: seed.category,
    document_type: seed.document_type,
    status: 'active',
    description: seed.description,
    requires_signature: seed.requires_signature,
    audience: 'customer',
    variables: json(seed.variables),
    tags: json(seed.tags),
  };
  if (info.default_delivery_channel) basePayload.default_delivery_channel = seed.default_delivery_channel;
  if (info.reminder_schedule_days) basePayload.reminder_schedule_days = json(seed.reminder_schedule_days);
  if (info.expire_after_days) basePayload.expire_after_days = seed.expire_after_days;

  let template = await knex('document_templates').where({ template_key: seed.template_key }).first();
  if (!template) {
    [template] = await knex('document_templates').insert({
      template_key: seed.template_key,
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
  if (!version || version.title !== seed.title || version.body !== seed.body) {
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: await nextVersionNumber(knex, template.id),
      title: seed.title,
      body: seed.body,
      signer_disclosure: null,
      variables: json(seed.variables),
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
  if (!(await knex.schema.hasTable('document_templates'))) return;
  if (!(await knex.schema.hasTable('document_template_versions'))) return;
  for (const template of TEMPLATES) {
    await upsertTemplate(knex, template);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('document_templates'))) return;
  await knex('document_templates')
    .whereIn('template_key', TEMPLATES.map((template) => template.template_key))
    .del();
};

exports.__private = { TEMPLATES, upsertTemplate };
