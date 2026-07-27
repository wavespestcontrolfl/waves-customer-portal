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

// One alert per dedupe key per rolling window.
const DEDUPE_WINDOW_HOURS = 24;
// Rows whose window ended this long ago are dead state — prune opportunistically.
const DEDUPE_PRUNE_DAYS = 30;

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

// The party we might be spamming Adam about. Inbound traffic carries the
// caller in `from` and one of our own business lines in `to` — keying on `to`
// would collapse EVERY inbound failure into one key and a single webhook
// error would suppress unrelated customers' alerts for a day. Outbound is the
// reverse: the customer is `to`.
function remotePartyDigits(direction, from, to) {
  const raw = String(direction || '').toLowerCase() === 'inbound' ? from : to;
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

// Atomically claim the alert window for this key. Exactly one concurrent
// caller gets a row back; everyone else is inside an open window and skips.
// Any DB error fails OPEN — a broken dedupe layer must never eat a failure
// alert, only ever allow a duplicate.
async function claimAlertWindow(dedupeKey) {
  try {
    const result = await db.raw(
      `INSERT INTO twilio_alert_dedupe (dedupe_key, last_alerted_at)
       VALUES (?, now())
       ON CONFLICT (dedupe_key) DO UPDATE
         SET last_alerted_at = now()
         WHERE twilio_alert_dedupe.last_alerted_at <= now() - (? * interval '1 hour')
       RETURNING dedupe_key`,
      [dedupeKey, DEDUPE_WINDOW_HOURS]
    );
    return (result.rows || []).length > 0;
  } catch (err) {
    logger.warn(`[twilio-alerts] dedupe claim failed (alerting anyway): ${err.message}`);
    return true;
  }
}

// If the notification itself failed after we claimed the window, give the
// window back so the next occurrence still alerts. Deleting the row fails
// toward alerting, same as claimAlertWindow's error path.
async function releaseAlertWindow(dedupeKey) {
  try {
    await db('twilio_alert_dedupe').where({ dedupe_key: dedupeKey }).del();
  } catch (err) {
    logger.warn(`[twilio-alerts] dedupe release failed: ${err.message}`);
  }
}

function pruneStaleDedupeRows() {
  db('twilio_alert_dedupe')
    .where('last_alerted_at', '<', db.raw(`now() - (? * interval '1 day')`, [DEDUPE_PRUNE_DAYS]))
    .del()
    .catch((err) => {
      logger.warn(`[twilio-alerts] dedupe prune failed: ${err.message}`);
    });
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
  // Key on the remote party, not the event: repeat failures reaching the same
  // number collapse to one alert per window regardless of SID (a fresh SID per
  // send is exactly why the old per-SID key never deduped anything). Only when
  // no phone is available fall back to the per-event key, which fails toward
  // alerting rather than suppressing.
  const remoteDigits = remotePartyDigits(direction, from, to);
  const rawDedupeKey = input.dedupeKey || (remoteDigits
    ? ['twilio', channel || 'unknown', direction || 'unknown', `party:${remoteDigits}`, errorCode || 'no-code'].join(':')
    : ['twilio', channel || 'unknown', direction || 'unknown', phase || 'unknown', sid || 'no-sid', normalizedStatus, errorCode || 'no-code'].join(':'));
  const dedupeKey = publicDedupeKey(rawDedupeKey);
  const safeErrorMessage = sanitizeFailureText(errorMessage);

  if (!(await claimAlertWindow(dedupeKey))) return { skipped: true, reason: 'duplicate' };
  pruneStaleDedupeRows();

  logger.warn(
    `[twilio-alerts] channel=${channel || 'unknown'} direction=${direction || 'unknown'} phase=${phase || 'unknown'} ` +
    `status=${normalizedStatus} sid=${maskSid(sid)} errorCode=${errorCode || 'none'} ` +
    `from=${maskPhone(from)} to=${maskPhone(to)}`
  );

  try {
    return await triggerNotification('twilio_failure', {
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
  } catch (err) {
    await releaseAlertWindow(dedupeKey);
    throw err;
  }
}

module.exports = {
  alertTwilioFailure,
  isFailureStatus,
  maskSid,
  maskPhone,
  publicDedupeKey,
  sanitizeFailureText,
};
