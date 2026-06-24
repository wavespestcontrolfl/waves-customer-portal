const db = require('../models/db');
const logger = require('./logger');
const leadAttribution = require('./lead-attribution');

const CLOSED_LEAD_STATUSES = new Set(['won', 'lost', 'unresponsive', 'disqualified', 'duplicate']);

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return digits || null;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function leadMatchesEstimateContact(lead, estimate) {
  if (!lead || !estimate) return false;
  if (lead.customer_id && estimate.customer_id) {
    return String(lead.customer_id) === String(estimate.customer_id);
  }

  const leadPhone = normalizePhone(lead.phone);
  const estimatePhone = normalizePhone(estimate.customer_phone);
  if (leadPhone && estimatePhone && leadPhone === estimatePhone) return true;

  const leadEmail = normalizeEmail(lead.email);
  const estimateEmail = normalizeEmail(estimate.customer_email);
  return !!(leadEmail && estimateEmail && leadEmail === estimateEmail);
}

function assertLeadCanAttachEstimate({ lead, estimate, estimateId, allowReplacingEstimateId = false }) {
  if (!lead) {
    const err = new Error('Lead not found');
    err.statusCode = 404;
    throw err;
  }
  if (CLOSED_LEAD_STATUSES.has(lead.status)) {
    const err = new Error('Lead is closed and cannot be linked to a new estimate');
    err.statusCode = 409;
    throw err;
  }
  if (
    lead.estimate_id
    && String(lead.estimate_id) !== String(estimateId)
    && !allowReplacingEstimateId
  ) {
    const err = new Error('Lead is already linked to another estimate');
    err.statusCode = 409;
    throw err;
  }
  if (!leadMatchesEstimateContact(lead, estimate)) {
    const err = new Error('Lead contact does not match estimate contact');
    err.statusCode = 409;
    throw err;
  }
}

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

async function attachLeadToEstimate({
  database = db,
  leadId,
  estimateId,
  estimate = null,
  technician,
  allowReplacingEstimateId = false,
}) {
  if (!leadId) return null;

  const lead = await database('leads').where({ id: leadId }).first();

  const estimateForValidation = estimate || await database('estimates').where({ id: estimateId }).first();
  assertLeadCanAttachEstimate({
    lead,
    estimate: estimateForValidation,
    estimateId,
    allowReplacingEstimateId,
  });

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
  database = db,
}) {
  if (!estimateId) return;

  let leads = (await database('leads').where({ estimate_id: estimateId }))
    .filter((lead) => !CLOSED_LEAD_STATUSES.has(lead.status));

  // Accepted-but-unlinked fallback: when the estimate was never FK-linked to
  // its originating lead (created standalone, so `leads.estimate_id` is null),
  // the query above finds nothing and the lead would stay stuck in `new` even
  // though the customer just accepted. Acceptance is the authoritative "won"
  // signal, so match the accepted customer's contact to an open, never-yet-
  // converted lead (customer_id IS NULL — see findUnconvertedLeadsByContact for
  // why we never sweep an existing customer's other open add-on leads).
  if (!leads.length && customerId) {
    const customer = await database('customers').where({ id: customerId }).first();
    if (customer) {
      leads = (await findUnconvertedLeadsByContact(database, customer.phone, customer.email))
        .filter((lead) => !CLOSED_LEAD_STATUSES.has(lead.status));
      if (leads.length > 1) {
        logger.warn(`[lead-trigger] estimate ${estimateId} acceptance matched ${leads.length} open leads by contact; converting all`, {
          estimateId,
          customerId,
          leadIds: leads.map((lead) => lead.id),
        });
      }
    }
  }

  for (const lead of leads) {
    await leadAttributionService.markConverted(lead.id, {
      customerId,
      monthlyValue,
      initialServiceValue,
      waveguardTier,
    });
  }
}

// ---------------------------------------------------------------------------
// Shared lead resolver used by the one-off backfill (server/scripts/
// backfill-lead-acceptance-triggers.js). Resolves the originating lead by the
// strongest signal available — estimate link, then the customer's normalized
// phone/email among never-converted leads — and converts it. NEVER throws: a
// miss returns a reason instead of breaking the caller.
// ---------------------------------------------------------------------------

function estimateValueHints(estimate) {
  if (!estimate) return {};
  const money = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    monthlyValue: money(estimate.monthly_total),
    initialServiceValue: money(estimate.onetime_total),
    waveguardTier: estimate.waveguard_tier || null,
  };
}

