/**
 * Visit prep photos — tech "seen" stamp (PR 3a: tech Visit Brief surface).
 *
 * Nullable `tech_seen_at` on `visit_prep_submissions`: stamped the first
 * time the ASSIGNED technician's Visit Brief read serves a stop whose
 * facts include this submission (server/routes/admin-schedule.js's
 * GET /:id/visit-brief, `withFacts`). Never stamped for an admin/office
 * preview of the same stop. `hasColumn`-guarded and reversible, matching
 * the style of 20260928130000_visit_prep_submissions.js.
 */

exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('visit_prep_submissions', 'tech_seen_at');
  if (!hasColumn) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      t.timestamp('tech_seen_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn('visit_prep_submissions', 'tech_seen_at');
  if (hasColumn) {
    await knex.schema.alterTable('visit_prep_submissions', (t) => {
      t.dropColumn('tech_seen_at');
    });
  }
};
