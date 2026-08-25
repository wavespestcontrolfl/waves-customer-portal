const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
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
const { sanitizeAnonUnitId } = require('../services/experimentation/growthbook');
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
const { normalizeLeadAddress, normalizeAdditionalProperties } = require('../utils/address-normalizer');
const { zipToCity } = require('../utils/zip-to-city');
const { verifyLeadPrefillToken } = require('../utils/lead-prefill-token');
const { OPEN_LEAD_STATUSES } = require('../services/lead-statuses');
const { cleanEmail, cleanText } = require('../utils/intake-normalize');
const { properCase } = require('../utils/name-case');
const { verifyTurnstileToken } = require('../utils/turnstile');
const { isHoneypotTripped, resolveSubmitHost } = require('../utils/lead-abuse');
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
// The canonical URL/UTM/click-id → lead_source classifier (and its
// SPOKE_SITES-derived domain list) moved VERBATIM to
// services/lead-source-classify.js so the self-booking attribution path
// (lead-estimate-link.js) classifies with the exact same semantics. This route
// keeps using — and re-exporting via `_test` — the shared implementation.
const { determineLeadSource } = require('../services/lead-source-classify');

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
    // Accept both our explicit field and the stock Turnstile field name the
    // widget posts (cf-turnstile-response), so a form that renders the widget
    // without remapping still verifies instead of 403-ing after rollout (codex P1).
    const turnstileToken = body && (body.turnstile_token || body['cf-turnstile-response']);
    // resolveSubmitHost lets verify() select the token's OWNING widget secret and
    // call siteverify exactly once — tokens are single-use, so probing other
    // widgets' secrets would spend it (codex P1). See utils/lead-abuse.
    const turnstile = await verifyTurnstileToken(turnstileToken, req.ip, resolveSubmitHost(req));
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
      additionalProperties,
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
      anonId,
      firstName,
      lastName,
      serviceInterest,
      leadSource,
    } = intake;
    // Human-readable note for triage / lead-response / owner alerts so the
    // extra-property ask can never be silently swallowed again (the ask used
    // to arrive as free text in the unit box and vanish).
    const additionalPropertiesNote = additionalProperties.length
      ? `Visitor also asked to cover ${additionalProperties.length > 1 ? 'additional properties' : 'an additional property'}: ${additionalProperties.map(p => p.formatted).join('; ')}`
      : '';

    // Inline street unit and dedicated unit field disagree — ambiguous. Fail
    // closed BEFORE any lead/customer mutation (same guard as
    // /public/quote/calculate and /property-lookup) rather than capture the
    // lead on the wrong unit.
    if (normalizedAddress.unitConflict) {
      return res.status(400).json({ error: 'The street address and unit number disagree — please re-enter your address.' });
    }

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
      const updates = buildExistingCustomerLeadUpdates({ existing, leadSource });
      await db('customers').where({ id: existing.id }).update(updates);

      await db('customer_interactions').insert({
        customer_id: existing.id, interaction_type: 'note',
        subject: 'Form submission (existing customer)',
        // Submitted contact details ride on the note body + metadata (NOT
        // the customers row) so staff can reconcile a changed email/address
        // by hand — existing customers return before the leads insert below.
        // Contact line goes FIRST: Customer 360 previews the body truncated
        // to 200 chars, and a long UTM-laden pageUrl would push it out of view.
        body: `Submitted contact (not applied to profile): email ${email || '—'}; address ${fullAddress || '—'}`
          + `\nSubmitted form from ${leadSource.detail || leadSource.source}. Page: ${pageUrl || 'unknown'}`,
        metadata: JSON.stringify({
          formId, formName, utmSource, utmMedium, utmCampaign,
          submittedContact: {
            email: email || null,
            address: fullAddress || null,
            city: normalizedAddress.city || zipCity || null,
            state: normalizedAddress.state || null,
            zip: normalizedAddress.zip || null,
          },
        }),
      });

      logger.info(`Lead webhook: existing customer ${existing.id} submitted form${isDuplicateSubmission ? ' (duplicate within 5min — skipping notifications)' : ''}`);
    } else {
      isNewCustomer = true;
      // Create new customer
      const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

      // Account layer: attach-or-create so the new lead profile is
      // login-complete (portal refresh sessions FK customer_accounts).
      // Lazy require: admin-customers is a route module (load-cycle risk).
      const { ensureCustomerAccount } = require('./admin-customers');
      const account = await ensureCustomerAccount(db, {
        firstName,
        lastName,
        phone: phoneFormatted,
        email: email || null,
      });
      const [newCust] = await db('customers').insert({
        account_id: account.accountId,
        is_primary_profile: !account.existingCustomer,
        profile_label: account.existingCustomer ? 'Additional property' : 'Primary',
        first_name: firstName, last_name: lastName,
        phone: phoneFormatted, email: email || null,
        address_line1: address || '',
        address_line2: normalizedAddress.line2 || null,
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
        body: `Form: ${formName || formId || 'unknown'}. Page: ${pageUrl || 'unknown'}. Address: ${fullAddress || 'not provided'}.${additionalPropertiesNote ? ` ${additionalPropertiesNote}.` : ''}`,
        metadata: JSON.stringify({ leadSource, formId, address: normalizedAddress }),
      });

      await PipelineManager.onEvent(customer.id, 'lead_created');
      await LeadScorer.calculateScore(customer.id);
    }

    estimateAutomationReadiness = applyLeadEstimateAutomationGate(evaluateLeadEstimateAutomationReadiness({
      intake,
      customer,
      // Raw submission: carries structured commercial flags the intake
      // shape doesn't model (codex r44 P1).
      body,
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
      ...(additionalProperties.length ? { additional_properties: additionalProperties } : {}),
    };
    const buildPrefillAttachFields = () => ({
      first_name: firstName, last_name: lastName,
      phone: phoneFormatted, email: email || null,
      address: fullAddress || '',
      city: resolvedCity,
      service_interest: serviceInterest || null,
      customer_id: customer.id,
      // The visitor just submitted from a browser carrying this unit id — a
      // call-pipeline lead attaching to a web submission gains the join too.
      ...(anonId ? { anon_id: anonId } : {}),
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
        if (!attachedLead) {
          attachedLead = await attachOpenCallLeadByPhone({
            phoneFormatted,
            typedFirstName: firstName,
            resolvedCustomerFirstName: customer?.first_name,
            fields: buildPrefillAttachFields(),
            webhookStage: { ...webhookStageBase, existing_customer_attach: true },
          });
        }
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

    // Push + bell notification for admins fires AFTER the lead row is
    // created (below) so the bell can deep-link the real lead id —
    // customer.id here made /admin/leads?lead=<id> resolve to nothing.

    // Notify Adam — during business hours (8AM-8PM ET) trigger a call, otherwise SMS
    const now = new Date();
    const etHour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }));
    const isDuringHours = etHour >= 8 && etHour < 20;
    let callConnected = false;
    let attemptedLeadCallFrom = null;
    let pendingLeadAlertCallLogId = null;
    // The legacy "New lead!" SMS to Adam's cell is redirected into an
    // internal_admin_alert bell (owner phones never receive raw SMS), so on
    // every after-hours or call-fallback lead it duplicated the new_lead
    // bell fired below (2026-07-30 audit: two bells one second apart per web
    // lead). Record the intent here; the send happens after the new_lead
    // trigger, and only if that bell/push failed to deliver.
    let legacyLeadSmsWanted = false;

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
          legacyLeadSmsWanted = true;
        }
      } else {
        // After hours: no call — the new_lead bell below covers the alert,
        // with the legacy SMS as delivery fallback only.
        legacyLeadSmsWanted = true;
      }
    } catch (e) { logger.error(`Lead alert failed: ${e.message}`); }

    // Auto-reply to lead — send AT MOST ONCE per person, ever (owner
    // ruling 2026-08-05). shouldRunLeadAcquisition() already limits this
    // to new customer rows, but the same person can produce a second
    // "new" row (phone stored in a different format, deleted/merged
    // record, double submission racing the 5-min window — 20 phones got
    // the menu text twice in prod). See hasPriorLeadAutoReply for the
    // dedup predicate. Concurrency: the CLAIM ITSELF is the mutex — the
    // ON CONFLICT DO NOTHING ... RETURNING insert is an atomic per-phone
    // test-and-set, so two concurrent POSTs can both pass the history
    // check but exactly one wins the claim row and sends; the loser
    // skips. No transaction and no advisory lock, so no handler ever
    // holds one pool connection while waiting on a second (that shape
    // deadlocks the pool under a burst). Fails CLOSED: any error in the
    // check or claim path skips the send — a missed greeting beats
    // texting a customer twice. Later inbound replies are still
    // classified by server/services/lead-intake.js. Edit copy in the
    // admin UI.
    try {
      if (await hasPriorLeadAutoReply(phoneFormatted)) {
        logger.info(`[lead-webhook] Auto-reply skipped for customer ${customer.id}: already sent once to this phone`);
      } else {
        // Render BEFORE claiming: a template failure claims nothing and
        // the phone stays re-armed.
        const replyMsg = await renderRequiredSmsTemplate(
          'lead_auto_reply_biz',
          { first_name: firstName },
          { workflow: 'lead_webhook_auto_reply', entity_type: 'customer', entity_id: customer.id }
        );

        // CLAIM-BEFORE-SEND, committed (autocommit) before the Twilio
        // call: from this point there is no instant where the customer
        // can have received the menu without durable evidence — a crash
        // anywhere after Twilio's accept leaves the claim in place and
        // the guard stays fail-closed. RETURNING distinguishes winning
        // the claim ([row]) from losing to a concurrent request or an
        // existing row ([]). An unresolved claim (twilio_sid null)
        // suppresses future sends by design — delete the
        // lead_auto_reply_sends row to re-arm that phone.
        const phoneDigits = String(phoneFormatted).slice(-10);
        const claim = await db('lead_auto_reply_sends')
          .insert({ phone_digits: phoneDigits, customer_id: customer.id, twilio_sid: null })
          .onConflict('phone_digits')
          .ignore()
          .returning('phone_digits');

        if (claim.length === 0) {
          logger.info(`[lead-webhook] Auto-reply skipped for customer ${customer.id}: claim already held for this phone`);
        } else {
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
          // Send-window hold: the menu is the lead's entry into the intake
          // state machine (lead_intake_status seeds 'awaiting_service'
          // below), so a dropped auto-reply strands intake for a night
          // form-fill. Requeue on the scheduled-SMS rail — the executor
          // sends it at 8:00 AM with bounded retries — and KEEP the
          // unresolved claim (twilio_sid null): the queued row now owns
          // this phone's one menu, and the fail-closed once-ever guard
          // must not re-arm while it's pending. from_phone pins the
          // location line already resolved for this lead. On an enqueue
          // failure, fall through to normal claim settlement (the hold is
          // deterministic no-delivery → claim released, a re-submit
          // re-arms).
          let heldQueued = false;
          if (!smsResult.sent
            && smsResult.code === 'QUIET_HOURS_HOLD'
            && smsResult.deferred
            && smsResult.nextAllowedAt) {
            try {
              await db('sms_log').insert({
                customer_id: customer.id,
                direction: 'outbound',
                from_phone: TWILIO_NUMBERS.getOutboundNumber(location.id),
                to_phone: phoneFormatted,
                message_body: replyMsg,
                status: 'scheduled',
                scheduled_for: new Date(smsResult.nextAllowedAt),
                message_type: 'auto_reply',
                metadata: JSON.stringify({
                  entry_point: 'lead_webhook_auto_reply_deferred',
                  lead_source: leadSource.source,
                  original_block_code: smsResult.code,
                  refresh_customer_phone: true,
                  // The executor settles the once-ever claim from this key:
                  // real provider sid → stamp; suppressed/terminal → delete
                  // the null-sid claim so a later form submission re-arms.
                  lead_auto_reply_phone_digits: phoneDigits,
                }),
              });
              heldQueued = true;
              logger.info(`[lead-webhook] Auto-reply for customer ${customer.id} held outside the 8AM-8PM ET send window — queued for ${smsResult.nextAllowedAt}`);
            } catch (queueErr) {
              logger.error(`[lead-webhook] Held auto-reply requeue failed for customer ${customer.id}: ${queueErr.message}`);
            }
          }
          if (!heldQueued) {
            await resolveLeadAutoReplyClaim(phoneDigits, smsResult);
          }
        }
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
    // True when this submission attached to an existing call-pipeline lead
    // (via the voicemail text-back prefill token OR the phone-match fallback)
    // instead of inserting a fresh leads row. attachedVia records which mode
    // ('prefill' | 'phone') — the attribution block below treats them
    // differently when the call side can't record a funnel row.
    let attachedCallLead = false;
    let attachedVia = null;
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
      let attached = await attachVoicemailPrefillLead({
        body,
        fields: buildPrefillAttachFields(),
        webhookStage,
      });
      if (attached) {
        attachedVia = 'prefill';
      } else {
        // Token-less fallback: a prospect who left a voicemail but never
        // clicked the text-back link (found the main-site form on their own)
        // arrives here with no prefill token — match their open call-pipeline
        // lead by phone instead of minting a duplicate row next to it.
        attached = await attachOpenCallLeadByPhone({
          phoneFormatted,
          typedFirstName: firstName,
          resolvedCustomerFirstName: customer?.first_name,
          fields: buildPrefillAttachFields(),
          webhookStage,
        });
        if (attached) attachedVia = 'phone';
      }
      if (attached) {
        leadRecord = attached;
        attachedCallLead = true;
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
          anon_id: anonId || null,
          is_residential: true,
        }).returning('*');
        leadRecord = newLead;
      }
    } catch (leadErr) {
      logger.error(`Lead record creation failed: ${leadErr.message}`);
    }

    // Ask-the-customer loop (GATE_ESTIMATE_CLARIFY_ASKS): a blocked
    // readiness verdict carries the machine-readable missing items — park
    // an approval-gated clarifying SMS so the question goes out only on the
    // owner's click. 'disabled' (global automation gate off) never asks.
    if (estimateAutomationReadiness?.status === 'blocked'
      && (estimateAutomationReadiness.missing || []).length) {
      try {
        const { parkClarifyAsk } = require('../services/estimate-clarify-asks');
        const clarifyMissing = estimateAutomationReadiness.missing;
        const parkedAsk = await parkClarifyAsk({
          missing: clarifyMissing,
          phone: phoneFormatted,
          firstName,
          customerId: customer?.id || null,
          leadId: leadRecord?.id || null,
          estimateId: createdEstimateId,
          source: 'lead_webhook_blocked',
          // Self-submitted on Waves' quote form — the same basis the form's
          // own SMS auto-reply already sends under.
          channelProvenance: 'web_form',
        });
        // Address-only ask alignment: the webhook seeded
        // lead_intake_status='awaiting_service' above, but this form already
        // carries a concrete service — a customer answering the address
        // question would hit the service classifier and be dropped. Advance
        // the machine to awaiting_address ONLY when a usable ask actually
        // exists (parked, merged, or cooldown-deduped against a live one) —
        // an internal park error means no SMS is coming, and moving the
        // state then would strand the reply. The SUBMITTED service label is
        // stored as-is: the readiness gate already certified it concrete,
        // and the intake shell's SERVICE_LABEL map falls back to the raw
        // label for non-core services (Mosquito Control, Termite …) — a
        // coarse pest/lawn re-bucket would erase what they asked for.
        // Guarded UPDATE: only from the state this webhook just seeded.
        // A live ADDRESS ask must actually exist: parked/merged/deduped
        // outcomes carry `covers` — a cooldown against an unrelated
        // service-only ask must not move the state.
        const askExists = (parkedAsk?.parked === true
          || ['merged_into_open_clarify', 'open_or_recent_clarify'].includes(parkedAsk?.skipped))
          && Array.isArray(parkedAsk?.covers)
          && parkedAsk.covers.includes('street_address');
        if (askExists
          && !clarifyMissing.includes('specific_service')
          && customer?.id) {
          await db('customers')
            .where({ id: customer.id, lead_intake_status: 'awaiting_service' })
            .update({
              lead_intake_status: 'awaiting_address',
              // varchar(32) column — an oversized label would throw AFTER
              // the ask parked and strand the customer in awaiting_service.
              lead_service_interest: String(serviceInterest || '').slice(0, 32),
            });
        }
      } catch (askErr) {
        logger.error(`Lead clarify ask failed: ${askErr.message}`);
      }
    }

    // Push + bell notification for admins. Deep-links the LEAD row; if lead
    // creation failed the customer id keeps a (degraded) bell rather than none.
    let leadBellDelivered = false;
    try {
      const { triggerNotification } = require('../services/notification-triggers');
      const stats = await triggerNotification('new_lead', {
        name: `${firstName || ''} ${lastName || ''}`.trim() || phoneFormatted,
        source: leadSource.detail || leadSource.source,
        zip: customer.zip,
        service: serviceInterest || null,
        leadId: leadRecord?.id || customer.id,
      });
      // suppressed counts as HANDLED (internal test customer) — the legacy
      // SMS fallback must not re-create the alert the suppression removed.
      leadBellDelivered = Boolean(stats && !stats.error &&
        (stats.suppressed || stats.bellWritten || Number(stats.push?.sent || 0) > 0));
    } catch (e) { logger.error(`[notifications] new_lead trigger failed: ${e.message}`); }

    // Last-resort delivery only: the legacy SMS becomes an
    // internal_admin_alert bell for owner phones, so sending it alongside a
    // delivered new_lead bell raised two notifications for the same lead.
    if (legacyLeadSmsWanted && !leadBellDelivered) {
      try {
        await TwilioService.sendSMS(ADAM_CELL,
          `New lead!\n${firstName} ${lastName}\nPhone: ${phoneFormatted}\nAddress: ${fullAddress || 'No address'}${additionalPropertiesNote ? `\n${additionalPropertiesNote}` : ''}\nSource: ${leadSource.detail || leadSource.source}${utmCampaign ? '\nCampaign: ' + utmCampaign : ''}`,
          { messageType: 'internal_alert' }
        );
      } catch (smsErr) {
        logger.error(`[lead-webhook] fallback lead alert SMS failed: ${smsErr.message}`);
      }
    }

    // Fire-and-forget AI triage
    if (leadRecord) {
      const messageText = body.message || body['Message'] || serviceInterest || findField(body, /service|help|pest|lawn|message/i) || '';
      const triageMessage = [messageText, additionalPropertiesNote].filter(Boolean).join('\n');
      aiTriageLead({ name: `${firstName} ${lastName}`, phone: phoneFormatted, message: triageMessage, address: fullAddress, pageUrl, formName })
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
              // one-shot stamp the attach just preserved. The replace branch
              // still carries forward additional_properties captured at intake
              // (jsonb_strip_nulls drops the key when the row had none) so the
              // triage snapshot can't erase the extra-property ask.
              updates.extracted_data = attachedCallLead
                ? db.raw("COALESCE(extracted_data, '{}'::jsonb) || ?::jsonb", [JSON.stringify(triageResult.extractedData)])
                : db.raw(
                  "jsonb_strip_nulls(jsonb_build_object('additional_properties', COALESCE(extracted_data, '{}'::jsonb)->'additional_properties')) || ?::jsonb",
                  [JSON.stringify(triageResult.extractedData)]
                );
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
                // Structured commercial flags must survive the triage
                // re-evaluation too, or a concrete generic service label
                // replaces the blocked snapshot with an auto-sendable
                // residential one (codex r46 P1).
                body,
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
        message: [messageText, additionalPropertiesNote].filter(Boolean).join('\n'),
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
    // A lead ATTACHED to an existing call-pipeline row (prefill token or
    // phone match): its funnel row belongs to the CALL source (the
    // tracking number the prospect dialed) — a web-channel row here would win
    // the unique lead_id slot and permanently misattribute a paid/GBP
    // voicemail to the website. And because the call processor's attribution
    // is customerId-gated while voicemail recovery leads are customer-less at
    // call time, no call row exists yet either: BACKFILL it now that this
    // handler has linked the customer (lead_id dedupe + first-touch inside).
    try {
      let needWebRow = !attachedCallLead;
      if (attachedCallLead) {
        const backfill = await backfillCallLeadAttribution({
          leadId: leadRecord?.id || null,
          customerId: customer.id,
          serviceInterest: serviceInterest || null,
        });
        // Phone-match mode only: when the call side can NEVER record a row
        // (untracked number — no lead_source_id / source gone / no channel
        // mapping), fall back to the tracked web row this submission carries
        // so the funnel doesn't lose it entirely. 'bridge_target' stays
        // suppressed (the unclaimed-bridge sweep owns those) and transient
        // errors stay conservative. Token attach keeps its long-standing
        // contract unchanged: call-source-or-nothing.
        needWebRow = attachedVia === 'phone'
          && backfill?.recorded !== true
          && ['no_lead_source', 'source_not_found', 'no_channel'].includes(backfill?.reason);
      }
      if (needWebRow) {
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
    const attached = await applyLeadAttachUpdate(prefillLeadId, fields, webhookStage);
    if (attached) {
      logger.info(`[lead-webhook] attached form submission to existing lead ${prefillLeadId} via prefill token`);
    }
    return attached;
  } catch (attachErr) {
    logger.warn(`[lead-webhook] prefill attach failed — caller falls back to its default path: ${attachErr.message}`);
    return null;
  }
}

// Shared attach UPDATE for both attach modes (prefill token + phone match).
// Atomic: the open-lead guards live in the WHERE so a lead the office closed
// between lookup and update never re-attaches. `extraWhere` lets the phone-
// match path re-check ITS candidate guards (open-status set, ownership, name)
// in the same statement — a concurrent claim between its SELECT and this
// UPDATE must miss, not overwrite. Returns the row or null.
async function applyLeadAttachUpdate(leadId, fields, webhookStage, extraWhere) {
  const query = db('leads')
    .where({ id: leadId })
    .whereNotIn('status', ['won', 'lost', 'disqualified', 'duplicate'])
    .whereNull('converted_at');
  if (extraWhere) extraWhere(query);
  const [attached] = await query
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
  return attached || null;
}

// Phone-match fallback attach. The prefill token only exists when the
// prospect clicks the voicemail text-back SMS link — one who finds a form on
// their own (e.g. voicemail to a GBP tracking number, then the main-site
// quote form) submits token-less, and the webhook minted a duplicate lead row
// next to their open call-pipeline lead. Mirror the call side
// (lead-from-extraction reuses the newest lead on the same number): attach
// the form to the newest OPEN call-channel lead matching the phone.
//
// Guards, tightest-first:
//  - call-channel leads only — form/SMS dups are owned by the customer-dedup
//    and duplicate-submission logic upstream, never by this attach;
//  - OPEN statuses only (the shared positive-membership set from
//    lead-statuses.js) — unlike the token path, a bare phone match carries
//    no proof the prospect is responding to THAT lead, so a lead the office
//    closed as 'unresponsive' months ago stays closed and the form gets a
//    fresh row with fresh attribution. The reopen CASE in the shared UPDATE
//    is intentionally unreachable from this path;
//  - unambiguous number only, on BOTH sides: 2+ open call leads on the
//    number (the call pipeline splits household members into separate rows)
//    or 2+ customer rows carrying it (multi-property households) → skip —
//    newest-wins / customers.first() picks are arbitrary and could pin the
//    voicemail's call attribution on the wrong person or account (mirrors
//    findCustomerByPhone's never-auto-link-ambiguous rule);
//  - never cross-link: a candidate already linked to a DIFFERENT customer is
//    someone else's lead (shared line) — skip;
//  - first-name conflict guard (mirrors lead-from-extraction.nameConflicts):
//    a first name that differs from the lead's captured first name means a
//    different household member — skip. The comparator is the TYPED name
//    when present, else the RESOLVED customer's name: a nameless form from
//    an existing customer must not claim a call lead the pipeline left
//    customer-less precisely because its captured name conflicted with that
//    customer (Miguel's voicemail on Dana's phone). The webhook's 'Unknown'
//    placeholder never counts as a name on either side.
// EVERY candidate predicate (phone, call-channel, open-status, not-deleted,
// ownership, name) is RE-CHECKED atomically inside the shared UPDATE's
// WHERE — a concurrent submission or an office edit between the candidate
// SELECT and the UPDATE makes the UPDATE miss (→ null → the caller inserts
// a fresh lead) instead of silently overwriting the claim.
//
// Unlike the token attach (typed-wins wholesale — the tokenized form was
// prefilled FROM the lead), this fallback only overwrites with NON-EMPTY
// typed values: a bare main-site form must not blank out a name/email the
// call extraction already captured.
async function attachOpenCallLeadByPhone({ phoneFormatted, typedFirstName, resolvedCustomerFirstName, fields, webhookStage }) {
  const digits = String(phoneFormatted || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return null;
  try {
    const candidates = await db('leads')
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits])
      .where({ first_contact_channel: 'call' })
      .whereIn('status', OPEN_LEAD_STATUSES)
      .whereNull('converted_at')
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .limit(2);
    const [candidate, rival] = candidates || [];
    if (!candidate) return null;
    if (rival) {
      // Two+ live call leads on one number = the call pipeline already split
      // household members on a shared line (its name-conflict guard mints
      // separate rows). Newest-wins could hand this form to the wrong
      // person's voicemail — ambiguous phone history never auto-attaches.
      logger.info(`[lead-webhook] phone-match: multiple open call leads share the number; not attaching`);
      return null;
    }

    const phoneCustomers = await db('customers')
      .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits])
      .whereNull('deleted_at')
      .limit(2);
    if (phoneCustomers.length > 1) {
      logger.info(`[lead-webhook] phone-match lead ${candidate.id}: ${phoneCustomers.length}+ customers share the number; not attaching`);
      return null;
    }

    if (candidate.customer_id && fields.customer_id && candidate.customer_id !== fields.customer_id) {
      logger.info(`[lead-webhook] phone-match lead ${candidate.id} belongs to another customer; not attaching`);
      return null;
    }

    const normName = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const typed = typedFirstName === 'Unknown' ? '' : normName(typedFirstName);
    const resolved = resolvedCustomerFirstName === 'Unknown' ? '' : normName(resolvedCustomerFirstName);
    const nameComparator = typed || resolved;
    const captured = normName(candidate.first_name);
    if (nameComparator && captured && nameComparator !== captured) {
      logger.info(`[lead-webhook] phone-match lead ${candidate.id} first name conflicts with the ${typed ? 'typed' : "resolved customer's"} name; not attaching`);
      return null;
    }

    const merged = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined || value === '') continue;
      merged[key] = value;
    }
    if (typedFirstName === 'Unknown') delete merged.first_name;

    const attached = await applyLeadAttachUpdate(candidate.id, merged, webhookStage, (query) => {
      query.whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [digits]);
      query.where({ first_contact_channel: 'call' });
      query.whereIn('status', OPEN_LEAD_STATUSES);
      query.whereNull('deleted_at');
      if (fields.customer_id) {
        query.where(function ownershipGuard() {
          this.whereNull('customer_id').orWhere('customer_id', fields.customer_id);
        });
      }
      if (nameComparator) {
        // SQL twin of normName: attach only while the captured first name is
        // still absent or still normalizes to the comparator (typed name, or
        // the resolved customer's name on a nameless form).
        query.whereRaw(
          "(COALESCE(first_name, '') = '' OR lower(regexp_replace(first_name, '[^a-zA-Z0-9]', '', 'g')) = ?)",
          [nameComparator]
        );
      }
    });
    if (attached) {
      logger.info(`[lead-webhook] attached form submission to existing lead ${candidate.id} via phone match`);
    }
    return attached;
  } catch (attachErr) {
    logger.warn(`[lead-webhook] phone-match attach failed — caller falls back to its default path: ${attachErr.message}`);
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
    // Anonymous experiment unit id (waves_exp_uid) — joins the lead to any A/B
    // assignments in experiment_exposures. Validated (not just truncated): it
    // must satisfy the exposure intake's unit-id contract or the join is dead
    // weight. null (not '') when absent/malformed.
    anonId: sanitizeAnonUnitId(body.anon_id || attr.anon_id),
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
    line2: body.address_line2 || body.addressLine2 || body.unit,
    city: body.city,
    state: body.state,
    zip: body.zip,
    placeId: body.google_place_id || body.googlePlaceId,
    components: body.address_components || body.addressComponents,
  });
  const address = normalizedAddress.line1 || rawAddress;
  const fullAddress = normalizedAddress.fullAddress || rawAddress;
  // Optional extra properties the visitor wants covered ("also my rental next
  // door"). Capture-only — never priced; each becomes a manual follow-up quote.
  const additionalProperties = normalizeAdditionalProperties(body, fullAddress);
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
    additionalProperties,
    ...attribution,
    formId: body.form_id || body['Form Id'] || '',
    formName: body.form_name || body['Form Name'] || body.source || '',
    firstName,
    lastName,
    serviceInterest,
    leadSource,
    // Free-prose message body — the readiness gate's commercial-signal scan
    // reads it (a residential form whose own words describe a commercial
    // premises must park, not auto-price).
    // EXACT prose key names only — a substring pattern swept attribution
    // and address metadata ('lead_source_detail', an address-detail field)
    // into the commercial-signal scan, where "Commercial Pest Control
    // campaign" wrongly blocked a residential lead (codex r8 P2).
    message: firstNonEmpty(
      body.message,
      body['Message'],
      findField(body, /^(?:message|comments?|notes?|description|details)$/i),
    ),
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

