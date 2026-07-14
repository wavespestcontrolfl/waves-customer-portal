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

/**
 * Redact credentials without parsing and reserializing the URL. Preserving the
 * original path/query encoding keeps request logs useful and means malformed
 * percent escapes cannot make the logger throw while handling a request.
 */
function redactRequestUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return rawUrl;
  const queryStart = rawUrl.indexOf('?');
  if (queryStart < 0) return rawUrl;

  const fragmentStart = rawUrl.indexOf('#', queryStart + 1);
  const queryEnd = fragmentStart < 0 ? rawUrl.length : fragmentStart;
  const prefix = rawUrl.slice(0, queryStart + 1);
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
  redactRequestUrl,
};
