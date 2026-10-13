/**
 * Removes credentials from JSON before it reaches the Intelligence Bar model
 * (general admin read, owner ruling 2026-10-12). Three kinds, one walk, run
 * before the answer is cut to its cap:
 *
 *  1. Signed file links: a URL that carries a signature or credential in its
 *     query string or fragment (X-Amz-Signature, Signature, sig, token, key,
 *     ...), points at a storage host (S3, R2, GCS, Azure blob, Spaces, B2,
 *     Wasabi) or embeds user:password@  ->  "[signed link removed]".
 *  2. Private application links: any other URL with a random-looking segment
 *     of 16+ characters in its path or query (a UUID, letters mixed with
 *     digits, or 24+ opaque characters). Pay, estimate, quote, review,
 *     unsubscribe and portal magic links work this way: whoever holds the link
 *     holds the access  ->  "[private link removed]". A readable content slug
 *     ("pest-control-services") and a slug under a public content path
 *     (/blog/..., /services/...) stay. Bare id fields are not URLs and stay.
 *     The same two checks cover a link with no scheme (www.example.test/pay/<token>,
 *     example.test/pay/<token>), a relative path in text (/pay/<token>,
 *     /portal/<token>) and a bare query string that carries a credential
 *     (?token=...). Readable text stays: dates (10/12/2026), fractions,
 *     and/or, and file-like paths made of words.
 *  3. Credential fields: the VALUE under any object key that names a
 *     credential (token, secret, password, pin, signature, hash, session, ...;
 *     see credential-fields.js) at any depth  ->  "[removed]". Gate and access
 *     codes are operational data and are kept.
 *
 * Defense in depth behind the catalog generator, which keeps routes that
 * select or build such values out of the catalog.
 */
const { isCredentialField } = require('./credential-fields');

const REDACTED_LINK = '[signed link removed]';
const REDACTED_PRIVATE_LINK = '[private link removed]';
const REDACTED_FIELD = '[removed]';

const SIGNED_KEYS = new Set([
  'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'x-amz-algorithm', 'x-goog-signature', 'x-goog-credential',
  'signature', 'sig', 'token', 'access_token', 'accesstoken', 'id_token', 'key', 'apikey', 'api_key', 'secret', 'auth', 'jwt',
  'awsaccesskeyid', 'key-pair-id',
]);
const STORAGE_HOST_RE = /(^|\.)(amazonaws\.com|r2\.cloudflarestorage\.com|r2\.dev|storage\.googleapis\.com|storage\.cloud\.google\.com|blob\.core\.windows\.net|digitaloceanspaces\.com|backblazeb2\.com|wasabisys\.com)$/i;
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>\\]+/gi;
// A first path segment that marks an ordinary public content page.
const PUBLIC_CONTENT_SEGMENTS = new Set(['blog', 'services', 'service', 'service-area', 'service-areas', 'areas', 'locations', 'about', 'contact', 'faq', 'resources']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

// A 16+ character run of [A-Za-z0-9_-] that reads as random, not as words.
function looksRandom(segment) {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(segment)) return false;
  if (UUID_RE.test(segment)) return true;
  if (/^[a-z]+(-[a-z]+)+$/.test(segment)) return false; // readable slug
  if (/[A-Za-z]/.test(segment) && /\d/.test(segment)) return true;
  if (segment.length >= 24 && /^[0-9a-fA-F]+$/.test(segment)) return true;
  return segment.length >= 24 && (!segment.includes('-') || (/[a-z]/.test(segment) && /[A-Z]/.test(segment)));
}

// Every 16+ character run of [A-Za-z0-9_-] in the path, query and fragment is
// judged on its own, so punctuation stuck to a token ("…/pay/<uuid>)." in
// Markdown or at a sentence end) cannot hide it.
const TOKEN_RUN_RE = /[A-Za-z0-9_-]{16,}/g;
function isPrivateLink(text) {
  let url;
  try { url = new URL(text); } catch { return true; }
  const segments = url.pathname.split('/').filter(Boolean);
  const publicPage = PUBLIC_CONTENT_SEGMENTS.has((segments[0] || '').toLowerCase());
  const random = candidate => looksRandom(candidate) && !(publicPage && !UUID_RE.test(candidate) && !/^[0-9a-fA-F]{24,}$/.test(candidate));
  let rest;
  try { rest = decodeURIComponent(`${url.pathname} ${url.search} ${url.hash}`); } catch { return true; }
  return (rest.match(TOKEN_RUN_RE) || []).some(random);
}

