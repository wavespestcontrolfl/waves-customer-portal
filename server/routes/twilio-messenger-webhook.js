const express = require('express');

const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { recordTouchpoint } = require('../services/conversations');

// Map an inbound `To` address to a unified-inbox channel. Facebook Messenger
// and Instagram arrive through Twilio's Programmable-Messaging channel senders
// with `messenger:` / `instagram:` prefixed addresses. Returns null for any
// other shape (SMS/WhatsApp/empty/misroute) so we never mis-tag a non-social
// address as Facebook.
function channelForAddress(address) {
  const a = String(address || '');
  if (a.startsWith('messenger:')) return 'facebook_messenger';
  if (a.startsWith('instagram:')) return 'instagram';
  return null;
}

/**
 * Inbound Facebook Messenger / Instagram messages.
 *
 * Twilio's channel sender POSTs here on every inbound message, same shape as
 * the SMS webhook but with `messenger:<psid>` / `instagram:<id>` addresses:
 *   From = the contact's page-scoped id, To = our page/account address.
 *
 * Mounted under /api/webhooks/twilio (so it inherits validateTwilioSignature).
 *
 * Fail-closed gate: this channel stays OFF until Phase 2 surfaces social
 * threads in Communications (the inbox read path is still SMS/voice only) and
 * adds reply-from-portal. While disabled we ACK (so Twilio doesn't retry) but
 * do NOT persist — we don't want to accumulate messages nobody can see/answer.
 *
 * When enabled: persist the message into the unified inbox FIRST, then ACK.
 * Unlike SMS there is no legacy sms_log fallback, so on a persistence failure
 * we return 500 to make Twilio retry rather than silently drop the inbound DM.
 */
router.post('/messenger', async (req, res) => {
  if (process.env.GATE_SOCIAL_INBOX !== 'true') {
    return res.type('text/xml').send('<Response></Response>');
  }

  try {
    const { From, To, Body, MessageSid } = req.body || {};
    if (!From || !To) {
      return res.type('text/xml').send('<Response></Response>');
    }

    // Only persist genuine messenger:/instagram: shapes. Ignore (ACK without
    // storing) anything else — a signed Twilio misroute or malformed sender
    // request must never create a bogus social conversation.
    const channel = channelForAddress(To);
    if (!channel) {
      logger.warn(`[messenger] ignoring unrecognized To address shape: ${To}`);
      return res.type('text/xml').send('<Response></Response>');
    }
    const expectedPrefix = channel === 'instagram' ? 'instagram:' : 'messenger:';
    if (!String(From).startsWith(expectedPrefix)) {
      logger.warn(`[messenger] ignoring From/To channel-family mismatch (from=${From} to=${To})`);
      return res.type('text/xml').send('<Response></Response>');
    }

    // FB/IG senders include the contact's display name as ProfileName.
    const contactLabel = req.body.ProfileName || null;

    // Best-effort: if this contact was previously linked to a customer, keep
    // the thread on that customer instead of creating an unknown one.
    let customerId = null;
    try {
      const prior = await db('conversations')
        .where({ contact_external_id: From, channel })
        .whereNotNull('customer_id')
        .first();
      if (prior) customerId = prior.customer_id;
    } catch (e) {
      logger.warn(`[messenger] prior-link lookup failed: ${e.message}`);
    }

    // Persist BEFORE acking. recordTouchpoint returns null if the DB write
    // failed (it logs + swallows internally). With no sms_log fallback for this
    // channel, a swallowed failure after a 200 would lose the DM, so return 500
    // on a null result and let Twilio retry. Retries are idempotent —
    // appendMessage dedupes on (channel, twilio_sid).
    const result = await recordTouchpoint({
      customerId,
      channel,
      ourEndpointId: To,
      contactExternalId: From,
      contactLabel,
      direction: 'inbound',
      authorType: 'customer',
      body: Body || null,
      twilioSid: MessageSid || null,
      isRead: false,
      metadata: { from: From, to: To, source: channel },
    });

    if (!result) {
      logger.error(`[messenger] persist failed for ${MessageSid || '(no sid)'} — returning 500 for Twilio retry`);
      return res.status(500).type('text/xml').send('<Response></Response>');
    }

    logger.info(`[messenger] inbound ${channel} message ${MessageSid || '(no sid)'} logged`);
    return res.type('text/xml').send('<Response></Response>');
  } catch (err) {
    logger.error(`[messenger] inbound handler failed: ${err.message}`, { stack: err.stack });
    return res.status(500).type('text/xml').send('<Response></Response>');
  }
});

module.exports = router;
module.exports.channelForAddress = channelForAddress;
