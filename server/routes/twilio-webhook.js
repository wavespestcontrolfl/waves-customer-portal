const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const { recordSuppression, clearSuppression } = require('../services/messaging/validators/suppression');
const { detectSmsOptCommand } = require('../services/messaging/opt-out-detector');
const { tryClaimInboundWebhook, releaseInboundWebhook } = require('../services/messaging/inbound-dedupe');
const { updateByTwilioSid } = require('../services/conversations');
const { uploadTwilioMedia } = require('../services/sms-media');
const { alertTwilioFailure, isFailureStatus } = require('../services/twilio-failure-alerts');
const { hasSchedulingIntent, isSmsReaction } = require('../services/sms-intent');
const { publicPortalUrl } = require('../utils/portal-url');
const { properCase } = require('../utils/name-case');

// Admin alert recipient — must be a real cell, never one of our own Twilio
// numbers (an SMS from the HQ line to itself fails with Twilio error 21266).
const ADMIN_ALERT_PHONE = process.env.ADAM_PHONE || '+19415993489';

function notifyTwilioFailure(payload) {
  void alertTwilioFailure(payload).catch((err) => {
    logger.error(`[twilio-alerts] async notification failed: ${err.message}`);
  });
}

function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return trimmed.startsWith('+') ? trimmed : trimmed || null;
}

function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function phoneLookupKey(phone) {
  const normalized = normalizeE164(phone);
  const digits = phoneDigits(normalized || phone);
  if (!digits) return '';
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function maskPhone(phone) {
  const digits = phoneDigits(phone);
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

async function findSingleCustomerByPhone(phone) {
  const key = phoneLookupKey(phone);
  if (!key) return null;

  const matches = await db('customers')
    .whereNull('deleted_at')
    .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [key])
    .orderBy('updated_at', 'desc')
    .limit(2);

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    logger.warn(`[sms] ${matches.length} customers share sender phone ${maskPhone(phone)}; not auto-linking inbound SMS`);
  }
  return null;
}

