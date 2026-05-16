const FLEA_EXTERIOR_TIERS = [
  { min: 1, max: 2500, initial: 55, followUp: 35 },
  { min: 2501, max: 5000, initial: 75, followUp: 45 },
  { min: 5001, max: 7500, initial: 95, followUp: 60 },
  { min: 7501, max: 10000, initial: 115, followUp: 75 },
  { min: 10001, max: 15000, initial: 155, followUp: 100 },
  { min: 15001, max: 20000, initial: 195, followUp: 125 },
];

function parseData(data) {
  if (!data) return {};
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return {};
    }
  }
  return data;
}

function nextFleaConfig(data = {}) {
  const initial = data.initial || {};
  const followUp = data.followUp || data.followup || {};
  return {
    ...data,
    initial: {
      base: initial.base ?? data.initial_base ?? 225,
      floor: initial.floor ?? data.initial_floor ?? 185,
    },
    followUp: {
      base: followUp.base ?? data.followup_base ?? data.followUp_base ?? 125,
      floor: followUp.floor ?? data.followup_floor ?? data.followUp_floor ?? 95,
    },
    exterior: {
      enabled: data.exterior?.enabled ?? true,
      maxSqFt: data.exterior?.maxSqFt ?? data.exterior?.max_sqft ?? 20000,
      tiers: Array.isArray(data.exterior?.tiers) && data.exterior.tiers.length
        ? data.exterior.tiers
        : FLEA_EXTERIOR_TIERS,
    },
  };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const row = await knex('pricing_config')
    .where({ config_key: 'onetime_flea' })
    .first();
  const data = nextFleaConfig(parseData(row?.data));

  if (row) {
    await knex('pricing_config')
      .where({ config_key: 'onetime_flea' })
      .update({
        name: row.name || 'Flea Treatment',
        category: row.category || 'one_time',
        data: JSON.stringify(data),
        updated_at: knex.fn.now(),
      });
    return;
  }

  await knex('pricing_config').insert({
    config_key: 'onetime_flea',
    name: 'Flea Treatment',
    category: 'one_time',
    sort_order: 10,
    data: JSON.stringify(data),
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const row = await knex('pricing_config')
    .where({ config_key: 'onetime_flea' })
    .first();
  if (!row) return;

  const data = parseData(row.data);
  await knex('pricing_config')
    .where({ config_key: 'onetime_flea' })
    .update({
      data: JSON.stringify({
        initial_base: data.initial?.base ?? data.initial_base ?? 225,
        initial_floor: data.initial?.floor ?? data.initial_floor ?? 185,
        followup_base: data.followUp?.base ?? data.followup_base ?? 125,
        followup_floor: data.followUp?.floor ?? data.followup_floor ?? 95,
      }),
      updated_at: knex.fn.now(),
    });
};
