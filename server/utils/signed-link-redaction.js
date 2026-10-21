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
 *     Two rules do not depend on length: a link on one of the business's own
 *     hosts (wavespestcontrol.com and subdomains, and the hosts the app builds
 *     links with) is private when its path has any non-marketing segment, and a
 *     relative path under a public token route (/l/<code>, /pay/<token>, ...)
 *     is private whatever the code looks like.
 *     The same two checks cover a link with no scheme (www.example.test/pay/<token>,
 *     example.test/pay/<token>), a relative path in text (/pay/<token>,
 *     /portal/<token>) and a bare query string that carries a credential
 *     (?token=...). Readable text stays: dates (10/12/2026), fractions,
 *     and/or, and file-like paths made of words.
 *  3. Credentials pasted into free text: known secret formats and labelled
 *     secrets ("password: x", "PIN is 4821") in any string value, best effort
 *     (secret-text-scrubber.js); counted with the credential fields.
 *  4. Credential fields: the VALUE under any object key that names a
 *     credential (token, secret, password, pin, signature, hash, session, ...;
 *     see credential-fields.js) at any depth  ->  "[removed]". Gate and access
 *     codes are operational data and are kept.
 *
 * Defense in depth behind the catalog generator, which keeps routes that
 * select or build such values out of the catalog.
 */
const { isCredentialField, isCredentialName, nameWords } = require('./credential-fields');
const { scrubSecretText } = require('./secret-text-scrubber');
const { scrubNote, SCAN_LIMIT } = require('./note-secret-scrubber');

const REDACTED_LINK = '[signed link removed]';
const REDACTED_PRIVATE_LINK = '[private link removed]';
const REDACTED_FIELD = '[removed]';

// Query keys that mark a credential in a LINK. The general rule is the shared
// credential-name test (credential-fields.js: token, secret, password, session,
// nonce, otp, signature, bearer, ... in any spelling, so `auth_token`,
// `session_id` and `passcode` hit) so a link and a JSON field are judged by one
// definition. Only two kinds of key stay listed here: storage-signature names
// that are not credential words, and link-only names that are credentials as a
// QUERY key but would over-remove as a field name (`sid`, `ticket`, `pwd`,
// `key`, `auth`, and the squashed spellings `sessionid`, `authtoken`). `code`
// is deliberately NOT a credential key: it is too common (`?code=` on a
// public page, a promo code), so a link whose only parameter is `code` is
// judged by the private-link rules like any other.
const SIGNED_KEYS = new Set([
  'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'x-amz-algorithm', 'x-goog-signature', 'x-goog-credential',
  'awsaccesskeyid', 'key-pair-id',
  'key', 'auth', 'sid', 'ticket', 'pwd', 'sessionid', 'authtoken', 'accesstoken', 'idtoken', 'apikey', 'bearer',
]);
const STORAGE_HOST_RE = /(^|\.)(amazonaws\.com|r2\.cloudflarestorage\.com|r2\.dev|storage\.googleapis\.com|storage\.cloud\.google\.com|blob\.core\.windows\.net|digitaloceanspaces\.com|backblazeb2\.com|wasabisys\.com)$/i;
const URL_IN_TEXT_RE = /https?:\/\/[^\s"'<>\\]+/gi;
// A first path segment that marks an ordinary public content page.
const PUBLIC_CONTENT_SEGMENTS = new Set(['blog', 'services', 'service', 'service-area', 'service-areas', 'areas', 'locations', 'about', 'contact', 'faq', 'resources']);
// OWN-DOMAIN RULE. The business's own hosts: the literal domain (and every
// subdomain) plus every host the app builds customer links with. The set is
// read from the same environment values the link builders read:
//   - server/utils/portal-url.js (the canonical builder):
//     PUBLIC_PORTAL_URL, PORTAL_URL, CLIENT_URL, PORTAL_DOMAIN
//   - server/services/short-url.js baseUrl(): SHORTLINK_BASE_URL
//   - other link bases in the services and routes: ADMIN_PORTAL_URL,
//     PORTAL_BASE_URL, PUBLIC_URL, SERVER_DOMAIN, RAILWAY_PUBLIC_DOMAIN,
//     WAVES_SITE_URL, ASTRO_HUB_ORIGIN
//   - the production default of all of them, portal.wavespestcontrol.com
const OWN_DOMAIN = 'wavespestcontrol.com';
const OWN_HOST_ENV_NAMES = Object.freeze([
  'PUBLIC_PORTAL_URL', 'PORTAL_URL', 'CLIENT_URL', 'PORTAL_DOMAIN', 'SHORTLINK_BASE_URL', 'ADMIN_PORTAL_URL',
  'PORTAL_BASE_URL', 'PUBLIC_URL', 'SERVER_DOMAIN', 'RAILWAY_PUBLIC_DOMAIN', 'WAVES_SITE_URL', 'ASTRO_HUB_ORIGIN',
]);

function hostOf(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase(); } catch { return null; }
}

