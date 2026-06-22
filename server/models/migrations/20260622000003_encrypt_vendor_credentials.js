/**
 * Migration — encrypt existing vendor login passwords at rest.
 *
 * vendors.login_password_encrypted was historically stored in PLAINTEXT (the save route
 * didn't encrypt). This PGP-armors any existing plaintext value so it matches what the
 * fixed route now writes (armor(pgp_sym_encrypt(...))). Idempotent: rows already armored
 * (starting with the PGP MESSAGE header) are skipped. No-op when no key is configured —
 * those rows then get encrypted on their next save.
 */
const KEY = () => process.env.VENDOR_CREDENTIAL_KEY || process.env.DATA_HYGIENE_VAULT_KEY || null;

exports.up = async function up(knex) {
  const key = KEY();
  if (!key) {
    // eslint-disable-next-line no-console
    console.warn('[migration] no VENDOR_CREDENTIAL_KEY/DATA_HYGIENE_VAULT_KEY set — leaving vendor passwords as-is (encrypted on next save)');
    return;
  }
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await knex.raw(
    "UPDATE vendors SET login_password_encrypted = armor(pgp_sym_encrypt(login_password_encrypted, ?)) "
    + "WHERE login_password_encrypted IS NOT NULL AND login_password_encrypted <> '' "
    + "AND login_password_encrypted NOT LIKE '-----BEGIN PGP MESSAGE-----%'",
    [key],
  );
};

exports.down = async function down() {
  // No safe reverse: returning ciphertext to plaintext would re-expose passwords, and the
  // key may be unavailable. Intentionally a no-op.
};
