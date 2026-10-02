/**
 * ai_replay_runs + ai_replay_results — the proof step of the correction loop
 * (scope 2026-10-02 piece 3). A run replays one fix proposal's dev or holdout
 * incidents against a candidate fix and records, per incident, whether the
 * mistake still happens.
 *
 * Owner ruling 2026-10-02: replays make NO provider call. The lane exports the
 * frozen cases to its scratchpad, Claude Code subagents re-draft and grade
 * them, and the verdicts are imported here (`method` 'subagent'), so
 * `exact_production_model` is false on every such run and the report says
 * so. `method` 'code' is for a deterministic check that needs no model.
 *
 * Results-only tables, like the sealed exam's: nothing here ever writes
 * message_drafts, and `reason` is a short code or sentence, never customer
 * text. Status is computed by services/ai-incidents/replay-runs.js
 * (passed / failed / inconclusive / underpowered). Nothing reads these
 * tables at runtime; not granted to the read-only chart role.
 */

const SPLITS = ['dev', 'holdout'];
const METHODS = ['subagent', 'code'];
const RUN_STATUSES = ['passed', 'failed', 'inconclusive', 'underpowered'];
const VERDICTS = ['fixed', 'reproduces', 'inconclusive'];

exports.SPLITS = SPLITS;
exports.METHODS = METHODS;
exports.RUN_STATUSES = RUN_STATUSES;
exports.VERDICTS = VERDICTS;

const list = (values) => values.map((v) => `'${v}'`).join(', ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ai_replay_runs'))) {
    await knex.schema.createTable('ai_replay_runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('area', 30).notNullable();
      t.uuid('proposal_id').references('id').inTable('ai_fix_proposals').onDelete('SET NULL');
      t.string('split', 10).notNullable();
      t.string('method', 20).notNullable();
      // The prompt version the replayed code renders, and the commit it ran.
      t.string('prompt_version', 60);
      t.string('code_ref', 64).notNullable();
      t.string('drafter_model', 80);
      t.boolean('exact_production_model').notNullable().defaultTo(false);
      t.string('status', 20).notNullable();
      t.integer('case_count').notNullable();
      t.integer('fixed_count').notNullable();
      t.integer('reproduces_count').notNullable();
      t.integer('inconclusive_count').notNullable();
      t.text('notes');
      t.string('created_by', 80).notNullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.index(['proposal_id', 'split'], 'ai_replay_runs_proposal_idx');
    });
    await knex.raw(`ALTER TABLE ai_replay_runs ADD CONSTRAINT ai_replay_runs_split_check CHECK (split IN (${list(SPLITS)}))`);
    await knex.raw(`ALTER TABLE ai_replay_runs ADD CONSTRAINT ai_replay_runs_method_check CHECK (method IN (${list(METHODS)}))`);
    await knex.raw(`ALTER TABLE ai_replay_runs ADD CONSTRAINT ai_replay_runs_status_check CHECK (status IN (${list(RUN_STATUSES)}))`);
    await knex.raw(`
      ALTER TABLE ai_replay_runs ADD CONSTRAINT ai_replay_runs_counts_check CHECK (
        case_count = fixed_count + reproduces_count + inconclusive_count
        AND fixed_count >= 0 AND reproduces_count >= 0 AND inconclusive_count >= 0
      )
    `);
  }
  if (!(await knex.schema.hasTable('ai_replay_results'))) {
    await knex.schema.createTable('ai_replay_results', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('run_id').notNullable().references('id').inTable('ai_replay_runs').onDelete('CASCADE');
      t.string('incident_key', 64).notNullable();
      t.string('verdict', 20).notNullable();
      t.string('reason', 300);
      t.jsonb('evidence').notNullable().defaultTo('{}');
      t.unique(['run_id', 'incident_key'], { indexName: 'ai_replay_results_run_incident_unique' });
    });
    await knex.raw(`ALTER TABLE ai_replay_results ADD CONSTRAINT ai_replay_results_verdict_check CHECK (verdict IN (${list(VERDICTS)}))`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_replay_results');
  await knex.schema.dropTableIfExists('ai_replay_runs');
};
