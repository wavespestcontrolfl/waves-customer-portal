/**
 * JWT_SECRET rotation (verify side only).
 *
 * JWT_SECRET signs customer / staff JWTs, MFA challenge tokens, terminal
 * tokens and every link signature or HMAC that falls back to it. Rolling it
 * used to log everyone out and kill every live link. JWT_SECRET_PREVIOUS
 * (comma-separated list of retired secrets, may be unset) lets a rotation
 * overlap: signing ALWAYS uses the current JWT_SECRET; verifying accepts the
 * current secret first, then each previous one.
 *
 * STAFF SESSIONS NEVER ROTATE THROUGH THE PREVIOUS LIST. Anyone holding a
 * retired secret could mint a fresh staff bearer (new exp, mfa claim) for a
 * known technician id, so staff / MFA-challenge / terminal / socket-staff /
 * admin-marker verifiers use verifyStaffJwt() (current secret only); a rotation
 * signs staff out once. Customer sessions (verifyCustomerJwt) and link / HMAC
 * families (jwtVerifySecrets, verifySecretsFor, verifyJwtWithKeys) accept the
 * previous list. A new staff verifier must call verifyStaffJwt.
 *
 * A RETIRED SECRET IS NOT A PERMANENT KEY. The previous list is honoured only
 * while JWT_SECRET_ROTATED_AT (ISO time, not in the future) is set and valid,
 * and a token or link accepted ONLY because of a retired secret must prove it
 * was minted before that time and not outlive its family's normal lifetime
 * (JWTs: iat before the cutoff and exp - iat within the family maximum;
 * HMAC links with an embedded expiry: exp no later than the cutoff plus the
 * family TTL). Otherwise someone holding a leaked retired key could mint a
 * fresh long-lived credential. Signatures with no embedded time (outlink
 * context, SMS attachment, digests) can only be gated by the cutoff itself.
 * After a suspected secret leak, rotate WITHOUT JWT_SECRET_PREVIOUS.
 *
 * Only the key list changes. Each verifier keeps its own claim, algorithm,
 * expiry and token_version checks. Where a dedicated secret (X_SECRET) is the
 * effective secret, the previous list does NOT apply: use verifySecretsFor().
 * Unset JWT_SECRET_PREVIOUS = the single-secret behaviour, byte for byte.
 * Secret values are never logged.
 */
const jwt = require('jsonwebtoken');

// JWT_SECRET_ROTATED_AT as epoch ms, or null when unset, unparsable or in the
// future (a future cutoff would let tokens minted today pass as "before").
function rotatedAtMs() {
  const raw = process.env.JWT_SECRET_ROTATED_AT;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw.trim());
  return Number.isFinite(ms) && ms <= Date.now() ? ms : null;
}

function parsePrevious(current) {
  const raw = process.env.JWT_SECRET_PREVIOUS;
  if (typeof raw !== 'string' || !raw) return [];
  if (rotatedAtMs() === null) return [];
  const out = [];
  for (const entry of raw.split(',')) {
    const secret = entry.trim();
    if (secret && secret !== current && !out.includes(secret)) out.push(secret);
  }
  return out;
}

/**
 * LINK / HMAC / CUSTOMER families only, never a staff session (use
 * staffVerifySecrets / verifyStaffJwt).
 * [current, ...previous] for a JWT_SECRET-keyed check. With no argument the
 * current secret is process.env.JWT_SECRET; callers that read config.jwt.secret
 * pass it, and an explicitly passed undefined stays undefined (it never falls
 * back to the environment). With no current secret the list is empty (fail
 * closed: previous secrets alone never authenticate anything).
 */
function jwtVerifySecrets(...args) {
  const current = args.length ? args[0] : process.env.JWT_SECRET;
  if (!current) return [];
  return [current, ...parsePrevious(current)];
}

/**
 * Key list for a verifier whose effective secret is
 * `process.env.JWT_SECRET || devFallback`. The previous list applies only
 * while JWT_SECRET is set.
 */
function jwtVerifySecretsOr(devFallback) {
  return process.env.JWT_SECRET ? jwtVerifySecrets(process.env.JWT_SECRET) : [devFallback];
}

/**
 * Key list for a verifier whose effective secret is `dedicated || JWT_SECRET`.
 * A dedicated secret keeps only itself; the previous list applies only when
 * JWT_SECRET is the effective secret.
 */
function verifySecretsFor(dedicated, ...args) {
  if (dedicated) return [dedicated];
  return jwtVerifySecrets(...args);
}

const CLOCK_SKEW_SECONDS = 60;

/**
 * A JWT accepted only because of a retired secret must carry iat strictly
 * before JWT_SECRET_ROTATED_AT and a lifetime (exp - iat) within its family's
 * maximum. Missing iat or exp fails.
 */
function retiredJwtOk(payload, maxLifetimeSeconds) {
  const cutoff = rotatedAtMs();
  if (cutoff === null || !payload || typeof payload !== 'object') return false;
  const { iat, exp } = payload;
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return false;
  if (!Number.isFinite(maxLifetimeSeconds)) return false;
  return iat * 1000 < cutoff && exp - iat <= maxLifetimeSeconds;
}

/**
 * An HMAC link with an embedded expiry (epoch seconds) accepted only because
 * of a retired secret: minted before the cutoff means it cannot expire later
 * than the cutoff plus the family's TTL.
 */
