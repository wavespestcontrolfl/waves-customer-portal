/**
 * Voice-relay Phase E — URGENT/HOT-LEAD INTERNAL OWNER ALERT.
 *
 * When Sandy captures a lead she classified `hot` (the prompt defines hot as
 * emergency / swarming / active infestation / angry customer), the owner gets
 * an alert IMMEDIATELY instead of finding it in a digest tomorrow.
 *
 * REUSED MECHANISM (never a parallel one): this is the SAME internal-alert
 * sender the self-booking confirm path uses — routes/booking.js
 * createSelfBooking's `if (process.env.ADAM_PHONE) TwilioService.sendSMS(...,
 * { messageType: 'internal_alert' })` block. services/twilio.js
 * redirectInternalAdminSmsToNotification intercepts owner-phone +
 * internal_alert sends at the top of sendSMS and delivers them through the
 * admin bell/push path. Nothing here talks to Twilio directly.
 *
 * NOT CUSTOMER-FACING, EVER. The house rule ("the owner sends all customer
 * communications") is untouched: the only recipient this module can address is
 * the owner phone from the environment, and the only messageType it can send
 * is 'internal_alert'. There is no code path from the voice agent to
 * sendCustomerMessage / a customer SMS or email.
 *
 * GATE: the existing context gate (VOICE_RELAY_CONTEXT_ENABLED === 'true',
 * fail-closed). Gate off ⇒ no alert, no sender loaded, no env read.
 *
 * IDEMPOTENT: at most ONE SUCCESSFUL alert per call. The session owns the flag
 * (relay-conversation's tool ctx: ctx.ownerAlerted / ctx.markOwnerAlerted), so
 * a model that calls capture_lead twice — or a retry after a tool error —
 * cannot page the owner twice. The flag is set AFTER the send returns: a
 * transient failure must not consume the one-per-call budget and silently
 * swallow the page.
 *
 * FAIL-OPEN: an alert failure must never break the call or the lead write.
 * Everything is inside a try/catch that logs and returns false. Phone numbers
 * are masked in logs (the alert BODY carries the real callback number — that
 * is the point of the alert, and it goes only to the owner).
 */

const logger = require('../logger');
const { maskPhone } = require('./relay-protocol');

const MAX_ALERT_BODY = 480; // two-ish SMS segments; the bell/push render truncates anyway

/**
 * Did an internal alert actually LAND? services/twilio.js suppresses
 * owner-phone `internal_alert` sends and redirects them to the admin
 * bell/push path — and that redirect returns `success: true` even when the
 * notification write failed (`notificationUndelivered` / `notificationError`),
 * because the SMS fallback is deliberately not taken. Only an explicit
 * failure marker counts as undelivered, so a plain SMS result (no redirect
 * keys) still reads as delivered.
 */
function internalAlertDelivered(result) {
  if (!result || result.success === false) return false;
  if (result.notificationUndelivered === true || result.notificationError === true) return false;
  return true;
}

/** The owner phone, using the SAME env precedence the alert callers use. */
function ownerAlertPhone() {
  return String(process.env.ADAM_PHONE || '').trim() || null;
}

/** One flat, quote-free line for the alert body. */
function alertSafe(value, max = 80) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Build the owner-facing alert body. Internal surface: the callback number is
 * deliberately in full so the owner can call back from the notification.
 */
function buildHotLeadAlert({ firstName, lastName, phone, city, requestedService, urgencyReason, summary, existingCustomer }) {
  const name = [alertSafe(firstName, 40), alertSafe(lastName, 40)].filter(Boolean).join(' ');
  const lines = [
    '🚨 URGENT lead from the phone assistant:',
    name || 'Caller name not given',
    alertSafe(phone, 20) || 'no callback number',
  ];
  if (city) lines.push(alertSafe(city, 40));
  if (existingCustomer) lines.push('EXISTING CUSTOMER');
  if (requestedService) lines.push(`Wants: ${alertSafe(requestedService, 80)}`);
  if (urgencyReason) lines.push(`Why urgent: ${alertSafe(urgencyReason, 120)}`);
  if (summary) lines.push(alertSafe(summary, 160));
  lines.push('Call them back — this was flagged hot on the call.');
  return lines.join('\n').slice(0, MAX_ALERT_BODY);
}

/**
 * Fire the internal hot-lead alert for THIS call. Returns true when an alert
 * was actually sent, false in every other case (gate off, not hot, already
 * alerted, no owner phone configured, send failed).
 *
 * @param {object} lead   { first_name, last_name, phone, city, requested_service,
 *                          urgency_reason, call_summary, lead_quality }
 * @param {object} ctx    the relay session tool ctx (callSid, ownerAlerted,
 *                        markOwnerAlerted, customerId)
 */
