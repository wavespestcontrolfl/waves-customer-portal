// One-Time Pest pricing model change:
//   OLD: one-time = max(floor, quarterlyPerApp × multiplier)        (multiplier 1.75)
//   NEW: one-time = max(floor, (quarterlyPerApp + setup_equivalent) × premium_multiplier)
//
// The legacy `multiplier` is NOT interchangeable with `premium_multiplier`
// (different base), so this migration rewrites the stored `onetime_pest` config
// row to the new shape. The pricing engine ignores the legacy key, so this
// keeps the admin Pricing Logic panel showing the fields that actually drive
// pricing. Floor is preserved if already customized.

const NEW_DEFAULTS = { floor: 199, premium_multiplier: 1.20, setup_equivalent: 99 };

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const row = await knex('pricing_config').where({ config_key: 'onetime_pest' }).first();
  const existing = row
    ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) || {}
    : {};

  const data = {
    floor: existing.floor != null ? Number(existing.floor) : NEW_DEFAULTS.floor,
    premium_multiplier: NEW_DEFAULTS.premium_multiplier,
    setup_equivalent: NEW_DEFAULTS.setup_equivalent,
  };

  await knex('pricing_config')
    .insert({
      config_key: 'onetime_pest',
      name: 'One-Time Pest Pricing',
      category: 'one_time',
      sort_order: 3,
      data: JSON.stringify(data),
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .onConflict('config_key')
    .merge(['data', 'updated_at']);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const row = await knex('pricing_config').where({ config_key: 'onetime_pest' }).first();
  if (!row) return;
  const existing = (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) || {};

  const data = {
    floor: existing.floor != null ? Number(existing.floor) : 199,
    multiplier: 1.75,
  };

  await knex('pricing_config')
    .where({ config_key: 'onetime_pest' })
    .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
};
