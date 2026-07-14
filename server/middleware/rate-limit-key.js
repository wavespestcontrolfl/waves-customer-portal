/**
 * Shared rate-limit key generator — factored out of index.js so route-level
 * limiters (e.g. the Ask Waves paid-LLM chat limiter) key IDENTICALLY to the
 * global + daily limiters instead of falling back to express-rate-limit's raw
 * req.ip default.
 *
 * Key authenticated requests by JWT subject so each admin/tech/customer gets
 * their own bucket. Falls back to a /64-collapsed client IP for
 * unauthenticated traffic — keying by raw req.ip would let an IPv6 client
 * rotate addresses within their subnet to evade the limit. Without per-user
 * keying, a single busy admin session (dispatch page + grid + per-action
 * refreshes) can exhaust the per-IP allowance and lock everyone behind the
 * same NAT out of the API.
 */
const { isIP } = require('node:net');
const jwt = require('jsonwebtoken');
const config = require('../config');

function ipFallbackKey(ip) {
  if (!ip) return ip;
  const v = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  if (isIP(v) !== 6) return v;
  // Canonicalize before slicing the /64 — equivalent textual forms
  // (uppercase, leading zeros, "::" placement) must yield the same bucket
  // key, otherwise a single client could rotate notation to evade the limit.
  const lower = v.toLowerCase();
  const [head, tail] = lower.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const missing = lower.includes('::') ? Math.max(0, 8 - headParts.length - tailParts.length) : 0;
  const fillers = Array(missing).fill('0');
  const groups = lower.includes('::') ? [...headParts, ...fillers, ...tailParts] : lower.split(':');
  const prefix = groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':');
  return `${prefix}::/64`;
}

function rateLimitKey(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && config.jwt.secret) {
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], config.jwt.secret);
      if (decoded.technicianId) {
        if (
          decoded.type !== 'access'
          || !Number.isInteger(decoded.tokenVersion)
          || decoded.tokenVersion < 1
        ) {
          return ipFallbackKey(req.ip);
        }
        return `tech:${decoded.technicianId}:v${decoded.tokenVersion}`;
      }
      if (decoded.type === 'refresh') return ipFallbackKey(req.ip);
      if (decoded.customerId) return `cust:${decoded.customerId}`;
    } catch { /* fall through to IP */ }
  }
  return ipFallbackKey(req.ip);
}

// Auth endpoints are intentionally unauthenticated. Never let an attached
// signed JWT select a subject bucket there; otherwise callers can alternate
// tokens to evade login/reset limits. ipFallbackKey still collapses IPv6 /64s.
function unauthenticatedAuthLimitKey(req) {
  return ipFallbackKey(req?.ip);
}

module.exports = { ipFallbackKey, rateLimitKey, unauthenticatedAuthLimitKey };
