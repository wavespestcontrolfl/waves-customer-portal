const INITIAL_ROACH = {
  regular: [
    { sqft: 1500, price: 119 },
    { sqft: 2501, price: 139 },
    { sqft: null, price: 169 },
  ],
  german: [
    { sqft: 1500, price: 169 },
    { sqft: 2501, price: 199 },
    { sqft: null, price: 249 },
  ],
  regular_standalone: [
    { sqft: 1500, price: 202.50 },
    { sqft: 2501, price: 239 },
    { sqft: null, price: 289 },
  ],
};

async function upsertConfig(knex, configKey, name, category, sortOrder, data, description = null) {
  const existing = await knex('pricing_config').where({ config_key: configKey }).first('id', 'data');
  const payload = {
    name,
    category,
    sort_order: sortOrder,
    data: JSON.stringify(data),
    description,
    updated_at: knex.fn.now(),
  };
  if (existing) {
    await knex('pricing_config').where({ config_key: configKey }).update(payload);
  } else {
    await knex('pricing_config').insert({
      config_key: configKey,
      ...payload,
      created_at: knex.fn.now(),
    });
  }
  return existing;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const pestBase = await knex('pricing_config').where({ config_key: 'pest_base' }).first('data');
  let baseData = { base: 117, floor: 89 };
  if (pestBase?.data) {
    baseData = typeof pestBase.data === 'string' ? JSON.parse(pestBase.data) : pestBase.data;
  }
  await upsertConfig(
    knex,
    'pest_base',
    'Pest Control Base Price',
    'pest',
    1,
    { ...baseData, initial_roach: INITIAL_ROACH },
    'Base/floor pricing plus Initial Roach Knockdown bracket pricing.'
  );

  await upsertConfig(
    knex,
    'pest_roach',
    'Pest Roach Modifier Status',
    'pest',
    6,
    {
      german: 0,
      regular: 0,
      none: 0,
      retired: true,
      replacement: 'pest_base.initial_roach',
      note: 'Recurring roach percentage modifiers are retired. Recurring pest with regular/German roach auto-adds a fixed pest_initial_roach first-visit fee.',
    },
    'Retired recurring roach percentage modifiers; kept as zeroed metadata for admin visibility.'
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const pestBase = await knex('pricing_config').where({ config_key: 'pest_base' }).first('data');
  if (pestBase?.data) {
    const baseData = typeof pestBase.data === 'string' ? JSON.parse(pestBase.data) : pestBase.data;
    delete baseData.initial_roach;
    await upsertConfig(knex, 'pest_base', 'Pest Control Base Price', 'pest', 1, baseData);
  }

  await upsertConfig(
    knex,
    'pest_roach',
    'Pest Roach Add-On Modifiers',
    'pest',
    6,
    { german: 0.25, regular: 0.10, none: 0 },
    'Legacy recurring roach add-on percentages.'
  );
};
