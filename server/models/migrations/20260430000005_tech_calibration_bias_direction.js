// Adds the missing bias_direction column on tech_calibration.
//
// Drift fix #1 of PR 0.4. services/lawn-intelligence.js:723 writes
// `bias_direction` ('higher' | 'lower' | 'mixed') alongside the
// avg_delta tally inside recordTechCalibration, but no migration
// ever created the column — same drift family as PR 0.1's
// fawn_snapshot. The insert silently fails inside the confirm-route
// setImmediate fanout, so calibration data never lands even though
// the rest of the row would compute correctly.
//
// The column is meaningful: it tells us whether a tech tends to
// score lawns more generously than the AI, more conservatively, or
// inconsistently — a calibration signal we'll use for tech-coaching
// dashboards once enough data accrues.
//
// Idempotent via hasColumn guard. Optional CHECK constraint pins
// the value set so a typo can't turn the column into freeform text.

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('tech_calibration'))) return;
  if (await knex.schema.hasColumn('tech_calibration', 'bias_direction')) return;

  await knex.schema.alterTable('tech_calibration', (t) => {
    t.text('bias_direction').nullable();
  });

  await knex.raw(`
    ALTER TABLE tech_calibration
    ADD CONSTRAINT tech_calibration_bias_direction_check
    CHECK (bias_direction IS NULL OR bias_direction IN ('higher', 'lower', 'mixed'))
  `);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('tech_calibration'))) return;
  if (!(await knex.schema.hasColumn('tech_calibration', 'bias_direction'))) return;

  await knex.raw(`
    ALTER TABLE tech_calibration
    DROP CONSTRAINT IF EXISTS tech_calibration_bias_direction_check
  `);
  await knex.schema.alterTable('tech_calibration', (t) => {
    t.dropColumn('bias_direction');
  });
};
