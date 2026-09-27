'use strict';
/**
 * The visit an automated customer notice is about, and that visit's
 * property AT SEND TIME, as the metadata stamp both delivery paths (SMS in
 * twilio.js, App push in push-channel-routing.js) write on the notice's
 * sms_log row. Property-scoped readers (SMS commitment evidence) trust only
 * this snapshot: a visit later moved to another property must not re-scope
 * a notice already delivered (Codex #4816 r49).
 *
 * appointmentId, when present, is authoritative (the send names its own
 * visit directly). Otherwise, `invoiceId` resolves the visit THROUGH the
 * invoice it is a receipt for (invoices.scheduled_service_id) — a plain
 * payment-receipt SMS (InvoiceService.sendReceipt) carries no appointmentId
 * of its own, so without this a property-scoped settlement question could
 * never be answered by an ordinary receipt (Codex round 1 P2, #4996).
 *
 * Never throws: a failed lookup stamps the visit without a property (or
 * nothing at all), which cannot vouch for a property-scoped promise, and the
 * send goes on.
 */
const db = require('../../models/db');

async function noticeScope(appointmentId, { invoiceId, conn = db } = {}) {
  let visitId = appointmentId || null;
  if (!visitId && invoiceId) {
    try {
      visitId = (await conn('invoices').where({ id: invoiceId }).first('scheduled_service_id'))?.scheduled_service_id || null;
    } catch {
      visitId = null;
    }
  }
  if (!visitId) return {};
  let propertyId = null;
  try {
    propertyId = (await conn('scheduled_services').where({ id: visitId }).first('property_id'))?.property_id || null;
  } catch {
    propertyId = null;
  }
  return { scheduled_service_id: String(visitId), ...(propertyId ? { property_id: String(propertyId) } : {}) };
}

module.exports = { noticeScope };
