/**
 * SendGrid Event Webhook — fans out SendGrid delivery events onto
 * newsletter_send_deliveries and rolls up counters onto newsletter_sends.
 *
 * Mounted BEFORE express.json() in index.js because SendGrid's ECDSA
 * signature is computed over the raw request body.
 *
 * Setup (one-time, SendGrid UI):
 *   Settings → Mail Settings → Event Webhook
 *     POST URL: https://portal.wavespestcontrol.com/api/webhooks/sendgrid/events
 *     Enable: Processed, Delivered, Bounced, Blocked, Deferred, Dropped,
 *             Opened, Clicked, Spam Reports, Unsubscribe
 *     Signed Event Webhook: ON
 *   Copy the generated "Verification Key" → Railway env SENDGRID_WEBHOOK_PUBLIC_KEY
 *
 * Event docs: https://docs.sendgrid.com/for-developers/tracking-events/event
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const bounceRecovery = require('../services/email-bounce-recovery');

const SIG_HEADER = 'x-twilio-email-event-webhook-signature';
const TS_HEADER = 'x-twilio-email-event-webhook-timestamp';
const WEBHOOK_MAX_AGE_SECONDS = 5 * 60;
const NEWSLETTER_RETRYABLE_DELIVERY_STATUSES = ['queued', 'failed', 'sending'];

// Convert SendGrid's base64 SPKI public key to a Node KeyObject.
// Cached — key is static env input.
let cachedKey = null;
function getPublicKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  if (!raw) return null;
  try {
    cachedKey = crypto.createPublicKey({
      key: Buffer.from(raw, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return cachedKey;
  } catch (err) {
    logger.error(`[sendgrid-webhook] Failed to parse SENDGRID_WEBHOOK_PUBLIC_KEY: ${err.message}`);
    return null;
  }
}

function verifySignature(rawBody, timestamp, signature) {
  const pubKey = getPublicKey();
  if (!pubKey) return false;
  const payload = Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody]);
  try {
    return crypto.verify('sha256', payload, pubKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function isFreshTimestamp(timestamp, nowMs = Date.now()) {
  const n = Number(timestamp);
  if (!Number.isFinite(n)) return false;
  const tsMs = n > 1e12 ? n : n * 1000;
  return Math.abs(nowMs - tsMs) <= WEBHOOK_MAX_AGE_SECONDS * 1000;
}

function redactEmail(value) {
  if (!value || typeof value !== 'string') return '';
  const [local, domain] = value.split('@');
  if (!domain) return '[redacted]';
  return `${local.slice(0, 2)}***@${domain}`;
}

function deliveryEmailMismatchLogMessage(deliveryId, rowEmail, eventEmail) {
  return `[sendgrid-webhook] delivery_id ${deliveryId} matched but email mismatch (row=${redactEmail(rowEmail)} event=${redactEmail(eventEmail)}) - ignoring`;
}

function shouldMarkProcessedNewsletterDeliverySent(delivery, ev = {}) {
  const status = String(delivery?.status || '').toLowerCase();
  if (['queued', 'failed'].includes(status)) return true;
  if (status !== 'sending') return false;
  return sendAttemptTokenMatches(delivery, ev?.send_attempt_token);
}

function sendAttemptTokenMatches(delivery, attemptToken = null) {
  const rowToken = delivery?.send_attempt_token ? String(delivery.send_attempt_token) : null;
  const eventToken = attemptToken ? String(attemptToken) : null;
  return !!rowToken && !!eventToken && rowToken === eventToken;
}

function canUseDeliveryIdFallback(delivery, messageId, attemptToken = null) {
  if (!delivery) return false;
  if (!delivery.provider_message_id) {
    const rowToken = delivery.send_attempt_token ? String(delivery.send_attempt_token) : null;
    const eventToken = attemptToken ? String(attemptToken) : null;
    if (rowToken || eventToken) return !!rowToken && !!eventToken && rowToken === eventToken;
    return String(delivery.status || '').toLowerCase() !== 'sending';
  }
  if (String(delivery.provider_message_id) === String(messageId || '')) return true;
  return sendAttemptTokenMatches(delivery, attemptToken);
}

function canUseProviderMessageMatch(delivery, attemptToken = null) {
  if (!delivery?.send_attempt_token) return true;
  return sendAttemptTokenMatches(delivery, attemptToken);
}

async function bindNewsletterDeliveryMessageId(delivery, messageId, attemptToken = null, client = db) {
  if (!delivery || !messageId) return delivery;
  const providerMatches = delivery.provider_message_id
    && String(delivery.provider_message_id) === String(messageId);
  if (providerMatches) return delivery;

  const tokenMatches = sendAttemptTokenMatches(delivery, attemptToken);
  if (delivery.provider_message_id && !tokenMatches) return delivery;

  const bindQuery = client('newsletter_send_deliveries')
    .where({ id: delivery.id })
    .where((q) => {
      q.whereNull('provider_message_id').orWhere({ provider_message_id: messageId });
      if (tokenMatches) q.orWhere({ send_attempt_token: String(attemptToken) });
    });
  if (delivery.send_attempt_token || attemptToken) {
    bindQuery.where({ send_attempt_token: attemptToken || delivery.send_attempt_token });
  }
  const updated = await bindQuery.update({ provider_message_id: messageId, updated_at: new Date() });
  if (updated) return { ...delivery, provider_message_id: messageId };

  return client('newsletter_send_deliveries')
    .where({ id: delivery.id })
    .first();
}

function applyRetryableNewsletterDeliveryFilter(query) {
  return query
    .whereIn('status', NEWSLETTER_RETRYABLE_DELIVERY_STATUSES)
    .whereNull('sent_at')
    .whereNull('delivered_at')
    .whereNull('opened_at')
    .whereNull('clicked_at');
}

router.post('/events', express.raw({ type: '*/*' }), async (req, res) => {
  // Fail closed unless the public key is configured — we don't want anyone
  // POSTing fake bounces to suppress recipients.
  if (!process.env.SENDGRID_WEBHOOK_PUBLIC_KEY) {
    logger.error('[sendgrid-webhook] SENDGRID_WEBHOOK_PUBLIC_KEY not set — rejecting');
    return res.status(500).send('Webhook public key not configured');
  }

  const sig = Array.isArray(req.headers[SIG_HEADER]) ? req.headers[SIG_HEADER][0] : req.headers[SIG_HEADER];
  const ts = Array.isArray(req.headers[TS_HEADER]) ? req.headers[TS_HEADER][0] : req.headers[TS_HEADER];
  if (!sig || !ts) {
    logger.warn('[sendgrid-webhook] Missing signature headers — rejecting');
    return res.status(400).send('Missing signature headers');
  }
  if (!isFreshTimestamp(ts)) {
    logger.warn('[sendgrid-webhook] Stale signature timestamp — rejecting');
    return res.status(403).send('Stale signature timestamp');
  }
  if (!verifySignature(req.body, ts, sig)) {
    logger.warn('[sendgrid-webhook] Signature verification failed — rejecting');
    return res.status(403).send('Invalid signature');
  }

  let events;
  try {
    events = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }
  if (!Array.isArray(events)) return res.status(400).send('Expected event array');

  // Process every event. We don't fail the whole batch on one bad row —
  // SendGrid will retry the entire batch on non-2xx, so partial failures
  // would double-apply the good rows.
  let processed = 0;
  for (const ev of events) {
    try {
      await handleEvent(ev);
      processed++;
    } catch (err) {
      logger.error(`[sendgrid-webhook] event ${ev.sg_event_id || '?'} (${ev.event}) failed: ${err.message}`);
    }
  }
  res.status(200).json({ received: events.length, processed });
});