// Sentence and Markdown punctuation after a link is not part of it.
const TRAILING_PUNCTUATION_RE = /[).,;:!?\]}>*_~`'"]+$/;
function splitTail(match) {
  const tail = (match.match(TRAILING_PUNCTUATION_RE) || [''])[0];
  return { link: tail ? match.slice(0, -tail.length) : match, tail };
}

// Links with no "https://" in front: "www.example.test/pay/<token>" and
// "example.test/pay/<token>". A candidate is judged exactly like an absolute
// link (parsed with https:// put in front); one that is neither signed nor
// private is left as it was, so ordinary dotted words stay.
const HOST_LINK_RE = /(?<![\w@./:-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:[/?#][^\s"'<>\\]*)?/gi;
// A relative link: "/pay/<token>", "/portal/<token>?x=1". The "/" must not
// follow a word character, "/", ":" or "." (so "10/12/2026", "and/or" and the
// inside of an absolute URL are not starts).
const RELATIVE_LINK_RE = /(?<![\w/:.@-])\/[A-Za-z0-9._~%@+=-]*(?:\/[A-Za-z0-9._~%@+=-]*)*(?:[?#][^\s"'<>\\]*)?/g;
// A bare query string that carries a credential: "?token=...", "?sig=...&x=1".
const BARE_QUERY_RE = /(?<![\w/])\?[A-Za-z0-9_.[\]-]+=[^\s"'<>\\]*/g;

// Words joined by - or _ ("quarterly-summary-final-2026") read as a name, not a token.
function readableName(run) {
  const parts = run.split(/[-_]/);
  return parts.length >= 3 && parts.every(part => /^(?:[A-Za-z]{2,}|\d{1,4})$/.test(part)) && parts.filter(part => /^[A-Za-z]{3,}$/.test(part)).length >= 2;
}

function relativeLinkVerdict(link) {
  let url;
  try { url = new URL(link, 'https://relative.invalid'); } catch { return null; }
  if (carriesCredential(url.search) || carriesCredential(url.hash.replace(/^#/, ''))) return REDACTED_LINK;
  const segments = url.pathname.split('/').filter(Boolean);
  const publicPage = PUBLIC_CONTENT_SEGMENTS.has((segments[0] || '').toLowerCase());
  let rest;
  try { rest = decodeURIComponent(`${url.pathname} ${url.search} ${url.hash}`); } catch { return REDACTED_PRIVATE_LINK; }
  const random = (run, index) => {
    if (UUID_RE.test(run) || /^[0-9a-fA-F]{24,}$/.test(run)) return true;
    if (!looksRandom(run) || readableName(run) || publicPage) return false;
    // A lone first segment is a page name unless it holds a digit.
    return segments.length > 1 || index > 0 || /\d/.test(run);
  };
  return (rest.match(TOKEN_RUN_RE) || []).some(run => random(run, segments.findIndex(segment => segment.includes(run)))) ? REDACTED_PRIVATE_LINK : null;
}

function redactString(text, state) {
  const count = (verdict) => { if (verdict === REDACTED_LINK) state.links += 1; else state.privateLinks += 1; return verdict; };
  const absolute = text.replace(URL_IN_TEXT_RE, (match) => {
    const { link, tail } = splitTail(match);
    if (isSignedLink(link)) return count(REDACTED_LINK) + tail;
    if (isPrivateLink(link)) return count(REDACTED_PRIVATE_LINK) + tail;
    return match;
  });
  const hosted = absolute.replace(HOST_LINK_RE, (match) => {
    const { link, tail } = splitTail(match);
    if (!/[/?#]/.test(link) && !/^www\./i.test(link)) return match;
    let candidate;
    try { candidate = new URL(`https://${link}`); } catch { return match; }
    if (isSignedLink(candidate.href)) return count(REDACTED_LINK) + tail;
    if (isPrivateLink(candidate.href)) return count(REDACTED_PRIVATE_LINK) + tail;
    return match;
  });
  const relative = hosted.replace(RELATIVE_LINK_RE, (match) => {
    const { link, tail } = splitTail(match);
    const verdict = link.length > 1 ? relativeLinkVerdict(link) : null;
    return verdict ? count(verdict) + tail : match;
  });
  return relative.replace(BARE_QUERY_RE, (match) => {
    const { link, tail } = splitTail(match);
    return carriesCredential(link.slice(1)) && /=[^&]/.test(link) ? count(REDACTED_LINK) + tail : match;
  });
}

function newState() {
  return { links: 0, privateLinks: 0, fields: 0 };
}

// A copy of `value` with credentials removed. `state` counts what was removed.
function redactSecrets(value, state, depth = 0) {
  if (typeof value === 'string') return redactString(value, state);
  if (!value || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) { state.fields += 1; return '[too deeply nested]'; }
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, state, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined && isCredentialField(key, item)) {
      state.fields += 1;
      out[key] = REDACTED_FIELD;
    } else out[key] = redactSecrets(item, state, depth + 1);
  }
  return out;
}

module.exports = {
  REDACTED_LINK, REDACTED_PRIVATE_LINK, REDACTED_FIELD, newState, redactSecrets, redactString, isSignedLink, isPrivateLink, looksRandom,
};
