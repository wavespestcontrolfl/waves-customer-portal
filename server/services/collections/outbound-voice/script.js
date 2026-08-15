/**
 * Fixed spoken copy for the collections outbound-voice lane (PR B).
 *
 * EVERY line here is deterministic: the vestibule plays these verbatim (no
 * model anywhere near the call before press-1), and the relay leg uses the
 * fixed lines for its non-negotiable moments (security interrupt, wrong-party
 * close, generic callback voicemail). Owner reviews this file's copy before
 * any gate flip.
 *
 * LANGUAGE RULES (ruled, tests pin them):
 *  - customer-facing words are "open balance" / "billing follow-up" — NEVER
 *    "collections", "debt", or "delinquent";
 *  - the voicemail is the "generic callback voicemail" — NEVER described as a
 *    "limited-content message" (a Reg-F term implying a safe harbor this lane
 *    has not established), and it contains ZERO balance/debt mention;
 *  - no emojis, no witty copy.
 */

const TWILIO_NUMBERS = require('../../../config/twilio-numbers');

// The callback number spoken in every fixed line — the business main line,
// the same number the call presents as caller ID.
function callbackNumber() {
  return TWILIO_NUMBERS.mainLine.formatted;
}

// ── Vestibule (fixed TwiML stage — plays before ANY audio processing) ──────
// Recording disclosure + automated-assistant disclosure BEFORE press-1: no
// ConversationRelay (and no recording of any kind) exists until the caller
// presses 1. DTMF only — a spoken "yes" would itself be audio processed
// before consent.
function vestibuleScript({ firstName } = {}) {
  const name = firstName ? `${firstName}, ` : '';
  return (
    `Hi ${name}this is an automated call from Waves Pest Control with a quick billing follow-up. `
    + 'If you continue, you will be speaking with our automated assistant and the call may be recorded. '
    + 'To continue, press 1. '
    + 'To stop automated calls from us, press 9. '
    + `To reach our office instead, press 0.`
  );
}

// Press 9 — confirm and stop. No balance mention.
const CONSENT_REVOKED_CONFIRMATION =
  'Understood. We will stop automated calls to this number. '
  + 'Our office is still available if you need anything. Goodbye.';

// Press 0 outside staffed hours (or transfer failed).
// Missed transfer DURING staffed hours (gh prb-r2): the office is open but
// the line was busy/unanswered — never announce a false closure.
function transferMissedCallback() {
  return (
    'I was not able to reach our office just now, so I have asked the team to give you a call back shortly. '
    + `You can also reach us directly at ${callbackNumber()}. Goodbye.`
  );
}

// Card persistence failed — give the number WITHOUT promising a callback
// nobody recorded (gh prb-r3).
// Pre-verification vocabulary screen (gh prb-r4): before identity is
// verified, the agent must not confirm that any balance, invoice, or amount
// exists — not even in generic words the post-verify screen permits.
const PRE_VERIFY_FORBIDDEN_RE = /\b(balance|invoice|amount|owe[sd]?|owing|past.?due|overdue|payment link|pay link)\b|\$\s?\d/i;
const PRE_VERIFY_DEFLECTION = 'I can only go into the details once I have confirmed I am speaking with the right person. Is this a good time?';

function callbackNumberOnly() {
  return `Please reach us at ${callbackNumber()} and the team will help right away. Goodbye.`;
}

function callbackPromise() {
  return (
    'Our office is closed right now, so I have asked the team to give you a call back. '
    + `You can also reach us at ${callbackNumber()}. Goodbye.`
  );
}

// Press 0 inside staffed hours — spoken right before the <Dial>.
const TRANSFER_ANNOUNCEMENT = 'One moment while I connect you to our office.';

// ── Generic callback voicemail ─────────────────────────────────────────────
// Fixed, deterministic, ZERO debt mention. Max 1 per 30 days per customer
// (ledger-enforced), and NEVER on an uncertain AMD result.
function genericCallbackVoicemail() {
  return (
    'Hi, this is Sandy calling from Waves Pest Control. '
    + `When you have a moment, please give our office a call back at ${callbackNumber()}. `
    + 'Thank you, and have a great day.'
  );
}

// ── Relay-leg fixed lines (spoken by the conversation at hard boundaries) ──
// Relay greeting after press-1. Right-party question FIRST — no balance or
// account detail is ever spoken before the named customer is confirmed AND
// verified. Repeats both disclosures so the relay leg stands on its own.
function relayGreeting({ firstName } = {}) {
  const who = firstName ? String(firstName).trim() : 'the account holder';
  return (
    "Thanks. This is Sandy, the automated assistant at Waves Pest Control, and this call may be recorded. "
    + `Before I continue, am I speaking with ${who}?`
  );
}

// Wrong party / unverified: polite generic close, NO debt or account mention.
const WRONG_PARTY_CLOSE =
  'No problem — sorry to bother you. This was a routine call from Waves Pest Control. '
  + 'Have a great day. Goodbye.';

const VERIFICATION_FAILED_CLOSE =
  "I'm not able to verify the account over this call, so I'll leave it with our office. "
  + `If you'd like to reach us directly, the number is CALLBACK. Goodbye.`;

function verificationFailedClose() {
  return VERIFICATION_FAILED_CLOSE.replace('CALLBACK', callbackNumber());
}

// Security interrupt: a caller starts reading a card/bank/SSN/one-time code.
// Fixed copy, ends the topic — the assistant NEVER takes payment details.
const SECURITY_INTERRUPT =
  'For your security, please never share card numbers, bank details, or codes on this call — '
  + 'I am not able to take payment information. Any payment link we send goes to our secure payment page. '
  + 'Is there anything else I can help with?';

// Relay-leg technical failure close (never mentions the balance). NO
// follow-up promise (gh prb-r14): this path files no callback card — the
// case just returns to the review queue, and a queue state is not an
// assigned follow-up. The customer gets the number instead of a promise
// nobody recorded.
// ("invoice"/"balance" vocabulary is deliberately absent — this line can be
// spoken PRE-verification and must pass the pre-verify screen.)
const RELAY_FAILURE_CLOSE =
  'Sorry, I am having technical trouble. Please reach our office at the number on our website. Goodbye.';

// Words that must never be spoken to the customer. The conversation screens
// model output against these before emission (belt-and-braces on top of the
// prompt rule). "Collections"/"debt"/"delinquent" are the external-language
// rule; the negotiation verbs are the never-negotiate/never-threaten line.
const FORBIDDEN_SPOKEN_RE = /\b(collections?|debtor?|delinquen\w*|settle(?:ment)?|write[- ]?off|legal action|attorney|lawsuit|credit (?:bureau|report)|promise to pay)\b/i;

module.exports = {
  callbackNumber,
  vestibuleScript,
  CONSENT_REVOKED_CONFIRMATION,
  callbackPromise,
  callbackNumberOnly,
  PRE_VERIFY_FORBIDDEN_RE,
  PRE_VERIFY_DEFLECTION,
  transferMissedCallback,
  TRANSFER_ANNOUNCEMENT,
  genericCallbackVoicemail,
  relayGreeting,
  WRONG_PARTY_CLOSE,
  verificationFailedClose,
  SECURITY_INTERRUPT,
  RELAY_FAILURE_CLOSE,
  FORBIDDEN_SPOKEN_RE,
};
