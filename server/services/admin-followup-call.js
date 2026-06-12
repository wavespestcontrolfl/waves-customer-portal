const twilio = require('twilio');
const config = require('../config');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const TwilioService = require('./twilio');
const logger = require('./logger');
const { alertTwilioFailure } = require('./twilio-failure-alerts');

const DEFAULT_ADMIN_PHONE = '+19415993489';
const BUSINESS_HOURS_START_ET = 8;
const BUSINESS_HOURS_END_ET = 20;

function notifyTwilioFailure(payload) {
  void alertTwilioFailure(payload).catch((alertErr) => {
    logger.error(`[twilio-alerts] async notification failed: ${alertErr.message}`);
  });
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeUsPhone(value) {
  const digits = phoneDigits(value);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(value || '').trim().startsWith('+') && digits.length >= 10) return `+${digits}`;
  return '';
}

function etHour(now = new Date()) {
  return parseInt(now.toLocaleString('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: 'America/New_York',
  }), 10);
}

function isDuringBusinessHours(now = new Date()) {
  const hour = etHour(now);
  return hour >= BUSINESS_HOURS_START_ET && hour < BUSINESS_HOURS_END_ET;
}

function publicDomain() {
  return process.env.SERVER_DOMAIN || process.env.RAILWAY_PUBLIC_DOMAIN || 'portal.wavespestcontrol.com';
}

function adminPhone() {
  return normalizeUsPhone(process.env.ADAM_PHONE) || DEFAULT_ADMIN_PHONE;
}

function alertFromNumber() {
  return normalizeUsPhone(process.env.WAVES_LEAD_ALERT_FROM_NUMBER)
    || TWILIO_NUMBERS.mainLine.number;
}

function fallbackSmsBody({
  eventLabel = 'Customer follow-up',
  customerName = '',
  customerPhone = '',
  address = '',
  sourceLabel = '',
  amountLabel = '',
} = {}) {
  return [
    eventLabel,
    customerName || 'Unknown customer',
    customerPhone ? `Phone: ${customerPhone}` : null,
    address ? `Address: ${address}` : null,
    sourceLabel ? `Source: ${sourceLabel}` : null,
    amountLabel ? `Amount: ${amountLabel}` : null,
  ].filter(Boolean).join('\n');
}

function scrubProviderError(value) {
  return String(value || '')
    .replace(/%2B1\d{10}/gi, '[phone]')
    .replace(/\+1\d{10}\b/g, '[phone]')
    .replace(/\b1\d{10}\b/g, '[phone]')
    .replace(/\b\d{10}\b/g, '[phone]');
}

async function sendFallbackSms({ to, body }) {
  await TwilioService.sendSMS(to, body, { messageType: 'internal_alert' });
}