/**
 * The lead auto-reply (lead_auto_reply_biz) is sent AT MOST ONCE per
 * person, ever (owner ruling 2026-08-05).
 *
 * Audit leg: messaging_audit_log rows with
 * entry_point='lead_webhook_auto_reply' — this route is the ONLY sender
 * of the menu template, so the entry point identifies it exactly
 * (sms_log.message_type='auto_reply' is shared with the public-quote
 * booking invite and can't distinguish templates). Only rows with a
 * non-null sent_at count: blocked and provider-failed attempts never
 * reached the customer and must not suppress a real first send.
 * to_hash is sha256 of the wrapper-normalized recipient
 * (+1XXXXXXXXXX for NANP — see normalizeRecipient in
 * services/messaging/send-customer-message.js and sha256 in
 * services/messaging/audit.js); phoneFormatted here is built the same
 * way, so the hashes line up.
 *
 * Legacy leg: 36 menu sends predate the first audit row
 * (2026-05-04T11:16:45Z). For rows STRICTLY BEFORE that instant we
 * fall back to the old sms_log signature. The bound is a fixed UTC
 * instant (not an ET business-day window), so comparing against the
 * raw timestamptz is correct. Post-cutover sms_log rows are never
 * consulted — that's what keeps quote-wizard sends from
 * false-positively suppressing the menu.
 *
 * Durable marker: lead_auto_reply_sends is a CLAIM-BEFORE-SEND record —
 * this route commits it (an atomic ON CONFLICT test-and-set that also
 * serializes concurrent requests) before calling Twilio, confirms it
 * with the real SID on success, and releases it only on PROVABLY
 * undelivered outcomes (see resolveLeadAutoReplyClaim). There is
 * therefore no instant where a delivered menu lacks durable evidence:
 * persistAudit failing (best-effort, {id:null}) or a crash between
 * Twilio's accept and any later write both leave the claim in place.
 * An unresolved claim (null twilio_sid) suppresses by design — fail
 * closed; delete the row to re-arm the phone. Checked first — it is
 * the only leg this route fully controls.
 *
 * The audit leg additionally requires a REAL Twilio SID (SM/MM prefix):
 * gate-blocked / template-disabled / owner-silence sends record
 * sent_at with a sentinel provider_message_id even though no text
 * reached the customer — those must not suppress a later real send.
 * All 167 historical sent rows for this entry point carry real SIDs
 * (prod-verified), so the filter changes nothing for genuine sends.
 *
 * FAIL CLOSED: if any dedup query errors, report "already sent" so
 * the caller skips the send. A missed greeting is recoverable (the
 * operator lead alert still fires); texting a customer the same
 * automated message twice is the failure this guard exists to prevent.
 */
