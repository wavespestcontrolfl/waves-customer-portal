const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');

const WAVES_ADMIN_PHONE = '+19413187612';

// POST /api/webhooks/twilio/sms — inbound SMS webhook
router.post('/sms', async (req, res) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('webhooks')) {
      logger.info(`[GATE BLOCKED] Inbound SMS webhook from ${req.body.From} (gate: webhooks)`);
      return res.type('text/xml').send('<Response></Response>');
    }

    const { From, To, Body, MessageSid } = req.body;
    const numberConfig = TWILIO_NUMBERS.findByNumber(To);

    if (!numberConfig) {
      logger.info(`Inbound SMS to unmanaged number ${To} — ignoring`);
      return res.type('text/xml').send('<Response></Response>');
    }

    // Try to match sender to a customer
    const customer = await db('customers').where({ phone: From }).first();

    // ── STOP / UNSUBSCRIBE keyword handling ──
    const bodyTrimmed = (Body || '').trim().toUpperCase();
    const STOP_KEYWORDS = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'END'];
    const START_KEYWORDS = ['START', 'SUBSCRIBE', 'YES'];

    if (customer && STOP_KEYWORDS.includes(bodyTrimmed)) {
      try {
        await db('notification_prefs').where({ customer_id: customer.id }).update({ sms_enabled: false });
        logger.info(`[sms-optout] Customer ${customer.id} (${customer.first_name}) opted out of SMS`);
      } catch (e) { logger.error(`[sms-optout] Failed to update prefs: ${e.message}`); }

      await db('sms_log').insert({
        customer_id: customer.id, direction: 'inbound', from_phone: From, to_phone: To,
        message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'opt_out',
      }).catch(() => {});

      await db('activity_log').insert({
        customer_id: customer.id, action: 'sms_opt_out',
        description: `${customer.first_name} ${customer.last_name} unsubscribed from SMS (keyword: ${bodyTrimmed})`,
      }).catch(() => {});

      return res.type('text/xml').send(
        `<Response><Message>You've been unsubscribed from Waves Pest Control SMS. Reply START to re-subscribe.</Message></Response>`
      );
    }

    if (customer && START_KEYWORDS.includes(bodyTrimmed)) {
      try {
        await db('notification_prefs').where({ customer_id: customer.id }).update({ sms_enabled: true });
        logger.info(`[sms-optin] Customer ${customer.id} (${customer.first_name}) re-subscribed to SMS`);
      } catch (e) { logger.error(`[sms-optin] Failed to update prefs: ${e.message}`); }

      await db('sms_log').insert({
        customer_id: customer.id, direction: 'inbound', from_phone: From, to_phone: To,
        message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'opt_in',
      }).catch(() => {});

      await db('activity_log').insert({
        customer_id: customer.id, action: 'sms_opt_in',
        description: `${customer.first_name} ${customer.last_name} re-subscribed to SMS`,
      }).catch(() => {});

      return res.type('text/xml').send(
        `<Response><Message>You've been re-subscribed to Waves Pest Control SMS.</Message></Response>`
      );
    }

    // Check for pending reschedule reply FIRST
    if (customer && numberConfig.type === 'location') {
      try {
        const RescheduleSMS = require('../services/reschedule-sms');
        const rescheduleResult = await RescheduleSMS.handleRescheduleReply(customer.id, Body);
        if (rescheduleResult?.handled) {
          logger.info(`Reschedule reply handled for ${customer.first_name}: ${rescheduleResult.action}`);
          // Still log the inbound message
          await db('sms_log').insert({
            customer_id: customer.id, direction: 'inbound', from_phone: From, to_phone: To,
            message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'reschedule_reply',
          }).catch(() => {});
          return res.type('text/xml').send('<Response></Response>');
        }
      } catch (e) { logger.error(`Reschedule reply check failed: ${e.message}`); }
    }

    // DOMAIN TRACKING — new lead from a domain-specific number
    if ((numberConfig.type === 'domain_tracking' || numberConfig.type === 'van_tracking') && !customer) {
      const leadSource = TWILIO_NUMBERS.getLeadSourceFromNumber(To);
      const { resolveLocation } = require('../config/locations');
      const loc = resolveLocation(numberConfig.area || leadSource.area || '');
      const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

      try {
        const [newCust] = await db('customers').insert({
          first_name: 'Unknown', last_name: '',
          phone: From, address_line1: '', city: numberConfig.area || '', state: 'FL', zip: '',
          referral_code: code, lead_source: leadSource.source,
          lead_source_detail: numberConfig.domain || leadSource.domain || 'Van wrap',
          lead_source_area: numberConfig.area || '', lead_source_channel: 'organic',
          nearest_location_id: numberConfig.location || loc.id,
          pipeline_stage: 'new_lead', pipeline_stage_changed_at: new Date(),
          last_contact_date: new Date(), last_contact_type: Body ? 'sms_inbound' : 'call_inbound',
          member_since: new Date().toISOString().split('T')[0], waveguard_tier: 'Bronze',
          crm_notes: `Inbound ${Body ? 'SMS' : 'call'} from ${numberConfig.domain || 'van wrap'}. ${Body ? 'Message: ' + Body : ''}`,
        }).returning('*');

        await db('property_preferences').insert({ customer_id: newCust.id });
        await db('notification_prefs').insert({ customer_id: newCust.id });

        try {
          await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
            `🔔 New lead from ${numberConfig.domain || 'van wrap'}!\n📞 ${From}\n💬 "${Body || 'Phone call'}"\nArea: ${numberConfig.area || 'Unknown'}`,
            { messageType: 'internal_alert' }
          );
        } catch (e) { logger.error(`Domain lead alert failed: ${e.message}`); }

        // Auto-reply from the location number (not the domain number)
        try {
          await TwilioService.sendSMS(From,
            "Thanks for reaching out to Waves Pest Control! We'll get back to you shortly. For immediate help, call (941) 318-7612. 🌊",
            { customerId: newCust.id, fromNumber: TWILIO_NUMBERS.getOutboundNumber(numberConfig.location || 'lakewood-ranch'), messageType: 'auto_reply' }
          );
        } catch (e) { logger.error(`Domain lead auto-reply failed: ${e.message}`); }

        await db('activity_log').insert({
          customer_id: newCust.id, action: 'customer_created',
          description: `New lead from ${numberConfig.domain || 'van wrap'}: ${From}`,
        });
      } catch (e) { logger.error(`Domain lead creation failed: ${e.message}`); }
    }

    // Log inbound message
    const messageType = numberConfig.type === 'domain_tracking' ? 'domain_lead'
      : numberConfig.type === 'van_tracking' ? 'van_lead' : 'inbound';

    await db('sms_log').insert({
      customer_id: customer?.id || null,
      direction: 'inbound', from_phone: From, to_phone: To,
      message_body: Body, twilio_sid: MessageSid, status: 'received',
      message_type: messageType,
      metadata: JSON.stringify({ locationId: numberConfig.locationId, source: numberConfig.type, domain: numberConfig.domain }),
    });

    await db('activity_log').insert({
      customer_id: customer?.id || null,
      action: messageType === 'inbound' ? 'sms_received' : 'lead_received',
      description: numberConfig.type === 'domain_tracking'
        ? `🌐 Lead from ${numberConfig.domain}: ${From} — "${(Body || '').slice(0, 80)}"`
        : numberConfig.type === 'van_tracking'
          ? `🚛 Lead from van wrap: ${From} — "${(Body || '').slice(0, 80)}"`
          : `📱 SMS from ${customer ? `${customer.first_name} ${customer.last_name}` : From}: "${(Body || '').slice(0, 80)}"`,
      metadata: JSON.stringify({ from: From, to: To, domain: numberConfig.domain }),
    });

    // Notify Adam of every inbound SMS (skip only if it would create a loop — same from AND to)
    if (Body && process.env.ADAM_PHONE && !(From === process.env.ADAM_PHONE && To === process.env.ADAM_PHONE)) {
      try {
        const senderName = customer ? `${customer.first_name} ${customer.last_name}` : From;
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `📩 New SMS\nFrom: ${senderName}\n"${(Body || '').slice(0, 120)}"`,
          { messageType: 'internal_alert' }
        );
      } catch (e) { logger.error(`SMS notification failed: ${e.message}`); }
    }

    // Van wrap tracking — new lead flow
    if (numberConfig.type === 'tracking') {
      // Auto-reply from the van wrap number
      try {
        await TwilioService.sendSMS(From,
          "Thanks for reaching out to Waves Pest Control! We'll get back to you shortly. For immediate help, call (941) 318-7612. 🌊",
          { fromNumber: To, messageType: 'auto_reply' }
        );
      } catch (e) { logger.error(`Van wrap auto-reply failed: ${e.message}`); }

      // Notify Adam
      try {
        await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
          `📱 New lead from van wrap number:\nFrom: ${From}\nMessage: "${Body || '(no text)'}"\n\nReply from the portal.`,
          { fromNumber: TWILIO_NUMBERS.locations['lakewood-ranch'].number, messageType: 'internal_alert' }
        );
      } catch (e) { logger.error(`Van wrap admin alert failed: ${e.message}`); }
    }

    // WAVES AI ASSISTANT — route through conversational AI engine
    // Check both feature gate AND the admin toggle (system_config)
    let aiAutoReplyOn = false;
    if (isEnabled('aiAssistantAutoReply')) {
      aiAutoReplyOn = true;
    } else {
      try {
        const toggle = await db('system_config').where({ key: 'ai_sms_auto_reply' }).first();
        if (toggle?.value === 'true') aiAutoReplyOn = true;
      } catch { /* ignore */ }
    }
    if (Body && (customer || numberConfig.type === 'location') && aiAutoReplyOn) {
      try {
        const WavesAssistant = require('../services/ai-assistant/assistant');
        const aiResult = await WavesAssistant.processMessage({
          message: Body,
          channel: 'sms',
          channelIdentifier: From,
          customerId: customer?.id || null,
          customerPhone: From,
        });

        // If AI generated a reply (not escalated), send it automatically
        if (aiResult.reply && !aiResult.escalated) {
          try {
            await TwilioService.sendSMS(From, aiResult.reply, {
              customerId: customer?.id, fromNumber: To, messageType: 'ai_assistant',
            });
          } catch (e) { logger.error(`AI reply SMS failed: ${e.message}`); }
        }

        logger.info(`AI Assistant processed: ${From} escalated=${aiResult.escalated} conv=${aiResult.conversationId}`);
      } catch (e) { logger.error(`AI Assistant failed: ${e.message}`); }
    }

    // LEGACY AI DRAFT — still create drafts for admin review alongside the AI assistant
    if (customer && numberConfig.type === 'location' && Body) {
      try {
        const ContextAggregator = require('../services/context-aggregator');
        const ResponseDrafter = require('../services/response-drafter');

        const context = await ContextAggregator.getFullCustomerContext(From);

        // Simple intent classification
        const intentMap = [
          { pattern: /when|next|schedule|appointment/i, intent: 'SCHEDULE_INQUIRY' },
          { pattern: /cancel|stop|pause|quit/i, intent: 'CANCEL_REQUEST' },
          { pattern: /bug|ant|roach|spider|pest|rat|mouse|termite|mosquito/i, intent: 'PEST_REPORT' },
          { pattern: /bill|pay|charge|invoice|balance/i, intent: 'BILLING_INQUIRY' },
          { pattern: /complain|unhappy|frustrated|not working|still seeing/i, intent: 'COMPLAINT' },
          { pattern: /thank|great|awesome|perfect|love|excellent/i, intent: 'POSITIVE_FEEDBACK' },
          { pattern: /yes|confirm|ok|sounds good/i, intent: 'CONFIRMATION' },
        ];
        const matched = intentMap.find(m => m.pattern.test(Body));
        const intent = { intent: matched?.intent || 'GENERAL', confidence: matched ? 0.85 : 0.5 };

        const draft = await ResponseDrafter.draftResponse(Body, context, intent);

        // Store draft for approval — DO NOT send
        await db('message_drafts').insert({
          sms_log_id: null, // could link to sms_log entry
          customer_id: customer.id,
          inbound_message: Body,
          draft_response: draft.draft,
          intent: intent.intent,
          intent_confidence: intent.confidence,
          context_summary: context.summary,
          flags: JSON.stringify(context.flags),
          status: 'pending',
        });

        // Auto-suggest appointment for schedule inquiries
        if (intent.intent === 'SCHEDULE_INQUIRY' && customer) {
          try {
            // Find next available slot based on customer location
            const zone = customer.city ? require('../config/locations').resolveLocation(customer.city) : null;
            const tomorrow = new Date();
            tomorrow.setDate(tomorrow.getDate() + 1);
            const nextWeek = new Date();
            nextWeek.setDate(nextWeek.getDate() + 7);

            // Check scheduled service load for next 7 days
            const dailyLoad = await db('scheduled_services')
              .whereBetween('scheduled_date', [tomorrow.toISOString().split('T')[0], nextWeek.toISOString().split('T')[0]])
              .whereNotIn('status', ['cancelled'])
              .select('scheduled_date')
              .count('* as count')
              .groupBy('scheduled_date')
              .orderBy('count', 'asc');

            // Find the lightest day
            const lightestDay = dailyLoad[0]?.scheduled_date || tomorrow.toISOString().split('T')[0];
            const datePretty = new Date(lightestDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

            // Append suggestion to the draft
            draft.draft += `\n\nI can get you scheduled for ${datePretty} — morning or afternoon works better for you?`;

            logger.info(`[sms-intent] Schedule inquiry from ${customer.first_name} — suggesting ${datePretty}`);
          } catch (schedErr) {
            logger.error(`[sms-intent] Schedule suggestion failed: ${schedErr.message}`);
          }
        }

        // Notify Adam for high-urgency
        if (['COMPLAINT', 'CANCEL_REQUEST', 'SCHEDULE_INQUIRY'].includes(intent.intent)) {
          try {
            await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
              `📱 ${customer.first_name}: "${Body.slice(0, 80)}"\n🤖 Draft: "${draft.draft.slice(0, 80)}..."\nApprove: ${process.env.CLIENT_URL || 'http://localhost:5173'}/admin/communications`,
              { messageType: 'internal_alert' }
            );
          } catch (e) { logger.error(`Draft alert failed: ${e.message}`); }
        }

        logger.info(`AI draft created for ${customer.first_name}: ${intent.intent}`);
      } catch (e) { logger.error(`AI draft pipeline failed: ${e.message}`); }
    }

    // Return empty TwiML — Adam approves drafts before sending
    res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    logger.error(`Webhook error: ${err.message}`);
    res.type('text/xml').send('<Response></Response>');
  }
});

// POST /api/webhooks/twilio/status — delivery status callback
router.post('/status', async (req, res) => {
  try {
    const { MessageSid, MessageStatus } = req.body;
    if (MessageSid && MessageStatus) {
      await db('sms_log').where({ twilio_sid: MessageSid }).update({ status: MessageStatus });
    }
  } catch (err) {
    logger.error(`Status webhook error: ${err.message}`);
  }
  res.sendStatus(200);
});

module.exports = router;
