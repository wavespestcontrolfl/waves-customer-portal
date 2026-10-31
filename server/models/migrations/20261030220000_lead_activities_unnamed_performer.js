// Lead history rows written while admin-leads.js built the performer from
// technicians.first_name / last_name, which the table does not have: they read
// "undefined " (2026-04 to 2026-09) or "" (lead PUT status changes, 2026-10).
// No record says who acted, so they get a plain label instead of a guess.
const UNNAMED_PERFORMER_LABEL = 'Staff (name not recorded)';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_activities'))) return;
  if (!(await knex.schema.hasColumn('lead_activities', 'performed_by'))) return;
  await knex('lead_activities')
    .whereIn('performed_by', ['undefined ', ''])
    .update({ performed_by: UNNAMED_PERFORMER_LABEL });
};

exports.down = async function down() {
  // One-way data repair: the old values carried no name to restore.
};

exports.UNNAMED_PERFORMER_LABEL = UNNAMED_PERFORMER_LABEL;