async function handleEvent(ev) {
  const messageId = ev.sg_message_id ? ev.sg_message_id.split('.')[0] : null;
  if (!messageId) return;
  const email = ev.email || null;

  // Events can belong to a newsletter broadcast delivery, an automation
  // step send, or neither (transactional sends we don't track). Try each
  // table by (message id, email): batched newsletter sends share the same
  // X-Message-Id across all recipients in a chunk, so the lookup MUST also
  // filter by email — otherwise events for recipient B silently update
  // recipient A's row.
  //
  // Fallback: SendGrid echoes our per-recipient `custom_args.delivery_id`
  // on every event for that recipient. When the X-Message-Id is unknown
  // to us (lost-response case: our sendBatch POST timed out before reading
  // the X-Message-Id header, so the row was marked 'failed' with no id),
  // the delivery_id lets the event still find its home and self-heal the
  // row. Only trust the fallback for unbound rows, rows already bound to the
  // same message id, or a token-matched resume attempt that needs to replace
  // an older message id; otherwise a delayed event from an earlier resume
  // attempt could mutate the current attempt. Backfill the provider_message_id
  // while we're here so subsequent events hit the fast path.
  let newsletterDelivery = email ? await db('newsletter_send_deliveries')
    .where({ provider_message_id: messageId, email })
    .first() : null;
  if (newsletterDelivery && !canUseProviderMessageMatch(newsletterDelivery, ev.send_attempt_token)) {
    newsletterDelivery = null;
  }
  if (!newsletterDelivery && ev.delivery_id) {
    newsletterDelivery = await db('newsletter_send_deliveries')
      .where({ id: String(ev.delivery_id) })
      .first();
    if (newsletterDelivery && !canUseDeliveryIdFallback(newsletterDelivery, messageId, ev.send_attempt_token)) {
      newsletterDelivery = null;
    } else if (newsletterDelivery && newsletterDelivery.email && email
        && String(newsletterDelivery.email).toLowerCase() !== String(email).toLowerCase()) {
      // Email mismatch on a delivery_id match → reject; treat as untracked
      // rather than corrupt an unrelated row. Should never happen unless
      // an event payload was tampered with.
      logger.warn(deliveryEmailMismatchLogMessage(ev.delivery_id, newsletterDelivery.email, email));
      newsletterDelivery = null;
    } else if (newsletterDelivery && messageId
        && String(newsletterDelivery.provider_message_id || '') !== String(messageId)) {
      const boundDelivery = await bindNewsletterDeliveryMessageId(newsletterDelivery, messageId, ev.send_attempt_token);
      newsletterDelivery = canUseDeliveryIdFallback(boundDelivery, messageId, ev.send_attempt_token) ? boundDelivery : null;
    }
  }
  // Automation step sends are always single-recipient (one customer per
  // step), so message id alone is unique there. Belt-and-suspenders email
  // filter anyway.
  const automationSend = !newsletterDelivery ? await db('automation_step_sends')
    .where({ sendgrid_message_id: messageId })
    .first() : null;
  let emailMessage = !newsletterDelivery && !automationSend
    ? await db('email_messages')
      .where({ provider_message_id: messageId })
      .modify((q) => {
        if (email) q.whereRaw('LOWER(recipient_email_snapshot) = ?', [String(email).toLowerCase()]);
      })
      .first()
    : null;
  // Fallback: tracked sends carry custom_args.email_message_id (+ send_attempt_token),
  // echoed on every event. If the X-Message-Id isn't bound yet (a webhook can race
  // the post-send provider_message_id write), resolve the row by that id and backfill.
  // SAFETY: a retried idempotent send reuses the same email_messages.id with a NEW
  // provider id + NEW attempt token, so accept the fallback only when the row is
  // already bound to THIS event's message id, OR it is unbound AND the event's
  // send_attempt_token matches the row's current token. Otherwise a delayed event
  // from a prior attempt could mis-terminalize the row or mis-trigger recovery.
  if (!emailMessage && !newsletterDelivery && !automationSend && ev.email_message_id) {
    const candidate = await db('email_messages')
      .where({ id: String(ev.email_message_id) })
      .modify((q) => {
        if (email) q.whereRaw('LOWER(recipient_email_snapshot) = ?', [String(email).toLowerCase()]);
      })
      .first()
      .catch(() => null);
    const boundHere = candidate?.provider_message_id
      && String(candidate.provider_message_id) === String(messageId || '');
    const tokenMatches = candidate?.send_attempt_token && ev.send_attempt_token
      && String(candidate.send_attempt_token) === String(ev.send_attempt_token);
    const acceptable = candidate && (boundHere || (!candidate.provider_message_id && tokenMatches));
    if (acceptable && boundHere) {
      emailMessage = candidate;
    } else if (acceptable && messageId) {
      // Unbound + token matched the snapshot. Re-assert the token IN the backfill
      // so a retry that reclaimed the row (and changed send_attempt_token) between
      // the read above and this write can't have a stale event bind onto it. If
      // the guarded update touches 0 rows, the row was superseded — treat as
      // untracked and ignore this event.
      const bound = await db('email_messages')
        .where({ id: candidate.id, send_attempt_token: ev.send_attempt_token })
        .whereNull('provider_message_id')
        .update({ provider_message_id: messageId, updated_at: new Date() })
        .catch(() => 0);
      if (Number(bound) > 0) {
        emailMessage = { ...candidate, provider_message_id: messageId };
      } else {
        // 0 rows: either the row was superseded (token changed) OR the sender bound
        // the SAME provider_message_id concurrently between our read and write.
        // Reread and accept only if it is now bound to THIS event's message id, so a
        // genuine hard bounce isn't dropped — but a superseded/other-id row still is.
        const reread = await db('email_messages').where({ id: candidate.id }).first().catch(() => null);
        if (reread && String(reread.provider_message_id || '') === String(messageId || '')) {
          emailMessage = reread;
        }
      }
    }
  }

  // Hard-bounce feedback for sends OUTSIDE the email_messages ledger
  // (newsletter confirmation, automation one-offs, fully untracked sends).
  // attemptRecovery below can only repair tracked messages; without this, an
  // untracked bounce creates its suppression silently and the dead address is
  // discovered hours later when an estimate send hits it. The service alerts
  // ONLY when the address is on file for a customer/open lead, which filters
  // marketing-list cruft. Fire-and-forget for the same batch-stall reason as
  // attemptRecovery; the 168h notification dedupe absorbs webhook redeliveries.
  const alertUntrackedHardBounce = () => {
    if (!bounceRecovery.isHardBounceEvent(ev)) return;
    bounceRecovery.alertBouncedContactAddress(email, ev)
      .catch((err) => logger.error(`[sendgrid-webhook] bounced-contact alert failed: ${err.message}`));
  };

  if (newsletterDelivery) {
    // Fire the alert only when the event was NEWLY processed — a SendGrid
    // redelivery must not re-run the side effect (mirrors the emailMessage
    // branch below); the notification dedupe + idempotent lead stamp remain
    // the backstop for the fully-untracked branch, which has no event ledger.
    const processedNew = await processWebhookEvent(ev, messageId, email, (trx) => handleNewsletterEvent(ev, newsletterDelivery, trx));
    if (processedNew) alertUntrackedHardBounce();
    return;
  }
  if (automationSend) {
    const processedNew = await processWebhookEvent(ev, messageId, email, (trx) => handleAutomationEvent(ev, automationSend, trx));
    if (processedNew) alertUntrackedHardBounce();
    return;
  }
  if (emailMessage) {
    const processedNew = await processWebhookEvent(ev, messageId, email, (trx) => handleEmailMessageEvent(ev, emailMessage, trx));
    // Bounce recovery runs AFTER the event transaction commits, only when the
    // event was newly processed (so a SendGrid redelivery can't re-trigger it).
    // It does a network re-send (sendgrid.sendOne), so dispatch it WITHOUT
    // awaiting — a slow Mail Send must not hold the /events request open and
    // stall the rest of the batch (SendGrid would retry the whole batch even
    // though this event is already marked processed). Best-effort, fire-and-forget.
    // Tracked bounces are NOT routed through alertBouncedContactAddress —
    // attemptRecovery has its own richer alert (alertUnrecoverableBounce).
    if (processedNew) {
      if (bounceRecovery.isHardBounceEvent(ev)) {
        bounceRecovery.attemptRecovery(emailMessage, ev)
          .catch((err) => logger.error(`[sendgrid-webhook] bounce recovery failed for ${messageId}: ${err.message}`));
      } else if (String(ev.event || '').toLowerCase() === 'delivered' && bounceRecovery.isRecoveryMessage(emailMessage)) {
        bounceRecovery.commitRecoveryOnDelivery(emailMessage)
          .catch((err) => logger.error(`[sendgrid-webhook] recovery commit failed for ${messageId}: ${err.message}`));
      }
    }
    return;
  }
  // Fully untracked send (direct sendgrid.sendOne callers) — no ledger row to
  // update, but a suppression-worthy event must still land in
  // email_suppressions (the template-library send gate reads it; without this
  // future sends keep attempting the dead address) and a hard bounce on an
  // operational contact must reach a human. recordEmailSuppressionForEvent is
  // idempotent (update-else-insert), so webhook redeliveries are safe even
  // without the event ledger.
  // HARD BOUNCES ONLY: a dead mailbox is dead for every stream, so the
  // null-group (global) suppression this records is correct. Group-scoped
  // events (unsubscribes, spam reports) are skipped here — without the
  // send's stream context a null group_key would make a newsletter opt-out
  // block unrelated transactional email.
  if (bounceRecovery.isHardBounceEvent(ev)) {
    try {
      await recordEmailSuppressionForEvent(ev, null, null, eventOccurredAt(ev));
    } catch (err) {
      logger.error(`[sendgrid-webhook] untracked suppression record failed: ${err.message}`);
    }
  }
  alertUntrackedHardBounce();
  return;
}

