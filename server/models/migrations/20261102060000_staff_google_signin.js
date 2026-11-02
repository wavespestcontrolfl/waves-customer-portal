/**
 * Staff Sign in with Google (GATE_STAFF_GOOGLE_SIGNIN, owner 2026-11-02).
 *
 * technicians.google_email — the company Google account (a domain listed in
 *   GOOGLE_STAFF_SIGNIN_DOMAINS) the owner links on the Team tab. Kept apart
 *   from `email`: a free Cloud Identity account has no inbox, so staff mail
 *   keeps going to `email`. Stored lower-case; at most one staff row per
 *   address.
 * technicians.google_sub — Google's stable account id, recorded at the first
 *   Google sign-in. Later sign-ins must present the same id, so a deleted and
 *   recreated Google account with the same address does not inherit access.
 *   The Team tab clears it whenever the link changes.
 *
 * staff_google_signin_attempts — one row per started sign-in, single use.
 *   /start writes state_hash (SHA-256 of the state Google echoes back, also
 *   held in an HttpOnly cookie), the nonce, the Google PKCE verifier and
 *   page_challenge (SHA-256 of a secret the starting page keeps). /callback
 *   stamps callback_at once and, on success, result_hash + technician_id +
 *   google_sub. /finish stamps consumed_at once and needs the page's secret.
 *   Rows live minutes; /start deletes rows older than a day.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('technicians')) {
    if (!(await knex.schema.hasColumn('technicians', 'google_email'))) {
      await knex.schema.alterTable('technicians', (t) => {
        t.string('google_email', 150);
      });
    }
    if (!(await knex.schema.hasColumn('technicians', 'google_sub'))) {
      await knex.schema.alterTable('technicians', (t) => {
        t.string('google_sub', 255);
      });
    }
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS technicians_google_email_uidx
        ON technicians (LOWER(google_email))
        WHERE google_email IS NOT NULL
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS technicians_google_sub_uidx
        ON technicians (google_sub)
        WHERE google_sub IS NOT NULL
    `);
  }

  if (!(await knex.schema.hasTable('staff_google_signin_attempts'))) {
    await knex.schema.createTable('staff_google_signin_attempts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('state_hash', 64).notNullable().unique();
      t.string('nonce', 64).notNullable();
      t.string('pkce_verifier', 64).notNullable();
      t.string('page_challenge', 64).notNullable();
      t.string('client', 8).notNullable();
      t.timestamp('expires_at', { useTz: true }).notNullable();
      t.timestamp('callback_at', { useTz: true });
      t.string('result_hash', 64).unique();
      t.uuid('technician_id').references('id').inTable('technicians').onDelete('CASCADE');
      t.string('google_sub', 255);
      t.timestamp('consumed_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['created_at']);
    });
    await knex.raw(`
      ALTER TABLE staff_google_signin_attempts
        ADD CONSTRAINT staff_google_signin_attempts_client_check
        CHECK (client IN ('web', 'ios'))
    `);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('staff_google_signin_attempts');
  await knex.raw('DROP INDEX IF EXISTS technicians_google_sub_uidx');
  await knex.raw('DROP INDEX IF EXISTS technicians_google_email_uidx');
  if (await knex.schema.hasTable('technicians')) {
    if (await knex.schema.hasColumn('technicians', 'google_sub')) {
      await knex.schema.alterTable('technicians', (t) => { t.dropColumn('google_sub'); });
    }
    if (await knex.schema.hasColumn('technicians', 'google_email')) {
      await knex.schema.alterTable('technicians', (t) => { t.dropColumn('google_email'); });
    }
  }
};
