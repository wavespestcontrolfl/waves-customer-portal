const db = require('../models/db');
const logger = require('./logger');
const leadAttribution = require('./lead-attribution');
const { resolveLeadSource } = require('./lead-source-resolver');
const { etDateString } = require('../utils/datetime-et');

const CLOSED_LEAD_STATUSES = new Set(['won', 'lost', 'unresponsive', 'disqualified', 'duplicate']);

// A DATE column comes back as a 'YYYY-MM-DD' string or a UTC-midnight Date — take
// its calendar day directly, without shifting it through a timezone.
function dateOnly(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}

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

// Resolve which lead(s) an estimate "sent"/"viewed" event should advance.
//
// Primary: FK-linked leads (`leads.estimate_id`) — the authoritative tie, of
// which there may be several (re-sends, manually linked rows). Behavior for this
// case is unchanged.
//
// When NO FK-linked lead exists, rescue the originating lead so a STANDALONE
// estimate — one built outside the lead's "Create Estimate" button (e.g. from the
// Estimates tab, or after Convert to Customer), which never got `leads.estimate_id`
// — still advances its lead on send/view. This mirrors the fallbacks the
// acceptance path (`markLinkedLeadEstimateAccepted`) already uses, so the pipeline
// stays consistent: an estimate that can mark a lead "won" on acceptance can also
// mark it "estimate_sent"/"viewed".
//
// Rescue is deliberately conservative — it never guesses which deal an event
// belongs to:
//   1. the public-quote mirror (`estimate_data.lead_id`) — that lead carries a
//      customer_id, so the contact fallback's `customer_id IS NULL` guard misses it.
//   2. else a SINGLE unambiguous open, never-linked, never-converted lead matched
//      on normalized phone/email. 0 or 2+ matches → none.
// Every rescued candidate must still pass the contact-match check and be open and
// unlinked. Returns { leads, rescued, estimate }.
async function resolveEstimateEventLeads(database, estimateId) {
  const linked = await database('leads').where({ estimate_id: estimateId });
  if (linked.length) return { leads: linked, rescued: false };

  const estimate = await database('estimates').where({ id: estimateId }).first();
  if (!estimate) return { leads: [], rescued: false };

  // 1. Public-quote mirror — match the named lead by id, then re-validate it is
  //    open, not already linked to another estimate, and a genuine contact match.
  const dataLeadId = parseEstimateData(estimate.estimate_data)?.lead_id || null;
  if (dataLeadId) {
    const lead = await database('leads').where({ id: dataLeadId }).first();
    if (
      lead
      && !lead.estimate_id
      && !CLOSED_LEAD_STATUSES.has(lead.status)
      && leadMatchesEstimateContact(lead, estimate)
    ) {
      return { leads: [lead], rescued: true, estimate };
    }
    return { leads: [], rescued: false };
  }

  // 2. Contact fallback — a single open, never-linked, never-converted lead whose
  //    normalized phone/email matches the estimate's contact. `findUnconverted-
  //    LeadsByContact` already restricts to `customer_id IS NULL` + not-closed;
  //    the extra `!estimate_id` guard ensures we never steal a lead already tied
  //    to a different estimate.
  const matches = (await findUnconvertedLeadsByContact(database, estimate.customer_phone, estimate.customer_email))
    .filter((lead) => !lead.estimate_id && !CLOSED_LEAD_STATUSES.has(lead.status));
  if (matches.length === 1) return { leads: matches, rescued: true, estimate };
  if (matches.length > 1) {
    logger.warn(`[lead-estimate-link] estimate ${estimateId} send/view: ambiguous contact match (${matches.length} open leads) — not advancing`, {
      estimateId,
      leadIds: matches.map((lead) => lead.id),
    });
  }
  return { leads: [], rescued: false };
}

