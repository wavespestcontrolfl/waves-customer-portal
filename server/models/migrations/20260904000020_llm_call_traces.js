/**
 * LLM call traces (agent-control S2a) — the REDACTED prompt / system /
 * response bodies for one ledger call row, kept only for lanes whose runtime
 * policy opts in (`trace: true` in agent-control/lane-policies.js) while
 * GATE_LLM_CALL_TRACES is on. Bodies pass through content/pii-redactor.js
 * before they are written and are capped per column; inbound lanes skip the
 * write entirely when redaction confidence is low.
 *
 * Rows hang off llm_dispatch_log(id) with ON DELETE CASCADE and are pruned
 * after 7 days by the dispatch digest (independently of the 30-day ledger
 * prune) — traces are debugging material, not history.
 */

const TABLE = 'llm_call_traces';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.bigIncrements('id').primary();
    t.integer('call_id').references('id').inTable('llm_dispatch_log').onDelete('CASCADE');
    t.string('lane_id', 80);
    t.uuid('run_id');
    t.text('system_redacted');
    t.text('prompt_redacted');
    t.text('response_redacted');
    t.string('redaction_confidence', 8);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['created_at'], 'llm_call_traces_created_at_idx');
    t.index(['run_id'], 'llm_call_traces_run_id_idx');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
