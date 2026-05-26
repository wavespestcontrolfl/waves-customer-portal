const db = require('../models/db');
const crypto = require('crypto');
const logger = require('./logger');
const { triggerNotification } = require('./notification-triggers');

const FAILURE_STATUSES = new Set([
  'failed',
  'undelivered',
  'delivery_unknown',
  'busy',
  'no-answer',
  'canceled',
]);

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

function maskSid(sid) {
  const value = String(sid || '');
  if (!value) return 'none';
  return value.length <= 8 ? `${value.slice(0, 2)}...` : `${value.slice(0, 2)}...${value.slice(-6)}`;
}

function sanitizeFailureText(value) {
  return String(value || '')
    .replace(/https:\/\/lookups\.twilio\.com\/v2\/PhoneNumbers\/[^?\s)]+/gi, 'https://lookups.twilio.com/v2/PhoneNumbers/[phone]')
    .replace(/%2B\d{10,15}/gi, '[phone]')
    .replace(/\+\d{10,15}\b/g, '[phone]')
    .replace(/\b\d{10,15}\b/g, '[phone]')
    .replace(/\b[A-Z]{2}[a-f0-9]{32}\b/gi, (sid) => maskSid(sid))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
}

function publicDedupeKey(rawKey) {
  const digest = crypto.createHash('sha256').update(String(rawKey || '')).digest('hex').slice(0, 16);
  return `twilio:${digest}`;
}

function isFailureStatus(status) {
  return FAILURE_STATUSES.has(String(status || '').toLowerCase());
}

async function alreadyAlerted(dedupeKey) {
  if (!dedupeKey) return false;
  try {
    const existing = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->'payload'->>'dedupeKey' = ?", [dedupeKey])
      .where('created_at', '>=', db.raw("now() - interval '24 hours'"))
      .first('id');
    return !!existing;
  } catch (err) {
    logger.warn(`[twilio-alerts] dedupe check failed: ${err.message}`);
    return false;
  }
}

async function alertTwilioFailure(input = {}) {
  const {
    channel,
    direction,
    phase,
    status,
    sid,
    errorCode,
    errorMessage,
    from,
    to,
    link,
  } = input;

  const normalizedStatus = String(status || 'failed').toLowerCase();
  const rawDedupeKey = input.dedupeKey || [
    'twilio',
    channel || 'unknown',
    direction || 'unknown',
    phase || 'unknown',
    sid || 'no-sid',
    normalizedStatus,
    errorCode || 'no-code',
  ].join(':');
  const dedupeKey = publicDedupeKey(rawDedupeKey);
  const safeErrorMessage = sanitizeFailureText(errorMessage);

  if (await alreadyAlerted(dedupeKey)) return { skipped: true, reason: 'duplicate' };

  logger.warn(
    `[twilio-alerts] channel=${channel || 'unknown'} direction=${direction || 'unknown'} phase=${phase || 'unknown'} ` +
    `status=${normalizedStatus} sid=${maskSid(sid)} errorCode=${errorCode || 'none'} ` +
    `from=${maskPhone(from)} to=${maskPhone(to)}`
  );

  return triggerNotification('twilio_failure', {
    channel,
    direction,
    phase,
    status: normalizedStatus,
    sidMasked: maskSid(sid),
    errorCode,
    errorMessage: safeErrorMessage,
    fromMasked: maskPhone(from),
    toMasked: maskPhone(to),
    link,
    dedupeKey,
  });
}

module.exports = {
  alertTwilioFailure,
  isFailureStatus,
  maskSid,
  maskPhone,
  publicDedupeKey,
  sanitizeFailureText,
};
