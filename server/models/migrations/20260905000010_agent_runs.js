/**
 * Agent runs (agent-control S3) — the run ledger every supervised lane
 * writes through services/agent-control/runs.js while GATE_AGENT_RUNS is on.
 *
 *   work_items      what was asked (one per source record: a call, a lead,
 *                   a content opportunity …), UNIQUE (source_system, source_ref)
 *   agent_runs      one attempt-set at a work item by a lane / workflow,
 *                   UNIQUE (source_system, source_run_id) so a legacy ledger
 *                   row (autonomous_runs, call_log …) mirrors onto exactly
 *                   one run; lifecycle / result / verification / disposition
 *                   are the taxonomy vocabularies (health is derived, never
 *                   stored)
 *   agent_attempts  one row per attempt (retries), UNIQUE (run_id, attempt_no)
 *   agent_run_steps the timeline inside an attempt (seq, tool, timings, spans)
 *   run_artifacts   what a run produced (draft | report | json | url | record_ref)
 *   run_events      the audit trail (queued … disposition); heartbeats update
 *                   columns on agent_runs only and never write here
 *
 * Shape follows email_template_automation_runs + _run_events. Dark: no
 * writer runs until the gate is set, so the tables only cost the migration.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('work_items'))) {
    await knex.schema.createTable('work_items', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('lane_id', 80);
      t.string('workflow_id', 80);
      t.string('source_system', 60).notNullable();
      t.string('source_ref', 180).notNullable();
      t.string('entity_type', 80);
      t.string('entity_id', 120);
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.string('title', 300);
      t.string('status', 20).notNullable().defaultTo('open');
      t.smallint('risk_tier');
      t.string('priority', 4);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['source_system', 'source_ref'], { indexName: 'work_items_source_uidx' });
      t.index(['lane_id', 'created_at'], 'work_items_lane_created_idx');
      t.index(['entity_type', 'entity_id'], 'work_items_entity_idx');
    });
    await knex.raw("ALTER TABLE work_items ADD CONSTRAINT work_items_status_chk CHECK (status IN ('open', 'done', 'canceled'))");
  }

  if (!(await knex.schema.hasTable('agent_runs'))) {
    await knex.schema.createTable('agent_runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('work_item_id').references('id').inTable('work_items').onDelete('SET NULL');
      t.string('lane_id', 80);
      t.string('workflow_id', 80);
      t.uuid('agent_version_id');
      t.string('source_system', 60).notNullable();
      t.string('source_run_id', 180).notNullable();
      t.specificType('trace_id', 'char(32)');
      t.string('lifecycle', 20).notNullable().defaultTo('queued');
      t.string('result', 20);
      t.string('verification', 20).notNullable().defaultTo('unjudged');
      t.string('disposition', 20);
      t.string('failure_class', 20);
      t.string('error_code', 80);
      t.text('error_message');
      t.string('worker_id', 120);
      t.timestamp('leased_at', { useTz: true });
      t.timestamp('lease_expires_at', { useTz: true });
      t.timestamp('started_at', { useTz: true });
      t.timestamp('finished_at', { useTz: true });
      t.timestamp('last_heartbeat_at', { useTz: true });
      t.integer('progress_sequence').notNullable().defaultTo(0);
      t.timestamp('last_progress_at', { useTz: true });
      t.integer('attempts').notNullable().defaultTo(0);
      t.integer('max_attempts').notNullable().defaultTo(1);
      t.string('idempotency_key', 260).unique({ indexName: 'agent_runs_idempotency_uidx' });
      t.string('side_effect_class', 24);
      t.smallint('risk_tier');
      t.jsonb('summary').notNullable().defaultTo('{}');
      t.text('link');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['source_system', 'source_run_id'], { indexName: 'agent_runs_source_uidx' });
      t.index(['lane_id', 'created_at'], 'agent_runs_lane_created_idx');
      t.index(['workflow_id', 'created_at'], 'agent_runs_workflow_created_idx');
      t.index(['work_item_id'], 'agent_runs_work_item_idx');
      t.index(['created_at'], 'agent_runs_created_idx');
    });
    await knex.raw('ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_scope_chk CHECK (lane_id IS NOT NULL OR workflow_id IS NOT NULL)');
    await knex.raw("ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_lifecycle_chk CHECK (lifecycle IN ('queued', 'leased', 'running', 'waiting_external', 'waiting_human', 'terminal'))");
    await knex.raw("ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_result_chk CHECK (result IS NULL OR result IN ('succeeded', 'errored', 'timed_out', 'canceled', 'budget_exhausted'))");
    await knex.raw("ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_verification_chk CHECK (verification IN ('unjudged', 'passed', 'warning', 'failed', 'overridden'))");
    await knex.raw("ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_disposition_chk CHECK (disposition IS NULL OR disposition IN ('applied', 'drafted', 'no_action', 'rejected', 'rolled_back'))");
    // The watchdog's two scans: leases that lapsed on a run still held, and
    // everything not yet terminal (small by construction).
    await knex.raw("CREATE INDEX agent_runs_lease_idx ON agent_runs (lease_expires_at) WHERE lifecycle IN ('leased', 'running')");
    await knex.raw("CREATE INDEX agent_runs_open_idx ON agent_runs (created_at) WHERE lifecycle <> 'terminal'");
  }

  if (!(await knex.schema.hasTable('agent_attempts'))) {
    await knex.schema.createTable('agent_attempts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('run_id').notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
      t.integer('attempt_no').notNullable();
      t.string('worker_id', 120);
      t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('finished_at', { useTz: true });
      t.string('result', 20);
      t.string('failure_class', 20);
      t.string('error_code', 80);
      t.text('error_message');
      t.unique(['run_id', 'attempt_no'], { indexName: 'agent_attempts_run_no_uidx' });
    });
  }

  if (!(await knex.schema.hasTable('agent_run_steps'))) {
    await knex.schema.createTable('agent_run_steps', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('run_id').notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
      t.uuid('attempt_id').references('id').inTable('agent_attempts').onDelete('SET NULL');
      t.integer('seq').notNullable();
      t.string('step_key', 80).notNullable();
      t.string('label', 200);
      t.string('status', 12).notNullable().defaultTo('running');
      t.string('tool_name', 120);
      t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('finished_at', { useTz: true });
      t.integer('duration_ms');
      t.text('detail');
      t.specificType('span_id', 'char(16)');
      t.specificType('parent_span_id', 'char(16)');
      t.index(['run_id', 'seq'], 'agent_run_steps_run_seq_idx');
    });
    await knex.raw("ALTER TABLE agent_run_steps ADD CONSTRAINT agent_run_steps_status_chk CHECK (status IN ('running', 'done', 'blocked', 'failed', 'skipped'))");
  }

  if (!(await knex.schema.hasTable('run_artifacts'))) {
    await knex.schema.createTable('run_artifacts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('run_id').notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
      t.string('kind', 12).notNullable();
      t.string('label', 200);
      t.text('ref');
      t.text('content_redacted');
      t.string('redaction_confidence', 8);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['run_id', 'created_at'], 'run_artifacts_run_created_idx');
    });
    await knex.raw("ALTER TABLE run_artifacts ADD CONSTRAINT run_artifacts_kind_chk CHECK (kind IN ('draft', 'report', 'json', 'url', 'record_ref'))");
  }

  if (!(await knex.schema.hasTable('run_events'))) {
    await knex.schema.createTable('run_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('run_id').notNullable().references('id').inTable('agent_runs').onDelete('CASCADE');
      t.string('event_type', 40).notNullable();
      t.text('message');
      t.jsonb('metadata').notNullable().defaultTo('{}');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['run_id', 'created_at'], 'run_events_run_created_idx');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('run_events');
  await knex.schema.dropTableIfExists('run_artifacts');
  await knex.schema.dropTableIfExists('agent_run_steps');
  await knex.schema.dropTableIfExists('agent_attempts');
  await knex.schema.dropTableIfExists('agent_runs');
  await knex.schema.dropTableIfExists('work_items');
};
