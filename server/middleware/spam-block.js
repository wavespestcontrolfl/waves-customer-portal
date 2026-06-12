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
 *
 * Voice calls with no manual block also consult the Marchex Clean Call
 * verdict (Twilio Marketplace `AddOns` webhook param). Enforcement is
 * gated by GATE_MARCHEX_AUTO_BLOCK; with the gate off, BLOCK verdicts are
 * shadow-logged so accuracy can be judged before any caller is rejected.
 */

const db = require('../models/db');
const logger = require('../services/logger');
const { isEnabled } = require('../config/feature-gates');

const TWIML_HARD_BLOCK_VOICE =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>';
const TWIML_HANGUP_VOICE =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
const TWIML_SILENT_SMS = '<Response></Response>';

// Phone numbers are PII and must never reach plain-text logs in full — log
// the masked form; the audit table and Twilio console (via SID) keep the
// full numbers for enforcement and follow-up.
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

/**
 * Extract the Marchex Clean Call verdict from Twilio's Marketplace `AddOns`
 * webhook param. Returns `{ recommendation, reason }` or null when the
 * add-on didn't run or the payload is malformed (fail-open, like the rest
 * of this module).
 */
function parseMarchexVerdict(addOnsRaw) {
  if (!addOnsRaw) return null;
  try {
    const addOns = typeof addOnsRaw === 'string' ? JSON.parse(addOnsRaw) : addOnsRaw;
    const marchex = addOns?.results?.marchex_cleancall;
    if (!marchex || marchex.status !== 'successful') return null;
    // Marchex nests its payload one level deeper than the add-on envelope.
    const verdict = marchex.result?.result || marchex.result;
    if (!verdict || typeof verdict.recommendation !== 'string') return null;
    return {
      recommendation: verdict.recommendation.toUpperCase(),
      reason: verdict.reason || null,
    };
  } catch (err) {
    logger.warn(`[spam-block] Unparseable AddOns payload (ignoring): ${err.message}`);
    return null;
  }
}

/**
 * @param {object} args
 * @param {string} args.from        — caller E.164 (Twilio `From`)
 * @param {string} [args.to]        — our endpoint E.164 (Twilio `To`)
 * @param {'voice'|'sms'} args.channel
 * @param {string} [args.twilioSid] — MessageSid for SMS, CallSid for voice
 * @param {string|object} [args.addOns] — Twilio Marketplace `AddOns` webhook
 *                                        param (voice only); carries the
 *                                        Marchex Clean Call spam verdict
 * @returns {Promise<{blocked: boolean, twiml?: string, blockType?: string}>}
 */
async function checkInboundBlock({ from, to, channel, twilioSid, addOns }) {
  if (!from) return { blocked: false };

  let block;
  try {
    block = await db('blocked_numbers').where({ number: from }).first();
  } catch (err) {
    logger.error(`[spam-block] DB query failed (failing open): ${err.message}`);
    return { blocked: false };
  }
  if (!block) {
    // No manual block — consult the Marchex Clean Call verdict that the
    // Marketplace add-on attaches to inbound voice webhooks.
    if (channel === 'voice') {
      const marchex = parseMarchexVerdict(addOns);
      if (marchex && marchex.recommendation === 'BLOCK') {
        if (!isEnabled('marchexAutoBlock')) {
          // Shadow mode — surface the verdict so accuracy can be judged from
          // logs before the gate lets it reject real callers.
          logger.info(`[spam-block] Marchex would block voice from ${maskPhone(from)} → ${maskPhone(to)} (shadow; sid=${twilioSid || 'n/a'}; reason=${marchex.reason || 'n/a'})`);
          return { blocked: false };
        }
        try {
          await db('blocked_call_attempts').insert({
            number: from,
            our_endpoint_id: to || null,
            channel,
            block_type: 'marchex_auto',
            twilio_sid: twilioSid || null,
          });
        } catch (err) {
          logger.error(`[spam-block] Audit insert failed: ${err.message}`);
        }
        logger.info(`[spam-block] Marchex auto-blocked voice from ${maskPhone(from)} → ${maskPhone(to)} (sid=${twilioSid || 'n/a'}; reason=${marchex.reason || 'n/a'})`);
        return { blocked: true, twiml: TWIML_HARD_BLOCK_VOICE, blockType: 'marchex_auto' };
      }
    }
    return { blocked: false };
  }

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

  logger.info(`[spam-block] Blocked ${channel} from ${maskPhone(from)} → ${maskPhone(to)} (sid=${twilioSid || 'n/a'}; type=${block.block_type})`);
  return { blocked: true, twiml, blockType: block.block_type };
}

module.exports = { checkInboundBlock };
