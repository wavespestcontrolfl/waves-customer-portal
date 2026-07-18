/**
 * SMS sealed evaluation set — a locked exam for the house-voice drafter.
 *
 * Three tables:
 *   - sms_sealed_eval_items: frozen (inbound, day-of facts_block, human reply)
 *     triples selected from judged live drafts. Rows are NEVER updated after
 *     insert (retire via active=false); the facts_block snapshot is what makes
 *     replay drift-free — the drafter is graded against the facts it would
 *     actually have had that day, not today's schedule.
 *   - sms_sealed_eval_runs: one exam sitting — a (prompt_version, provider_leg)
 *     pair with aggregate scores and the paired-significance result vs a
 *     baseline run.
 *   - sms_sealed_eval_results: per-item verdicts for a run. UNIQUE(run_id,
 *     item_id) makes runs resumable (anti-join re-entry, judge-style).
 *
 * Exam drafts live ONLY here — never in message_drafts — so sealed replays can
 * never contaminate the live judge/graduation cohort metrics, and nothing in
 * this lane is reachable by any send path.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_sealed_eval_items'))) {
    await knex.schema.createTable('sms_sealed_eval_items', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      // Provenance + dedup: each live draft seeds at most one sealed item.
      t.uuid('source_draft_id').notNullable().unique()
        .references('id').inTable('message_drafts');
      t.uuid('customer_id');
      t.string('intent', 50);
      t.text('inbound_message').notNullable();
      // The facts block persisted on the source draft — the day-of snapshot.
      t.text('facts_block').notNullable();
      t.text('context_summary');
      // Ground truth: what the human actually sent (judge reference), and the
      // reply's sms_log id — the key the few-shot exemplar fetch excludes so
      // the drafter never studies from the exam's answer key.
      t.text('human_reply_text').notNullable();
      t.uuid('human_reply_sms_id');
      t.boolean('scheduling_intent').notNullable().defaultTo(false);
      t.timestamp('inbound_at');
      t.boolean('active').notNullable().defaultTo(true);
      t.string('schema_version', 40).notNullable().defaultTo('sms-sealed-eval.v1');
      t.timestamp('sealed_at').notNullable().defaultTo(knex.fn.now());
      t.index(['active', 'intent']);
    });
  }

  if (!(await knex.schema.hasTable('sms_sealed_eval_runs'))) {
    await knex.schema.createTable('sms_sealed_eval_runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('prompt_version', 40).notNullable();
      t.string('provider_leg', 20).notNullable();
      t.string('status', 20).notNullable().defaultTo('running');
      t.integer('items_total');
      t.integer('items_judged').notNullable().defaultTo(0);
      t.integer('unsafe_count').notNullable().defaultTo(0);
      t.decimal('avg_safety', 5, 2);
      t.decimal('avg_voice', 5, 2);
      t.decimal('avg_overall', 5, 2);
      t.jsonb('verdict_counts');
      t.uuid('baseline_run_id').references('id').inTable('sms_sealed_eval_runs');
      t.jsonb('significance');
      t.string('triggered_by', 100);
      t.text('error');
      t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('finished_at');
      t.index(['prompt_version', 'provider_leg', 'status']);
    });
    await knex.raw(`
      ALTER TABLE sms_sealed_eval_runs
        ADD CONSTRAINT sms_sealed_eval_runs_status_check
        CHECK (status IN ('running', 'complete', 'failed')),
        ADD CONSTRAINT sms_sealed_eval_runs_leg_check
        CHECK (provider_leg IN ('anthropic', 'openai'))
    `);
    // At most ONE run may be processing at a time — processing is serialized
    // behind a single advisory lock, so a second 'running' row would sit
    // unprocessed and read as wedged. The app checks first for a friendly
    // 409; this index makes the invariant hold under concurrent creates.
    await knex.raw(`
      CREATE UNIQUE INDEX sms_sealed_eval_runs_one_running
        ON sms_sealed_eval_runs ((TRUE))
        WHERE status = 'running'
    `);
  }

  if (!(await knex.schema.hasTable('sms_sealed_eval_results'))) {
    await knex.schema.createTable('sms_sealed_eval_results', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('run_id').notNullable()
        .references('id').inTable('sms_sealed_eval_runs').onDelete('CASCADE');
      t.uuid('item_id').notNullable()
        .references('id').inTable('sms_sealed_eval_items');
      t.text('draft_response');
      t.string('model', 80);
      t.integer('passes');
      t.boolean('converged');
      t.string('verdict', 20);
      t.jsonb('scores');
      t.text('notes');
      t.string('judge_model', 80);
      t.integer('draft_ms');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['run_id', 'item_id']);
      t.index('item_id');
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_sealed_eval_results')) {
    await knex.schema.dropTable('sms_sealed_eval_results');
  }
  if (await knex.schema.hasTable('sms_sealed_eval_runs')) {
    await knex.schema.dropTable('sms_sealed_eval_runs');
  }
  if (await knex.schema.hasTable('sms_sealed_eval_items')) {
    await knex.schema.dropTable('sms_sealed_eval_items');
  }
};
