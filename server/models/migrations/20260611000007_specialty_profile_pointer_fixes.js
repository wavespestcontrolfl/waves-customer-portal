/**
 * Correct two findings-schema pointers seeded wrong by 20260521000005:
 *
 *   - flea_tick            → project_type 'flea'             (was one_time_pest_treatment)
 *   - rodent_exclusion%    → project_type 'rodent_exclusion' (was rodent_trapping)
 *
 * Both rows stay completion_mode='project_required', so the only behavior
 * change is WHICH project form opens today (the correct one). The specialty
 * service-report cutover later reuses project_type as the typed-findings
 * schema pointer, so these need to be right before any cutover.
 *
 * Explicit-match updates only — no pattern sweeps over modes. down() restores
 * the exact original seed values.
 */

exports.up = async function up(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  await knex('service_completion_profiles')
    .where({ service_key: 'flea_tick', completion_mode: 'project_required' })
    .update({ project_type: 'flea', updated_at: knex.fn.now() });

  await knex('service_completion_profiles')
    .where('service_key', 'like', 'rodent_exclusion%')
    .where({ completion_mode: 'project_required' })
    .update({ project_type: 'rodent_exclusion', updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  const hasProfiles = await knex.schema.hasTable('service_completion_profiles');
  if (!hasProfiles) return;

  await knex('service_completion_profiles')
    .where({ service_key: 'flea_tick', completion_mode: 'project_required' })
    .update({ project_type: 'one_time_pest_treatment', updated_at: knex.fn.now() });

  await knex('service_completion_profiles')
    .where('service_key', 'like', 'rodent_exclusion%')
    .where({ completion_mode: 'project_required' })
    .update({ project_type: 'rodent_trapping', updated_at: knex.fn.now() });
};
