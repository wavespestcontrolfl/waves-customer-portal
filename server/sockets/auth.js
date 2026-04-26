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
 *   - decoded technicianId → DB lookup; if technicians row exists,
 *                            is active, and role still matches the
 *                            JWT claim, set socket.userType=role
 *                            and socket.userId=technicianId; otherwise
 *                            reject with IDENTITY_REVOKED
 *   - decoded but no claim → reject with code AUTH_FAILED
 *
 * Why a staff DB lookup at connect (changed from foundation PR #279):
 *   The original foundation deferred the technicians lookup — verify
 *   the JWT, attach userType, move on. Symmetric with customers; saved
 *   a query per reconnect. That was fine when sockets had no event
 *   handlers and emitted nothing.
 *
 *   PR #284 introduces dispatch:tech_status broadcasting to a
 *   staff-only room. Admin tokens are signed with expiresIn '12h'
 *   (server/routes/admin-auth.js). Without a freshness check, a
 *   technician deactivated mid-shift, or anyone whose role was
 *   downgraded, can stay subscribed to live tech locations + customer
 *   job IDs for up to 12h. HTTP admin routes already 401 in that
 *   window because admin-auth.js does the DB lookup per request;
 *   Socket.io must do the same at the gate or the channel leaks.
 *
 *   Customer rooms (customer:<id>) arrived alongside customer:job_update.
 *   The customer path now does its own DB lookup against the customers
 *   table for the active flag, mirroring the staff freshness check.
 *   Same closed-fail posture on DB error.
 *
 * Role downgrade is checked too: if the JWT claims role='admin' but
 * the DB row says role='technician' (demoted), we reject. The JWT's
 * role claim drove the original branch; the DB is the source of truth
 * post-issuance.
 *
 * Errors emit Socket.io connect_error so the client can distinguish
 * "your token expired, refresh it" from "the server is down" — that
 * matters for the customer live tracker UX in particular.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const logger = require('../services/logger');

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

async function socketAuth(socket, next) {
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
    // Staff (admin or technician). Verify the row still exists, is
    // active, and the JWT's role claim still matches the DB. See the
    // header comment for why this lookup matters now (PR #284 added
    // the dispatch:admins broadcast room).
    let tech;
    try {
      tech = await db('technicians')
        .where({ id: decoded.technicianId })
        .first('id', 'active', 'role');
    } catch (err) {
      logger.error(`[socket-auth] technicians lookup failed: ${err.message}`);
      // Closed-fail: a DB blip shouldn't grant a stale token access.
      return next(rejectionError('Authentication backend unavailable', 'AUTH_FAILED'));
    }

    if (!tech || !tech.active) {
      logger.warn(`[socket-auth] rejecting staff token: tech_id=${decoded.technicianId} active=${tech?.active}`);
      return next(rejectionError('Identity revoked', 'IDENTITY_REVOKED'));
    }

    const dbIsStaff = tech.role === 'admin' || tech.role === 'technician';
    if (!dbIsStaff) {
      logger.warn(`[socket-auth] rejecting non-staff role: tech_id=${decoded.technicianId} role=${tech.role}`);
      return next(rejectionError('Identity revoked', 'IDENTITY_REVOKED'));
    }

    // Role downgrade check: token says admin, DB says technician → reject.
    // We use the *DB's* current role for socket.userType (not the JWT's)
    // so an upgraded user gets the new role on next reconnect even if
    // their old token is still in flight. That can't happen the other
    // direction (DB downgraded) because we reject above.
    if (decoded.role === 'admin' && tech.role !== 'admin') {
      logger.warn(`[socket-auth] rejecting role downgrade: tech_id=${decoded.technicianId} jwt=${decoded.role} db=${tech.role}`);
      return next(rejectionError('Identity revoked', 'IDENTITY_REVOKED'));
    }

    socket.userType = tech.role;       // 'admin' | 'technician', sourced from DB
    socket.userId = decoded.technicianId;
    return next();
  }

  if (decoded.customerId) {
    // Symmetric freshness check with the staff path. Customer rooms
    // arrive in this PR (customer:<id>); without a DB lookup, a
    // deactivated customer's still-valid JWT can stay subscribed to
    // their customer:<id> room and continue receiving job updates.
    // HTTP middleware (server/middleware/auth.js) already does this
    // lookup per request — Socket.io must do the same at the gate.
    let customer;
    try {
      customer = await db('customers')
        .where({ id: decoded.customerId })
        .first('id', 'active');
    } catch (err) {
      logger.error(`[socket-auth] customers lookup failed: ${err.message}`);
      // Closed-fail, same posture as the staff path.
      return next(rejectionError('Authentication backend unavailable', 'AUTH_FAILED'));
    }

    if (!customer || !customer.active) {
      logger.warn(`[socket-auth] rejecting customer token: customer_id=${decoded.customerId} active=${customer?.active}`);
      return next(rejectionError('Identity revoked', 'IDENTITY_REVOKED'));
    }

    socket.userType = 'customer';
    socket.userId = decoded.customerId;
    return next();
  }

  return next(rejectionError('Token has no recognized claim', 'AUTH_FAILED'));
}

module.exports = { socketAuth };
