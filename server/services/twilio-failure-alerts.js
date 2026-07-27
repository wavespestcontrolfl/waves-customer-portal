const db = require('../models/db');
const crypto = require('crypto');
const logger = require('./logger');
const { triggerNotification } = require('./notification-triggers');
const { toE164, isLikelyE164 } = require('../utils/phone');

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
// A claim whose delivery was never confirmed (process died mid-dispatch)
// only suppresses duplicates this long before it can be re-claimed.
const DEDUPE_PENDING_LEASE_MINUTES = 5;
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
// reverse: the customer is `to`. Only an EXPLICIT direction picks a side —
// some error paths (voice /call-status catch) pass direction 'unknown', and
// guessing outbound there would key unrelated inbound callers on our own
// line; unknown direction takes the per-event fallback instead.
function remotePartyDigits(direction, from, to) {
  const dir = String(direction || '').toLowerCase();
  if (dir !== 'inbound' && dir !== 'outbound') return null;
  const raw = dir === 'inbound' ? from : to;
  if (!raw) return null;
  // Canonicalize before hashing: send paths pass stored/caller-supplied
  // formats ("(941) 555-1234") while provider callbacks pass E.164 — without
  // one canonical form the same party would hash to different keys. toE164
  // returns the raw input on garbage ("anonymous", "client:foo"); gate on
  // isLikelyE164 so those take the per-event fallback.
  const e164 = toE164(raw);
  if (!e164 || !isLikelyE164(e164)) return null;
  return String(e164).replace(/\D/g, '');
}

// Atomically claim the alert window for this key. Exactly one concurrent
// caller gets a row back; everyone else is inside an open window and skips.
// Any DB error fails OPEN — a broken dedupe layer must never eat a failure
// alert, only ever allow a duplicate. `owned` distinguishes "we hold the row"
// from "we're alerting despite a broken claim": only an owned claim may be
// released later, otherwise a dispatch failure here could delete a valid
// in-window row established by an earlier, successfully delivered alert.
// Two-phase: a fresh claim starts as a short pending lease (delivered_at
// NULL); only after a channel actually receives the alert is it confirmed to
// the full window. A process that dies between claim and delivery therefore
// suppresses duplicates for minutes, not 24 hours.
async function claimAlertWindow(dedupeKey) {
  try {
    const result = await db.raw(
      `INSERT INTO twilio_alert_dedupe (dedupe_key, last_alerted_at, delivered_at)
       VALUES (?, now(), NULL)
       ON CONFLICT (dedupe_key) DO UPDATE
         SET last_alerted_at = now(), delivered_at = NULL
         WHERE (twilio_alert_dedupe.delivered_at IS NOT NULL
                AND twilio_alert_dedupe.last_alerted_at <= now() - (? * interval '1 hour'))
            OR (twilio_alert_dedupe.delivered_at IS NULL
                AND twilio_alert_dedupe.last_alerted_at <= now() - (? * interval '1 minute'))
       RETURNING dedupe_key`,
      [dedupeKey, DEDUPE_WINDOW_HOURS, DEDUPE_PENDING_LEASE_MINUTES]
    );
    const claimed = (result.rows || []).length > 0;
    return { claimed, owned: claimed };
  } catch (err) {
    logger.warn(`[twilio-alerts] dedupe claim failed (alerting anyway): ${err.message}`);
    return { claimed: true, owned: false };
  }
}

// Confirm the lease to the full window once a channel received the alert.
// On error the row stays pending and expires after the lease — the failure
// direction is an extra alert, never a suppressed one.
async function confirmAlertDelivered(dedupeKey) {
  try {
    await db('twilio_alert_dedupe')
      .where({ dedupe_key: dedupeKey })
      .update({ delivered_at: db.fn.now() });
  } catch (err) {
    logger.warn(`[twilio-alerts] dedupe confirm failed: ${err.message}`);
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

// In-flight work by dedupe key, so an overlapping same-key caller observes
// the outcome instead of returning "duplicate" against a claim whose delivery
// later fails and gets released. Callers CHAIN onto the tail promise
// synchronously — before any await — so two events arriving in the same tick
// still serialize (an async-checked map would let both pass the check first).
const pendingDispatches = new Map();

async function runAlert(dedupeKey, notification) {
  const claim = await claimAlertWindow(dedupeKey);
  if (!claim.claimed) return { skipped: true, reason: 'duplicate' };
  pruneStaleDedupeRows();

  logger.warn(notification.logLine);

  let result;
  try {
    result = await triggerNotification('twilio_failure', notification.payload);
  } catch (err) {
    if (claim.owned) await releaseAlertWindow(dedupeKey);
    throw err;
  }

  // triggerNotification never throws — dispatch failures come back as
  // { bellWritten: false, push: null, error }. If the alert reached no
  // channel, give the window back so the next occurrence still alerts.
  // A deliberate internal-test suppression counts as handled, not failed.
  const delivered = !!result && (
    result.suppressed === true ||
    result.bellWritten === true ||
    Number(result.push?.sent || 0) > 0
  );
  if (claim.owned) {
    if (delivered) await confirmAlertDelivered(dedupeKey);
    else await releaseAlertWindow(dedupeKey);
  }
  return result;
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
  // With neither a phone nor a SID there is no event identity at all (e.g. a
  // malformed webhook with an empty body) — a constant key would classify
  // every later such failure as a duplicate for 24h. A per-call nonce keeps
  // those alerting every time, which is the fail-open direction.
  const eventId = sid || `evt:${crypto.randomUUID()}`;
  const rawDedupeKey = input.dedupeKey || (remoteDigits
    ? ['twilio', channel || 'unknown', direction || 'unknown', `party:${remoteDigits}`, errorCode || 'no-code'].join(':')
    : ['twilio', channel || 'unknown', direction || 'unknown', phase || 'unknown', eventId, normalizedStatus, errorCode || 'no-code'].join(':'));
  const dedupeKey = publicDedupeKey(rawDedupeKey);
  const safeErrorMessage = sanitizeFailureText(errorMessage);

  const notification = {
    logLine:
      `[twilio-alerts] channel=${channel || 'unknown'} direction=${direction || 'unknown'} phase=${phase || 'unknown'} ` +
      `status=${normalizedStatus} sid=${maskSid(sid)} errorCode=${errorCode || 'none'} ` +
      `from=${maskPhone(from)} to=${maskPhone(to)}`,
    payload: {
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
    },
  };

  // Chain onto any same-key work already in flight — registered here
  // SYNCHRONOUSLY, so an event arriving in the same tick serializes behind us
  // and sees the true claim state (delivered → duplicate; released → it takes
  // over). Cross-process overlap still resolves through the atomic claim; the
  // portal runs as a single service instance.
  const prior = pendingDispatches.get(dedupeKey) || Promise.resolve();
  const task = prior.catch(() => {}).then(() => runAlert(dedupeKey, notification));
  pendingDispatches.set(dedupeKey, task);
  const cleanup = () => {
    if (pendingDispatches.get(dedupeKey) === task) pendingDispatches.delete(dedupeKey);
  };
  task.then(cleanup, cleanup);
  return task;
}

module.exports = {
  alertTwilioFailure,
  isFailureStatus,
  maskSid,
  maskPhone,
  publicDedupeKey,
  sanitizeFailureText,
};
