const express = require('express');

const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { uploadTwilioMedia } = require('../services/sms-media');
const { recordTouchpoint } = require('../services/conversations');

// Facebook Messenger arrives through Twilio's Programmable-Messaging channel
// sender with a `messenger:<id>` address. Instagram is NOT a Twilio Messaging
// channel (Messaging supports SMS/MMS/RCS/WhatsApp/Facebook Messenger) — it
// would need a separate Conversations/Meta integration — so it is intentionally
// not handled here. Returns null for any non-`messenger:` address so we never
// mis-tag SMS/WhatsApp/RCS/empty as a social DM.
function channelForAddress(address) {
  return String(address || '').startsWith('messenger:') ? 'facebook_messenger' : null;
}

/**
 * Inbound Facebook Messenger messages.
 *
 * Twilio's channel sender POSTs here on every inbound message, same shape as
 * the SMS webhook but with `messenger:<psid>` addresses:
 *   From = the contact's page-scoped id, To = our page address.
 * Media arrives as NumMedia/MediaUrl{N}, same as MMS.
 *
 * Mounted under /api/webhooks/twilio (so it inherits validateTwilioSignature).
 *
 * Fail-closed gate: this channel stays OFF until Phase 2 surfaces social threads
 * in Communications (the inbox read path is still SMS/voice only) and adds
 * reply-from-portal. While disabled we ACK (so Twilio doesn't retry) but do NOT
 * persist — we don't want to accumulate messages nobody can see/answer.
 *
 * When enabled: persist FIRST, then ACK. Unlike SMS there is no legacy sms_log
 * fallback, so on a persistence failure we return 500 to make Twilio retry
 * rather than silently drop the inbound DM.
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

    // Only persist genuine Facebook Messenger shapes (From + To both
    // `messenger:`). ACK-ignore anything else — a signed Twilio misroute or a
    // Messaging Service / fallback pointed here for SMS/WhatsApp/RCS must never
    // create a bogus social conversation.
    const channel = channelForAddress(To);
    if (!channel || !String(From).startsWith('messenger:')) {
      logger.warn(`[messenger] ignoring non-Messenger address shape (from=${From} to=${To})`);
      return res.type('text/xml').send('<Response></Response>');
    }

    // Pull any attached media (image-only DMs are common) the same way the SMS
    // path does, so an attachment with little/no text isn't stored blank.
    const inboundMedia = await uploadTwilioMedia(req.body);

    // FB senders include the contact's display name as ProfileName.
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
    // failed (it logs + swallows internally). With no sms_log fallback here, a
    // swallowed failure after a 200 would lose the DM, so return 500 on a null
    // result and let Twilio retry. Retries are idempotent — appendMessage
    // dedupes on (channel, twilio_sid).
    const result = await recordTouchpoint({
      customerId,
      channel,
      ourEndpointId: To,
      contactExternalId: From,
      contactLabel,
      direction: 'inbound',
      authorType: 'customer',
      body: Body || null,
      media: inboundMedia,
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
