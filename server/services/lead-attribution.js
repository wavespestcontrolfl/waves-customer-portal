const db = require('../models/db');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Phone normalization
// ---------------------------------------------------------------------------
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.startsWith('+')) return phone;
  return `+${digits}`;
}

// ---------------------------------------------------------------------------
// 1. attributeInboundContact
// ---------------------------------------------------------------------------
async function attributeInboundContact({ from, to, type, callSid, messageSid, callDuration, recordingUrl }) {
  const normalizedFrom = normalizePhone(from);
  const normalizedTo = normalizePhone(to);

  // Look up lead source by the Twilio number that received the call/sms
  let leadSource = null;
  if (normalizedTo) {
    leadSource = await db('lead_sources')
      .where('twilio_phone_number', normalizedTo)
      .where('is_active', true)
      .first();
  }

  // Check if caller is already a customer
  const existingCustomer = normalizedFrom
    ? await db('customers').where('phone', normalizedFrom).first()
    : null;

  if (existingCustomer) {
    // Log touch for existing customer rather than creating a lead
    logger.info(`[LeadAttribution] Existing customer touch: ${existingCustomer.id} via source ${leadSource?.id || 'unknown'}`);
    try {
      await db('customer_interactions').insert({
        customer_id: existingCustomer.id,
        interaction_type: type === 'call' ? 'inbound_call' : 'inbound_sms',
        channel: type,
        notes: `Inbound ${type} via ${leadSource?.name || normalizedTo || 'unknown'}`,
        metadata: JSON.stringify({ callSid, messageSid, leadSourceId: leadSource?.id }),
        created_at: new Date(),
      });
    } catch (e) {
      logger.warn(`[LeadAttribution] Could not log customer interaction: ${e.message}`);
    }
    return { type: 'existing_customer', customerId: existingCustomer.id, leadSourceId: leadSource?.id };
  }

  // Check if we already have a lead with this phone
  const existingLead = normalizedFrom
    ? await db('leads').where('phone', normalizedFrom).orderBy('created_at', 'desc').first()
    : null;

  if (existingLead) {
    // Update existing lead with new touch
    const updates = {};
    if (!existingLead.lead_source_id && leadSource) updates.lead_source_id = leadSource.id;
    if (type === 'call' && callSid) updates.twilio_call_sid = callSid;
    if (type === 'sms' && messageSid) updates.twilio_message_sid = messageSid;
    if (callDuration) updates.call_duration_seconds = callDuration;
    if (recordingUrl) updates.call_recording_url = recordingUrl;
    updates.follow_up_count = (existingLead.follow_up_count || 0) + 1;
    updates.updated_at = new Date();

    if (Object.keys(updates).length > 1) {
      await db('leads').where('id', existingLead.id).update(updates);
    }

    await db('lead_activities').insert({
      lead_id: existingLead.id,
      activity_type: type === 'call' ? 'inbound_call' : 'inbound_sms',
      description: `Follow-up ${type} via ${leadSource?.name || normalizedTo || 'unknown'}`,
      performed_by: 'system',
      metadata: JSON.stringify({ callSid, messageSid, callDuration }),
    });

    logger.info(`[LeadAttribution] Updated existing lead ${existingLead.id}`);
    return { type: 'existing_lead', leadId: existingLead.id, leadSourceId: leadSource?.id };
  }

  // Create new lead
  const leadType = type === 'call' ? 'inbound_call' : 'inbound_sms';
  const [newLead] = await db('leads').insert({
    lead_source_id: leadSource?.id || null,
    phone: normalizedFrom,
    lead_type: leadType,
    first_contact_at: new Date(),
    first_contact_channel: type,
    twilio_call_sid: callSid || null,
    twilio_message_sid: messageSid || null,
    call_duration_seconds: callDuration || null,
    call_recording_url: recordingUrl || null,
    status: 'new',
  }).returning('*');

  await db('lead_activities').insert({
    lead_id: newLead.id,
    activity_type: 'created',
    description: `New lead from ${leadType} via ${leadSource?.name || normalizedTo || 'unknown'}`,
    performed_by: 'system',
    metadata: JSON.stringify({ callSid, messageSid, from: normalizedFrom, to: normalizedTo }),
  });

  logger.info(`[LeadAttribution] New lead created: ${newLead.id} from ${leadSource?.name || 'unknown source'}`);
  return { type: 'new_lead', leadId: newLead.id, leadSourceId: leadSource?.id };
}

