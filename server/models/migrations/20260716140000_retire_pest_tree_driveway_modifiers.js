const RETIRED_PEST_FEATURE_DEFAULTS = {
  trees_heavy: 6,
  trees_moderate: 0,
  trees_light: -5,
  large_driveway: 3,
};

function parseData(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function updatePestFeatures(knex, { restore }) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  if (!(await knex.schema.hasColumn('pricing_config', 'data'))) return;

  const row = await knex('pricing_config')
    .where({ config_key: 'pest_features' })
    .first('data');
  const data = parseData(row?.data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;

  if (restore) {
    for (const [key, value] of Object.entries(RETIRED_PEST_FEATURE_DEFAULTS)) {
      if (!Object.prototype.hasOwnProperty.call(data, key)) data[key] = value;
    }
  } else {
    Object.keys(RETIRED_PEST_FEATURE_DEFAULTS).forEach((key) => delete data[key]);
  }

  await knex('pricing_config')
    .where({ config_key: 'pest_features' })
    .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
}

exports.up = async function up(knex) {
  await updatePestFeatures(knex, { restore: false });
};

exports.down = async function down(knex) {
  await updatePestFeatures(knex, { restore: true });
};
