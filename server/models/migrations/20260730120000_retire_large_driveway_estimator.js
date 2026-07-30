const RETIRED_TRENCHING_KEYS = [
  'concrete_pct_driveway',
  'concretePctDriveway',
];

const MIGRATION_TAG = 'migration:20260730120000';
const UP_REASON = 'Retire the large-driveway modifier from the estimator engine.';
const DOWN_REASON = 'Rollback: restore the retired large-driveway trenching value captured by migration 20260730120000.';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-07-30',
  category: 'rule',
  summary: 'Remove large driveway from estimator pricing and logic entirely.',
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
    RETIRED_TRENCHING_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(data, key))
      .map((key) => [key, data[key]]),
  );
}

async function loadTrenchingConfig(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  if (!(await knex.schema.hasColumn('pricing_config', 'data'))) return null;
  const row = await knex('pricing_config')
    .where({ config_key: 'onetime_trenching' })
    .first('data');
  const data = parseData(row?.data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

async function saveTrenchingConfig(knex, data) {
  await knex('pricing_config')
    .where({ config_key: 'onetime_trenching' })
    .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
}

async function insertAudit(knex, oldData, newData, reason) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: 'onetime_trenching',
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
    affected_services: JSON.stringify([
      'lawn_care',
      'mosquito',
      'termite_trenching',
      'pest_production_diagnostics',
    ]),
    before_value: JSON.stringify({
      hardscape_addition_sqft: 300,
      turf_complexity_score_points: 2,
      trenching_concrete_pct_addition: 0.05,
      lawn_complexity_minutes_per_visit: 5,
      pest_production_diagnostic_minutes: 2,
      retired_config_values: retiredConfigValues,
    }),
    after_value: JSON.stringify({
      large_driveway: 'removed_from_estimator',
    }),
    rationale: 'Owner directive 2026-07-30: remove large driveway from the estimator engine completely — pricing, logic, everything. Extends the 2026-07-16 retirement (which had already dropped it from pest-control pricing) to every remaining estimator surface: the hardscape-sqft addition (which fed the mosquito treatable area), the turf complexity score (which fed the lawn sqft estimate), the termite-trench concrete split, the lawn cost-floor complexity minutes (margin reporting only since the 2026-07-17 floor disarm), and the pest production-diagnostics minutes. Driveway observations remain property context outside the estimator (satellite/property-lookup detection is unchanged). The onetime_trenching pricing_config row is defensively stripped of any driveway pct key; pest_features.large_driveway was already removed by migration 20260716140000.',
  });
}

async function loadRetiredValuesForRollback(knex) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const audit = await knex('pricing_config_audit')
      .where({ config_key: 'onetime_trenching', changed_by: MIGRATION_TAG, reason: UP_REASON })
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
  const existingData = await loadTrenchingConfig(knex);
  const retiredConfigValues = retiredValuesFrom(existingData);

  if (existingData && Object.keys(retiredConfigValues).length > 0) {
    const nextData = { ...existingData };
    RETIRED_TRENCHING_KEYS.forEach((key) => delete nextData[key]);
    await saveTrenchingConfig(knex, nextData);
    await insertAudit(knex, existingData, nextData, UP_REASON);
  }

  await insertChangelog(knex, retiredConfigValues);
};

exports.down = async function down(knex) {
  const retiredConfigValues = await loadRetiredValuesForRollback(knex);
  const existingData = await loadTrenchingConfig(knex);

  if (existingData && Object.keys(retiredConfigValues).length > 0) {
    const restoredData = { ...existingData, ...retiredConfigValues };
    await saveTrenchingConfig(knex, restoredData);
    await insertAudit(knex, existingData, restoredData, DOWN_REASON);
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