// Stamp `leads.estimate_id` onto a lead rescued by contact/mirror match and log
// the link. Scoped to `estimate_id IS NULL` so a concurrent linker can't be
// clobbered. Returns whether THIS call won the stamp: if another process linked
// the lead (to a different estimate) between resolution and here, the update
// touches 0 rows and we return false so the caller skips advancing/logging the
// lead for our estimate. The activity is written only on a win.
async function linkRescuedLead(database, lead, estimate, performedBy) {
  const linked = await database('leads')
    .where({ id: lead.id })
    .whereNull('estimate_id')
    .update({ estimate_id: estimate.id, updated_at: new Date() });
  if (!linked) return false;
  await database('lead_activities').insert({
    lead_id: lead.id,
    activity_type: 'estimate_created',
    description: `Estimate linked to lead by contact match (${estimate.id})`,
    performed_by: performedBy,
    metadata: JSON.stringify({ estimateId: estimate.id, linkedBy: 'contact_match' }),
  });
  return true;
}

async function markLinkedLeadEstimateSent({ estimateId, sendMethod, performedBy = 'system', database = db }) {
  if (!estimateId) return;
  const { leads, rescued, estimate } = await resolveEstimateEventLeads(database, estimateId);
  for (const lead of leads) {
    // Only advance a rescued lead if WE won the link stamp — otherwise another
    // estimate claimed it between resolution and now, and it isn't ours to move.
    if (rescued && estimate && !(await linkRescuedLead(database, lead, estimate, performedBy))) continue;
    if (!CLOSED_LEAD_STATUSES.has(lead.status) && ['new', 'contacted'].includes(lead.status)) {
      await database('leads').where({ id: lead.id }).update({
        status: 'estimate_sent',
        updated_at: new Date(),
      });
    }
    await recordFirstResponseIfNeeded(database, lead, performedBy);
    await database('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'estimate_sent',
      description: `Estimate sent via ${sendMethod || 'both'} (${estimateId})`,
      performed_by: performedBy,
      metadata: JSON.stringify({ estimateId, sendMethod: sendMethod || 'both' }),
    });
  }
}

async function markLinkedLeadEstimateViewed({ estimateId, performedBy = 'system', database = db }) {
  if (!estimateId) return;
  const { leads, rescued, estimate } = await resolveEstimateEventLeads(database, estimateId);
  for (const lead of leads) {
    // Only advance a rescued lead if WE won the link stamp (see send path).
    if (rescued && estimate && !(await linkRescuedLead(database, lead, estimate, performedBy))) continue;
    if (!CLOSED_LEAD_STATUSES.has(lead.status) && ['new', 'contacted', 'estimate_sent'].includes(lead.status)) {
      await database('leads').where({ id: lead.id }).update({
        status: 'estimate_viewed',
        updated_at: new Date(),
      });
    }
    await database('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'estimate_viewed',
      description: `Estimate viewed by customer (${estimateId})`,
      performed_by: performedBy,
      metadata: JSON.stringify({ estimateId }),
    });
  }
}

