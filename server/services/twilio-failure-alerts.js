const db = require('../models/db');
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
  const dedupeKey = input.dedupeKey || [
    'twilio',
    channel || 'unknown',
    direction || 'unknown',
    phase || 'unknown',
    sid || 'no-sid',
    normalizedStatus,
    errorCode || 'no-code',
  ].join(':');

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
    sid,
    sidMasked: maskSid(sid),
    errorCode,
    errorMessage,
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
};
