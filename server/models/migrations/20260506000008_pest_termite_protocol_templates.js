exports.up = async function (knex) {
  const hasUsageTable = await knex.schema.hasTable('service_product_usage');
  const hasProductsTable = await knex.schema.hasTable('products_catalog');
  if (!hasUsageTable || !hasProductsTable) return;

  const products = await knex('products_catalog').select('id', 'name');
  const findProduct = (terms) => {
    const needles = Array.isArray(terms) ? terms : [terms];
    return products.find((product) => {
      const name = String(product.name || '').toLowerCase();
      return needles.some((term) => name.includes(String(term).toLowerCase()));
    });
  };

  async function ensureUsage(serviceType, productTerms, data) {
    const product = findProduct(productTerms);
    if (!product) return;

    const existing = await knex('service_product_usage')
      .where({ service_type: serviceType, product_id: product.id })
      .first();
    if (existing) return;

    await knex('service_product_usage').insert({
      service_type: serviceType,
      product_id: product.id,
      ...data,
    });
  }

  await ensureUsage('General Pest Perimeter', ['demand cs', 'talstar p'], {
    usage_amount: 1.6,
    usage_unit: 'oz',
    usage_per_1000sf: 0.4,
    is_primary: true,
    notes: 'Exterior general pest perimeter band; use existing recurring pest pricing logic for customer price.',
  });

  await ensureUsage('Ant Service', ['advion ant', 'advion wdg'], {
    usage_amount: 0.5,
    usage_unit: 'oz',
    is_primary: true,
    notes: 'Trail-focused bait/non-repellent protocol; avoid repellent spray on active trails.',
  });

  await ensureUsage('German Roach Cleanout', ['advion cockroach', 'advion gel'], {
    usage_amount: 1,
    usage_unit: 'tube',
    is_primary: true,
    notes: 'Gel bait placement in hinges, cracks, appliances, and plumbing voids.',
  });

  await ensureUsage('German Roach Cleanout', ['alpine wsg'], {
    usage_amount: 1,
    usage_unit: 'packets',
    is_primary: true,
    notes: 'Non-repellent crack-and-crevice support treatment.',
  });

  await ensureUsage('Liquid Termite Perimeter', ['termidor sc'], {
    usage_amount: 1,
    usage_unit: 'bottle',
    usage_per_1000sf: 0.8,
    is_primary: true,
    notes: 'Liquid perimeter/trench-and-rod COGS proxy; final volume must follow label and diagram.',
  });

  await ensureUsage('Termite Foam Drill', ['termidor foam'], {
    usage_amount: 1,
    usage_unit: 'can',
    is_primary: true,
    notes: 'Localized foam drill or void treatment; not a whole-structure protection proxy.',
  });

  await ensureUsage('Termite Wood Treatment', ['bora-care', 'bora care'], {
    usage_amount: 1,
    usage_unit: 'gal',
    usage_per_1000sf: 3.64,
    is_primary: true,
    notes: 'Bora-Care accessible wood treatment; cost scales by treatable sqft.',
  });

  if (!(await knex.schema.hasTable('equipment_checklists'))) return;

  async function ensureChecklist(serviceLine, serviceType, checklistItems, notes) {
    const existing = await knex('equipment_checklists')
      .where({ service_line: serviceLine, service_type: serviceType })
      .first();
    if (existing) return;

    await knex('equipment_checklists').insert({
      service_line: serviceLine,
      service_type: serviceType,
      checklist_items: JSON.stringify(checklistItems),
      notes,
    });
  }

  await ensureChecklist('termite', 'Termite Inspection / Treatment', [
    { category: 'Inspection', items: [
      { item: 'Flashlight and probe/screwdriver', required: true },
      { item: 'Moisture meter', required: true },
      { item: 'Graph/diagram and photo capture workflow', required: true },
    ] },
    { category: 'Treatment', items: [
      { item: 'Bait station keys and replacement cartridges', required: false },
      { item: 'Foam drill kit and patch materials', required: false },
      { item: 'Liquid termiticide PPE and spill kit', required: false },
    ] },
    { category: 'Compliance', items: [
      { item: 'Product label available', required: true },
      { item: 'Application volume and location notes ready', required: true },
    ] },
  ], 'Use the treatment-specific subset after inspection determines scope.');

  await ensureChecklist('mosquito', 'Mosquito Barrier Treatment', [
    { category: 'Equipment', items: [
      { item: 'Backpack mist blower or sprayer charged/primed', required: true },
      { item: 'Fan/cone nozzle appropriate for foliage', required: true },
      { item: 'Larvicide/IGR for labeled standing-water sites', required: false },
    ] },
    { category: 'Inspection', items: [
      { item: 'Dump standing water', required: true },
      { item: 'Check gutters, planters, drains, and shaded vegetation', required: true },
    ] },
    { category: 'Safety', items: [
      { item: 'Pollinator/blooming plant check', required: true },
      { item: 'Wind/rain condition check', required: true },
    ] },
  ], 'Barrier service should document inaccessible breeding sources.');
};

exports.down = async function (knex) {
  // Intentionally no-op. The up migration is idempotent and may skip rows that
  // already existed; deleting by service type here could remove user-managed
  // protocol rows that this migration did not create.
  void knex;
};
