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
 *     Enable: Delivered, Bounced, Blocked, Deferred, Dropped, Opened,
 *             Clicked, Spam Reports, Unsubscribe
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

const SIG_HEADER = 'x-twilio-email-event-webhook-signature';
const TS_HEADER = 'x-twilio-email-event-webhook-timestamp';

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

router.post('/events', express.raw({ type: '*/*' }), async (req, res) => {
  // Fail closed unless the public key is configured — we don't want anyone
  // POSTing fake bounces to suppress recipients.
  if (!process.env.SENDGRID_WEBHOOK_PUBLIC_KEY) {
    logger.error('[sendgrid-webhook] SENDGRID_WEBHOOK_PUBLIC_KEY not set — rejecting');
    return res.status(500).send('Webhook public key not configured');
  }

  const sig = req.headers[SIG_HEADER];
  const ts = req.headers[TS_HEADER];
  if (!sig || !ts) {
    logger.warn('[sendgrid-webhook] Missing signature headers — rejecting');
    return res.status(400).send('Missing signature headers');
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

  // Events can belong to a newsletter broadcast delivery, an automation
  // step send, or neither (transactional sends we don't track). Try each
  // table by message id.
  const newsletterDelivery = await db('newsletter_send_deliveries')
    .where({ resend_message_id: messageId })
    .first();
  const automationSend = !newsletterDelivery ? await db('automation_step_sends')
    .where({ sendgrid_message_id: messageId })
    .first() : null;

  if (newsletterDelivery) {
    await handleNewsletterEvent(ev, newsletterDelivery);
    return;
  }
  if (automationSend) {
    await handleAutomationEvent(ev, automationSend);
    return;
  }
  // Untracked send (transactional invoices, receipts, etc.) — ignore.
  return;
}

async function handleNewsletterEvent(ev, delivery) {
  const now = new Date();

  switch (ev.event) {
    case 'delivered':
      if (!delivery.delivered_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          status: 'delivered', delivered_at: now, updated_at: now,
        });
        await db('newsletter_sends').where({ id: delivery.send_id }).increment('delivered_count', 1);
      }
      break;

    case 'bounce':
    case 'blocked':
    case 'dropped':
      if (!delivery.bounced_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          status: 'bounced',
          bounced_at: now,
          bounce_reason: (ev.reason || ev.response || ev.type || '').toString().slice(0, 500),
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

    case 'open':
      if (!delivery.opened_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          opened_at: now, updated_at: now,
        });
        // Don't downgrade status once delivered.
        await db('newsletter_sends').where({ id: delivery.send_id }).increment('opened_count', 1);
      }
      break;

    case 'click':
      if (!delivery.clicked_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          clicked_at: now, updated_at: now,
        });
        await db('newsletter_sends').where({ id: delivery.send_id }).increment('clicked_count', 1);
      }
      break;

    case 'spamreport':
      if (!delivery.complained_at) {
        await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
          status: 'complained', complained_at: now, updated_at: now,
        });
        await db('newsletter_sends').where({ id: delivery.send_id }).increment('complained_count', 1);
        // Complaint = auto-unsubscribe. Protects sender reputation.
        if (delivery.subscriber_id) {
          await db('newsletter_subscribers').where({ id: delivery.subscriber_id }).update({
            status: 'unsubscribed',
            unsubscribed_at: now,
            updated_at: now,
          });
        }
      }
      break;

    case 'unsubscribe':
    case 'group_unsubscribe':
      // Primary unsub path is our own token endpoint; this catches SendGrid-
      // initiated unsubs (rare — we disable subscription_tracking).
      await db('newsletter_sends').where({ id: delivery.send_id }).increment('unsubscribed_count', 1);
      if (delivery.subscriber_id) {
        await db('newsletter_subscribers')
          .where({ id: delivery.subscriber_id })
          .whereNot({ status: 'unsubscribed' })
          .update({
            status: 'unsubscribed',
            unsubscribed_at: now,
            updated_at: now,
          });
      }
      break;

    case 'processed':
    case 'deferred':
    case 'group_resubscribe':
    default:
      // processed = accepted by SG (already "sent" in our model)
      // deferred = temporary fail, SG will retry — don't update row
      // group_resubscribe = we don't use SG groups
      break;
  }
}

