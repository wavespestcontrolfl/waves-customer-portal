const crypto = require('crypto');

const REDACTED = '[REDACTED]';

/**
 * Query parameter names that commonly carry bearer credentials or other
 * reusable secrets. Normalize punctuation/casing first so access_token,
 * access-token, and accessToken receive the same treatment.
 */
function isSensitiveQueryKey(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Free-text lookup parameters carry whatever the operator typed — street
  // addresses, phone numbers, names, emails (/api/admin/customers?search=,
  // the address-keyed lookups). PII in request logs is an AGENTS.md P1;
  // the log keeps the path and every other parameter.
  if (['search', 'q', 'query', 'address'].includes(normalized)) return true;
  // The click-to-call bridge hands Twilio the customer's number and name on
  // the /outbound-admin-prompt URL (services/call-bridge.js); Twilio's
  // callback lands in the request log with them (codex #4072 r2 P1).
  if (['customernumber', 'leadname'].includes(normalized)) return true;
  return ['auth', 'jwt', 'code', 'key', 'nonce', 'otp', 'session', 'sessionid', 'ticket'].includes(normalized)
    || normalized.includes('token')
    || normalized.includes('authorization')
    || normalized.includes('apikey')
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('credential')
    || normalized.includes('signature');
}

function decodeQueryPart(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, ' '));
  } catch {
    return String(value || '');
  }
}

function looksLikeJwt(value) {
  const decoded = decodeQueryPart(value);
  return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(decoded);
}

// Path segments that ARE bearer credentials. Every public-token surface
// (pay/receipt/contract/estimate/review/reschedule/report/track/share) mints
// crypto.randomBytes(16|32).toString('hex') → 32/64 lowercase hex, so the
// hex rule alone covers them; JWTs cover signed links. Booking confirmation
// codes (WPC- + the 32-symbol alphabet from utils/slot-offer-token.js) are
// the single factor on GET /booking/status/:code — the alphabet excludes
// 0/1/I/O so real invoice numbers (WPC-2026-0001) never match. UUID segments
// stay (they're row ids all over admin logs, not secrets) EXCEPT directly
// after the newsletter bearer prefixes, where a randomUUID IS the credential.
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 'feedback' — newsletter reaction links (/api/public/newsletter/
// feedback/:token/:reaction) use the same randomUUID bearer class as the
// quiz tokens (AGENTS.md public-newsletter block). 'e' — event
// click-through links (/api/public/newsletter/e/:token/:eventId) carry
// the SAME engagement_token, which also authorizes quiz/feedback writes.
const UUID_BEARER_PARENTS = new Set(['unsubscribe', 'confirm', 'quiz', 'feedback', 'e']);

// Legacy estimate slug tokens (nameSlug-8hex, the pre-estimate-versions admin
// share-link format — estimate-public and estimate-slots-public TOKEN_REs
// still accept them) are bearer credentials the length-based rules above
// never match. Scope an explicit rule to estimate path parents so
// /estimate/jane-doe-9f8e7d6c and /api/estimates/jane-doe-9f8e7d6c/data stop
// logging reusable quote links with customer pricing/contact details. The
// -8hex suffix requirement keeps fixed admin children (slots, config,
// extension-request, UUID row ids) out of scope.
const ESTIMATE_BEARER_PARENTS = new Set(['estimate', 'estimates']);
const LEGACY_ESTIMATE_SLUG = /^[a-z0-9][a-z0-9-]*-[a-f0-9]{8}$/i;

// Secure-card capture links (appointment-card-request.js) mint
// crypto.randomBytes(16).toString('base64url') → 22 chars — below the 40+
// generic base64url rule above, so scope the shorter shape to the secure-card
// parents: the SPA path (/secure/<token>) and the API mount
// (/api/public/secure-card/<token>[/complete|/select-plan]). Legacy 64-hex
// secure-card tokens are already caught by the 32+-hex rule.
const SECURE_CARD_BEARER_PARENTS = new Set(['secure', 'secure-card']);
const SECURE_CARD_SHORT_TOKEN = /^[A-Za-z0-9_-]{22}$/;

// The consultation page's lead bearer (Codex #4737 r5 P1) —
// `<leadId>.<exp>[.<channel>].<sig>` under /inspection/ (SPA) and
// /api/public/inspection/ (API). Its dotted shape matches none of the
// generic rules below, so any segment under that parent is redacted.
const CONSULTATION_TOKEN_PARENTS = new Set(['inspection']);


function isTokenLikePathSegment(segment, previousSegment) {
  const decoded = decodeQueryPart(segment);
  if (CONSULTATION_TOKEN_PARENTS.has(String(previousSegment || '').toLowerCase())) return true;
  if (/^[a-f0-9]{32,}$/i.test(decoded)) return true;
  if (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(decoded)) return true;
  if (/^WPC-[A-HJ-NP-Z2-9]{4,}$/.test(decoded)) return true;
  // base64url bearer tokens: contract (contracts.js) and service-outline
  // (lawn-service-outline.js) mint crypto.randomBytes(32).toString('base64url')
  // → 43 chars. 40+ continuous base64url chars is a token, not a slug/id.
  if (/^[A-Za-z0-9_-]{40,}$/.test(decoded)) return true;
  if (UUID_SEGMENT.test(decoded) && UUID_BEARER_PARENTS.has(String(previousSegment || '').toLowerCase())) return true;
  if (SECURE_CARD_SHORT_TOKEN.test(decoded)
    && SECURE_CARD_BEARER_PARENTS.has(String(previousSegment || '').toLowerCase())) return true;
  if (!UUID_SEGMENT.test(decoded)
    && LEGACY_ESTIMATE_SLUG.test(decoded)
    && ESTIMATE_BEARER_PARENTS.has(String(previousSegment || '').toLowerCase())) return true;
  return false;
}

/**
 * Redact token-like path segments, preserving original encoding. Public
 * bearer tokens ride the PATH on this app (/api/pay/<token>, …), so a
 * query-only redactor still writes reusable credentials into request logs.
 */
function redactRequestPath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath) return rawPath;
  const segments = rawPath.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    // Link-preview images (routes/og-preview.js): under /og only a bare kind
    // ("report") or a fixed card file ("pay.jpg") is kept (card names are
    // short words; bearer tokens are 32+ characters); anything else —
    // a token, with or without an encoded suffix or separator
    // (/og/report%2F<token>.jpg) — is whatever a caller put there, so it is
    // redacted. Case-insensitive: Express routes /OG/ here too.
    const underOg = segments[0] === '' && String(segments[1] || '').toLowerCase() === 'og';
    const ogFile = underOg && (i >= 3 || (i === 2 && !/^[a-z-]{1,20}(\.jpg)?$/i.test(segments[i] || '')));
    if (segments[i] && (ogFile || isTokenLikePathSegment(segments[i], segments[i - 1]))) {
      segments[i] = REDACTED;
    }
  }
  return segments.join('/');
}

