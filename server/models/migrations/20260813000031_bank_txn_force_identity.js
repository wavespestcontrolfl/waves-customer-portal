/**
 * Bank Import — DB-enforced replay identity for force-imported duplicates.
 *
 * A force confirmation records {forceToken, forcedFor} in `suggestion`; the
 * route's SELECT-then-INSERT replay check alone is racy (two concurrent
 * retries of the same confirmation can both see "no replay" and walk to
 * different free ordinals). This partial unique expression index makes the
 * confirmation identity atomic: the losing insert raises 23505, which the
 * route treats as already-present.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('bank_transactions'))) return;
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS bank_txn_force_identity_uniq
    ON bank_transactions (((suggestion->>'forceToken')), ((suggestion->>'forcedFor')))
    WHERE suggestion->>'forceToken' IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS bank_txn_force_identity_uniq');
};
