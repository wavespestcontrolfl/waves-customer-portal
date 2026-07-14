/**
 * Socket.io server bootstrap.
 *
 * Auth middleware + connection-time room joins + connection logger.
 * Event handlers / broadcast helpers live in service modules
 * (server/services/*.js) that import { getIo } from this file.
 *
 * Rooms are joined in the `connection` event handler, NOT in middleware.
 * Middleware runs before the socket fully connects — calling
 * socket.join() there can race against the connection completing and
 * the client may miss broadcasts emitted during that window. Doing it
 * inside `connection` guarantees the socket is registered with the
 * adapter before any room write.
 *
 * Current rooms (one per event channel):
 *   dispatch:admins      — staff (admin + technician). Receives
 *                          dispatch:tech_status broadcasts on every
 *                          tech_status row upsert. Customers do not join.
 *   customer:<id>        — exactly one room per customer. The customer
 *                          joins their own room only (matched against
 *                          socket.userId). Receives customer:job_update
 *                          broadcasts on every job status transition for
 *                          a job belonging to that customer. Staff do
 *                          NOT join customer rooms — they get the same
 *                          data via dispatch:job_update.
 *
 *                          Two userTypes can join customer:<id>:
 *                            - 'customer'        — full-portal JWT session
 *                            - 'customer-track'  — public TrackPage
 *                                                  authenticated via
 *                                                  scheduled_services.
 *                                                  track_view_token (no
 *                                                  JWT). Read-only.
 *
 * CORS origins read from server/config/cors-origins.js — same source
 * the Express CORS middleware uses. Don't redefine the list here.
 *
 * Transports: websocket preferred, polling fallback. Polling stays
 * in the list so corporate networks that block ws upgrades still
 * connect (Socket.io will start on polling and upgrade when it can).
 *
 * Graceful shutdown: io.close() drains the connection set, then the
 * outer caller closes the HTTP server. Railway sends SIGTERM on
 * deploy; the wiring lives in server/index.js.
 */
const { Server } = require('socket.io');
const { allowedOrigins } = require('../config/cors-origins');
const { socketAuth } = require('./auth');
const logger = require('../services/logger');
const db = require('../models/db');
const { staffTokenVersionMatches } = require('../middleware/admin-auth');

// Module-level singleton so service modules (server/services/*.js)
// can call getIo().to(room).emit(...) without us threading the io
// instance through every function signature. Set once in
// attachSockets(); read via getIo(). Returns null if attachSockets
// hasn't run yet — service modules that emit must guard the null
// case so a test harness without sockets doesn't crash.
let _io = null;
const STAFF_RECHECK_INTERVAL_MS = 60 * 1000;

function isStaffSocket(socket) {
  return socket?.userType === 'admin' || socket?.userType === 'technician';
}

function disconnectSocket(socket, reason = 'credential_revoked') {
  if (!socket || socket.disconnected) return false;
  try {
    socket.emit('auth:revoked', { code: 'IDENTITY_REVOKED', reason });
  } catch { /* best-effort notice; disconnect remains authoritative */ }
  socket.disconnect(true);
  return true;
}

function disconnectMatchingStaffSockets(io, technicianId, reason = 'credential_revoked') {
  if (!io || !technicianId) return 0;
  let disconnected = 0;
  for (const socket of io.sockets?.sockets?.values?.() || []) {
    if (isStaffSocket(socket) && String(socket.userId) === String(technicianId)) {
      if (disconnectSocket(socket, reason)) disconnected += 1;
    }
  }
  return disconnected;
}

// Credential mutations call this after commit for immediate local-replica
// revocation. Periodic DB checks bound exposure on other replicas.
function disconnectStaffSockets(technicianId, reason = 'credential_revoked') {
  return disconnectMatchingStaffSockets(_io, technicianId, reason);
}

async function revalidateStaffSocket(socket) {
  if (!isStaffSocket(socket) || socket.disconnected) return true;
  if (socket.staffTokenExpiresAt && Date.now() >= socket.staffTokenExpiresAt) {
    disconnectSocket(socket, 'token_expired');
    return false;
  }

  let tech;
  try {
    tech = await db('technicians')
      .where({ id: socket.userId })
      .first('id', 'active', 'role', 'auth_token_version', 'must_change_password');
  } catch (err) {
    logger.error(`[socket] staff recheck failed: tech_id=${socket.userId} error=${err.message}`);
    disconnectSocket(socket, 'auth_backend_unavailable');
    return false;
  }

  const versionMatches = staffTokenVersionMatches({
    type: 'access',
    tokenVersion: socket.staffTokenVersion,
  }, tech);
  const valid = Boolean(
    tech
    && tech.active
    && !tech.must_change_password
    && tech.role === socket.userType
    && ['admin', 'technician'].includes(tech.role)
    && versionMatches
  );
  if (!valid) disconnectSocket(socket, 'credential_revoked');
  return valid;
}

function startStaffSocketRevalidation(socket) {
  if (!isStaffSocket(socket)) return null;
  const timer = setInterval(() => {
    if (socket.staffRecheckInFlight || socket.disconnected) return;
    socket.staffRecheckInFlight = true;
    void revalidateStaffSocket(socket)
      .finally(() => { socket.staffRecheckInFlight = false; });
  }, STAFF_RECHECK_INTERVAL_MS);
  timer.unref?.();
  socket.staffRecheckTimer = timer;
  return timer;
}

function stopStaffSocketRevalidation(socket) {
  if (socket?.staffRecheckTimer) clearInterval(socket.staffRecheckTimer);
  if (socket) socket.staffRecheckTimer = null;
}

function attachSockets(httpServer) {
  _io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    // pingInterval / pingTimeout left at Socket.io defaults
    // (25s / 20s) — sufficient for tech-mobile and customer-tracker
    // clients on flaky LTE.
  });

  _io.use(socketAuth);

  _io.on('connection', (socket) => {
    // Room joins live here, not in the auth middleware. See header
    // comment for why.
    if (socket.userType === 'admin' || socket.userType === 'technician') {
      socket.join('dispatch:admins');
      startStaffSocketRevalidation(socket);
    } else if (socket.userType === 'customer' || socket.userType === 'customer-track') {
      // Customer joins exactly one room: their own. socket.userId
      // came from socket auth's verified DB lookup (or, for
      // customer-track, the track_view_token resolution), so a
      // forged customer_id can't be used to join someone else's
      // room.
      socket.join(`customer:${socket.userId}`);
    }

    logger.info(
      `[socket] connect id=${socket.id} userType=${socket.userType} userId=${socket.userId} rooms=${[...socket.rooms].filter((r) => r !== socket.id).join(',') || '(none)'}`
    );

    socket.on('disconnect', (reason) => {
      stopStaffSocketRevalidation(socket);
      logger.info(
        `[socket] disconnect id=${socket.id} userType=${socket.userType} userId=${socket.userId} reason=${reason}`
      );
    });
  });

  return _io;
}

function getIo() {
  return _io;
}

module.exports = {
  STAFF_RECHECK_INTERVAL_MS,
  attachSockets,
  disconnectStaffSockets,
  getIo,
  _disconnectMatchingStaffSockets: disconnectMatchingStaffSockets,
  _revalidateStaffSocket: revalidateStaffSocket,
};
