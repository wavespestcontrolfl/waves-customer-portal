/**
 * One-time burn record for voice-relay WebSocket upgrade tokens.
 *
 * The /ws/voice-agent upgrade is authorized by a per-call token (relay-protocol
 * mintCallToken). "Accepted once" was a per-process Map first, which is not a
 * guarantee in the shape this deploys: a second Railway instance — or the same
 * one after a restart — has an empty Map and would accept the replayed URL for
 * the rest of its five-minute life, and that replayed socket can spend Anthropic
 * tokens and write leads. The claim has to live where every instance can see it.
 *
 * The unique primary key IS the claim: INSERT … ON CONFLICT DO NOTHING returns a
 * row to exactly one racer and nothing to every replay, in one statement, so the
 * "is it burned" test and the write cannot be interleaved.
 *
 * The token is stored HASHED. It is short-lived, but it is still a credential
 * and this table is a durable, greppable place; a sha256 is all a burn check
 * needs. Rows are swept once they are older than any token can be valid.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('voice_relay_token_burns')) return;
  await knex.schema.createTable('voice_relay_token_burns', (t) => {
    t.string('token_hash', 64).primary(); // sha256 hex of the token — never the token
    t.string('call_sid', 64);
    t.timestamp('burned_at', { useTz: true }).defaultTo(knex.fn.now()).notNullable();
  });
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_voice_relay_token_burns_burned_at ON voice_relay_token_burns(burned_at)'
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('voice_relay_token_burns');
};
