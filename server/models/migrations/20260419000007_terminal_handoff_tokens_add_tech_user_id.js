/**
 * terminal_handoff_tokens.tech_user_id — enables per-tech rate-limit counts.
 *
 * Added in follow-up to the original slim replay-store schema when we moved
 * handoff-mint rate limiting out of in-memory express-rate-limit and into
 * Postgres (see POST /api/stripe/terminal/handoff). The rate check is now
 *
 *   SELECT COUNT(*) FROM terminal_handoff_tokens
 *    WHERE tech_user_id = :tech AND created_at > NOW() - INTERVAL '1 hour'
 *
 * executed inside the same transaction as the jti insert, serialized by a
 * pg_advisory_xact_lock keyed on tech_user_id. This gives us:
 *   - survives deploys (rows persist across process restarts)
 *   - correct under multi-instance scaling (all replicas hit one DB)
 *   - atomic count+insert (no TOCTOU race between concurrent mints)
 *
 * Nullable + ON DELETE SET NULL so a deactivated technician's ephemeral
 * rows don't block cleanup and so back-filled rows from before this
 * migration (dev only) don't blow up.
 */

exports.up = async function (knex) {
  const hasCol = await knex.schema.hasColumn('terminal_handoff_tokens', 'tech_user_id');
  if (hasCol) return;

  await knex.schema.alterTable('terminal_handoff_tokens', (t) => {
    t.uuid('tech_user_id').references('id').inTable('technicians').onDelete('SET NULL');
    t.index(['tech_user_id', 'created_at']);
  });
};

exports.down = async function (knex) {
  const hasCol = await knex.schema.hasColumn('terminal_handoff_tokens', 'tech_user_id');
  if (!hasCol) return;

  await knex.schema.alterTable('terminal_handoff_tokens', (t) => {
    t.dropIndex(['tech_user_id', 'created_at']);
    t.dropForeign(['tech_user_id']);
    t.dropColumn('tech_user_id');
  });
};
