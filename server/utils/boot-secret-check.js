/**
 * Boot-time secret strength check (pure, no logging, no process control).
 *
 * server/index.js calls this from assertRequiredSecrets(). It returns the
 * NAMES of problem variables only — never a value — so a caller can log the
 * result without leaking a secret.
 *
 * - JWT_SECRET: fatal in production when it is the .env.example placeholder
 *   text or shorter than 32 characters. Anyone who has read the repo knows the
 *   placeholder, so a deploy that kept it would sign forgeable tokens.
 * - TERMINAL_HANDOFF_SECRET / BOUNCIE_WEBHOOK_SECRET: a placeholder value is
 *   reported as a warning only. The caller logs it loudly but keeps booting.
 *   An unset variable is not reported here: those features already fail closed
 *   on a missing value.
 */

const MIN_JWT_SECRET_LENGTH = 32;

// Every secret placeholder in .env.example starts with this text
// (replace_with_random_64_char_string_use_openssl_rand_hex_32,
// replace_with_openssl_rand_hex_32_output, replace_with_bouncie_webhook_key).
const PLACEHOLDER_PATTERN = /^replace_with/i;

const WARN_ONLY_SECRETS = ['TERMINAL_HANDOFF_SECRET', 'BOUNCIE_WEBHOOK_SECRET'];

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERN.test(String(value == null ? '' : value).trim());
}

/**
 * @param {{ jwtSecret?: string, env?: Record<string,string|undefined> }} input
 * @returns {{ fatal: string[], warnings: string[] }} messages naming variables
 *   and the rule they broke, never their values.
 */
function checkBootSecrets({ jwtSecret, env = process.env } = {}) {
  const fatal = [];
  const warnings = [];

  const jwt = jwtSecret == null ? '' : String(jwtSecret).trim();
  // A missing JWT_SECRET is reported by the required-variable check, not here.
  if (jwt) {
    if (isPlaceholder(jwt)) {
      fatal.push('JWT_SECRET is still the .env.example placeholder text');
    } else if (jwt.length < MIN_JWT_SECRET_LENGTH) {
      fatal.push(`JWT_SECRET is shorter than ${MIN_JWT_SECRET_LENGTH} characters`);
    }
  }

  for (const name of WARN_ONLY_SECRETS) {
    if (isPlaceholder(env[name])) {
      warnings.push(`${name} is still the .env.example placeholder text`);
    }
  }

  return { fatal, warnings };
}

module.exports = { checkBootSecrets, isPlaceholder, MIN_JWT_SECRET_LENGTH, WARN_ONLY_SECRETS };
