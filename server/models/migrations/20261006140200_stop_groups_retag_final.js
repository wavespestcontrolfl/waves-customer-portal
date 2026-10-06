/**
 * Final open-visit family pass for the two stop groups (20261006140000 and
 * 20261006140100 are frozen once pushed). Those passes dropped NULL-status
 * members (`status NOT IN (...)` is never true for NULL), so a mixed visit
 * with a NULL-status pest member could be tagged lawn_stop. This pass
 * re-derives EVERY open visit the earlier passes could have touched from its
 * live members, NULL status included: one family → that family; more than
 * one → the old shared family (nothing new joins it; the office splits it).
 */
const OLD = 'recurring_property_service';
// visit-context/statuses.js JOIN_INELIGIBLE_STATUSES as of this migration.
const JOIN_INELIGIBLE_STATUSES = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];

exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE service_visits sv
       SET group_family = CASE WHEN m.families = 1 THEN m.family ELSE ? END
      FROM (
        SELECT ss.visit_id, COUNT(DISTINCT svc.group_family) AS families, MIN(svc.group_family) AS family
          FROM scheduled_services ss
          JOIN services svc ON svc.id = ss.service_id
         WHERE ss.visit_id IS NOT NULL
           AND (ss.status IS NULL OR ss.status <> ALL(?::text[]))
           AND svc.group_family IS NOT NULL
         GROUP BY ss.visit_id
      ) m
     WHERE sv.id = m.visit_id
       AND sv.status = 'open'
       AND sv.group_family IN (?, 'pest_stop', 'lawn_stop')
       AND sv.group_family IS DISTINCT FROM (CASE WHEN m.families = 1 THEN m.family ELSE ? END)`,
  [OLD, JOIN_INELIGIBLE_STATUSES, OLD, OLD]);
};

// 20261006140000's down restores every open visit's family.
exports.down = async function down() {};
