/**
 * Two stop groups (owner ruling 2026-10-05, "ok go" on idea C): pest and lawn
 * never share one stop again. Until now every recurring program carried ONE
 * family, 'recurring_property_service' (20260830000020), and
 * familiesCompatible() is strict equality, so pest + lawn joined one visit.
 *
 * Pest group: pest, mosquito, rodent and termite programs (one sprayer / bait
 * kit). Lawn group: lawn, tree & shrub and palm programs (plant care). Same
 * group = one stop as before; different groups never join (visit-groups.js
 * canJoin, the 2:25 AM regroup sweep and office Combine all read the family).
 *
 * Open visits whose open members all fall in one new group take that group,
 * so editing a member does not detach it on the family check. A visit that
 * mixes both groups keeps the old family: nothing new can join it, and the
 * office splits it (ops step after this lands). Key-based, like the backfill.
 */
const OLD = 'recurring_property_service';

const PEST_KEYS = [
  'mosquito_monthly', 'mosquito_seasonal',
  'pest_general_bimonthly', 'pest_general_monthly', 'pest_general_quarterly', 'pest_general_semiannual',
  'pest_termite_bait_quarterly',
  'rodent_bait_quarterly', 'trap_only_retainer_monthly', 'trap_only_retainer_plus', 'trap_only_retainer_standard',
  'foam_recurring', 'termite_active_annual', 'termite_active_bait_quarterly', 'termite_bait',
  'termite_bond_1yr', 'termite_bond_5yr', 'termite_bond_10yr', 'termite_monitoring', 'termite_renewal',
];

const LAWN_KEYS = [
  'lawn_care_6week', 'lawn_care_monthly', 'lawn_care_quarterly', 'lawn_care_recurring',
  'lawn_tree_shrub_combo',
  'tree_shrub_6week', 'tree_shrub_program', 'tree_shrub_quarterly', 'palm_injection_semiannual',
];

const GROUPS = { pest_stop: PEST_KEYS, lawn_stop: LAWN_KEYS };

// Open visits whose open members all carry one family take that family.
async function retagOpenVisits(knex, from) {
  await knex.raw(`
    UPDATE service_visits sv
       SET group_family = m.family
      FROM (
        SELECT ss.visit_id, MIN(svc.group_family) AS family
          FROM scheduled_services ss
          JOIN services svc ON svc.id = ss.service_id
         WHERE ss.visit_id IS NOT NULL
           AND ss.status NOT IN ('completed', 'cancelled', 'skipped', 'no_show')
         GROUP BY ss.visit_id
        HAVING COUNT(DISTINCT svc.group_family) = 1
      ) m
     WHERE sv.id = m.visit_id
       AND sv.status = 'open'
       AND sv.group_family = ?
       AND m.family IS NOT NULL
       AND m.family <> sv.group_family`, [from]);
}

exports.up = async function up(knex) {
  for (const [family, keys] of Object.entries(GROUPS)) {
    await knex('services').whereIn('service_key', keys).where({ group_family: OLD })
      .update({ group_family: family });
  }
  await retagOpenVisits(knex, OLD);
};

exports.down = async function down(knex) {
  await knex('services').whereIn('group_family', Object.keys(GROUPS)).update({ group_family: OLD });
  await knex('service_visits').where({ status: 'open' }).whereIn('group_family', Object.keys(GROUPS))
    .update({ group_family: OLD });
};