// Read when a string is judged, so a changed environment value is seen at once.
function ownHosts() {
  const hosts = new Set([OWN_DOMAIN]);
  for (const name of OWN_HOST_ENV_NAMES) {
    const host = hostOf(process.env[name]);
    if (host) hosts.add(host.replace(/^www\./, ''));
  }
  return hosts;
}

function isOwnHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return [...ownHosts()].some(own => host === own || host.endsWith(`.${own}`));
}

// PUBLIC-TOKEN-ROUTE RULE. First path segments under which the app serves a
// page or redirect addressed by a code or token, whatever its length. Sources:
//   client/src/App.jsx public routes whose param is a token or code:
//     appointment, book, card, careers (careers/interview/:token), contract,
//     estimate, inspection, lawn-report, pay (pay/:token, pay/statement/:token),
//     pest-report, prep, price-change, rate, recap, receipt, report
//     (report/:token, report/project/:token), reschedule, reservice, review,
//     secure, service-outlines, track, visit
//   server/index.js public mounts: /l (routes/public-shortlinks.js GET /:code,
//     the 10-character codes, the readable invoice codes and the legacy 1-7
//     character codes), /r (routes/referral-links.js GET /:code), /go
//     (routes/outbound-redirect.js GET /:code), /estimate/:token (app.get),
//     /og (routes/og-preview.js, report preview images named by report token)
// server/tests/ib-admin-read-tools.test.js reads those two files and fails when
// a public token route there is missing from this list.
const PUBLIC_TOKEN_ROUTE_SEGMENTS = Object.freeze([
  'appointment', 'book', 'card', 'careers', 'contract', 'estimate', 'go', 'inspection', 'l', 'lawn-report', 'og', 'pay',
  'pest-report', 'prep', 'price-change', 'r', 'rate', 'recap', 'receipt', 'report', 'reschedule', 'reservice', 'review',
  'secure', 'service-outlines', 'track', 'visit',
]);
const PUBLIC_TOKEN_ROUTES = new Set(PUBLIC_TOKEN_ROUTE_SEGMENTS);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DEPTH = 40;

function isCredentialQueryKey(key) {
  const squashed = key.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return SIGNED_KEYS.has(key.toLowerCase()) || SIGNED_KEYS.has(squashed) || isCredentialName(key);
}

