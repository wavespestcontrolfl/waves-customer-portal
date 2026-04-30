/**
 * Opt-out + HELP detection for inbound SMS bodies.
 *
 * Used by twilio-webhook (or any inbound channel) BEFORE the model sees
 * the message, so the model never gets a chance to "respond conversationally"
 * to a stop request and accidentally re-engage. Also used inside the wrapper
 * to detect when a freshly-arriving message body indicates we should
 * suppress the recipient before our outbound queue fires.
 *
 * IMPORTANT: keep this module CONSERVATIVE on natural-language matching.
 *
 *   "cancel my service"     → ESCALATE (cancellation_pause_downgrade), NOT opt-out
 *   "stop texting me"       → opt-out
 *   "wrong number"          → opt-out
 *
 * If we treat "cancel" as opt-out we lose the ability to follow up on a
 * pest-control cancellation conversation. Only the SMS-keyword family
 * ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'QUIT', 'CANCEL') is a hard
 * carrier-recognized opt-out — and even there, we recognize them as opt-
 * outs only when they are the entire message (per CTIA practice).
 */

// Carrier-recognized opt-out keywords. Match only when the keyword is the
// FULL trimmed body (case-insensitive). Most carriers handle these natively
// via Twilio's Advanced Opt-Out, but we mirror the detection so our
// suppression list updates the moment the inbound webhook fires.
const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'END', 'QUIT', 'CANCEL'];

// Natural-language opt-out phrases. These are stricter — they must be
// recognizable as a stop request rather than a service cancellation.
// ORDER MATTERS: the first match wins, so put the most specific patterns
// first.
const NL_OPT_OUT_PATTERNS = [
  /\b(stop|quit|cease)\s+(texting|messaging|texts|messages)\s+me\b/i,
  /\b(don'?t|do not)\s+(text|message|contact)\s+me\b/i,
  /\bremove\s+me\s+from\s+(your\s+)?(list|texts|messages)/i,
  /\bunsubscribe\s+me\b/i,
  /\bwrong\s+number\b/i,
  /\bnot\s+my\s+number\b/i,
];

// HELP keywords — same FULL-body match rule. Recognized so we can short-
// circuit to the canonical help template instead of the model.
const HELP_KEYWORDS = ['HELP', 'INFO'];

/**
 * Detect opt-out intent in an inbound SMS body.
 * @param {string} body
 * @returns {{ optOut: boolean, source: 'keyword' | 'natural_language' | null, matched: string | null }}
 */
function detectOptOut(body) {
  if (!body || typeof body !== 'string') {
    return { optOut: false, source: null, matched: null };
  }
  const trimmed = body.trim();
  const upper = trimmed.toUpperCase();

  // Carrier-recognized keyword — full body, case-insensitive
  if (OPT_OUT_KEYWORDS.includes(upper)) {
    return { optOut: true, source: 'keyword', matched: upper };
  }

  // Natural-language phrase
  for (const re of NL_OPT_OUT_PATTERNS) {
    const m = trimmed.match(re);
    if (m) {
      return { optOut: true, source: 'natural_language', matched: m[0] };
    }
  }

  return { optOut: false, source: null, matched: null };
}

/**
 * Detect HELP/INFO request in an inbound SMS body.
 * @param {string} body
 * @returns {{ help: boolean, matched: string | null }}
 */
function detectHelp(body) {
  if (!body || typeof body !== 'string') {
    return { help: false, matched: null };
  }
  const upper = body.trim().toUpperCase();
  if (HELP_KEYWORDS.includes(upper)) {
    return { help: true, matched: upper };
  }
  return { help: false, matched: null };
}

/**
 * Canonical, template-driven HELP response.
 *
 * Template-driven — never model-generated. The required pieces (company
 * name, support number, opt-out hint) line up with CTIA expectations and
 * what A2P 10DLC campaign registration declares.
 */
const HELP_RESPONSE_TEMPLATE =
  'Waves Pest Control: text or call (941) 297-5749 for support. ' +
  'Reply STOP to opt out. Msg & data rates may apply.';

/**
 * Canonical, template-driven STOP confirmation. Carriers usually send their
 * own; this is the one we send when we run our own suppression flow.
 */
const STOP_CONFIRMATION_TEMPLATE =
  "You've been unsubscribed from Waves Pest Control SMS. Reply START to re-subscribe.";

module.exports = {
  detectOptOut,
  detectHelp,
  HELP_RESPONSE_TEMPLATE,
  STOP_CONFIRMATION_TEMPLATE,
  // Exposed for tests
  _internals: {
    OPT_OUT_KEYWORDS,
    NL_OPT_OUT_PATTERNS,
    HELP_KEYWORDS,
  },
};