// ⭐ ONE PAGE PER CALL — DURABLY. The in-memory latch below is per
// RelayConversation, and a legitimate reconnect (Twilio retrying the socket
// with a freshly minted token) builds a NEW conversation with the latch clear:
// same CallSid, second page. The receipt therefore lives where the session
// claim already does — a jsonb key burned atomically on the call's own
// call_log row, one statement, exactly one winner. A send FAILURE releases the
// key so the retry rail stays open (the latch doctrine below, made durable).
// Fail-OPEN on a claim error: for an internal hot-lead page, a rare duplicate
// is safer than a missed swarm call.
// Two keys, because CLAIMED IS NOT DELIVERED: the claim is who owns the send,
// the sent receipt is proof the page went out. A losing claimant that treated
// the claim itself as coverage could tell its caller "the team was notified"
// while the winner's send failed and released — hot lead paged by nobody.
const HOT_ALERT_KEY = 'relay_hot_alert_at';
const HOT_ALERT_SENT_KEY = 'relay_hot_alert_sent_at';
// ⭐ THE CLAIM IS A LEASE, NOT A TOMBSTONE. A process that dies between the
// claim and the send (or the sent receipt) leaves claimed=true/sent=false
// forever — and every later session would wait, see no receipt, and refuse to
// page for the rest of time. A claim with no delivery receipt is therefore
// RECLAIMABLE once it is old enough that no live send can still be running;
// the reclaim is the same single-statement burn, so exactly one taker wins.
const HOT_ALERT_CLAIM_LEASE = "interval '2 minutes'";

async function claimHotAlertForCall(callSid) {
  const key = String(callSid || '').trim();
  if (!key) return { claimed: true, durable: false }; // no call row to claim on
  try {
    const db = require('../../models/db');
    const rows = await db('call_log')
      .where({ twilio_call_sid: key })
      .whereRaw(
        `((metadata->>'${HOT_ALERT_KEY}') IS NULL `
        + `OR ((metadata->>'${HOT_ALERT_SENT_KEY}') IS NULL `
        + `AND (metadata->>'${HOT_ALERT_KEY}')::timestamptz < now() - ${HOT_ALERT_CLAIM_LEASE}))`,
      )
      .update({
        metadata: db.raw(
          `jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${HOT_ALERT_KEY}}', to_jsonb(now()::text), true)`,
        ),
      })
      .returning('id');
    if (rows && rows.length > 0) return { claimed: true, durable: true };
    // No unclaimed row: either another session already claimed this call, or
    // there is no call_log row at all (nothing to dedupe against) — only the
    // former means "stand down".
    const exists = await db('call_log').where({ twilio_call_sid: key }).first('id');
    return exists ? { claimed: false, durable: true } : { claimed: true, durable: false };
  } catch (err) {
    logger.warn(`[voice-relay-alert] hot-alert claim failed for ${key} — paging anyway (fail-open): ${err.message}`);
    return { claimed: true, durable: false };
  }
}

async function markHotAlertSent(callSid) {
  const key = String(callSid || '').trim();
  if (!key) return;
  try {
    const db = require('../../models/db');
    await db('call_log')
      .where({ twilio_call_sid: key })
      .update({
        metadata: db.raw(
          `jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${HOT_ALERT_SENT_KEY}}', to_jsonb(now()::text), true)`,
        ),
      });
  } catch (err) {
    // The claim key still stands, so no duplicate page — a loser just cannot
    // confirm coverage and stays conservative about the promise.
    logger.warn(`[voice-relay-alert] hot-alert sent receipt failed for ${key}: ${err.message}`);
  }
}

async function hotAlertState(callSid) {
  const key = String(callSid || '').trim();
  if (!key) return null;
  try {
    const db = require('../../models/db');
    const row = await db('call_log').where({ twilio_call_sid: key }).first('metadata');
    const meta = row && (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);
    return {
      claimed: !!(meta && meta[HOT_ALERT_KEY]),
      sent: !!(meta && meta[HOT_ALERT_SENT_KEY]),
    };
  } catch {
    return null;
  }
}

async function releaseHotAlertClaim(callSid) {
  const key = String(callSid || '').trim();
  if (!key) return;
  try {
    const db = require('../../models/db');
    await db('call_log')
      .where({ twilio_call_sid: key })
      .update({ metadata: db.raw(`COALESCE(metadata, '{}'::jsonb) - '${HOT_ALERT_KEY}'`) });
  } catch (err) {
    logger.warn(`[voice-relay-alert] hot-alert claim release failed for ${key}: ${err.message}`);
  }
}

