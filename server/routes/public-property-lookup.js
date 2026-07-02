const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { performPropertyLookup } = require('./property-lookup-v2');
const { resolveLeadSource } = require('../services/lead-source-resolver');
const { normalizeLeadAddress } = require('../utils/address-normalizer');
const { zipToCity } = require('../utils/zip-to-city');
const { verifyLeadPrefillToken } = require('../utils/lead-prefill-token');

// Aggressive rate limit — each lookup spends real AI + Google Maps dollars.
// 5 per IP per hour is enough for a real lead to iterate on
// the address a couple of times, but blocks scripted abuse.
const lookupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lookup requests. Please try again in an hour or call (941) 297-5749.' },
});

// The prefill exchange is a cheap indexed read, but still public — keep a lid on it.
const prefillLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

function publicPropertySummary(record) {
  if (!record) return null;
  return {
    propertyType: record.propertyType,
    squareFootage: record.squareFootage,
    lotSize: record.lotSize,
    yearBuilt: record.yearBuilt,
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return '';
}

const SERVICE_INTEREST_LABELS = {
  pest: 'Pest Control',
  general_pest: 'Pest Control',
  pest_control: 'Pest Control',
  pest_control_lawn_care: 'Pest Control + Lawn Care',
  general_pest_lawn_care: 'Pest Control + Lawn Care',
  lawn: 'Lawn Care',
  lawn_care: 'Lawn Care',
  mosquito_control: 'Mosquito Control',
  mosquito_lawn_care: 'Mosquito Control + Lawn Care',
  termite_treatment: 'Termite Treatment',
  bed_bug_treatment: 'Bed Bug Treatment',
  ant_control: 'Ant Control',
  flea_tick_control: 'Flea & Tick Control',
  spider_wasp_control: 'Spider & Wasp Control',
  lawn_fertilization: 'Lawn Fertilization',
  weed_control: 'Weed Control',
  lawn_pest_control: 'Lawn Pest Control',
  tree_shrub_care: 'Tree & Shrub Care',
  palm_injections: 'Palm Tree Injections',
  aeration_plugging: 'Lawn Aeration & Plugging',
  not_sure_pest: 'Pest Control Consultation',
  not_sure_lawn: 'Lawn Care Consultation',
  not_sure_both: 'Pest Control + Lawn Care Consultation',
  inspection: 'Inspection',
  commercial_service: 'Commercial Service',
  both: 'Pest Control + Lawn Care',
  mosquito: 'Mosquito Control',
  termite: 'Termite',
  rodent: 'Rodent Control',
  rodent_control: 'Rodent Control',
  tree_shrub: 'Tree & Shrub Care',
  flea: 'Flea Control',
  cockroach: 'Cockroach Control',
  bed_bug: 'Bed Bug',
  bedbug: 'Bed Bug',
  dethatching: 'Dethatching',
  top_dressing: 'Top Dressing',
  overseeding: 'Overseeding',
  other: 'Other Services',
};

const FREQUENCY_LABELS = {
  ongoing: 'Recurring',
  recurring: 'Recurring',
  'one-time': 'One-Time',
  one_time: 'One-Time',
  'not-sure': 'Consultation',
  not_sure: 'Consultation',
  consult: 'Consultation',
};

function titleizeServiceValue(value) {
  return String(value || '')
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function serviceLabelFor(value) {
  const raw = firstNonEmpty(value);
  if (!raw) return '';
  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (SERVICE_INTEREST_LABELS[key]) return SERVICE_INTEREST_LABELS[key];
  return /^[a-z0-9_-]+$/i.test(raw) ? titleizeServiceValue(raw) : raw;
}

function normalizeFrequencyKey(value) {
  return firstNonEmpty(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function formatServiceInterestForFrequency(serviceLabel, frequency) {
  const label = serviceLabelFor(serviceLabel);
  if (!label) return '';
  if (/\bconsultation\b/i.test(label)) return label;
  const frequencyKey = normalizeFrequencyKey(frequency);
  const frequencyLabel = FREQUENCY_LABELS[frequencyKey] ?? titleizeServiceValue(frequency);
  if (!frequencyLabel) return label;
  return label.split(/\s+\+\s+/)
    .filter(Boolean)
    .map(part => (frequencyLabel === 'Consultation' ? `${part} Consultation` : `${frequencyLabel} ${part}`))
    .join(' + ');
}

function normalizeServiceInterest(body = {}) {
  const explicit = firstNonEmpty(body.service_interest, body.serviceInterest, body.service);
  if (explicit) return serviceLabelFor(explicit);

  const interest = firstNonEmpty(body.specific_service, body.specificService, body.interest);
  const otherService = firstNonEmpty(body.otherService, body.other_service);
  if (!interest) return '';
  const serviceLabel = interest.toLowerCase() === 'other'
    ? serviceLabelFor(otherService || interest)
    : serviceLabelFor(interest);
  const frequency = firstNonEmpty(body.frequency, body.Frequency);
  return frequency ? formatServiceInterestForFrequency(serviceLabel, frequency) : serviceLabel;
}

// GET /lead-prefill?lead_id=&token= — exchange a voicemail text-back link's
// HMAC token (utils/lead-prefill-token.js) for that lead's own contact fields,
// so the /estimate wizard arrives prefilled. 404 on ANY failure — invalid,
// expired, or mismatched token and unknown lead are indistinguishable (no
// oracle). PREFILL authority only: this returns the contact data we already
// texted the link-holder; it is never accepted as identity or pricing
// authority on a money path.
router.get('/lead-prefill', prefillLimiter, async (req, res) => {
  try {
    const leadId = String(req.query.lead_id || '').trim();
    const token = String(req.query.token || '').trim();
    if (!leadId || !token || !UUID_RE.test(leadId) || !verifyLeadPrefillToken(leadId, token)) {
      return res.status(404).json({ error: 'not_found' });
    }
    const lead = await db('leads')
      .where({ id: leadId })
      .first('id', 'first_name', 'last_name', 'email', 'phone', 'address', 'city', 'zip', 'service_interest');
    if (!lead) return res.status(404).json({ error: 'not_found' });
    res.json({
      lead_id: lead.id,
      first_name: lead.first_name || null,
      last_name: lead.last_name || null,
      email: lead.email || null,
      phone: lead.phone || null,
      address: lead.address || null,
      city: lead.city || null,
      zip: lead.zip || null,
      service_interest: lead.service_interest || null,
    });
  } catch (err) {
    logger.error(`[public-property-lookup] lead-prefill failed: ${err.message}`);
    res.status(404).json({ error: 'not_found' });
  }
});

router.post('/property-lookup', lookupLimiter, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, attribution } = req.body || {};
    const normalizedAddress = normalizeLeadAddress({
      raw: address,
      line1: req.body.address_line1 || req.body.addressLine1,
      city: req.body.city,
      state: req.body.state,
      zip: req.body.zip,
      placeId: req.body.google_place_id || req.body.googlePlaceId,
      components: req.body.address_components || req.body.addressComponents,
    });
    const lookupAddress = normalizedAddress.fullAddress || String(address || '').trim();
    const streetForValidation = normalizedAddress.line1 || String(address || '').trim();

    if (!firstName || !lastName) return res.status(400).json({ error: 'Name required.' });
    if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Valid email required.' });
    const normPhone = normalizePhone(phone);
    if (!normPhone) return res.status(400).json({ error: 'Valid 10-digit phone required.' });
    if (
      !lookupAddress
      || !streetForValidation
      || streetForValidation.length < 5
      || !/\d/.test(streetForValidation)
      || !/[A-Za-z]/.test(streetForValidation)
    ) return res.status(400).json({ error: 'Address required.' });

    const attr = (attribution && typeof attribution === 'object') ? attribution : null;
    const gclid = attr?.gclid ? String(attr.gclid).slice(0, 255) : null;
    const wbraid = attr?.wbraid ? String(attr.wbraid).slice(0, 255) : null;
    const gbraid = attr?.gbraid ? String(attr.gbraid).slice(0, 255) : null;
    const fbclid = attr?.fbclid ? String(attr.fbclid).slice(0, 255) : null;
    const fbc = attr?.fbc ? String(attr.fbc).slice(0, 255) : null;
    const fbp = attr?.fbp ? String(attr.fbp).slice(0, 255) : null;
    const sourceMeta = await resolveLeadSource(attr);
    const serviceInterest = normalizeServiceInterest(req.body || {});

    const startedStage = {
      stage: 'property_lookup_started',
      service_interest: serviceInterest || null,
      utm: attr?.utm || null,
      clickIds: { gclid, wbraid, gbraid, fbclid, fbc, fbp },
      referrer: attr?.referrer || null,
      landing_url: attr?.landing_url || null,
      address: normalizedAddress,
    };

    // Voicemail text-back prefill attach: when the request carries a valid
    // lead-prefill token (minted ONLY by the voicemail text-back SMS), UPDATE
    // that existing call-pipeline lead instead of minting a duplicate row.
    // Typed values win over the voicemail extraction — the user is the
    // authority on their own name/email/address — but call attribution
    // (lead_source_id / lead_type / first_contact_*) is preserved, and
    // extracted_data is MERGED (not replaced) so the voicemail provenance and
    // the text-back one-shot stamp survive the wizard stages. Terminal or
    // converted leads never re-attach — a re-entry after the lead closed is a
    // fresh lead like any other visitor.
    let lead = null;
    let attachedToExistingLead = false;
    const prefillLeadId = firstNonEmpty(req.body.prefill_lead_id, req.body.prefillLeadId);
    const prefillToken = firstNonEmpty(req.body.prefill_token, req.body.prefillToken);
    if (prefillLeadId && prefillToken && UUID_RE.test(prefillLeadId)
      && verifyLeadPrefillToken(prefillLeadId, prefillToken)) {
      try {
        const updated = await db('leads')
          .where({ id: prefillLeadId })
          .whereNotIn('status', ['won', 'lost', 'disqualified', 'duplicate'])
          .whereNull('converted_at')
          .update({
            first_name: firstName,
            last_name: lastName,
            email: String(email).toLowerCase().trim(),
            phone: normPhone,
            address: lookupAddress,
            city: normalizedAddress.city || zipToCity(normalizedAddress.zip) || null,
            zip: normalizedAddress.zip || null,
            ...(serviceInterest ? { service_interest: serviceInterest } : {}),
            extracted_data: db.raw(
              "COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb",
              [JSON.stringify(startedStage)]
            ),
            updated_at: new Date(),
          });
        if (updated) {
          lead = { id: prefillLeadId };
          attachedToExistingLead = true;
          logger.info(`[public-property-lookup] wizard attached to existing lead ${prefillLeadId} via prefill token`);
        }
      } catch (attachErr) {
        logger.warn(`[public-property-lookup] prefill attach failed — falling back to new lead: ${attachErr.message}`);
      }
    }

    // Capture the lead BEFORE firing the expensive API chain. Abuse-protection
    // + marketing attribution + recovery if the user bails mid-flow.
    if (!lead) {
      [lead] = await db('leads').insert({
        first_name: firstName,
        last_name: lastName,
        email: String(email).toLowerCase().trim(),
        phone: normPhone,
        address: lookupAddress,
        city: normalizedAddress.city || zipToCity(normalizedAddress.zip) || null,
        zip: normalizedAddress.zip || null,
        lead_type: 'quote_wizard',
        first_contact_channel: 'website_quote',
        lead_source_id: sourceMeta.leadSourceId,
        status: 'new',
        gclid,
        wbraid,
        gbraid,
        fbclid,
        fbc,
        fbp,
        service_interest: serviceInterest || null,
        extracted_data: JSON.stringify(startedStage),
      }).returning(['id']);
    }

    if (!lead?.id) {
      logger.error('[public-property-lookup] lead insert returned no id');
      return res.status(500).json({ error: 'Property lookup failed. Please call (941) 297-5749 to speak with our team.' });
    }

    const result = await performPropertyLookup(lookupAddress);
    const propertyRecord = publicPropertySummary(result.propertyRecord || result.rentcast);

    // Persist the enriched profile on the lead so a stale/abandoned row is
    // still useful for follow-up. On an attached call-pipeline lead, MERGE so
    // the voicemail provenance keys survive (same rule as the attach above).
    try {
      const completeStage = {
        stage: 'property_lookup_complete',
        enriched: result.enriched || null,
        propertyRecord,
        rentcast: propertyRecord,
        avm: result.avm || null,
        ai_sources: result.aiAnalysis?._sources || null,
        service_interest: serviceInterest || null,
        utm: attr?.utm || null,
        clickIds: { gclid, wbraid, gbraid, fbclid, fbc, fbp },
        referrer: attr?.referrer || null,
        landing_url: attr?.landing_url || null,
        address: normalizedAddress,
      };
      await db('leads').where({ id: lead.id }).update({
        extracted_data: attachedToExistingLead
          ? db.raw("COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify(completeStage)])
          : JSON.stringify(completeStage),
        updated_at: new Date(),
      });
    } catch (e) {
      logger.error(`[public-property-lookup] lead update failed: ${e.message}`);
    }

    res.json({
      lead_id: lead.id,
      enriched: result.enriched,
      propertyRecord,
      rentcast: propertyRecord,
      satellite: result.satellite ? {
        closeUrl: result.satellite.closeUrl,
        microCloseUrl: result.satellite.microCloseUrl,
        wideUrl: result.satellite.wideUrl,
        inServiceArea: result.satellite.inServiceArea,
      } : null,
      aiAnalysis: result.aiAnalysis ? {
        sources: result.aiAnalysis._sources,
        confidence: result.aiAnalysis._claudeConfidence || result.aiAnalysis.confidenceScore,
      } : null,
      errors: result.errors,
      meta: result.meta,
    });
  } catch (err) {
    logger.error(`[public-property-lookup] failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Property lookup failed. Please call (941) 297-5749 to speak with our team.' });
  }
});

module.exports = router;
module.exports._test = {
  normalizeServiceInterest,
  formatServiceInterestForFrequency,
};
