/**
 * DB-backed schema checks for the call-ledger migrations
 * (20260904000010_llm_dispatch_log_call_ledger + 20260904000020_llm_call_traces):
 * the per-call columns on llm_dispatch_log, its new indexes, the heartbeat
 * row_kind backfill semantics, and the llm_call_traces table.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`) — the
 * same convention as auto-dispatch-schema.test.js.
 */
const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const CALL_COLUMNS = [
  'row_kind', 'chain_id', 'lane_id', 'workflow_id', 'agent_version_id', 'workload', 'requested_model', 'served_model',
  'input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens', 'latency_ms',
  'error_class', 'error_code', 'prompt_version', 'provider_ref', 'work_item_id', 'run_id', 'attempt_id', 'step_id',
  'trace_id', 'span_id', 'parent_span_id',
];
const INDEXES = ['llm_dispatch_log_lane_created_idx', 'llm_dispatch_log_run_idx', 'llm_dispatch_log_chain_idx', 'llm_dispatch_log_row_kind_created_idx'];

describeOrSkip('llm call ledger schema', () => {
  let knex;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  test('llm_dispatch_log gains the per-call ledger columns; row_kind defaults to chain', async () => {
    const cols = await knex('llm_dispatch_log').columnInfo();
    CALL_COLUMNS.forEach((c) => expect(cols).toHaveProperty(c));
    expect(cols.row_kind.nullable).toBe(false);
    expect(cols.row_kind.defaultValue).toMatch(/chain/);
    expect(cols.chain_id.type).toBe('uuid');
    expect(cols.trace_id.type).toMatch(/char/);
    // the chain-era columns are untouched
    ['policy', 'ok', 'provider', 'model', 'fallback_used', 'failure_reasons', 'created_at'].forEach((c) => expect(cols).toHaveProperty(c));
  });

  test('the ledger indexes exist', async () => {
    const { rows } = await knex.raw("SELECT indexname FROM pg_indexes WHERE tablename = 'llm_dispatch_log'");
    const names = rows.map((r) => r.indexname);
    INDEXES.forEach((i) => expect(names).toContain(i));
  });

  test('llm_call_traces exists, cascades from its call row, and is indexed on created_at + run_id', async () => {
    const cols = await knex('llm_call_traces').columnInfo();
    ['id', 'call_id', 'lane_id', 'run_id', 'system_redacted', 'prompt_redacted', 'response_redacted', 'redaction_confidence', 'created_at']
      .forEach((c) => expect(cols).toHaveProperty(c));
    const { rows } = await knex.raw("SELECT indexname FROM pg_indexes WHERE tablename = 'llm_call_traces'");
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('llm_call_traces_created_at_idx');
    expect(names).toContain('llm_call_traces_run_id_idx');

    const [call] = await knex('llm_dispatch_log')
      .insert({ policy: '__schema_test__', ok: true, row_kind: 'call', provider: 'openai', input_tokens: 1, output_tokens: 1 })
      .returning('id');
    const callId = typeof call === 'object' ? call.id : call;
    await knex('llm_call_traces').insert({ call_id: callId, lane_id: 'schema_test', prompt_redacted: 'p', redaction_confidence: 'high' });
    expect(await knex('llm_call_traces').where({ call_id: callId }).count({ n: '*' }).first()).toMatchObject({ n: expect.anything() });
    await knex('llm_dispatch_log').where({ id: callId }).del();
    const left = await knex('llm_call_traces').where({ call_id: callId }).count({ n: '*' }).first();
    expect(Number(left.n)).toBe(0);
  });

  test('a chain-era insert (no row_kind) still lands as a chain row', async () => {
    const [row] = await knex('llm_dispatch_log')
      .insert({ policy: '__schema_test__', ok: false, failure_reasons: JSON.stringify([]) })
      .returning(['id', 'row_kind']);
    expect(row.row_kind).toBe('chain');
    await knex('llm_dispatch_log').where({ id: row.id }).del();
  });
});
