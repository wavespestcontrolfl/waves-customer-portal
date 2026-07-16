/**
 * Durable customer refresh-token sessions.
 *
 * Only SHA-256 token fingerprints are stored. Each successful refresh consumes
 * one row and creates its replacement in the same family. Reuse of a consumed
 * row revokes the family, containing a stolen-token replay.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('customer_refresh_tokens', (t) => {
    t.string('jti', 64).primary();
    t.uuid('family_id').notNullable();
    t.uuid('customer_id').notNullable()
      .references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('account_id').notNullable()
      .references('id').inTable('customer_accounts').onDelete('CASCADE');
    t.string('token_hash', 64).notNullable().unique();
    t.string('parent_jti', 64).nullable();
    t.string('replaced_by_jti', 64).nullable();
    t.timestamp('expires_at', { useTz: true }).notNullable();
    t.timestamp('consumed_at', { useTz: true }).nullable();
    t.timestamp('revoked_at', { useTz: true }).nullable();
    t.string('revoke_reason', 64).nullable();
    t.timestamps(true, true);

    t.index(['family_id'], 'customer_refresh_tokens_family_idx');
    t.index(['customer_id'], 'customer_refresh_tokens_customer_idx');
    t.index(['account_id'], 'customer_refresh_tokens_account_idx');
    t.index(['expires_at'], 'customer_refresh_tokens_expiry_idx');
  });

  // Exactly one live token per device/session family. The application also
  // serializes rotations with SELECT ... FOR UPDATE; this index is the final
  // database-level guard against parallel descendants.
  await knex.raw(`
    CREATE UNIQUE INDEX customer_refresh_tokens_one_live_per_family_idx
      ON customer_refresh_tokens (family_id)
      WHERE consumed_at IS NULL AND revoked_at IS NULL
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customer_refresh_tokens');
};
