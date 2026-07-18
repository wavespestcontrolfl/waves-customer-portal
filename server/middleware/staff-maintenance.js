const jwt = require('jsonwebtoken');
const config = require('../config');

const STAFF_API_PREFIXES = [
  '/api/admin',
  '/api/tech',
  '/api/dispatch',
  '/api/knowledge',
  // Staff-only routers mounted outside the four conventional namespaces.
  '/api/stripe/terminal',
  '/api/service/records',
  '/api/ai/admin',
  '/api/visual-moments',
];

// Bouncie vehicle/location reads are customer-authenticated and must remain
// online. Only the Staff OAuth start/callback are closed; callback is listed
// because it authenticates with signed OAuth state (not a bearer) and persists
// integration credentials.
const STAFF_API_EXACT_PATHS = new Set([
  '/api/bouncie/auth',
  '/api/bouncie/callback',
]);

// visual-service-moments is mounted at /api rather than under /api/tech.
const STAFF_API_PATTERNS = [
  /^\/api\/jobs\/[^/]+\/visual-moments(?:\/|$)/,
];

const RETRY_AFTER_SECONDS = 60;

// This is an operational interlock, not a normal feature flag. Only the exact
// lowercase string "true" closes Staff ingress; typos must be visible in the
// health response instead of being interpreted inconsistently across deploys.
function isStaffMaintenanceEnabled(env = process.env) {
  return env?.STAFF_MAINTENANCE_MODE === 'true';
}

function canonicalRequestPath(req = {}) {
  const source = [req.originalUrl, req.url, req.path]
    .find((value) => typeof value === 'string') || '/';
  let pathname;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) {
    try {
      // RFC 7230 permits absolute-form request targets when a client talks to
      // a proxy. Express can route their pathname, so the gate must too.
      pathname = new URL(source).pathname;
    } catch {
      pathname = source;
    }
  } else {
    pathname = source;
  }
  pathname = pathname.split(/[?#]/, 1)[0] || '/';

  // Decode a small, bounded number of times so an encoded path cannot become a
  // Staff route after a proxy normalization step. Invalid escapes stay as-is;
  // they cannot hide a clear, undecoded Staff prefix.
  for (let i = 0; i < 3; i += 1) {
    try {
      const decoded = decodeURIComponent(pathname);
      if (decoded === pathname) break;
      pathname = decoded;
    } catch {
      break;
    }
  }

  pathname = pathname.replace(/\\/g, '/').replace(/\/+/g, '/');
  const segments = [];
  for (const segment of pathname.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`.toLowerCase();
}

function isStaffApiPath(req) {
  const pathname = canonicalRequestPath(req);
  return STAFF_API_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(`${prefix}/`)
  ))
    || STAFF_API_EXACT_PATHS.has(pathname)
    || STAFF_API_PATTERNS.some((pattern) => pattern.test(pathname));
}

function extractBearerToken(authorization) {
  if (typeof authorization !== 'string') return null;
  // Use the first bearer credential, matching the legacy auth middleware's
  // split-on-space behavior. A harmless trailing value must not let a token
  // accepted by an older Staff-only helper slip around maintenance.
  const match = authorization.match(/^Bearer[\t ]+([^\s,]+)/i);
  return match ? match[1] : null;
}

function isSignedStaffJwt(token) {
  if (typeof token !== 'string' || !token) return false;
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    return decoded?.technicianId != null;
  } catch {
    return false;
  }
}

function requestCarriesSignedStaffJwt(req = {}) {
  const token = extractBearerToken(req.headers?.authorization);
  return isSignedStaffJwt(token);
}

function shouldBlockStaffHttpRequest(req) {
  if (!isStaffMaintenanceEnabled()) return false;

  // Health is the operator's verification surface and must remain reachable,
  // even if a browser or probe happens to attach a cached Staff bearer token.
  if (canonicalRequestPath(req) === '/api/health') return false;

  return isStaffApiPath(req) || requestCarriesSignedStaffJwt(req);
}

function sendStaffMaintenanceResponse(res) {
  res.set('Retry-After', String(RETRY_AFTER_SECONDS));
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
  return res.status(503).json({
    error: 'Staff access is temporarily unavailable',
    code: 'STAFF_MAINTENANCE',
  });
}

function staffMaintenance(req, res, next) {
  if (!shouldBlockStaffHttpRequest(req)) return next();
  return sendStaffMaintenanceResponse(res);
}

module.exports = {
  canonicalRequestPath,
  isSignedStaffJwt,
  isStaffMaintenanceEnabled,
  staffMaintenance,
};
