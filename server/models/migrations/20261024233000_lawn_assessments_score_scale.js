/**
 * Add lawn_assessments.score_scale — which score scale a lawn assessment's four
 * scores are on (owner 2026-10-24, lawn scoring review; GATE_LAWN_SCORE_SCALE_V2).
 *
 * NULL = scale 1, every row before this (weed control = 100 minus the model's
 * weed share of the lawn, color 1-10 x10, Condition from severity words).
 * 2 = scale 2 (the model's four 0-100 ratings against written anchors, kept as
 * read). Property history (lawn-assessment-history.js) compares only rows on one
 * scale, so the column is read on every history query. Nullable and additive:
 * no backfill, no default, nothing else changes.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  if (!(await knex.schema.hasColumn('lawn_assessments', 'score_scale'))) {
    await knex.schema.alterTable('lawn_assessments', (t) => {
      t.smallint('score_scale').nullable(); // NULL = scale 1; 2 = scale 2
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessments'))) return;
  if (await knex.schema.hasColumn('lawn_assessments', 'score_scale')) {
    await knex.schema.alterTable('lawn_assessments', (t) => {
      t.dropColumn('score_scale');
    });
  }
};
