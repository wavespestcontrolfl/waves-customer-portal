// Vendor login credentials — encryption at rest.
//
// vendors.login_password_encrypted is named "encrypted" but the admin save route used to
// store it in PLAINTEXT. This module fixes that: passwords are stored PGP-armored
// (pgcrypto pgp_sym_encrypt -> armor, so the value still fits the existing TEXT column)
// and decrypted only at the point of use (a vendor login adapter). Mirrors the
// data-hygiene vault's pgp_sym pattern.
//
// Key: VENDOR_CREDENTIAL_KEY, falling back to DATA_HYGIENE_VAULT_KEY (already set in prod,
// so this works out of the box). With NO key set, writes FAIL CLOSED (a password is never
// stored in the clear) and reads return a null password.

const db = require('../models/db');

function vendorCredentialKey() {
  return process.env.VENDOR_CREDENTIAL_KEY || process.env.DATA_HYGIENE_VAULT_KEY || null;
}

// Pure decision for how a PUT should treat an incoming loginPassword field. Kept separate
// from the DB so it's unit-testable:
//   'skip'    — field absent OR blank STRING: leave the stored value UNCHANGED. Critical: the
//               admin vendor form initializes loginPassword to '' and submits the whole form
//               on every save, so a blank field means "didn't retype it", NOT "erase it" —
//               else editing the username/URL would silently wipe the saved password.
//   'clear'   — caller explicitly asked to remove it: clearRequested flag OR an explicit null
//               loginPassword (a deliberate API value the form never sends): set column NULL
//   'encrypt' — non-empty + a key available: caller stores armor(pgp_sym_encrypt(...))
//   'reject'  — non-empty but NO key: refuse rather than store plaintext (fail closed)
function passwordWriteAction(loginPassword, hasKey, clearRequested) {
  if (clearRequested === true || loginPassword === null) return 'clear';
  if (loginPassword === undefined || String(loginPassword) === '') return 'skip';
  return hasKey ? 'encrypt' : 'reject';
}

// A Knex raw expression that encrypts `plaintext` for storage in login_password_encrypted.
// Throws if no key (callers should pre-check with passwordWriteAction to return a clean 4xx).
function encryptedPasswordRaw(conn, plaintext) {
  const key = vendorCredentialKey();
  if (!key) throw new Error('vendor credential key missing');
  return conn.raw('armor(pgp_sym_encrypt(?, ?))', [String(plaintext), key]);
}

// Read a vendor's login credentials with the password DECRYPTED (for a login adapter).
// Returns null if the vendor doesn't exist; password is null when there's none stored, no
// key is configured, or the stored value can't be decrypted (legacy plaintext / wrong key).
async function getVendorLoginCredentials(conn, vendorId) {
  const row = await conn('vendors').where({ id: vendorId })
    .first('login_username', 'login_email', 'account_number', 'login_url', 'login_password_encrypted');
  if (!row) return null;
  let password = null;
  const key = vendorCredentialKey();
  if (row.login_password_encrypted && key) {
    try {
      const r = await conn.raw('SELECT pgp_sym_decrypt(dearmor(?), ?) AS pw', [row.login_password_encrypted, key]);
      password = (r && r.rows && r.rows[0] && r.rows[0].pw) || null;
    } catch (e) {
      // Not armored (legacy plaintext not yet migrated) or wrong key — never expose the raw value.
      password = null;
    }
  }
  return {
    username: row.login_username || null,
    email: row.login_email || null,
    accountNumber: row.account_number || null,
    loginUrl: row.login_url || null,
    password,
  };
}

module.exports = {
  vendorCredentialKey,
  passwordWriteAction,
  encryptedPasswordRaw,
  getVendorLoginCredentials,
  _db: db,
};
