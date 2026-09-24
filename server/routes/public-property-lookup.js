const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { recoverAddressUnverified, nextAddressUnverified, flagCoversAddress, buildAddressVerdict, contactPairLockKey, cleanVerdictCovers, cachedAuditSuperseded, auditEvidenceAt, samePremiseDisplay, countyRollAnswered } = require('../services/lead-address-unverified');
const { performPropertyLookup, VACANT_SQFT_FLAG_COPY } = require('./property-lookup-v2');
const { resolveLeadSource } = require('../services/lead-source-resolver');
const { normalizeLeadAddress, formatAddress } = require('../utils/address-normalizer');
const { normalizeWebAdditionalProperties } = require('../utils/intake-normalize');
const { zipToCity } = require('../utils/zip-to-city');
const { verifyLeadPrefillToken } = require('../utils/lead-prefill-token');
const { verifyTurnstileToken } = require('../utils/turnstile');
const { isHoneypotTripped, resolveSubmitHost } = require('../utils/lead-abuse');
const { sanitizeAnonUnitId } = require('../services/experimentation/growthbook');
const { normalizeTimeline, urgencyForTimeline } = require('../services/lead-timeline');
const { isEnabled } = require('../config/feature-gates');

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

// PII responses on a public token route are never cached, indexed, or leaked
// via referrer — same contract as prep-public.js / lawn-diagnostic.
const PRIVACY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

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

