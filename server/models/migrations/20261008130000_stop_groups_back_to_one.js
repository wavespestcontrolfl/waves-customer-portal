/**
 * Back to ONE stop group (owner ruling 2026-10-08: "changing this back to not
 * have two visits for one customer ... change back to what it was for all
 * customers"). Reverses 20261006210000_stop_groups_pest_lawn: every recurring
 * program carries 'recurring_property_service' again, so pest + lawn on the
 * same day and connected windows join one visit as they did before 10-06
 * (visit-groups.js canJoin, the 2:25 AM regroup sweep and office Combine all
 * read the family).
 *
 * 20261006210000 already ran in production and stays in the directory; this
 * forward migration is its down(), widened to every visit status so no row
 * keeps a family the code no longer writes. No appointment time moves here:
 * the regroup sweep folds rows that are already back to back.
 */
const ONE = 'recurring_property_service';
const SPLIT = ['pest_stop', 'lawn_stop'];

exports.up = async function up(knex) {
  await knex('services').whereIn('group_family', SPLIT).update({ group_family: ONE });
  await knex('service_visits').whereIn('group_family', SPLIT).update({ group_family: ONE });
};

// Not reversible: after up() a visit no longer records which group it was in,
// and 20261006210000 holds the key lists that would re-derive it.
exports.down = async function down() {};
