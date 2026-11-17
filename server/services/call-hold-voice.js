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
// star. 'Hold on a second' does not start a hold."
//
// A false match puts a caller on hold, and a miss costs little (star and the Hold button still work), so each rule
// is narrow. The live text has punctuation (Google, EnableAutomaticPunctuation), so it is cut into sentences at
// . ? ! ; : and each sentence is matched on its own: words from two sentences never make one phrase.
//   A question never starts a hold, wherever it sits in the sentence ("Before I check that, can you please hold?",
//   "May I put you on hold?"): the caller has not said yes. A condition said before the ask ("If I need to check
//   with the technician, I will put you on hold") or right after "on hold" ("I'll put you on hold if I need to")
//   makes it a maybe, not a hold. "If you could please hold" is a polite ask and still holds.
//   please hold      only at the end of the sentence or before a word that keeps it a phone hold ("please hold while
//                    I check", "please hold for one moment"). Never "please hold on" (= "hold on"), "please hold off
//                    on watering", "please hold onto that receipt" or "please hold the service".
//   hold please      only as the sentence's own ask ("Hold, please.", "Okay, hold please"). Never "I'll hold, please
//                    take your time" (the staff wait) or "your service is on hold, please call us" (an account hold).
//   put you on hold  only the staff's own announcement ("let me just put you on hold", "I'm going to put you on a
//                    quick hold"). Never "if I put you on hold" or "put your account on hold".
// Words a sentence may start with before its ask: "Okay, please hold", "Alright, so let me put you on hold".
const LEAD = '^(?:(?:okay|ok|alright|all right|so|sure|um|uh|great|perfect|yes|yeah|got it|thank you|thanks'
  + '|one moment|one second|just a moment|just a second) )*';
// A question form anywhere in the sentence: a helping verb, then who it asks about ("can you", "may I", "is it",
// "mind if"). "Do not hang up" and "Will do" are not questions.
const QUESTION_FORM = /\b(?:can|could|would|will|may|might|shall|should|do|does|did|is|are|mind) (?:you|i|we|it|that|if)\b/;
// A condition before the ask, about the staff or the call ("if I", "when I'm", "if it's okay"). "If you could" is not.
const CONDITION_BEFORE = /\b(?:if|when|once|unless|in case|whenever) (?:i|i'm|i'll|we|we're|we'll|it|it's|that|that's|there|the)\b/;
// What may follow "please hold" in the same sentence and keep it a phone hold.
const AFTER_PLEASE_HOLD = "(?:while|for (?:a|one|just|me|the next)|one|just|a (?:moment|minute|second|sec)"
  + "|and (?:i|i'll|let)|thank|thanks|i|i'll|i'm|we'll|we're|let|real quick|briefly|momentarily|the line"
  + "|sir|ma'am|maam|okay|ok|please)";
const ON_HOLD = 'on (?:a )?(?:(?:quick|brief|short) )?hold\\b(?! (?:if|when|once|unless|in case)\\b)';
const HOLD_RULES = [
  new RegExp(`\\bplease hold(?:$| ${AFTER_PLEASE_HOLD}\\b)`),
  new RegExp(`${LEAD}hold please\\b`),
  new RegExp(`\\b(?:let me|i'll|i will)(?: just| quickly| go ahead and)? (?:put|place) you ${ON_HOLD}`),
  new RegExp(`\\b(?:i'm|i am)(?: just)? (?:going to|gonna)(?: go ahead and)? (?:put|place) you ${ON_HOLD}`),
  new RegExp(`\\b(?:i'm|i am)(?: just)? (?:putting|placing) you ${ON_HOLD}`),
];

// The sentences of an utterance: lower case, curly apostrophes made straight, a quote mark at a word's edge dropped,
// anything but a-z, 0-9, ' and space made a space, spaces collapsed.
function sentences(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .split(/[.?!;:\n]+/)
    .map((sentence) => sentence.replace(/[^a-z0-9' ]/g, ' ').replace(/\B'|'\B/g, '').replace(/ +/g, ' ').trim())
    .filter(Boolean);
}

// One sentence asks for a hold: no question form in it, and a rule matches with no condition up to the end of the
// match (the condition's subject can be the match's own first word: "When I am putting you on hold").
function asksForHold(sentence) {
  if (QUESTION_FORM.test(sentence)) return false;
  return HOLD_RULES.some((rule) => {
    const match = rule.exec(sentence);
    return Boolean(match) && !CONDITION_BEFORE.test(sentence.slice(0, match.index + match[0].length));
  });
}

function isHoldPhrase(text) {
  return sentences(text).some(asksForHold);
}

// Read through the module object at call time: a suite that mocks feature-gates as a bare object reads off.
const live = () => typeof featureGates.callHoldVoiceLive === 'function' && featureGates.callHoldVoiceLive();

const masked = (callSid) => `…${String(callSid || '').slice(-6)}`;
const errorCode = (err) => String(err?.code || err?.name || 'error').slice(0, 40);

// Fire and forget; the returned promise is for tests. Never throws, never logs the text.
async function afterStaffUtterance(callSid, text) {
  try {
    if (!live()) return;
    if (!isHoldPhrase(text)) return;
    const answer = await require('./call-hold').requestHold(callSid, { by: 'voice' });
    logger.info(`[call-hold-voice] hold asked for ${masked(callSid)} (${answer})`);
  } catch (err) {
    try { logger.warn(`[call-hold-voice] hold request failed for ${masked(callSid)} (${errorCode(err)})`); } catch { /* logging never throws out */ }
  }
}

module.exports = { isHoldPhrase, afterStaffUtterance };
