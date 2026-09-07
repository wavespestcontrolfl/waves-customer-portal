/**
 * DB-backed schema checks for the agent runs migration
 * (20260905000010_agent_runs): the six tables, their unique keys, CHECK
 * vocabularies and the watchdog's partial indexes.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`) — the
 * same convention as llm-dispatch-log-schema.test.js.
 */
const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('agent runs schema', () => {
  let knex;
  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  test('the six tables exist with their key columns', async () => {
    for (const [table, cols] of Object.entries({
      work_items: ['source_system', 'source_ref', 'lane_id', 'workflow_id', 'customer_id', 'status', 'risk_tier', 'priority'],
      agent_runs: ['work_item_id', 'lane_id', 'workflow_id', 'source_system', 'source_run_id', 'trace_id', 'lifecycle', 'result', 'verification', 'disposition', 'failure_class', 'error_code', 'error_message', 'worker_id', 'leased_at', 'lease_expires_at', 'started_at', 'finished_at', 'last_heartbeat_at', 'progress_sequence', 'last_progress_at', 'attempts', 'max_attempts', 'idempotency_key', 'side_effect_class', 'risk_tier', 'summary', 'link'],
      agent_attempts: ['run_id', 'attempt_no', 'worker_id', 'started_at', 'finished_at', 'result', 'failure_class', 'error_code', 'error_message'],
      agent_run_steps: ['run_id', 'attempt_id', 'seq', 'step_key', 'label', 'status', 'tool_name', 'started_at', 'finished_at', 'duration_ms', 'detail', 'span_id', 'parent_span_id'],
      run_artifacts: ['run_id', 'kind', 'label', 'ref', 'content_redacted', 'redaction_confidence'],
      run_events: ['run_id', 'event_type', 'message', 'metadata'],
    })) {
      const info = await knex(table).columnInfo();
      cols.forEach((c) => expect(info).toHaveProperty(c));
    }
    const runs = await knex('agent_runs').columnInfo();
    expect(runs.lifecycle.defaultValue).toMatch(/queued/);
    expect(runs.verification.defaultValue).toMatch(/unjudged/);
    expect(runs.source_run_id.nullable).toBe(false);
  });

  test('unique keys, CHECKs and the watchdog partial indexes are in place', async () => {
    const { rows } = await knex.raw("SELECT tablename, indexname FROM pg_indexes WHERE tablename IN ('work_items','agent_runs','agent_attempts','agent_run_steps','run_artifacts','run_events')");
    const names = rows.map((r) => r.indexname);
    ['work_items_source_uidx', 'agent_runs_source_uidx', 'agent_runs_idempotency_uidx', 'agent_attempts_run_no_uidx', 'agent_runs_lease_idx', 'agent_runs_open_idx', 'agent_run_steps_run_seq_idx', 'run_events_run_created_idx'].forEach((i) => expect(names).toContain(i));
    const checks = (await knex.raw("SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('agent_runs'::regclass, 'work_items'::regclass, 'agent_run_steps'::regclass, 'run_artifacts'::regclass)")).rows.map((r) => r.conname);
    ['agent_runs_scope_chk', 'agent_runs_lifecycle_chk', 'agent_runs_result_chk', 'agent_runs_verification_chk', 'agent_runs_disposition_chk', 'work_items_status_chk', 'agent_run_steps_status_chk', 'run_artifacts_kind_chk'].forEach((c) => expect(checks).toContain(c));
    // a run needs a lane or a workflow
    await expect(knex('agent_runs').insert({ source_system: '__schema_test__', source_run_id: 'x' })).rejects.toThrow(/agent_runs_scope_chk/);
  });
});
