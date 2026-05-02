// Pre-Phase-2 data prep — small migration that lands two changes the
// plan engine will read without expanding PR 2.0's scope:
//
// 1. sun_exposure value rename: 'shade' → 'heavy_shade'
//    The original validator + UI used 'shade'. PR 2.0's planner
//    treats sun exposure as a modifier (not a track) and uses
//    'heavy_shade' so the value name itself signals severity. Any
//    rows already storing 'shade' are normalized in-place; the
//    validator + UI option list update in the same PR ensures no
//    new 'shade' rows can be inserted.
//
// 2. lawn_assessments.stress_flags jsonb (transient, per-visit)
//    Distinct from customer_turf_profiles.known_*_history (stable
//    property characteristics). The planner reads stress_flags to
//    gate hot herbicides / PGR / etc. on a per-assessment basis,
//    because a property can be "drought-stressed today" without
//    having "known_drought_history" set.
//
//    Default null (not {}) — fewer rows touched on initial migration,
//    and the planner treats null + missing keys as "no signal,
//    proceed normally". When the tech confirms an assessment with
//    explicit stress flags, the row stores them.
//
// Idempotent throughout. Down-migration is symmetric.

exports.up = async function (knex) {
  // ── 1. sun_exposure rename ──────────────────────────────────────────
  if (await knex.schema.hasTable('customer_turf_profiles')) {
    // Normalize any existing 'shade' rows in place. WHERE clause is
    // safe even when no such rows exist (just a no-op UPDATE).
    await knex('customer_turf_profiles')
      .where({ sun_exposure: 'shade' })
      .update({ sun_exposure: 'heavy_shade', updated_at: new Date() });
  }

  // ── 2. lawn_assessments.stress_flags ────────────────────────────────
  if (await knex.schema.hasTable('lawn_assessments')) {
    if (!(await knex.schema.hasColumn('lawn_assessments', 'stress_flags'))) {
      await knex.schema.alterTable('lawn_assessments', (t) => {
        t.jsonb('stress_flags').nullable();
      });
    }
  }
};

exports.down = async function (knex) {
  // Drop the stress_flags column on rollback. We do NOT reverse the
  // sun_exposure rename — once the planner is live, reverting to
  // 'shade' would reintroduce ambiguity. A future rollback that
  // truly needs the old value can do it explicitly.
  if (await knex.schema.hasTable('lawn_assessments')) {
    if (await knex.schema.hasColumn('lawn_assessments', 'stress_flags')) {
      await knex.schema.alterTable('lawn_assessments', (t) => {
        t.dropColumn('stress_flags');
      });
    }
  }
};
