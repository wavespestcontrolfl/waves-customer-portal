const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { performPropertyLookup } = require('./property-lookup-v2');
const { resolveLeadSource } = require('../services/lead-source-resolver');

// Aggressive rate limit — each lookup spends real RentCast + Google + Claude +
// Gemini dollars. 5 per IP per hour is enough for a real lead to iterate on
// the address a couple of times, but blocks scripted abuse.
const lookupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many lookup requests. Please try again in an hour or call (941) 297-5749.' },
});

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

router.post('/property-lookup', lookupLimiter, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, address, attribution } = req.body || {};

    if (!firstName || !lastName) return res.status(400).json({ error: 'Name required.' });
    if (!/^\S+@\S+\.\S+$/.test(email || '')) return res.status(400).json({ error: 'Valid email required.' });
    const normPhone = normalizePhone(phone);
    if (!normPhone) return res.status(400).json({ error: 'Valid 10-digit phone required.' });
    if (!address || String(address).trim().length < 5) return res.status(400).json({ error: 'Address required.' });

    const attr = (attribution && typeof attribution === 'object') ? attribution : null;
    const gclid = attr?.gclid ? String(attr.gclid).slice(0, 255) : null;
    const sourceMeta = await resolveLeadSource(attr);

    // Capture the lead BEFORE firing the expensive API chain. Abuse-protection
    // + marketing attribution + recovery if the user bails mid-flow.
    const [lead] = await db('leads').insert({
      first_name: firstName,
      last_name: lastName,
      email: String(email).toLowerCase().trim(),
      phone: normPhone,
      address: String(address).trim(),
      lead_type: 'quote_wizard',
      first_contact_channel: 'website_quote',
      lead_source_id: sourceMeta.leadSourceId,
      status: 'new',
      gclid,
      extracted_data: JSON.stringify({
        stage: 'property_lookup_started',
        utm: attr?.utm || null,
        referrer: attr?.referrer || null,
        landing_url: attr?.landing_url || null,
      }),
    }).returning(['id']);

    const result = await performPropertyLookup(address);

    // Persist the enriched profile on the lead so a stale/abandoned row is
    // still useful for follow-up.
    try {
      await db('leads').where({ id: lead.id }).update({
        extracted_data: JSON.stringify({
          stage: 'property_lookup_complete',
          enriched: result.enriched || null,
          rentcast: result.rentcast || null,
          avm: result.avm || null,
          ai_sources: result.aiAnalysis?._sources || null,
          utm: attr?.utm || null,
          referrer: attr?.referrer || null,
          landing_url: attr?.landing_url || null,
        }),
        updated_at: new Date(),
      });
    } catch (e) {
      logger.error(`[public-property-lookup] lead update failed: ${e.message}`);
    }

    res.json({
      lead_id: lead.id,
      enriched: result.enriched,
      rentcast: result.rentcast ? {
        propertyType: result.rentcast.propertyType,
        squareFootage: result.rentcast.squareFootage,
        lotSize: result.rentcast.lotSize,
        yearBuilt: result.rentcast.yearBuilt,
      } : null,
      satellite: result.satellite ? {
        closeUrl: result.satellite.closeUrl,
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
