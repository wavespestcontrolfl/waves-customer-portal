const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const PipelineManager = require('../services/pipeline-manager');
const LeadScorer = require('../services/lead-scorer');
const { resolveLocationFromCandidates, isOfficeCity, findGbpLocationByUtmContent } = require('../config/locations');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');

const { aiTriageLead } = require('../services/lead-triage');
const { etDateString } = require('../utils/datetime-et');
const { isEnabled } = require('../config/feature-gates');
// Service-line inference is shared with the call attribution path so both
// populate ad_service_attribution identically — see utils/service-line-infer.
const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');
// Backfills the CALL-source funnel row when a voicemail text-back lead is
// attached here (the call path skipped it: recovery leads are customer-less).
const { backfillCallLeadAttribution } = require('../services/ads/call-attribution');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
const { normalizeLeadAddress } = require('../utils/address-normalizer');
const { zipToCity } = require('../utils/zip-to-city');
const { verifyLeadPrefillToken } = require('../utils/lead-prefill-token');
const { cleanEmail, cleanText } = require('../utils/intake-normalize');
const { properCase } = require('../utils/name-case');
const { verifyTurnstileToken } = require('../utils/turnstile');
const {
  blockIfAutomatedEstimateDuplicate,
  withAutomatedEstimatePhoneLock,
} = require('../services/estimate-automation-duplicates');
const {
  automationNote,
  buildAutomatedLeadDraftEstimate,
  evaluateLeadEstimateAutomationReadiness,
} = require('../services/lead-estimate-automation');

const LEAD_PREFILL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function notifyTwilioFailure(payload) {
  void alertTwilioFailure(payload).catch((alertErr) => {
    logger.error(`[twilio-alerts] async notification failed: ${alertErr.message}`);
  });
}

function scrubLeadAlertProviderError(value) {
  return String(value || '')
    .replace(/%2B1\d{10}/gi, '[phone]')
    .replace(/\+1\d{10}\b/g, '[phone]')
    .replace(/\b1\d{10}\b/g, '[phone]')
    .replace(/\b\d{10}\b/g, '[phone]');
}

async function markLeadAlertCallLogFailed(callLogId, errorMessage, database = db) {
  if (!callLogId) return;
  await database('call_log').where({ id: callLogId }).update({
    status: 'failed',
    notes: `Twilio create failed: ${errorMessage}`,
    updated_at: new Date(),
  });
}

// Delegates to the shared robust title-caser (Mc/Mac/O'/particles/hyphens) so
// form-lead names match every other ingestion path.
function capitalizeName(name) {
  return properCase(name);
}
const leadAttribution = require('../services/lead-attribution');
const { SPOKE_SITES } = require('../services/content-astro/spoke-sites');

// Single source of truth for the spoke fleet: the domains determineLeadSource()
// matches for organic domain_website attribution are derived from SPOKE_SITES (the
// same canonical list the Astro build + content filter use) — so adding a spoke
// there auto-attributes its inbound form leads here instead of dropping to the
// 'Unattributed (web)' fallback. The hub (group 'Hub') is excluded — it resolves
// to waves_website. `area` is optional display/location enrichment (used for
// location resolution + stored on the lead); a spoke absent from SPOKE_AREA still
// attributes correctly as domain_website, just with a null area.
const SPOKE_DOMAIN_KEYS = SPOKE_SITES.filter((s) => s.group !== 'Hub').map((s) => s.key);
const SPOKE_AREA = {
  'bradentonflexterminator.com': 'Bradenton', 'bradentonflpestcontrol.com': 'Bradenton', 'bradentonfllawncare.com': 'Bradenton',
  'palmettoexterminator.com': 'Palmetto', 'palmettoflpestcontrol.com': 'Palmetto',
  'parrishexterminator.com': 'Parrish', 'parrishpestcontrol.com': 'Parrish', 'parrishfllawncare.com': 'Parrish',
  'sarasotaflexterminator.com': 'Sarasota', 'sarasotaflpestcontrol.com': 'Sarasota', 'sarasotafllawncare.com': 'Sarasota',
  'veniceexterminator.com': 'Venice', 'veniceflpestcontrol.com': 'Venice', 'venicelawncare.com': 'Venice',
  'northportflpestcontrol.com': 'North Port',
  'waveslawncare.com': 'SW Florida',
};

// Adam's personal cell for new-lead alerts — must be a real cell, never one
// of our own Twilio numbers (same-from/to sends fail with Twilio error 21266).
const ADAM_CELL = process.env.ADAM_PHONE || '+19415993489';

function applyLeadEstimateAutomationGate(readiness = {}) {
  if (isEnabled('leadEstimateAutomation')) return readiness;
  return {
    ...readiness,
    status: 'disabled',
    ready: false,
    disabled: true,
    disabledReason: 'lead_estimate_automation_gate_disabled',
  };
}

// --- Abuse protection for the public, unauthenticated lead webhook ---
// Every accepted POST fans out to real-money side effects: a customer-facing
// SMS to the SUBMITTED number, a call/SMS to the owner's personal cell, and
// marketing enrollment. Unthrottled, this is an SMS-pumping + owner-harassment
// vector — any anonymous caller can ring the owner's cell on every request.
// Legitimate lead-form submissions from one visitor/number are rare, so tight
// caps cost real users nothing. Prod-only (mirrors the app-wide limiter) so
// local dev and the Jest suite — which POST here repeatedly — are unaffected.
const leadWebhookIpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 8,
  message: { error: 'Too many submissions, please try again shortly.' },
  skip: () => process.env.NODE_ENV !== 'production',
});

// Second axis: cap how often any single phone number can be the lead target,
// independent of source IP. This blunts a rotating-IP attacker pumping SMS at
// one victim number. Keyed off the SAME phone the handler will text (via the
// shared intake builder). Engages only when a phone is present; the IP limiter
// covers the rest, so there is no shared-bucket / IPv6-keying edge case here.
function leadSubmittedPhoneKey(req) {
  try {
    const { rawPhone } = buildLeadWebhookIntake(req.body || {});
    const digits = String(rawPhone || '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : '';
  } catch (_err) {
    return '';
  }
}
const leadWebhookPhoneLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 4,
  message: { error: 'Too many submissions for this number, please try again later.' },
  keyGenerator: (req) => `leadphone:${leadSubmittedPhoneKey(req)}`,
  skip: (req) => process.env.NODE_ENV !== 'production' || !leadSubmittedPhoneKey(req),
});

// Honeypot trap: the public forms render a visually-hidden, autocomplete-off
// `fax_number` input that real users never see or fill. Any non-empty value is
// an indiscriminate bot that populated every field. Pure + exported for tests.
// (`fax_number` chosen deliberately — modern browsers/password managers don't
// autofill fax, so a real visitor won't trip it.)
function isHoneypotTripped(body) {
  const v = body && body.fax_number;
  return typeof v === 'string' && v.trim() !== '';
}

