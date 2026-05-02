const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { recordSuppression, clearSuppression } = require('../services/messaging/validators/suppression');
const { updateByTwilioSid } = require('../services/conversations');
const { uploadTwilioMedia } = require('../services/sms-media');

const WAVES_ADMIN_PHONE = '+19413187612';

function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : trimmed || null;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

// POST /api/webhooks/twilio/sms — inbound SMS webhook
router.post('/sms', async (req, res) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('webhooks')) {
      logger.info(`[GATE BLOCKED] Inbound SMS webhook from ${maskPhone(req.body.From)} (gate: webhooks)`);
      return res.type('text/xml').send('<Response></Response>');
    }

    const { From, To, Body, MessageSid } = req.body;

    // ── Spam block (must run before any other routing) ──
    const { checkInboundBlock } = require('../middleware/spam-block');
    const blockResult = await checkInboundBlock({ from: From, to: To, channel: 'sms', twilioSid: MessageSid });
    if (blockResult.blocked) return res.type('text/xml').send(blockResult.twiml);

    const numberConfig = TWILIO_NUMBERS.findByNumber(To);

    if (!numberConfig) {
      logger.info(`Inbound SMS to unmanaged number ${To} — ignoring`);
      return res.type('text/xml').send('<Response></Response>');
    }

    const inboundMedia = await uploadTwilioMedia(req.body);

    // Try to match sender to a customer
    const customer = await db('customers').where({ phone: From }).first();

    // Dual-write to unified messages table. Wrapped in fire-and-forget
    // because old sms_log writes still happen below; if this errors the
    // legacy path keeps Virginia's inbox working.
    require('../services/conversations').recordTouchpoint({
      customerId: customer?.id,
      channel: 'sms',
      ourEndpointId: To,
      contactPhone: customer ? null : From,
      direction: 'inbound',
      body: Body,
      authorType: 'customer',
      twilioSid: MessageSid,
      media: inboundMedia,
      metadata: { location: numberConfig?.label, numberType: numberConfig?.type },
    }).catch(() => {});

    // ── STOP / UNSUBSCRIBE keyword handling ──
    const bodyTrimmed = (Body || '').trim().toUpperCase();
    const STOP_KEYWORDS = ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'QUIT', 'END'];
    const START_KEYWORDS = ['START', 'SUBSCRIBE', 'YES'];

    if (STOP_KEYWORDS.includes(bodyTrimmed)) {
      const normalizedFrom = normalizeE164(From);
      await recordSuppression({
        phone: normalizedFrom || From,
        reason: 'opt_out_keyword',
        source: `twilio_webhook_${bodyTrimmed}`,
        capturedBody: Body,
      });
      try {
        if (customer) {
          await db('notification_prefs')
            .insert({ customer_id: customer.id, sms_enabled: false })
            .onConflict('customer_id')
            .merge({ sms_enabled: false });
        }
        logger.info(`[sms-optout] ${customer ? `Customer ${customer.id}` : `Unknown sender ${maskPhone(From)}`} opted out of SMS`);
      } catch (e) { logger.error(`[sms-optout] Failed to update prefs: ${e.message}`); }

      await db('sms_log').insert({
        customer_id: customer?.id || null, direction: 'inbound', from_phone: From, to_phone: To,
        message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'opt_out',
      }).catch(() => {});

      if (customer) {
        await db('activity_log').insert({
          customer_id: customer.id, action: 'sms_opt_out',
          description: `${customer.first_name} ${customer.last_name} unsubscribed from SMS (keyword: ${bodyTrimmed})`,
        }).catch(() => {});
      }

      return res.type('text/xml').send(
        `<Response><Message>You've been unsubscribed from Waves Pest Control SMS. Reply START to re-subscribe.</Message></Response>`
      );
    }

    if (START_KEYWORDS.includes(bodyTrimmed)) {
      const normalizedFrom = normalizeE164(From);
      await clearSuppression({
        phone: normalizedFrom || From,
        source: `twilio_webhook_${bodyTrimmed}`,
      });
      try {
        if (customer) {
          await db('notification_prefs')
            .insert({ customer_id: customer.id, sms_enabled: true })
            .onConflict('customer_id')
            .merge({ sms_enabled: true });
        }
        logger.info(`[sms-optin] ${customer ? `Customer ${customer.id}` : `Unknown sender ${maskPhone(From)}`} re-subscribed to SMS`);
      } catch (e) { logger.error(`[sms-optin] Failed to update prefs: ${e.message}`); }

      await db('sms_log').insert({
        customer_id: customer?.id || null, direction: 'inbound', from_phone: From, to_phone: To,
        message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'opt_in',
      }).catch(() => {});

      if (customer) {
        await db('activity_log').insert({
          customer_id: customer.id, action: 'sms_opt_in',
          description: `${customer.first_name} ${customer.last_name} re-subscribed to SMS`,
        }).catch(() => {});
      }

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

    // LEAD INTAKE STATE MACHINE — catches replies to the "What are you
    // interested in — Pest Control, Lawn Care, or One-Time Service?"
    // auto-reply that lead-webhook.js sends after a form submission.
    // Runs the intent classifier → asks for address → auto-creates a
    // draft estimate → SMS-notifies Adam at 941-599-3489. Only active
    // while lead_intake_status is set (seeded by lead-webhook).
    if (customer && Body && customer.lead_intake_status &&
        customer.lead_intake_status !== 'estimate_drafted') {
      try {
        const LeadIntake = require('../services/lead-intake');
        const intakeResult = await LeadIntake.handleIntakeReply(customer, Body);
        if (intakeResult?.handled) {
          logger.info(`[lead-intake] Handled for ${customer.first_name}: ${customer.lead_intake_status} → ${intakeResult.next}`);
          await db('sms_log').insert({
            customer_id: customer.id, direction: 'inbound', from_phone: From, to_phone: To,
            message_body: Body, twilio_sid: MessageSid, status: 'received',
            message_type: 'lead_intake',
          }).catch(() => {});
          return res.type('text/xml').send('<Response></Response>');
        }
      } catch (e) { logger.error(`[lead-intake] Failed: ${e.message}`); }
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
          member_since: etDateString(),
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

    const [smsLogEntry] = await db('sms_log').insert({
      customer_id: customer?.id || null,
      direction: 'inbound', from_phone: From, to_phone: To,
      message_body: Body, twilio_sid: MessageSid, status: 'received',
      message_type: messageType,
      metadata: JSON.stringify({
        locationId: numberConfig.locationId,
        source: numberConfig.type,
        domain: numberConfig.domain,
        media: inboundMedia,
      }),
    }).returning('id');

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

    // In-app + push notification for inbound SMS from known customers
    if (customer && (Body || inboundMedia.length) && numberConfig.type === 'location') {
      try {
        const { triggerNotification } = require('../services/notification-triggers');
        await triggerNotification('sms_reply', {
          fromName: `${customer.first_name} ${customer.last_name}`,
          fromPhone: From,
          message: Body || `${inboundMedia.length} photo${inboundMedia.length === 1 ? '' : 's'}`,
          threadId: customer.id,
        });
      } catch (e) { logger.error(`[notifications] sms_reply trigger failed: ${e.message}`); }
    }

    // Notify Adam of every inbound SMS (skip only if it would create a loop — same from AND to)
    if ((Body || inboundMedia.length) && process.env.ADAM_PHONE && !(From === process.env.ADAM_PHONE && To === process.env.ADAM_PHONE)) {
      try {
        const senderName = customer ? `${customer.first_name} ${customer.last_name}` : From;
        const mediaText = inboundMedia.length
          ? `\nMedia: ${inboundMedia.length} photo${inboundMedia.length === 1 ? '' : 's'}`
          : '';
        await TwilioService.sendSMS(process.env.ADAM_PHONE,
          `📩 New SMS\nFrom: ${senderName}\n"${(Body || '').slice(0, 120)}"${mediaText}`,
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
    // Only active on the dedicated AI assistant number
    const AI_ASSISTANT_NUMBER = '+18559260203';
    const toClean = (To || '').replace(/\D/g, '');
    const isAiNumber = toClean === '18559260203' || toClean === '8559260203' || To === AI_ASSISTANT_NUMBER;

    let aiAutoReplyOn = false;
    if (isAiNumber) {
      if (isEnabled('aiAssistantAutoReply')) {
        aiAutoReplyOn = true;
      } else {
        try {
          const toggle = await db('system_config').where({ key: 'ai_sms_auto_reply' }).first();
          if (toggle?.value === 'true') aiAutoReplyOn = true;
        } catch { /* ignore */ }
      }
    }
    // Scheduling-intent gate — high-stakes scheduling questions must not be
    // auto-answered. A real failure motivated this: a customer asked "are we
    // on the schedule for tomorrow?" and the canned AI reply said "fully
    // booked, call us" while the customer actually had an appointment. Any
    // scheduling-intent inbound skips the auto-reply entirely and falls
    // through to Virginia's inbox (legacy ai-draft block below still runs).
    const { hasSchedulingIntent } = require('../services/sms-intent');
    const schedulingIntent = Body ? hasSchedulingIntent(Body) : false;

    if (Body && (customer || numberConfig.type === 'location') && aiAutoReplyOn && !schedulingIntent) {
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
        // through the customer-message middleware. The wrapper enforces
        // suppression (so we don't reply to a STOP'd number), consent,
        // emoji + price-leak rules, and segment cap. Audit row written
        // either way.
        if (aiResult.reply && !aiResult.escalated) {
          try {
            const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
            // Inbound texters always reach at least phone_provided_unverified —
            // they're literally texting from the number, so the channel-level
            // identity is established by the inbound webhook itself. Without
            // this hint, audience='lead' for unknown numbers would fall back
            // to 'anonymous' in the trust resolver and fail the policy
            // minimum for purpose='conversational' (a regression that would
            // silently drop every new-lead AI reply).
            const sendResult = await sendCustomerMessage({
              to: From,
              body: aiResult.reply,
              channel: 'sms',
              audience: customer ? 'customer' : 'lead',
              purpose: 'conversational',
              customerId: customer?.id || null,
              identityTrustLevel: customer ? 'phone_matches_customer' : 'phone_provided_unverified',
              entryPoint: 'twilio_inbound_ai_assistant',
              metadata: { fromNumber: To },
            });
            if (!sendResult.sent) {
              // PII rule: never log full phone in plaintext. Mask to last 4
              // digits — enough for operator debugging via audit log
              // cross-reference. Drop sendResult.reason: upstream
              // provider/guard error strings may include the full
              // recipient phone or message body. Operators get the full
              // failure context via messaging_audit_log keyed by code +
              // to_last4.
              const last4 = String(From || '').replace(/\D/g, '').slice(-4);
              logger.warn(`[twilio-webhook] AI reply BLOCKED for ***${last4}: code=${sendResult.code}`);
            }
          } catch (e) { logger.error(`AI reply SMS failed: ${e.message}`); }
        }

        logger.info(`AI Assistant processed: ${From} escalated=${aiResult.escalated} conv=${aiResult.conversationId}`);
      } catch (e) { logger.error(`AI Assistant failed: ${e.message}`); }
    } else if (schedulingIntent && aiAutoReplyOn) {
      // Log the intentional skip so we can audit the gate and see volume.
      logger.info(`[sms-intent] scheduling-intent detected from ${From}; skipping auto-reply, routing to human inbox`);
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
          sms_log_id: smsLogEntry?.id || null,
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
            const datePretty = new Date(lightestDay + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });

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
      await updateByTwilioSid(MessageSid, { delivery_status: MessageStatus, updated_at: new Date() });
    }
  } catch (err) {
    logger.error(`Status webhook error: ${err.message}`);
  }
  res.sendStatus(200);
});

module.exports = router;
