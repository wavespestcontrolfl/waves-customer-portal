const db = require('../../models/db');
const logger = require('../logger');

/**
 * Atomically claim an inbound Twilio webhook delivery for processing.
 *
 * Returns BOTH whether the delivery should be processed AND whether THIS
 * delivery actually acquired the ledger row, because they differ in the
 * fail-open case:
 *   - fresh insert     -> { processable: true,  owned: true  }  (first delivery)
 *   - conflict (dup)   -> { processable: false, owned: false }  (redelivery, skip)
 *   - claim write error-> { processable: true,  owned: false }  (FAIL OPEN — process,
 *                                                                 but we did NOT take a row)
 *   - missing sid      -> { processable: true,  owned: false }
 *
 * The claim is a single INSERT ... ON CONFLICT (twilio_sid) DO NOTHING:
 * the first delivery inserts a row and gets it back; a redelivery hits the
 * conflict and gets zero rows. No check-then-act race window.
 *
 * FAILS OPEN (processable=true) if the dedupe write itself errors (table
 * missing during a deploy window, transient DB hiccup) so a real inbound
 * customer message is NEVER dropped on account of the dedupe layer. But
 * `owned` stays false there — the caller must NOT release a claim it never
 * took, or it could delete a *sibling* delivery's good claim and let that
 * message be reprocessed (double-handled).
 *
 * @param {string} twilioSid  MessageSid (SMS) or CallSid (voice)
 * @param {string} channel    'sms' | 'voice'
 * @returns {Promise<{processable: boolean, owned: boolean}>}
 */
async function tryClaimInboundWebhook(twilioSid, channel) {
  if (!twilioSid) return { processable: true, owned: false }; // nothing to dedupe on
  try {
    const inserted = await db('inbound_webhook_events')
      .insert({ twilio_sid: twilioSid, channel })
      .onConflict('twilio_sid')
      .ignore()
      .returning('twilio_sid');
    const owned = inserted.length > 0;
    return { processable: owned, owned };
  } catch (err) {
    logger.error(`[inbound-dedupe] claim failed (${channel}); failing open: ${err.message}`);
    return { processable: true, owned: false };
  }
}

/**
 * Boolean convenience wrapper around {@link tryClaimInboundWebhook}: true if
 * the delivery should be processed (first delivery OR fail-open), false if it
 * is a confirmed duplicate. Use tryClaimInboundWebhook when you also need to
 * know whether to release the claim on error.
 *
 * @param {string} twilioSid
 * @param {string} channel
 * @returns {Promise<boolean>}
 */
async function claimInboundWebhook(twilioSid, channel) {
  const { processable } = await tryClaimInboundWebhook(twilioSid, channel);
  return processable;
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

module.exports = { tryClaimInboundWebhook, claimInboundWebhook, releaseInboundWebhook, pruneInboundWebhookEvents };
