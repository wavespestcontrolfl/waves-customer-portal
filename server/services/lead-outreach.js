/**
 * Manual operator SMS send to a lead: the lead_activities audit row, the
 * first-response stamp (logFirstResponse), and the new→contacted status
 * transition (+ funnel bridge) every manual lead text gets.
 *
 * Shared by admin-leads.js's POST /:id/send-sms AND
 * admin-communications.js's POST /sms (when the consultation-link lane
 * resolved a lead with no customer row, leadId rides through in the body
 * instead of the send being rerouted to the leads route — pre-push Codex
 * P1: rerouting bypassed /sms's own interlocks, the Agent Review draft's
 * atomic claim, pending-suggestion thread parking, and the active
 * auto-send check). Both routes call this SAME function so they can never
 * drift on what "a lead got manually texted" records.
 *
 * Best-effort by design at the CALLER's discretion: a caller that already
 * confirmed a real provider send should treat a throw here as fail-soft
 * bookkeeping (log and continue) rather than fail the response — the text
 * already left.
 */

const db = require('../models/db');
const leadAttribution = require('./lead-attribution');

async function recordLeadSmsOutreach({ leadId, message, performedBy } = {}) {
  if (!leadId) return null;
  const lead = await db('leads').where('id', leadId).whereNull('deleted_at').first();
  if (!lead) return null;

  const cleanMessage = String(message || '');
  await db('lead_activities').insert({
    lead_id: leadId,
    activity_type: 'sms_sent',
    description: `SMS sent: ${cleanMessage.slice(0, 100)}${cleanMessage.length > 100 ? '...' : ''}`,
    performed_by: performedBy || 'Admin',
    metadata: JSON.stringify({ message: cleanMessage }),
  });

  if (lead.response_time_minutes == null) {
    await leadAttribution.logFirstResponse(leadId);
  }

  if (lead.status === 'new') {
    const changed = await db('leads').where('id', leadId).where('status', 'new').update({ status: 'contacted', updated_at: new Date() });
    // Funnel-row mirror (monotonic, best-effort).
    if (changed) {
      const { bridgeLeadFunnelStage } = require('./lead-funnel-bridge');
      await bridgeLeadFunnelStage(leadId, 'contacted');
    }
  }

  return db('leads').where('id', leadId).first();
}

module.exports = { recordLeadSmsOutreach };
