const REDACTED = '[REDACTED]';

/**
 * Query parameter names that commonly carry bearer credentials or other
 * reusable secrets. Normalize punctuation/casing first so access_token,
 * access-token, and accessToken receive the same treatment.
 */
function isSensitiveQueryKey(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
// quiz tokens (AGENTS.md public-newsletter block).
const UUID_BEARER_PARENTS = new Set(['unsubscribe', 'confirm', 'quiz', 'feedback']);

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

function isTokenLikePathSegment(segment, previousSegment) {
  const decoded = decodeQueryPart(segment);
  if (/^[a-f0-9]{32,}$/i.test(decoded)) return true;
  if (/^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(decoded)) return true;
  if (/^WPC-[A-HJ-NP-Z2-9]{4,}$/.test(decoded)) return true;
  // base64url bearer tokens: contract (contracts.js) and service-outline
  // (lawn-service-outline.js) mint crypto.randomBytes(32).toString('base64url')
  // → 43 chars. 40+ continuous base64url chars is a token, not a slug/id.
  if (/^[A-Za-z0-9_-]{40,}$/.test(decoded)) return true;
  if (UUID_SEGMENT.test(decoded) && UUID_BEARER_PARENTS.has(String(previousSegment || '').toLowerCase())) return true;
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
    if (segments[i] && isTokenLikePathSegment(segments[i], segments[i - 1])) {
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
function redactRequestUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return rawUrl;
  const queryStart = rawUrl.indexOf('?');
  if (queryStart < 0) return redactRequestPath(rawUrl);

  const fragmentStart = rawUrl.indexOf('#', queryStart + 1);
  const queryEnd = fragmentStart < 0 ? rawUrl.length : fragmentStart;
  const prefix = `${redactRequestPath(rawUrl.slice(0, queryStart))}?`;
  const suffix = rawUrl.slice(queryEnd);
  const query = rawUrl.slice(queryStart + 1, queryEnd);

  const redactedQuery = query.split('&').map((part) => {
    const equals = part.indexOf('=');
    const rawKey = equals < 0 ? part : part.slice(0, equals);
    const rawValue = equals < 0 ? '' : part.slice(equals + 1);
    const decodedKey = decodeQueryPart(rawKey);

    if (!isSensitiveQueryKey(decodedKey) && !looksLikeJwt(rawValue)) return part;
    return `${rawKey}=${REDACTED}`;
  }).join('&');

  return `${prefix}${redactedQuery}${suffix}`;
}

module.exports = {
  REDACTED,
  isSensitiveQueryKey,
  redactRequestPath,
  redactRequestUrl,
};
