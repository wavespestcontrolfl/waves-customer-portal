/**
 * Pest Pressure service-line scope.
 *
 * Adds two new config knobs so the feature only runs on the service lines
 * where the multi-visit-trend model makes sense (default: pest + mosquito)
 * and only on recurring frequencies (default: skip one-time / unknown).
 *
 * Also adds a 'semiannual' window to the existing serviceFrequencyWindows
 * jsonb so Phase 1's hardcoded {monthly, bimonthly, quarterly, fallback}
 * gains 180-day coverage for true semi-annual recurring services.
 */

async function addColumnIfMissing(knex, table, name, add) {
  if (!(await knex.schema.hasColumn(table, name))) {
    await knex.schema.alterTable(table, (t) => add(t));
  }
}

async function dropColumnIfPresent(knex, table, name) {
  if (await knex.schema.hasColumn(table, name)) {
    await knex.schema.alterTable(table, (t) => t.dropColumn(name));
  }
}

const DEFAULT_ENABLED_SERVICE_LINES = ['pest', 'mosquito'];

exports.up = async function up(knex) {
  await addColumnIfMissing(knex, 'pest_pressure_configs', 'enabled_service_lines', (t) =>
    t.jsonb('enabled_service_lines').notNullable().defaultTo(knex.raw(`'${JSON.stringify(DEFAULT_ENABLED_SERVICE_LINES)}'::jsonb`)));
  await addColumnIfMissing(knex, 'pest_pressure_configs', 'require_recurring_frequency', (t) =>
    t.boolean('require_recurring_frequency').notNullable().defaultTo(true));

  // Backfill the seeded 'global' row + add 'semiannual' to its frequency
  // windows. Keeps existing admins on the new defaults without requiring
  // them to open the settings page.
  const row = await knex('pest_pressure_configs').where({ scope: 'global' }).first('id', 'service_frequency_windows', 'enabled_service_lines');
  if (row) {
    const windows = row.service_frequency_windows || {};
    if (windows.semiannual == null) {
      windows.semiannual = 180;
      await knex('pest_pressure_configs')
        .where({ id: row.id })
        .update({ service_frequency_windows: JSON.stringify(windows) });
    }
    // Make sure the new column has the default applied even on existing rows
    // (the DEFAULT only fires on INSERT).
    const currentLines = Array.isArray(row.enabled_service_lines) ? row.enabled_service_lines : null;
    if (!currentLines || currentLines.length === 0) {
      await knex('pest_pressure_configs')
        .where({ id: row.id })
        .update({ enabled_service_lines: JSON.stringify(DEFAULT_ENABLED_SERVICE_LINES) });
    }
  }
};

exports.down = async function down(knex) {
  // Strip 'semiannual' from the seeded row's windows so down restores the
  // Phase 1 shape exactly.
  const row = await knex('pest_pressure_configs').where({ scope: 'global' }).first('id', 'service_frequency_windows');
  if (row && row.service_frequency_windows && row.service_frequency_windows.semiannual != null) {
    const windows = { ...row.service_frequency_windows };
    delete windows.semiannual;
    await knex('pest_pressure_configs')
      .where({ id: row.id })
      .update({ service_frequency_windows: JSON.stringify(windows) });
  }

  await dropColumnIfPresent(knex, 'pest_pressure_configs', 'require_recurring_frequency');
  await dropColumnIfPresent(knex, 'pest_pressure_configs', 'enabled_service_lines');
};
