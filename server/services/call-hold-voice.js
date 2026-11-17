'use strict';

/**
 * "Hold please" voice trigger for the star-key hold (GATE_CALL_HOLD_VOICE, dark; owner 2026-11-16 "ok build all",
 * live-call suite part 7).
 *
 * live-call-transcription.js stores each final utterance of a conference-path call. After a STAFF utterance is
 * stored it hands the text here. When the staff say they are putting the caller on hold, this module asks
 * call-hold.js for the hold (requestHold, by 'voice'): the staff leg is moved to the star route, so the hold runs
 * exactly as if the staff had pressed star (the same decision, sender, menu, timer and press 1).
 *
 * Nothing is stored or logged from the words: the text is customer-call speech. Logs carry the last 6 characters of
 * the SID and an answer or error code only. Fire and forget: nothing here throws or delays the webhook's 200.
 * While the hold holds the caller nothing is stored, so no phrase can fire during a hold.
 */

const logger = require('./logger');
const featureGates = require('../config/feature-gates');

// Owner 2026-11-16: "Hold please. Staff say 'please hold' or 'let me put you on hold', and the hold starts as with
// star. 'Hold on a second' does not start a hold." Rules run on the normalized text (see normalize). One row per
// rule; a phrase starts a hold when any row matches.
//   please hold      not "please hold on": that reads as "hold on".
//   hold please      not after "I'll", "we can", "I'd" ...: "Sure, I'll hold, please take your time" is the staff
//                    waiting for the caller, never a hold.
//   put you on hold  only the staff's own announcement ("let me", "I'm going to", "I'll" ...). "Can I put you on
//                    hold" is a question: the caller has not said yes.
const HOLD_RULES = [
  /\bplease hold(?! on\b)/,
  /(?<!\b(?:i'll|i will|i can|we'll|we will|we can|i'd|i would) )\bhold please\b/,
  /\b(?:let me|i'm going to|i am going to|i'm gonna|i'll|i will) (?:put|place) you on (?:a )?(?:(?:quick|brief|short) )?hold\b/,
];

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

function isHoldPhrase(text) {
  const normalized = normalize(text);
  return normalized !== '' && HOLD_RULES.some((rule) => rule.test(normalized));
}

const masked = (callSid) => `…${String(callSid || '').slice(-6)}`;
const errorCode = (err) => String(err?.code || err?.name || 'error').slice(0, 40);

// Fire and forget; the returned promise is for tests. Never throws, never logs the text.
async function afterStaffUtterance(callSid, text) {
  try {
    if (!featureGates.callHoldVoiceLive()) return;
    if (!isHoldPhrase(text)) return;
    const answer = await require('./call-hold').requestHold(callSid, { by: 'voice' });
    logger.info(`[call-hold-voice] hold asked for ${masked(callSid)} (${answer})`);
  } catch (err) {
    try { logger.warn(`[call-hold-voice] hold request failed for ${masked(callSid)} (${errorCode(err)})`); } catch { /* logging never throws out */ }
  }
}

module.exports = { isHoldPhrase, afterStaffUtterance };