const LEAD_AUTO_REPLY_AUDIT_CUTOVER = new Date('2026-05-04T11:16:45Z');
const REAL_TWILIO_SID_RE = /^(SM|MM)/;

/**
 * Settle a pre-send lead-auto-reply claim after the send attempt.
 *
 *  - Real Twilio SID → confirm the claim (stamp twilio_sid).
 *  - DETERMINISTIC no-delivery → release the claim so a later
 *    submission can greet the customer. Deterministic means the text
 *    provably never reached the carrier path:
 *      · wrapper policy block (blocked === true — provider never called)
 *      · gate/template/owner sentinel sid (sent:true without a real SID)
 *      · terminal provider failure (Twilio definitively rejected)
 *  - AMBIGUOUS outcomes KEEP the claim (fail closed): a retryable
 *    transport error (timeout, socket reset) can occur AFTER Twilio
 *    accepted the message, so releasing on those could let a later
 *    form send the menu a second time to a customer who received the
 *    first one. Same for unknown/absent result shapes.
 *  - If the release itself fails we keep the claim (fail closed) and
 *    log — a suppressed greeting is recoverable, a duplicate is not.
 *
 * Never throws: claim settlement must not mask the original send error.
 */
async function resolveLeadAutoReplyClaim(phoneDigits, smsResult, dbc = db) {
  try {
    const sid = smsResult && smsResult.sent ? String(smsResult.providerMessageId || '') : '';
    if (REAL_TWILIO_SID_RE.test(sid)) {
      await dbc('lead_auto_reply_sends').where({ phone_digits: phoneDigits }).update({ twilio_sid: sid });
      return;
    }
    const deterministicNoDelivery = !!smsResult && (
      smsResult.blocked === true
      || smsResult.sent === true // sentinel sid: gate-blocked / template-disabled / owner-silence
      || (smsResult.sent === false && smsResult.terminal === true)
    );
    if (deterministicNoDelivery) {
      await dbc('lead_auto_reply_sends').where({ phone_digits: phoneDigits }).whereNull('twilio_sid').del();
    } else {
      logger.warn(`[lead-webhook] auto-reply outcome ambiguous (retryable/unknown) — keeping claim, fail closed`);
    }
  } catch (settleErr) {
    logger.warn(`[lead-webhook] auto-reply claim settlement failed (claim stays, fail closed): ${settleErr.message}`);
  }
}