// Returns true when this call actually processed the event (handler ran), false
// when it was a deduped redelivery. Callers use this to fire post-commit side
// effects (e.g. bounce recovery) exactly once per event.
async function processWebhookEvent(ev, messageId, email, handler) {
  const eventId = ev.sg_event_id ? String(ev.sg_event_id) : null;
  if (!eventId) {
    await handler(db);
    return true;
  }

  let processed = false;
  await db.transaction(async (trx) => {
    const inserted = await trx('sendgrid_webhook_events')
      .insert({
        event_id: eventId,
        event_type: ev.event || null,
        message_id: messageId,
        email: email || null,
        status: 'processing',
      })
      .onConflict('event_id')
      .ignore()
      .returning('event_id');

    if (!inserted.length) return;

    await handler(trx);
    await trx('sendgrid_webhook_events')
      .where({ event_id: eventId })
      .update({
        status: 'processed',
        processed_at: new Date(),
        updated_at: new Date(),
      });
    processed = true;
  });
  return processed;
}

/**
 * Pure function: maps a SendGrid event + the matched delivery row to a
 * structured updates plan. Extracted so the per-event logic is unit-
 * testable without a DB; the handler below performs the actual writes.
 *
 * Returns null when the event is a no-op for our state (already delivered,
 * already bounced, etc., or an event type we ignore like 'processed').
 *
 * Update shape:
 *   delivery       — fields to write to newsletter_send_deliveries
 *   sendIncrement  — column on newsletter_sends to increment by 1
 *   reconcileSendStatus — re-check failed parent send when a delivery leaves
 *     the retryable set via webhook self-heal
 *   subscriberAction — one of:
 *     'bounce_increment'    bounce_count++ + last_bounced_at
 *     'force_unsubscribe'   status='unsubscribed' regardless of prior state
 *     'unsubscribe_if_active' status='unsubscribed' UNLESS already unsubbed
 *   subscriberAt   — timestamp to use for the subscriber-side write
 */
