const db = require('../models/db');
const logger = require('./logger');

// Phone normalization moved to server/utils/phone.js (PR1 of call-triage
// consolidation — see docs/call-triage-discovery.md §9). The unified
// implementation preserves the toE164 contract (return raw on garbage)
// rather than the prior `+${digits}` fabrication, which silently
// produced invalid E.164 strings on bad input.
const { normalizePhone } = require('../utils/phone');
const { startOfETMonth, etDateString } = require('../utils/datetime-et');
const { bridgeLeadFunnelStage } = require('./lead-funnel-bridge');

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
        subject: `Inbound ${type} via ${leadSource?.name || normalizedTo || 'unknown'}`,
        metadata: JSON.stringify({ callSid, messageSid, leadSourceId: leadSource?.id, channel: type }),
        created_at: new Date(),
      });
    } catch (e) {
      logger.warn(`[LeadAttribution] Could not log customer interaction: ${e.message}`);
    }
    return { type: 'existing_customer', customerId: existingCustomer.id, leadSourceId: leadSource?.id };
  }

  // Check if we already have a lead with this phone. Soft-deleted leads are
  // excluded — a new touch from that number should make a FRESH lead, not
  // silently update a row an operator removed from the pipeline.
  const existingLead = normalizedFrom
    ? await db('leads').where('phone', normalizedFrom).whereNull('deleted_at').orderBy('created_at', 'desc').first()
    : null;

  if (existingLead) {
    // Update existing lead with new touch
    const updates = {};
    if (!existingLead.lead_source_id && leadSource) updates.lead_source_id = leadSource.id;
    if (type === 'call' && callSid) updates.twilio_call_sid = callSid;
    if (type === 'sms' && messageSid) updates.twilio_message_sid = messageSid;
    if (callDuration) updates.call_duration_seconds = callDuration;
    if (recordingUrl) updates.call_recording_url = recordingUrl;
    updates.follow_up_count = (parseInt(existingLead.follow_up_count) || 0) + 1;
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
async function markConverted(leadId, { customerId, monthlyValue, initialServiceValue, waveguardTier, triggerSource } = {}) {
  // Only write the fields the caller actually supplied. Trigger-driven
  // conversions (service completed / invoice sent) have no estimate to source
  // revenue from, so they omit the value fields rather than null them out —
  // overwriting would erase monthly_value / initial_service_value /
  // waveguard_tier that the quote flow already stored for lead-ROI analytics.
  const updates = {
    status: 'won',
    converted_at: new Date(),
    is_qualified: true,
    updated_at: new Date(),
  };
  if (customerId !== undefined) updates.customer_id = customerId || null;
  if (monthlyValue !== undefined) updates.monthly_value = monthlyValue || null;
  if (initialServiceValue !== undefined) updates.initial_service_value = initialServiceValue || null;
  if (waveguardTier !== undefined) updates.waveguard_tier = waveguardTier || null;

  // Soft-deleted leads are out of every live mutation path: 0 rows updated
  // means the lead is missing or deleted, and nothing below should run.
  const updatedRows = await db('leads').where('id', leadId).whereNull('deleted_at').update(updates);
  if (!updatedRows) {
    logger.info(`[LeadAttribution] markConverted skipped — lead ${leadId} missing or deleted`);
    return;
  }

  // Mirror the win onto the lead's ad_service_attribution funnel row
  // (won → 'booked'; 'completed' stays the revenue sync's to write). Monotonic
  // in SQL and best-effort — never blocks the conversion.
  await bridgeLeadFunnelStage(leadId, 'won');

  // Attach the lead's quote to the customer so it becomes a customer estimate —
  // visible in the New Appointment "Estimate source" and convertible (until now
  // a lead estimate kept customer_id = NULL and was invisible/unbookable). Lazy
  // require breaks the lead-estimate-link ⇄ lead-attribution cycle. Best-effort:
  // a backfill miss must never break the conversion.
  if (customerId) {
    try {
      const lead = await db('leads').where('id', leadId).first('id', 'estimate_id', 'phone', 'email');
      const { linkLeadEstimatesToCustomer } = require('./lead-estimate-link');
      await linkLeadEstimatesToCustomer({ lead, customerId });
    } catch (err) {
      logger.warn(`[LeadAttribution] estimate→customer backfill failed for lead ${leadId}: ${err.message}`);
    }
  }

  await db('lead_activities').insert({
    lead_id: leadId,
    activity_type: 'converted',
    description: `Converted to customer${customerId ? ` (${customerId})` : ''}. Monthly: $${monthlyValue || 0}, Initial: $${initialServiceValue || 0}${triggerSource ? ` [via ${triggerSource}]` : ''}`,
    performed_by: 'system',
    metadata: JSON.stringify({ customerId, monthlyValue, initialServiceValue, waveguardTier, triggerSource }),
  });

  logger.info(`[LeadAttribution] Lead ${leadId} converted${triggerSource ? ` (${triggerSource})` : ''}`);
}

// ---------------------------------------------------------------------------
// 3. markLost
// ---------------------------------------------------------------------------
async function markLost(leadId, { reason, competitor, notes }) {
  const updatedRows = await db('leads').where('id', leadId).whereNull('deleted_at').update({
    status: 'lost',
    lost_reason: reason || null,
    lost_to_competitor: competitor || null,
    lost_notes: notes || null,
    updated_at: new Date(),
  });
  if (!updatedRows) {
    logger.info(`[LeadAttribution] markLost skipped — lead ${leadId} missing or deleted`);
    return;
  }

  // Funnel-row mirror: 'lost' collapses any intermediate stage but never
  // overwrites a 'completed' row (sticky — matches ad-attribution-sync).
  await bridgeLeadFunnelStage(leadId, 'lost');

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
  const lead = await db('leads').where('id', leadId).whereNull('deleted_at').first();
  if (!lead || lead.response_time_minutes != null) return; // deleted or already logged

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
      body: `Touchpoint from lead source ${sourceId}`,
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
// claimedInvoiceIds / claimedServiceIds: optional shared Sets so calculateAllSourceROI
// can de-dupe a customer's invoice/service rows ACROSS sources (a customer with
// won leads under two sources must not have the same invoice credited to both).
// revenueSourceByCustomer (optional, set by calculateAllSourceROI): customer_id →
// the source id of that customer's EARLIEST conversion in the window. A customer
// won under two sources has their revenue credited only to that one source, so
// the all-source totals never double-count and the credit follows conversion
// time, not source name. Omitted for a standalone single-source call.
// Excludes internal/test accounts (lowercased "first last" names) from a leads
// query, so ROI/revenue cover the same population as a caller's lead counts.
function applyNameExclusion(qb, names) {
  if (names && names.length) {
    qb.whereNotIn(
      db.raw("LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))"),
      names,
    );
  }
  return qb;
}

async function calculateSourceROI(leadSourceId, startDate, endDate, { revenueSourceByCustomer, excludeCustomerNames = [] } = {}) {
  const source = await db('lead_sources').where('id', leadSourceId).first();
  if (!source) return null;

  // Default to the ET month (matches /sources' startOfETMonth) so a row's cost/ROI
  // describes the same month as its lead/conversion counts, even at the UTC boundary.
  const start = startDate || startOfETMonth();
  const end = endDate || new Date();

  // Leads in date range. excludeCustomerNames drops internal/test accounts so a
  // caller (e.g. the dashboard's excluded_internal_customers contract) measures
  // ROI over the same population as its lead counts.
  const leads = await db('leads')
    .where('lead_source_id', leadSourceId)
    .whereNull('deleted_at')
    .where('first_contact_at', '>=', start)
    .where('first_contact_at', '<=', end)
    .modify((qb) => applyNameExclusion(qb, excludeCustomerNames));

  const totalLeads = leads.length;
  const wonLeads = leads.filter(l => l.status === 'won');
  const conversions = wonLeads.length;
  const conversionRate = totalLeads > 0 ? (conversions / totalLeads * 100) : 0;

  // Costs from lead_source_costs. `month` is a DATE (first of the month), so bound
  // it by ET calendar dates — comparing it to the startOfETMonth() TIMESTAMP
  // (midnight ET = 04:00 UTC) would drop the current month's row, which sits at
  // midnight UTC, and report $0 cost / inflated ROI. Leads/revenue keep timestamp bounds.
  const costs = await db('lead_source_costs')
    .where('lead_source_id', leadSourceId)
    .where('month', '>=', etDateString(start))
    .where('month', '<=', etDateString(end));

  let totalCost = costs.reduce((sum, c) => sum + parseFloat(c.cost_amount || 0), 0);

  // If no explicit costs logged, estimate from source monthly_cost
  if (totalCost === 0 && source.monthly_cost > 0) {
    const months = Math.max(1, Math.ceil((new Date(end) - new Date(start)) / (30 * 86400000)));
    totalCost = parseFloat(source.monthly_cost) * months;
  }

  // Revenue attributable to THIS source's conversions — per won-lead, strictly
  // bounded, and de-duplicated:
  //   • window-bounded [start, end] (the old query had no upper bound, leaking
  //     post-period revenue while leads/costs were windowed).
  //   • conversion-bounded — counted only from the lead's converted_at onward,
  //     so a customer's pre-conversion billing is never credited. converted_at
  //     when known, else the window start; NEVER updated_at (the admin edit
  //     route restamps it on any field change, which would mis-date the cutoff).
  //   • de-duplicated — when a customer has multiple won leads for this source,
  //     each invoice/service row is attributed to ONE conversion (earliest), so
  //     repeat/add-on leads never sum the same row twice.
  // Falls back to the captured monthly_value / initial_service_value only for a
  // customer with no billing in range AND a conversion on/before the report end.
  let totalRevenue = 0;
  const wonCustomerIds = [...new Set(wonLeads.map(l => l.customer_id).filter(Boolean))];

  let invoiceRows = [];
  let serviceRows = [];
  if (wonCustomerIds.length > 0) {
    try {
      invoiceRows = await db('invoices')
        .whereIn('customer_id', wonCustomerIds)
        // Only billed, non-reversed invoices count as revenue — exclude draft
        // (never issued), void/cancelled, and refunded (a fully-refunded invoice
        // is terminalized to 'refunded' by customer-credit.js and is no longer
        // revenue). Matches the canonical exclusion sets in mrr-breakdown.js /
        // invoice.js AR. Both 'canceled'/'cancelled' spellings appear in the code.
        .whereNotIn('status', ['void', 'cancelled', 'canceled', 'draft', 'refunded'])
        .where('created_at', '>=', start)
        .where('created_at', '<=', end)
        .select('id', 'customer_id', 'total', 'created_at');
    } catch (e) {
      invoiceRows = []; // invoices table may not exist / differ — fall through
    }
    try {
      serviceRows = await db('service_records')
        .whereIn('customer_id', wonCustomerIds)
        // Only completed services are realized revenue (same guard as
        // revenue-tools.js / tax-tools.js) — an incomplete/cancelled record
        // carrying revenue must not inflate ROI.
        .where('status', 'completed')
        // service_date is a DATE column — bound by ET date strings (like
        // lead_source_costs.month), or the 04:00-UTC ET month-start timestamp
        // would drop services on the first ET day of the month.
        .where('service_date', '>=', etDateString(start))
        .where('service_date', '<=', etDateString(end))
        // Job revenue is service_records.revenue (migration 20260401000027); there
        // is no `price` column — selecting it throws and silently voids this fallback.
        .select('id', 'customer_id', 'revenue', 'service_date');
    } catch (e) {
      serviceRows = [];
    }
  }

  const windowEnd = new Date(end);
  // Within THIS source: a customer's invoice/service row is counted once even
  // across their multiple won leads, and the fallback never re-bills a customer
  // who already had billing here. Cross-source de-dup is handled separately by
  // revenueSourceByCustomer (only the winning source attributes the customer).
  const usedInvoiceIds = new Set();
  const usedServiceIds = new Set();
  const customersWithBilling = new Set();
  // Earliest conversion first, so it claims a customer's invoice rows here.
  const orderedWonLeads = [...wonLeads].sort(
    (a, b) => new Date(a.converted_at || start) - new Date(b.converted_at || start),
  );

  for (const lead of orderedWonLeads) {
    // Cross-source attribution: credit a customer's revenue only to the source of
    // their earliest conversion. Other sources still count the conversion, not the
    // revenue — so no double-count, and the credit follows conversion time.
    if (revenueSourceByCustomer && lead.customer_id
        && revenueSourceByCustomer.get(lead.customer_id) !== leadSourceId) {
      continue;
    }
    const convertedAt = new Date(lead.converted_at || start);
    // Conversion cutoff for the DATE-typed service_date: compare ET calendar days
    // (a same-day service still counts), not the converted_at/start timestamp.
    const convertedDay = etDateString(convertedAt);
    let leadRevenue = 0;

    if (lead.customer_id) {
      const leadInvoices = invoiceRows.filter(r =>
        r.customer_id === lead.customer_id
        && new Date(r.created_at) >= convertedAt
        && !usedInvoiceIds.has(r.id));
      if (leadInvoices.length) {
        leadInvoices.forEach(r => usedInvoiceIds.add(r.id));
        leadRevenue = leadInvoices.reduce((sum, r) => sum + parseFloat(r.total || 0), 0);
      } else {
        const leadServices = serviceRows.filter(r =>
          r.customer_id === lead.customer_id
          && new Date(r.service_date).toISOString().slice(0, 10) >= convertedDay
          && !usedServiceIds.has(r.id));
        if (leadServices.length) {
          leadServices.forEach(r => usedServiceIds.add(r.id));
          leadRevenue = leadServices.reduce((sum, r) => sum + parseFloat(r.revenue || 0), 0);
        }
      }
    }

    // Captured-value fallback — only when this customer has no billing in range
    // and the conversion happened on/before the report end (a lead won AFTER a
    // historical window must not credit revenue to that closed period).
    if (leadRevenue === 0 && convertedAt <= windowEnd && !customersWithBilling.has(lead.customer_id)) {
      if (lead.monthly_value) {
        const monthsSince = Math.max(1, Math.ceil((windowEnd - convertedAt) / (30 * 86400000)));
        leadRevenue += parseFloat(lead.monthly_value) * monthsSince;
      }
      if (lead.initial_service_value) {
        leadRevenue += parseFloat(lead.initial_service_value);
      }
    }

    // Mark billed AFTER the fallback too, so a customer's second won lead in this
    // same source can't re-bill them (via invoices already claimed or the estimate).
    if (leadRevenue > 0 && lead.customer_id) customersWithBilling.add(lead.customer_id);
    totalRevenue += leadRevenue;
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
// Active-only by default — the Analytics tab (Channel Comparison, ROI Matrix,
// Phone Number ROI) must not show decommissioned sources. The Sources table
// passes includeInactive: true to also list inactive sources with their ROI.
// A shared claim set de-dupes each invoice/service row across sources.
async function calculateAllSourceROI(startDate, endDate, { includeInactive = false, excludeCustomerNames = [] } = {}) {
  // ALL sources (active + inactive) — the winner map must be built from every
  // source so attribution is identical whether or not the caller displays
  // inactive ones. Only the RETURNED rows are filtered by is_active below.
  const allSources = await db('lead_sources').orderBy('name');

  // Resolve the window once (ET month default, matching calculateSourceROI and
  // /sources) so the attribution query and every per-source call use the same bounds.
  const start = startDate || startOfETMonth();
  const end = endDate || new Date();

  // Global revenue attribution: credit each customer's revenue to the source of
  // their EARLIEST conversion in the window, so a customer won under two sources
  // is counted once and the credit follows conversion time, not source name.
  // COALESCE(converted_at, start) mirrors calculateSourceROI's per-lead cutoff, so
  // a legacy won lead with no converted_at sorts as converted at the window start.
  const revenueSourceByCustomer = new Map();
  if (allSources.length) {
    const wonLeads = await db('leads')
      .whereIn('lead_source_id', allSources.map((s) => s.id))
      .whereNull('deleted_at')
      .where('status', 'won')
      .where('first_contact_at', '>=', start)
      .where('first_contact_at', '<=', end)
      .whereNotNull('customer_id')
      .modify((qb) => applyNameExclusion(qb, excludeCustomerNames))
      .orderByRaw('COALESCE(converted_at, ?) ASC', [start])
      // Stable tiebreakers so ties on converted_at (esp. legacy NULLs that all
      // coalesce to `start`) attribute deterministically across runs/plans.
      .orderBy('first_contact_at', 'asc')
      .orderBy('id', 'asc')
      .select('lead_source_id', 'customer_id', 'converted_at');
    for (const l of wonLeads) {
      if (!revenueSourceByCustomer.has(l.customer_id)) {
        revenueSourceByCustomer.set(l.customer_id, l.lead_source_id);
      }
    }
  }

  const sourcesToReturn = includeInactive ? allSources : allSources.filter((s) => s.is_active);
  const results = [];
  for (const source of sourcesToReturn) {
    const roi = await calculateSourceROI(source.id, start, end, { revenueSourceByCustomer, excludeCustomerNames });
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
