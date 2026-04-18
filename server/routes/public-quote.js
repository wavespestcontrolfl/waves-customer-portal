const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { generateEstimate } = require('../services/pricing-engine');

const quoteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many quote requests. Please try again later.' },
});

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

router.post('/calculate', quoteLimiter, async (req, res) => {
  try {
    const { leadId, firstName, lastName, email, phone, address, city, zip, homeSqFt, lotSqFt, stories, propertyType, enriched, services, attribution } = req.body || {};

    if (!firstName || !lastName || !email || !phone || !address) {
      return res.status(400).json({ error: 'Missing required contact or address fields.' });
    }
    if (!services || (!services.pest && !services.lawn)) {
      return res.status(400).json({ error: 'Select at least one service.' });
    }

    const sqft = Math.max(500, Math.min(20000, Number(homeSqFt) || 2000));
    const lot = Math.max(500, Math.min(200000, Number(lotSqFt) || sqft * 4));
    const ep = (enriched && typeof enriched === 'object') ? enriched : {};

    // NOTE: enriched density/pool/complexity fields are captured on the lead
    // row for follow-up but NOT passed into the pricing engine here. Flipping
    // those inputs on would quietly raise public quotes by ~$10/visit vs the
    // pre-lookup flow (LIGHT defaults → MODERATE defaults). Keep public quote
    // pricing stable until explicitly greenlit.
    const engineInput = {
      homeSqFt: sqft,
      stories: 1,
      lotSqFt: lot,
      propertyType: propertyType || ep.propertyType || 'Single Family',
      services: {},
    };
    if (services.pest) {
      engineInput.services.pest = { frequency: services.pest.frequency || 'quarterly' };
    }
    if (services.lawn) {
      engineInput.services.lawn = {
        track: services.lawn.track || 'st_augustine',
        tier: services.lawn.tier || 'enhanced',
      };
    }

    const estimate = generateEstimate(engineInput);
    const monthly = Number(estimate?.summary?.recurringMonthlyAfterDiscount || 0);
    const annual = Number(estimate?.summary?.recurringAnnualAfterDiscount || 0);

    if (!monthly || !annual) {
      logger.error('[public-quote] Engine returned zero price', { engineInput, estimate });
      return res.status(500).json({ error: 'Unable to calculate a price right now.' });
    }

    const serviceInterest = [services.pest ? 'Pest Control' : null, services.lawn ? 'Lawn Care' : null].filter(Boolean).join(' + ');
    const normalizedPhone = normalizePhone(phone);

    const attr = (attribution && typeof attribution === 'object') ? attribution : null;
    const gclid = attr?.gclid ? String(attr.gclid).slice(0, 255) : null;

    const extractedData = JSON.stringify({
      stage: 'quote_calculated',
      homeSqFt: sqft,
      lotSqFt: lot,
      services,
      enriched: ep,
      annual,
      monthly,
      utm: attr?.utm || null,
      referrer: attr?.referrer || null,
      landing_url: attr?.landing_url || null,
    });

    // If the property-lookup step already captured a lead row, update it
    // in place so we don't double-count leads for a single conversion.
    let lead;
    if (leadId) {
      const rows = await db('leads')
        .where({ id: leadId })
        .update({
          first_name: firstName,
          last_name: lastName,
          email: email.toLowerCase().trim(),
          phone: normalizedPhone || phone,
          address: [address, city, zip].filter(Boolean).join(', '),
          city: city || null,
          zip: zip || null,
          service_interest: serviceInterest,
          monthly_value: monthly,
          extracted_data: extractedData,
          updated_at: new Date(),
        })
        .returning(['id']);
      lead = rows[0];
    }
    if (!lead) {
      const rows = await db('leads').insert({
        first_name: firstName,
        last_name: lastName,
        email: email.toLowerCase().trim(),
        phone: normalizedPhone || phone,
        address: [address, city, zip].filter(Boolean).join(', '),
        city: city || null,
        zip: zip || null,
        service_interest: serviceInterest,
        lead_type: 'quote_wizard',
        first_contact_channel: 'website_quote',
        monthly_value: monthly,
        status: 'new',
        gclid,
        extracted_data: extractedData,
      }).returning(['id']);
      lead = rows[0];
    }

    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin(
        'new_lead',
        `Calculator quote: ${firstName} ${lastName}`,
        `${serviceInterest} · $${Math.round(monthly)}/mo · ${address}`,
        { icon: '\u{1F4B0}', link: '/admin/leads', metadata: { leadId: lead.id } }
      );
    } catch (e) {
      logger.error(`[public-quote] Admin notify failed: ${e.message}`);
    }

    res.json({
      lead_id: lead.id,
      monthly_total: Math.round(monthly),
      annual_total: Math.round(annual),
      variance_low: Math.round(monthly * 0.95),
      variance_high: Math.round(monthly * 1.05),
      service_interest: serviceInterest,
    });
  } catch (err) {
    logger.error(`[public-quote] calculate failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Something went wrong. Please call (941) 318-7612 for a quote.' });
  }
});

module.exports = router;
