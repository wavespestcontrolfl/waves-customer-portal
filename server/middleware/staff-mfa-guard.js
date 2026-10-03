// Pre-router guard for the staff two-step code step (POST
// /api/admin/auth/login/mfa, GATE_ADMIN_MFA). No-store/noindex/no-referrer
// headers, then the generic unknown-route 404 while the gate is dark.
// server/index.js mounts it ahead of cors(), the global `/api/` limiter, the
// login limiter and the body parsers, so a probe never sees a revealing 401
// or 429 while dark; the route re-runs it.
const { noStore } = require('./no-store');
const { notFoundBody } = require('./errors');
const { adminMfaLive } = require('../services/staff-mfa');

const loginMfaPreParserGuard = [
  noStore,
  (req, res, next) => {
    if (!adminMfaLive()) return res.status(404).json(notFoundBody(req));
    return next();
  },
];

module.exports = { loginMfaPreParserGuard };
