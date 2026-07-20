const jwt = require('jsonwebtoken');
const config = require('../config');
const { isStaffAccessToken } = require('./admin-auth');

// Bytes above which a request body is "large" and must be authenticated before
// the 50 MB staff parser runs. Anything up to the 1 MB global default is always
// allowed, so small unauthenticated requests (login, OAuth callbacks, the push
// VAPID key, webhooks) pass untouched — no per-route exemptions needed.
const STAFF_LARGE_BODY_AUTH_MIN = 1 * 1024 * 1024;

// True only when we can PROVE the request body is within the 1 MB default. A
// bodiless request (no Content-Length and no Transfer-Encoding — e.g. a GET
// OAuth callback) is small; a chunked/streamed body has unknown length and is
// treated as large so it can't slip past a Content-Length-only check.
function bodyProvenSmall(req) {
  if (req.headers['transfer-encoding']) return false;
  const raw = req.headers['content-length'];
  if (raw === undefined) return true;
  const len = Number(raw);
  return Number.isFinite(len) && len <= STAFF_LARGE_BODY_AUTH_MIN;
}

// A valid staff access token — the SAME claims adminAuthenticate requires (minus
// the DB lookup, kept out of the hot path): correct type/tokenVersion, a
// technician id, and a non-terminal scope. Signature-only would let customer
// tokens, terminal-scoped tokens, or malformed tokens signed with the shared
// secret unlock the 50 MB parser.
function hasValidStaffToken(authorizationHeader) {
  const header = authorizationHeader || '';
  if (!header.startsWith('Bearer ')) return false;
  try {
    const decoded = jwt.verify(header.slice(7), config.jwt.secret);
    return isStaffAccessToken(decoded)
      && !!decoded.technicianId
      && decoded.scope !== 'terminal';
  } catch {
    return false;
  }
}

// Guards the /api/admin and /api/tech 50 MB body parsers: an anonymous or
// forged-token caller could otherwise force 50 MB of JSON parsing per request.
function requireStaffTokenForLargeBody(req, res, next) {
  if (bodyProvenSmall(req)) return next();
  if (hasValidStaffToken(req.headers.authorization)) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

module.exports = {
  requireStaffTokenForLargeBody,
  bodyProvenSmall,
  hasValidStaffToken,
  STAFF_LARGE_BODY_AUTH_MIN,
};
