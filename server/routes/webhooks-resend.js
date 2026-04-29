/**
 * Resend Event Webhook — placeholder, wired for future migration.
 *
 * Mirror of webhooks-sendgrid.js but for Resend.com. The newsletter
 * sender currently ships through SendGrid; the schema column
 * `provider_message_id` (was `resend_message_id` until 20260429000003)
 * is intentionally provider-neutral so a switch back to Resend wouldn't
 * require another rename. When NewsletterSender flips its provider,
 * this webhook is already in place and will start populating
 * opens/clicks/bounces on the same `newsletter_send_deliveries` rows.
 *
 * Mounted BEFORE express.json() in index.js because Resend's webhook
 * signature (Svix-format HMAC-SHA256) is computed over the raw body.
 *
 * Setup (one-time, when migrating):
 *   Resend → Webhooks → Add Endpoint
 *     URL:    https://portal.wavespestcontrol.com/api/webhooks/resend/events
 *     Events: email.delivered, email.bounced, email.complained,
 *             email.delivery_delayed, email.opened, email.clicked
 *   Copy the generated "Signing Secret" (whsec_...) → Railway env
 *   RESEND_WEBHOOK_SECRET
 *
 * Event docs: https://resend.com/docs/dashboard/webhooks/event-types
 * Svix verification: https://docs.svix.com/receiving/verifying-payloads/how-manual
 *
 * Until RESEND_WEBHOOK_SECRET is set, the route fails closed with 503
 * — Resend will retry the same batch with backoff, so flipping the
 * env on later picks up missed deliveries automatically.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');

const SVIX_ID = 'svix-id';
const SVIX_TIMESTAMP = 'svix-timestamp';
const SVIX_SIGNATURE = 'svix-signature';

function verifySignature(rawBody, headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;
  const id = headers[SVIX_ID];
  const ts = headers[SVIX_TIMESTAMP];
  const sigHeader = headers[SVIX_SIGNATURE];
  if (!id || !ts || !sigHeader) return false;

  // Defend against replay — reject signatures more than 5 min stale.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  // Svix signing secret is `whsec_<base64>`; the raw HMAC key is the
  // decoded portion.
  const keyBase64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let key;
  try { key = Buffer.from(keyBase64, 'base64'); } catch { return false; }

  const toSign = `${id}.${ts}.${rawBody.toString('utf8')}`;
  const computed = crypto.createHmac('sha256', key).update(toSign).digest('base64');

  // Header is space-separated list of `v1,<base64sig>` entries — any match wins.
  const signatures = String(sigHeader).split(' ').map((s) => s.split(',')[1]).filter(Boolean);
  return signatures.some((sig) => {
    try {
      return sig.length === computed.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(computed));
    } catch { return false; }
  });
}

router.post('/events', express.raw({ type: '*/*' }), async (req, res) => {
  if (!process.env.RESEND_WEBHOOK_SECRET) {
    // Fail closed until the migration flips on. Resend retries with
    // exponential backoff, so missed events catch up after the env is set.
    logger.warn('[resend-webhook] RESEND_WEBHOOK_SECRET not set — rejecting');
    return res.status(503).send('Webhook secret not configured');
  }

  if (!verifySignature(req.body, req.headers)) {
    logger.warn('[resend-webhook] Signature verification failed — rejecting');
    return res.status(403).send('Invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  try {
    await handleEvent(payload);
  } catch (err) {
    logger.error(`[resend-webhook] event ${payload?.type || '?'} failed: ${err.message}`);
    // Still 200 — partial-failure on a retry would double-apply the
    // good rows. Same idempotence stance as the SendGrid handler.
  }
  res.status(200).json({ received: true });
});

// Resend payload shape (single event per POST, unlike SendGrid's array):
//   { type: 'email.delivered', created_at, data: { email_id, to, ... } }
async function handleEvent(ev) {
  const messageId = ev?.data?.email_id;
  if (!messageId) return;

  const delivery = await db('newsletter_send_deliveries')
    .where({ provider_message_id: messageId })
    .first();
  if (!delivery) return;  // untracked send — ignore

  const now = new Date();

  switch (ev.type) {
    case 'email.delivered':
      if (!delivery.delivered_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          status: 'delivered', delivered_at: now, updated_at: now,
        });
        await db('newsletter_sends').where({ id: delivery.send_id }).increment('delivered_count', 1);
      }
      break;

    case 'email.bounced':
      if (!delivery.bounced_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          status: 'bounced',
          bounced_at: now,
          bounce_reason: (ev.data?.bounce?.message || ev.data?.bounce?.subType || '').toString().slice(0, 500),
          updated_at: now,
        });
        await db('newsletter_sends').where({ id: delivery.send_id }).increment('bounced_count', 1);
        if (delivery.subscriber_id) {
          await db('newsletter_subscribers').where({ id: delivery.subscriber_id }).update({
            bounce_count: db.raw('COALESCE(bounce_count,0) + 1'),
            last_bounced_at: now,
            updated_at: now,
          });
        }
      }
      break;

    case 'email.opened':
      if (!delivery.opened_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          opened_at: now, updated_at: now,
        });
        await db('newsletter_sends').where({ id: delivery.send_id }).increment('opened_count', 1);
      }
      break;

    case 'email.clicked':
      if (!delivery.clicked_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          clicked_at: now, updated_at: now,
        });
        await db('newsletter_sends').where({ id: delivery.send_id }).increment('clicked_count', 1);
      }
      break;

    case 'email.complained':
      if (!delivery.complained_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          status: 'complained', complained_at: now, updated_at: now,
        });
        await db('newsletter_sends').where({ id: delivery.send_id }).increment('complained_count', 1);
        if (delivery.subscriber_id) {
          await db('newsletter_subscribers').where({ id: delivery.subscriber_id }).update({
            status: 'unsubscribed', unsubscribed_at: now, updated_at: now,
          });
        }
      }
      break;

    case 'email.delivery_delayed':
    default:
      // delivery_delayed = soft-fail, Resend will retry — don't mutate row
      break;
  }
}

module.exports = router;
