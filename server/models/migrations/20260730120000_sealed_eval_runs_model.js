/**
 * Sealed exam runs record WHICH MODEL drafted them (Codex r12, PR #3076):
 * the openai leg's model changed Luna → Sol with the routing flip, and the
 * default baseline picker (same leg, different prompt version) would compare
 * a v10 Sol run against a v9 Luna run — attributing a simultaneous
 * model-and-prompt change to the prompt. Runs now stamp their model and the
 * picker requires a same-model baseline (no candidate → no default baseline,
 * which is honest). Historical rows are backfilled with the models their
 * legs meant at the time.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('sms_sealed_eval_runs', 'model');
  if (!has) {
    await knex.schema.alterTable('sms_sealed_eval_runs', (t) => {
      t.string('model', 80);
    });
  }
  // Historically accurate backfill: every anthropic-leg run to date drafted
  // on Sonnet; every openai-leg run drafted on Luna (the Sol rebind ships in
  // the same PR as this migration, so no pre-existing Sol rows exist).
  await knex('sms_sealed_eval_runs').where({ provider_leg: 'anthropic' }).whereNull('model').update({ model: 'claude-sonnet-5' });
  await knex('sms_sealed_eval_runs').where({ provider_leg: 'openai' }).whereNull('model').update({ model: 'gpt-5.6-luna' });
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('sms_sealed_eval_runs', 'model');
  if (has) {
    await knex.schema.alterTable('sms_sealed_eval_runs', (t) => {
      t.dropColumn('model');
    });
  }
};
