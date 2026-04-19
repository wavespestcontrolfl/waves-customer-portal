/**
 * Inbound spam-block check. Runs at the very top of the Twilio voice
 * and SMS webhooks — before customer resolution, before keyword routing,
 * before AI assistant routing.
 *
 * Reads `blocked_numbers`, logs every blocked attempt to
 * `blocked_call_attempts` for daily-digest pattern detection, and
 * returns the appropriate channel-specific TwiML for the caller to send.
 *
 * Fail-open: if the DB query errors, allow the call through. Better to
 * let a spammer reach Virginia than to block a real customer because
 * Postgres hiccupped.
 *
 * PR 1 ships only `hard_block` enforcement from the inbox UI; the other
 * enum values (silent_voicemail, ai_screen, sms_silent) are accepted
 * here but not yet writable from any UI surface.
 */

const db = require('../models/db');
const logger = require('../services/logger');

const TWIML_HARD_BLOCK_VOICE =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';
const TWIML_HANGUP_VOICE =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
const TWIML_SILENT_SMS = '<Response></Response>';

/**
 * @param {object} args
 * @param {string} args.from        — caller E.164 (Twilio `From`)
 * @param {string} [args.to]        — our endpoint E.164 (Twilio `To`)
 * @param {'voice'|'sms'} args.channel
 * @param {string} [args.twilioSid] — MessageSid for SMS, CallSid for voice
 * @returns {Promise<{blocked: boolean, twiml?: string, blockType?: string}>}
 */
async function checkInboundBlock({ from, to, channel, twilioSid }) {
  if (!from) return { blocked: false };

  let block;
  try {
    block = await db('blocked_numbers').where({ number: from }).first();
  } catch (err) {
    logger.error(`[spam-block] DB query failed (failing open): ${err.message}`);
    return { blocked: false };
  }
  if (!block) return { blocked: false };

  // Silent audit — never notify, never create a conversation row.
  try {
    await db('blocked_call_attempts').insert({
      number: from,
      our_endpoint_id: to || null,
      channel,
      block_type: block.block_type,
      twilio_sid: twilioSid || null,
    });
  } catch (err) {
    logger.error(`[spam-block] Audit insert failed: ${err.message}`);
  }

  let twiml;
  if (channel === 'voice') {
    if (block.block_type === 'hard_block') {
      twiml = TWIML_HARD_BLOCK_VOICE;
    } else {
      // silent_voicemail and ai_screen both hang up in PR 1 — the silent-
      // voicemail recorder and AI screener flows land in later PRs.
      twiml = TWIML_HANGUP_VOICE;
    }
  } else {
    // sms_silent (and any future SMS block_type) returns an empty Response
    // so Twilio sends nothing back to the caller and no row hits sms_log.
    twiml = TWIML_SILENT_SMS;
  }

  logger.info(`[spam-block] Blocked ${channel} from ${from} → ${to || 'unknown'} (type=${block.block_type})`);
  return { blocked: true, twiml, blockType: block.block_type };
}

module.exports = { checkInboundBlock };
