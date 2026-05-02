const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { generateEstimate } = require('../services/pricing-engine');
const TwilioService = require('../services/twilio');
const { shortenOrPassthrough } = require('../services/short-url');
const { subscribeOrResubscribe } = require('../services/newsletter-subscribers');
const { resolveLeadSource } = require('../services/lead-source-resolver');
const smsTemplatesRouter = require('./admin-sms-templates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

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
    const sourceMeta = await resolveLeadSource(attr);

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
      // Don't overwrite a lead_source_id set at property-lookup time — only fill
      // it in if the row is still missing one (manual leadId reuse, legacy rows).
      const updateFields = {
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
      };
      const rows = await db('leads')
        .where({ id: leadId })
        .update(updateFields)
        .returning(['id', 'lead_source_id']);
      lead = rows[0];
      if (lead && !lead.lead_source_id && sourceMeta.leadSourceId) {
        await db('leads').where({ id: lead.id }).update({ lead_source_id: sourceMeta.leadSourceId });
      }
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
        lead_source_id: sourceMeta.leadSourceId,
        monthly_value: monthly,
        status: 'new',
        gclid,
        extracted_data: extractedData,
      }).returning(['id']);
      lead = rows[0];
    }

    // Upsert a customers row so wizard-priced leads surface in /admin/customers
    // alongside the leads pipeline. Mirrors the lead-webhook precedent where
    // any qualified inbound creates a customer record at pipeline_stage=
    // 'new_lead'. Dedup: phone-digits regex first (matches /quick-add and the
    // customers search fallback), email second. NEVER downgrade an existing
    // active_customer/won row — only fill missing attribution and bump
    // last_contact_*. Lead and estimate are linked via customer_id once we
    // have it.
    let customerId = null;
    try {
      const phoneDigits = String(normalizedPhone || phone).replace(/\D/g, '').slice(-10);
      const emailLc = email.toLowerCase().trim();
      let existingCust = null;
      if (phoneDigits.length === 10) {
        existingCust = await db('customers')
          .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${phoneDigits}`])
          .whereNull('deleted_at')
          .first();
      }
      if (!existingCust && emailLc) {
        existingCust = await db('customers')
          .whereRaw('LOWER(email) = ?', [emailLc])
          .whereNull('deleted_at')
          .first();
      }

      // customers.lead_service_interest is varchar(32); a merged upsell string
      // ("Pest Control + Lawn Care + Mosquito...") will overflow. Truncate.
      const serviceInterestForCustomer = serviceInterest ? serviceInterest.slice(0, 32) : null;
      // landing_page_url is varchar(500); UTM-heavy URLs can creep past it.
      const landingForCustomer = attr?.landing_url ? String(attr.landing_url).slice(0, 500) : null;

      if (existingCust) {
        const updates = {
          last_contact_date: new Date(),
          last_contact_type: 'website_quote',
          lead_service_interest: serviceInterestForCustomer,
        };
        if (!existingCust.lead_source) updates.lead_source = 'website_quote';
        if (!existingCust.lead_source_detail) updates.lead_source_detail = sourceMeta.leadSourceDetail;
        if (!existingCust.lead_source_channel) updates.lead_source_channel = 'quote_wizard';
        if (!existingCust.lead_source_area && city) updates.lead_source_area = String(city).slice(0, 50);
        if (!existingCust.email && emailLc) updates.email = emailLc;
        if (!existingCust.address_line1 && address) updates.address_line1 = address;
        if (!existingCust.city && city) updates.city = city;
        if (!existingCust.zip && zip) updates.zip = zip;
        if (existingCust.latitude == null && ep.lat) updates.latitude = ep.lat;
        if (existingCust.longitude == null && ep.lng) updates.longitude = ep.lng;
        if (existingCust.property_sqft == null && sqft) updates.property_sqft = sqft;
        if (existingCust.lot_sqft == null && lot) updates.lot_sqft = lot;
        if (!existingCust.landing_page_url && landingForCustomer) updates.landing_page_url = landingForCustomer;
        if (!existingCust.utm_data && attr?.utm) updates.utm_data = attr.utm;
        await db('customers').where({ id: existingCust.id }).update(updates);
        customerId = existingCust.id;
      } else {
        const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
        const [newCust] = await db('customers').insert({
          first_name: firstName,
          last_name: lastName,
          email: emailLc,
          phone: normalizedPhone || phone,
          address_line1: address,
          city: city || '',
          state: 'FL',
          zip: zip || '',
          latitude: ep.lat || null,
          longitude: ep.lng || null,
          property_sqft: sqft,
          lot_sqft: lot,
          pipeline_stage: 'new_lead',
          pipeline_stage_changed_at: new Date(),
          lead_source: 'website_quote',
          lead_source_detail: sourceMeta.leadSourceDetail,
          lead_source_channel: 'quote_wizard',
          lead_source_area: city ? String(city).slice(0, 50) : null,
          lead_service_interest: serviceInterestForCustomer,
          landing_page_url: landingForCustomer,
          utm_data: attr?.utm || null,
          referral_code: code,
          last_contact_date: new Date(),
          last_contact_type: 'website_quote',
          active: true,
        }).returning(['id']);
        customerId = newCust.id;
      }

      if (customerId) {
        await db('leads').where({ id: lead.id }).update({ customer_id: customerId });
      }
    } catch (e) {
      logger.error(`[public-quote] Customer upsert failed: ${e.message}`);
    }

    // Mirror the priced quote into the estimates pipeline so wizard-generated
    // quotes show up alongside admin/tech estimates in /admin/estimates. Keyed
    // off lead_id in estimate_data — re-submits update the same draft instead
    // of stacking duplicates. Source 'quote_wizard' is the discriminator.
    // estimate_data is jsonb — pass the object directly so the ->>'lead_id'
    // lookup resolves; pre-stringifying risks pg storing it as a json string
    // scalar.
    try {
      const fullAddress = [address, city, zip].filter(Boolean).join(', ');
      const estimateDataObj = {
        lead_id: lead.id,
        services,
        monthly,
        annual,
        enriched: ep,
      };
      const existingEst = await db('estimates')
        .where({ source: 'quote_wizard', status: 'draft' })
        .whereRaw("estimate_data->>'lead_id' = ?", [lead.id])
        .first();
      const estFields = {
        customer_id: customerId,
        customer_name: `${firstName} ${lastName}`,
        customer_phone: normalizedPhone || phone,
        customer_email: email.toLowerCase().trim(),
        address: fullAddress,
        monthly_total: monthly,
        annual_total: annual,
        service_interest: serviceInterest,
        lead_source: sourceMeta.leadSourceName,
        lead_source_detail: sourceMeta.leadSourceDetail,
        estimate_data: estimateDataObj,
      };
      if (existingEst) {
        await db('estimates').where({ id: existingEst.id }).update({ ...estFields, updated_at: new Date() });
      } else {
        await db('estimates').insert({ ...estFields, status: 'draft', source: 'quote_wizard' });
      }
    } catch (e) {
      logger.error(`[public-quote] Estimate upsert failed: ${e.message}`);
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
        const longBookingUrl = `${PORTAL_BASE_URL}/book?service=${bookingServiceId}&source=quote-wizard`;
        const bookingUrl = await shortenOrPassthrough(longBookingUrl, {
          kind: 'booking', entityType: 'leads', entityId: lead.id,
        });
        const customerBody = await renderTemplate(
          'estimate_accepted_onetime',
          { first_name: firstName, service_label: serviceLabel, booking_url: bookingUrl },
          `Hey ${firstName}! Thanks for booking your ${serviceLabel} with Waves. Pick your time here and we'll show slots when a tech will already be in your neighborhood: ${bookingUrl}. Questions? Just reply. - Waves`
        );
        const smsResult = await sendCustomerMessage({
          to: normalizedPhone,
          body: customerBody,
          channel: 'sms',
          audience: 'lead',
          purpose: 'conversational',
          leadId: lead.id,
          identityTrustLevel: 'phone_provided_unverified',
          entryPoint: 'public_quote_booking_sms',
          metadata: {
            original_message_type: 'auto_reply',
            mediaUrls: ['https://www.wavespestcontrol.com/wp-content/uploads/2026/01/waves-pest-and-lawn-logo.png'],
          },
        });
        if (!smsResult.sent) {
          logger.warn(`[public-quote] Customer SMS blocked/failed for lead ${lead.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        } else {
          logger.info(`[public-quote] Customer SMS sent for lead ${lead.id}`);
        }
      } catch (e) { logger.error(`[public-quote] Customer SMS failed: ${e.message}`); }
    }

    // Newsletter enrollment — gated on explicit opt-in checkbox from the quote
    // wizard (QuotePage.jsx). Same consent bit drives both systems:
    //   - beehiiv lead drip (new_lead automation — promotional, per ASM classification)
    //   - SendGrid newsletter_subscribers table (ongoing monthly broadcast)
    // Without the checkbox: no email enrollment of any kind. User gets the quote,
    // the admin alert, and their customer-SMS booking link — nothing else.
    const newsletterOptIn = req.body.newsletter_opt_in === true;
    const emailLc = email ? email.toLowerCase().trim() : '';

    if (newsletterOptIn && emailLc) {
      try {
        const AutomationRunner = require('../services/automation-runner');
        const r = await AutomationRunner.enrollCustomer({
          templateKey: 'new_lead',
          customer: { email: emailLc, first_name: firstName, last_name: lastName, id: null },
        });
        logger.info(`[public-quote] enrolled ${emailLc} in new_lead: ${JSON.stringify(r)}`);
      } catch (e) { logger.error(`[public-quote] new_lead enroll failed: ${e.message}`); }

      // SendGrid side: dual-write into newsletter_subscribers via the
      // shared helper (audit §9.3 — single source of truth for the
      // resub/insert/customer-link flow). strict=false because the quote
      // form's own validation already gated the email shape; we don't
      // want to block a quote on a subtle regex difference.
      try {
        const result = await subscribeOrResubscribe({
          email: emailLc,
          firstName: firstName || null,
          lastName: lastName || null,
          source: 'quote_wizard',
          strict: false,
        });
        if (result.action === 'resubscribed') {
          logger.info(`[public-quote] SendGrid: resubscribed ${emailLc} via quote wizard`);
        } else if (result.action === 'created') {
          logger.info(`[public-quote] SendGrid: subscribed ${emailLc} via quote wizard`);
        }
      } catch (e) { logger.error(`[public-quote] newsletter_subscribers dual-write failed: ${e.message}`); }
    }

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

// Upsell labels: client sends IDs, server owns the copy that hits the lead row
// and the admin SMS. Keep in sync with UPSELL_OPTIONS in QuotePage.jsx.
const UPSELL_LABELS = {
  mosquito: 'Mosquito & No-See-Um Control',
  lawn_care: 'Lawn Care',
  pest_control: 'Pest Control',
  tree_shrub: 'Tree & Shrub Care',
  termite: 'Termite Protection',
};

router.post('/upsell', quoteLimiter, async (req, res) => {
  try {
    const { leadId, email, addOns } = req.body || {};
    if (!leadId || !email || !Array.isArray(addOns) || addOns.length === 0) {
      return res.status(400).json({ error: 'Missing leadId, email, or addOns.' });
    }

    const valid = addOns.filter(id => UPSELL_LABELS[id]);
    if (valid.length === 0) {
      return res.status(400).json({ error: 'No recognized add-ons.' });
    }

    // leadId + email match = good-enough public auth (customer just typed the
    // email in the same session). Avoids any-id-overwrite abuse.
    const lead = await db('leads')
      .where({ id: leadId })
      .whereRaw('LOWER(email) = ?', [String(email).toLowerCase().trim()])
      .first();
    if (!lead) return res.status(404).json({ error: 'Lead not found.' });

    const addLabels = valid.map(id => UPSELL_LABELS[id]);
    const existing = (lead.service_interest || '').split(' + ').filter(Boolean);
    const mergedInterest = Array.from(new Set([...existing, ...addLabels])).join(' + ');

    // pg returns jsonb columns as already-parsed JS objects; only JSON.parse if
    // it somehow came back as a string (legacy rows, manual edits).
    let existingData = {};
    if (lead.extracted_data && typeof lead.extracted_data === 'object') {
      existingData = lead.extracted_data;
    } else if (typeof lead.extracted_data === 'string') {
      try { existingData = JSON.parse(lead.extracted_data); } catch { existingData = {}; }
    }
    // Merge with any prior upsell IDs so a second /upsell call (retry, back-nav,
    // or double-fire) doesn't drop what the customer already added.
    const prevUpsells = Array.isArray(existingData.upsell_interests) ? existingData.upsell_interests : [];
    const mergedUpsells = Array.from(new Set([...prevUpsells, ...valid]));
    const updatedData = { ...existingData, upsell_interests: mergedUpsells, upsell_added_at: new Date().toISOString() };

    await db('leads').where({ id: leadId }).update({
      service_interest: mergedInterest,
      extracted_data: JSON.stringify(updatedData),
      updated_at: new Date(),
    });

    // Keep the quote_wizard estimate row in sync — admins viewing the pipeline
    // should see the merged service_interest after an upsell add, not the
    // original /calculate snapshot. Scope to status='draft' so a late upsell
    // submission can't mutate an estimate that's already been sent/viewed/
    // accepted (admins may have edited service_interest by hand at that
    // point — the customer-side flow shouldn't overwrite that).
    try {
      await db('estimates')
        .where({ source: 'quote_wizard', status: 'draft' })
        .whereRaw("estimate_data->>'lead_id' = ?", [leadId])
        .update({ service_interest: mergedInterest, updated_at: new Date() });
    } catch (e) { logger.error(`[public-quote] Estimate upsell sync failed: ${e.message}`); }

    // Cascade to the customer row's lead_service_interest (varchar(32) — must
    // truncate, since merged "Pest Control + Lawn Care + Mosquito..." overflows).
    // Same scope guard as the estimate sync — only if pipeline_stage is still
    // 'new_lead', so we don't mutate active/won customer profiles.
    if (lead.customer_id) {
      try {
        await db('customers')
          .where({ id: lead.customer_id, pipeline_stage: 'new_lead' })
          .update({
            lead_service_interest: mergedInterest.slice(0, 32),
            last_contact_date: new Date(),
            last_contact_type: 'website_quote',
          });
      } catch (e) { logger.error(`[public-quote] Customer upsell sync failed: ${e.message}`); }
    }

    const firstName = lead.first_name || '';
    const lastName = lead.last_name || '';
    try {
      await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
        `\u{2728} Upsell added\n${firstName} ${lastName}\n+ ${addLabels.join(', ')}`,
        { messageType: 'internal_alert' }
      );
    } catch (e) { logger.error(`[public-quote] Upsell admin SMS failed: ${e.message}`); }

    res.json({ ok: true, service_interest: mergedInterest });
  } catch (err) {
    logger.error(`[public-quote] upsell failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
