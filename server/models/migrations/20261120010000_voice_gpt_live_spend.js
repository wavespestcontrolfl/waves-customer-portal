/**
 * voice_gpt_live_spend: the spend ledger of the Sandy GPT-Live trial (GATE_VOICE_GPT_LIVE_TEST, owner 2026-11-19,
 * $5 cap on OpenAI charges). One row per call that claimed a reservation.
 *
 * It is kept apart from call_log on purpose: the spam disposition (routes/admin-call-recordings.js) and the orphan
 * cleanup script delete call_log rows, and a deleted row must never give back spend OpenAI already billed. Nothing
 * deletes from this table.
 *
 * call_sid is the primary key, so a call claims one reservation, once (the cell route's insert, under an advisory
 * lock with the budget read). reserved_usd is the call's worst case. admitted_at is set once, when the call's stream
 * opens (relay-server.js); a row never admitted within the stream token's life is released at $0 by the next
 * reservation (a caller who hung up during the disclosure used nothing), and a released row can no longer be
 * admitted. cost_usd is written only when OpenAI's session.closed confirms the final usage, or 0 when the call never
 * reached OpenAI. The budget is SUM(COALESCE(cost_usd, reserved_usd)) over every row.
 *
 * Additive; down drops the table.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('voice_gpt_live_spend')) return;
  await knex.schema.createTable('voice_gpt_live_spend', (t) => {
    t.string('call_sid', 64).primary();
    t.decimal('reserved_usd', 10, 4).notNullable();
    t.decimal('cost_usd', 10, 4);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('admitted_at', { useTz: true });
    t.timestamp('settled_at', { useTz: true });
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('voice_gpt_live_spend');
};
