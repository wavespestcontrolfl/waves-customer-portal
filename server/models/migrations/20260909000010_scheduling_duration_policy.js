/** Additive catalog policy for the owner-approved routine allowance.
 * The previous catalog defaults stay available to the default-off release
 * gate. Explicit catalog edits and existing appointments are never shortened.
 */
const ROUTINE_KEYS = [
  'pest_general_monthly', 'pest_general_bimonthly', 'pest_general_quarterly', 'pest_general_semiannual',
  'lawn_care_monthly', 'lawn_care_6week', 'lawn_care_recurring', 'lawn_care_quarterly', 'lawn_fertilization',
  'mosquito_monthly', 'mosquito_seasonal', 'tree_shrub_program', 'tree_shrub_6week', 'tree_shrub_quarterly',
  'rodent_monitoring', 'rodent_bait_quarterly', 'termite_active_bait_quarterly',
];

exports.up = async function (knex) {
  await knex.schema.alterTable('services', (table) => { table.jsonb('scheduling_duration_policy'); });
  await knex.schema.alterTable('scheduled_services', (table) => { table.integer('reservation_policy_version'); });
  await knex('services').whereIn('service_key', ROUTINE_KEYS)
    .where('default_duration_minutes', 60)
    .whereNotExists(function () {
      this.select(knex.raw('1')).from('audit_log')
        .whereRaw('audit_log.resource_id = services.id')
        .where('resource_type', 'service').where('action', 'like', 'service_catalog.%')
        .where('created_at', '>=', '2026-07-03T00:00:00Z')
        .whereRaw("jsonb_exists_any(metadata->'changed_fields', ARRAY['default_duration_minutes','min_duration_minutes','max_duration_minutes'])");
    })
    .update({ scheduling_duration_policy: JSON.stringify({ version: 1,
      default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 40,
      source: 'owner_2026_09_09', previous_default_minutes: 60,
    }) });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('scheduled_services', (table) => { table.dropColumn('reservation_policy_version'); });
  await knex.schema.alterTable('services', (table) => { table.dropColumn('scheduling_duration_policy'); });
};
