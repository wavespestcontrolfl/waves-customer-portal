const DEFAULT_ZONE_NAMES = {
  A: 'Manatee/Sarasota core',
  B: 'Extended service area',
  C: 'Charlotte outskirts',
  D: 'Far reach',
  UNKNOWN: 'Default',
};

const LEGACY_ZONE_MULTIPLIERS = {
  A: 1.00,
  B: 1.05,
  C: 1.12,
  D: 1.20,
  UNKNOWN: 1.00,
};

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

function buildZoneConfig(data = {}, multiplierByZone) {
  return Object.fromEntries(
    Object.entries(DEFAULT_ZONE_NAMES).map(([key, defaultName]) => [
      key,
      {
        name: data[key]?.name || defaultName,
        multiplier: multiplierByZone[key] ?? 1.00,
      },
    ])
  );
}

async function hasColumn(knex, tableName, columnName) {
  return knex.schema.hasColumn(tableName, columnName);
}

async function insertChangelog(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;

  const identity = {
    version_from: 'v4.3',
    version_to: 'v4.3',
    changed_by: 'codex-2026-05-16',
    category: 'rule',
    summary: 'Remove service-zone pricing multipliers from estimator quotes.',
  };
  const existing = await knex('pricing_changelog')
    .where(identity)
    .first('id');
  if (existing) return;

  await knex('pricing_changelog').insert({
    ...identity,
    affected_services: JSON.stringify([
      'pest_control',
      'tree_shrub',
      'palm_injection',
      'mosquito',
      'termite_bait',
      'rodent_bait',
    ]),
    before_value: JSON.stringify(LEGACY_ZONE_MULTIPLIERS),
    after_value: JSON.stringify({
      A: 1.00,
      B: 1.00,
      C: 1.00,
      D: 1.00,
      UNKNOWN: 1.00,
    }),
    rationale: 'Service Zone A/B/C/D should remain available as routing and service-area metadata, but it should not raise estimator prices. The recurring-service zone bump caused otherwise-identical properties to quote differently solely because of geography. Drive and admin cost remain handled by the fleet-average DRIVE_TIME and ADMIN_ANNUAL model.',
  });
}

async function deleteChangelog(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;

  await knex('pricing_changelog')
    .where({
      version_from: 'v4.3',
      version_to: 'v4.3',
      changed_by: 'codex-2026-05-16',
      category: 'rule',
      summary: 'Remove service-zone pricing multipliers from estimator quotes.',
    })
    .del();
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  if (await hasColumn(knex, 'pricing_config', 'data')) {
    const row = await knex('pricing_config')
      .where({ config_key: 'zone_multipliers' })
      .first();
    const data = buildZoneConfig(parseData(row?.data), {
      A: 1.00,
      B: 1.00,
      C: 1.00,
      D: 1.00,
      UNKNOWN: 1.00,
    });

    if (row) {
      await knex('pricing_config')
        .where({ config_key: 'zone_multipliers' })
        .update({
          name: 'Service Zones',
          category: row.category || 'zone',
          data: JSON.stringify(data),
          updated_at: knex.fn.now(),
        });
      await insertChangelog(knex);
      return;
    }

    await knex('pricing_config').insert({
      config_key: 'zone_multipliers',
      name: 'Service Zones',
      category: 'zone',
      sort_order: 1,
      data: JSON.stringify(data),
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
    await insertChangelog(knex);
    return;
  }

  if (await hasColumn(knex, 'pricing_config', 'config_value')) {
    await knex('pricing_config')
      .whereIn('config_key', ['ZONE_A', 'ZONE_B', 'ZONE_C', 'ZONE_D', 'ZONE_UNKNOWN'])
      .update({ config_value: 1.00, updated_at: knex.fn.now() });
  }

  await insertChangelog(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) {
    await deleteChangelog(knex);
    return;
  }

  if (await hasColumn(knex, 'pricing_config', 'data')) {
    const row = await knex('pricing_config')
      .where({ config_key: 'zone_multipliers' })
      .first();
    if (!row) {
      await deleteChangelog(knex);
      return;
    }

    await knex('pricing_config')
      .where({ config_key: 'zone_multipliers' })
      .update({
        name: 'Service Zone Multipliers',
        data: JSON.stringify(buildZoneConfig(parseData(row.data), LEGACY_ZONE_MULTIPLIERS)),
        updated_at: knex.fn.now(),
      });
    await deleteChangelog(knex);
    return;
  }

  if (await hasColumn(knex, 'pricing_config', 'config_value')) {
    await knex('pricing_config').where({ config_key: 'ZONE_A' }).update({ config_value: 1.00, updated_at: knex.fn.now() });
    await knex('pricing_config').where({ config_key: 'ZONE_B' }).update({ config_value: 1.05, updated_at: knex.fn.now() });
    await knex('pricing_config').where({ config_key: 'ZONE_C' }).update({ config_value: 1.10, updated_at: knex.fn.now() });
    await knex('pricing_config').where({ config_key: 'ZONE_UNKNOWN' }).update({ config_value: 1.05, updated_at: knex.fn.now() });
  }

  await deleteChangelog(knex);
};
