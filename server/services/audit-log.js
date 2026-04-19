const db = require('../models/db');
const logger = require('./logger');

/**
 * Thin writer for the generic audit_log table. Fire-and-forget: failures are
 * logged but never thrown, so audit writes can't wedge a business flow.
 *
 * Keep metadata small — this is an event record, not a log dump. Large
 * payloads (full API responses, stack traces) belong elsewhere.
 */
async function recordAuditEvent({
  actor_type,
  actor_id = null,
  action,
  resource_type = null,
  resource_id = null,
  metadata = {},
  ip_address = null,
  user_agent = null,
}) {
  try {
    await db('audit_log').insert({
      actor_type,
      actor_id,
      action,
      resource_type,
      resource_id,
      metadata,
      ip_address,
      user_agent,
    });
  } catch (err) {
    logger.error(`[audit-log] write failed for ${action}: ${err.message}`);
  }
}

function ipFromReq(req) {
  return (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
}

function uaFromReq(req) {
  return req.headers?.['user-agent'] || null;
}

module.exports = { recordAuditEvent, ipFromReq, uaFromReq };
