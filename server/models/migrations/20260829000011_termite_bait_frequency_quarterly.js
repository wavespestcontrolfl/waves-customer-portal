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
 * Value-guarded both ways: only the shipped contradiction is corrected, and
 * down() restores 'annual' only while the row still reads quarterly/4.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  await knex('services')
    .where({ service_key: 'termite_bait', frequency: 'annual', visits_per_year: 4 })
    .update({ frequency: 'quarterly', updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  await knex('services')
    .where({ service_key: 'termite_bait', frequency: 'quarterly', visits_per_year: 4 })
    .update({ frequency: 'annual', updated_at: knex.fn.now() });
};
