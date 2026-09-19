// Codex round 3 on #4608 (P0 PRRT_kwDOR3YQi86j8Ydq): the service-details SMS
// cross-process claim gate had no way for a claim LOSER to learn the WINNER's
// refusal reason — the loser's polling only ever checked for a durable
// sms_log row (proof of an actual send), so a withheld winner (no send, no
// log row) fell through to the generic "claim held elsewhere" retryable
// failure (502) instead of the same generic 404 an unknown/ineligible token
// gets. That let a loser's response distinguish "withheld" (502) from
// "unknown" (404) by request timing alone — the existence-oracle leak
// AGENTS.md's public-route rule exists to close.
//
// `outcome` lets the winner stamp a durable, loser-readable refusal ('withheld')
// on the SAME claim row before it releases — nullable, no default, so an
// in-flight or successfully-sent claim reads as unset either way.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_send_claims'))) return;
  if (await knex.schema.hasColumn('sms_send_claims', 'outcome')) return;
  await knex.schema.alterTable('sms_send_claims', (t) => {
    t.string('outcome', 32).nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_send_claims'))) return;
  if (!(await knex.schema.hasColumn('sms_send_claims', 'outcome'))) return;
  await knex.schema.alterTable('sms_send_claims', (t) => {
    t.dropColumn('outcome');
  });
};
