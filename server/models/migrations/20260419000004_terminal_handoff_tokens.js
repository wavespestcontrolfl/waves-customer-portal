/**
 * terminal_handoff_tokens — replay-protection store for Tap to Pay deep links.
 *
 * When a tech hits "Collect Payment" in the PWA, the server mints a 60-second
 * HMAC-JWT and embeds its jti in a wavespay:// deep link. The native iOS app
 * POSTs to /validate-handoff; the atomic UPDATE ... WHERE used_at IS NULL
 * flips the row in a single statement — second attempt finds used_at NOT NULL
 * and is rejected.
 *
 * Scope: ephemeral. Rows are useful for ~60 seconds. A nightly cron in
 * scheduler.js deletes rows where expires_at < NOW() - INTERVAL '1 hour'
 * so the table doesn't grow unbounded.
 *
 * Mint audit (who/what/when/from-where) lives separately in audit_log, which
 * is permanent. The jti is written as a plain string reference in audit_log
 * (no FK, since the row here disappears on cleanup).
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasTable('terminal_handoff_tokens');
  if (has) return;

  await knex.schema.createTable('terminal_handoff_tokens', (t) => {
    t.string('jti', 64).primary();
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.index(['expires_at']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('terminal_handoff_tokens');
};
