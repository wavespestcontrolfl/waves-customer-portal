/**
 * Migration — treatment_outcomes vision-delta scoring columns.
 *
 * Additive columns backing the before/after photo delta lane
 * (server/services/vision-delta.js):
 *   - vision_delta         jsonb   — full structured verdict from the VISION tier
 *   - vision_delta_score   integer — overall visual change, -100..100 (null when
 *                                    the pair was not comparable / low confidence)
 *   - vision_scored_at     timestamp — stamp = terminal (scored OR permanently
 *                                    given up); null + attempts < 3 = sweepable
 *   - vision_score_attempts integer — failed-attempt counter (give up at 3)
 *
 * Guarded per-column (same pattern as 20260414000019_lawn_intelligence_suite.js)
 * so re-runs and partially-applied environments are safe.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('treatment_outcomes'))) return;

  if (!(await knex.schema.hasColumn('treatment_outcomes', 'vision_delta'))) {
    await knex.schema.alterTable('treatment_outcomes', (t) => {
      t.jsonb('vision_delta');
    });
  }
  if (!(await knex.schema.hasColumn('treatment_outcomes', 'vision_delta_score'))) {
    await knex.schema.alterTable('treatment_outcomes', (t) => {
      t.integer('vision_delta_score'); // -100..100 overall visual change
    });
  }
  if (!(await knex.schema.hasColumn('treatment_outcomes', 'vision_scored_at'))) {
    await knex.schema.alterTable('treatment_outcomes', (t) => {
      t.timestamp('vision_scored_at');
    });
  }
  if (!(await knex.schema.hasColumn('treatment_outcomes', 'vision_score_attempts'))) {
    await knex.schema.alterTable('treatment_outcomes', (t) => {
      t.integer('vision_score_attempts').defaultTo(0);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('treatment_outcomes'))) return;

  for (const col of ['vision_delta', 'vision_delta_score', 'vision_scored_at', 'vision_score_attempts']) {
    if (await knex.schema.hasColumn('treatment_outcomes', col)) {
      await knex.schema.alterTable('treatment_outcomes', (t) => t.dropColumn(col));
    }
  }
};