function computeNewsletterEventUpdates(ev, delivery, now = new Date()) {
  const event = String(ev?.event || '').toLowerCase();
  const reason = String(ev?.reason || ev?.response || ev?.type || '').trim().toLowerCase();
  if (event === 'dropped' && (reason === 'group unsubscribe' || reason === 'unsubscribed address')) {
    if (delivery.unsubscribed_at) return null;
    return {
      delivery: { status: 'unsubscribed', unsubscribed_at: now, updated_at: now },
      sendIncrement: 'unsubscribed_count',
      reconcileSendStatus: true,
      subscriberAction: delivery.subscriber_id ? 'unsubscribe_if_active' : null,
      subscriberAt: now,
    };
  }
  if (event === 'dropped' && reason === 'spam reporting address') {
    if (delivery.complained_at) return null;
    return {
      delivery: { status: 'complained', complained_at: now, updated_at: now },
      sendIncrement: 'complained_count',
      reconcileSendStatus: true,
      subscriberAction: delivery.subscriber_id ? 'force_unsubscribe' : null,
      subscriberAt: now,
    };
  }

  switch (ev.event) {
    case 'delivered':
      if (delivery.delivered_at) return null;
      return {
        delivery: { status: 'delivered', delivered_at: now, updated_at: now },
        sendIncrement: 'delivered_count',
        reconcileSendStatus: true,
      };

    case 'bounce':
    case 'blocked':
    case 'dropped':
      if (delivery.bounced_at) return null;
      return {
        delivery: {
          status: 'bounced',
          bounced_at: now,
          bounce_reason: (ev.reason || ev.response || ev.type || '').toString().slice(0, 500),
          updated_at: now,
        },
        sendIncrement: 'bounced_count',
        reconcileSendStatus: true,
        subscriberAction: delivery.subscriber_id ? 'bounce_increment' : null,
        subscriberAt: now,
      };

    case 'open':
      if (delivery.opened_at) return null;
      // Don't downgrade status once delivered — only stamp the timestamp.
      return {
        delivery: { opened_at: now, updated_at: now },
        sendIncrement: 'opened_count',
        reconcileSendStatus: true,
      };

    case 'click':
      if (delivery.clicked_at) return null;
      return {
        delivery: { clicked_at: now, updated_at: now },
        sendIncrement: 'clicked_count',
        reconcileSendStatus: true,
      };

    case 'spamreport':
      if (delivery.complained_at) return null;
      // Complaint = auto-unsubscribe (sender-reputation defense). Force
      // path so a previously-active subscriber gets flipped even if they
      // somehow re-subscribed in the same window.
      return {
        delivery: { status: 'complained', complained_at: now, updated_at: now },
        sendIncrement: 'complained_count',
        reconcileSendStatus: true,
        subscriberAction: delivery.subscriber_id ? 'force_unsubscribe' : null,
        subscriberAt: now,
      };

    case 'unsubscribe':
    case 'group_unsubscribe':
      // Primary unsub path is our own token endpoint; this catches SendGrid-
      // initiated unsubs (rare — we disable subscription_tracking). Only
      // flip if not already unsubbed so the unsubscribed_at timestamp
      // captures the FIRST unsub, not subsequent re-fires.
      if (delivery.unsubscribed_at) return null;
      return {
        delivery: { unsubscribed_at: now, updated_at: now },
        sendIncrement: 'unsubscribed_count',
        subscriberAction: delivery.subscriber_id ? 'unsubscribe_if_active' : null,
        subscriberAt: now,
      };

    case 'processed':
      if (shouldMarkProcessedNewsletterDeliverySent(delivery, ev)) {
        return {
          delivery: { status: 'sent', sent_at: now, updated_at: now },
          reconcileSendStatus: true,
        };
      }
      return null;

    case 'deferred':
    case 'group_resubscribe':
    default:
      // deferred = temporary fail, SG will retry — don't update row
      // group_resubscribe = we don't use SG groups
      return null;
  }
}

