/**
 * Insert a notification row for the tech PWA to poll (GET /api/tech/notifications).
 * Returns true when the row was written, false when the insert failed (logged, never thrown).
 */
const db = require('../models/db');
const logger = require('./logger');

async function sendTechNotification(technicianId, { type, message, payload }) {
  try {
    await db('tech_notifications').insert({
      technician_id: technicianId,
      type,
      message,
      payload: payload ? JSON.stringify(payload) : null,
    });
    return true;
  } catch (err) {
    logger.error(`[tech-notify] sendTechNotification failed: ${err.message}`);
    return false;
  }
}

module.exports = { sendTechNotification };
