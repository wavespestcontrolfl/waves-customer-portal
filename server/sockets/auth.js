/**
 * Socket.io connection auth — bridges THREE token shapes:
 *   1. JWT with decoded.customerId  — full-customer-portal session
 *   2. JWT with decoded.technicianId — staff (admin or technician)
 *   3. Public track token            — customer arrives via SMS link to
 *                                       /track/:token, no JWT. Looks up
 *                                       scheduled_services.track_view_token,
 *                                       validates expiry, derives the
 *                                       customer_id, and treats the
 *                                       socket as a (read-only)
 *                                       customer-track session that
 *                                       joins customer:<customer_id>.
 *
 * Token transport (in priority order):
 *   1. socket.handshake.auth.token       — JWT (customer or staff)
 *   2. socket.handshake.auth.trackToken  — public track token
 *   3. socket.handshake.headers.authorization  — Bearer JWT fallback
 *
 * Outcomes:
 *   - missing token        → reject with code AUTH_FAILED
 *   - JWT invalid          → reject with code AUTH_FAILED
 *   - JWT expired          → reject with code TOKEN_EXPIRED
 *   - JWT customerId       → DB lookup; active customer → join
 *                            customer:<id>; otherwise IDENTITY_REVOKED
 *   - JWT technicianId     → DB lookup; active staff with matching role
 *                            → join dispatch:admins; otherwise
 *                            IDENTITY_REVOKED
 *   - trackToken           → DB lookup on track_view_token; if found,
 *                            not expired, and the linked customer is
 *                            active → join customer:<id> (matching the
 *                            same room the public GET data backs).
 *                            Otherwise reject with TRACK_TOKEN_INVALID.
 *
 * Why a track-token path:
 *   PRs #328 / #329 / #330 emit customer:job_update on every status
 *   change. The TrackPage (a public page that customers reach via SMS
 *   link, with no login) needs a way to subscribe so its UI updates
 *   in real time. JWT auth doesn't fit — the customer hasn't signed
 *   in. The public GET endpoint already trusts the token to read the
 *   row; the socket path mirrors that trust shape.
 *
 *   Read-only: track-token sockets join the customer's room only.
 *   They don't get any other authorization. The token's expiry is the
 *   gate for how long the live channel stays open.
 *
 * Why a staff DB lookup at connect (changed from foundation PR #279):
 *   The original foundation deferred the technicians lookup. PR #284
 *   added dispatch:admins broadcasts and 12h JWT expiry made stale
 *   tokens too risky — a deactivated tech could stay subscribed up to
 *   12h. HTTP admin routes already 401 in that window because
 *   admin-auth.js does the DB lookup per request; Socket.io must do
 *   the same at the gate. Customer rooms get the same freshness check.
 *
 * Role downgrade is checked too: if the JWT claims role='admin' but
 * the DB row says role='technician' (demoted), we reject.
 *
 * Errors emit Socket.io connect_error so the client can distinguish
 * "your token expired, refresh it" from "the server is down."
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../models/db');
const logger = require('../services/logger');

// Track tokens are 64-char lowercase hex — generated as
// encode(gen_random_bytes(32), 'hex') in
// server/models/migrations/20260422000009_scheduled_services_tracking.js
// and matched by server/routes/track-public.js's TOKEN_RE. Keeping
// a copy here means a malformed string never hits the DB.
//
// (Prior version of this regex used 32 chars — Codex P1 on PR #332.
//  In prod every real token would have been rejected with
//  TRACK_TOKEN_INVALID and the customer-track socket would have
//  silently failed to connect.)
const TRACK_TOKEN_RE = /^[a-f0-9]{64}$/;

function extractAuth(socket) {
  const handshake = socket.handshake || {};
  const auth = handshake.auth || {};
  const headers = handshake.headers || {};
  const trackToken = auth.trackToken || null;
  const jwtToken =
    auth.token ||
    (headers.authorization && headers.authorization.startsWith('Bearer ')
      ? headers.authorization.slice(7)
      : null);
  return { jwtToken, trackToken };
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
  const { jwtToken, trackToken } = extractAuth(socket);

  // Track-token path: public TrackPage. Doesn't go through jwt.verify;
  // the token is opaque + non-JWT (random hex) and is matched against
  // scheduled_services.track_view_token. Successful match resolves to
  // a customer_id that the socket joins as customer:<id>.
  if (trackToken) {
    if (!TRACK_TOKEN_RE.test(trackToken)) {
      return next(rejectionError('Invalid track token', 'TRACK_TOKEN_INVALID'));
    }
    let row;
    try {
      row = await db('scheduled_services as s')
        .leftJoin('customers as c', 's.customer_id', 'c.id')
        .where('s.track_view_token', trackToken)
        .first('s.id', 's.customer_id', 's.track_token_expires_at', 'c.active');
    } catch (err) {
      logger.error(`[socket-auth] track-token lookup failed: ${err.message}`);
      return next(rejectionError('Authentication backend unavailable', 'AUTH_FAILED'));
    }
    if (!row) {
      return next(rejectionError('Invalid track token', 'TRACK_TOKEN_INVALID'));
    }
    if (row.track_token_expires_at && new Date(row.track_token_expires_at) < new Date()) {
      return next(rejectionError('Track token expired', 'TRACK_TOKEN_EXPIRED'));
    }
    if (row.active === false) {
      // Inactive customer: still let the GET endpoint return data on
      // an active job's token, but don't grant a real-time channel.
      return next(rejectionError('Identity revoked', 'IDENTITY_REVOKED'));
    }
    socket.userType = 'customer-track';
    socket.userId = row.customer_id;
    socket.trackJobId = row.id;
    return next();
  }

  if (!jwtToken) {
    return next(rejectionError('Authentication required', 'AUTH_FAILED'));
  }

  let decoded;
  try {
    decoded = jwt.verify(jwtToken, config.jwt.secret);
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