/**
 * Same event shape as newsletter, but the row lives in automation_step_sends.
 * Plus: on hard unsub / spam / bounce events we cancel any still-active
 * enrollment for that email so the sequence doesn't keep ticking. Group
 * unsubscribes only cancel enrollments whose template's asm_group matches.
 */
async function handleAutomationEvent(ev, sendRow) {
  const now = new Date();

  switch (ev.event) {
    case 'delivered':
      if (!sendRow.delivered_at) {
        await db('automation_step_sends').where({ id: sendRow.id }).update({
          status: 'delivered', delivered_at: now, updated_at: now,
        });
      }
      break;

    case 'open':
      if (!sendRow.opened_at) {
        await db('automation_step_sends').where({ id: sendRow.id }).update({
          opened_at: now, updated_at: now,
        });
      }
      break;

    case 'click':
      if (!sendRow.clicked_at) {
        await db('automation_step_sends').where({ id: sendRow.id }).update({
          clicked_at: now, updated_at: now,
        });
      }
      break;

    case 'bounce':
    case 'blocked':
    case 'dropped':
      await db('automation_step_sends').where({ id: sendRow.id }).update({
        status: 'bounced',
        failure_reason: (ev.reason || ev.response || ev.type || '').toString().slice(0, 500),
        updated_at: now,
      });
      // Hard-bounce → cancel ALL active enrollments for this email. The
      // address is undeliverable across any automation group.
      if (ev.type === 'bounce' || ev.type === 'blocked' || ev.event === 'dropped') {
        await cancelActiveEnrollments({ email: ev.email, reason: 'hard_bounce' });
      }
      break;

    case 'spamreport':
      await db('automation_step_sends').where({ id: sendRow.id }).update({
        status: 'complained', updated_at: now,
      });
      // Complaint → cancel everything + mark newsletter sub unsubscribed.
      await cancelActiveEnrollments({ email: ev.email, reason: 'spam_report' });
      await db('newsletter_subscribers').where({ email: ev.email }).whereNot({ status: 'unsubscribed' }).update({
        status: 'unsubscribed', unsubscribed_at: now, updated_at: now,
      });
      break;

    case 'unsubscribe':
      // Global unsub — cancel every active enrollment for this email.
      await cancelActiveEnrollments({ email: ev.email, reason: 'unsubscribe' });
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
        await cancelActiveEnrollments({ email: ev.email, reason: 'group_unsubscribe', asmGroup: asmGroupToCancel });
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

async function cancelActiveEnrollments({ email, reason, asmGroup }) {
  if (!email) return;
  let q = db('automation_enrollments as e')
    .join('automation_templates as t', 't.key', 'e.template_key')
    .where('e.email', email)
    .where('e.status', 'active');
  if (asmGroup) q = q.where('t.asm_group', asmGroup);

  const rows = await q.select('e.id', 't.key as template_key');
  if (!rows.length) return;

  const ids = rows.map((r) => r.id);
  await db('automation_enrollments').whereIn('id', ids).update({
    status: 'cancelled',
    next_send_at: null,
    completed_at: new Date(),
    metadata: db.raw("jsonb_set(COALESCE(metadata,'{}'::jsonb), '{cancel_reason}', ?::jsonb, true)", [JSON.stringify(reason)]),
    updated_at: new Date(),
  });
  logger.info(`[sendgrid-webhook] cancelled ${rows.length} enrollment(s) for ${email} reason=${reason}${asmGroup ? ` group=${asmGroup}` : ''}`);
}

module.exports = router;
