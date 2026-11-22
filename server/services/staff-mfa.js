// Staff two-step sign-in (GATE_ADMIN_MFA): an authenticator-app code (TOTP,
// RFC 6238: HMAC-SHA1, 6 digits, 30-second steps) after the password, plus
// single-use recovery codes.
//
// Secrets are pgcrypto-encrypted at rest with the same armor(pgp_sym_encrypt)
// pattern plaid-sync.js uses for bank tokens. Key: STAFF_MFA_KEY, falling back
// to DATA_HYGIENE_VAULT_KEY (already set in production). With no key, setup
// FAILS CLOSED (a secret is never stored in the clear) and a code cannot be
// checked — the kill switch for a lost key is unsetting the gate.
//
// Gate semantics (read at CALL time, see feature-gates.js):
//   GATE_ADMIN_MFA off          → nothing here runs; login is exactly today's.
//   GATE_ADMIN_MFA on           → an enrolled staff member must pass a code
//                                 before a session is issued.
//   + GATE_ADMIN_MFA_ENFORCE on → an ADMIN with no authenticator is held on
//                                 the enrollment page until they set one up.

const crypto = require('crypto');
const db = require('../models/db');
const { isInfrastructureError } = require('./vendor-credentials');
const featureGates = require('../config/feature-gates');

// The gate readers, resolved at call time through the module object. Every
// staff auth check (and the staff push lookup) runs through these, so a
// caller whose environment replaces feature-gates with a partial stub (many
// unrelated suites do) reads "off" instead of throwing inside auth.
function adminMfaLive() {
  return typeof featureGates.adminMfaLive === 'function' && featureGates.adminMfaLive() === true;
}

function adminMfaEnforceLive() {
  return adminMfaLive()
    && typeof featureGates.adminMfaEnforceLive === 'function'
    && featureGates.adminMfaEnforceLive() === true;
}

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
// One step either side tolerates a phone clock up to ~30 s off.
const TOTP_WINDOW_STEPS = 1;
const SECRET_BYTES = 20; // RFC 4226 recommends 160 bits for HMAC-SHA1.
const PENDING_SETUP_TTL_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10; // 80 bits → 16 base32 characters.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
// A session that signed in with a recovery code may replace the authenticator
// without a second code for this long (the lost-phone path: the last code
// must not leave the account unrecoverable).
const RECOVERY_SESSION_REPLACE_MS = 30 * 60 * 1000;
const ISSUER = 'Waves Pest Control';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ── base32 (RFC 4648, no padding) ───────────────────────────────────────────

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('invalid base32');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── TOTP (RFC 6238 over RFC 4226 HOTP) ──────────────────────────────────────

function hotp(secretBytes, counter, digits = TOTP_DIGITS) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBytes).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8)
    | hmac[offset + 3];
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function timeStep(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

function normalizeTotpCode(code) {
  const digits = String(code ?? '').replace(/\s/g, '');
  return new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits) ? digits : null;
}