// The DISTINCTIVE per-call notification title — the delivery-level dedupe key.
// buildInternalAlertPayload honours options.notificationTitle verbatim, so this
// exact string lands on the notifications row and a retry after an AMBIGUOUS
// receipt failure (page delivered, receipt write lost) can probe for it instead
// of paging twice. The CallSid tail is an opaque id, not PII.
function hotAlertNotificationTitle(callSid) {
  const tail = String(callSid || '').slice(-8) || 'unknown';
  return `🚨 Hot lead — phone assistant call …${tail}`;
}

async function hotAlertAlreadyDelivered(callSid) {
  const key = String(callSid || '').trim();
  if (!key) return false;
  try {
    const db = require('../../models/db');
    const row = await db('notifications')
      .where({ category: 'alert' })
      .where('title', hotAlertNotificationTitle(key))
      .first('id');
    return !!row;
  } catch {
    return false; // unknown ⇒ page (a duplicate beats a missed swarm)
  }
}

async function alertOwnerHotLead(lead = {}, ctx = {}) {
  try {
    const { isContextEnabled } = require('./relay-context');
    if (!isContextEnabled()) return false;
    if (String(lead.lead_quality || '').toLowerCase() !== 'hot') return false;
    // One per CALL, never per turn. The session exposes a LIVE reader
    // (isOwnerAlerted) because the tool ctx is rebuilt each turn while two
    // capture_lead calls can land inside one turn; a plain `ownerAlerted`
    // boolean is honoured too so a test ctx stays simple.
    const alreadyAlerted = typeof ctx.isOwnerAlerted === 'function'
      ? ctx.isOwnerAlerted() === true
      : ctx.ownerAlerted === true;
    if (alreadyAlerted) return false;

    const to = ownerAlertPhone();
    if (!to) {
      logger.warn('[voice-relay-alert] hot lead captured but ADAM_PHONE is unset — no owner alert sent');
      return false;
    }

    // The durable one-per-CALL receipt (reconnects build a fresh session).
    let claim = await claimHotAlertForCall(ctx.callSid);
    if (!claim.claimed) {
      // Somebody else holds the claim — but CLAIMED IS NOT DELIVERED. Wait
      // briefly for their SENT receipt: present ⇒ this call is covered (latch
      // + true, the promise stands). Claim released mid-wait ⇒ their send
      // FAILED — take the claim over and page ourselves. Still claimed with
      // no receipt after the wait ⇒ report false WITHOUT the latch: the
      // caller is not promised a page nobody can prove, and a later
      // capture_lead on this session can try again.
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => { const t = setTimeout(r, 400); t.unref?.(); });
        const state = await hotAlertState(ctx.callSid);
        if (state && state.sent) {
          if (typeof ctx.markOwnerAlerted === 'function') ctx.markOwnerAlerted();
          logger.info(`[voice-relay-alert] hot-lead page already sent for callSid=${ctx.callSid} — not paging twice`);
          return true;
        }
        if (state && !state.claimed) {
          claim = await claimHotAlertForCall(ctx.callSid);
          break; // released — the winner failed; try to take over
        }
      }
      if (!claim.claimed) {
        logger.warn(
          `[voice-relay-alert] hot-lead claim held elsewhere with NO delivery receipt callSid=${ctx.callSid} `
          + '— not paging (no duplicate) and not confirming (no false promise)'
        );
        return false;
      }
    }

    const body = buildHotLeadAlert({
      firstName: lead.first_name,
      lastName: lead.last_name,
      phone: lead.phone,
      city: lead.city,
      requestedService: lead.requested_service,
      urgencyReason: lead.urgency_reason,
      summary: lead.call_summary,
      existingCustomer: Boolean(ctx.customerId),
    });

    // ⭐ THE DELIVERY-LEVEL DEDUPE. A page that was DELIVERED but whose sent
    // receipt failed to write leaves claimed-but-unsent — the lease expires and
    // the sweep would page again. The notification row IS delivery evidence:
    // probe for this call's distinctive title before sending, and a hit just
    // repairs the receipt instead of re-paging.
    if (await hotAlertAlreadyDelivered(ctx.callSid)) {
      if (claim.durable) await markHotAlertSent(ctx.callSid);
      if (typeof ctx.markOwnerAlerted === 'function') ctx.markOwnerAlerted();
      logger.info(`[voice-relay-alert] hot-lead page already delivered for callSid=${ctx.callSid} — receipt repaired, not paging twice`);
      return true;
    }

    // The SAME sender + messageType the self-booking confirm alert uses.
    const TwilioService = require('../twilio');
    const sent = await TwilioService.sendSMS(to, body, {
      messageType: 'internal_alert',
      // The dedupe key doubles as the bell title; the body carries the detail.
      notificationTitle: hotAlertNotificationTitle(ctx.callSid),
    });
    // ⭐ `success: true` IS NOT DELIVERY ON THIS PATH. The internal-alert
    // redirect (services/twilio.js redirectInternalAdminSmsToNotification)
    // returns success:true with `notificationUndelivered` / `notificationError`
    // when the bell/push write itself failed — it suppressed the SMS and had
    // nowhere to put the alert. Latching on that consumed the one-per-call
    // budget for an alert nobody ever saw, and blocked the retry that would
    // have paged the owner.
    if (!internalAlertDelivered(sent)) {
      logger.error(
        `[voice-relay-alert] hot-lead owner alert NOT delivered callSid=${ctx.callSid || 'n/a'} `
        + `(${sent && sent.notificationError ? 'notification error' : 'notification undelivered'}) — latch left open for a retry`
      );
      if (claim.durable) await releaseHotAlertClaim(ctx.callSid); // the retry rail stays open
      return false;
    }
    // ⭐ THE LATCH IS SET AFTER A SUCCESSFUL SEND, NOT BEFORE IT. Marking first
    // meant a transient Twilio/DB blip PERMANENTLY consumed the one-per-call
    // budget: the retry (or the second capture_lead) saw `alreadyAlerted` and
    // returned quietly, and the hot lead — a swarm, a sting, an angry customer —
    // was never paged at all. The failure path below now leaves the latch open
    // so the next attempt on this call can still get through, and the send
    // itself stays idempotent-by-latch once it succeeds.
    if (typeof ctx.markOwnerAlerted === 'function') ctx.markOwnerAlerted();
    // The durable DELIVERY receipt — what a losing claimant on a reconnect
    // needs to see before telling its caller the team was notified.
    if (claim.durable) await markHotAlertSent(ctx.callSid);
    logger.info(`[voice-relay-alert] hot-lead owner alert sent callSid=${ctx.callSid || 'n/a'} caller=${maskPhone(lead.phone)}`);
    return true;
  } catch (err) {
    // FAIL-OPEN, loudly: the lead is already written and the caller is still
    // on the line — an alert failure can never surface to either. The
    // one-per-call latch is deliberately NOT set here, so a later attempt on
    // this same call can still page the owner.
    logger.error(`[voice-relay-alert] hot-lead owner alert FAILED callSid=${ctx.callSid || 'n/a'}: ${err.message}`);
    // Give back the durable claim too — a failed page must stay retryable
    // across sessions, not just within this one.
    await releaseHotAlertClaim(ctx.callSid).catch(() => {});
    return false;
  }
}