// ---------------------------------------------------------------------------
// 2. markConverted
// ---------------------------------------------------------------------------
async function markConverted(leadId, { customerId, monthlyValue, initialServiceValue, waveguardTier }) {
  await db('leads').where('id', leadId).update({
    status: 'won',
    customer_id: customerId || null,
    monthly_value: monthlyValue || null,
    initial_service_value: initialServiceValue || null,
    waveguard_tier: waveguardTier || null,
    converted_at: new Date(),
    is_qualified: true,
    updated_at: new Date(),
  });

  await db('lead_activities').insert({
    lead_id: leadId,
    activity_type: 'converted',
    description: `Converted to customer${customerId ? ` (${customerId})` : ''}. Monthly: $${monthlyValue || 0}, Initial: $${initialServiceValue || 0}`,
    performed_by: 'system',
    metadata: JSON.stringify({ customerId, monthlyValue, initialServiceValue, waveguardTier }),
  });

  logger.info(`[LeadAttribution] Lead ${leadId} converted`);
}

// ---------------------------------------------------------------------------
// 3. markLost
// ---------------------------------------------------------------------------
async function markLost(leadId, { reason, competitor, notes }) {
  await db('leads').where('id', leadId).update({
    status: 'lost',
    lost_reason: reason || null,
    lost_to_competitor: competitor || null,
    lost_notes: notes || null,
    updated_at: new Date(),
  });

  await db('lead_activities').insert({
    lead_id: leadId,
    activity_type: 'lost',
    description: `Lead lost: ${reason || 'no reason'}${competitor ? ` — to ${competitor}` : ''}`,
    performed_by: 'system',
    metadata: JSON.stringify({ reason, competitor, notes }),
  });

  logger.info(`[LeadAttribution] Lead ${leadId} marked lost: ${reason}`);
}

// ---------------------------------------------------------------------------
// 4. logFirstResponse
// ---------------------------------------------------------------------------
async function logFirstResponse(leadId) {
  const lead = await db('leads').where('id', leadId).first();
  if (!lead || lead.response_time_minutes != null) return; // already logged

  const firstContact = new Date(lead.first_contact_at);
  const now = new Date();
  const minutes = Math.round((now - firstContact) / 60000);

  await db('leads').where('id', leadId).update({
    response_time_minutes: minutes,
    updated_at: new Date(),
  });

  await db('lead_activities').insert({
    lead_id: leadId,
    activity_type: 'first_response',
    description: `First response in ${minutes} minutes`,
    performed_by: 'system',
  });

  return minutes;
}