// Contact fallback — only OPEN, NOT-yet-converted leads (customer_id IS NULL),
// matched on the last 10 phone digits (lead/customer phones are stored in
// mixed E.164 / 10-digit formats) or a case-insensitive email. The
// `customer_id IS NULL` guard is deliberate: an existing customer can hold
// separate open leads already attached to them (e.g. public quote links stamp
// `leads.customer_id`), and we must never sweep those unrelated add-on leads.
// We only rescue the originating lead that was never linked to anyone.
async function findUnconvertedLeadsByContact(database, phone, email) {
  const np = normalizePhone(phone);
  const ne = normalizeEmail(email);
  if (!np && !ne) return [];
  return database('leads')
    .whereNotIn('status', [...CLOSED_LEAD_STATUSES])
    .whereNull('customer_id')
    .andWhere((builder) => {
      if (np) builder.orWhereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = ?", [np]);
      if (ne) builder.orWhereRaw("LOWER(COALESCE(email, '')) = ?", [ne]);
    });
}

async function convertLeadFromEvent({
  source,
  estimateId = null,
  customerId = null,
  phone = null,
  email = null,
  database = db,
  leadAttributionService = leadAttribution,
}) {
  try {
    let resolvedCustomerId = customerId || null;
    let resolvedPhone = phone || null;
    let resolvedEmail = email || null;
    let valueHints = {};
    let haveEstimateHints = false;

    if (estimateId) {
      const estimate = await database('estimates').where({ id: estimateId }).first();
      if (estimate) {
        resolvedCustomerId = resolvedCustomerId || estimate.customer_id || null;
        resolvedPhone = resolvedPhone || estimate.customer_phone || null;
        resolvedEmail = resolvedEmail || estimate.customer_email || null;
        valueHints = estimateValueHints(estimate);
        haveEstimateHints = true;
      }
    }

    // Resolve the originating lead:
    //  1. estimate link (`leads.estimate_id`) — authoritative.
    //  2. contact match among UNCONVERTED leads — the originating lead that was
    //     never linked. We do NOT match every open lead on the customer; see
    //     findUnconvertedLeadsByContact for why.
    let candidates = [];
    if (estimateId) {
      candidates = await database('leads').where({ estimate_id: estimateId });
    }
    if (!candidates.length) {
      if (!resolvedPhone && !resolvedEmail && resolvedCustomerId) {
        const customer = await database('customers').where({ id: resolvedCustomerId }).first();
        resolvedPhone = customer?.phone || null;
        resolvedEmail = customer?.email || null;
      }
      if (resolvedPhone || resolvedEmail) {
        candidates = await findUnconvertedLeadsByContact(database, resolvedPhone, resolvedEmail);
      }
    }

    const open = (candidates || []).filter((lead) => lead && !CLOSED_LEAD_STATUSES.has(lead.status));
    if (!open.length) return { converted: false, reason: 'no_open_lead' };
    if (open.length > 1) {
      logger.warn(`[lead-trigger] ${source} matched ${open.length} open leads; converting all`, {
        source,
        estimateId,
        customerId: resolvedCustomerId,
        leadIds: open.map((lead) => lead.id),
      });
    }

    for (const lead of open) {
      const conversion = { triggerSource: source };
      if (resolvedCustomerId) conversion.customerId = resolvedCustomerId;
      else if (lead.customer_id) conversion.customerId = lead.customer_id;
      // Pass revenue fields only when an estimate supplied them — otherwise
      // markConverted preserves whatever the lead already has.
      if (haveEstimateHints) {
        conversion.monthlyValue = valueHints.monthlyValue;
        conversion.initialServiceValue = valueHints.initialServiceValue;
        conversion.waveguardTier = valueHints.waveguardTier;
      }
      await leadAttributionService.markConverted(lead.id, conversion);
    }
    return { converted: true, count: open.length, leadIds: open.map((lead) => lead.id) };
  } catch (err) {
    logger.error(`[lead-trigger] convertLeadFromEvent failed (${source || 'unknown'}): ${err.message}`);
    return { converted: false, reason: 'error' };
  }
}

module.exports = {
  attachLeadToEstimate,
  assertLeadCanAttachEstimate,
  leadMatchesEstimateContact,
  markLinkedLeadEstimateSent,
  markLinkedLeadEstimateViewed,
  markLinkedLeadEstimateAccepted,
  convertLeadFromEvent,
  findUnconvertedLeadsByContact,
};
