const db = require('../models/db');
const leadAttribution = require('./lead-attribution');

const CLOSED_LEAD_STATUSES = new Set(['won', 'lost', 'unresponsive', 'disqualified', 'duplicate']);

function performedByFromTechnician(technician) {
  const name = [technician?.first_name, technician?.last_name].filter(Boolean).join(' ').trim();
  return name || 'system';
}

async function recordFirstResponseIfNeeded(database, lead, performedBy = 'system') {
  if (!lead || lead.response_time_minutes != null || !lead.first_contact_at) return;
  const firstContact = new Date(lead.first_contact_at);
  const minutes = Math.max(0, Math.round((Date.now() - firstContact.getTime()) / 60000));
  if (!Number.isFinite(minutes)) return;

  await database('leads').where({ id: lead.id }).update({
    response_time_minutes: minutes,
    updated_at: new Date(),
  });
  await database('lead_activities').insert({
    lead_id: lead.id,
    activity_type: 'first_response',
    description: `First response in ${minutes} minutes`,
    performed_by: performedBy,
  });
}

async function attachLeadToEstimate({ database = db, leadId, estimateId, technician }) {
  if (!leadId) return null;

  const lead = await database('leads').where({ id: leadId }).first();
  if (!lead) {
    const err = new Error('Lead not found');
    err.statusCode = 404;
    throw err;
  }

  const performedBy = performedByFromTechnician(technician);
  const updates = {
    estimate_id: estimateId,
    updated_at: new Date(),
  };

  await database('leads').where({ id: leadId }).update(updates);
  await database('lead_activities').insert({
    lead_id: leadId,
    activity_type: 'estimate_created',
    description: `Estimate created from lead (${estimateId})`,
    performed_by: performedBy,
    metadata: JSON.stringify({ estimateId }),
  });

  return { ...lead, ...updates };
}

async function markLinkedLeadEstimateSent({ estimateId, sendMethod, performedBy = 'system' }) {
  if (!estimateId) return;
  const leads = await db('leads').where({ estimate_id: estimateId });
  for (const lead of leads) {
    if (!CLOSED_LEAD_STATUSES.has(lead.status) && ['new', 'contacted'].includes(lead.status)) {
      await db('leads').where({ id: lead.id }).update({
        status: 'estimate_sent',
        updated_at: new Date(),
      });
    }
    await recordFirstResponseIfNeeded(db, lead, performedBy);
    await db('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'estimate_sent',
      description: `Estimate sent via ${sendMethod || 'both'} (${estimateId})`,
      performed_by: performedBy,
      metadata: JSON.stringify({ estimateId, sendMethod: sendMethod || 'both' }),
    });
  }
}

async function markLinkedLeadEstimateViewed({ estimateId, performedBy = 'system' }) {
  if (!estimateId) return;
  const leads = await db('leads').where({ estimate_id: estimateId });
  for (const lead of leads) {
    if (!CLOSED_LEAD_STATUSES.has(lead.status) && ['new', 'contacted', 'estimate_sent'].includes(lead.status)) {
      await db('leads').where({ id: lead.id }).update({
        status: 'estimate_viewed',
        updated_at: new Date(),
      });
    }
    await db('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'estimate_viewed',
      description: `Estimate viewed by customer (${estimateId})`,
      performed_by: performedBy,
      metadata: JSON.stringify({ estimateId }),
    });
  }
}

async function markLinkedLeadEstimateAccepted({
  estimateId,
  customerId,
  monthlyValue,
  initialServiceValue,
  waveguardTier,
  leadAttributionService = leadAttribution,
}) {
  if (!estimateId) return;
  const leads = await db('leads').where({ estimate_id: estimateId });
  for (const lead of leads) {
    if (CLOSED_LEAD_STATUSES.has(lead.status)) continue;
    await leadAttributionService.markConverted(lead.id, {
      customerId,
      monthlyValue,
      initialServiceValue,
      waveguardTier,
    });
  }
}

module.exports = {
  attachLeadToEstimate,
  markLinkedLeadEstimateSent,
  markLinkedLeadEstimateViewed,
  markLinkedLeadEstimateAccepted,
};
