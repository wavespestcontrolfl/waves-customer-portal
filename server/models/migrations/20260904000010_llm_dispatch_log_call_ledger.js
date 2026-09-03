/**
 * LLM call ledger (agent-control S2a) — widens llm_dispatch_log from one
 * row per dispatch chain into the shared ledger every LLM row kind lives in:
 *
 *   row_kind  chain      one row per dispatchWithFallback chain (as before)
 *             call       one row per provider call — tokens, latency, the
 *                        model actually served, the lane / run / step it ran in
 *             session    one row per Anthropic Managed Agents session
 *             heartbeat  the recorder's hourly write-path probe (was
 *                        policy = '__heartbeat__'; backfilled below)
 *
 * The existing `model` column keeps its chain semantics (the model that
 * answered the chain); `requested_model` / `served_model` are per-call. All
 * additive, every column nullable (row_kind defaults to 'chain' so existing
 * rows and the untouched chain writer stay valid), guarded per column so a
 * partial earlier run is safe to re-run. Correlation ids (run / attempt /
 * step / trace / span) are written by the agent-control context when a
 * scope is active and stay null otherwise.
 */

const TABLE = 'llm_dispatch_log';

const COLUMNS = [
  ['row_kind', (t) => t.string('row_kind', 12).notNullable().defaultTo('chain')],
  ['chain_id', (t) => t.uuid('chain_id')],
  ['lane_id', (t) => t.string('lane_id', 80)],
  ['workflow_id', (t) => t.string('workflow_id', 80)],
  ['agent_version_id', (t) => t.uuid('agent_version_id')],
  ['workload', (t) => t.string('workload', 12)],
  ['requested_model', (t) => t.string('requested_model', 120)],
  ['served_model', (t) => t.string('served_model', 120)],
  ['input_tokens', (t) => t.integer('input_tokens')],
  ['cached_input_tokens', (t) => t.integer('cached_input_tokens')],
  ['cache_write_tokens', (t) => t.integer('cache_write_tokens')],
  ['output_tokens', (t) => t.integer('output_tokens')],
  ['reasoning_tokens', (t) => t.integer('reasoning_tokens')],
  ['latency_ms', (t) => t.integer('latency_ms')],
  ['error_class', (t) => t.string('error_class', 20)],
  ['error_code', (t) => t.string('error_code', 80)],
  ['prompt_version', (t) => t.string('prompt_version', 60)],
  ['provider_ref', (t) => t.string('provider_ref', 120)],
  ['work_item_id', (t) => t.uuid('work_item_id')],
  ['run_id', (t) => t.uuid('run_id')],
  ['attempt_id', (t) => t.uuid('attempt_id')],
  ['step_id', (t) => t.uuid('step_id')],
  ['trace_id', (t) => t.specificType('trace_id', 'char(32)')],
  ['span_id', (t) => t.specificType('span_id', 'char(16)')],
  ['parent_span_id', (t) => t.specificType('parent_span_id', 'char(16)')],
];

const INDEXES = [
  ['llm_dispatch_log_lane_created_idx', `CREATE INDEX IF NOT EXISTS llm_dispatch_log_lane_created_idx ON ${TABLE} (lane_id, created_at)`],
  ['llm_dispatch_log_run_idx', `CREATE INDEX IF NOT EXISTS llm_dispatch_log_run_idx ON ${TABLE} (run_id) WHERE run_id IS NOT NULL`],
  ['llm_dispatch_log_chain_idx', `CREATE INDEX IF NOT EXISTS llm_dispatch_log_chain_idx ON ${TABLE} (chain_id) WHERE chain_id IS NOT NULL`],
  ['llm_dispatch_log_row_kind_created_idx', `CREATE INDEX IF NOT EXISTS llm_dispatch_log_row_kind_created_idx ON ${TABLE} (row_kind, created_at)`],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [name, add] of COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, name)) continue;
    await knex.schema.alterTable(TABLE, (t) => { add(t); });
  }
  // Heartbeat rows predate row_kind; the digest now filters on row_kind, so
  // the historical probes must carry it or the day they cover reads as dead.
  await knex(TABLE).where('policy', '__heartbeat__').andWhere('row_kind', 'chain').update({ row_kind: 'heartbeat' });
  for (const [, sql] of INDEXES) await knex.raw(sql);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  for (const [name] of INDEXES) await knex.raw(`DROP INDEX IF EXISTS ${name}`);
  for (const [name] of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, name))) continue;
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(name); });
  }
};