function cleanIntroNameSegment(segment) {
  const text = String(segment || '')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .split(/[.,;!?]/)[0]
    .replace(/\s+(?:and|but|because|who|that|i|we)\b.*$/i, '')
    .replace(/\s+(?:from|in|at|with|seeking|looking|need|needs|want|wants|live|lives|located)\b.*$/i, '')
    .trim();
  const words = text.match(/[a-z][a-z' -]*/gi);
  if (!words) return '';
  const candidate = words.join(' ').replace(/\s+/g, ' ').trim();
  const lower = candidate.toLowerCase();
  const firstWord = lower.split(' ')[0];
  if (
    !candidate ||
    [
      'about', 'at', 'for', 'from', 'in', 'located', 'live', 'lives', 'looking',
      'need', 'needs', 'interested', 'seeking', 'trying', 'want', 'wants', 'with',
    ].includes(firstWord) ||
    /^(a|an|the|quote|service|pest|rodent|lawn|customer|homeowner|property)$/i.test(lower)
  ) {
    return '';
  }
  return properCase(candidate.split(' ').slice(0, 3).join(' '));
}

function extractContactNameFromSms(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const patterns = [
    /\bmy\s+name\s+is\s+(.{1,80})/i,
    /\bthis\s+is\s+(.{1,80})/i,
    /\bi['’]?m\s+(.{1,80})/i,
    /\bi\s+am\s+(.{1,80})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const fullName = cleanIntroNameSegment(match?.[1]);
    if (!fullName) continue;
    const parts = fullName.split(/\s+/);
    return {
      fullName,
      firstName: parts[0] || '',
      lastName: parts.slice(1).join(' '),
    };
  }

  return null;
}

// POST /api/webhooks/twilio/sms — inbound SMS webhook
router.post('/sms', async (req, res) => {
  // Whether THIS delivery actually took the dedupe ledger row. Only an owner
  // may release the claim on error (a fail-open delivery must not delete a
  // sibling delivery's good claim). Declared out here so the catch can read it.
  let claimOwned = false;
  // Flipped true once a non-idempotent write keyed to this SID has committed
  // (the inbound sms_log row). After that we must NOT release the claim on a
  // later error — sms_log.twilio_sid is not unique, so a Twilio retry would
  // duplicate the row. Better to keep the (already-logged) message claimed.
  let persisted = false;
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('webhooks')) {
      logger.info(`[GATE BLOCKED] Inbound SMS webhook from ${maskPhone(req.body.From)} (gate: webhooks)`);
      return res.type('text/xml').send('<Response></Response>');
    }

    const { From, To, Body, MessageSid } = req.body;
    const smsReaction = isSmsReaction(Body);
    const schedulingIntent = hasSchedulingIntent(Body);

    // ── Idempotency claim (must run before spam-block + all side-effects) ──
    // Twilio can redeliver the same MessageSid (edge retry, a slow handler
    // that blew the ~15s timeout, or a FallbackUrl re-hitting us). Claim the
    // SID atomically BEFORE spam-block, so a confirmed redelivery short-circuits
    // before it can re-write blocked_call_attempts / re-log / double-alert /
    // send a second AI auto-reply (RED audit R1). Genuine first deliveries fall
    // through to spam-block as before. Fails open (processable but not owned) so
    // a dedupe outage never drops a message; we release on error only when we
    // actually own the claim.
    const smsClaim = await tryClaimInboundWebhook(MessageSid, 'sms');
    claimOwned = smsClaim.owned;
    if (!smsClaim.processable) {
      logger.info(`[twilio-webhook] Duplicate inbound SMS ${MessageSid} ignored (already processed)`);
      return res.type('text/xml').send('<Response></Response>');
    }

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

    // Try to match sender to a single active customer. Twilio sends E.164,
    // while older customer rows may still have local formatting.
    const customer = await findSingleCustomerByPhone(From);

    // Dual-write to unified messages table. Wrapped in fire-and-forget
    // because old sms_log writes still happen below; if this errors the
    // legacy path keeps Virginia's inbox working.
    require('../services/conversations').recordTouchpoint({
      customerId: customer?.id,
      channel: 'sms',
      ourEndpointId: To,
      contactPhone: From,
      direction: 'inbound',
      body: Body,
      authorType: 'customer',
      twilioSid: MessageSid,
      media: inboundMedia,
      metadata: { location: numberConfig?.label, numberType: numberConfig?.type },
    }).catch(() => {});

    // ── STOP / UNSUBSCRIBE keyword handling ──
    const optCommand = detectSmsOptCommand(Body);

    if (optCommand.action === 'opt_out') {
      const normalizedFrom = normalizeE164(From);
      await recordSuppression({
        phone: normalizedFrom || From,
        reason: optCommand.reason,
        source: `twilio_webhook_${optCommand.detectionMethod}`,
        capturedBody: Body,
      });
      try {
        if (customer) {
          await db('notification_prefs')
            .insert({ customer_id: customer.id, sms_enabled: false })
            .onConflict('customer_id')
            .merge({ sms_enabled: false });
        }
        logger.info(`[sms-optout] ${customer ? `Customer ${customer.id}` : `Unknown sender ${maskPhone(From)}`} opted out of SMS via ${optCommand.detectionMethod}`);
      } catch (e) { logger.error(`[sms-optout] Failed to update prefs: ${e.message}`); }

      await db('sms_log').insert({
        customer_id: customer?.id || null, direction: 'inbound', from_phone: From, to_phone: To,
        message_body: Body, twilio_sid: MessageSid, status: 'received', message_type: 'opt_out',
        metadata: JSON.stringify({
          opt_out_reason: optCommand.reason,
          detection_method: optCommand.detectionMethod,
          source_keyword: optCommand.sourceKeyword,
        }),
      }).catch(() => {});

      if (customer) {
        await db('activity_log').insert({
          customer_id: customer.id, action: 'sms_opt_out',
          description: `${customer.first_name} ${customer.last_name} unsubscribed from SMS (${optCommand.detectionMethod})`,
          metadata: JSON.stringify({
            opt_out_reason: optCommand.reason,
            detection_method: optCommand.detectionMethod,
            source_keyword: optCommand.sourceKeyword,
          }),
        }).catch(() => {});
      }

      return res.type('text/xml').send(
        `<Response><Message>You've been unsubscribed from Waves Pest Control SMS. Reply START to re-subscribe.</Message></Response>`
      );
    }

    if (optCommand.action === 'opt_in') {
      const normalizedFrom = normalizeE164(From);
      await clearSuppression({
        phone: normalizedFrom || From,
        source: `twilio_webhook_${optCommand.detectionMethod}`,
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
        metadata: JSON.stringify({
          detection_method: optCommand.detectionMethod,
          source_keyword: optCommand.sourceKeyword,
        }),
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

    if (smsReaction) {
      await db('sms_log').insert({
        customer_id: customer?.id || null,
        direction: 'inbound', from_phone: From, to_phone: To,
        message_body: Body, twilio_sid: MessageSid, status: 'received',
        message_type: 'sms_reaction',
        metadata: JSON.stringify({
          locationId: numberConfig.locationId,
          source: numberConfig.type,
          domain: numberConfig.domain,
          media: inboundMedia,
        }),
      }).catch(() => {});

      logger.info('[sms-intent] SMS reaction detected; skipping automated inbound handling');
      return res.type('text/xml').send('<Response></Response>');
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
      const inboundContactName = extractContactNameFromSms(Body);

      try {
        const [newCust] = await db('customers').insert({
          first_name: inboundContactName?.firstName || 'Unknown',
          last_name: inboundContactName?.lastName || '',
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
          const { triggerNotification } = require('../services/notification-triggers');
          const source = numberConfig.domain || 'van wrap';
          await triggerNotification('new_lead', {
            title: `New lead from ${source}`,
            name: inboundContactName?.fullName || 'Unknown prospect',
            phone: From,
            message: Body || 'Phone call',
            source,
            area: numberConfig.area || 'Unknown',
            leadId: newCust.id,
          });
        } catch (e) { logger.error(`Domain lead notification failed: ${e.message}`); }

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
    // The inbound message is now durably recorded — releasing the claim on a
    // later error would let a retry duplicate this row (twilio_sid not unique).
    persisted = true;

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

    if (Body && !smsReaction) {
      void require('../services/estimate-conversion-agent').processInboundSms({
        customer,
        from: From,
        to: To,
        body: Body,
        smsLogId: smsLogEntry?.id || null,
        sourceMessageId: MessageSid || null,
      }).catch((err) => logger.warn(`[estimate-conversion-agent] async shadow failed: ${err.message}`));
    }

    // Acknowledge Twilio now. Everything below — owner/admin alerts, in-app
    // notifications, the AI auto-reply, and legacy/shadow drafts — is a
    // side-effect that does NOT influence the (always-empty) TwiML reply.
    // Two sequential Claude calls used to run inline here and could exceed
    // Twilio's ~15s webhook timeout, making Twilio retry the webhook (RED
    // audit R2). The inbound message is durably persisted above, so we
    // respond first and finish the rest off the response path. This block
    // carries its own try/catch — its errors can't affect the response.
    res.type('text/xml').send('<Response></Response>');
    setImmediate(() => { void (async () => {
     try {
    const isTrackingLeadInbound = numberConfig.type === 'domain_tracking' || numberConfig.type === 'van_tracking';
    const shouldNotifyKnownInbound = numberConfig.type === 'location' || isTrackingLeadInbound;

    // In-app + push notification for inbound SMS from known customers.
    // knownInboundNotified records whether this modern bell/push actually
    // landed — when it did, the legacy owner-SMS forward below is suppressed
    // so a single inbound message can't raise two admin notifications.
    let knownInboundNotified = false;
    if (customer && (Body || inboundMedia.length) && shouldNotifyKnownInbound && !smsReaction) {
      try {
        const { triggerNotification } = require('../services/notification-triggers');
        const stats = await triggerNotification('sms_reply', {
          fromName: `${customer.first_name} ${customer.last_name}`,
          fromPhone: From,
          message: Body || `${inboundMedia.length} photo${inboundMedia.length === 1 ? '' : 's'}`,
          threadId: customer.id,
        });
        knownInboundNotified = Boolean(stats && !stats.error &&
          (stats.bellWritten || Number(stats.push?.sent || 0) > 0));
      } catch (e) { logger.error(`[notifications] sms_reply trigger failed: ${e.message}`); }
    }

    // Notify Adam of regular inbound SMS. Domain/van tracking leads use the
    // admin notification dispatcher above instead of owner SMS. Skip this
    // legacy owner forward when the sms_reply bell/push above already fired
    // (known customers) — for owner phones it is redirected to the SAME admin
    // notification, so sending both raised a duplicate. Unknown senders have no
    // customer match (sms_reply never fires), so they still get this alert.
    if ((Body || inboundMedia.length) && process.env.ADAM_PHONE && !smsReaction && !isTrackingLeadInbound && !knownInboundNotified && !(From === process.env.ADAM_PHONE && To === process.env.ADAM_PHONE)) {
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
      try {
        const { triggerNotification } = require('../services/notification-triggers');
        await triggerNotification('new_lead', {
          title: 'New lead from van wrap number',
          name: 'Unknown prospect',
          phone: From,
          message: Body || '(no text)',
          source: 'van wrap',
        });
      } catch (e) { logger.error(`Van wrap admin notification failed: ${e.message}`); }
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
    // through to Virginia's inbox.
    const legacyAiDraftsEnabled = isEnabled('legacyAiDrafts');

    if (Body && (customer || numberConfig.type === 'location') && aiAutoReplyOn && !schedulingIntent && !smsReaction) {
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

              // Transient provider failure (Twilio 429/5xx/timeout): don't
              // silently drop the reply. Re-queue it onto the scheduled-SMS
              // rail so the every-5-min cron retries it, bounded by
              // SCHEDULED_SMS_MAX_ATTEMPTS. message_type maps to purpose
              // 'conversational', matching the inbound send above. (RED R3)
              if (sendResult.retryable && sendResult.nextAllowedAt) {
                try {
                  await db('sms_log').insert({
                    customer_id: customer?.id || null,
                    direction: 'outbound',
                    from_phone: To,
                    to_phone: From,
                    message_body: aiResult.reply,
                    status: 'scheduled',
                    scheduled_for: new Date(sendResult.nextAllowedAt),
                    message_type: 'ai_assistant_reply',
                    metadata: JSON.stringify({
                      entry_point: 'twilio_inbound_ai_assistant_retry',
                      provider_retry: true,
                      original_failure_code: sendResult.code || null,
                    }),
                  });
                  logger.info(`[twilio-webhook] AI reply re-queued (retry at ${sendResult.nextAllowedAt}) for ***${last4}`);
                } catch (requeueErr) {
                  logger.error(`[twilio-webhook] AI reply re-queue failed: ${requeueErr.message}`);
                }
              }
            }
          } catch (e) { logger.error(`AI reply SMS failed: ${e.message}`); }
        }

        logger.info(`AI Assistant processed: ${From} escalated=${aiResult.escalated} conv=${aiResult.conversationId}`);
      } catch (e) { logger.error(`AI Assistant failed: ${e.message}`); }
    } else if (schedulingIntent && aiAutoReplyOn) {
      // Log the intentional skip so we can audit the gate and see volume.
      logger.info('[sms-intent] scheduling-intent detected; skipping auto-reply, routing to human inbox');
    } else if (smsReaction && aiAutoReplyOn) {
      logger.info('[sms-intent] SMS reaction detected; skipping auto-reply');
    }

    // LEGACY AI DRAFT — still create drafts for admin review alongside the AI assistant
    if (customer && numberConfig.type === 'location' && Body && legacyAiDraftsEnabled && !schedulingIntent && !smsReaction) {
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
            await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
              `📱 ${customer.first_name}: "${Body.slice(0, 80)}"\n🤖 Draft: "${draft.draft.slice(0, 80)}..."\nApprove: ${publicPortalUrl()}/admin/communications`,
              { messageType: 'internal_alert' }
            );
          } catch (e) { logger.error(`Draft alert failed: ${e.message}`); }
        }

        logger.info(`AI draft created for ${customer.first_name}: ${intent.intent}`);
      } catch (e) { logger.error(`AI draft pipeline failed: ${e.message}`); }
    } else if (customer && numberConfig.type === 'location' && Body && !legacyAiDraftsEnabled) {
      logger.info('[sms-intent] legacy AI draft gate disabled; skipping draft creation');
    } else if (customer && numberConfig.type === 'location' && Body && schedulingIntent) {
      logger.info('[sms-intent] scheduling-intent detected; skipping legacy AI draft');
    } else if (customer && numberConfig.type === 'location' && Body && smsReaction) {
      logger.info('[sms-intent] SMS reaction detected; skipping legacy AI draft');
    }

    // SMS SHADOW DRAFTER (brand-voice loop, Phase B) — silently record what
    // the house-voice AI would have replied. status='shadow' rows never send
    // and never enter the approval queue; a later judge pass scores them
    // against the reply Virginia actually sent. The AI number is excluded
    // (findByNumber reports it as type 'location', but its traffic is
    // already AI-handled — there is no human reply to judge against).
    // Scheduling-intent messages ARE shadowed: a shadow row can't send, and
    // the high-stakes class is exactly where the judge needs data.
    if (Body && customer && !smsReaction && !isAiNumber && numberConfig.type === 'location' && isEnabled('smsShadowDrafts')) {
      try {
        const { classifyCustomerSmsTriageIntent } = require('../services/estimate-conversion-agent');
        // no_reply_needed messages are shadowed too (intent label kept):
        // short confirmations like "yes" / "sounds good" classify that way
        // from the body alone, but they're exactly where a human follows up
        // — and knowing when NOT to reply is itself a judged class. The
        // draft contract allows an empty reply for true courtesy acks.
        const triage = classifyCustomerSmsTriageIntent(Body, { customer });
        void require('../services/sms-shadow-drafter').draftShadowReply({
          inboundMessage: Body,
          fromPhone: From,
          customer,
          smsLogId: smsLogEntry?.id || null,
          intent: triage,
          schedulingIntent,
        }).catch((err) => logger.warn(`[sms-shadow] async draft failed: ${err.message}`));
      } catch (e) { logger.error(`[sms-shadow] wiring failed: ${e.message}`); }
    }

     } catch (sideErr) {
       logger.error(`[twilio-webhook] async inbound side-effects failed: ${sideErr.message}`);
     }
    })(); });
    // Response already sent above (empty TwiML — Adam approves drafts before sending).
  } catch (err) {
    logger.error(`Webhook error: ${err.message}`);
    // Release the idempotency claim ONLY if this delivery owns it AND nothing
    // non-idempotent has committed yet (!persisted): handling failed before the
    // inbound row landed, so a Twilio retry SHOULD reprocess rather than be
    // short-circuited as a duplicate. A fail-open delivery (claimOwned=false)
    // must NOT release — it never took the row, and deleting it would free a
    // sibling delivery's good claim. Once persisted, we keep the claim so a
    // retry can't duplicate sms_log. (The deferred side-effects run after the
    // response with their own catch — they
    // never reach here, so a post-ack failure correctly keeps the claim.)
    if (claimOwned && !persisted) void releaseInboundWebhook(req.body?.MessageSid);
    notifyTwilioFailure({
      channel: 'sms',
      direction: 'inbound',
      phase: 'webhook',
      status: 'failed',
      sid: req.body?.MessageSid,
      errorMessage: err.message,
      from: req.body?.From,
      to: req.body?.To,
      link: '/admin/communications',
    });
    res.type('text/xml').send('<Response></Response>');
  }
});

