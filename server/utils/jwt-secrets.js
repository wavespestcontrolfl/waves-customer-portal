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
 * Only the key list changes. Each verifier keeps its own claim, algorithm,
 * expiry and token_version checks. Where a dedicated secret (X_SECRET) is the
 * effective secret, the previous list does NOT apply: use verifySecretsFor().
 * Unset JWT_SECRET_PREVIOUS = the single-secret behaviour, byte for byte.
 * Secret values are never logged.
 */
const jwt = require('jsonwebtoken');

function parsePrevious(current) {
  const raw = process.env.JWT_SECRET_PREVIOUS;
  if (typeof raw !== 'string' || !raw) return [];
  const out = [];
  for (const entry of raw.split(',')) {
    const secret = entry.trim();
    if (secret && secret !== current && !out.includes(secret)) out.push(secret);
  }
  return out;
}

/**
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

function isBadSignature(err) {
  return Boolean(err) && err.name === 'JsonWebTokenError' && err.message === 'invalid signature';
}

/**
 * jwt.verify(token, current, options) with rotation. Tries the current secret,
 * then each previous one, and moves on only when the signature does not match. Any other failure
 * (expired, malformed, wrong algorithm, bad claims) is thrown at once. If no
 * key matches, the error from the CURRENT secret is thrown, so the failure is
 * identical to the single-secret case.
 */
function verifyJwtWithRotation(token, current, options) {
  const keys = jwtVerifySecrets(current);
  // No current secret: let jsonwebtoken raise its own error, exactly as before.
  if (!keys.length) return runVerify(token, current, options);
  return verifyJwtWithKeys(token, keys, options);
}

function runVerify(token, secret, options) {
  return options === undefined ? jwt.verify(token, secret) : jwt.verify(token, secret, options);
}

/** Same as verifyJwtWithRotation, for a caller that built its own key list. */
function verifyJwtWithKeys(token, keys, options) {
  if (keys.length === 1) return runVerify(token, keys[0], options);
  let firstError;
  for (const key of keys) {
    try {
      return runVerify(token, key, options);
    } catch (err) {
      if (!isBadSignature(err)) throw err;
      if (!firstError) firstError = err;
    }
  }
  throw firstError;
}

module.exports = { jwtVerifySecrets, jwtVerifySecretsOr, verifySecretsFor, verifyJwtWithRotation, verifyJwtWithKeys };