function eventOccurredAt(ev, fallback = new Date()) {
  const ts = Number(ev?.timestamp);
  if (!Number.isFinite(ts)) return fallback;
  return new Date(ts > 1e12 ? ts : ts * 1000);
}

function computeEmailMessageEventUpdates(ev, message, now = new Date()) {
  switch (ev.event) {
    case 'delivered':
      if (message.delivered_at) return null;
      return { status: 'delivered', delivered_at: now, updated_at: now };

    case 'open':
      if (message.opened_at) return null;
      return { opened_at: now, updated_at: now };

    case 'click':
      if (message.clicked_at) return null;
      return { clicked_at: now, updated_at: now };

    case 'bounce':
    case 'blocked':
    case 'dropped':
      if (message.bounced_at) return null;
      return {
        status: ev.event === 'bounce' ? 'bounced' : ev.event,
        bounced_at: now,
        error_message: (ev.reason || ev.response || ev.type || '').toString().slice(0, 1000),
        updated_at: now,
      };

    case 'spamreport':
      if (message.complained_at) return null;
      return { status: 'spam_report', complained_at: now, updated_at: now };

    case 'unsubscribe':
    case 'group_unsubscribe':
      return { status: 'unsubscribed', updated_at: now };

    case 'processed':
    case 'deferred':
    case 'group_resubscribe':
    default:
      return null;
  }
}

