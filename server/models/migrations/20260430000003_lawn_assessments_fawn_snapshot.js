// Adds the fawn_snapshot jsonb column to lawn_assessments.
//
// Drift fix: services/lawn-intelligence.js:attachWeather() writes
// fawn_snapshot as a JSON blob and the report builder reads it back
// (services/lawn-intelligence.js:874), but the column was never added
// in the lawn-intelligence-suite migration (20260414000019). Calls to
// attachWeather() inside the confirm-route setImmediate fanout fail
// silently — the intelligence catch-all at admin-lawn-assessment.js:431
// swallows the error, so service reports render with empty weather and
// the five scalar FAWN columns also miss their update.
//
// Scope is intentionally minimal: one nullable jsonb column. The five
// scalar fawn_* columns already exist (added by 20260414000019) and
// are kept — the snapshot is the full audit blob, not a replacement.
// No GIN index yet; the snapshot is read whole, never queried into.
//
// Idempotent via hasColumn guard so re-runs on environments that may
// have hand-patched the column don't error.

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  if (await knex.schema.hasColumn('lawn_assessments', 'fawn_snapshot')) return;

  await knex.schema.alterTable('lawn_assessments', (t) => {
    t.jsonb('fawn_snapshot').nullable();
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  if (!(await knex.schema.hasColumn('lawn_assessments', 'fawn_snapshot'))) return;

  await knex.schema.alterTable('lawn_assessments', (t) => {
    t.dropColumn('fawn_snapshot');
  });
};
