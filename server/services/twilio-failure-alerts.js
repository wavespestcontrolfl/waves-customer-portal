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
// Slack added past lease expiry before a blocked caller retries its claim.
const DEDUPE_RETRY_BUFFER_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Who is on the other end of the failed call/message. Owner ruling (Adam,
// 2026-07-30): the admin bell must show the real number and, when the phone
// maps to exactly one live customer, their name and record id — fully masked
// alerts were untriageable. Log lines keep masking (maskPhone/maskSid); only
// the notification payload is enriched. Any lookup error degrades to a
// nameless alert, never a suppressed one.
async function resolveRemoteParty(direction, from, to) {
  const dir = String(direction || '').toLowerCase();
  if (dir !== 'inbound' && dir !== 'outbound') return null;
  const raw = dir === 'inbound' ? from : to;
  const e164 = toE164(raw);
  if (!e164 || !isLikelyE164(e164)) return null;
  const digits = String(e164).replace(/\D/g, '');
  const party = { name: null, customerId: null };
  // Last-10 matching is a NANP convention — a non-NANP caller (+44 20 7946
  // 0958) shares its last ten digits with an unrelated US number (+1 207 946
  // 0958) and would falsely name that customer. toE164 preserves foreign
  // country codes, so gate on them: international callers stay nameless (the
  // real number still shows in the alert body).
  if (String(e164).startsWith('+') && !String(e164).startsWith('+1')) return party;
  try {
    // Match every customer contact slot, not just the primary phone — the
    // pipeline records spouses/tenants into the service-contact slots (same
    // column set as call-recording-processor's CONTACT_MATCH_PHONE_COLS).
    // LIVE customers only (whereLiveCustomer — customers.active is true for
    // leads too, so a bare deleted_at check would let a stale lead/churned
    // row suppress or mislabel the one live match). Enrich only an
    // UNAMBIGUOUS match: two live customers sharing the number stay nameless
    // rather than naming the wrong one.
    const { whereLiveCustomer } = require('./customer-stages');
    const key = digits.slice(-10);
    const phoneCols = ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone'];
    const matches = await whereLiveCustomer(db('customers'))
      .where(function anyContactSlot() {
        for (const col of phoneCols) {
          this.orWhereRaw(`RIGHT(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g'), 10) = ?`, [key]);
        }
      })
      .orderBy('updated_at', 'desc')
      .limit(2);
    if (Array.isArray(matches) && matches.length === 1) {
      party.name = [matches[0].first_name, matches[0].last_name].filter(Boolean).join(' ') || null;
      party.customerId = matches[0].id || null;
    }
  } catch (err) {
    logger.warn(`[twilio-alerts] remote-party lookup failed: ${err.message}`);
  }
  return party;
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
// The claimed timestamp doubles as a claim token: confirm and release match
// on it, so a stale process whose lease was re-claimed by a newer one can no
// longer confirm or delete the newer claim. Round-tripped as ::text — the pg
// driver parses timestamptz into a millisecond Date, which would drop the
// microseconds and never match again.
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
       RETURNING dedupe_key, last_alerted_at::text AS claimed_at`,
      [dedupeKey, DEDUPE_WINDOW_HOURS, DEDUPE_PENDING_LEASE_MINUTES]
    );
    const row = (result.rows || [])[0];
    return row
      ? { claimed: true, owned: true, claimedAt: row.claimed_at }
      : { claimed: false, owned: false, claimedAt: null };
  } catch (err) {
    logger.warn(`[twilio-alerts] dedupe claim failed (alerting anyway): ${err.message}`);
    return { claimed: true, owned: false, claimedAt: null };
  }
}

// When a claim is refused, tell a delivered duplicate (suppress) apart from
// another process's still-pending lease (worth retrying — the owner may have
// crashed or its dispatch may fail). Row already gone → it was released →
// retry immediately. Unknown state → treat as duplicate: the claim was
// refused by an in-window row, which is overwhelmingly a delivered one.
async function pendingLeaseState(dedupeKey) {
  try {
    const result = await db.raw(
      `SELECT (delivered_at IS NULL) AS pending,
              GREATEST(0, EXTRACT(EPOCH FROM (last_alerted_at + (? * interval '1 minute') - now()))) AS retry_in_s
       FROM twilio_alert_dedupe
       WHERE dedupe_key = ?`,
      [DEDUPE_PENDING_LEASE_MINUTES, dedupeKey]
    );
    const row = (result.rows || [])[0];
    if (!row) return { pending: true, retryInMs: 0 };
    return { pending: !!row.pending, retryInMs: Math.ceil(Number(row.retry_in_s || 0) * 1000) };
  } catch (err) {
    logger.warn(`[twilio-alerts] pending-lease check failed: ${err.message}`);
    return { pending: false, retryInMs: 0 };
  }
}

// Confirm the lease to the full window once a channel received the alert —
// but only OUR lease: a newer claim (different last_alerted_at) is left
// untouched. On error the row stays pending and expires after the lease —
// the failure direction is an extra alert, never a suppressed one.
async function confirmAlertDelivered(dedupeKey, claimedAt) {
  try {
    await db('twilio_alert_dedupe')
      .where({ dedupe_key: dedupeKey })
      .whereRaw('last_alerted_at = ?::timestamptz', [claimedAt])
      .whereNull('delivered_at')
      .update({ delivered_at: db.fn.now() });
  } catch (err) {
    logger.warn(`[twilio-alerts] dedupe confirm failed: ${err.message}`);
  }
}

// If the notification itself failed after we claimed the window, give the
// window back so the next occurrence still alerts — but only OUR claim.
// Deleting the row fails toward alerting, same as claimAlertWindow's error
// path.
async function releaseAlertWindow(dedupeKey, claimedAt) {
  try {
    await db('twilio_alert_dedupe')
      .where({ dedupe_key: dedupeKey })
      .whereRaw('last_alerted_at = ?::timestamptz', [claimedAt])
      .whereNull('delivered_at')
      .del();
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

async function runAlert(dedupeKey, notification, attempt = 0) {
  const claim = await claimAlertWindow(dedupeKey);
  if (!claim.claimed) {
    // Same-process callers never reach here while a dispatch is in flight
    // (they chain on pendingDispatches) — a refused claim on a PENDING row
    // means another process holds the lease. Wait it out and retry once: if
    // the owner delivered, the retry sees a delivered duplicate; if it
    // crashed or failed, the retry claims the expired lease and alerts.
    const state = await pendingLeaseState(dedupeKey);
    if (!state.pending) return { skipped: true, reason: 'duplicate' };
    if (attempt >= 1) {
      logger.warn('[twilio-alerts] pending lease still contested after retry — skipping');
      return { skipped: true, reason: 'pending_conflict' };
    }
    await sleep(state.retryInMs + DEDUPE_RETRY_BUFFER_MS);
    return runAlert(dedupeKey, notification, attempt + 1);
  }
  pruneStaleDedupeRows();

  logger.warn(notification.logLine);

  let result;
  try {
    result = await triggerNotification('twilio_failure', notification.payload);
  } catch (err) {
    if (claim.owned) await releaseAlertWindow(dedupeKey, claim.claimedAt);
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
    if (delivered) await confirmAlertDelivered(dedupeKey, claim.claimedAt);
    else await releaseAlertWindow(dedupeKey, claim.claimedAt);
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
  const remote = await resolveRemoteParty(direction, from, to);

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
      fromPhone: from || null,
      toPhone: to || null,
      remoteName: remote?.name || null,
      customerId: remote?.customerId || null,
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
