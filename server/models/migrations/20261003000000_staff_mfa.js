/**
 * Staff two-step sign-in (GATE_ADMIN_MFA) — an authenticator-app code
 * (TOTP, RFC 6238) after the password, plus single-use recovery codes.
 *
 * technicians.mfa_enabled_at — set when a staff member finishes enrolling,
 *   cleared when they turn it off. The only MFA fact the per-request auth
 *   check reads (it already loads the technicians row). No secret here.
 *
 * staff_mfa_totp — one row per staff member. `secret_enc` is the ACTIVE
 *   authenticator secret, `pending_secret_enc` a setup not yet confirmed
 *   with a code. Both are pgcrypto-encrypted (armor(pgp_sym_encrypt), key
 *   STAFF_MFA_KEY → falls back to DATA_HYGIENE_VAULT_KEY, the same pattern as
 *   plaid_items.access_token_enc) and never leave the server after setup.
 *   `last_used_step` is the 30-second TOTP time step of the last accepted
 *   code: a code is accepted only for a LATER step, so a code cannot be
 *   used twice. `failed_attempts` / `locked_until` are the per-account
 *   lockout after repeated wrong codes.
 *
 * staff_mfa_recovery_codes — SHA-256 of each recovery code (80 random bits,
 *   so the hash cannot be brute-forced back); `used_at` makes each one
 *   single-use.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('technicians')) {
    if (!(await knex.schema.hasColumn('technicians', 'mfa_enabled_at'))) {
      await knex.schema.alterTable('technicians', (t) => {
        t.timestamp('mfa_enabled_at', { useTz: true });
      });
    }
  }

  if (!(await knex.schema.hasTable('staff_mfa_totp'))) {
    await knex.schema.createTable('staff_mfa_totp', (t) => {
      t.uuid('technician_id').primary().references('id').inTable('technicians').onDelete('CASCADE');
      t.text('secret_enc');
      t.text('pending_secret_enc');
      t.timestamp('pending_created_at', { useTz: true });
      t.bigInteger('last_used_step');
      t.integer('failed_attempts').notNullable().defaultTo(0);
      t.timestamp('locked_until', { useTz: true });
      t.timestamps(true, true);
    });
  }

  if (!(await knex.schema.hasTable('staff_mfa_recovery_codes'))) {
    await knex.schema.createTable('staff_mfa_recovery_codes', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('CASCADE');
      t.string('code_hash', 64).notNullable();
      t.timestamp('used_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['technician_id', 'code_hash']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('staff_mfa_recovery_codes');
  await knex.schema.dropTableIfExists('staff_mfa_totp');
  if (await knex.schema.hasTable('technicians')
    && await knex.schema.hasColumn('technicians', 'mfa_enabled_at')) {
    await knex.schema.alterTable('technicians', (t) => {
      t.dropColumn('mfa_enabled_at');
    });
  }
};
