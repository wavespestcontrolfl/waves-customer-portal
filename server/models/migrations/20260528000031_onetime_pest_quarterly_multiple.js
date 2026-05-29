// One-Time Pest pricing model change (supersedes 20260528000021):
//   OLD: one-time = max(floor, (quarterlyPerApp + setup_equivalent) × premium_multiplier)
//   NEW: one-time = max(floor, quarterlyPerApp × multiplier)
//
// Pure multiple off the quarterly rate (which already encodes every property
// metric — footprint, lot, tree/shrub, pool/cage, driveway, complexity, type,
// age), so one-time scales proportionally with real job difficulty and the
// flat setup add-on is dropped. Rewrites the stored `onetime_pest` config row
// to `{ floor, multiplier }`, preserving any customized floor.

const NEW_DEFAULTS = { floor: 199, multiplier: 2.2 };

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const row = await knex('pricing_config').where({ config_key: 'onetime_pest' }).first();
  const existing = row
    ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) || {}
    : {};

  const data = {
    floor: existing.floor != null ? Number(existing.floor) : NEW_DEFAULTS.floor,
    multiplier: NEW_DEFAULTS.multiplier,
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

  // Restore the previous setup + premium shape.
  const data = {
    floor: existing.floor != null ? Number(existing.floor) : 199,
    premium_multiplier: 1.20,
    setup_equivalent: 99,
  };

  await knex('pricing_config')
    .where({ config_key: 'onetime_pest' })
    .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
};
