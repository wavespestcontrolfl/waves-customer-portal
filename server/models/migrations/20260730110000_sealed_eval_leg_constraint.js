/**
 * Extend sms_sealed_eval_runs' provider_leg CHECK to the six-model exam
 * (Codex r5, PR #3076): the original constraint allowed only
 * anthropic/openai, so every createExamRun insert for the new measurement
 * legs (gemini/luna/opus/fable) would die on a check-constraint violation
 * before a single item ran. Down restores the original pair — safe only
 * once measurement-leg rows are deleted, so down() clears them first.
 */

const LEGS = ['anthropic', 'openai', 'gemini', 'luna', 'opus', 'fable'];

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE sms_sealed_eval_runs DROP CONSTRAINT IF EXISTS sms_sealed_eval_runs_leg_check');
  await knex.raw(`
    ALTER TABLE sms_sealed_eval_runs
      ADD CONSTRAINT sms_sealed_eval_runs_leg_check
      CHECK (provider_leg IN (${LEGS.map((l) => `'${l}'`).join(', ')}))
  `);
};

exports.down = async function down(knex) {
  await knex('sms_sealed_eval_runs').whereNotIn('provider_leg', ['anthropic', 'openai']).del();
  await knex.raw('ALTER TABLE sms_sealed_eval_runs DROP CONSTRAINT IF EXISTS sms_sealed_eval_runs_leg_check');
  await knex.raw(`
    ALTER TABLE sms_sealed_eval_runs
      ADD CONSTRAINT sms_sealed_eval_runs_leg_check
      CHECK (provider_leg IN ('anthropic', 'openai'))
  `);
};
