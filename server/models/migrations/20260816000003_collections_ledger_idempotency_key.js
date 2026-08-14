/**
 * idempotency_key on collections_contact_ledger — lets a retryable caller
 * (the quiet-hours deferred replay) RESERVE its contact row before dispatch
 * exactly once: recheck retries re-hit the same key and reuse the standing
 * row instead of inserting duplicates. Plain unique index — Postgres allows
 * unlimited NULLs on a unique column, so the existing keyless writers are
 * untouched. Follow-up migration by design: 20260816000002 may already have
 * run in PR environments (never edit a shipped migration in place).
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasColumn('collections_contact_ledger', 'idempotency_key');
  if (!has) {
    await knex.schema.alterTable('collections_contact_ledger', (t) => {
      t.string('idempotency_key', 120).unique('collections_contact_ledger_idem_uniq');
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasColumn('collections_contact_ledger', 'idempotency_key');
  if (has) {
    await knex.schema.alterTable('collections_contact_ledger', (t) => {
      t.dropUnique(['idempotency_key'], 'collections_contact_ledger_idem_uniq');
      t.dropColumn('idempotency_key');
    });
  }
};