function carriesCredential(search) {
  for (const key of new URLSearchParams(search).keys()) if (isCredentialQueryKey(key)) return true;
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
// A protocol-relative link: "//host/…", not inside "https://…" or a path.
const PROTOCOL_RELATIVE_RE = /(?<![\w:/.@-])\/\/(?=[A-Za-z0-9])[^\s"'<>\\]+/g;
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
  // A route that serves a page by code or token: any non-empty segment after it is the code.
  if (segments.length > 1 && PUBLIC_TOKEN_ROUTES.has(segments[0].toLowerCase())) return REDACTED_PRIVATE_LINK;
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

// A link on one of the business's own hosts is private whenever its path has a
// segment that is not ordinary public content, whatever that segment looks like
// ("/l/abc234def5" is a short link). A marketing page ("/blog/...", "/services/...")
// stays when it has no query string; a bare host or "/" stays.
function isOwnPrivateLink(url) {
  if (!isOwnHost(url.hostname)) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  if (!segments.length) return false;
  return !(PUBLIC_CONTENT_SEGMENTS.has(segments[0].toLowerCase()) && !url.search);
}

// The verdict for an absolute link (href with a scheme), or null to leave it.
function absoluteLinkVerdict(href) {
  if (isSignedLink(href)) return REDACTED_LINK;
  let url;
  try { url = new URL(href); } catch { return REDACTED_LINK; }
  return isOwnPrivateLink(url) || isPrivateLink(href) ? REDACTED_PRIVATE_LINK : null;
}

function redactString(text, state) {
  const count = (verdict) => { if (verdict === REDACTED_LINK) state.links += 1; else state.privateLinks += 1; return verdict; };
  const absolute = text.replace(URL_IN_TEXT_RE, (match) => {
    const { link, tail } = splitTail(match);
    const verdict = absoluteLinkVerdict(link);
    return verdict ? count(verdict) + tail : match;
  });
  // "//user:pw@host/path", "//bucket.s3.amazonaws.com/key": a link with no
  // scheme. Judged exactly like an absolute link (userinfo, storage host,
  // credential query, own host, token path).
  const protocolRelative = absolute.replace(PROTOCOL_RELATIVE_RE, (match) => {
    const { link, tail } = splitTail(match);
    const verdict = absoluteLinkVerdict(`https:${link}`);
    return verdict ? count(verdict) + tail : match;
  });
  const hosted = protocolRelative.replace(HOST_LINK_RE, (match) => {
    const { link, tail } = splitTail(match);
    if (!/[/?#]/.test(link) && !/^www\./i.test(link)) return match;
    let candidate;
    try { candidate = new URL(`https://${link}`); } catch { return match; }
    const verdict = absoluteLinkVerdict(candidate.href);
    return verdict ? count(verdict) + tail : match;
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
  return { links: 0, privateLinks: 0, fields: 0, notes: 0, notesReturned: 0, noteSecrets: 0 };
}

// OPERATOR NOTES. A free-text field typed by staff or customers about a record
// (notes, admin_notes, reason, instructions ...) is where a password, a
// session link or a card number gets pasted, and a best-effort scrubber cannot
// win that. Such a value is not read through the general read at all: it is
// replaced by a marker that carries only its length.
//
// Fail closed (Codex round 10): a reviewer who forgets to declare a field must
// not leak it, so on EVERY endpoint a response key whose NAME looks like free
// text is withheld, unless the reviewed row declares that key "content"
// (business reference text that is the point of the read). A row may also
// declare "note" for a key the name test would not catch. Matched by key name
// at any depth. A free-text field whose name is outside this list still
// depends on the review (see the README).
//
// The list is words of the key (snake_case, camelCase, kebab-case), singular
// and plural written out. `direction` alone is not on it (a sort direction);
// `directions` is. Added beyond the owner's first list: transcript(s),
// transcription, narrative, excerpt, snippet (spoken or typed text of a call or
// message). Dropped: none.
const FREE_TEXT_WORDS = Object.freeze([
  'note', 'notes', 'comment', 'comments', 'reason', 'reasons', 'instruction', 'instructions', 'detail', 'details',
  'memo', 'memos', 'remark', 'remarks', 'message', 'messages', 'description', 'descriptions', 'text', 'texts', 'body',
  'summary', 'summaries', 'script', 'scripts', 'feedback', 'explanation', 'explanations', 'directions', 'special',
  'transcript', 'transcripts', 'transcription', 'narrative', 'excerpt', 'snippet',
]);
const FREE_TEXT_WORD_SET = new Set(FREE_TEXT_WORDS);

function isFreeTextName(key) {
  return nameWords(key).some(word => FREE_TEXT_WORD_SET.has(word));
}

function withheldMarker(length) {
  return `[note withheld: ${length} characters]`;
}

// A value worth withholding: a non-blank string, or a non-empty object or array
// (the JSON `details` case). Numbers, booleans, null and empty text are not.
function hasFreeText(item) {
  if (typeof item === 'string') return item.trim() !== '';
  return item !== null && typeof item === 'object' && Object.keys(item).length > 0;
}

function shouldWithhold(key, item, freeText) {
  const kind = Object.hasOwn(freeText, key) ? freeText[key] : undefined;
  const flagged = kind === 'note' || (kind !== 'content' && isFreeTextName(key));
  return flagged && hasFreeText(item);
}

// `freeText` is the reviewed row's map { key: 'note' | 'content' }.
function withholdNotes(value, freeText, state, depth = 0) {
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(item => withholdNotes(item, freeText, state, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (shouldWithhold(key, item, freeText)) {
      state.notes += 1;
      out[key] = withheldMarker(typeof item === 'string' ? item.length : JSON.stringify(item).length);
    } else out[key] = withholdNotes(item, freeText, state, depth + 1);
  }
  return out;
}

// Credentials pasted into free text (best effort; see secret-text-scrubber.js).
function scrubFreeText(text, state) {
  const { text: clean, removed } = scrubSecretText(text);
  state.fields += removed;
  return clean;
}

// RETURNED NOTES (GATE_IB_READ_NOTES, owner ruling 2026-10-13). A value the
// withholding rule above would hide comes back instead: every string in it goes
// through the ONE fixed-format scrubber (note-secret-scrubber.js) and is cut at
// 1,000 characters. The only other rule is the structural link redaction every
// string already gets (a signed or private link becomes a marker). No prose
// rule runs on it, so gate codes and lockbox instructions come back as written. A credential-named key inside it is still
// removed.
function returnNote(item, state, depth = 0) {
  if (typeof item === 'string') {
    const { text, removed } = scrubNote(redactString(item.slice(0, SCAN_LIMIT), state));
    state.noteSecrets += removed;
    return text;
  }
  if (!item || typeof item !== 'object') return item;
  if (depth > MAX_DEPTH) { state.noteSecrets += 1; return '[too deeply nested]'; }
  if (Array.isArray(item)) return item.map(entry => returnNote(entry, state, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(item)) {
    if (entry !== null && entry !== undefined && isCredentialField(key, entry)) {
      state.noteSecrets += 1;
      out[key] = REDACTED_FIELD;
    } else out[key] = returnNote(entry, state, depth + 1);
  }
  return out;
}

// A copy of `value` with credentials removed. `state` counts what was removed.
// `notes` ({ freeText }) turns on RETURNED NOTES: a value that would be
// withheld is returned scrubbed instead. Without it nothing changes.
function redactSecrets(value, state, depth = 0, notes = null) {
  if (typeof value === 'string') return scrubFreeText(redactString(value, state), state);
  if (!value || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) { state.fields += 1; return '[too deeply nested]'; }
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, state, depth + 1, notes));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && item !== undefined && isCredentialField(key, item)) {
      state.fields += 1;
      out[key] = REDACTED_FIELD;
    } else if (notes && shouldWithhold(key, item, notes.freeText)) {
      state.notesReturned += 1;
      out[key] = returnNote(item, state);
    } else out[key] = redactSecrets(item, state, depth + 1, notes);
  }
  return out;
}

module.exports = {
  withholdNotes, isFreeTextName, FREE_TEXT_WORDS, REDACTED_LINK, REDACTED_PRIVATE_LINK, REDACTED_FIELD, PUBLIC_TOKEN_ROUTE_SEGMENTS, OWN_DOMAIN, ownHosts, isOwnHost, newState, redactSecrets, redactString, isSignedLink, isPrivateLink, looksRandom,
};
