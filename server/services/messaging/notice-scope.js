'use strict';
/**
 * The visit an automated customer notice is about, and that visit's
 * property AT SEND TIME, as the metadata stamp both delivery paths (SMS in
 * twilio.js, App push in push-channel-routing.js) write on the notice's
 * sms_log row. Property-scoped readers (SMS commitment evidence) trust only
 * this snapshot: a visit later moved to another property must not re-scope
 * a notice already delivered (Codex #4816 r49).
 *
 * Never throws: a failed lookup stamps the visit without a property, which
 * cannot vouch for a property-scoped promise, and the send goes on.
 */
const db = require('../../models/db');

async function noticeScope(appointmentId, conn = db) {
  if (!appointmentId) return {};
  let propertyId = null;
  try {
    propertyId = (await conn('scheduled_services').where({ id: appointmentId }).first('property_id'))?.property_id || null;
  } catch {
    propertyId = null;
  }
  return { scheduled_service_id: String(appointmentId), ...(propertyId ? { property_id: String(propertyId) } : {}) };
}

module.exports = { noticeScope };
