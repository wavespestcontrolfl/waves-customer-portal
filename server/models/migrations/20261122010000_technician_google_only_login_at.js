/**
 * Team tab Hired button, the Google-only login (owner 2026-11-22 "press"; GATE_HIRED_PACKET with
 * GATE_STAFF_GOOGLE_SIGNIN).
 *
 * technicians.google_only_login_at: when the Hired button (routes/admin-timetracking.js hireTechnician) made this
 * staff row an account that signs in with its linked company Google address and has no password. The email on such
 * a row can be one typed on a job application, which nobody proved, so no password link goes to it: not from the
 * Hired press, not from "Resend link", not from a password reset request (routes/admin-auth.js issuePasswordReset).
 *
 * The CHECK makes that a rule of the table and not only of the code: a marked row holds no password and no
 * set-password or reset token. A writer that does not know the mark (an older build after a rollback) cannot store
 * a token on a marked row: its UPDATE fails. The Hired button's password variant clears the mark in the UPDATE that
 * stores its token.
 *
 * A second CHECK: a marked row is never an office (admin) login. Two-step sign-in setup asks for the account
 * password, and GATE_ADMIN_MFA_ENFORCE holds an admin with no authenticator on that setup page, so a Google-only
 * admin could sign in and then never get past it. The Hired button gives an admin row the emailed link; nothing
 * changes a row's role after it is made.
 *
 * Each statement takes a short ACCESS EXCLUSIVE lock on technicians. With lock_timeout the migration (and the deploy)
 * fails after 10 seconds behind a long transaction, and never queues staff sign-in reads behind itself.
 *
 * down() removes nothing: the column and the rule are what keep the reset closed for these accounts, so a rollback
 * followed by a second up() must not open it. All are inert for a row with no mark, and up() skips what is there.
 */

const COLUMN = 'google_only_login_at';
// Rule name -> what a marked row must meet.
const RULES = {
  technicians_google_only_login_no_password: 'password_hash IS NULL AND password_reset_token_hash IS NULL',
  technicians_google_only_login_not_admin: "role IS DISTINCT FROM 'admin'",
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('technicians'))) return;
  await knex.raw("SET LOCAL lock_timeout = '10s'");
  if (!(await knex.schema.hasColumn('technicians', COLUMN))) {
    await knex.schema.alterTable('technicians', (t) => {
      t.timestamp(COLUMN, { useTz: true }).nullable();
    });
  }
  for (const [rule, holds] of Object.entries(RULES)) {
    const existing = await knex.raw(
      "SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'technicians'::regclass",
      [rule],
    );
    if (!existing.rows.length) {
      await knex.raw(`ALTER TABLE technicians ADD CONSTRAINT ${rule} CHECK (${COLUMN} IS NULL OR (${holds}))`);
    }
  }
};

// Removes nothing: see the header.
exports.down = async function down() {};
