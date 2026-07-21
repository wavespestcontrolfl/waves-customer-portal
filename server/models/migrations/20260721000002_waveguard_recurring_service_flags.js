/**
 * Mark four recurring catalog services as WaveGuard services.
 *
 * The service library is DB-authoritative — `services.is_waveguard` defaults
 * to false (migration 20260401000105), so every service whose seed omitted the
 * flag landed as false regardless of what the plan actually is. That left the
 * bi-monthly and semiannual general-pest cadences flagged false while their
 * quarterly and monthly siblings are true, which is wrong: all four general
 * pest cadences are WaveGuard plans (owner, 2026-07-21).
 *
 * Owner picked the exact set to flip; the remaining false rows (termite bonds,
 * termite monitoring/renewal, the active-bait services, rodent_monitoring and
 * palm_treatment) are deliberately left alone — those are warranty/monitoring
 * products, not WaveGuard service plans.
 *
 * Nothing reads this flag today (customer-facing WaveGuard status keys off the
 * customer's own waveguard_tier, not the catalog row), so this is a data
 * correction that removes a landmine rather than a behavior change.
 */
const SERVICE_KEYS = [
  'pest_general_bimonthly',
  'pest_general_semiannual',
  'rodent_bait_quarterly',
  'termite_bait',
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('services', 'is_waveguard'))) return;

  // Only touch rows still sitting at the false default — an admin who already
  // flipped one in /admin/services keeps their edit and its updated_at.
  await knex('services')
    .whereIn('service_key', SERVICE_KEYS)
    .where('is_waveguard', false)
    .update({ is_waveguard: true, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasColumn('services', 'is_waveguard'))) return;

  await knex('services')
    .whereIn('service_key', SERVICE_KEYS)
    .where('is_waveguard', true)
    .update({ is_waveguard: false, updated_at: knex.fn.now() });
};
