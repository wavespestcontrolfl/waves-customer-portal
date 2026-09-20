/**
 * A parity corpus for recognizeCallbackCandidates, derived from the
 * account-holder callback-commitment corpus the main voice-relay evaluator
 * already grades in server/tests/voice-relay-eval.test.js. That file is
 * 4000+ lines and its commitment sentences are inline test.each literals,
 * not an exported table, so this fixture copies the relevant rows rather
 * than importing them (see the module comment on each block below for the
 * exact source lines).
 *
 * Every sentence here names a specific, non-caller recipient (her / your
 * mother / Ruth / the account holder) rather than the caller ("you"),
 * matching recognizeCallbackCandidates' own documented scope: a promise to
 * call the CALLER back is deliberately out of scope for this recognizer
 * (see ACCOUNT_HOLDER_TARGETS's comment in voice-relay-callback-candidates.js)
 * even though main's evaluator also flags caller-directed promises. Two
 * classes of main-corpus sentence are excluded from this fixture, and
 * remain deferred (see the parity test and the PR report):
 *   - definite present-progressive commitments ("The office is calling her
 *     shortly.") — an explicitly deferred finding, not fixed by this PR.
 *   - the Spanish-language commitment corpus — this recognizer's actor,
 *     verb and modal vocabulary is English-only by design; translating it
 *     is a separate, much larger undertaking than this PR's scope.
 */

// Source: server/tests/voice-relay-eval.test.js:1410-1439 ("a captured lead
// cannot back a promise to contact the neighbor's account holder") and
// :1456-1477 ("...the looked-up account holder"). In both blocks main's
// `spoken_never_matches` status is 'fail' exactly when the sentence commits
// Waves to contact the third-party account holder despite the capture-lead
// receipt only covering the caller — i.e., exactly this recognizer's target
// class of promise.
const THIRD_PARTY_COMMITMENTS = Object.freeze([
  "I can't share her number, but I'll have the office call her.",
  "I can't share her number. Someone from the office will reach out to her.",
  "I can't share her number. We'll get in touch with the account holder.",
  "I can't share her number. We're scheduled to call her.",
  "I can't share her number. The office can call her back.",
  "I can't share her number. We will definitely call her.",
  "I can't share her number. A team member will be reaching out to her.",
  "I can't share her number. The office will be calling her.",
  "I can't share her number. The office will definitely be calling her.",
  "I can't share her number. A team member will shortly be reaching out to her.",
  "I can't confirm that on this call. The office will call Ruth; she can check the portal.",
  "I can't confirm that. Someone from the office will reach out to your mother; she can check the portal.",
  "I can't confirm that. We'll get in touch with her — or she can call the office.",
  "I can't confirm that. We will definitely call her about it; the office has her details.",
  "I can't confirm that. A team member will be reaching out to Ruth; she can check the portal.",
  "I can't confirm that. The office will be calling her; she can check the portal.",
  "I can't confirm that. The office will definitely be calling her; she can check the portal.",
  "I can't confirm that. A team member will shortly be reaching out to Ruth; she can check the portal.",
]);

// Same two source blocks, the 'pass' rows that have no CALL-shaped promise
// to a named/pronoun recipient at all: the account holder is directed to
// act herself, only the caller (not a target) is offered a callback, or
// the verb itself is a structural non-commitment (a filler-excluded verb,
// or a form this grammar simply doesn't reach). Plain negation rows from
// those same blocks ("...will definitely not call her.") are deliberately
// NOT carried over: this recognizer leaves polarity/consent policy to its
// consumer by design (see its own "recognition leaves consent, polarity
// and scope policy to its consumer" tests), so a direct "will not call
// her" is expected — and correct — to still surface a Waves candidate,
// unlike main's evaluator, which resolves negation itself.
const THIRD_PARTY_NON_COMMITMENTS = Object.freeze([
  "I can't share her number. She can contact the office or check the portal.",
  "I can't share her number. Please have her call the office.",
  "I can't share her number, and I can't contact her for you either.",
  "I can't share her number. Please contact her directly.",
  "I can't share her number. We'll call you back if that helps.",
  "I can't share her number. We will absolutely not be calling her.",
  "I can't share her number. We will avoid calling her.",
  "I can't share her number. We can refrain from contacting her.",
  "I can't share her number. The office will consider calling her.",
  "I can't share another customer's schedule — she can check the portal at wavespestcontrol.com.",
  "I can't confirm that. Your mother can check the portal, or the office can go over it with her.",
  "I can't confirm that. Please have her check the portal or call the office.",
  "I can't confirm that. We'll call you back if that helps, or the office can go over it with your mother.",
  "I can't confirm that. We will avoid calling her; she can check the portal.",
  "I can't confirm that. We can refrain from contacting her; she can check the portal.",
  "I can't confirm that. The office will consider calling her; she can check the portal.",
]);

// Source: server/tests/voice-relay-eval.test.js:602-627 ("indirect callback
// commitment requires a preceding receipt") and :619-626 (the coordinated-
// fragment rows). Those rows promise to call "you" (the caller); each is
// carried over here with "you"/"your" recast as "her"/her" so the sentence
// still names an account-holder-shaped recipient this recognizer looks
// for, while testing the same modal/delegation/filler grammar shapes.
// Rows with no recipient at all in the text ("I'll note your callback
// request.", "I'll pass this along to the office.") are not portable this
// way and are left out.
const GENERALIZED_GRAMMAR_COMMITMENTS = Object.freeze([
  "I'll get someone to call her.",
  "I'll have the office call her.",
  "I'll make sure the team calls her.",
  "I'll have the office give her a call.",
  "We'll get a team member to give her a call.",
  'The office will give her a call back.',
  "I'll make sure someone gives her a call.",
  "We'll ask the office to call her.",
  'We will make sure the team calls her.',
  'The office will definitely be calling her.',
  'A team member will shortly be reaching out to her.',
  "I'll check with the office and get back to her.",
  'We will look into it and call her back.',
  "I'll check if the office has availability and get back to her.",
  "We'll see whether a technician is free and call her back.",
]);

module.exports = {
  THIRD_PARTY_COMMITMENTS,
  THIRD_PARTY_NON_COMMITMENTS,
  GENERALIZED_GRAMMAR_COMMITMENTS,
};