async function hasPriorLeadAutoReply(phoneFormatted, dbc = db) {
  try {
    const markerHit = await dbc('lead_auto_reply_sends')
      .where({ phone_digits: String(phoneFormatted).slice(-10) })
      .first();
    if (markerHit) return true;

    const toHash = crypto.createHash('sha256').update(String(phoneFormatted || ''), 'utf8').digest('hex');
    const auditHit = await dbc('messaging_audit_log')
      .where({ entry_point: 'lead_webhook_auto_reply', to_hash: toHash })
      .whereNotNull('sent_at')
      .whereRaw("provider_message_id ~ '^(SM|MM)'")
      .first();
    if (auditHit) return true;

    const legacyHit = await dbc('sms_log')
      .where({ direction: 'outbound', message_type: 'auto_reply' })
      .where('created_at', '<', LEAD_AUTO_REPLY_AUDIT_CUTOVER)
      .whereRaw("RIGHT(regexp_replace(COALESCE(to_phone, ''), '[^0-9]', '', 'g'), 10) = ?", [String(phoneFormatted).slice(-10)])
      .first();
    return !!legacyHit;
  } catch (dedupErr) {
    logger.warn(`[lead-webhook] auto-reply dedup check failed — skipping send (fail closed): ${dedupErr.message}`);
    return true;
  }
}