function suppressionForEmailEvent(ev, groupKey = null) {
  const event = String(ev?.event || '').toLowerCase();
  const reason = String(ev?.reason || ev?.response || ev?.type || '').trim().toLowerCase();
  if (event === 'spamreport') {
    return { suppression_type: 'spam_complaint', group_key: null };
  }
  if (event === 'unsubscribe') {
    return { suppression_type: 'unsubscribe', group_key: null };
  }
  if (event === 'group_unsubscribe') {
    return { suppression_type: 'unsubscribe', group_key: groupKey || null };
  }
  if (event === 'bounce') {
    const type = String(ev?.type || '').trim().toLowerCase();
    if (!type || type === 'bounce' || type === 'hard') {
      return { suppression_type: 'bounce', group_key: null };
    }
  }
  if (event === 'dropped') {
    if (reason === 'group unsubscribe') {
      return groupKey ? { suppression_type: 'unsubscribe', group_key: groupKey } : null;
    }
    if (reason === 'unsubscribed address') {
      return { suppression_type: 'unsubscribe', group_key: null };
    }
    if (reason === 'spam reporting address') {
      return { suppression_type: 'spam_complaint', group_key: null };
    }
    if (reason === 'bounced address' || reason === 'invalid') {
      return { suppression_type: 'bounce', group_key: null };
    }
  }
  return null;
}

function automationSuppressionGroupKeyForEvent(ev) {
  const event = String(ev?.event || '').toLowerCase();
  const reason = String(ev?.reason || ev?.response || ev?.type || '').trim().toLowerCase();
  if (event !== 'group_unsubscribe' && !(event === 'dropped' && reason === 'group unsubscribe')) return null;
  const gid = String(ev?.asm_group_id || '');
  if (gid && gid === String(process.env.SENDGRID_ASM_GROUP_NEWSLETTER || '')) return 'marketing_newsletter';
  if (gid && gid === String(process.env.SENDGRID_ASM_GROUP_SERVICE || '')) return 'service_operational';
  return null;
}

async function groupKeyForEmailMessage(message, client = db) {
  if (
    Object.prototype.hasOwnProperty.call(message || {}, 'suppression_group_key_snapshot') &&
    message.suppression_group_key_snapshot !== null
  ) {
    const snapshot = String(message.suppression_group_key_snapshot || '').trim();
    return snapshot || null;
  }
  if (!message?.template_id) return null;
  const template = await client('email_templates')
    .where({ id: message.template_id })
    .first('suppression_group_key', 'send_stream');
  return template?.suppression_group_key || template?.send_stream || null;
}

async function recordEmailSuppressionForEvent(ev, message, groupKey, at, client = db) {
  const email = String(ev?.email || message?.recipient_email_snapshot || '').trim().toLowerCase();
  if (!email) return;
  const suppression = suppressionForEmailEvent(ev, groupKey);
  if (!suppression) return;

  const metadata = {
    provider: 'sendgrid',
    provider_event_id: ev.sg_event_id || null,
    event_type: ev.event || null,
    reason: ev.reason || ev.response || ev.type || null,
    asm_group_id: ev.asm_group_id || null,
    email_message_id: message?.id || null,
  };

  const existingQuery = client('email_suppressions')
    .whereRaw('LOWER(email) = ?', [email])
    .where({
      status: 'active',
      suppression_type: suppression.suppression_type,
    });
  if (suppression.group_key) existingQuery.where({ group_key: suppression.group_key });
  else existingQuery.whereNull('group_key');
  const existing = await existingQuery.first();

  if (existing) {
    await client('email_suppressions').where({ id: existing.id }).update({
      source: 'sendgrid_event_webhook',
      metadata: client.raw('COALESCE(metadata, \'{}\'::jsonb) || ?::jsonb', [JSON.stringify(metadata)]),
      updated_at: at,
    });
    return;
  }

  await client('email_suppressions').insert({
    email,
    group_key: suppression.group_key,
    suppression_type: suppression.suppression_type,
    status: 'active',
    source: 'sendgrid_event_webhook',
    suppressed_at: at,
    metadata: JSON.stringify(metadata),
    created_at: at,
    updated_at: at,
  });
}

async function handleEmailMessageEvent(ev, message, client = db) {
  const now = eventOccurredAt(ev);
  await client('email_message_events').insert({
    email_message_id: message.id,
    provider: 'sendgrid',
    provider_event_id: ev.sg_event_id || null,
    event_type: ev.event || 'unknown',
    raw_event: JSON.stringify(ev || {}),
    occurred_at: now,
  });

  const updates = computeEmailMessageEventUpdates(ev, message, now);
  if (updates) await client('email_messages').where({ id: message.id }).update(updates);
  const groupKey = await groupKeyForEmailMessage(message, client);
  await recordEmailSuppressionForEvent(ev, message, groupKey, now, client);
}

