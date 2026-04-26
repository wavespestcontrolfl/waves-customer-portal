/**
 * Socket.io server bootstrap.
 *
 * Foundation only — auth middleware + connection logger. No event
 * handlers, no room joins, no broadcast helpers. Those land in
 * scoped follow-up PRs (one per channel: dispatch:tech_status,
 * customer:job_update, dispatch:job_update, dispatch:alert).
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

function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    // pingInterval / pingTimeout left at Socket.io defaults
    // (25s / 20s) — sufficient for tech-mobile and customer-tracker
    // clients on flaky LTE.
  });

  io.use(socketAuth);

  io.on('connection', (socket) => {
    logger.info(
      `[socket] connect id=${socket.id} userType=${socket.userType} userId=${socket.userId}`
    );
    socket.on('disconnect', (reason) => {
      logger.info(
        `[socket] disconnect id=${socket.id} userType=${socket.userType} userId=${socket.userId} reason=${reason}`
      );
    });
  });

  return io;
}

module.exports = { attachSockets };
