/**
 * Two stop groups (owner ruling 2026-10-05, idea C, tree & shrub with lawn):
 * pest and lawn never share one stop again. Until now every recurring program
 * carried ONE family, 'recurring_property_service' (20260830000020), and
 * familiesCompatible() is strict equality, so pest + lawn joined one visit.
 *
 * Pest group: pest, mosquito, rodent and termite programs. Lawn group: lawn,
 * tree & shrub and palm programs. Same group = one stop as before; different
 * groups never join (visit-groups.js canJoin, the 2:25 AM regroup sweep and
 * office Combine all read the family).
 *
 * Open visits are re-derived from their LIVE members (NULL status counts as
 * live; visit-context/statuses.js JOIN_INELIGIBLE_STATUSES are history): one
 * family → that family, so editing a member does not detach it; a visit that
 * mixes both groups keeps the old family, nothing new can join it, and the
 * office splits it. Key-based, like the backfill.
 */
const OLD = 'recurring_property_service';
// visit-context/statuses.js JOIN_INELIGIBLE_STATUSES as of this migration.
const JOIN_INELIGIBLE_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];

const GROUPS = {
  pest_stop: [
    'mosquito_monthly', 'mosquito_seasonal',
    'pest_general_bimonthly', 'pest_general_monthly', 'pest_general_quarterly', 'pest_general_semiannual',
    'pest_termite_bait_quarterly',
    'rodent_bait_quarterly', 'trap_only_retainer_monthly', 'trap_only_retainer_plus', 'trap_only_retainer_standard',
    'foam_recurring', 'termite_active_annual', 'termite_active_bait_quarterly', 'termite_bait',
    'termite_bond_1yr', 'termite_bond_5yr', 'termite_bond_10yr', 'termite_monitoring', 'termite_renewal',
  ],
  lawn_stop: [
    'lawn_care_6week', 'lawn_care_monthly', 'lawn_care_quarterly', 'lawn_care_recurring',
    'lawn_tree_shrub_combo',
    'tree_shrub_6week', 'tree_shrub_program', 'tree_shrub_quarterly', 'palm_injection_semiannual',
  ],
};

exports.up = async function up(knex) {
  for (const [family, keys] of Object.entries(GROUPS)) {
    await knex('services').whereIn('service_key', keys).where({ group_family: OLD })
      .update({ group_family: family });
  }
  await knex.raw(`
    UPDATE service_visits sv
       SET group_family = m.family
      FROM (
        SELECT ss.visit_id, MIN(svc.group_family) AS family
          FROM scheduled_services ss
          JOIN services svc ON svc.id = ss.service_id
         WHERE ss.visit_id IS NOT NULL
           AND (ss.status IS NULL OR ss.status <> ALL(?::text[]))
           AND svc.group_family IS NOT NULL
         GROUP BY ss.visit_id
        HAVING COUNT(DISTINCT svc.group_family) = 1
      ) m
     WHERE sv.id = m.visit_id
       AND sv.status = 'open'
       AND sv.group_family = ?
       AND m.family IN ('pest_stop', 'lawn_stop')`, [JOIN_INELIGIBLE_STATUSES, OLD]);
};

exports.down = async function down(knex) {
  await knex('services').whereIn('group_family', Object.keys(GROUPS)).update({ group_family: OLD });
  await knex('service_visits').where({ status: 'open' }).whereIn('group_family', Object.keys(GROUPS))
    .update({ group_family: OLD });
};