// ---------------------------------------------------------------------------
// 5. logSourceTouch
// ---------------------------------------------------------------------------
async function logSourceTouch(sourceId, customerId, type) {
  try {
    await db('customer_interactions').insert({
      customer_id: customerId,
      interaction_type: type || 'source_touch',
      channel: 'lead_source',
      notes: `Touchpoint from lead source ${sourceId}`,
      metadata: JSON.stringify({ leadSourceId: sourceId, type }),
      created_at: new Date(),
    });
  } catch (e) {
    logger.warn(`[LeadAttribution] Could not log source touch: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 6. calculateSourceROI
// ---------------------------------------------------------------------------
async function calculateSourceROI(leadSourceId, startDate, endDate) {
  const source = await db('lead_sources').where('id', leadSourceId).first();
  if (!source) return null;

  const start = startDate || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const end = endDate || new Date();

  // Leads in date range
  const leads = await db('leads')
    .where('lead_source_id', leadSourceId)
    .where('first_contact_at', '>=', start)
    .where('first_contact_at', '<=', end);

  const totalLeads = leads.length;
  const wonLeads = leads.filter(l => l.status === 'won');
  const conversions = wonLeads.length;
  const conversionRate = totalLeads > 0 ? (conversions / totalLeads * 100) : 0;

  // Costs from lead_source_costs
  const costs = await db('lead_source_costs')
    .where('lead_source_id', leadSourceId)
    .where('month', '>=', start)
    .where('month', '<=', end);

  let totalCost = costs.reduce((sum, c) => sum + parseFloat(c.cost_amount || 0), 0);

  // If no explicit costs logged, estimate from source monthly_cost
  if (totalCost === 0 && source.monthly_cost > 0) {
    const months = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / (30 * 86400000)));
    totalCost = parseFloat(source.monthly_cost) * months;
  }

  // Revenue from converted leads
  let totalRevenue = 0;
  const customerIds = wonLeads.map(l => l.customer_id).filter(Boolean);

  if (customerIds.length > 0) {
    // Try invoices table for actual revenue
    try {
      const invoiceRevenue = await db('invoices')
        .whereIn('customer_id', customerIds)
        .where('created_at', '>=', start)
        .sum('total as total')
        .first();
      if (invoiceRevenue && parseFloat(invoiceRevenue.total) > 0) {
        totalRevenue = parseFloat(invoiceRevenue.total);
      }
    } catch (e) {
      // invoices table may not exist or have different schema
    }

    // Fallback: try service_records
    if (totalRevenue === 0) {
      try {
        const serviceRevenue = await db('service_records')
          .whereIn('customer_id', customerIds)
          .where('service_date', '>=', start)
          .sum('price as total')
          .first();
        if (serviceRevenue && parseFloat(serviceRevenue.total) > 0) {
          totalRevenue = parseFloat(serviceRevenue.total);
        }
      } catch (e) {
        // fallback to monthly_value estimate
      }
    }

    // Final fallback: monthly_value * months since conversion
    if (totalRevenue === 0) {
      for (const lead of wonLeads) {
        if (lead.monthly_value) {
          const convertedAt = lead.converted_at || lead.updated_at;
          const monthsSince = Math.max(1, Math.ceil((new Date(end) - new Date(convertedAt)) / (30 * 86400000)));
          totalRevenue += parseFloat(lead.monthly_value) * monthsSince;
        }
        if (lead.initial_service_value) {
          totalRevenue += parseFloat(lead.initial_service_value);
        }
      }
    }
  }

  const costPerLead = totalLeads > 0 ? totalCost / totalLeads : 0;
  const costPerAcquisition = conversions > 0 ? totalCost / conversions : 0;
  const roi = totalCost > 0 ? ((totalRevenue - totalCost) / totalCost * 100) : (totalRevenue > 0 ? Infinity : 0);

  // Average response time for this source's leads
  const responseLeads = leads.filter(l => l.response_time_minutes != null);
  const avgResponseTime = responseLeads.length > 0
    ? Math.round(responseLeads.reduce((s, l) => s + l.response_time_minutes, 0) / responseLeads.length)
    : null;

  return {
    source,
    totalLeads,
    conversions,
    conversionRate: Math.round(conversionRate * 10) / 10,
    totalCost: Math.round(totalCost * 100) / 100,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    costPerLead: Math.round(costPerLead * 100) / 100,
    costPerAcquisition: Math.round(costPerAcquisition * 100) / 100,
    roi: roi === Infinity ? 9999 : Math.round(roi * 10) / 10,
    avgResponseTime,
    startDate: start,
    endDate: end,
  };
}

// ---------------------------------------------------------------------------
// 7. calculateAllSourceROI
// ---------------------------------------------------------------------------
async function calculateAllSourceROI(startDate, endDate) {
  const sources = await db('lead_sources').where('is_active', true).orderBy('name');
  const results = [];
  for (const source of sources) {
    const roi = await calculateSourceROI(source.id, startDate, endDate);
    if (roi) results.push(roi);
  }
  return results;
}

module.exports = {
  normalizePhone,
  attributeInboundContact,
  markConverted,
  markLost,
  logFirstResponse,
  logSourceTouch,
  calculateSourceROI,
  calculateAllSourceROI,
};