async function triggerAdminFollowupCall({
  customerId = null,
  customerName = '',
  customerPhone = '',
  address = '',
  source = 'admin-followup',
  sourceLabel = '',
  eventLabel = 'Customer follow-up',
  amountLabel = '',
  now = new Date(),
  database = db,
  twilioFactory = twilio,
} = {}) {
  const normalizedCustomerPhone = normalizeUsPhone(customerPhone);
  if (!normalizedCustomerPhone) {
    logger.warn(`[admin-followup-call] skipped ${source}: missing customer phone`);
    return { called: false, skipped: true, reason: 'missing_customer_phone' };
  }

  const toAdmin = adminPhone();
  const fromNumber = alertFromNumber();
  const smsBody = fallbackSmsBody({
    eventLabel,
    customerName,
    customerPhone: normalizedCustomerPhone,
    address,
    sourceLabel,
    amountLabel,
  });

  if (!isDuringBusinessHours(now)) {
    await sendFallbackSms({ to: toAdmin, body: smsBody });
    return { called: false, sms: true, reason: 'after_hours' };
  }

  if (!isEnabled('twilioVoice')) {
    await sendFallbackSms({ to: toAdmin, body: smsBody });
    return { called: false, sms: true, reason: 'twilio_voice_disabled' };
  }

  if (!config.twilio.accountSid || !config.twilio.authToken) {
    logger.warn(`[admin-followup-call] Twilio voice unavailable for ${source}: missing credentials`);
    await sendFallbackSms({ to: toAdmin, body: smsBody });
    return { called: false, sms: true, reason: 'twilio_not_configured' };
  }

  const client = twilioFactory(config.twilio.accountSid, config.twilio.authToken);
  const domain = publicDomain();
  const firstName = String(customerName || '').trim().split(/\s+/)[0] || 'a customer';
  const autoBridge = isEnabled('leadAutoBridge');
  let pendingAutoBridgeCallLogId = null;

  try {
    if (autoBridge) {
      const bridgeCallerId = TWILIO_NUMBERS.mainLine.number;
      const [callLogRow] = await database('call_log')
        .insert({
          customer_id: customerId || null,
          direction: 'outbound',
          from_phone: fromNumber,
          to_phone: toAdmin,
          status: 'initiated',
          source: `${source}-auto-bridge`,
          metadata: JSON.stringify({
            type: 'admin_auto_bridge',
            eventLabel,
            customerName,
            customerPhone: normalizedCustomerPhone,
            bridgeCallerId,
            sourceLabel,
            amountLabel,
          }),
        })
        .returning(['id']);
      const callLogId = callLogRow?.id;
      pendingAutoBridgeCallLogId = callLogId || null;

      const promptParams = new URLSearchParams({
        customerNumber: normalizedCustomerPhone,
        callerIdNumber: bridgeCallerId,
        leadName: firstName,
        eventLabel,
      });
      if (callLogId) promptParams.set('callLogId', callLogId);

      const call = await client.calls.create({
        to: toAdmin,
        from: fromNumber,
        url: `https://${domain}/api/webhooks/twilio/outbound-admin-prompt?${promptParams.toString()}`,
        statusCallback: `https://${domain}/api/webhooks/twilio/call-status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        record: false,
      });

      if (callLogId) {
        await database('call_log').where({ id: callLogId }).update({
          twilio_call_sid: call.sid,
          updated_at: new Date(),
        }).catch((err) => {
          logger.warn(`[admin-followup-call] call_log sid backfill failed for ${source}: ${err.message}`);
        });
      }

      logger.info(`[admin-followup-call] Auto-bridge call started for ${source}: ${call.sid}`);
      return { called: true, mode: 'auto_bridge', callSid: call.sid, callLogId };
    }

    const call = await client.calls.create({
      to: toAdmin,
      from: fromNumber,
      url: `https://${domain}/api/webhooks/twilio/lead-alert-announce?leadName=${encodeURIComponent(firstName)}&leadPhone=${encodeURIComponent(normalizedCustomerPhone)}&eventLabel=${encodeURIComponent(eventLabel)}`,
      statusCallback: `https://${domain}/api/webhooks/twilio/call-status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      record: false,
    });

    try {
      await database('call_log').insert({
        customer_id: customerId || null,
        direction: 'outbound',
        from_phone: fromNumber,
        to_phone: toAdmin,
        twilio_call_sid: call.sid,
        status: 'initiated',
        source: `${source}-announce`,
        metadata: JSON.stringify({
          type: 'admin_alert_announce',
          eventLabel,
          customerName,
          customerPhone: normalizedCustomerPhone,
          sourceLabel,
          amountLabel,
        }),
      });
    } catch (logErr) {
      logger.warn(`[admin-followup-call] announce call_log insert failed for ${source}: ${logErr.message}`);
    }

    logger.info(`[admin-followup-call] Announce call started for ${source}: ${call.sid}`);
    return { called: true, mode: 'announce', callSid: call.sid };
  } catch (callErr) {
    const safeError = scrubProviderError(callErr.message);
    if (pendingAutoBridgeCallLogId) {
      await database('call_log').where({ id: pendingAutoBridgeCallLogId }).update({
        status: 'failed',
        notes: `Twilio create failed: ${safeError}`,
        updated_at: new Date(),
      }).catch((logErr) => {
        logger.warn(`[admin-followup-call] call_log failure mark failed for ${source}: ${logErr.message}`);
      });
    }
    logger.error(`[admin-followup-call] call failed for ${source}, falling back to SMS: ${safeError}`);
    notifyTwilioFailure({
      channel: 'voice',
      direction: 'outbound',
      phase: 'send_api',
      status: 'failed',
      errorMessage: safeError,
      from: fromNumber,
      to: toAdmin,
      link: '/admin/estimates',
    });
    await sendFallbackSms({ to: toAdmin, body: smsBody });
    return { called: false, sms: true, reason: 'call_failed', error: safeError };
  }
}

module.exports = {
  _internals: {
    fallbackSmsBody,
    isDuringBusinessHours,
    normalizeUsPhone,
    scrubProviderError,
  },
  triggerAdminFollowupCall,
};
