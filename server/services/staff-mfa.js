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
const { adminMfaLive, adminMfaEnforceLive } = require('../config/feature-gates');

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
      const r = await conn.raw('SELECT pgp_sym_decrypt(dearmor(?), ?) AS t', [enc, key]);
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
// Replay protection: a TOTP code is accepted only for a time step later than
// the last accepted one, claimed with one conditional UPDATE so two
// concurrent requests with the same code cannot both pass. A recovery code is
// consumed the same way (used_at IS NULL in the WHERE).
// Returns { ok: true, method } or { ok: false, reason: invalid|locked|unavailable }.
async function verifySecondFactor(technicianId, code, { conn = db, nowMs = Date.now() } = {}) {
  const row = await conn('staff_mfa_totp').where({ technician_id: technicianId }).first();
  if (!row || !row.secret_enc) return { ok: false, reason: 'unavailable' };
  if (row.locked_until && new Date(row.locked_until) > new Date(nowMs)) return lockedResult(new Date(row.locked_until));

  const totp = normalizeTotpCode(code);
  if (totp) {
    let secret;
    try {
      secret = await decryptSecret(conn, row.secret_enc);
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (!secret) return { ok: false, reason: 'unavailable' };
    const step = matchTotpStep(secret, totp, nowMs);
    if (step !== null) {
      const claimed = await conn('staff_mfa_totp')
        .where({ technician_id: technicianId })
        .where(function laterStep() {
          this.whereNull('last_used_step').orWhere('last_used_step', '<', step);
        })
        .update({ last_used_step: step, failed_attempts: 0, locked_until: null, updated_at: conn.fn.now() });
      if (claimed === 1) return { ok: true, method: 'totp' };
    }
    return recordFailure(conn, technicianId);
  }

  const recovery = normalizeRecoveryCode(code);
  if (recovery) {
    const used = await conn('staff_mfa_recovery_codes')
      .where({ technician_id: technicianId, code_hash: hashRecoveryCode(recovery) })
      .whereNull('used_at')
      .update({ used_at: conn.fn.now() });
    if (used === 1) {
      await conn('staff_mfa_totp')
        .where({ technician_id: technicianId })
        .update({ failed_attempts: 0, locked_until: null, updated_at: conn.fn.now() });
      return { ok: true, method: 'recovery' };
    }
  }
  return recordFailure(conn, technicianId);
}

// ── enrollment ──────────────────────────────────────────────────────────────

async function startSetup(tech, { conn = db } = {}) {
  if (!hasMfaKey()) {
    throw Object.assign(new Error('Two-step sign-in cannot be set up: no encryption key is configured.'), { status: 503 });
  }
  const secret = generateSecret();
  await conn('staff_mfa_totp')
    .insert({
      technician_id: tech.id,
      pending_secret_enc: encryptedSecretRaw(conn, secret),
      pending_created_at: conn.fn.now(),
    })
    .onConflict('technician_id')
    .merge({
      pending_secret_enc: encryptedSecretRaw(conn, secret),
      pending_created_at: conn.fn.now(),
      updated_at: conn.fn.now(),
    });
  return { secret, otpauthUrl: otpauthUri(secret, tech.email) };
}

// Confirms a pending setup with a code from the new authenticator. In one
// transaction: the pending secret becomes the active one, the confirming
// step is recorded (so the same code cannot then be replayed at login),
// recovery codes are replaced, and technicians.mfa_enabled_at is stamped.
// Returns { ok: true, recoveryCodes } or { ok: false, reason }.
async function confirmSetup(tech, code, { nowMs = Date.now() } = {}) {
  return db.transaction(async (trx) => {
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
    await trx('technicians').where({ id: tech.id }).update({ mfa_enabled_at: trx.fn.now(), updated_at: trx.fn.now() });
    return { ok: true, recoveryCodes };
  });
}

async function regenerateRecoveryCodes(technicianId) {
  return db.transaction((trx) => replaceRecoveryCodes(trx, technicianId));
}

async function disable(technicianId) {
  await db.transaction(async (trx) => {
    await trx('staff_mfa_recovery_codes').where({ technician_id: technicianId }).del();
    await trx('staff_mfa_totp').where({ technician_id: technicianId }).del();
    await trx('technicians').where({ id: technicianId }).update({ mfa_enabled_at: null, updated_at: trx.fn.now() });
  });
}

async function status(tech) {
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
  };
}

module.exports = {
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
  regenerateRecoveryCodes,
  sessionMfaBlock,
  startSetup,
  status,
  timeStep,
  twoStepProfile,
  verifySecondFactor,
};
