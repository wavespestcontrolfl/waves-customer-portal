const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const PipelineManager = require('../services/pipeline-manager');
const LeadScorer = require('../services/lead-scorer');
const { resolveLocation } = require('../config/locations');
const logger = require('../services/logger');

const { aiTriageLead } = require('../services/lead-triage');

function capitalizeName(name) {
  if (!name) return '';
  return name.trim().toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bMc(\w)/g, (_, c) => 'Mc' + c.toUpperCase())
    .replace(/\bO'(\w)/g, (_, c) => "O'" + c.toUpperCase());
}
const leadAttribution = require('../services/lead-attribution');

const WAVES_ADMIN_PHONE = '+19413187612';

// POST /api/webhooks/lead — Elementor form submission webhook
router.post('/', async (req, res) => {
  try {
    const body = req.body;

    // Map Elementor form fields (garbled names → clean)
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

    // Check for existing customer
    const existing = await db('customers').where({ phone: phoneFormatted }).first();

    if (existing) {
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

      logger.info(`Lead webhook: existing customer ${existing.first_name} ${existing.last_name} submitted form`);
      return res.json({ success: true, existing: true, customerId: existing.id });
    }

    // Create new customer
    const location = resolveLocation(leadSource.area || '');
    const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

    const [customer] = await db('customers').insert({
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
      member_since: new Date().toISOString().split('T')[0],
      waveguard_tier: null,
    }).returning('*');

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

    // Notify Adam — during business hours (8AM-8PM ET) trigger a call, otherwise SMS
    const now = new Date();
    const etHour = parseInt(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }));
    const isDuringHours = etHour >= 8 && etHour < 20;
    let callConnected = false;

    try {
      const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      if (isDuringHours && twilioClient) {
        // During business hours: initiate call to admin connecting to the lead
        try {
          const domain = process.env.SERVER_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || 'portal.wavespestcontrol.com';
          await twilioClient.calls.create({
            to: WAVES_ADMIN_PHONE,
            from: '+19412972606',
            url: `https://${domain}/api/webhooks/twilio/outbound-admin-prompt?customerNumber=${encodeURIComponent(phoneFormatted)}&callerIdNumber=${encodeURIComponent('+19412972606')}`,
            record: true,
          });
          callConnected = true;
          logger.info(`[lead-webhook] Business hours — calling admin to connect with ${firstName}`);
        } catch (callErr) {
          logger.error(`[lead-webhook] Admin call failed, falling back to SMS: ${callErr.message}`);
          await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
            `🔔 New lead!\n${firstName} ${lastName}\n📞 ${phoneFormatted}\n📍 ${address || 'No address'}\n🌐 ${leadSource.detail || leadSource.source}\n${utmCampaign ? '📊 Campaign: ' + utmCampaign : ''}`,
            { messageType: 'internal_alert' }
          );
        }
      } else {
        // After hours: SMS alert only
        await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
          `🔔 New lead!\n${firstName} ${lastName}\n📞 ${phoneFormatted}\n📍 ${address || 'No address'}\n🌐 ${leadSource.detail || leadSource.source}\n${utmCampaign ? '📊 Campaign: ' + utmCampaign : ''}`,
          { messageType: 'internal_alert' }
        );
      }
    } catch (e) { logger.error(`Lead alert failed: ${e.message}`); }

    // Auto-reply to lead — always send during business hours (whether call connected or not)
    try {
      const replyMsg = isDuringHours
        ? `Hello ${firstName}! Waves here! We received your quote request. One of our specialists will be calling soon—feel free to reply if you'd rather chat by message.\n\nThank you for considering Waves!`
        : `Hello ${firstName}! Thanks for reaching out to Waves. We received your info and will follow up first thing in the morning with a custom quote.\n\nQuestions? Reply to this message.\nThank you for choosing Waves!`;
      await TwilioService.sendSMS(phoneFormatted, replyMsg,
        { customerId: customer.id, messageType: 'auto_reply', customerLocationId: location.id }
      );
    } catch (e) { logger.error(`Lead auto-reply failed: ${e.message}`); }

    // Beehiiv — create subscriber, tag as Lead, enroll in lead automation
    try {
      const beehiiv = require('../services/beehiiv');
      if (beehiiv.configured && email) {
        const sub = await beehiiv.upsertSubscriber(email, {
          firstName, lastName, utmSource: landingUrl || pageUrl, utmMedium: 'website_quote',
        });
        if (sub?.id) {
          await beehiiv.addTags(sub.id, ['Lead']);
          const autoId = process.env.BEEHIIV_AUTO_LEAD || 'aut_d08077d4-3079-4e69-9488-f6669caf6a6c';
          await beehiiv.enrollInAutomation(autoId, { email, subscriptionId: sub.id });
          logger.info(`[lead-webhook] Beehiiv: subscribed ${email}, tagged Lead, enrolled in automation`);
        }
      }
    } catch (e) { logger.error(`Lead Beehiiv failed: ${e.message}`); }

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
        lead_source_id: null,
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

    // In-app notification for new lead
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('new_lead', `New lead: ${firstName} ${lastName}`, `${leadSource.detail || leadSource.source} \u2014 ${address || 'no address'}`, { icon: '\u{1F514}', link: '/admin/customers', metadata: { customerId: customer.id } });
    } catch (e) { logger.error(`[notifications] New lead notification failed: ${e.message}`); }

    // Ad service attribution — track the full funnel from lead onward
    try {
      const serviceInterest = body.service_interest || body['What Can We Help You With'] || findField(body, /service|help|pest|lawn/i) || '';
      await db('ad_service_attribution').insert({
        customer_id: customer.id,
        service_line: inferServiceLine(serviceInterest),
        specific_service: inferSpecificService(serviceInterest),
        service_bucket: inferServiceBucket(serviceInterest),
        lead_date: new Date().toISOString().split('T')[0],
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
