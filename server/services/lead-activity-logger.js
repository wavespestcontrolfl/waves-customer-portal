const db = require('../models/db');
const { toE164 } = require('../utils/phone');
const logger = require('./logger');

async function findLeadByPhone(phone) {
  const e164 = toE164(phone);
  if (!e164) return null;
  return db('leads').where({ phone: e164 }).orderBy('created_at', 'desc').first();
}

async function getTechnicianName(adminUserId) {
  if (!adminUserId) return null;
  try {
    const tech = await db('technicians').where({ id: adminUserId }).first();
    return tech?.name || null;
  } catch {
    return null;
  }
}

// Outbound SMS reaches sendSMS from many callers — auto-replies, the Lead
// Response Agent, the inbox composer, internal admin alerts. We classify
// from messageType + adminUserId so the timeline can show "Adam sent" vs
// "System auto-reply" vs "LRA followup" without each caller having to log
// its own activity row.
function classifyOutbound({ messageType, adminUserId }) {
  // LRA logs its own canonical row in lead-response-tools.js (with
  // sent/blocked/failed + audit_log_id metadata), so we skip here to
  // avoid two stacked rows for the same send.
  if (messageType === 'internal_alert' || messageType === 'lead_response') return null;
  if (adminUserId) return { activity_type: 'sms_sent', performer: 'manual_admin' };
  if (messageType === 'auto_reply') return { activity_type: 'sms_auto_reply', performer: 'system' };
  if (messageType === 'lead_outreach') return { activity_type: 'sms_auto_reply', performer: 'lead_response_agent' };
  return { activity_type: 'sms_sent', performer: 'system' };
}

async function logSms({ leadId, phone, direction, body, messageType, adminUserId, twilioSid }) {
  try {
    let lead = null;
    if (leadId) {
      lead = await db('leads').where({ id: leadId }).first();
    } else if (phone) {
      lead = await findLeadByPhone(phone);
    }
    if (!lead) return;

    let activity_type;
    let performed_by;
    let descriptionPrefix;

    if (direction === 'inbound') {
      activity_type = 'sms_received';
      performed_by = `${lead.first_name || 'Lead'} ${lead.last_name || ''}`.trim() || 'Lead';
      descriptionPrefix = 'Reply received';
    } else {
      const cls = classifyOutbound({ messageType, adminUserId });
      if (!cls) return;
      activity_type = cls.activity_type;
      if (cls.performer === 'manual_admin') {
        performed_by = (await getTechnicianName(adminUserId)) || 'Admin';
      } else if (cls.performer === 'lead_response_agent') {
        performed_by = 'Lead Response Agent';
      } else {
        performed_by = 'System';
      }
      descriptionPrefix = activity_type === 'sms_auto_reply' ? 'Auto-reply sent' : 'SMS sent';
    }

    const safeBody = body || '';
    const snippet = safeBody.slice(0, 100);
    const truncated = safeBody.length > 100 ? '…' : '';

    await db('lead_activities').insert({
      lead_id: lead.id,
      activity_type,
      description: `${descriptionPrefix}: ${snippet}${truncated}`,
      performed_by,
      metadata: JSON.stringify({
        message_type: messageType || null,
        twilio_sid: twilioSid || null,
        body: safeBody,
      }),
    });
  } catch (err) {
    logger.error(`[lead-activity-logger] Failed to log SMS activity: ${err.message}`);
  }
}

module.exports = { logSms, findLeadByPhone };
