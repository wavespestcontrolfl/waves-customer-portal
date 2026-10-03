// Assignment cards (visit_assigned / visit_unassigned) written before #5783
// never recorded the slot the visit left, so a combined technician + date move
// off today cannot be ruled out for them. Marking them prior_day_unknown keeps
// each as its own card on the Today page instead of folding it into the
// summary where Clear all would dismiss it (Codex #5786 P2). The Today feed
// (routes/tech-notifications.js soonSql) reads the mark.
//
// A new file rather than an edit to 20261003150000, which a preview database
// may already have run (knex tracks migrations by filename).
//
// Cutoff: #5783's production deploy began 2026-10-03T11:32:40Z; cards from
// the deploy window are marked too (a few post-deploy cards becoming their own
// card is the conservative error). Undismissed cards only.
//
// down() is a documented no-op: the mark only keeps a card visible on its
// own, and removing it could fold a near-term change away.
const TYPES = ['visit_assigned', 'visit_unassigned'];
const CUTOFF = new Date('2026-10-03T11:45:00Z');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tech_notifications'))) return;
  await knex('tech_notifications')
    .whereNull('dismissed_at')
    .whereIn('type', TYPES)
    .where('created_at', '<', CUTOFF)
    .update({ payload: knex.raw("COALESCE(payload, '{}'::jsonb) || '{\"prior_day_unknown\": true}'::jsonb") });
};

exports.down = async function down() {
  // Documented no-op (see header).
};