function parseEstimateData(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
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

  // Stamp the accepted estimate onto a rescued (previously unlinked) lead so
  // accepted-estimate reporting that joins on `leads.estimate_id`
  // (seo/conversion-feedback-miner) counts it, then convert it.
  const convert = async (lead) => {
    if (!lead.estimate_id) {
      await database('leads').where({ id: lead.id }).update({ estimate_id: estimateId, updated_at: new Date() });
    }
    await leadAttributionService.markConverted(lead.id, {
      customerId,
      monthlyValue,
      initialServiceValue,
      waveguardTier,
    });
  };

  // 1. Directly FK-linked leads. If ANY linkage row exists — even one already
  //    closed (lost/duplicate) — the originating lead for this estimate is
  //    known, so convert the open ones and STOP. We must NOT fall through to
  //    fuzzy matching here: a previously-linked-then-lost lead means the deal's
  //    lead is accounted for, and contact matching could win an unrelated one.
  const linked = await database('leads').where({ estimate_id: estimateId });
  if (linked.length) {
    for (const lead of linked) {
      if (!CLOSED_LEAD_STATUSES.has(lead.status)) await convert(lead);
    }
    return;
  }

  // No `leads.estimate_id` row exists at all — rescue the originating lead that
  // was never linked via the FK.
  const estimate = await database('estimates').where({ id: estimateId }).first();
  if (!estimate) return;

  // 2. Quote-wizard origination: public-quote stamps `leads.customer_id` and
  //    mirrors the lead id in `estimate_data.lead_id` (NOT `leads.estimate_id`).
  //    The contact fallback's `customer_id IS NULL` guard would miss it, so
  //    convert that exact lead by id — precise, no sweeping.
  const dataLeadId = parseEstimateData(estimate.estimate_data)?.lead_id || null;
  if (dataLeadId) {
    const lead = await database('leads').where({ id: dataLeadId }).first();
    if (lead && !CLOSED_LEAD_STATUSES.has(lead.status)) await convert(lead);
    return;
  }

  // 3. Standalone estimate (no lead linkage anywhere): match the accepted
  //    customer's contact to an open, never-converted lead. Acceptance of one
  //    estimate identifies at most ONE originating lead, so convert only when
  //    the match is unambiguous — skip (don't over-count wins) when 0 or 2+.
  if (!customerId) return;
  const customer = await database('customers').where({ id: customerId }).first();
  if (!customer) return;
  const matches = (await findUnconvertedLeadsByContact(database, customer.phone, customer.email))
    .filter((lead) => !CLOSED_LEAD_STATUSES.has(lead.status));
  if (matches.length === 1) {
    await convert(matches[0]);
  } else if (matches.length > 1) {
    logger.warn(`[lead-trigger] estimate ${estimateId} acceptance: ambiguous contact match (${matches.length} open leads) — skipping fallback`, {
      estimateId,
      customerId,
      leadIds: matches.map((lead) => lead.id),
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

// Backfill `estimates.customer_id` so a lead's quote becomes a customer estimate
// the moment the lead gets a customer (converted / booked / accepted). Until
// then a lead estimate carries `customer_id = NULL` and is invisible to the
// customer-keyed New Appointment "Estimate source" (which queries
// `estimates.customer_id`) — and EstimateConverter refuses to convert it
// ("has no linked customer"). Two PRECISE signals only, never a contact sweep
// (a shared phone/email must not re-home an unrelated quote): the lead's
// FK-linked estimate (`leads.estimate_id`), then estimates explicitly tagged
// with this lead's id in `estimate_data.lead_id` (the public-quote mirror).
// Always guarded to `customer_id IS NULL` so an estimate tied to another
// customer is never re-homed. Best-effort: a failure here never breaks the
// conversion. Returns the number of estimates attached.
async function linkLeadEstimatesToCustomer({ database = db, lead, customerId } = {}) {
  if (!customerId || !lead) return 0;
  try {
    // Primary: the lead's FK-linked estimate — deterministic, zero ambiguity.
    if (lead.estimate_id) {
      return await database('estimates')
        .where({ id: lead.estimate_id })
        .whereNull('customer_id')
        .update({ customer_id: customerId, updated_at: new Date() });
    }
    // Fallback: estimates explicitly mirroring THIS lead's id in estimate_data
    // (public-quote leads stamp `estimate_data.lead_id`, not `leads.estimate_id`).
    // estimate_data is stored as JSON text, so prefilter with a LIKE on the
    // lead-id substring (a UUID — no LIKE metacharacters) and confirm the exact
    // value in JS. No phone/email matching — precise lead-id only.
    const tagged = await database('estimates')
      .whereNull('customer_id')
      .whereRaw('estimate_data::text LIKE ?', [`%${lead.id}%`])
      .select('id', 'estimate_data');
    const ids = tagged
      .filter((e) => parseEstimateData(e.estimate_data)?.lead_id === lead.id)
      .map((e) => e.id);
    if (!ids.length) return 0;
    return await database('estimates')
      .whereIn('id', ids)
      .whereNull('customer_id')
      .update({ customer_id: customerId, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[lead-estimate-link] backfill estimate.customer_id failed for lead ${lead?.id} → customer ${customerId}: ${err.message}`);
    return 0;
  }
}

// Customer-link match — an OPEN lead already attached to the EXACT customer the
// event is about. Tighter than the contact fallback above: the lead is
// explicitly tied to this customer (e.g. its `customer_id` was stamped when the
// customer record was created), not merely sharing a phone/email. The contact
// fallback can't see these (its `customer_id IS NULL` guard), which is why an
// originating lead that already carries a `customer_id` while still open never
// auto-converts. convertLeadFromEvent gates this (single open lead + the
// customer's FIRST close) so it can't sweep an established customer's add-on.
async function findOpenLeadsForCustomer(database, customerId) {
  if (!customerId) return [];
  return database('leads')
    .where({ customer_id: customerId })
    .whereNotIn('status', [...CLOSED_LEAD_STATUSES]);
}

// First-close guard: if this customer already has a WON lead, a separate open
// lead is an add-on inquiry — not the originating deal — so it must not
// auto-convert on a routine invoice/visit. A genuinely-won add-on still
// converts through the authoritative estimate-link path when its estimate is
// accepted.
async function customerHasWonLead(database, customerId) {
  if (!customerId) return false;
  const won = await database('leads')
    .where({ customer_id: customerId, status: 'won' })
    .first('id');
  return !!won;
}

// Originating-lead test — the real first-close signal. A `status='won'` lead is
// NOT a reliable "established customer" marker: customers can be active (booked,
// invoiced, completed services) with no won lead at all, and add-on inquiry
// leads are stamped with `customer_id`. So gate on TIMING instead: the open lead
// is the originating deal only if it was first contacted on/before the customer
// became a customer; a lead created AFTER that is a later add-on. `member_since`
// (else the customer's created date) is the same "became a customer" date the
// KPI conversion windows use (server/services/customer-stages.js). Fail-closed:
// if either date is unknown, treat the lead as NOT originating (don't convert).
async function isOriginatingLead(database, customerId, lead) {
  const leadStart = lead.first_contact_at || lead.created_at;
  if (!leadStart) return false;
  const customer = await database('customers')
    .where({ id: customerId })
    .first('member_since', 'created_at');
  if (!customer) return false;
  // Compare ET calendar days — the same conversion date customer-stages.js uses.
  // first_contact_at/created_at are timestamps → convert via the ET helper (a UTC
  // day would mis-bucket an evening-ET contact as the next day and wrongly skip).
  // member_since is a DATE column (already an ET calendar day) → read as-is.
  const leadDay = etDateString(new Date(leadStart));
  const becameDay = customer.member_since != null
    ? dateOnly(customer.member_since)
    : (customer.created_at != null ? etDateString(new Date(customer.created_at)) : null);
  if (!becameDay) return false;
  return leadDay <= becameDay;
}

async function convertLeadFromEvent({
  source,
  estimateId = null,
  customerId = null,
  phone = null,
  email = null,
  requireAcceptedEstimate = false,
  enforceOriginating = false,
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
      // requireAcceptedEstimate (deposit-paid trigger): a succeeded deposit PI is
      // NOT proof the deal closed — the customer can pay then abandon the accept,
      // and the estimate later declines/expires and the deposit is refunded. Only
      // convert once the estimate is genuinely `accepted`; a missing estimate
      // can't confirm acceptance, so it also does not convert.
      if (requireAcceptedEstimate && estimate?.status !== 'accepted') {
        return { converted: false, reason: 'estimate_not_accepted' };
      }
      if (estimate) {
        resolvedCustomerId = resolvedCustomerId || estimate.customer_id || null;
        resolvedPhone = resolvedPhone || estimate.customer_phone || null;
        resolvedEmail = resolvedEmail || estimate.customer_email || null;
        valueHints = estimateValueHints(estimate);
        haveEstimateHints = true;
      }
    }

    // Resolve the originating lead, most-authoritative first:
    //  1. estimate link (`leads.estimate_id`) — authoritative, convert all.
    //  2. customer-link — an open lead tied to the EXACT customer of this event,
    //     gated to the customer's FIRST close + a single open lead.
    //  3. contact fallback — an open, never-linked lead matched by phone/email.
    let candidates = [];
    let resolution = null; // 'estimate' | 'customer_link' | 'contact'
    if (estimateId) {
      candidates = await database('leads').where({ estimate_id: estimateId });
      if (candidates.length) resolution = 'estimate';
    }
    if (!candidates.length) {
      if (!resolvedPhone && !resolvedEmail && resolvedCustomerId) {
        const customer = await database('customers').where({ id: resolvedCustomerId }).first();
        resolvedPhone = customer?.phone || null;
        resolvedEmail = customer?.email || null;
      }

      // Tier 2 — customer-link. Catches an originating lead that already carries
      // a `customer_id` (so the contact fallback can't see it). Convert ONLY the
      // customer's first close: exactly one open lead, no prior won lead, AND
      // that lead is the originating deal (first contacted on/before they became
      // a customer). Anything else is an add-on for an established customer —
      // skip rather than guess which deal the event closed.
      if (resolvedCustomerId) {
        let linked = await findOpenLeadsForCustomer(database, resolvedCustomerId);
        // For an estimate-scoped event (deposit_paid), a lead tied to a DIFFERENT
        // estimate belongs to that deal — exclude it so we never convert it or
        // misattribute this estimate's value hints. (Tier 1 already handled a
        // lead linked to THIS estimate.)
        if (estimateId) {
          linked = linked.filter((l) => !l.estimate_id || l.estimate_id === estimateId);
        }
        if (linked.length) {
          if (linked.length > 1) {
            logger.warn(`[lead-trigger] ${source} customer-link skip — ${linked.length} open leads (ambiguous)`, {
              source, customerId: resolvedCustomerId, leadIds: linked.map((l) => l.id),
            });
            return { converted: false, reason: 'ambiguous_customer_link' };
          }
          const established = await customerHasWonLead(database, resolvedCustomerId);
          const originating = await isOriginatingLead(database, resolvedCustomerId, linked[0]);
          if (established || !originating) {
            logger.warn(`[lead-trigger] ${source} customer-link skip (established=${established}, originating=${originating})`, {
              source, customerId: resolvedCustomerId, leadIds: linked.map((l) => l.id),
            });
            return { converted: false, reason: established ? 'customer_link_established' : 'customer_link_not_originating' };
          }
          candidates = linked;
          resolution = 'customer_link';
        }
      }

      // Tier 3 — contact fallback (never-linked, customer_id IS NULL).
      if (!candidates.length && (resolvedPhone || resolvedEmail)) {
        candidates = await findUnconvertedLeadsByContact(database, resolvedPhone, resolvedEmail);
        // enforceOriginating (backfill safety): the live triggers fire the moment
        // the deal closes, so a contact-matched open lead is the originating deal.
        // A backfill runs LATER, by which point the customer may have a newer,
        // unrelated add-on inquiry sharing their phone/email — converting that
        // would misattribute a closed deal to the wrong lead. Gate the fuzzy match
        // to leads first contacted on/before the customer became a customer (the
        // same originating-timing test Tier 2 already applies).
        if (enforceOriginating && candidates.length && resolvedCustomerId) {
          const originating = [];
          for (const lead of candidates) {
            if (await isOriginatingLead(database, resolvedCustomerId, lead)) originating.push(lead);
          }
          candidates = originating;
        }
        if (candidates.length) resolution = 'contact';
      }
    }

    const open = (candidates || []).filter((lead) => lead && !CLOSED_LEAD_STATUSES.has(lead.status));
    if (!open.length) return { converted: false, reason: 'no_open_lead' };
    // FK-linked leads are authoritatively tied to THIS estimate, so convert them
    // all; tier 2 already enforced a single first-close lead. Only the fuzzy
    // contact fallback needs the ambiguity guard — 2+ open leads on one
    // phone/email can be distinct deals, and an event proves only ONE closed.
    if (resolution === 'contact' && open.length > 1) {
      logger.warn(`[lead-trigger] ${source} ambiguous contact match (${open.length} open leads) — skipping`, {
        source,
        estimateId,
        customerId: resolvedCustomerId,
        leadIds: open.map((lead) => lead.id),
      });
      return { converted: false, reason: 'ambiguous_contact' };
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

// ---------------------------------------------------------------------------
// Self-booking click-id attribution
//
// A public /book self-booking creates a customer + appointment but NO lead, and
// the offline-conversion pipeline (data-manager qualified_lead candidates + Meta
// CAPI) reads ad click ids ONLY off the `leads` table. So a cold ad click that
// books straight from the funnel — exactly the "book from the feed" flow — would
// reach Google/Meta only via a hashed-PII match, never the deterministic click
// id, weakening ad optimization and per-channel CAC.
//
// attributeSelfBooking closes that loop: when a booking is genuinely ad-tracked
// AND the booker has no lead of any kind on file, it mints a single already-won
// lead carrying the click ids plus the customer's phone/email match keys. Minting
// (not just converting) is required because the cold case has no lead to convert;
// won-on-create keeps it out of the open pipeline / new-lead auto-response so it
// only surfaces in attribution + LTV:CAC reporting. An existing lead is left
// untouched: a web lead already captured its own click ids, and stamping this
// booking's click id onto a call/manual-origin lead would mis-channel it.
// Best-effort + idempotent — never throws into the (already-committed) booking.
// ---------------------------------------------------------------------------

// gclid is varchar(200); wbraid/gbraid/fbclid/fbc/fbp are varchar(255).
const LEAD_CLICK_ID_MAX = { gclid: 200, wbraid: 255, gbraid: 255, fbclid: 255, fbc: 255, fbp: 255 };
const LEAD_CLICK_ID_COLUMNS = Object.keys(LEAD_CLICK_ID_MAX);

// A self-booking is minted as a paid lead ONLY on a deterministic paid click id:
// Google gclid/wbraid/gbraid or Meta fbclid/_fbc — these are appended only on an
// ad click. _fbc counts (Meta's persisted click id fb.1.<ts>.<fbclid>, the match
// key when the URL fbclid has fallen off by booking time). A bare UTM is NOT
// enough — newsletters/organic/referral links carry UTMs too — and the ambient
// _fbp cookie (Meta sets it on every pixel visit, organic included) is NEVER a
// trigger; it is kept only as an auxiliary CAPI match key alongside a real click
// id. Mirrors the paid-click rule in the lead-webhook's determineLeadSource.
function attributionHasPaidClickId(attribution) {
  if (!attribution || typeof attribution !== 'object') return false;
  return !!(attribution.gclid || attribution.wbraid || attribution.gbraid
    || attribution.fbclid || attribution.fbc);
}

function clickIdColumnsFromAttribution(attribution) {
  const out = {};
  if (!attribution || typeof attribution !== 'object') return out;
  for (const col of LEAD_CLICK_ID_COLUMNS) {
    const v = attribution[col];
    if (typeof v === 'string' && v.trim()) out[col] = v.trim().slice(0, LEAD_CLICK_ID_MAX[col]);
  }
  return out;
}

async function attributeSelfBooking({
  customerId,
  attribution,
  serviceInterest = null,
  customerCreated = false,
  database = db,
}) {
  try {
    if (!customerId || !attributionHasPaidClickId(attribution)) {
      return { attributed: false, reason: 'no_paid_click_id' };
    }
    const clickIds = clickIdColumnsFromAttribution(attribution);
    if (!Object.keys(clickIds).length) return { attributed: false, reason: 'no_click_ids' };

    // Only mint for a genuinely NEW acquisition — a customer this booking just
    // created. A pre-existing customer (resolved by phone/estimate) is a repeat
    // booker, not a fresh paid lead; minting a won/qualified lead for them would
    // feed the offline-conversion pipeline a synthetic "new qualified lead" and
    // inflate paid-channel conversions. (Legacy/admin customers can have prior
    // activity but no lead row, so an existing-lead check alone is insufficient.)
    if (!customerCreated) return { attributed: false, reason: 'existing_customer' };

    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer) return { attributed: false, reason: 'no_customer' };

    // Belt-and-suspenders: even a just-created customer could already match a
    // lead created earlier without a customer link. An existing lead owns its own
    // channel attribution — never overwrite or duplicate it.
    const linkedLead = await database('leads').where({ customer_id: customerId }).first('id');
    if (linkedLead) return { attributed: false, reason: 'existing_customer_lead' };
    const contactMatches = await findUnconvertedLeadsByContact(database, customer.phone, customer.email);
    if (contactMatches.length) return { attributed: false, reason: 'existing_contact_lead' };

    const { leadSourceId, leadSourceDetail } = await resolveLeadSource(attribution);
    const now = new Date();
    const [minted] = await database('leads').insert({
      customer_id: customerId,
      first_name: customer.first_name || null,
      last_name: customer.last_name || '',
      phone: customer.phone || null,
      email: customer.email || null,
      lead_source_id: leadSourceId,
      lead_type: 'self_booking',
      first_contact_channel: 'web',
      service_interest: serviceInterest || null,
      first_contact_at: now,
      converted_at: now,
      status: 'won',
      is_qualified: true,
      ...clickIds,
    }).returning('*');

    await database('lead_activities').insert({
      lead_id: minted.id,
      activity_type: 'converted',
      description: 'Self-booked from a tracked ad click — minted as a won lead to attribute the booking to its ad channel.',
      performed_by: 'system',
      metadata: JSON.stringify({ source: 'self_booking', clickIds: Object.keys(clickIds), leadSourceId: leadSourceId || null }),
    }).catch((e) => logger.warn(`[self-booking-attribution] activity log failed (non-blocking): ${e.message}`));

    // Mirror the web-lead PPC funnel row (routes/lead-webhook.js) so the minted
    // lead is visible in /admin ads CAC/ROAS reporting and revenue sync, not just
    // the offline-conversion upload. Source is the paid platform of the click id
    // (a minted lead always carries one); idempotent on lead_id.
    const ppcSource = (clickIds.gclid || clickIds.wbraid || clickIds.gbraid) ? 'google_ads'
      : (clickIds.fbclid || clickIds.fbc) ? 'facebook' : null;
    if (ppcSource) {
      try {
        const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');
        const utm = (attribution && typeof attribution.utm === 'object' && attribution.utm) || {};
        await database('ad_service_attribution').insert({
          customer_id: customerId,
          lead_id: minted.id,
          service_line: inferServiceLine(serviceInterest),
          specific_service: inferSpecificService(serviceInterest),
          service_bucket: inferServiceBucket(serviceInterest),
          lead_date: etDateString(),
          lead_source: ppcSource,
          lead_source_detail: leadSourceDetail || null,
          gclid: clickIds.gclid || null,
          wbraid: clickIds.wbraid || null,
          gbraid: clickIds.gbraid || null,
          fbclid: clickIds.fbclid || null,
          fbc: clickIds.fbc || null,
          fbp: clickIds.fbp || null,
          utm_campaign: utm.campaign || null,
          utm_term: utm.term || null,
          funnel_stage: 'lead',
        }).onConflict('lead_id').ignore();
      } catch (attrErr) {
        logger.warn(`[self-booking-attribution] PPC funnel row failed (non-blocking): ${attrErr.message}`);
      }
    }

    logger.info(`[self-booking-attribution] minted won lead ${minted.id} for customer=${customerId} (${Object.keys(clickIds).join(',')})`);
    return { attributed: true, leadId: minted.id, minted: true };
  } catch (err) {
    logger.warn(`[self-booking-attribution] failed for customer=${customerId || 'unknown'}: ${err.message}`);
    return { attributed: false, reason: 'error' };
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
  linkLeadEstimatesToCustomer,
  attributeSelfBooking,
};