// Public copy of the enriched profile. The admin lookup's plat-median
// estimate (subdivisionMedian: plat name, county, neighbor sample and
// range for an unassessed vacant parcel) is staff-only context — this
// unauthenticated route's contract returns facts for the requested parcel,
// so the block is dropped from both the response and the lead snapshot.
function publicEnrichedProfile(enriched) {
  if (!enriched || typeof enriched !== 'object') return enriched ?? null;
  // addressVerdict is a server-owned trust marker (the lead's verdict is
  // derived from it server-side) — never part of the public payload
  // (codex #4667 r11 P0).
  const { subdivisionMedian, addressVerdict, ...rest } = enriched;
  if (!subdivisionMedian || !Array.isArray(rest.fieldVerifyFlags)) return rest;
  // The homeSqFt verify flag spells the same figures out in prose — swap in
  // the median-free vacant-parcel copy (one shared string, never a regex).
  return {
    ...rest,
    fieldVerifyFlags: rest.fieldVerifyFlags.map((flag) => (
      flag?.field === 'homeSqFt' ? { ...flag, reason: VACANT_SQFT_FLAG_COPY } : flag
    )),
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
  bed_bug_treatment: 'Bed Bug Treatment Service',
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

// POST /lead-prefill {lead_id, token} — exchange a voicemail text-back link's
// HMAC token (utils/lead-prefill-token.js) for that lead's own contact fields,
// so the /estimate wizard arrives prefilled. POST with a JSON body on purpose:
// the token is a bearer credential and query strings land verbatim in
// morgan/Railway request logs (the AGENTS.md PII-in-logs rule); bodies don't.
// 404 on ANY failure — invalid, expired, or mismatched token and unknown lead
// are indistinguishable (no oracle). PREFILL authority only: this returns the
// contact data we already texted the link-holder; it is never accepted as
// identity or pricing authority on a money path.
router.post('/lead-prefill', prefillLimiter, async (req, res) => {
  res.set(PRIVACY_HEADERS);
  try {
    const leadId = String(req.body?.lead_id || '').trim();
    const token = String(req.body?.token || '').trim();
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
    // --- Abuse guards, BEFORE the paid satellite + AI lookup ---
    // Honeypot (always on): a bot that filled the hidden field gets a benign
    // 200 with no lead + no lookup spend. Old cached pages omit it → passes.
    if (isHoneypotTripped(req.body)) {
      logger.info('[property-lookup] honeypot tripped — dropping before paid lookup');
      return res.status(200).json({ lead_id: null, enriched: null });
    }
    // Cloudflare Turnstile (gated behind GATE_LEAD_TURNSTILE). Same verify as the
    // lead webhook: fail OPEN on misconfig/CF error, block (403) only when the
    // gate is on AND the owning-widget secret gives a definitive rejection. While
    // the gate is off it verify-and-logs (shadow) but never blocks.
    const turnstileToken = req.body && (req.body.turnstile_token || req.body['cf-turnstile-response']);
    const turnstile = await verifyTurnstileToken(turnstileToken, req.ip, resolveSubmitHost(req));
    if (!turnstile.ok) {
      logger.info(`[property-lookup] turnstile ${turnstile.reason} (enforced=${turnstile.enforced}, gate=${isEnabled('leadTurnstile')})`);
      if (isEnabled('leadTurnstile') && turnstile.enforced) {
        return res.status(403).json({ error: 'Verification failed. Please try again.' });
      }
    }

    const { firstName, lastName, email, phone, address, attribution } = req.body || {};
    const normalizedAddress = normalizeLeadAddress({
      raw: address,
      line1: req.body.address_line1 || req.body.addressLine1,
      line2: req.body.address_line2 || req.body.addressLine2 || req.body.unit,
      city: req.body.city,
      state: req.body.state,
      zip: req.body.zip,
      placeId: req.body.google_place_id || req.body.googlePlaceId,
      components: req.body.address_components || req.body.addressComponents,
    });
    // Optional extra properties the visitor wants covered. Capture-only —
    // never priced here; each becomes a manual follow-up quote.
    const additionalProperties = normalizeWebAdditionalProperties(req.body, normalizedAddress.fullAddress);
    // Inline street unit and dedicated unit field disagree — ambiguous. Fail
    // closed BEFORE the lead insert/update below (same guard as
    // /public/quote/calculate) so no lead is captured on the wrong unit.
    if (normalizedAddress.unitConflict) {
      return res.status(400).json({ error: 'The street address and unit number disagree — please re-enter your address.' });
    }
    const lookupAddress = normalizedAddress.fullAddress || String(address || '').trim();
    const streetForValidation = normalizedAddress.line1 || String(address || '').trim();
    // The parcel/geocode lookup gets the STREET-ONLY composition — a unit
    // inline between street and city can degrade county-roll matching. The
    // lead-facing fields keep the unit via fullAddress.
    const parcelLookupAddress = normalizedAddress.line2
      ? formatAddress({
        line1: normalizedAddress.line1,
        city: normalizedAddress.city,
        state: normalizedAddress.state,
        zip: normalizedAddress.zip,
      })
      : lookupAddress;

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
    // Anonymous experiment unit id (waves_exp_uid) — joins this lead to any
    // A/B assignments in experiment_exposures. Stored as a first-class column
    // (like the click ids above) so later extracted_data rewrites can't drop it.
    const anonId = sanitizeAnonUnitId(attr?.anon_id);
    const sourceMeta = await resolveLeadSource(attr);
    const serviceInterest = normalizeServiceInterest(req.body || {});
    // Declared "when do you want this handled?" (quote-form tile). Persisted
    // verbatim in extracted_data and mapped onto leads.urgency; null when the
    // form didn't ask, so nothing is guessed.
    const timeline = normalizeTimeline(req.body?.timeline);
    const declaredUrgency = urgencyForTimeline(timeline);

    const startedStage = {
      stage: 'property_lookup_started',
      service_interest: serviceInterest || null,
      ...(timeline ? { timeline } : {}),
      utm: attr?.utm || null,
      clickIds: { gclid, wbraid, gbraid, fbclid, fbc, fbp },
      referrer: attr?.referrer || null,
      landing_url: attr?.landing_url || null,
      address: normalizedAddress,
      ...(additionalProperties.length ? { additional_properties: additionalProperties } : {}),
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
            ...(declaredUrgency ? { urgency: declaredUrgency } : {}),
            ...(anonId ? { anon_id: anonId } : {}),
            // A lead the office parked as 'unresponsive' just responded — the
            // admin UI buckets that status as closed, so reopen it or the
            // re-engaged prospect stays hidden. Other statuses are untouched.
            status: db.raw("CASE WHEN status = 'unresponsive' THEN 'new' ELSE status END"),
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
        anon_id: anonId,
        service_interest: serviceInterest || null,
        ...(declaredUrgency ? { urgency: declaredUrgency } : {}),
        extracted_data: JSON.stringify(startedStage),
      }).returning(['id']);
    }

    if (!lead?.id) {
      logger.error('[public-property-lookup] lead insert returned no id');
      return res.status(500).json({ error: 'Property lookup failed. Please call (941) 297-5749 to speak with our team.' });
    }

    const result = await performPropertyLookup(parcelLookupAddress);
    const propertyRecord = publicPropertySummary(result.propertyRecord || result.rentcast);
    const enriched = publicEnrichedProfile(result.enriched);

    // A lead this run re-attached to (prefill token) may already carry a
    // county-roll flag from an earlier run: a GIS outage on THIS lookup must
    // not erase it through the merge below — only a clean roll answer, or
    // a changed address, clears it (pre-push audit P1). Token-verified own
    // row; the server-written key only.
    let priorAddressUnverified = null;
    if (attachedToExistingLead) {
      try {
        const own = await db('leads').where({ id: lead.id }).first('extracted_data');
        const snapshot = typeof own?.extracted_data === 'string' ? JSON.parse(own.extracted_data) : own?.extracted_data;
        // The attach above already merged THIS run's address into the
        // snapshot, so judge the flag on its own stamped address.
        // A STAMPED flag only: an unstamped (older) flag would pass the
        // permissive cover check while the snapshot's own address is no
        // longer the flag's — the attach above already overwrote it
        // (pre-push audit P1).
        const recovered = recoverAddressUnverified(snapshot);
        if (recovered && recovered.address_line1 && flagCoversAddress(recovered, normalizedAddress)) priorAddressUnverified = recovered;
      } catch (priorErr) {
        logger.warn(`[public-property-lookup] prior address flag re-read failed: ${priorErr.code || priorErr.name || 'error'}`);
      }
    }
    // A CACHED audit (no new evidence this run) is outranked by a staff
    // clean verdict for this premise stamped on any of the contact pair's
    // leads AFTER it was cached and after every matching flag — otherwise
    // a repeat lookup re-derives the flag staff already overruled and the
    // next /calculate blocks the booking again (pre-push audit P1). A
    // live lookup is fresh evidence and always stands.
    // Newest staff / lookup CLEAN verdict for this premise across the
    // contact pair, newer than every matching flag — read pre-lock for the
    // derivation and AGAIN under the contact-pair lock below, so a
    // confirmation that commits while this lookup runs is honoured rather
    // than merely ordered before a stale overwrite (codex r19 P1).
    const resolveStaffCleanAt = async (conn) => {
      if (!email || !normPhone) return null;
      try {
        const rows = await conn('leads')
          .whereNull('deleted_at')
          .whereRaw('LOWER(email) = ?', [String(email).toLowerCase().trim()])
          .whereRaw("right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [String(normPhone).replace(/\D/g, '').slice(-10)])
          .whereRaw("(extracted_data->'address_unverified' IS NOT NULL OR extracted_data->'address_verdict' IS NOT NULL)")
          .select('id', 'extracted_data');
        const parseSnap = (row) => (typeof row.extracted_data === 'string' ? (() => { try { return JSON.parse(row.extracted_data); } catch { return null; } })() : row.extracted_data);
        const snapshots = rows.map(parseSnap).filter(Boolean);
        // The CURRENT lead's clean verdict (a staff confirmation of a
        // street-only intake carries no locality) is judged on the premise
        // alone; other leads need the complete locality (codex r18 P1).
        const newestClean = rows
          .map((row) => ({ own: String(row.id) === String(lead.id), snap: parseSnap(row) }))
          .filter(({ own, snap }) => snap && cleanVerdictCovers(snap, normalizedAddress, { requireLocality: !own }))
          .map(({ snap }) => Date.parse(snap.address_verdict?.at || '') || 0)
          .reduce((max, at) => Math.max(max, at), 0);
        const newestFlag = snapshots
          .map((snap) => recoverAddressUnverified(snap))
          .filter((flag) => flag && flag.address_line1 && flagCoversAddress(flag, normalizedAddress))
          .map((flag) => Date.parse(flag.flagged_at || '') || 0)
          .reduce((max, at) => Math.max(max, at), 0);
        const newestFlagObj = snapshots
          .map((snap) => recoverAddressUnverified(snap))
          .filter((flag) => flag && flag.address_line1 && flagCoversAddress(flag, normalizedAddress))
          .sort((a, b) => (Date.parse(b.flagged_at || '') || 0) - (Date.parse(a.flagged_at || '') || 0))[0] || null;
        resolveStaffCleanAt.lastNewestFlag = newestFlagObj;
        resolveStaffCleanAt.lastNewestFlagAt = newestFlag;
        return newestClean && newestClean > newestFlag ? new Date(newestClean).toISOString() : null;
      } catch (cleanErr) {
        logger.warn(`[public-property-lookup] contact-pair clean verdict re-read failed: ${cleanErr.code || cleanErr.name || 'error'}`);
        return null;
      }
    };
    let staffCleanAt = (result?.meta?.cache === 'hit' && result?.enriched) ? await resolveStaffCleanAt(db) : null;
    let cachedAuditStale = cachedAuditSuperseded({
      leadCleanVerdict: !!staffCleanAt, profileFound: !!result?.enriched, cachedAt: auditEvidenceAt(result), cleanEvidenceAt: staffCleanAt,
    });
    let addressUnverified = cachedAuditStale
      ? null
      : nextAddressUnverified({ enriched: result.enriched, profileFound: !!result?.enriched, prior: priorAddressUnverified });
    if (addressUnverified && !addressUnverified.address_line1) {
      Object.assign(addressUnverified, {
        address_line1: String(normalizedAddress.line1 || '').trim() || null,
        city: String(normalizedAddress.city || '').trim() || null,
        state: String(normalizedAddress.state || '').trim().toUpperCase().slice(0, 2) || null,
        zip: (String(normalizedAddress.zip || '').match(/\d{5}/) || [''])[0] || null,
      });
    }

    // Persist the enriched profile on the lead so a stale/abandoned row is
    // still useful for follow-up. On an attached call-pipeline lead, MERGE so
    // the voicemail provenance keys survive (same rule as the attach above).
    try {
      const completeStage = {
        stage: 'property_lookup_complete',
        enriched: enriched || null,
        propertyRecord,
        rentcast: propertyRecord,
        avm: result.avm || null,
        ai_sources: result.aiAnalysis?._sources || null,
        service_interest: serviceInterest || null,
        ...(timeline ? { timeline } : {}),
        utm: attr?.utm || null,
        clickIds: { gclid, wbraid, gbraid, fbclid, fbc, fbp },
        referrer: attr?.referrer || null,
        landing_url: attr?.landing_url || null,
        address: normalizedAddress,
        ...(additionalProperties.length ? { additional_properties: additionalProperties } : {}),
        // County roll could not vouch for the typed house number (see
        // lead-address-unverified). Derived from the SERVER result, so an
        // abandoned row already carries the callback ask; /calculate
        // re-derives it (or recovers this one when its cache read misses).
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
    // The verdict keys are published UNDER the contact-pair advisory lock
    // the booking confirm takes, never in the unlocked write above
    // (pre-push audit P1). FAIL CLOSED: a rolled-back verdict/quarantine
    // (a deadlock, the withdrawal, its critical audit row) must not answer
    // as a successful lookup while an earlier publication stays
    // acceptable at the flagged number (codex r20 P1). The visitor retries.
    try {
      await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['address-verdict', contactPairLockKey(email, normPhone)]);
        // Re-reconciled UNDER the lock (codex r19 P1): a clean verdict that
        // committed since the pre-lock read outranks this run's audit when
        // it is newer than the audit's own evidence time (a live audit is
        // stamped now and always stands).
        // …BOTH ways, whatever the pre-lock value (codex r21 P1): a flag
        // another request committed since (a recordless county audit is
        // never cached, so nothing else could recover it) outranks this
        // run's clean answer when it is newer than this run's evidence.
        {
          const lockedCleanAt = await resolveStaffCleanAt(trx);
          const evidenceAt = Date.parse(auditEvidenceAt(result) || '') || Date.parse(result?.meta?.timestamp || '') || 0;
          const newerFlag = resolveStaffCleanAt.lastNewestFlag;
          const newerFlagAt = resolveStaffCleanAt.lastNewestFlagAt || 0;
          if (addressUnverified && result?.enriched && lockedCleanAt
            && cachedAuditSuperseded({ leadCleanVerdict: true, profileFound: true, cachedAt: auditEvidenceAt(result), cleanEvidenceAt: lockedCleanAt })) {
            addressUnverified = null;
            staffCleanAt = lockedCleanAt;
            cachedAuditStale = true;
          } else if (!addressUnverified && newerFlag && newerFlagAt > evidenceAt && !(lockedCleanAt && (Date.parse(lockedCleanAt) || 0) > newerFlagAt)) {
            addressUnverified = newerFlag;
            staffCleanAt = null;
            cachedAuditStale = false;
          }
        }
        // A FLAGGED verdict quarantines the visitor's earlier publications
        // for this premise right here — a visitor who abandons before
        // /calculate must not keep an acceptable link from a clean run
        // (codex r17 P1). Same transaction and lock as the verdict.
        if (addressUnverified) {
          const { withdrawFlaggedPublications } = require('../services/website-quote-withdrawal');
          await withdrawFlaggedPublications(trx, {
            leadId: lead.id, contactEmail: email, contactPhone: normPhone, fullAddress: normalizedAddress.fullAddress || lookupAddress, flag: addressUnverified,
          });
        } else if (cachedAuditStale || countyRollAnswered(result?.enriched)) {
          // The CLEAN counterpart (codex r27 P1): legacy quote-wizard rows an
          // earlier flagged lookup blocked without archiving keep refusing
          // every staff send with ADDRESS_UNVERIFIED if the visitor abandons
          // before /calculate lifts them — so a clean county answer (or a
          // staff verdict that superseded the cached audit) lifts the block
          // here, under the same lock, for this contact pair's rows at the
          // same complete premise. Mirrors the /calculate supersession.
          const fullAddress = normalizedAddress.fullAddress || lookupAddress;
          const blocked = await trx('estimates')
            .where({ source: 'quote_wizard' })
            .whereNull('archived_at')
            .whereRaw('LOWER(customer_email) = ?', [String(email).toLowerCase().trim()])
            .whereRaw("right(regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [String(normPhone).replace(/\D/g, '').slice(-10)])
            .whereRaw("estimate_data->'addressUnverified' = 'true'::jsonb")
            .select('id', 'address');
          const unblocked = blocked
            .filter((row) => samePremiseDisplay(row.address, fullAddress, { requireLocality: true }))
            .map((row) => row.id);
          if (unblocked.length) {
            await trx('estimates')
              .whereIn('id', unblocked)
              .whereRaw("estimate_data->'addressUnverified' = 'true'::jsonb")
              .update({
                estimate_data: trx.raw("COALESCE(estimate_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ addressUnverified: false, addressUnverifiedFlag: null, addressUnverifiedSupersededAt: new Date().toISOString() })]),
                updated_at: new Date(),
              });
            logger.info(`[public-property-lookup] clean verdict lifted the address block on ${unblocked.length} legacy estimate(s)`);
          }
        }
        await trx('leads').where({ id: lead.id }).update({
          extracted_data: trx.raw("COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
            address_unverified: addressUnverified,
            // Server-owned verdict for this address (clean / flagged /
            // unanswered) — a clean one supersedes older warnings downstream.
            address_verdict: (() => {
              if (!cachedAuditStale) {
                const verdict = buildAddressVerdict({ flag: addressUnverified, enriched: result.enriched, profileFound: !!result?.enriched, address: normalizedAddress });
                // A clean answer served from the cache is evidence from the
                // audit's own time, never this request's: a revisit of an
                // older spelling must not out-date a newer flag on an
                // equivalent premise (codex #4667 r16 P1).
                const evidenceAt = result?.meta?.cache === 'hit' ? auditEvidenceAt(result) : null;
                if (verdict.status === 'clean' && evidenceAt) verdict.at = evidenceAt;
                return verdict;
              }
              // The staff verdict is the evidence, at ITS timestamp.
              return { ...buildAddressVerdict({ flag: null, enriched: { addressVerdict: 'audited' }, profileFound: true, address: normalizedAddress }), at: staffCleanAt };
            })(),
          })]),
          updated_at: new Date(),
        });
      });
    } catch (verdictErr) {
      logger.error(`[public-property-lookup] address verdict publication failed — refusing the lookup: ${verdictErr.code || verdictErr.name || 'error'}`);
      return res.status(503).json({ error: 'We could not finish checking this address. Please try again in a moment.' });
    }

    res.json({
      lead_id: lead.id,
      enriched,
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
  publicEnrichedProfile,
  normalizeServiceInterest,
  formatServiceInterestForFrequency,
};
