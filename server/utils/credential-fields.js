/**
 * Which names mark a credential (general admin read, owner ruling 2026-10-12).
 * Shared by the catalog generator (a handler that selects, returns or builds
 * one is kept out of the catalog) and by the run-time redaction of an answer
 * (the VALUE under such a key is dropped at any depth), so both layers judge
 * a name by one definition.
 *
 * A name is split into words (camelCase, snake_case, kebab-case), so
 * `unsubscribeToken` -> unsubscribe + token, and `pinned` / `shipping` never
 * hit the whole word `pin`.
 *
 * NOT credentials, on purpose: `code`, `gate_code`, `access_code`. A gate or
 * access code for a customer's property is operational data the owner may ask
 * for. (`invite_code` IS removed: it is a sign-up credential, not a property
 * code.) Decision list for the words below: when in doubt, remove.
 */
const CREDENTIAL_WORDS = new Set([
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'passcode', 'pin', 'credential', 'credentials',
  'signature', 'signatures', 'sig', 'hash', 'salt', 'apikey', 'jwt', 'otp', 'nonce', 'authorization', 'bearer', 'cookie', 'cookies',
  'session', 'sessions',
  // spellings the free-text scrubber also treats as credential names
  'pwd', 'passphrase', 'auth',
]);
// Words that name a credential in a structured field but also name ordinary things in a sentence
// ("Prior authorization: required", "Signature: on file", "gate PIN: 1234" which is kept data). The
// free-text passes (secret-text-scrubber.js) use the SAME list minus these: authorization has its own
// header rule, a PIN has its own gate-code rule, and a hash, salt or signature in prose is not a secret.
const FREE_TEXT_EXEMPT_WORDS = new Set(['pin', 'authorization', 'hash', 'salt', 'sig', 'signature', 'signatures']);
// Two-word credentials: api key, access key, private key, magic link, reset link, invite code ...
const CREDENTIAL_PAIRS = [
  ['api', 'key'], ['access', 'key'], ['private', 'key'], ['secret', 'key'], ['signing', 'key'], ['encryption', 'key'], ['cert', 'key'],
  ['magic', 'link'], ['reset', 'link'], ['login', 'link'], ['invite', 'code'], ['invite', 'link'], ['verification', 'code'],
  ['confirmation', 'code'], ['auth', 'code'],
];
const LONG_OPAQUE_MIN = 16;

function nameWords(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Words that mark a column holding an ACCESS credential. A `*_hash` or
// `session_id` column is removed from an answer at run time, but is not a
// reason to keep a whole table out of the catalog (content_hash, ip_hash).
const WEAK_WORDS = new Set(['hash', 'session', 'sessions', 'sig', 'signature', 'signatures']);

// True when the NAME marks an access credential (the table-level test).
function isStrongCredentialName(name) {
  const words = nameWords(name);
  if (words.some(word => CREDENTIAL_WORDS.has(word) && !WEAK_WORDS.has(word))) return true;
  return CREDENTIAL_PAIRS.some(([a, b]) => words.some((word, i) => word === a && words[i + 1] === b));
}

// True when the NAME marks a credential, whatever the value is.
function isCredentialName(name, exempt = null) {
  const words = nameWords(name);
  if (words.some(word => CREDENTIAL_WORDS.has(word) && !(exempt && exempt.has(word)))) return true;
  return CREDENTIAL_PAIRS.some(([a, b]) => words.some((word, i) => word === a && words[i + 1] === b));
}

// A string that looks like an opaque secret: long, no spaces.
function looksOpaque(value) {
  return typeof value === 'string' && value.length >= LONG_OPAQUE_MIN && !/\s/.test(value);
}

// True when the VALUE under `key` must be dropped: a credential name, or a
// `...key` name (s3_key, api_key, idempotency_key) holding a long opaque string.
// A short human label under `key` ("name", "status") stays.
function isCredentialField(key, value) {
  if (isCredentialName(key)) return true;
  const words = nameWords(key);
  return words[words.length - 1] === 'key' && looksOpaque(value);
}

// True when the two words together form a listed credential pair ("private key", "secret key").
function isCredentialPair(first, second) {
  return CREDENTIAL_PAIRS.some(([a, b]) => a === String(first).toLowerCase() && b === String(second).toLowerCase());
}

module.exports = { isCredentialPair, isStrongCredentialName, isCredentialName, isCredentialField, nameWords, looksOpaque, CREDENTIAL_WORDS, FREE_TEXT_EXEMPT_WORDS, LONG_OPAQUE_MIN };