function cleanPhone(value) {
  if (!value) return '';
  return String(value).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
}

// determineLeadSource lives in services/lead-source-classify.js (extracted
// verbatim — see the import above). Re-exported through `_test` below so the
// existing test surface and callers are unchanged.

// Updates for an EXISTING customers row matched by the public lead webhook.
// The match is by submitted phone alone from an unauthenticated form — NO
// proven identity — so contact and location fields (email, address lines,
// city/state/zip) are never backfilled here: anyone who knows a customer's
// phone could otherwise point that customer's email at their own inbox and
// receive invoices, pay links and reports. Only attribution / last-contact /
// intake-status fields land. Existing customers return before the leads
// insert, so the submitted contact details reach staff via the 'Form
// submission (existing customer)' interaction note's metadata instead.
// Same rule as /public/quote/calculate.
function buildExistingCustomerLeadUpdates({ existing, leadSource }) {
  const updates = { last_contact_date: new Date(), last_contact_type: 'form_submission' };
  if (!existing.lead_source) updates.lead_source = leadSource.source;
  if (!existing.lead_source_detail) updates.lead_source_detail = leadSource.detail;
  if (existing.lead_intake_status) updates.lead_intake_status = null;
  return updates;
}

module.exports = router;
module.exports._test = {
  buildExistingCustomerLeadUpdates,
  attachVoicemailPrefillLead,
  attachOpenCallLeadByPhone,
  scrubLeadAlertProviderError,
  markLeadAlertCallLogFailed,
  buildLeadWebhookIntake,
  getLeadWebhookAttribution,
  normalizeLeadServiceInterest,
  formatServiceInterestForFrequency,
  serviceInterestUpdateFromTriage,
  shouldApplyTriageServiceInterest,
  shouldRunLeadAcquisition,
  hasPriorLeadAutoReply,
  resolveLeadAutoReplyClaim,
  applyLeadEstimateAutomationGate,
  determineLeadSource,
  isHoneypotTripped,
};
