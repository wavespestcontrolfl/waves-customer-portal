/**
 * Follow-up to 20261006140000_stop_groups_pest_lawn (frozen once pushed): its
 * open-visit retag counted `rescheduled` children, which visit-context/
 * statuses.js classifies as join-ineligible retained history. A pest visit
 * that kept a rescheduled lawn child stayed on 'recurring_property_service'
 * although its only live member is pest_stop, so later family checks could
 * detach that member. Re-derive the family from live members only.
 */
// visit-context/statuses.js JOIN_INELIGIBLE_STATUSES as of this migration.
const JOIN_INELIGIBLE_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];

exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE service_visits sv
       SET group_family = m.family
      FROM (
        SELECT ss.visit_id, MIN(svc.group_family) AS family
          FROM scheduled_services ss
          JOIN services svc ON svc.id = ss.service_id
         WHERE ss.visit_id IS NOT NULL
           AND (ss.status IS NULL OR ss.status <> ALL(?::text[]))
         GROUP BY ss.visit_id
        HAVING COUNT(DISTINCT svc.group_family) = 1
      ) m
     WHERE sv.id = m.visit_id
       AND sv.status = 'open'
       AND sv.group_family = 'recurring_property_service'
       AND m.family IN ('pest_stop', 'lawn_stop')`, [JOIN_INELIGIBLE_STATUSES]);
};

// The earlier migration's down restores every open visit's family.
exports.down = async function down() {};