/**
 * Redact credentials without parsing and reserializing the URL. Preserving the
 * original path/query encoding keeps request logs useful and means malformed
 * percent escapes cannot make the logger throw while handling a request.
 * Covers BOTH the query string and token-bearing path segments.
 */
function redactRequestUrl(rawUrl, { maskAllQuery = false } = {}) {
  if (typeof rawUrl !== 'string') return rawUrl;
  const queryStart = rawUrl.indexOf('?');
  if (queryStart < 0) return redactRequestPath(rawUrl);

  const fragmentStart = rawUrl.indexOf('#', queryStart + 1);
  const queryEnd = fragmentStart < 0 ? rawUrl.length : fragmentStart;
  const prefix = `${redactRequestPath(rawUrl.slice(0, queryStart))}?`;
  const suffix = maskAllQuery && fragmentStart >= 0 ? `#${REDACTED}` : rawUrl.slice(queryEnd);
  const query = rawUrl.slice(queryStart + 1, queryEnd);

  const redactedQuery = query.split('&').map((part) => {
    const equals = part.indexOf('=');
    const rawKey = equals < 0 ? part : part.slice(0, equals);
    const rawValue = equals < 0 ? '' : part.slice(equals + 1);
    const decodedKey = decodeQueryPart(rawKey);

    // Every value masked, keys kept. A part with no "=" is masked whole (it is
    // a key and a value at once).
    if (maskAllQuery) return equals < 0 ? REDACTED : `${rawKey}=${REDACTED}`;
    if (!isSensitiveQueryKey(decodedKey) && !looksLikeJwt(rawValue)) return part;
    return `${rawKey}=${REDACTED}`;
  }).join('&');

  return `${prefix}${redactedQuery}${suffix}`;
}