/**
 * Build the owner-facing body for a voice-filed RE-SERVICE. Internal surface.
 */
function buildReserviceAlert({ lane, urgency, subject, issue, covered, requestId, unverifiedRequester, unverifiedNote }) {
  const lines = [
    `${urgency === 'urgent' ? '🚨 URGENT ' : ''}Re-service filed by the phone assistant`,
  ];
  // ⭐ SECOND LINE, ALWAYS, when the caller only matched a secondary contact
  // slot (spouse/tenant/prior occupant — relay-reservice's stamp). The body is
  // sliced to MAX_ALERT_BODY and the bell/push render truncates again, so a
  // warning further down could be cut off; this one cannot be.
  if (unverifiedRequester) {
    lines.push(`⚠️ ${alertSafe(unverifiedNote, 200)
      || 'UNVERIFIED third-party requester — verify identity before confirming.'}`);
  }
  lines.push(
    `Lane: ${alertSafe(lane, 20)}`,
    alertSafe(subject || issue, 200),
  );
  if (covered) lines.push('Covered by their plan (free re-service).');
  if (requestId) lines.push(`Request ${alertSafe(requestId, 40)}`);
  // The ticket queue is a known black hole — this alert IS the routing fix.
  lines.push('Get them on the schedule — do not leave this in the request queue.');
  return lines.join('\n').slice(0, MAX_ALERT_BODY);
}

