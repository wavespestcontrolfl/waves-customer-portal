/**
 * Path rules for the Intelligence Bar's general admin read (owner ruling
 * 2026-10-12). Shared by the catalog generator
 * (scripts/build-ib-admin-read-catalog.js) and the runtime reader
 * (admin-read-tools.js), so a path is judged by one definition at build time
 * and again at call time.
 *
 * Pure functions, no I/O. Everything here fails closed: a path the rules
 * cannot read is denied.
 */

// A path parameter value: no slash, no percent sign, no whitespace.
const PARAM_VALUE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const QUERY_KEY_RE = /^[A-Za-z0-9_.[\]-]{1,60}$/;
const MAX_QUERY_KEYS = 20;
const MAX_QUERY_VALUE = 200;

// Words that mark a credential, an identity flow or an outside callback.
// Matched against the words inside each path segment ("api-key", "apiKey",
// "oauth_callback" all hit).
const SENSITIVE_WORDS = new Set([
  'auth', 'oauth', 'login', 'logout', 'mfa', 'password', 'passwords', 'credential', 'credentials',
  'secret', 'secrets', 'token', 'tokens', 'callback', 'callbacks', 'webhook', 'webhooks',
  'session', 'sessions', 'jwt', 'otp', 'apikey', 'apikeys', 'gates',
]);
// Words that mark a file, a download or a long-lived stream, not a JSON read.
const STREAM_WORDS = new Set([
  'export', 'exports', 'download', 'downloads', 'csv', 'pdf', 'xlsx', 'xls', 'zip', 'stream', 'streams',
  'sse', 'subscribe', 'events',
]);
// The final literal segment names an action, not a read.
const EFFECT_VERBS = new Set([
  'sync', 'refresh', 'run', 'trigger', 'generate', 'recompute', 'recalculate', 'recalc', 'mark',
  'send', 'enqueue', 'import', 'rebuild', 'reset', 'retry', 'execute',
]);
// Whole prefixes that never join the catalog.
const DENIED_PREFIXES = ['/admin/credentials', '/admin/auth', '/admin/intelligence-bar', '/admin/feature-flags'];

function splitPath(path) {
  return String(path || '').split('/').filter(Boolean);
}

function isParam(segment) {
  return typeof segment === 'string' && segment.startsWith(':');
}

function segmentWords(segment) {
  const spaced = String(segment).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const words = spaced.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  // "api-key" and "apiKey" read as one word for the credential check.
  const compact = String(segment).toLowerCase().replace(/[^a-z0-9]/g, '');
  return compact.includes('apikey') ? [...words, 'apikey'] : words;
}

function segmentDenyReason(segment, isLast) {
  const lowered = segment.toLowerCase();
  if (/\.[a-z0-9]{1,6}$/.test(lowered)) return 'file_extension';
  const words = segmentWords(segment);
  if (words.some(word => SENSITIVE_WORDS.has(word))) return 'credential_or_identity_path';
  if (words.some(word => STREAM_WORDS.has(word))) return 'file_or_stream_path';
  if (isLast && words.some(word => EFFECT_VERBS.has(word))) return 'action_verb_path';
  return null;
}

// Why a path pattern (or concrete path) is outside the catalog, or null.
function denyReason(path) {
  const text = String(path || '');
  if (!text.startsWith('/admin/') || text.includes('?') || text.includes('#') || text.includes('%')
    || text.includes('\\') || text.includes('//')) return 'not_a_plain_admin_path';
  const lowered = text.toLowerCase();
  if (DENIED_PREFIXES.some(prefix => lowered === prefix || lowered.startsWith(`${prefix}/`))) return 'denied_prefix';
  const segments = splitPath(text);
  const literals = segments.map((segment, index) => ({ segment, index })).filter(({ segment }) => !isParam(segment));
  const lastLiteralIndex = literals.length ? literals[literals.length - 1].index : -1;
  for (const { segment, index } of literals) {
    if (segment === '.' || segment === '..') return 'dot_segment';
    const reason = segmentDenyReason(segment, index === lastLiteralIndex && index === segments.length - 1);
    if (reason) return reason;
  }
  return null;
}

function patternParams(pattern) {
  return splitPath(pattern).filter(isParam).map(segment => segment.slice(1));
}

// Fill a catalog pattern. Returns { path } or { error }. Nothing here reads
// the network; encodeURIComponent is belt and braces over PARAM_VALUE_RE.
function fillPattern(pattern, params) {
  const wanted = patternParams(pattern);
  const given = params && typeof params === 'object' && !Array.isArray(params) ? params : null;
  if (!given) return { error: 'params must be an object of strings' };
  const extra = Object.keys(given).filter(key => !wanted.includes(key));
  if (extra.length) return { error: `Unexpected params: ${extra.join(', ')}` };
  const out = [];
  for (const segment of splitPath(pattern)) {
    if (!isParam(segment)) { out.push(segment); continue; }
    const name = segment.slice(1);
    const value = given[name];
    if (typeof value !== 'string' && typeof value !== 'number') return { error: `Missing param: ${name}` };
    const text = String(value);
    if (!PARAM_VALUE_RE.test(text) || /^\.+$/.test(text)) return { error: `Param ${name} has characters that are not allowed` };
    out.push(encodeURIComponent(text));
  }
  return { path: `/${out.join('/')}` };
}

// Query string from scalars only. Returns { search } or { error }.
function buildSearch(query) {
  if (query === undefined || query === null) return { search: '' };
  if (typeof query !== 'object' || Array.isArray(query)) return { error: 'query must be an object of scalar values' };
  const entries = Object.entries(query);
  if (entries.length > MAX_QUERY_KEYS) return { error: `At most ${MAX_QUERY_KEYS} query keys` };
  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    if (!QUERY_KEY_RE.test(key)) return { error: `Query key not allowed: ${key.slice(0, 40)}` };
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
      return { error: `Query value for ${key} must be a string, number or boolean` };
    }
    search.append(key, String(value).slice(0, MAX_QUERY_VALUE));
  }
  const text = search.toString();
  return { search: text ? `?${text}` : '' };
}

// Express matches literals without regard to case, and a pattern segment
// with a wildcard, an optional mark or a regex acts as a parameter.
function routeSegmentIsWild(segment) {
  return isParam(segment) || /[*?()+]/.test(segment);
}

// Could the concrete path reach an unreviewed route of the same shape through
// a parameter value that spells one of that route's literal segments?
// `pattern` is the catalog pattern the path was built from.
function collidesWithRoute(route, concreteSegments, pattern) {
  const routeSegments = splitPath(route);
  const patternSegments = splitPath(pattern);
  if (routeSegments.length !== concreteSegments.length || patternSegments.length !== routeSegments.length) return false;
  let usesParamValue = false;
  for (let i = 0; i < routeSegments.length; i++) {
    if (routeSegmentIsWild(routeSegments[i])) continue;
    if (routeSegments[i].toLowerCase() !== String(concreteSegments[i]).toLowerCase()) return false;
    if (isParam(patternSegments[i])) usesParamValue = true;
  }
  return usesParamValue;
}

module.exports = {
  PARAM_VALUE_RE, QUERY_KEY_RE, MAX_QUERY_KEYS, MAX_QUERY_VALUE, DENIED_PREFIXES,
  splitPath, isParam, segmentWords, denyReason, patternParams, fillPattern, buildSearch,
  routeSegmentIsWild, collidesWithRoute,
};