async function handleNewsletterEvent(ev, delivery, client = db) {
  const updates = computeNewsletterEventUpdates(ev, delivery);
  if (!updates) return;

  if (updates.delivery) {
    await client('newsletter_send_deliveries').where({ id: delivery.id }).update(updates.delivery);
  }
  if (updates.reconcileSendStatus) {
    await reconcileNewsletterSendStatus(delivery.send_id, client);
  }
  if (updates.sendIncrement) {
    await client('newsletter_sends').where({ id: delivery.send_id }).increment(updates.sendIncrement, 1);
  }
  if (updates.subscriberAction && delivery.subscriber_id) {
    const at = updates.subscriberAt;
    if (updates.subscriberAction === 'bounce_increment') {
      await client('newsletter_subscribers').where({ id: delivery.subscriber_id }).update({
        bounce_count: client.raw('COALESCE(bounce_count,0) + 1'),
        last_bounced_at: at,
        updated_at: at,
      });
    } else if (updates.subscriberAction === 'force_unsubscribe') {
      await client('newsletter_subscribers').where({ id: delivery.subscriber_id }).update({
        status: 'unsubscribed',
        unsubscribed_at: at,
        updated_at: at,
      });
    } else if (updates.subscriberAction === 'unsubscribe_if_active') {
      await client('newsletter_subscribers')
        .where({ id: delivery.subscriber_id })
        .whereNot({ status: 'unsubscribed' })
        .update({
          status: 'unsubscribed',
          unsubscribed_at: at,
          updated_at: at,
        });
    }
  }

  // Record the suppression ledger entry for provider events that should block
  // future app sends. Runs even when there's no matching subscriber row; the
  // address/provider signal is still valid. SendGrid's newsletter ASM group is
  // local `marketing_newsletter`, while bounces/spam complaints stay GLOBAL.
  const newsletterGroupKey = newsletterSuppressionGroupKeyForEvent(ev);
  if (shouldRecordNewsletterSuppression(ev, newsletterGroupKey)) {
    await recordEmailSuppressionForEvent(
      ev,
      { recipient_email_snapshot: delivery.email || null },
      newsletterGroupKey,
      updates.subscriberAt || new Date(),
      client,
    );
  }
}

function newsletterSuppressionGroupKeyForEvent(ev) {
  const event = String(ev?.event || '').toLowerCase();
  const reason = String(ev?.reason || ev?.response || ev?.type || '').trim().toLowerCase();
  if (event === 'group_unsubscribe' || (event === 'dropped' && reason === 'group unsubscribe')) {
    return automationSuppressionGroupKeyForEvent({ event: 'group_unsubscribe', asm_group_id: ev?.asm_group_id })
      || 'marketing_newsletter';
  }
  return null;
}

function shouldRecordNewsletterSuppression(ev, groupKey = null) {
  return !!suppressionForEmailEvent(ev, groupKey);
}

/**
 * Same event shape as newsletter, but the row lives in automation_step_sends.
 * Plus: on hard unsub / spam / bounce events we cancel any still-active
 * enrollment for that email so the sequence doesn't keep ticking. Group
 * unsubscribes only cancel enrollments whose template's asm_group matches.
 */
async function handleAutomationEvent(ev, sendRow, client = db) {
  const now = new Date();
  const newsletterUnsubscribe = () => unsubscribeNewsletterSubscriber(ev.email, now, client);
  const automationGroupKey = automationSuppressionGroupKeyForEvent(ev);
  if (ev.event !== 'group_unsubscribe' || automationGroupKey) {
    await recordEmailSuppressionForEvent(ev, null, automationGroupKey, now, client);
  }

  switch (ev.event) {
    case 'delivered':
      if (!sendRow.delivered_at) {
        await client('automation_step_sends').where({ id: sendRow.id }).update({
          status: 'delivered', delivered_at: now, updated_at: now,
        });
      }
      break;

    case 'open':
      if (!sendRow.opened_at) {
        await client('automation_step_sends').where({ id: sendRow.id }).update({
          opened_at: now, updated_at: now,
        });
      }
      break;

    case 'click':
      if (!sendRow.clicked_at) {
        await client('automation_step_sends').where({ id: sendRow.id }).update({
          clicked_at: now, updated_at: now,
        });
      }
      break;

    case 'bounce':
    case 'blocked':
    case 'dropped':
      await client('automation_step_sends').where({ id: sendRow.id }).update({
        status: 'bounced',
        failure_reason: (ev.reason || ev.response || ev.type || '').toString().slice(0, 500),
        updated_at: now,
      });
      // Cancel active enrollments only on TRUE hard bounce (ev.type='bounce').
      // SendGrid 'blocked' = receiver-side rate-limit / IP block (transient,
      // often recoverable on retry). 'dropped' = SG never sent it because
      // the address was already suppressed — no signal that the address is
      // bad, just that we already knew. Cancelling on either was destructive
      // since enrollment.status='cancelled' is terminal.
      if (ev.type === 'bounce') {
        await cancelActiveEnrollments({ email: ev.email, reason: 'hard_bounce' }, client);
      }
      break;

    case 'spamreport':
      await client('automation_step_sends').where({ id: sendRow.id }).update({
        status: 'complained', updated_at: now,
      });
      // Complaint → cancel everything + mark newsletter sub unsubscribed.
      await cancelActiveEnrollments({ email: ev.email, reason: 'spam_report' }, client);
      await newsletterUnsubscribe();
      break;

    case 'unsubscribe':
      // Global unsub — cancel every active enrollment for this email.
      await cancelActiveEnrollments({ email: ev.email, reason: 'unsubscribe' }, client);
      await newsletterUnsubscribe();
      break;

    case 'group_unsubscribe': {
      // Group unsub — cancel enrollments where template.asm_group maps to the
      // unsubscribed ASM group id. Newsletter group = promotional; service
      // group = transactional (shouldn't normally unsub but we honor it).
      const gid = String(ev.asm_group_id || '');
      const newsletterGid = String(process.env.SENDGRID_ASM_GROUP_NEWSLETTER || '');
      const serviceGid = String(process.env.SENDGRID_ASM_GROUP_SERVICE || '');
      let asmGroupToCancel = null;
      if (gid && gid === newsletterGid) asmGroupToCancel = 'newsletter';
      else if (gid && gid === serviceGid) asmGroupToCancel = 'service';
      if (asmGroupToCancel) {
        await cancelActiveEnrollments({ email: ev.email, reason: 'group_unsubscribe', asmGroup: asmGroupToCancel }, client);
        if (asmGroupToCancel === 'newsletter') await newsletterUnsubscribe();
      }
      break;
    }

    case 'processed':
    case 'deferred':
    case 'group_resubscribe':
    default:
      break;
  }
}