// The Intelligence Bar's general admin read (services/intelligence-bar/
// admin-read-tools.js) sends its loopback GET with this header. The query
// filters and the path parameters on it are chosen by the model and can hold a
// name, phone or email the key-based rules above do not know ("email",
// "phone", "name", a free-text service name), so the request logs mask EVERY
// query value and every path segment that came from a parameter.
//
// The marker is trusted only when it is provably ours, because anyone can send
// a header: the value carries a per-process secret generated when this module
// loads (never logged, never returned, never in an env var), compared in
// constant time, AND the request arrived on a loopback socket
// (req.socket.remoteAddress, never req.ip or a forwarded header). Anything
// else is an ordinary request and is logged exactly as an unmarked one. The
// tool and the logger share the secret by requiring this same module in the
// same process: the loopback call goes to this process's own port
// (config.port); the server runs as one Node process per container (no
// cluster, no workers), and replicas are separate containers whose loopback is
// their own. If a request ever reached a different process, its secret would
// not match and it would simply be logged in full.
//
// Format: "<secret>" (no path parameters) or "<secret>;p=3,5": the zero-based
// indexes of the path segments after /api that are parameters (the tool filled
// the pattern, so it knows). The index list is parsed strictly: digits and
// commas only, at most 12 indexes, each under 40. An authenticated marker whose
// list does not parse falls back to masking EVERY path segment after the first
// two (/api/admin/... stays), so a bad list can only log less, never more.
const ADMIN_READ_HEADER = 'x-ib-admin-read';
const MARKER_SECRET = crypto.randomBytes(16).toString('hex');
const MARKER_SECRET_BUFFER = Buffer.from(MARKER_SECRET);
const MAX_PARAM_INDEXES = 12;
const MAX_SEGMENT_INDEX = 40;
const INDEX_LIST_RE = /^p=(\d{1,2}(?:,\d{1,2})*)$/;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function markerValue(req) {
  const value = req?.headers?.[ADMIN_READ_HEADER];
  return String(Array.isArray(value) ? value[0] : value ?? '');
}

function isLoopbackRequest(req) {
  return LOOPBACK_ADDRESSES.has(req?.socket?.remoteAddress);
}

function secretMatches(candidate) {
  const buffer = Buffer.from(candidate);
  return buffer.length === MARKER_SECRET_BUFFER.length && crypto.timingSafeEqual(buffer, MARKER_SECRET_BUFFER);
}

// null: an ordinary request (no marker, a wrong secret, or not from loopback).
// { params: [indexes] } for an authenticated marker; { params: null } for an
// authenticated marker with an unparseable index list.
function adminReadMarker(req) {
  const [secret, list, ...extra] = markerValue(req).split(';');
  if (!secret || !secretMatches(secret) || !isLoopbackRequest(req)) return null;
  if (list === undefined) return { params: [] };
  const match = extra.length === 0 ? INDEX_LIST_RE.exec(list) : null;
  const indexes = match ? match[1].split(',').map(Number) : [];
  const valid = match && indexes.length <= MAX_PARAM_INDEXES && indexes.every(index => index < MAX_SEGMENT_INDEX);
  return { params: valid ? indexes : null };
}

function isAdminReadRequest(req) {
  return adminReadMarker(req) !== null;
}

// Mask path segments of the logged URL by their position after /api. `params`
// is a list of indexes, or null for "every segment after /api/admin".
function maskPathSegments(url, params) {
  const queryStart = url.search(/[?#]/);
  const path = queryStart < 0 ? url : url.slice(0, queryStart);
  const rest = queryStart < 0 ? '' : url.slice(queryStart);
  const segments = path.split('/');
  // segments[0] is '' (before the first slash) and segments[1] is "api".
  const first = segments[1] === 'api' ? 2 : 1;
  const masked = segments.map((segment, position) => {
    const index = position - first;
    if (index < 0 || !segment) return segment;
    return params === null ? (index >= 1 ? REDACTED : segment) : (params.includes(index) ? REDACTED : segment);
  });
  return masked.join('/') + rest;
}

// The request's URL as it may be logged: the redactor above, with every query
// value and every parameter path segment masked when the request carries the
// admin-read marker. One helper for the access log and the error logger.
function redactRequestUrlFor(req, rawUrl = req?.originalUrl || req?.url || '') {
  const marker = adminReadMarker(req);
  if (!marker || typeof rawUrl !== 'string') return redactRequestUrl(rawUrl);
  return redactRequestUrl(maskPathSegments(rawUrl, marker.params), { maskAllQuery: true });
}

// What the tool sends: the secret, then ";p=<indexes>" for the parameter
// segments of the catalog pattern (zero-based, after /api).
function adminReadMarkerValue(paramIndexes = []) {
  return paramIndexes.length ? `${MARKER_SECRET};p=${paramIndexes.join(',')}` : MARKER_SECRET;
}

module.exports = {
  ADMIN_READ_HEADER,
  adminReadMarkerValue,
  isAdminReadRequest,
  redactRequestUrlFor,
  REDACTED,
  isSensitiveQueryKey,
  redactRequestPath,
  redactRequestUrl,
};
