/**
 * Removes links that carry their own credential from JSON before it reaches
 * the Intelligence Bar model (general admin read, owner ruling 2026-10-12).
 * A presigned S3/R2/GCS URL is a bearer token for a private file; the bar must
 * never hold one. Defense in depth behind the catalog generator, which keeps
 * routes that mint such links out of the catalog.
 *
 * A link is removed when it
 *   - carries a signature or credential in its query string or fragment
 *     (X-Amz-Signature, X-Amz-Credential, Signature, sig, token,
 *     access_token, key, ...; an Expires + Signature pair is covered by the
 *     signature key), or
 *   - points at a storage host (S3, R2, GCS, Azure blob, Spaces, B2, Wasabi), or
 *   - embeds user:password@ credentials.
 */
const REDACTED_LINK = '[signed link removed]';

const SIGNED_KEYS = new Set([
  'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'x-amz-algorithm', 'x-goog-signature', 'x-goog-credential',
  'signature', 'sig', 'token', 'access_token', 'accesstoken', 'id_token', 'key', 'apikey', 'api_key', 'secret', 'auth', 'jwt',
  'awsaccesskeyid', 'key-pair-id',
]);
const STORAGE_HOST_RE = /(^|\.)(amazonaws\.com|r2\.cloudflarestorage\.com|r2\.dev|storage\.googleapis\.com|storage\.cloud\.google\.com|blob\.core\.windows\.net|digitaloceanspaces\.com|backblazeb2\.com|wasabisys\.com)$/i;
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>\\]+/gi;
const MAX_DEPTH = 40;

function carriesCredential(search) {
  for (const key of new URLSearchParams(search).keys()) if (SIGNED_KEYS.has(key.toLowerCase())) return true;
  return false;
}

function isSignedLink(text) {
  let url;
  try { url = new URL(text); } catch { return true; } // an unreadable link is not worth the risk
  return Boolean(url.username || url.password) || STORAGE_HOST_RE.test(url.hostname)
    || carriesCredential(url.search) || carriesCredential(url.hash.replace(/^#/, ''));
}

function redactString(text, state) {
  return text.replace(URL_IN_TEXT_RE, (link) => {
    if (!isSignedLink(link)) return link;
    state.removed += 1;
    return REDACTED_LINK;
  });
}

// A copy of `value` with every signed link replaced. `state.removed` counts them.
function redactSignedLinks(value, state, depth = 0) {
  if (typeof value === 'string') return redactString(value, state);
  if (!value || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) { state.removed += 1; return '[too deeply nested]'; }
  if (Array.isArray(value)) return value.map(item => redactSignedLinks(item, state, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = redactSignedLinks(item, state, depth + 1);
  return out;
}

module.exports = { REDACTED_LINK, redactSignedLinks, redactString, isSignedLink };
