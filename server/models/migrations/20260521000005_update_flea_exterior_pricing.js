const FLEA_EXTERIOR_TIERS = [
  { min: 1, max: 2500, initial: 75, followUp: 50 },
  { min: 2501, max: 5000, initial: 95, followUp: 60 },
  { min: 5001, max: 7500, initial: 120, followUp: 75 },
  { min: 7501, max: 10000, initial: 145, followUp: 95 },
  { min: 10001, max: 15000, initial: 195, followUp: 130 },
  { min: 15001, max: 20000, initial: 240, followUp: 155 },
];

const LEGACY_FLEA_EXTERIOR_TIERS = [
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

async function updateFleaExteriorTiers(knex, tiers) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const row = await knex('pricing_config')
    .where({ config_key: 'onetime_flea' })
    .first();

  const data = parseData(row?.data);
  const nextData = {
    ...data,
    initial: {
      base: data.initial?.base ?? data.initial_base ?? 225,
      floor: data.initial?.floor ?? data.initial_floor ?? 185,
    },
    followUp: {
      base: data.followUp?.base ?? data.followup_base ?? data.followUp_base ?? 125,
      floor: data.followUp?.floor ?? data.followup_floor ?? data.followUp_floor ?? 95,
    },
    exterior: {
      ...(data.exterior || {}),
      enabled: data.exterior?.enabled ?? true,
      maxSqFt: 20000,
      tiers,
    },
  };

  if (row) {
    await knex('pricing_config')
      .where({ config_key: 'onetime_flea' })
      .update({
        name: row.name || 'Flea Treatment',
        category: row.category || 'one_time',
        data: JSON.stringify(nextData),
        updated_at: knex.fn.now(),
      });
    return;
  }

  await knex('pricing_config').insert({
    config_key: 'onetime_flea',
    name: 'Flea Treatment',
    category: 'one_time',
    sort_order: 12,
    data: JSON.stringify(nextData),
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });
}

exports.up = async function up(knex) {
  await updateFleaExteriorTiers(knex, FLEA_EXTERIOR_TIERS);
};

exports.down = async function down(knex) {
  await updateFleaExteriorTiers(knex, LEGACY_FLEA_EXTERIOR_TIERS);
};