// POST /api/webhooks/lead — website lead-form submission webhook
router.post('/', leadWebhookIpLimiter, leadWebhookPhoneLimiter, async (req, res) => {
  try {
    const body = req.body;

    // --- Abuse guards, BEFORE any DB write / draft estimate / owner SMS ---
    // Every accepted POST fans out to real-money side effects (customer +
    // draft estimate + a text to the owner's cell), so bot submissions are
    // stopped here, before the fan-out.
    //
    // 1) Honeypot (always on). 200-OK — not 4xx — so the bot believes it
    //    succeeded and doesn't adapt, but nothing is created. Old cached pages
    //    omit the field (undefined → passes), so this is safe unconditionally.
    if (isHoneypotTripped(body)) {
      logger.info('[lead-webhook] honeypot tripped — silently dropping submission');
      return res.status(200).json({ success: true });
    }

    // 2) Cloudflare Turnstile (gated behind GATE_LEAD_TURNSTILE). Verified
    //    server-side. While the gate is OFF we still verify-and-log (shadow) so
    //    we can see how many real submissions WOULD be blocked before flipping,
    //    but never block. Enforcement (403) begins only once the owner sets the
    //    secret AND the Astro widget has propagated AND the gate is flipped on.
    //    Misconfiguration / Cloudflare errors fail OPEN (see utils/turnstile).
    const turnstile = await verifyTurnstileToken(body && body.turnstile_token, req.ip);
    if (!turnstile.ok) {
      logger.info(
        `[lead-webhook] turnstile ${turnstile.reason} ` +
          `(enforced=${turnstile.enforced}, gate=${isEnabled('leadTurnstile')})`
      );
      if (isEnabled('leadTurnstile') && turnstile.enforced) {
        return res.status(403).json({ error: 'Verification failed. Please try again.' });
      }
    }

    const intake = buildLeadWebhookIntake(body);
    const {
      email,
      rawPhone,
      normalizedAddress,
      address,
      fullAddress,
      pageUrl,
      landingUrl,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      formId,
      formName,
      gclid,
      wbraid,
      gbraid,
      fbclid,
      fbc,
      fbp,
      firstName,
      lastName,
      serviceInterest,
      leadSource,
    } = intake;

    // City fallback. Forms only capture a structured city when the visitor
    // picks a Google Places suggestion; free-text submissions arrive with no
    // city (e.g. "87th Street East, FL 34219"). Recover it from the ZIP so a
    // lead never lands with a blank city. zipCity is also used standalone on
    // the existing-customer update path, which fills from the submitted
    // address only (no marketing-page area).
    //
    // Order: parsed city → a *routable* source area → ZIP city → raw area. A
    // non-city source area ("SW Florida" for the brand-wide lawn domain, or
    // arbitrary Google Ads utm_content) must lose to the ZIP city — storing it
    // would mislabel the city and break downstream city-based routing.
    const zipCity = zipToCity(normalizedAddress.zip) || '';
    const resolvedCity = normalizedAddress.city
      || (isOfficeCity(leadSource.area) ? leadSource.area : '')
      || zipCity
      || leadSource.area
      || '';

    const phone = cleanPhone(rawPhone);
    if (!phone || phone.length < 10) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }
    const phoneFormatted = '+1' + phone.slice(-10);
    let estimateAutomationReadiness = null;

    // Look up matching lead_sources record for proper attribution
    let leadSourceId = null;
    try {
      let sourceRecord = null;
      // Match by domain first (most specific)
      if (leadSource.source === 'domain_website' && leadSource.detail) {
        sourceRecord = await db('lead_sources')
          .where('domain', leadSource.detail)
          .where('is_active', true)
          .first();
      }
      // Match by source_type + channel
      if (!sourceRecord && leadSource.source === 'google_business') {
        const gbpLocation = findGbpLocationByUtmContent(leadSource.area || utmContent);
        if (gbpLocation?.googleLocationId) {
          sourceRecord = await db('lead_sources')
            .where('source_type', 'gbp')
            .where('gbp_location_id', gbpLocation.googleLocationId)
            .where('is_active', true)
            .first();
        }
      }
      if (!sourceRecord && leadSource.source === 'google_business') {
        sourceRecord = await db('lead_sources')
          .where('source_type', 'website_organic')
          .where('channel', 'google')
          .where('is_active', true)
          .first();
      }
      if (!sourceRecord && leadSource.source === 'waves_website') {
        // Prefer the city-specific hub row when the classifier resolved an area
        // (e.g. a Parrish page → "Website — Parrish (city page)") instead of an
        // arbitrary .first() over every wavespestcontrol row (which mis-tagged
        // Parrish leads as Bradenton). Fall back to the generic Main Site row.
        if (leadSource.area) {
          sourceRecord = await db('lead_sources')
            .where('source_type', 'main_site')
            .where('is_active', true)
            .whereRaw('name ILIKE ?', [`%${leadSource.area}%`])
            .first();
        }
        if (!sourceRecord) {
          sourceRecord = await db('lead_sources')
            .where('domain', 'like', '%wavespestcontrol%')
            .where('is_active', true)
            .orderByRaw("(name ILIKE '%Main Site (%') DESC")
            .first();
        }
      }
      if (!sourceRecord && leadSource.source === 'nextdoor') {
        sourceRecord = await db('lead_sources')
          .where('source_type', 'marketplace')
          .where('channel', 'social_organic')
          .where('is_active', true)
          .first();
      }
      if (!sourceRecord && leadSource.source === 'facebook') {
        // Match the Facebook row for the right channel: paid ad clicks
        // (fbclid/_fbc or utm cpc → channel 'paid') resolve to the paid
        // call-extension / ads row; organic social (channel 'organic')
        // resolves to an organic Facebook row. Without the channel filter a
        // paid call-extension row would also swallow organic social form
        // leads and mislabel them in lead-source reports.
        const fbQuery = db('lead_sources')
          .whereRaw("LOWER(name) LIKE '%facebook%'")
          .where('is_active', true);
        if (leadSource.channel) fbQuery.where('channel', leadSource.channel);
        sourceRecord = await fbQuery.first();
      }
      if (sourceRecord) leadSourceId = sourceRecord.id;
    } catch (e) {
      logger.warn(`[lead-webhook] Lead source lookup failed: ${e.message}`);
    }

    // Check for existing customer
    const existing = await db('customers').where({ phone: phoneFormatted }).first();

    // Dedup: if this customer already submitted a form within the last 5 minutes,
    // skip the heavy notification work below. Protects against accidental
    // double-clicks and form retries; legitimate re-submissions hours/days
    // later still flow through normally. New customers can't be duplicates by
    // definition (no prior interactions), so the check only applies to existing.
    let isDuplicateSubmission = false;
    if (existing) {
      try {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
        const recent = await db('customer_interactions')
          .where('customer_id', existing.id)
          .where('interaction_type', 'note')
          .where(function () {
            this.whereILike('subject', 'form submission%').orWhereILike('subject', 'new lead from%');
          })
          .where('created_at', '>=', fiveMinAgo)
          .first();
        if (recent) isDuplicateSubmission = true;
      } catch (e) {
        logger.warn(`[lead-webhook] dedup lookup failed (continuing): ${e.message}`);
      }
    }

    let customer;
    let isNewCustomer = false;
    // Resolve the office from the best routable signal: the structured city,
    // then the source area, then the ZIP-derived city — skipping any that
    // aren't a known office city. This recovers location for a ZIP-derived
    // city (34219 -> Parrish on a main-site lead with no area) without letting
    // a real-but-unmapped Places city (e.g. "Rotonda West") shadow a known
    // source area (e.g. a Venice spoke). Falls back to the Bradenton default.
    const location = resolveLocationFromCandidates([normalizedAddress.city, leadSource.area, zipCity]);

    if (existing) {
      customer = existing;
      // Update attribution if missing
      const updates = { last_contact_date: new Date(), last_contact_type: 'form_submission' };
      if (!existing.lead_source) updates.lead_source = leadSource.source;
      if (!existing.lead_source_detail) updates.lead_source_detail = leadSource.detail;
      if (!existing.email && email) updates.email = email;
      if (!existing.address_line1 && address) updates.address_line1 = address;
      if (!existing.city && (normalizedAddress.city || zipCity)) updates.city = normalizedAddress.city || zipCity;
      if (!existing.state && normalizedAddress.state) updates.state = normalizedAddress.state;
      if (!existing.zip && normalizedAddress.zip) updates.zip = normalizedAddress.zip;
      if (existing.lead_intake_status) updates.lead_intake_status = null;

      await db('customers').where({ id: existing.id }).update(updates);

      await db('customer_interactions').insert({
        customer_id: existing.id, interaction_type: 'note',
        subject: 'Form submission (existing customer)',
        body: `Submitted form from ${leadSource.detail || leadSource.source}. Page: ${pageUrl || 'unknown'}`,
        metadata: JSON.stringify({ formId, formName, utmSource, utmMedium, utmCampaign }),
      });

      logger.info(`Lead webhook: existing customer ${existing.first_name} ${existing.last_name} submitted form${isDuplicateSubmission ? ' (duplicate within 5min — skipping notifications)' : ''}`);
    } else {
      isNewCustomer = true;
      // Create new customer
      const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

      const [newCust] = await db('customers').insert({
        first_name: firstName, last_name: lastName,
        phone: phoneFormatted, email: email || null,
        address_line1: address || '',
        city: resolvedCity,
        state: normalizedAddress.state || 'FL',
        zip: normalizedAddress.zip || '',
        referral_code: code,
        lead_source: leadSource.source,
        lead_source_detail: leadSource.detail,
        lead_source_channel: leadSource.channel,
        lead_source_area: leadSource.area,
        utm_data: JSON.stringify({ source: utmSource, medium: utmMedium, campaign: utmCampaign, term: utmTerm, content: utmContent, pageUrl, landingUrl, formId, formName }),
        landing_page_url: landingUrl || pageUrl,
        form_id: formId,
        nearest_location_id: location.id,
        pipeline_stage: 'new_lead',
        pipeline_stage_changed_at: new Date(),
        last_contact_date: new Date(),
        last_contact_type: 'form_submission',
        member_since: etDateString(),
        waveguard_tier: null,
      }).returning('*');
      customer = newCust;

      await db('property_preferences').insert({ customer_id: customer.id });
      await db('notification_prefs').insert({ customer_id: customer.id });

      await db('customer_interactions').insert({
        customer_id: customer.id, interaction_type: 'note',
        subject: `New lead from ${leadSource.detail || leadSource.source}`,
        body: `Form: ${formName || formId || 'unknown'}. Page: ${pageUrl || 'unknown'}. Address: ${fullAddress || 'not provided'}.`,
        metadata: JSON.stringify({ leadSource, formId, address: normalizedAddress }),
      });

      await PipelineManager.onEvent(customer.id, 'lead_created');
      await LeadScorer.calculateScore(customer.id);
    }

    estimateAutomationReadiness = applyLeadEstimateAutomationGate(evaluateLeadEstimateAutomationReadiness({
      intake,
      customer,
      phone: phoneFormatted,
      serviceInterest,
    }));

    // Provenance stage shared by both leads-row paths. Built BEFORE the
    // existing-customer early return so the voicemail text-back prefill attach
    // can run on that path too; the acquisition path below layers in the
    // draft-estimate automation snapshot (which doesn't exist yet here).
    const webhookStageBase = {
      stage: 'lead_webhook_received',
      service_interest: serviceInterest || null,
      automation: {
        leadEstimateAutomation: estimateAutomationReadiness,
        draftEstimateAutomation: null,
      },
      attribution: {
        leadSource,
        formId,
        formName,
        pageUrl,
        landingUrl,
        utm: {
          source: utmSource,
          medium: utmMedium,
          campaign: utmCampaign,
          content: utmContent,
          term: utmTerm,
        },
        clickIds: { gclid: gclid || null, wbraid: wbraid || null, gbraid: gbraid || null, fbclid: fbclid || null, fbc: fbc || null, fbp: fbp || null },
      },
      address: normalizedAddress,
    };
    const buildPrefillAttachFields = () => ({
      first_name: firstName, last_name: lastName,
      phone: phoneFormatted, email: email || null,
      address: fullAddress || '',
      city: resolvedCity,
      service_interest: serviceInterest || null,
      customer_id: customer.id,
    });

    if (!shouldRunLeadAcquisition({ isNewCustomer, isDuplicateSubmission })) {
      // Customer record + interaction note are written above so we still have an
      // audit trail. Existing customers must not continue into lead acquisition:
      // no new-lead notifications, lead auto-replies, lead intake state, draft
      // estimates, leads rows, or lead-agent processing.
      //
      // The voicemail text-back prefill attach DOES still run here: the open
      // call-pipeline lead predates this customers row (voicemail recovery
      // leads are customer-less at call time, and the office may have
      // converted the prospect manually before they clicked the SMS link).
      // Skipping it would strand that lead unattached — no typed contact
      // data, no customer link, no call-source attribution backfill — while
      // the prospect believes they responded. The attach only UPDATES an
      // existing open lead row; every acquisition side-effect stays skipped.
      let attachedLead = null;
      try {
        attachedLead = await attachVoicemailPrefillLead({
          body,
          fields: buildPrefillAttachFields(),
          webhookStage: { ...webhookStageBase, existing_customer_attach: true },
        });
        if (attachedLead) {
          await backfillCallLeadAttribution({
            leadId: attachedLead.id,
            customerId: customer.id,
            serviceInterest: serviceInterest || null,
          });
        }
      } catch (attachErr) {
        logger.warn(`[lead-webhook] existing-customer prefill attach failed: ${attachErr.message}`);
      }
      return res.json({
        success: true,
        customerId: customer.id,
        deduped: !!isDuplicateSubmission,
        existingCustomer: !isNewCustomer,
        ...(attachedLead ? { attachedLeadId: attachedLead.id } : {}),
      });
    }

    // Push + bell notification for admins
    try {
      const { triggerNotification } = require('../services/notification-triggers');
      await triggerNotification('new_lead', {
        name: `${firstName || ''} ${lastName || ''}`.trim() || phoneFormatted,
        source: leadSource.detail || leadSource.source,
        zip: customer.zip,
        service: serviceInterest || null,
        leadId: customer.id,
      });
    } catch (e) { logger.error(`[notifications] new_lead trigger failed: ${e.message}`); }

    // Notify Adam — during business hours (8AM-8PM ET) trigger a call, otherwise SMS
    const now = new Date();
    const etHour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }));
    const isDuringHours = etHour >= 8 && etHour < 20;
    let callConnected = false;
    let attemptedLeadCallFrom = null;
    let pendingLeadAlertCallLogId = null;

    try {
      const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      if (isDuringHours && twilioClient) {
        // During business hours: ring Adam's cell with a voice announcement of
        // the lead (no Press-1-to-connect, no auto-dialing the lead). Adam calls
        // back manually from the admin portal or directly.
        try {
          const domain = process.env.SERVER_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || 'portal.wavespestcontrol.com';
          const fromNumber = TWILIO_NUMBERS.mainLine.number;
          attemptedLeadCallFrom = fromNumber;
          const autoBridge = isEnabled('leadAutoBridge');

          if (autoBridge) {
            // Press-1-to-connect auto-bridge. Create call_log row FIRST so
            // outbound-admin-prompt / outbound-connect can update it without
            // racing Twilio's webhook fire (2–5s after create()).
            const bridgeCallerId = TWILIO_NUMBERS.mainLine.number;
            const [callLogRow] = await db('call_log')
              .insert({
                customer_id: customer.id,
                direction: 'outbound',
                from_phone: fromNumber,
                to_phone: ADAM_CELL,
                status: 'initiated',
                source: 'lead-webhook-auto-bridge',
                metadata: JSON.stringify({
                  type: 'lead_auto_bridge',
                  leadName: `${firstName} ${lastName}`,
                  leadPhone: phoneFormatted,
                  bridgeCallerId,
                }),
              })
              .returning(['id']);
            const callLogId = callLogRow?.id;
            pendingLeadAlertCallLogId = callLogId || null;

            const promptParams = new URLSearchParams({
              customerNumber: phoneFormatted,
              callerIdNumber: bridgeCallerId,
              leadName: firstName,
            });
            if (callLogId) promptParams.set('callLogId', callLogId);

            logger.info(`[lead-webhook] Auto-bridge ON — calling Adam for ${firstName} (${phoneFormatted}). callLogId: ${callLogId}`);
            const call = await twilioClient.calls.create({
              to: ADAM_CELL,
              from: fromNumber,
              url: `https://${domain}/api/webhooks/twilio/outbound-admin-prompt?${promptParams.toString()}`,
              statusCallback: `https://${domain}/api/webhooks/twilio/call-status`,
              statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
              record: false,
            });
            callConnected = true;
            logger.info(`[lead-webhook] Auto-bridge CallSid: ${call.sid}`);

            if (callLogId) {
              await db('call_log').where({ id: callLogId }).update({
                twilio_call_sid: call.sid,
                updated_at: new Date(),
              }).catch(err => {
                logger.warn(`[lead-webhook] Could not backfill call_log.twilio_call_sid: ${err.message}`);
              });
            }
          } else {
            // Flag OFF — keep the announce-only behavior: speak the lead name
            // and phone to Adam, he calls back manually.
            logger.info(`[lead-webhook] Auto-bridge OFF — announcing lead ${firstName} (${phoneFormatted}) to Adam. Domain: ${domain}`);
            const call = await twilioClient.calls.create({
              to: ADAM_CELL,
              from: fromNumber,
              url: `https://${domain}/api/webhooks/twilio/lead-alert-announce?leadName=${encodeURIComponent(firstName)}&leadPhone=${encodeURIComponent(phoneFormatted)}`,
              statusCallback: `https://${domain}/api/webhooks/twilio/call-status`,
              statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
              record: false,
            });
            callConnected = true;
            logger.info(`[lead-webhook] Announce CallSid: ${call.sid}`);

            try {
              await db('call_log').insert({
                customer_id: customer.id,
                direction: 'outbound',
                from_phone: fromNumber,
                to_phone: ADAM_CELL,
                twilio_call_sid: call.sid,
                status: 'initiated',
                source: 'lead-webhook-announce',
                metadata: JSON.stringify({
                  type: 'lead_alert_announce',
                  leadName: `${firstName} ${lastName}`,
                  leadPhone: phoneFormatted,
                }),
              });
            } catch (logErr) {
              logger.warn(`[lead-webhook] Could not log outbound call: ${logErr.message}`);
            }
          }
        } catch (callErr) {
          const safeError = scrubLeadAlertProviderError(callErr.message);
          if (pendingLeadAlertCallLogId) {
            await markLeadAlertCallLogFailed(pendingLeadAlertCallLogId, safeError).catch(err => {
              logger.warn(`[lead-webhook] Could not mark lead alert call_log failed: ${err.message}`);
            });
          }
          logger.error(`[lead-webhook] Lead alert call failed, falling back to SMS: ${safeError}`);
          notifyTwilioFailure({
            channel: 'voice',
            direction: 'outbound',
            phase: 'send_api',
            status: 'failed',
            errorMessage: safeError,
            from: attemptedLeadCallFrom,
            to: ADAM_CELL,
            link: '/admin/leads',
          });
          await TwilioService.sendSMS(ADAM_CELL,
            `🔔 New lead!\n${firstName} ${lastName}\n📞 ${phoneFormatted}\n📍 ${fullAddress || 'No address'}\n🌐 ${leadSource.detail || leadSource.source}\n${utmCampaign ? '📊 Campaign: ' + utmCampaign : ''}`,
            { messageType: 'internal_alert' }
          );
        }
      } else {
        // After hours: SMS alert only
        await TwilioService.sendSMS(ADAM_CELL,
          `🔔 New lead!\n${firstName} ${lastName}\n📞 ${phoneFormatted}\n📍 ${fullAddress || 'No address'}\n🌐 ${leadSource.detail || leadSource.source}\n${utmCampaign ? '📊 Campaign: ' + utmCampaign : ''}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (e) { logger.error(`Lead alert failed: ${e.message}`); }

    // Auto-reply to lead — always send (whether call connected or not),
    // 24/7. The template acknowledges the quote request; later inbound
    // replies can still be classified by server/services/lead-intake.js
    // when they include service interest or address details. Edit copy in
    // the admin UI.
    try {
      const replyMsg = await renderRequiredSmsTemplate(
        'lead_auto_reply_biz',
        { first_name: firstName },
        { workflow: 'lead_webhook_auto_reply', entity_type: 'customer', entity_id: customer.id }
      );

      const smsResult = await sendCustomerMessage({
        to: phoneFormatted,
        body: replyMsg,
        channel: 'sms',
        audience: 'lead',
        purpose: 'conversational',
        customerId: customer.id,
        identityTrustLevel: 'phone_matches_customer',
        entryPoint: 'lead_webhook_auto_reply',
        metadata: {
          original_message_type: 'auto_reply',
          customerLocationId: location.id,
          lead_source: leadSource.source,
        },
      });
      if (!smsResult.sent) {
        logger.warn(`[lead-webhook] Auto-reply blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      }

      // Seed the intake state machine so the customer's next inbound SMS
      // gets routed through server/services/lead-intake.js (classify →
      // ask for address → auto-create draft estimate → notify Adam).
      try {
        await db('customers').where({ id: customer.id }).update({
          lead_intake_status: 'awaiting_service',
        });
      } catch (stateErr) {
        // Non-fatal — the auto-reply was sent; worst case the next SMS
        // falls through to the normal AI draft path.
        logger.warn(`[lead-webhook] intake state seed failed: ${stateErr.message}`);
      }
    } catch (e) { logger.error(`Lead auto-reply failed: ${e.message}`); }

    // Enroll in the local new_lead automation sequence (SendGrid-backed).
    try {
      if (email) {
        const AutomationRunner = require('../services/automation-runner');
        const r = await AutomationRunner.enrollCustomer({
          templateKey: 'new_lead',
          customer: { email, first_name: firstName, last_name: lastName, id: customer?.id || null },
        });
        logger.info(`[lead-webhook] enrolled customer ${customer?.id || 'unlinked'} in new_lead: ${JSON.stringify(r)}`);
      }
    } catch (e) { logger.error(`Lead enroll failed: ${e.message}`); }

    // Create estimate/quote record so it appears in Pipeline → Quotes tab
    let createdEstimateId = null;
    let createdEstimateServiceInterest = serviceInterest || null;
    let automatedDraftEstimate = null;
    try {
      await withAutomatedEstimatePhoneLock(phoneFormatted, async (trx) => {
        const duplicateBlock = await blockIfAutomatedEstimateDuplicate(phoneFormatted, { database: trx });

        if (duplicateBlock) {
          logger.info(`[lead-webhook] Estimate creation blocked by duplicate estimate ${duplicateBlock.existingEstimateId} for customer ${customer.id}`);
        } else {
          automatedDraftEstimate = buildAutomatedLeadDraftEstimate({
            intake,
            customer,
            body,
            readiness: estimateAutomationReadiness,
          });
          const crypto = require('crypto');
          const estimateToken = crypto.randomBytes(16).toString('hex');
          const estimateData = automatedDraftEstimate?.estimateData || {
            automation: {
              leadEstimateAutomation: estimateAutomationReadiness,
            },
          };
          const draftAutomation = automatedDraftEstimate?.automation;
          const draftAutomationNote = draftAutomation
            ? ` Draft automation: ${draftAutomation.status}${draftAutomation.unsupportedReason ? ` (${draftAutomation.unsupportedReason})` : ''}.`
            : '';
          const [estimateRow] = await trx('estimates').insert({
            customer_id: customer.id,
            customer_name: `${firstName} ${lastName}`,
            customer_phone: phoneFormatted,
            customer_email: email || null,
            address: fullAddress || '',
            monthly_total: automatedDraftEstimate?.monthly || null,
            annual_total: automatedDraftEstimate?.annual || null,
            onetime_total: automatedDraftEstimate?.oneTimeTotal || null,
            status: 'draft',
            source: 'lead_webhook',
            service_interest: serviceInterest || null,
            lead_source: leadSource.source,
            lead_source_detail: leadSource.detail,
            token: estimateToken,
            estimate_data: JSON.stringify(estimateData),
            notes: `Form: ${formName || formId || 'unknown'}. Page: ${pageUrl || 'unknown'}. ${automationNote(estimateAutomationReadiness)}${draftAutomationNote}`,
          }).returning(['id', 'service_interest']);
          createdEstimateId = estimateRow?.id || null;
          createdEstimateServiceInterest = estimateRow?.service_interest || createdEstimateServiceInterest;
        }
      });
    } catch (estErr) {
      logger.error(`Lead estimate creation failed: ${estErr.message}`);
    }

    // Create leads table record for pipeline tracking
    let leadRecord = null;
    let attachedViaPrefill = false;
    try {
      const webhookStage = {
        ...webhookStageBase,
        automation: {
          ...webhookStageBase.automation,
          draftEstimateAutomation: automatedDraftEstimate?.automation || null,
        },
      };

      // Voicemail text-back prefill attach — same contract as the quote-wizard
      // priced path (public-property-lookup.js): a valid lead-prefill token
      // (minted ONLY by the voicemail text-back SMS) UPDATES that existing
      // call-pipeline lead instead of minting a duplicate form_submission row.
      // Typed values win over the voicemail extraction; call attribution
      // (lead_source_id / lead_type / first_contact_*) is preserved;
      // extracted_data is MERGED so the voicemail provenance and the one-shot
      // SMS stamp survive. Terminal or converted leads never re-attach.
      const attached = await attachVoicemailPrefillLead({
        body,
        fields: buildPrefillAttachFields(),
        webhookStage,
      });
      if (attached) {
        leadRecord = attached;
        attachedViaPrefill = true;
      }

      if (!leadRecord) {
        const [newLead] = await db('leads').insert({
          first_name: firstName, last_name: lastName,
          phone: phoneFormatted, email: email || null,
          address: fullAddress || '',
          city: resolvedCity,
          lead_source_id: leadSourceId,
          lead_type: 'form_submission',
          service_interest: serviceInterest || null,
          extracted_data: JSON.stringify(webhookStage),
          first_contact_at: new Date(),
          first_contact_channel: 'form',
          status: 'new',
          customer_id: customer.id,
          gclid: gclid || null,
          wbraid: wbraid || null,
          gbraid: gbraid || null,
          fbclid: fbclid || null,
          fbc: fbc || null,
          fbp: fbp || null,
          is_residential: true,
        }).returning('*');
        leadRecord = newLead;
      }
    } catch (leadErr) {
      logger.error(`Lead record creation failed: ${leadErr.message}`);
    }

    // Fire-and-forget AI triage
    if (leadRecord) {
      const messageText = body.message || body['Message'] || serviceInterest || findField(body, /service|help|pest|lawn|message/i) || '';
      aiTriageLead({ name: `${firstName} ${lastName}`, phone: phoneFormatted, message: messageText, address: fullAddress, pageUrl, formName })
        .then(async (triageResult) => {
          if (!triageResult) return;
          try {
            const updates = {};
            const triageServiceInterestUpdate = serviceInterestUpdateFromTriage(
              leadRecord.service_interest,
              triageResult.serviceInterest
            );
            if (triageServiceInterestUpdate) {
              updates.service_interest = triageServiceInterestUpdate;
            }
            if (triageResult.urgency) updates.urgency = triageResult.urgency;
            if (triageResult.extractedData) {
              // On an attached call-pipeline lead, MERGE — a wholesale replace
              // here would clobber the voicemail provenance and the text-back
              // one-shot stamp the prefill attach just preserved.
              updates.extracted_data = attachedViaPrefill
                ? db.raw("COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify(triageResult.extractedData)])
                : JSON.stringify(triageResult.extractedData);
            }
            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date();
              await db('leads').where('id', leadRecord.id).update(updates);
            }
            if (createdEstimateId && triageServiceInterestUpdate) {
              const triageReadiness = applyLeadEstimateAutomationGate(evaluateLeadEstimateAutomationReadiness({
                intake: {
                  ...intake,
                  serviceInterest: triageServiceInterestUpdate,
                },
                customer,
                phone: phoneFormatted,
                serviceInterest: triageServiceInterestUpdate,
              }));
              const triageDraftEstimate = buildAutomatedLeadDraftEstimate({
                intake: {
                  ...intake,
                  serviceInterest: triageServiceInterestUpdate,
                },
                customer,
                body,
                readiness: triageReadiness,
              });
              const estimateUpdateQuery = db('estimates')
                .where({
                  id: createdEstimateId,
                  source: 'lead_webhook',
                  status: 'draft',
                });
              if (createdEstimateServiceInterest) {
                estimateUpdateQuery.where('service_interest', createdEstimateServiceInterest);
              } else {
                estimateUpdateQuery.where((q) => {
                  q.whereNull('service_interest').orWhere('service_interest', '');
                });
              }
              await estimateUpdateQuery.update({
                service_interest: triageServiceInterestUpdate,
                monthly_total: triageDraftEstimate?.monthly || null,
                annual_total: triageDraftEstimate?.annual || null,
                onetime_total: triageDraftEstimate?.oneTimeTotal || null,
                estimate_data: JSON.stringify(triageDraftEstimate?.estimateData || {
                  automation: {
                    leadEstimateAutomation: triageReadiness,
                    draftEstimateAutomation: triageDraftEstimate?.automation || null,
                  },
                }),
                updated_at: new Date(),
              });
            }
            await db('lead_activities').insert({
              lead_id: leadRecord.id,
              activity_type: 'ai_triage',
              description: 'AI triage completed',
              performed_by: 'system',
              metadata: JSON.stringify({
                serviceInterest: triageResult.serviceInterest,
                urgency: triageResult.urgency,
                extractedData: triageResult.extractedData,
                suggestedReply: triageResult.suggestedReply,
              }),
            });
            logger.info(`[lead-webhook] AI triage completed for lead ${leadRecord.id}`);
          } catch (storeErr) {
            logger.error(`[lead-webhook] AI triage store failed: ${storeErr.message}`);
          }
        })
        .catch(err => logger.error(`[lead-webhook] AI triage fire-and-forget error: ${err.message}`));
    }

    // Fire-and-forget Lead Response Agent — personalized response in <60s
    // The generic auto-reply above is the safety net; this replaces it with something specific
    try {
      const LeadResponseAgent = require('../services/lead-response-agent');
      const messageText = body.message || body['Message'] || serviceInterest || findField(body, /service|help|pest|lawn|message/i) || '';
      LeadResponseAgent.processLead({
        leadId: leadRecord?.id,
        customerId: customer.id,
        phone: phoneFormatted,
        name: `${firstName} ${lastName}`,
        message: messageText,
        address: fullAddress || '',
        city: resolvedCity,
        leadSource: leadSource.source,
        pageUrl: pageUrl || '',
        formName: formName || '',
      }).catch(err => logger.error(`[lead-agent] Fire-and-forget error: ${err.message}`));
    } catch (e) { logger.error(`[lead-agent] Init error: ${e.message}`); }

    await db('activity_log').insert({
      customer_id: customer.id, action: 'customer_created',
      description: `New lead: ${firstName} ${lastName} from ${leadSource.detail || leadSource.source}`,
      metadata: JSON.stringify({ leadSource, phone: phoneFormatted }),
    });

    // Bell + push for new leads are already fired earlier in this handler
    // via triggerNotification('new_lead', …). The legacy direct notifyAdmin
    // call that used to live here caused every lead to ring the bell twice.
    // Removed intentionally; do NOT re-add without deduping upstream.

    // Ad service attribution — track the full funnel from lead onward.
    // A lead ATTACHED via the voicemail text-back prefill token is a
    // call-pipeline lead: its funnel row belongs to the CALL source (the
    // tracking number the prospect dialed) — a web-channel row here would win
    // the unique lead_id slot and permanently misattribute a paid/GBP
    // voicemail to the website. And because the call processor's attribution
    // is customerId-gated while voicemail recovery leads are customer-less at
    // call time, no call row exists yet either: BACKFILL it now that this
    // handler has linked the customer (lead_id dedupe + first-touch inside).
    try {
      if (attachedViaPrefill) {
        await backfillCallLeadAttribution({
          leadId: leadRecord?.id || null,
          customerId: customer.id,
          serviceInterest: serviceInterest || null,
        });
      } else {
        await db('ad_service_attribution').insert({
          customer_id: customer.id,
          // Stamp the lead so the call-attribution path dedupes against this row
          // (a customer who fills the web form and later calls the paid number is
          // one lead, not two) — see services/ads/call-attribution.js.
          lead_id: leadRecord?.id || null,
          service_line: inferServiceLine(serviceInterest),
          specific_service: inferSpecificService(serviceInterest),
          service_bucket: inferServiceBucket(serviceInterest),
          lead_date: etDateString(),
          lead_source: leadSource.source,
          lead_source_detail: leadSource.detail,
          gclid: gclid || null,
          wbraid: wbraid || null,
          gbraid: gbraid || null,
          fbclid: fbclid || null,
          fbc: fbc || null,
          fbp: fbp || null,
          utm_campaign: utmCampaign,
          utm_term: utmTerm,
          funnel_stage: 'lead',
          // determineLeadSource marks every paid classification (google cpc,
          // gclid/wbraid/gbraid, fbclid/_fbc, facebook cpc) channel='paid'.
          // Without this stamp even gclid rows sit at is_paid NULL and the paid
          // funnel views undercount.
          is_paid: leadSource.channel === 'paid',
        }).onConflict('lead_id').ignore();
      }
    } catch (attrErr) {
      logger.error(`Ad attribution insert failed: ${attrErr.message}`);
    }

    logger.info(`Lead webhook: new customer ${firstName} ${lastName} from ${leadSource.source}`);
    res.json({ success: true, customerId: customer.id });
  } catch (err) {
    logger.error(`Lead webhook error: ${err.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ============================================
// HELPERS
// ============================================

// Voicemail text-back prefill attach. A valid lead-prefill token (minted ONLY
// by the voicemail text-back SMS) UPDATES that existing call-pipeline lead
// instead of minting a duplicate row. Typed values win over the voicemail
// extraction; call attribution (lead_source_id / lead_type / first_contact_*)
// is preserved; extracted_data is MERGED so the voicemail provenance and the
// one-shot SMS stamp survive. Terminal or converted leads never re-attach.
// Returns the attached lead row, or null (invalid/missing token, lead not
// attachable, or attach error — callers fall back to their default path).
async function attachVoicemailPrefillLead({ body, fields, webhookStage }) {
  const prefillLeadId = cleanText(body.prefill_lead_id || body.prefillLeadId || '');
  const prefillToken = cleanText(body.prefill_token || body.prefillToken || '');
  if (!(prefillLeadId && prefillToken && LEAD_PREFILL_UUID_RE.test(prefillLeadId)
    && verifyLeadPrefillToken(prefillLeadId, prefillToken))) {
    return null;
  }
  try {
    const [attached] = await db('leads')
      .where({ id: prefillLeadId })
      .whereNotIn('status', ['won', 'lost', 'disqualified', 'duplicate'])
      .whereNull('converted_at')
      .update({
        ...fields,
        // Reopen a lead the office parked as 'unresponsive' — they just
        // responded, and that status buckets as closed in the admin UI.
        status: db.raw("CASE WHEN status = 'unresponsive' THEN 'new' ELSE status END"),
        extracted_data: db.raw(
          "COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify(webhookStage)]
        ),
        updated_at: new Date(),
      })
      .returning('*');
    if (attached) {
      logger.info(`[lead-webhook] attached form submission to existing lead ${prefillLeadId} via prefill token`);
    }
    return attached || null;
  } catch (attachErr) {
    logger.warn(`[lead-webhook] prefill attach failed — caller falls back to its default path: ${attachErr.message}`);
    return null;
  }
}

function findField(body, pattern) {
  for (const [key, value] of Object.entries(body)) {
    if (pattern.test(key) && value) return String(value);
  }
  return null;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (str) return str;
  }
  return '';
}

function normalizeLeadName(body = {}) {
  const explicitFirst = firstNonEmpty(body.first_name, body.firstName);
  const explicitLast = firstNonEmpty(body.last_name, body.lastName);

  if (explicitFirst || explicitLast) {
    if (explicitFirst && !explicitLast) {
      const firstParts = explicitFirst.split(/\s+/).filter(Boolean);
      if (firstParts.length > 1) {
        return {
          first_name: firstParts[0],
          last_name: firstParts.slice(1).join(' '),
        };
      }
    }
    return {
      first_name: explicitFirst || null,
      last_name: explicitLast || null,
    };
  }

  const rawName = firstNonEmpty(
    body.name,
    body.full_name,
    body.fullName,
    body['First Things First Whats Your Name'],
    findField(body, /name/i)
  );
  const parts = rawName.split(/\s+/).filter(Boolean);

  return {
    first_name: parts[0] || null,
    last_name: parts.length > 1 ? parts.slice(1).join(' ') : null,
  };
}

function getLeadWebhookAttribution(body = {}) {
  const attr = (body.attribution && typeof body.attribution === 'object') ? body.attribution : {};
  const attrUtm = (attr.utm && typeof attr.utm === 'object') ? attr.utm : {};
  const domainFallback = firstNonEmpty(attr.domain, body.domain);

  // Attribution can arrive in two shapes:
  //   1. Flat top-level fields (legacy callers, GHL forms, etc.)
  //   2. Nested under body.attribution (spoke sites and quote wizard)
  // Flat values win so legacy callers keep their exact behavior.
  const synthesizedFromDomain = (
    !body.page_url &&
    !body['Page Url'] &&
    !body.referrer &&
    !body.landing_url &&
    !body['Landing Url'] &&
    !attr.referrer &&
    !attr.landing_url &&
    domainFallback
  ) ? `https://www.${domainFallback}/` : '';

  return {
    pageUrl: body.page_url || body['Page Url'] || body.referrer || attr.referrer || synthesizedFromDomain || '',
    landingUrl: body.landing_url || body['Landing Url'] || attr.landing_url || synthesizedFromDomain || '',
    utmSource: body.utm_source || body['Utm Source'] || attrUtm.source || '',
    utmMedium: body.utm_medium || body['Utm Medium'] || attrUtm.medium || '',
    utmCampaign: body.utm_campaign || body['Utm Campaign'] || attrUtm.campaign || '',
    utmContent: body.utm_content || body['Utm Content'] || attrUtm.content || '',
    utmTerm: body.utm_term || body['Utm Term'] || attrUtm.term || '',
    gclid: truncateClickId(body.gclid || body['Gclid'] || body.GCLID || attr.gclid || ''),
    wbraid: truncateClickId(body.wbraid || body['Wbraid'] || body.WBRAID || attr.wbraid || ''),
    gbraid: truncateClickId(body.gbraid || body['Gbraid'] || body.GBRAID || attr.gbraid || ''),
    // Meta click id + first-party cookies (the gclid analog), for Meta web-lead
    // attribution + Conversions API match keys.
    fbclid: truncateClickId(body.fbclid || body['Fbclid'] || body.FBCLID || attr.fbclid || ''),
    fbc: truncateClickId(body.fbc || body['Fbc'] || attr.fbc || ''),
    fbp: truncateClickId(body.fbp || body['Fbp'] || attr.fbp || ''),
  };
}

function truncateClickId(value) {
  return value ? String(value).slice(0, 255) : '';
}

function buildLeadWebhookIntake(body = {}) {
  // Map raw form field names (garbled -> clean)
  const email = cleanEmail(body.email || body['Whats Your Best Email'] || findField(body, /email/i) || '');
  const rawPhone = body.phone || body['Got A Number We Can Call Or Text'] || findField(body, /number|phone|call|text/i) || '';
  const rawAddress = body.address || body['And Whats Your Address'] || findField(body, /address/i) || '';
  const normalizedAddress = normalizeLeadAddress({
    raw: rawAddress,
    line1: body.address_line1 || body.addressLine1,
    city: body.city,
    state: body.state,
    zip: body.zip,
    placeId: body.google_place_id || body.googlePlaceId,
    components: body.address_components || body.addressComponents,
  });
  const address = normalizedAddress.line1 || rawAddress;
  const fullAddress = normalizedAddress.fullAddress || rawAddress;
  const attribution = getLeadWebhookAttribution(body);
  const normalizedName = normalizeLeadName(body);
  const firstName = capitalizeName(normalizedName.first_name || 'Unknown');
  const lastName = capitalizeName(normalizedName.last_name || '');
  const serviceInterest = normalizeLeadServiceInterest(body);
  const leadSource = determineLeadSource(
    attribution.pageUrl,
    attribution.landingUrl,
    attribution.utmSource,
    attribution.utmMedium,
    attribution.utmCampaign,
    attribution.utmContent,
    attribution.fbclid,
    attribution.fbc,
    attribution.gclid,
    attribution.wbraid,
    attribution.gbraid,
  );

  return {
    email,
    rawPhone,
    rawAddress,
    normalizedAddress,
    address,
    fullAddress,
    ...attribution,
    formId: body.form_id || body['Form Id'] || '',
    formName: body.form_name || body['Form Name'] || body.source || '',
    firstName,
    lastName,
    serviceInterest,
    leadSource,
  };
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

function normalizeExplicitServiceInterest(value) {
  const raw = firstNonEmpty(value);
  if (!raw) return '';
  const parenthetical = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenthetical) {
    const frequencyKey = normalizeFrequencyKey(parenthetical[2]);
    if (FREQUENCY_LABELS[frequencyKey]) {
      return formatServiceInterestForFrequency(parenthetical[1], frequencyKey);
    }
  }
  return serviceLabelFor(raw);
}

function normalizeLeadServiceInterest(body = {}) {
  const explicit = firstNonEmpty(
    body.service_interest,
    body.serviceInterest,
    body.service,
    body.service_type,
    body.serviceType,
    body['What Can We Help You With'],
    body['Selected Service'],
    body['Service']
  );
  if (explicit) return normalizeExplicitServiceInterest(explicit);

  const specificService = firstNonEmpty(body.specific_service, body.specificService);
  const interest = firstNonEmpty(specificService, body.interest, body.Interest);
  const otherService = firstNonEmpty(body.otherService, body.other_service, body['Other Service']);
  if (!interest) {
    const legacyField = firstNonEmpty(findField(body, /service|help|pest|lawn/i));
    return legacyField ? serviceLabelFor(legacyField) : '';
  }

  const serviceLabel = interest.toLowerCase() === 'other'
    ? serviceLabelFor(otherService || interest)
    : serviceLabelFor(interest);
  if (!serviceLabel) return '';

  const frequency = firstNonEmpty(body.frequency, body.Frequency);
  return frequency ? formatServiceInterestForFrequency(serviceLabel, frequency) : serviceLabel;
}

function isWorkflowSpecificServiceInterest(value) {
  const text = firstNonEmpty(value).toLowerCase();
  return /\b(one[- ]?time|recurring|consultation|quarterly|bi[- ]?monthly|monthly|semiannual|semi[- ]annual)\b/.test(text);
}

function serviceInterestUpdateFromTriage(currentServiceInterest, triageServiceInterest) {
  const next = firstNonEmpty(triageServiceInterest);
  if (!next) return null;
  if (!firstNonEmpty(currentServiceInterest)) return next;
  return isWorkflowSpecificServiceInterest(currentServiceInterest) ? null : next;
}

function shouldApplyTriageServiceInterest(currentServiceInterest, triageServiceInterest) {
  return !!serviceInterestUpdateFromTriage(currentServiceInterest, triageServiceInterest);
}

function shouldRunLeadAcquisition({ isNewCustomer, isDuplicateSubmission } = {}) {
  return !!isNewCustomer && !isDuplicateSubmission;
}

function cleanPhone(value) {
  if (!value) return '';
  return String(value).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
}

function determineLeadSource(pageUrl, landingUrl, utmSource, utmMedium, utmCampaign, utmContent, fbclid, fbc, gclid, wbraid, gbraid) {
  const url = landingUrl || pageUrl || '';
  const source = String(utmSource || '').trim().toLowerCase();
  const medium = String(utmMedium || '').trim().toLowerCase();
  const campaign = String(utmCampaign || '').trim().toLowerCase();

  // UTM-based attribution (most specific)
  if (source === 'gbp' || (source === 'google' && medium === 'organic' && campaign === 'gbp')) {
    const gbpLocation = findGbpLocationByUtmContent(utmContent);
    return {
      source: 'google_business',
      detail: gbpLocation ? `GBP ${gbpLocation.name}` : 'GBP unattributed',
      channel: 'organic',
      area: gbpLocation?.id || null,
    };
  }
  if (utmSource === 'google' && utmMedium === 'cpc') return { source: 'google_ads', detail: `Campaign: ${utmCampaign}`, channel: 'paid', area: utmContent };
  if (utmSource === 'facebook' || utmSource === 'fb') return { source: 'facebook', detail: `${utmMedium} — ${utmCampaign}`, channel: utmMedium === 'cpc' ? 'paid' : 'organic' };
  if (utmSource === 'nextdoor') return { source: 'nextdoor', detail: utmCampaign || '', channel: 'social' };
  // Google auto-tagging (the default) appends gclid — or wbraid/gbraid for
  // iOS/web-to-app — to ad-click landing URLs WITHOUT utm_source/medium, so an
  // auto-tagged paid click would otherwise fall through to the organic/referrer
  // default and never count as Google Ads. The Google analog of the Meta fbclid
  // branch below. (Explicit utm_source=google&cpc above still wins, with richer detail.)
  if (gclid || wbraid || gbraid) {
    return { source: 'google_ads', detail: utmCampaign ? `Campaign: ${utmCampaign}` : 'Google Ads click (gclid)', channel: 'paid', area: utmContent };
  }
  // Meta auto-appends fbclid to ad-click landing URLs even without explicit UTMs;
  // _fbc is its cookie form (survives navigation when the URL fbclid is lost). A
  // lead carrying either, with no clearer source above, is a paid Meta click.
  // (_fbp alone is NOT counted — Meta sets it on every visit, organic included.)
  if (fbclid || fbc) return { source: 'facebook', detail: fbclid ? 'Meta click (fbclid)' : 'Meta click (_fbc)', channel: 'paid' };

  // Domain-based attribution. The spoke fleet is single-sourced from SPOKE_SITES
  // (see SPOKE_DOMAIN_KEYS / SPOKE_AREA above) so it can't drift from the Astro
  // build's domain list — a spoke added there attributes here automatically. A
  // domain not in the fleet falls through to the 'website' fallback below, which
  // the dashboard surfaces as "Unattributed (web)" — a visible signal to map it,
  // not a silent miss (the class of bug PR #264 fixed piecemeal).
  const spokeDomain = SPOKE_DOMAIN_KEYS.find((domain) => url.includes(domain));
  if (spokeDomain) return { source: 'domain_website', detail: spokeDomain, channel: 'organic', area: SPOKE_AREA[spokeDomain] || null };

  // Waves main site (hub) pages. Detect the CITY anywhere in the URL path — not just
  // a fixed /pest-control-<city> list — so quote pages (/pest-control-quote-parrish-fl/),
  // lawn/mosquito city pages, etc. get the right area instead of falling to a generic
  // "Main site". Channel is always waves_website (organic hub); the page slug is the
  // detail so it stays specific for any page type.
  if (url.includes('wavespestcontrol.com')) {
    const path = String(url).replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].replace(/\/+$/, '');
    const seg = path.split('/').filter(Boolean).pop() || '';
    // Anchor single-word cities to the "-fl" city/quote-page suffix so an incidental
    // mention in a slug isn't read as a city — most importantly "palmetto-bug" (a FL
    // cockroach) must NOT resolve to Palmetto and skew office routing. Compound names
    // (north-port, lakewood-ranch) are unambiguous on their own and need no anchor.
    const HUB_CITIES = [
      [/north[-_ ]?port/i, 'North Port'], [/lakewood[-_ ]?ranch/i, 'Lakewood Ranch'],
      [/bradenton-fl/i, 'Bradenton'], [/parrish-fl/i, 'Parrish'], [/sarasota-fl/i, 'Sarasota'],
      [/venice-fl/i, 'Venice'], [/palmetto-fl/i, 'Palmetto'], [/ellenton-fl/i, 'Ellenton'],
    ];
    const hit = HUB_CITIES.find(([re]) => re.test(path));
    return { source: 'waves_website', detail: seg ? `${seg} page` : 'Main site', channel: 'organic', area: hit ? hit[1] : undefined };
  }

  return { source: utmSource || 'website', detail: utmMedium || '', channel: 'unknown' };
}

module.exports = router;
module.exports._test = {
  attachVoicemailPrefillLead,
  scrubLeadAlertProviderError,
  markLeadAlertCallLogFailed,
  buildLeadWebhookIntake,
  getLeadWebhookAttribution,
  normalizeLeadServiceInterest,
  formatServiceInterestForFrequency,
  serviceInterestUpdateFromTriage,
  shouldApplyTriageServiceInterest,
  shouldRunLeadAcquisition,
  applyLeadEstimateAutomationGate,
  determineLeadSource,
  isHoneypotTripped,
};
