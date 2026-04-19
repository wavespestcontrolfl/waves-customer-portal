const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { generateEstimate } = require('../services/pricing-engine');
const TwilioService = require('../services/twilio');
const smsTemplatesRouter = require('./admin-sms-templates');

const WAVES_ADMIN_PHONE = '+19413187612';
const PORTAL_BASE_URL = 'https://portal.wavespestcontrol.com';

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through to fallback */ }
  return fallback;
}

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

    // Greenlit 2026-04-18: enriched property features (pool/cage, shrub/tree
    // density, landscape complexity, near-water, large-driveway) flow into the
    // pricing engine so public quotes match what admin /estimate would price.
    // Same per-visit modifiers as admin (+$10 pool cage, +$5 moderate shrubs,
    // etc. — see constants.js PEST.additionalAdjustments). The customer still
    // sees a ±5% range (variance_low/high below) so AI misclassification has
    // headroom. Zero retroactive impact: no quote_wizard leads existed when
    // this landed.
    const engineInput = {
      homeSqFt: sqft,
      stories: Math.max(1, Math.min(3, Number(stories) || Number(ep.stories) || 1)),
      lotSqFt: lot,
      propertyType: propertyType || ep.propertyType || 'Single Family',
      features: {
        pool: ep.pool === 'YES' || ep.pool === true || ep.poolCage === 'YES',
        poolCage: ep.poolCage === 'YES' || ep.poolCage === true,
        shrubs: (ep.shrubDensity || ep.shrubs || '').toString().toLowerCase() || undefined,
        trees: (ep.treeDensity || ep.trees || '').toString().toLowerCase() || undefined,
        complexity: (ep.landscapeComplexity || ep.complexity || '').toString().toLowerCase() || undefined,
        nearWater: ep.nearWater === 'YES' || ep.nearWater === true,
        largeDriveway: ep.hasLargeDriveway === true || ep.largeDriveway === true,
      },
      services: {},
    };
    // Public quote endpoint handles recurring plans only. One-time service
    // requests divert to /api/leads (lead-webhook.js) where the time-of-day
    // call/SMS logic lives — one-time jobs typically need a human conversation
    // (site visit, flare-up triage) before we can quote reliably.
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

    // Post-quote orchestration — customer self-serves with price + booking link,
    // admin gets SMS notification (no call — they already saw the price on screen).
    // The outbound-admin-call pattern is reserved for the no-price divert flow
    // via /api/leads (lead-webhook.js), where admin follow-up is actually needed.
    try {
      await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
        `\u{1F514} Quote-wizard lead!\n${firstName} ${lastName}\n\u{1F4DE} ${normalizedPhone || phone}\n\u{1F4CD} ${address || 'No address'}\n\u{1F4B0} ${serviceInterest} · $${Math.round(monthly)}/mo`,
        { messageType: 'internal_alert' }
      );
    } catch (e) { logger.error(`[public-quote] Admin SMS failed: ${e.message}`); }

    // Customer SMS: estimate_accepted_onetime template (DB-editable).
    if (normalizedPhone) {
      try {
        const wantsPest = !!services?.pest;
        const wantsLawn = !!services?.lawn;
        const serviceLabel = wantsPest && wantsLawn ? 'Pest Control & Lawn Care' : wantsPest ? 'Pest Control' : 'Lawn Care';
        const bookingServiceId = wantsPest ? 'pest_control' : 'lawn_care';
        const bookingUrl = `${PORTAL_BASE_URL}/book?service=${bookingServiceId}&source=quote-wizard`;
        const customerBody = await renderTemplate(
          'estimate_accepted_onetime',
          { first_name: firstName, service_label: serviceLabel, booking_url: bookingUrl },
          `Hey ${firstName}! Thanks for booking your ${serviceLabel} with Waves. Pick your time here — we'll show you slots when a tech will already be in your neighborhood: ${bookingUrl}\n\nQuestions? Just reply. — Waves`
        );
        await TwilioService.sendSMS(normalizedPhone, customerBody,
          { mediaUrl: 'https://www.wavespestcontrol.com/wp-content/uploads/2026/01/waves-pest-and-lawn-logo.png', messageType: 'auto_reply' }
        );
        logger.info(`[public-quote] Customer SMS sent to ${firstName} (${normalizedPhone})`);
      } catch (e) { logger.error(`[public-quote] Customer SMS failed: ${e.message}`); }
    }

    // Beehiiv: subscribe + tag + enroll in lead automation (drives the email side).
    try {
      const beehiiv = require('../services/beehiiv');
      if (beehiiv.configured && email) {
        const sub = await beehiiv.upsertSubscriber(email.toLowerCase().trim(), {
          firstName, lastName,
          utmSource: attr?.landing_url || attr?.utm?.source || 'waves_portal',
          utmMedium: 'quote_wizard',
        });
        if (sub?.id) {
          await beehiiv.addTags(sub.id, ['Lead', 'quote wizard']);
          const autoId = process.env.BEEHIIV_AUTO_LEAD || 'aut_d08077d4-3079-4e69-9488-f6669caf6a6c';
          await beehiiv.enrollInAutomation(autoId, { email: email.toLowerCase().trim(), subscriptionId: sub.id });
          logger.info(`[public-quote] Beehiiv: subscribed ${email}, enrolled in lead automation`);
        }
      }
    } catch (e) { logger.error(`[public-quote] Beehiiv enroll failed: ${e.message}`); }

    // has_setup_fee flags the $99 WaveGuard initial fee (recurring pest only).
    // UI notes this is waivable with annual prepay.
    const hasSetupFee = !!services.pest;

    // Confidence flag: when satellite enrichment came back empty (new construction,
    // missing imagery, AI couldn't classify), widen the customer-facing range from
    // ±5% to ±10% so we have headroom to true up on the site visit. Heuristic: if
    // none of the three landscape signals (shrubs/trees/complexity) classified,
    // we're flying blind on the modifiers that drive ~$5–$25/visit swings.
    const hasShrubs = !!(ep.shrubDensity || ep.shrubs);
    const hasTrees = !!(ep.treeDensity || ep.trees);
    const hasComplexity = !!(ep.landscapeComplexity || ep.complexity);
    const confidence = (hasShrubs || hasTrees || hasComplexity) ? 'high' : 'low';
    const varianceBand = confidence === 'low' ? 0.10 : 0.05;

    res.json({
      lead_id: lead.id,
      monthly_total: Math.round(monthly),
      annual_total: Math.round(annual),
      variance_low: Math.round(monthly * (1 - varianceBand)),
      variance_high: Math.round(monthly * (1 + varianceBand)),
      confidence,
      has_setup_fee: hasSetupFee,
      service_interest: serviceInterest,
    });
  } catch (err) {
    logger.error(`[public-quote] calculate failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Something went wrong. Please call (941) 318-7612 for a quote.' });
  }
});

module.exports = router;