function retiredExpOk(expSeconds, ttlSeconds) {
  const cutoff = rotatedAtMs();
  if (cutoff === null || !Number.isFinite(expSeconds) || !Number.isFinite(ttlSeconds)) return false;
  return expSeconds <= Math.floor(cutoff / 1000) + ttlSeconds + CLOCK_SKEW_SECONDS;
}

/** A timestamp (epoch ms) carried in a retired-secret payload must precede the cutoff. */
function retiredMintedBefore(tsMs) {
  const cutoff = rotatedAtMs();
  return cutoff !== null && Number.isFinite(tsMs) && tsMs < cutoff;
}

const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31557600 };
function durationSeconds(value, fallbackSeconds) {
  const match = /^\s*(\d+)\s*([smhdwy])?\s*$/i.exec(String(value == null ? '' : value));
  if (!match) return fallbackSeconds;
  return Number(match[1]) * (match[2] ? DURATION_UNITS[match[2].toLowerCase()] : 1);
}

// Normal lifetimes of the customer session tokens (middleware/auth.js signing):
// access 15 minutes; refresh REFRESH_TOKEN_EXPIRY (default 30 days).
const CUSTOMER_ACCESS_SECONDS = 15 * 60;
function customerMaxLifetimeSeconds(payload) {
  return payload && payload.type === 'refresh'
    ? durationSeconds(process.env.REFRESH_TOKEN_EXPIRY || '30d', 30 * 86400)
    : CUSTOMER_ACCESS_SECONDS;
}

function isBadSignature(err) {
  return Boolean(err) && err.name === 'JsonWebTokenError' && err.message === 'invalid signature';
}

/**
 * Staff-session key list: the current secret only, never the previous list.
 */
function staffVerifySecrets(current) {
  return current ? [current] : [];
}

/**
 * Staff-session jwt.verify (admin / technician access, MFA challenge, terminal,
 * staff socket, admin marker): the current secret only. Identical to a plain
 * jwt.verify(token, current, options).
 */
function verifyStaffJwt(token, current, options) {
  return runVerify(token, current, options);
}

// Claims only a staff-session token carries. A payload signed with a RETIRED
// secret that carries any of them is refused (see verifyCustomerJwt).
const STAFF_CLAIMS = ['technicianId', 'tokenVersion', 'mfa', 'scope', 'kind'];

/**
 * jwt.verify(token, current, options) for CUSTOMER sessions, with rotation:
 * tries the current secret, then each previous one, and moves on only when the
 * signature does not match. Any other failure (expired, malformed, wrong
 * algorithm, bad claims) is thrown at once. If no key matches, the error from
 * the CURRENT secret is thrown, so the failure is identical to the
 * single-secret case. A token that verifies only under a retired secret and
 * carries a staff claim is refused with that same error: a retired secret must
 * never yield a staff identity, even on mixed customer/staff decoders.
 */
function verifyCustomerJwt(token, current, options) {
  const keys = jwtVerifySecrets(current);
  // No current secret: let jsonwebtoken raise its own error, exactly as before.
  if (!keys.length) return runVerify(token, current, options);
  if (keys.length === 1) return runVerify(token, keys[0], options);
  let firstError;
  for (let i = 0; i < keys.length; i += 1) {
    try {
      const payload = runVerify(token, keys[i], options);
      if (i > 0 && (!payload || typeof payload !== 'object'
        || STAFF_CLAIMS.some((c) => payload[c] != null)
        || !retiredJwtOk(payload, customerMaxLifetimeSeconds(payload)))) {
        throw firstError;
      }
      return payload;
    } catch (err) {
      if (err === firstError) throw err;
      if (!isBadSignature(err)) throw err;
      if (!firstError) firstError = err;
    }
  }
  throw firstError;
}

function runVerify(token, secret, options) {
  return options === undefined ? jwt.verify(token, secret) : jwt.verify(token, secret, options);
}

/**
 * Link-family jwt.verify over a caller-built key list (never for staff
 * sessions). `maxLifetimeSeconds` is the family's normal exp - iat; a token
 * accepted only by a retired key must also pass retiredJwtOk with it.
 */
function verifyJwtWithKeys(token, keys, options, maxLifetimeSeconds) {
  if (keys.length === 1) return runVerify(token, keys[0], options);
  let firstError;
  for (let i = 0; i < keys.length; i += 1) {
    try {
      const payload = runVerify(token, keys[i], options);
      if (i > 0 && !retiredJwtOk(payload, maxLifetimeSeconds)) throw firstError;
      return payload;
    } catch (err) {
      if (err === firstError) throw err;
      if (!isBadSignature(err)) throw err;
      if (!firstError) firstError = err;
    }
  }
  throw firstError;
}

/**
 * True when `token` verifies only under a retired secret (not the current one).
 * Used by the refresh exchange to refuse legacy migration for old-key tokens.
 */
function verifiedByRetiredKey(token, current) {
  if (jwtVerifySecrets(current).length <= 1) return false;
  try {
    jwt.verify(token, current);
    return false;
  } catch {
    return true;
  }
}

module.exports = {
  jwtVerifySecrets, jwtVerifySecretsOr, verifySecretsFor, staffVerifySecrets,
  verifyStaffJwt, verifyCustomerJwt, verifyJwtWithKeys, verifiedByRetiredKey,
  retiredExpOk, retiredMintedBefore, retiredJwtOk, rotatedAtMs,
};
