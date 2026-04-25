const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const PipelineManager = require('../services/pipeline-manager');
const LeadScorer = require('../services/lead-scorer');
const { resolveLocation } = require('../config/locations');
const logger = require('../services/logger');

const { aiTriageLead } = require('../services/lead-triage');
const { etDateString } = require('../utils/datetime-et');
const { isEnabled } = require('../config/feature-gates');
const TWILIO_NUMBERS = require('../config/twilio-numbers');

function capitalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bMc(\w)/g, (_, c) => 'Mc' + c.toUpperCase())
    .replace(/\bO'(\w)/g, (_, c) => "O'" + c.toUpperCase());
}
const leadAttribution = require('../services/lead-attribution');

const WAVES_ADMIN_PHONE = '+19413187612';
// Adam's personal cell for new-lead alerts. WAVES_ADMIN_PHONE is the HQ Pest
// line used elsewhere for notifications; new leads should ring Adam directly.
const ADAM_CELL = '+19415993489';

// POST /api/webhooks/lead — website lead-form submission webhook
router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // Map raw form field names (garbled → clean)
    const rawName = body.first_name || body['First Things First Whats Your Name'] || body.name || body.full_name || findField(body, /name/i) || '';
    const email = body.email || body['Whats Your Best Email'] || findField(body, /email/i) || '';
    const rawPhone = body.phone || body['Got A Number We Can Call Or Text'] || findField(body, /number|phone|call|text/i) || '';
    const address = body.address || body['And Whats Your Address'] || findField(body, /address/i) || '';

    const pageUrl = body.page_url || body['Page Url'] || body.referrer || '';
    const landingUrl = body.landing_url || body['Landing Url'] || '';
    const utmSource = body.utm_source || body['Utm Source'] || '';
    const utmMedium = body.utm_medium || body['Utm Medium'] || '';
    const utmCampaign = body.utm_campaign || body['Utm Campaign'] || '';
    const utmContent = body.utm_content || body['Utm Content'] || '';
    const utmTerm = body.utm_term || body['Utm Term'] || '';
    const formId = body.form_id || body['Form Id'] || '';
    const formName = body.form_name || body['Form Name'] || '';
    const gclid = body.gclid || body['Gclid'] || body.GCLID || '';

    // Parse name
    const nameParts = rawName.trim().split(/\s+/);
    const firstName = capitalizeName(nameParts[0] || 'Unknown');
    const lastName = capitalizeName(nameParts.slice(1).join(' ') || '');

    // Clean phone
    const phone = cleanPhone(rawPhone);
    if (!phone || phone.length < 10) {
      return res.status(400).json({ error: 'Valid phone number required' });
    }
    const phoneFormatted = '+1' + phone.slice(-10);

    // Determine lead source
    const leadSource = determineLeadSource(pageUrl, landingUrl, utmSource, utmMedium, utmCampaign, utmContent);

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
        sourceRecord = await db('lead_sources')
          .where('source_type', 'website_organic')
          .where('channel', 'google')
          .where('is_active', true)
          .first();
      }
      if (!sourceRecord && leadSource.source === 'waves_website') {
        sourceRecord = await db('lead_sources')
          .where('domain', 'like', '%wavespestcontrol%')
          .where('is_active', true)
          .first();
      }
      if (!sourceRecord && leadSource.source === 'nextdoor') {
        sourceRecord = await db('lead_sources')
          .where('source_type', 'marketplace')
          .where('channel', 'social_organic')
          .where('is_active', true)
          .first();
      }
      if (!sourceRecord && leadSource.source === 'facebook') {
        sourceRecord = await db('lead_sources')
          .whereRaw("LOWER(name) LIKE '%facebook%'")
          .where('is_active', true)
          .first();
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
    const location = resolveLocation(leadSource.area || '');

    if (existing) {
      customer = existing;
      // Update attribution if missing
      const updates = { last_contact_date: new Date(), last_contact_type: 'form_submission' };
      if (!existing.lead_source) updates.lead_source = leadSource.source;
      if (!existing.lead_source_detail) updates.lead_source_detail = leadSource.detail;
      if (!existing.email && email) updates.email = email;
      if (!existing.address_line1 && address) updates.address_line1 = address;

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
        address_line1: address || '', city: leadSource.area || '', state: 'FL', zip: '',
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
        body: `Form: ${formName || formId || 'unknown'}. Page: ${pageUrl || 'unknown'}. Address: ${address || 'not provided'}.`,
        metadata: JSON.stringify({ leadSource, formId }),
      });

      await PipelineManager.onEvent(customer.id, 'lead_created');
      await LeadScorer.calculateScore(customer.id);
    }

    if (isDuplicateSubmission) {
      // Customer record + interaction note are written above so we still have an
      // audit trail. Skip everything below (call, SMS, estimate, triage, agent)
      // because we already fired all of that on the first submission.
      return res.json({ success: true, customerId: customer.id, deduped: true });
    }

    // Push + bell notification for admins
    try {
      const { triggerNotification } = require('../services/notification-triggers');
      await triggerNotification('new_lead', {
        name: `${firstName || ''} ${lastName || ''}`.trim() || phoneFormatted,
        source: leadSource.detail || leadSource.source,
        zip: customer.zip,
        leadId: customer.id,
      });
    } catch (e) { logger.error(`[notifications] new_lead trigger failed: ${e.message}`); }

    // Notify Adam — during business hours (8AM-8PM ET) trigger a call, otherwise SMS
    const now = new Date();
    const etHour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }));
    const isDuringHours = etHour >= 8 && etHour < 20;
    let callConnected = false;

    try {
      const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      if (isDuringHours && twilioClient) {
        // During business hours: ring Adam's cell with a voice announcement of
        // the lead (no Press-1-to-connect, no auto-dialing the lead). Adam calls
        // back manually from the admin portal or directly.
        try {
          const domain = process.env.SERVER_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || 'portal.wavespestcontrol.com';
          const fromNumber = '+19412972606';
          const autoBridge = isEnabled('leadAutoBridge');

          if (autoBridge) {
            // Press-1-to-connect auto-bridge. Create call_log row FIRST so
            // outbound-admin-prompt / outbound-connect can update it without
            // racing Twilio's webhook fire (2–5s after create()).
            const bridgeCallerId = TWILIO_NUMBERS.locations['lakewood-ranch'].number;
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
          logger.error(`[lead-webhook] Lead alert call failed, falling back to SMS: ${callErr.message}`);
          await TwilioService.sendSMS(ADAM_CELL,
            `🔔 New lead!\n${firstName} ${lastName}\n📞 ${phoneFormatted}\n📍 ${address || 'No address'}\n🌐 ${leadSource.detail || leadSource.source}\n${utmCampaign ? '📊 Campaign: ' + utmCampaign : ''}`,
            { messageType: 'internal_alert' }
          );
        }
      } else {
        // After hours: SMS alert only
        await TwilioService.sendSMS(ADAM_CELL,
          `🔔 New lead!\n${firstName} ${lastName}\n📞 ${phoneFormatted}\n📍 ${address || 'No address'}\n🌐 ${leadSource.detail || leadSource.source}\n${utmCampaign ? '📊 Campaign: ' + utmCampaign : ''}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (e) { logger.error(`Lead alert failed: ${e.message}`); }

    // Auto-reply to lead — always send (whether call connected or not).
    // Pull from sms_templates (lead_auto_reply_biz / lead_auto_reply_after_hours)
    // so Virginia can edit the copy in the admin UI without a deploy. The
    // hardcoded strings below are the fallback if a template row is missing
    // or disabled — keep them in sync with the seeded defaults.
    try {
      const smsTemplatesRouter = require('./admin-sms-templates');
      const templateKey = isDuringHours ? 'lead_auto_reply_biz' : 'lead_auto_reply_after_hours';
      const fallback = isDuringHours
        ? `Hello ${firstName}! Thanks for reaching out to Waves! What are you interested in — Pest Control, Lawn Care, or a One-Time Service? Reply and we'll get you a quote right away.`
        : `Hello ${firstName}! Thanks for reaching out to Waves! What are you interested in — Pest Control, Lawn Care, or a One-Time Service? We'll follow up first thing in the morning with a custom quote.`;
      let replyMsg = fallback;
      try {
        if (typeof smsTemplatesRouter.getTemplate === 'function') {
          const rendered = await smsTemplatesRouter.getTemplate(templateKey, { first_name: firstName });
          if (rendered) replyMsg = rendered;
        }
      } catch (tErr) { logger.warn(`[lead-webhook] template render failed, using fallback: ${tErr.message}`); }

      await TwilioService.sendSMS(phoneFormatted, replyMsg,
        { customerId: customer.id, messageType: 'auto_reply', customerLocationId: location.id }
      );

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
        logger.info(`[lead-webhook] enrolled ${email} in new_lead: ${JSON.stringify(r)}`);
      }
    } catch (e) { logger.error(`Lead enroll failed: ${e.message}`); }

    // Create estimate/quote record so it appears in Pipeline → Quotes tab
    try {
      const serviceInterest = body.service_interest || body['What Can We Help You With'] || findField(body, /service|help|pest|lawn/i) || '';
      const crypto = require('crypto');
      const estimateToken = crypto.randomBytes(16).toString('hex');

      await db('estimates').insert({
        customer_id: customer.id,
        customer_name: `${firstName} ${lastName}`,
        customer_phone: phoneFormatted,
        customer_email: email || null,
        address: address || '',
        status: 'draft',
        source: 'lead_webhook',
        service_interest: serviceInterest || null,
        lead_source: leadSource.source,
        lead_source_detail: leadSource.detail,
        token: estimateToken,
        notes: `Form: ${formName || formId || 'unknown'}. Page: ${pageUrl || 'unknown'}.`,
      });
    } catch (estErr) {
      logger.error(`Lead estimate creation failed: ${estErr.message}`);
    }

    // Create leads table record for pipeline tracking
    let leadRecord = null;
    try {
      const serviceInterestField = body.service_interest || body['What Can We Help You With'] || findField(body, /service|help|pest|lawn/i) || '';
      const [newLead] = await db('leads').insert({
        first_name: firstName, last_name: lastName,
        phone: phoneFormatted, email: email || null,
        address: address || '', city: leadSource.area || '',
        lead_source_id: leadSourceId,
        lead_type: 'form_submission',
        service_interest: serviceInterestField || null,
        first_contact_at: new Date(),
        first_contact_channel: 'form',
        status: 'new',
        customer_id: customer.id,
        gclid: gclid || null,
        is_residential: true,
      }).returning('*');
      leadRecord = newLead;
    } catch (leadErr) {
      logger.error(`Lead record creation failed: ${leadErr.message}`);
    }

    // Fire-and-forget AI triage
    if (leadRecord) {
      const messageText = body.message || body['Message'] || body.service_interest || body['What Can We Help You With'] || findField(body, /service|help|pest|lawn|message/i) || '';
      aiTriageLead({ name: `${firstName} ${lastName}`, phone: phoneFormatted, message: messageText, address, pageUrl, formName })
        .then(async (triageResult) => {
          if (!triageResult) return;
          try {
            const updates = {};
            if (triageResult.serviceInterest) updates.service_interest = triageResult.serviceInterest;
            if (triageResult.urgency) updates.urgency = triageResult.urgency;
            if (triageResult.extractedData) updates.extracted_data = JSON.stringify(triageResult.extractedData);
            if (Object.keys(updates).length > 0) {
              updates.updated_at = new Date();
              await db('leads').where('id', leadRecord.id).update(updates);
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
      const messageText = body.message || body['Message'] || body.service_interest || body['What Can We Help You With'] || findField(body, /service|help|pest|lawn|message/i) || '';
      LeadResponseAgent.processLead({
        leadId: leadRecord?.id,
        customerId: customer.id,
        phone: phoneFormatted,
        name: `${firstName} ${lastName}`,
        message: messageText,
        address: address || '',
        city: leadSource.area || '',
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

    // Ad service attribution — track the full funnel from lead onward
    try {
      const serviceInterest = body.service_interest || body['What Can We Help You With'] || findField(body, /service|help|pest|lawn/i) || '';
      await db('ad_service_attribution').insert({
        customer_id: customer.id,
        service_line: inferServiceLine(serviceInterest),
        specific_service: inferSpecificService(serviceInterest),
        service_bucket: inferServiceBucket(serviceInterest),
        lead_date: etDateString(),
        lead_source: leadSource.source,
        lead_source_detail: leadSource.detail,
        gclid: body.gclid || body['Gclid'] || null,
        utm_campaign: utmCampaign,
        utm_term: utmTerm,
        funnel_stage: 'lead',
      });
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
function findField(body, pattern) {
  for (const [key, value] of Object.entries(body)) {
    if (pattern.test(key) && value) return String(value);
  }
  return null;
}

function cleanPhone(value) {
  if (!value) return '';
  return String(value).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
}

function determineLeadSource(pageUrl, landingUrl, utmSource, utmMedium, utmCampaign, utmContent) {
  const url = landingUrl || pageUrl || '';

  // UTM-based attribution (most specific)
  if (utmSource === 'gbp') return { source: 'google_business', detail: `GBP ${utmContent || ''}`, channel: 'organic', area: utmContent };
  if (utmSource === 'google' && utmMedium === 'cpc') return { source: 'google_ads', detail: `Campaign: ${utmCampaign}`, channel: 'paid', area: utmContent };
  if (utmSource === 'facebook' || utmSource === 'fb') return { source: 'facebook', detail: `${utmMedium} — ${utmCampaign}`, channel: utmMedium === 'cpc' ? 'paid' : 'organic' };
  if (utmSource === 'nextdoor') return { source: 'nextdoor', detail: utmCampaign || '', channel: 'social' };

  // Domain-based attribution
  const domains = {
    'bradentonflexterminator.com': { area: 'Bradenton' }, 'bradentonflpestcontrol.com': { area: 'Bradenton' },
    'palmettoexterminator.com': { area: 'Palmetto' }, 'palmettoflpestcontrol.com': { area: 'Palmetto' },
    'parrishexterminator.com': { area: 'Parrish' }, 'parrishpestcontrol.com': { area: 'Parrish' },
    'sarasotaflexterminator.com': { area: 'Sarasota' }, 'sarasotaflpestcontrol.com': { area: 'Sarasota' },
    'veniceexterminator.com': { area: 'Venice' }, 'veniceflpestcontrol.com': { area: 'Venice' },
  };

  for (const [domain, info] of Object.entries(domains)) {
    if (url.includes(domain)) return { source: 'domain_website', detail: domain, channel: 'organic', area: info.area };
  }

  // Waves main site pages
  if (url.includes('wavespestcontrol.com')) {
    const pages = { '/pest-control-bradenton': 'Bradenton', '/pest-control-sarasota': 'Sarasota', '/pest-control-venice': 'Venice', '/pest-control-parrish': 'Parrish', '/pest-control-lakewood': 'Lakewood Ranch', '/lawn-care': null, '/mosquito': null, '/termite': null };
    for (const [path, area] of Object.entries(pages)) {
      if (url.includes(path)) return { source: 'waves_website', detail: `${path.replace('/', '')} page`, channel: 'organic', area };
    }
    return { source: 'waves_website', detail: 'Main site', channel: 'organic' };
  }

  return { source: utmSource || 'website', detail: utmMedium || '', channel: 'unknown' };
}

function inferServiceLine(interest) {
  const t = (interest || '').toLowerCase();
  if (t.includes('lawn') || t.includes('grass') || t.includes('turf')) return 'lawn';
  if (t.includes('mosquito')) return 'mosquito';
  if (t.includes('termite')) return 'termite';
  if (t.includes('rodent') || t.includes('rat') || t.includes('mouse')) return 'rodent';
  if (t.includes('tree') || t.includes('shrub')) return 'tree_shrub';
  if (t.includes('bed bug') || t.includes('exclusion') || t.includes('bora')) return 'specialty';
  return 'pest';
}

function inferSpecificService(interest) {
  const t = (interest || '').toLowerCase();
  if (t.includes('rodent exclusion') || t.includes('rat exclusion')) return 'rodent_exclusion';
  if (t.includes('bed bug')) return 'bed_bug';
  if (t.includes('termite trench')) return 'termite_trenching';
  if (t.includes('termite bait')) return 'termite_bait_station';
  if (t.includes('bora')) return 'bora_care';
  if (t.includes('mosquito')) return 'mosquito_program';
  if (t.includes('flea') || t.includes('tick')) return 'flea_tick';
  if (t.includes('cockroach') || t.includes('roach')) return 'cockroach';
  if (t.includes('wasp') || t.includes('bee')) return 'wasp_bee';
  if (t.includes('lawn plug')) return 'lawn_plugging';
  if (t.includes('top dress')) return 'top_dressing';
  if (t.includes('tree') || t.includes('shrub')) return 'tree_shrub_spray';
  if (t.includes('one-time') || t.includes('one time')) return 'one_time_pest';
  return 'quarterly_pest';
}

function inferServiceBucket(interest) {
  const specific = inferSpecificService(interest);
  const recurring = ['mosquito_program', 'termite_bait_station', 'rodent_bait_station', 'quarterly_pest'];
  const highTicket = ['rodent_exclusion', 'bed_bug', 'termite_trenching', 'bora_care', 'palm_injection'];
  const lawnSeasonal = ['lawn_plugging', 'top_dressing', 'dethatching', 'tree_shrub_spray'];
  if (recurring.includes(specific)) return 'recurring';
  if (highTicket.includes(specific)) return 'high_ticket_specialty';
  if (lawnSeasonal.includes(specific)) return 'lawn_seasonal';
  return 'one_time_entry';
}

module.exports = router;