/**
 * ⭐ OWNER-RULED: every voice-filed re-service pages the owner.
 *
 * routes/requests.js 409s a covered pest/lawn ticket because the ticket queue
 * is "a proven black hole — 14 requests, zero resolved". The voice agent must
 * still file the ticket (it is the durable record) and cannot use the
 * streamline's booking half (that fires customer comms, which the agent may
 * never do) — so the alert is what makes the ticket reach a human.
 *
 * Reuses the SAME internal sender as the hot-lead alert. Not idempotent-latched
 * like the hot-lead path: request_reservice already refuses to file a second
 * ticket in a lane, so one filed ticket is one alert by construction.
 *
 * Returns true when an alert was actually sent. Never throws.
 */
async function alertOwnerReservice(request = {}, ctx = {}) {
  try {
    const { isContextEnabled } = require('./relay-context');
    if (!isContextEnabled()) return false;
    const to = ownerAlertPhone();
    if (!to) {
      logger.warn('[voice-relay-alert] re-service filed but ADAM_PHONE is unset — no owner alert sent');
      return false;
    }
    const TwilioService = require('../twilio');
    const sent = await TwilioService.sendSMS(to, buildReserviceAlert(request), { messageType: 'internal_alert' });
    // Same success-is-not-delivery rule as the hot-lead path: the ticket is
    // durable either way, but an alert that never reached the bell must say so
    // (the whole point of this lane is reaching a human, not the queue).
    if (!internalAlertDelivered(sent)) {
      logger.error(
        `[voice-relay-alert] re-service owner alert NOT delivered callSid=${ctx.callSid || 'n/a'} `
        + `request=${request.requestId || 'n/a'} — the ticket is filed but unannounced`
      );
      return false;
    }
    logger.info(`[voice-relay-alert] re-service owner alert sent callSid=${ctx.callSid || 'n/a'} request=${request.requestId || 'n/a'}`);
    return true;
  } catch (err) {
    logger.error(`[voice-relay-alert] re-service owner alert FAILED callSid=${ctx.callSid || 'n/a'}: ${err.message}`);
    return false;
  }
}

/**
 * Hourly backstop for the crash window the lease alone cannot cover: the lease
 * makes an abandoned claim RECLAIMABLE, but the only reclaimer was the live
 * capture_lead path — and after the socket died, Twilio sent the caller to
 * voicemail, so nothing on that call ever claimed again and the hot lead
 * stayed unpaged. This sweep finds claimed-unsent call_log rows past the
 * lease, recovers the lead by its own twilio_call_sid, and re-fires the page
 * through alertOwnerHotLead (which re-takes the expired lease atomically —
 * concurrent rails still cannot double-page).
 */
async function sweepAbandonedHotAlerts({ limit = 10 } = {}) {
  const db = require('../../models/db');
  let rows = [];
  try {
    rows = await db('call_log')
      .whereRaw(`(metadata->>'${HOT_ALERT_KEY}') IS NOT NULL`)
      .whereRaw(`(metadata->>'${HOT_ALERT_SENT_KEY}') IS NULL`)
      .whereRaw(`(metadata->>'${HOT_ALERT_KEY}')::timestamptz < now() - ${HOT_ALERT_CLAIM_LEASE}`)
      .orderBy('created_at', 'asc')
      .limit(limit)
      .select('id', 'twilio_call_sid');
  } catch (err) {
    logger.error(`[voice-relay-alert] abandoned hot-alert sweep query failed: ${err.message}`);
    return 0;
  }
  let paged = 0;
  for (const row of rows) {
    let lead = null;
    try {
       
      lead = await db('leads')
        .where({ twilio_call_sid: row.twilio_call_sid })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .first('first_name', 'last_name', 'phone', 'city', 'lead_quality', 'transcript_summary');
    } catch { /* fall through to release */ }
    if (!lead || String(lead.lead_quality || '').toLowerCase() !== 'hot') {
      // Nothing hot to page (or no lead at all — the bell rang new_lead
      // regardless): release so the row leaves the sweep population.
       
      await releaseHotAlertClaim(row.twilio_call_sid).catch(() => {});
      continue;
    }
     
    const ok = await alertOwnerHotLead(
      { ...lead, call_summary: lead.transcript_summary, urgency_reason: 'recovered by the hot-alert sweep' },
      { callSid: row.twilio_call_sid },
    ).catch(() => false);
    if (ok) paged += 1;
  }
  if (rows.length) logger.info(`[voice-relay-alert] abandoned hot-alert sweep: ${rows.length} candidate(s), ${paged} paged`);
  return paged;
}

module.exports = {
  alertOwnerHotLead,
  sweepAbandonedHotAlerts,
  alertOwnerReservice,
  buildHotLeadAlert,
  buildReserviceAlert,
  ownerAlertPhone,
  MAX_ALERT_BODY,
};
