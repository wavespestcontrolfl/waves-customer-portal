/**
 * Rollback guard for the web sweep row (area_addon_web_sweep), later than 20261010160000.
 *
 * 20261010160000 tells an operator's edit from the seed by comparing every field the area add-on migrations wrote, and by
 * `updated_at` for the five chemical rows. It skips `updated_at` for the web sweep, because 20261008220000 and 20261008240000
 * stamp it themselves, so an edit to a field no migration wrote (the frequency, say) left the web sweep looking untouched and
 * the older rollback deleted the service. The frozen 20261008200000 down() deletes each service it inserted by the id recorded
 * in its state row, whatever else changed since.
 *
 * This guard compares the web sweep's `updated_at` with the moment the last migration that writes the row finished
 * (`knex_migrations.migration_time` of 20261008200000, 20261008220000 and 20261008240000): a save after that moment is an
 * operator edit. The key then leaves the older migration's state row (service, profile and tax row together), exactly as
 * 20261010160000 does for the other keys, so the older down() leaves the service, its profile and its tax row as the operator
 * left them. When in doubt the row is KEPT: a missing `knex_migrations` table, a missing row for any of the three migrations,
 * or a web sweep with no `updated_at` all protect it.
 *
 * up() changes nothing. This is the latest area add-on migration that has a rollback to run, so it runs first on a rollback.
 */
const catalog = require('./20261008200000_area_addon_catalog_rows');
const sweep = require('./20261008220000_area_addon_web_sweep_closeout');

// The migrations that write the web sweep row (insert, closeout rules and the tax mark), as knex_migrations names them.
const WRITER_MIGRATIONS = [
  '20261008200000_area_addon_catalog_rows.js',
  '20261008220000_area_addon_web_sweep_closeout.js',
  '20261008240000_area_addon_catalog_tax_mark.js',
];
// updated_at is the database's clock, migration_time the migration runner's: a save within this long after the last
// migration is not told from the migration's own write.
const CLOCK_SKEW_MS = 5000;

exports.WRITER_MIGRATIONS = WRITER_MIGRATIONS;
exports.up = async function up() {};

// The latest finish time of the three writer migrations, or null when any of them cannot be read.
async function lastWriterTime(knex) {
  try {
    if (!(await knex.schema.hasTable('knex_migrations'))) return null;
    const times = (await knex('knex_migrations').whereIn('name', WRITER_MIGRATIONS).pluck('migration_time'))
      .map((value) => new Date(value).getTime());
    if (times.length !== WRITER_MIGRATIONS.length || times.some((t) => !Number.isFinite(t))) return null;
    return Math.max(...times);
  } catch {
    return null;
  }
}

async function readState(knex) {
  const row = await knex('system_settings').where({ key: catalog.STATE_KEY }).first();
  if (!row) return null;
  try { return { services: [], profiles: [], taxability: [], ...JSON.parse(row.value) }; } catch { return null; }
}

// True unless the row can be shown to be as the migrations left it.
async function webSweepProtected(knex) {
  const row = await knex('services').where({ service_key: sweep.SERVICE_KEY }).first();
  if (!row) return false;
  const saved = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
  const reference = await lastWriterTime(knex);
  if (!Number.isFinite(saved) || reference === null) return true;
  return saved > reference + CLOCK_SKEW_MS;
}

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services')) || !(await knex.schema.hasTable('system_settings'))) return;
  const state = await readState(knex);
  if (!state || !state.services.some((entry) => entry && entry.key === sweep.SERVICE_KEY)) return;
  if (!(await webSweepProtected(knex))) return;
  await knex('system_settings').where({ key: catalog.STATE_KEY }).update({
    value: JSON.stringify({
      ...state,
      services: state.services.filter((entry) => !(entry && entry.key === sweep.SERVICE_KEY)),
      profiles: state.profiles.filter((key) => key !== sweep.SERVICE_KEY),
      taxability: state.taxability.filter((key) => key !== sweep.SERVICE_KEY),
    }),
  });
};