// Returns the matched time step, or null. Every candidate step is compared
// (no early exit) with a constant-time compare.
function matchTotpStep(secretBase32, code, nowMs = Date.now()) {
  const normalized = normalizeTotpCode(code);
  if (!normalized) return null;
  let secretBytes;
  try {
    secretBytes = base32Decode(secretBase32);
  } catch {
    return null;
  }
  const given = Buffer.from(normalized);
  const current = timeStep(nowMs);
  let matched = null;
  for (let step = current - TOTP_WINDOW_STEPS; step <= current + TOTP_WINDOW_STEPS; step += 1) {
    const expected = Buffer.from(hotp(secretBytes, step));
    if (crypto.timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  return matched;
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

function otpauthUri(secretBase32, accountName) {
  const label = encodeURIComponent(`${ISSUER}:${accountName || 'staff'}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── recovery codes ──────────────────────────────────────────────────────────

function normalizeRecoveryCode(code) {
  const clean = String(code ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-7]{16}$/.test(clean) ? clean : null;
}

function hashRecoveryCode(normalized) {
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = base32Encode(crypto.randomBytes(RECOVERY_CODE_BYTES)).slice(0, 16);
    codes.push(raw.match(/.{4}/g).join('-'));
  }
  return codes;
}

async function replaceRecoveryCodes(trx, technicianId) {
  const codes = generateRecoveryCodes();
  await trx('staff_mfa_recovery_codes').where({ technician_id: technicianId }).del();
  await trx('staff_mfa_recovery_codes').insert(codes.map((code) => ({
    technician_id: technicianId,
    code_hash: hashRecoveryCode(normalizeRecoveryCode(code)),
  })));
  return codes;
}

// ── secret vault (plaid-sync.js pattern) ────────────────────────────────────

function mfaKeys() {
  return [...new Set([process.env.STAFF_MFA_KEY, process.env.DATA_HYGIENE_VAULT_KEY].filter(Boolean))];
}

function hasMfaKey() {
  return mfaKeys().length > 0;
}

function encryptedSecretRaw(conn, secret) {
  const key = mfaKeys()[0];
  if (!key) throw Object.assign(new Error('staff MFA key missing'), { code: 'MFA_KEY_MISSING' });
  return conn.raw('armor(pgp_sym_encrypt(?, ?))', [String(secret), key]);
}

// Tries every candidate key (primary first). A wrong key is pgcrypto's data
// error → next key; an infrastructure failure is rethrown SANITIZED — knex
// puts bindings (ciphertext AND key) in its error message.
async function decryptSecret(conn, enc) {
  if (!enc) return null;
  for (const key of mfaKeys()) {
    try {
      // Each attempt runs in its own (sub)transaction: inside a caller's
      // transaction that is a savepoint, so a wrong key's error does not
      // abort the caller's transaction before the next key is tried.
      const r = await conn.transaction((attempt) => attempt.raw('SELECT pgp_sym_decrypt(dearmor(?), ?) AS t', [enc, key]));
      const t = r && r.rows && r.rows[0] && r.rows[0].t;
      if (t) return t;
    } catch (e) {
      if (!isInfrastructureError(e)) continue;
      const err = new Error(`staff MFA decrypt failed: database error${e && e.code != null ? ` ${String(e.code)}` : ''}`);
      err.code = e && e.code != null ? String(e.code) : undefined;
      throw err;
    }
  }
  return null;
}

// ── policy (shared by the HTTP middleware, verifyStaffBearer and sockets) ───

function mfaEnabled(tech) {
  return Boolean(tech && tech.mfa_enabled_at);
}

function enrollmentRequired(tech) {
  return adminMfaLive() && adminMfaEnforceLive() && tech?.role === 'admin' && !mfaEnabled(tech);
}

// Why a verified staff access token may NOT use the app right now, or null.
// The gate is read first: with GATE_ADMIN_MFA off every persisted MFA fact is
// ignored, so the kill switch always outranks enrollment state.
function sessionMfaBlock(decoded, tech) {
  if (!adminMfaLive()) return null;
  if (mfaEnabled(tech) && decoded?.mfa !== true) {
    return { status: 401, code: 'MFA_REQUIRED', error: 'Two-step sign-in required. Sign in again.' };
  }
  if (enrollmentRequired(tech)) {
    return { status: 403, code: 'MFA_ENROLLMENT_REQUIRED', error: 'Set up two-step sign-in to continue.' };
  }
  return null;
}

// Fields the client reads, present only while the gate is live so the
// gate-off /me and login payloads stay exactly as they were.
function twoStepProfile(tech) {
  if (!adminMfaLive()) return {};
  return {
    twoStep: {
      enabled: mfaEnabled(tech),
      enrollmentRequired: enrollmentRequired(tech),
    },
  };
}

// ── verification (login step two, and the self-service routes) ──────────────

function lockedResult(lockedUntil) {
  return { ok: false, reason: 'locked', lockedUntil };
}

// Records one wrong code; locks the account for LOCKOUT_MS on the fifth.
async function recordFailure(conn, technicianId) {
  const lockAt = new Date(Date.now() + LOCKOUT_MS);
  const result = await conn.raw(`
    UPDATE staff_mfa_totp
       SET failed_attempts = CASE WHEN failed_attempts + 1 >= ? THEN 0 ELSE failed_attempts + 1 END,
           locked_until = CASE WHEN failed_attempts + 1 >= ? THEN ?::timestamptz ELSE locked_until END,
           updated_at = now()
     WHERE technician_id = ?
     RETURNING locked_until
  `, [MAX_FAILED_ATTEMPTS, MAX_FAILED_ATTEMPTS, lockAt, technicianId]);
  const lockedUntil = result?.rows?.[0]?.locked_until;
  return lockedUntil && new Date(lockedUntil) > new Date() ? lockedResult(new Date(lockedUntil)) : { ok: false, reason: 'invalid' };
}

// Checks an authenticator code OR a recovery code against the ACTIVE factor.
// The whole check runs in one transaction holding the factor row FOR UPDATE:
// concurrent attempts for one account are serialized, so the lockout is read,
// the code judged, the code consumed and a failure counted as one step, and
// no parallel burst can guess past the fifth wrong code. Replay protection: a
// TOTP code is accepted only for a time step later than the last accepted
// one; a recovery code only while its used_at is NULL.
// The account row is locked first at the caller's credential version (the
// same fence every factor write uses), so a code — a single-use recovery code
// above all — is never consumed for a session or sign-in that a password
// change or factor replacement already revoked.
// Returns { ok: true, method } or { ok: false, reason: invalid|locked|unavailable|revoked }.
async function verifySecondFactor(technicianId, code, { expectedTokenVersion, conn = db, nowMs = Date.now() } = {}) {
  return conn.transaction(async (trx) => {
    if (!await lockAccountAtVersion(trx, technicianId, expectedTokenVersion)) return { ok: false, reason: 'revoked' };
    const row = await trx('staff_mfa_totp').where({ technician_id: technicianId }).forUpdate().first();
    if (!row || !row.secret_enc) return { ok: false, reason: 'unavailable' };
    if (row.locked_until && new Date(row.locked_until) > new Date(nowMs)) return lockedResult(new Date(row.locked_until));

    const totp = normalizeTotpCode(code);
    if (totp) {
      let secret;
      try {
        secret = await decryptSecret(trx, row.secret_enc);
      } catch {
        return { ok: false, reason: 'unavailable' };
      }
      if (!secret) return { ok: false, reason: 'unavailable' };
      const step = matchTotpStep(secret, totp, nowMs);
      const lastStep = row.last_used_step == null ? null : Number(row.last_used_step);
      if (step !== null && (lastStep === null || step > lastStep)) {
        await trx('staff_mfa_totp')
          .where({ technician_id: technicianId })
          .update({ last_used_step: step, failed_attempts: 0, locked_until: null, updated_at: trx.fn.now() });
        return { ok: true, method: 'totp' };
      }
      return recordFailure(trx, technicianId);
    }

    const recovery = normalizeRecoveryCode(code);
    if (recovery) {
      const used = await trx('staff_mfa_recovery_codes')
        .where({ technician_id: technicianId, code_hash: hashRecoveryCode(recovery) })
        .whereNull('used_at')
        .update({ used_at: trx.fn.now() });
      if (used === 1) {
        await trx('staff_mfa_totp')
          .where({ technician_id: technicianId })
          .update({ failed_attempts: 0, locked_until: null, updated_at: trx.fn.now() });
        return { ok: true, method: 'recovery' };
      }
    }
    return recordFailure(trx, technicianId);
  });
}

// ── enrollment ──────────────────────────────────────────────────────────────

// Stores a new pending secret, fenced on the session's credential version
// like every other factor write: a request from a session that a password
// change or factor replacement revoked meanwhile writes nothing.
// Returns { ok: true, secret, otpauthUrl } or { ok: false, reason: 'revoked' }.
// `code` (replacing an existing authenticator): checked inside the same
// transaction, so a recovery code is consumed only if the new pending setup
// is written too. Returns { ok: true, secret, otpauthUrl, method } or
// { ok: false, reason: revoked|invalid|locked|unavailable }.
async function startSetup(tech, { expectedTokenVersion, code = null } = {}) {
  if (!hasMfaKey()) {
    throw Object.assign(new Error('Two-step sign-in cannot be set up: no encryption key is configured.'), { status: 503 });
  }
  const secret = generateSecret();
  let outcome;
  try {
    outcome = await db.transaction(async (trx) => {
      if (!await lockAccountAtVersion(trx, tech.id, expectedTokenVersion)) return { ok: false, reason: 'revoked' };
      let method = null;
      if (code !== null) {
        await trx('staff_mfa_totp').where({ technician_id: tech.id }).forUpdate().first();
        const verified = await verifySecondFactor(tech.id, code, { expectedTokenVersion, conn: trx });
        if (!verified.ok) return verified;
        method = verified.method;
      }
      await trx('staff_mfa_totp')
        .insert({
          technician_id: tech.id,
          pending_secret_enc: encryptedSecretRaw(trx, secret),
          pending_created_at: trx.fn.now(),
        })
        .onConflict('technician_id')
        .merge({
          pending_secret_enc: encryptedSecretRaw(trx, secret),
          pending_created_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        });
      return { ok: true, method };
    });
  } catch (e) {
    // knex puts bindings (the new secret AND the key) in its error message;
    // only a sanitized error with the database code leaves this function.
    const err = new Error(`staff MFA setup failed: database error${e && e.code != null ? ` ${String(e.code)}` : ''}`);
    err.code = e && e.code != null ? String(e.code) : undefined;
    throw err;
  }
  if (!outcome.ok) return outcome;
  return { ok: true, method: outcome.method, secret, otpauthUrl: otpauthUri(secret, tech.email) };
}

// Confirms a pending setup with a code from the new authenticator. In one
// transaction, fenced on the session's credential version (a password change
// or reset that landed after this request authenticated wins): the pending
// secret becomes the active one, the confirming step is recorded (so the same
// code cannot then be replayed at login), recovery codes are replaced,
// technicians.mfa_enabled_at is stamped, and — like a password change — the
// credential version moves and push registrations are deactivated, so every
// session and device registered before the authenticator is signed out.
// Returns { ok: true, recoveryCodes, technician } or { ok: false, reason }.
async function confirmSetup(tech, code, { expectedTokenVersion, nowMs = Date.now() } = {}) {
  return db.transaction(async (trx) => {
    if (!await lockAccountAtVersion(trx, tech.id, expectedTokenVersion, { writesAccount: true })) return { ok: false, reason: 'revoked' };
    const row = await trx('staff_mfa_totp').where({ technician_id: tech.id }).forUpdate().first();
    if (!row || !row.pending_secret_enc || !row.pending_created_at) return { ok: false, reason: 'no_pending' };
    if (new Date(row.pending_created_at).getTime() + PENDING_SETUP_TTL_MS < nowMs) return { ok: false, reason: 'expired' };
    if (row.locked_until && new Date(row.locked_until) > new Date(nowMs)) return lockedResult(new Date(row.locked_until));
    let secret;
    try {
      secret = await decryptSecret(trx, row.pending_secret_enc);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (!secret) return { ok: false, reason: 'unavailable' };
    const step = matchTotpStep(secret, code, nowMs);
    if (step === null) return { ok: false, reason: 'invalid' };

    await trx('staff_mfa_totp').where({ technician_id: tech.id }).update({
      secret_enc: row.pending_secret_enc,
      pending_secret_enc: null,
      pending_created_at: null,
      last_used_step: step,
      failed_attempts: 0,
      locked_until: null,
      updated_at: trx.fn.now(),
    });
    const recoveryCodes = await replaceRecoveryCodes(trx, tech.id);
    const [technician] = await trx('technicians')
      .where({ id: tech.id, auth_token_version: expectedTokenVersion })
      .update({
        mfa_enabled_at: trx.fn.now(),
        auth_token_version: expectedTokenVersion + 1,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    // Lazy: this module sits under every staff auth check, the push stack does not.
    await require('./push-notifications').deactivateStaffUser(tech.id, trx);
    return { ok: true, recoveryCodes, technician };
  });
}

// Locks the account on the session's credential version, the same fence
// enrollment uses: a factor replacement or password change that landed after
// the request authenticated (both move the version) wins, so an in-flight
// request from a revoked session changes nothing.
// `writesAccount`: the transaction will also UPDATE the technicians row. It
// then takes the table's ROW EXCLUSIVE lock BEFORE the row lock — the order
// the staff identity writers use (lockStaffAccountMutations takes SHARE ROW
// EXCLUSIVE first) — so a password-reset request or Team edit overlapping it
// waits instead of deadlocking.
async function lockAccountAtVersion(trx, technicianId, expectedTokenVersion, { writesAccount = false } = {}) {
  if (writesAccount) await trx.raw('LOCK TABLE technicians IN ROW EXCLUSIVE MODE');
  return trx('technicians')
    .where({ id: technicianId, auth_token_version: expectedTokenVersion })
    .forUpdate()
    .first();
}

// The account and factor rows are locked first, so two concurrent
// regenerations replace the codes one after the other instead of both
// deleting the old batch and leaving two new ones valid.
// Returns { ok: true, recoveryCodes } or { ok: false, reason: 'revoked' }.
// `code` (the current authenticator or a recovery code) is checked in the
// SAME transaction, so a recovery code is consumed only if the new batch is
// written too — a failure never leaves the last recovery code spent for
// nothing.
async function regenerateRecoveryCodes(technicianId, { expectedTokenVersion, code } = {}) {
  return db.transaction(async (trx) => {
    if (!await lockAccountAtVersion(trx, technicianId, expectedTokenVersion)) return { ok: false, reason: 'revoked' };
    await trx('staff_mfa_totp').where({ technician_id: technicianId }).forUpdate().first();
    const verified = await verifySecondFactor(technicianId, code, { expectedTokenVersion, conn: trx });
    if (!verified.ok) return verified;
    return { ok: true, recoveryCodes: await replaceRecoveryCodes(trx, technicianId) };
  });
}

// Lock order everywhere: account row, then factor row, then recovery codes
// (verification takes factor row then codes), so turning it off never
// deadlocks against a recovery-code sign-in. Like enrolling, turning it off
// moves the credential version and deactivates push registrations: a
// password-only token or device the gate was refusing (minted while the gate
// was briefly off) must not come back to life once the factor is gone.
// Returns { ok: true, technician } or { ok: false, reason: 'revoked' }.
// `code` is checked in the same transaction (see regenerateRecoveryCodes).
async function disable(technicianId, { expectedTokenVersion, code } = {}) {
  return db.transaction(async (trx) => {
    if (!await lockAccountAtVersion(trx, technicianId, expectedTokenVersion, { writesAccount: true })) return { ok: false, reason: 'revoked' };
    await trx('staff_mfa_totp').where({ technician_id: technicianId }).forUpdate().first();
    const verified = await verifySecondFactor(technicianId, code, { expectedTokenVersion, conn: trx });
    if (!verified.ok) return verified;
    await trx('staff_mfa_recovery_codes').where({ technician_id: technicianId }).del();
    await trx('staff_mfa_totp').where({ technician_id: technicianId }).del();
    const [technician] = await trx('technicians')
      .where({ id: technicianId, auth_token_version: expectedTokenVersion })
      .update({ mfa_enabled_at: null, auth_token_version: expectedTokenVersion + 1, updated_at: trx.fn.now() })
      .returning('*');
    await require('./push-notifications').deactivateStaffUser(technicianId, trx);
    return { ok: true, technician };
  });
}

// The `mfaRecoveryUntil` (epoch seconds) a recovery-code sign-in stamps on
// its access token; a password change carries it over unchanged.
function recoveryReplaceDeadline(nowMs = Date.now()) {
  return Math.floor((nowMs + RECOVERY_SESSION_REPLACE_MS) / 1000);
}

// True while a session that signed in with a recovery code is still inside
// its replacement window.
function recoverySessionCanReplace(decoded, nowMs = Date.now()) {
  return decoded?.mfa === true
    && Number.isFinite(decoded.mfaRecoveryUntil)
    && nowMs < decoded.mfaRecoveryUntil * 1000;
}

async function status(tech, decoded) {
  let remaining = 0;
  if (mfaEnabled(tech)) {
    const row = await db('staff_mfa_recovery_codes')
      .where({ technician_id: tech.id })
      .whereNull('used_at')
      .count({ n: '*' })
      .first();
    remaining = Number(row?.n || 0);
  }
  return {
    available: adminMfaLive(),
    enabled: mfaEnabled(tech),
    enrollmentRequired: enrollmentRequired(tech),
    enforced: adminMfaLive() && adminMfaEnforceLive() && tech?.role === 'admin',
    recoveryCodesRemaining: remaining,
    // The page asks for no current code when replacing from such a session.
    replaceWithoutCode: mfaEnabled(tech) && recoverySessionCanReplace(decoded),
  };
}

module.exports = {
  adminMfaEnforceLive,
  adminMfaLive,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  PENDING_SETUP_TTL_MS,
  base32Decode,
  base32Encode,
  confirmSetup,
  disable,
  enrollmentRequired,
  generateRecoveryCodes,
  hasMfaKey,
  hotp,
  matchTotpStep,
  mfaEnabled,
  normalizeRecoveryCode,
  otpauthUri,
  recoveryReplaceDeadline,
  recoverySessionCanReplace,
  regenerateRecoveryCodes,
  sessionMfaBlock,
  startSetup,
  status,
  timeStep,
  twoStepProfile,
  verifySecondFactor,
};