async function unsubscribeNewsletterSubscriber(email, at, client = db) {
  if (!email) return;
  const lc = String(email).trim().toLowerCase();
  await client('newsletter_subscribers')
    .whereRaw('LOWER(email) = ?', [lc])
    .whereNot({ status: 'unsubscribed' })
    .update({
      status: 'unsubscribed',
      unsubscribed_at: at,
      updated_at: at,
    });
}

async function reconcileNewsletterSendStatus(sendId, client = db) {
  const outstanding = await applyRetryableNewsletterDeliveryFilter(
    client('newsletter_send_deliveries').where({ send_id: sendId }),
  )
    .count('* as c')
    .first();
  if (Number(outstanding?.c || 0) > 0) return;

  await client('newsletter_sends')
    .where({ id: sendId, status: 'failed' })
    .update({ status: 'sent', updated_at: new Date() });
}

async function cancelActiveEnrollments({ email, reason, asmGroup }, client = db) {
  if (!email) return;
  const lc = String(email).trim().toLowerCase();
  let q = client('automation_enrollments as e')
    .join('automation_templates as t', 't.key', 'e.template_key')
    .whereRaw('LOWER(e.email) = ?', [lc])
    .where('e.status', 'active');
  if (asmGroup) q = q.where('t.asm_group', asmGroup);

  const rows = await q.select('e.id', 't.key as template_key');
  if (!rows.length) return;

  const ids = rows.map((r) => r.id);
  await client('automation_enrollments').whereIn('id', ids).update({
    status: 'cancelled',
    next_send_at: null,
    completed_at: new Date(),
    metadata: client.raw("jsonb_set(COALESCE(metadata,'{}'::jsonb), '{cancel_reason}', ?::jsonb, true)", [JSON.stringify(reason)]),
    updated_at: new Date(),
  });
  logger.info(`[sendgrid-webhook] cancelled ${rows.length} enrollment(s) for ${redactEmail(email)} reason=${reason}${asmGroup ? ` group=${asmGroup}` : ''}`);
}

// Default export is the Express router; the pure event-mapping function
// is hung off as a property so the test suite can exercise it directly.
module.exports = router;
module.exports.computeNewsletterEventUpdates = computeNewsletterEventUpdates;
module.exports.computeEmailMessageEventUpdates = computeEmailMessageEventUpdates;
module.exports.suppressionForEmailEvent = suppressionForEmailEvent;
module.exports.automationSuppressionGroupKeyForEvent = automationSuppressionGroupKeyForEvent;
module.exports.isFreshTimestamp = isFreshTimestamp;
module.exports.deliveryEmailMismatchLogMessage = deliveryEmailMismatchLogMessage;
module.exports.canUseDeliveryIdFallback = canUseDeliveryIdFallback;
module.exports.canUseProviderMessageMatch = canUseProviderMessageMatch;
module.exports.bindNewsletterDeliveryMessageId = bindNewsletterDeliveryMessageId;
module.exports.reconcileNewsletterSendStatus = reconcileNewsletterSendStatus;
module.exports.handleNewsletterEvent = handleNewsletterEvent;
module.exports.newsletterSuppressionGroupKeyForEvent = newsletterSuppressionGroupKeyForEvent;
module.exports.shouldRecordNewsletterSuppression = shouldRecordNewsletterSuppression;
