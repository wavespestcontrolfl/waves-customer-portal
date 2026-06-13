const db = require('../../models/db');
const logger = require('../logger');

/**
 * Atomically claim an inbound Twilio webhook delivery for processing.
 *
 * Returns true when this is the FIRST time we've seen this SID (the caller
 * owns the message and should process it), false when it's a redelivery of
 * an already-seen SID (the caller should short-circuit).
 *
 * The claim is a single INSERT ... ON CONFLICT (twilio_sid) DO NOTHING:
 * the first delivery inserts a row and gets it back; a redelivery hits the
 * conflict and gets zero rows. No check-then-act race window.
 *
 * FAILS OPEN: if the dedupe write itself errors (table missing during a
 * deploy window, transient DB hiccup), we return true so a real inbound
 * customer message is NEVER dropped on account of the dedupe layer. A rare
 * duplicate is strictly better than a lost message.
 *
 * @param {string} twilioSid  MessageSid (SMS) or CallSid (voice)
 * @param {string} channel    'sms' | 'voice'
 * @returns {Promise<boolean>} true = first delivery (process), false = duplicate (skip)
 */
async function claimInboundWebhook(twilioSid, channel) {
  if (!twilioSid) return true; // nothing to dedupe on — process it
  try {
    const inserted = await db('inbound_webhook_events')
      .insert({ twilio_sid: twilioSid, channel })
      .onConflict('twilio_sid')
      .ignore()
      .returning('twilio_sid');
    return inserted.length > 0;
  } catch (err) {
    logger.error(`[inbound-dedupe] claim failed (${channel}); failing open: ${err.message}`);
    return true;
  }
}

/**
 * Release a previously-claimed SID so a Twilio retry can reprocess it.
 *
 * Call this ONLY when the first delivery failed before it finished handling
 * the message (i.e. from the handler's error path). A successful delivery
 * must KEEP its claim so a retry is suppressed. Best-effort: a failed
 * release just means a later retry is treated as a duplicate, which is the
 * same outcome as not having the release at all.
 *
 * @param {string} twilioSid
 */
async function releaseInboundWebhook(twilioSid) {
  if (!twilioSid) return;
  try {
    await db('inbound_webhook_events').where({ twilio_sid: twilioSid }).del();
  } catch (err) {
    logger.error(`[inbound-dedupe] release failed: ${err.message}`);
  }
}

/**
 * Prune dedupe rows older than the retention window. Twilio never retries a
 * webhook days later, so a short horizon is ample.
 * @returns {Promise<number>} rows deleted
 */
async function pruneInboundWebhookEvents({ olderThanDays = 7 } = {}) {
  try {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    return await db('inbound_webhook_events').where('created_at', '<', cutoff).del();
  } catch (err) {
    logger.error(`[inbound-dedupe] prune failed: ${err.message}`);
    return 0;
  }
}

module.exports = { claimInboundWebhook, releaseInboundWebhook, pruneInboundWebhookEvents };
