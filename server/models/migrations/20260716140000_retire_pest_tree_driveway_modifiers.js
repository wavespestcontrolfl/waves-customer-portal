const RETIRED_PEST_FEATURE_KEYS = [
  'trees_heavy',
  'trees_moderate',
  'trees_light',
  'large_driveway',
];

const MIGRATION_TAG = 'migration:20260716140000';
const UP_REASON = 'Retire tree-density and large-driveway modifiers from pest-control pricing.';
const DOWN_REASON = 'Rollback: restore the retired pest modifier values captured by migration 20260716140000.';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'codex-2026-07-16',
  category: 'rule',
  summary: 'Stop using tree density and large-driveway size in pest-control pricing.',
};

function parseData(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function retiredValuesFrom(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return Object.fromEntries(
    RETIRED_PEST_FEATURE_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
      .map((key) => [key, data[key]]),
  );
}

async function loadPestFeatures(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  if (!(await knex.schema.hasColumn('pricing_config', 'data'))) return null;
  const row = await knex('pricing_config')
    .where({ config_key: 'pest_features' })
    .first('data');
  const data = parseData(row?.data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

async function savePestFeatures(knex, data) {
  await knex('pricing_config')
    .where({ config_key: 'pest_features' })
    .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
}

async function insertAudit(knex, oldData, newData, reason) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: 'pest_features',
    old_value: JSON.stringify(oldData),
    new_value: JSON.stringify(newData),
    changed_by: MIGRATION_TAG,
    reason,
  });
}

async function insertChangelog(knex, retiredConfigValues) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['pest_control', 'one_time_pest', 'waveguard_bundle_totals']),
    before_value: JSON.stringify({
      tree_density_adjustment_per_visit: { light: -5, moderate: 0, heavy: 6 },
      large_driveway_adjustment_per_visit: 3,
      retired_config_values: retiredConfigValues,
    }),
    after_value: JSON.stringify({
      tree_density: 'context_only',
      large_driveway: 'context_only',
    }),
    rationale: 'Owner directive 2026-07-16: tree density and driveway size are not reliable drivers of general pest-control treatment cost. Remove both from recurring and one-time pest math while retaining them as property context for services where they remain operationally relevant. The pricing engine remains DB-authoritative for every active modifier; these retired keys are removed from pest_features and ignored by the DB bridge. Regression fixtures retain only the pest deltas isolated against the same production pricing_config before and after this rule change.',
  });
}

async function loadRetiredValuesForRollback(knex) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const audit = await knex('pricing_config_audit')
      .where({ config_key: 'pest_features', changed_by: MIGRATION_TAG, reason: UP_REASON })
      .orderBy('id', 'desc')
      .first('old_value');
    const oldData = parseData(audit?.old_value);
    if (oldData && typeof oldData === 'object') return retiredValuesFrom(oldData);
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    const changelog = await knex('pricing_changelog')
      .where(CHANGELOG_IDENTITY)
      .first('before_value');
    const beforeValue = parseData(changelog?.before_value);
    const values = beforeValue?.retired_config_values;
    if (values && typeof values === 'object' && !Array.isArray(values)) return values;
  }
  return {};
}

exports.up = async function up(knex) {
  const existingData = await loadPestFeatures(knex);
  const retiredConfigValues = retiredValuesFrom(existingData);

  if (existingData) {
    const nextData = { ...existingData };
    RETIRED_PEST_FEATURE_KEYS.forEach((key) => delete nextData[key]);
    await savePestFeatures(knex, nextData);
    await insertAudit(knex, existingData, nextData, UP_REASON);
  }

  await insertChangelog(knex, retiredConfigValues);
};

exports.down = async function down(knex) {
  const retiredConfigValues = await loadRetiredValuesForRollback(knex);
  const existingData = await loadPestFeatures(knex);

  if (existingData && Object.keys(retiredConfigValues).length > 0) {
    const restoredData = { ...existingData, ...retiredConfigValues };
    await savePestFeatures(knex, restoredData);
    await insertAudit(knex, existingData, restoredData, DOWN_REASON);
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
