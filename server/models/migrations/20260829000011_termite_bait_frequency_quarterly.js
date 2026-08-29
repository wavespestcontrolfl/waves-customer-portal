/**
 * termite_bait ("Termite Bait Station System Service") carried
 * frequency='annual' with visits_per_year=4 — contradictory, and
 * services.frequency is read operationally (estimate-converter coverage
 * cadence, the recurring seeder, the admin-customers cadence resolver) while
 * self-booking-plan-sync already maps termite_bait to the QUARTERLY plan.
 * Owner ruling 2026-08-28: frequency = quarterly, visits_per_year = 4.
 *
 * The name keeps no cadence prefix by explicit exemption: the row is the
 * bait-station SYSTEM product (installation + the system the bonds ride on),
 * alongside termite_monitoring and the bond rows — the termite family's
 * non-"Active" rows are term/system products, not cadence programs.
 *
 * Ownership-recorded both ways (codex #3579 r1 P1): up() records in
 * system_settings whether IT changed the row; down() restores 'annual' only
 * when up() made the change AND the row still reads quarterly/4 — a row an
 * admin or another environment already corrected is never rewritten back to
 * the known-invalid cadence.
 */
const STATE_KEY = 'migration.20260829000011.state';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const changed = await knex('services')
    .where({ service_key: 'termite_bait', frequency: 'annual', visits_per_year: 4 })
    .update({ frequency: 'quarterly', updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
    await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify({ changed: changed > 0 }) });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  let changed = false;
  if (await knex.schema.hasTable('system_settings')) {
    const row = await knex('system_settings').where({ key: STATE_KEY }).first();
    try { changed = !!(row && JSON.parse(row.value).changed); } catch { changed = false; }
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }
  if (!changed) return;
  await knex('services')
    .where({ service_key: 'termite_bait', frequency: 'quarterly', visits_per_year: 4 })
    .update({ frequency: 'annual', updated_at: knex.fn.now() });
};