// POST /api/webhooks/twilio/status — delivery status callback
router.post('/status', async (req, res) => {
  try {
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage, From, To } = req.body;
    if (MessageSid && MessageStatus) {
      await db('sms_log').where({ twilio_sid: MessageSid }).update({ status: MessageStatus });
      await updateByTwilioSid(MessageSid, { delivery_status: MessageStatus, updated_at: new Date() });
      if (isFailureStatus(MessageStatus)) {
        notifyTwilioFailure({
          channel: 'sms',
          direction: 'outbound',
          phase: 'delivery',
          status: MessageStatus,
          sid: MessageSid,
          errorCode: ErrorCode,
          errorMessage: ErrorMessage,
          from: From,
          to: To,
          link: '/admin/communications',
        });

        // Appointment-text fallback: if this undelivered message was an appointment
        // notification (confirmation / 72h / 24h / en-route), learn the landline on
        // a 30006 bounce and send the email version so the customer still gets it.
        // Best-effort, off the webhook response path — never block the 200.
        try {
          const AppointmentReminders = require('../services/appointment-reminders');
          void AppointmentReminders.handleUndeliveredSms({
            sid: MessageSid,
            status: MessageStatus,
            errorCode: ErrorCode,
            to: To,
          }).catch((e) => logger.error(`[twilio-status] appointment email fallback failed: ${e.message}`));
        } catch (e) {
          logger.error(`[twilio-status] appointment email fallback dispatch failed: ${e.message}`);
        }
      }
    }
  } catch (err) {
    logger.error(`Status webhook error: ${err.message}`);
    notifyTwilioFailure({
      channel: 'sms',
      direction: 'outbound',
      phase: 'status_webhook',
      status: 'failed',
      sid: req.body?.MessageSid,
      errorMessage: err.message,
      from: req.body?.From,
      to: req.body?.To,
      link: '/admin/communications',
    });
  }
  res.sendStatus(200);
});

router._internals = {
  extractContactNameFromSms,
};

module.exports = router;
