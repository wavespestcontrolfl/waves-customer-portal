/**
 * Socket.io connection auth — bridges the two existing JWT shapes from
 * server/middleware/auth.js (customers, decoded.customerId) and
 * server/middleware/admin-auth.js (techs + admins,
 * decoded.technicianId). Either shape verifies against the same secret
 * (config.jwt.secret), so we run jwt.verify once and branch on which
 * claim is present.
 *
 * Token transport (in priority order):
 *   1. socket.handshake.auth.token  — preferred, set by client
 *      via io(url, { auth: { token } })
 *   2. socket.handshake.headers.authorization  — Bearer fallback for
 *      older clients reusing their HTTP auth header
 *
 * Outcomes:
 *   - missing token        → reject with code AUTH_FAILED
 *   - invalid signature    → reject with code AUTH_FAILED
 *   - expired              → reject with code TOKEN_EXPIRED
 *   - decoded customerId   → socket.userType='customer',
 *                            socket.userId=customerId
 *   - decoded technicianId → socket.userType=role ('admin'|'technician'),
 *                            socket.userId=technicianId
 *   - decoded but no claim → reject with code AUTH_FAILED
 *
 * Customer/tech identity lookups (verifying the row still exists +
 * is active) are deferred — the HTTP middleware does that on every
 * request, but a connection lookup would 2x the auth load on every
 * reconnect. Foundation scope is verify-and-attach; row hydration
 * lands when the first event handler needs it.
 *
 * Errors emit Socket.io connect_error so the client can distinguish
 * "your token expired, refresh it" from "the server is down" — that
 * matters for the customer live tracker UX in particular.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');

function extractToken(socket) {
  const authToken = socket.handshake.auth && socket.handshake.auth.token;
  if (authToken) return authToken;

  const header = socket.handshake.headers && socket.handshake.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);

  return null;
}

function rejectionError(message, code) {
  // next(err) on a Socket.io middleware fires connect_error on the
  // client. Setting err.data lets the client distinguish error codes
  // — the default behavior only surfaces err.message, but err.data
  // is included in connect_error events.
  const err = new Error(message);
  err.data = { code };
  return err;
}

function socketAuth(socket, next) {
  const token = extractToken(socket);
  if (!token) {
    return next(rejectionError('Authentication required', 'AUTH_FAILED'));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(rejectionError('Token expired', 'TOKEN_EXPIRED'));
    }
    return next(rejectionError('Invalid token', 'AUTH_FAILED'));
  }

  if (decoded.technicianId) {
    // admin-auth.js shape. role lives on the JWT claim itself
    // (signed at login from technicians.role), so we don't need a DB
    // lookup at connect time. 'admin' or 'technician' both map to
    // staff-side userType — the role string itself is the userType so
    // downstream room-scoping code in later PRs can branch on it
    // without a second lookup.
    socket.userType = decoded.role === 'admin' ? 'admin' : 'technician';
    socket.userId = decoded.technicianId;
    return next();
  }

  if (decoded.customerId) {
    socket.userType = 'customer';
    socket.userId = decoded.customerId;
    return next();
  }

  return next(rejectionError('Token has no recognized claim', 'AUTH_FAILED'));
}

module.exports = { socketAuth };
