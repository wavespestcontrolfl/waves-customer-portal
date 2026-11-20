/**
 * voice_gpt_live_ledger: the spend ledger of the Sandy GPT-Live trial (GATE_VOICE_GPT_LIVE_TEST, owner 2026-11-19,
 * $5 cap on OpenAI charges). One row per call that claimed a reservation.
 *
 * It supersedes voice_gpt_live_spend (20261120010000). That migration is frozen, and its down() drops its table: a
 * rollback, or a named migrate:down of it, would erase billed spend, and a re-run would free the full $5 again. This
 * ledger is permanent: down() always refuses (roll forward). up() drops the superseded table, which nothing ever wrote
 * (the trial never ran on it).
 *
 * It is kept apart from call_log on purpose: the spam disposition (routes/admin-call-recordings.js) and the orphan
 * cleanup script delete call_log rows, and a deleted row must never give back spend. Nothing deletes from this table.
 *
 * call_sid is the primary key: a call claims one reservation, once (the cell route's insert, under an advisory lock
 * with the budget read). reserved_usd is the call's worst case. admitted_at is set once, when the call's stream opens
 * (live-bridge.js); a row never admitted within the stream token's life is released at $0 by the next reservation,
 * and a released row cannot be admitted. cost_usd is written only when OpenAI's session.closed confirms the final
 * usage, or 0 when the call never started a session. The budget is SUM(COALESCE(cost_usd, reserved_usd)).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('voice_gpt_live_ledger'))) {
    await knex.schema.createTable('voice_gpt_live_ledger', (t) => {
      t.string('call_sid', 64).primary();
      t.decimal('reserved_usd', 10, 4).notNullable();
      t.decimal('cost_usd', 10, 4);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('admitted_at', { useTz: true });
      t.timestamp('settled_at', { useTz: true });
    });
  }
  await knex.schema.dropTableIfExists('voice_gpt_live_spend');
};

exports.down = async function down() {
  throw new Error('voice_gpt_live_ledger is the GPT-Live trial budget ledger and is permanent: roll forward, not back');
};
