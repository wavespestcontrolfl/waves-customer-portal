const EXACT_OPT_OUT = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'UNSUB',
  'CANCEL',
  'QUIT',
  'END',
  'REMOVE',
  'OPTOUT',
  'OPT OUT',
  'DO NOT TEXT',
  'DONT TEXT',
  "DON'T TEXT",
]);

const EXACT_OPT_IN = new Set([
  'START',
  'SUBSCRIBE',
  'YES',
  'UNSTOP',
  'OPTIN',
  'OPT IN',
]);

const OPT_OUT_PATTERNS = [
  /\b(stop|stopp|unsubscribe|unsub)\s+(texting|messaging|texts?|messages?|sms|me)\b/i,
  /^\s*(please\s+)?remove\s+me\s*[.!?]*\s*$/i,
  /^\s*(please\s+)?take\s+me\s+off\s*[.!?]*\s*$/i,
  /\bremove\s+me\s+from\s+(your|this|the|my)?\s*(text\s+)?(list|texts?|messages?|messaging|sms)\b/i,
  /\btake\s+me\s+off\s+(your|this|the|my)?\s*(text\s+)?(list|texts?|messages?|messaging|sms)\b/i,
  /\btake\s+me\s+off\s+of\s+(your|this|the|my)?\s*(text\s+)?(list|texts?|messages?|messaging|sms)\b/i,
  /\bdo\s+not\s+(text|message|contact|sms)\b/i,
  /\bdon'?t\s+(text|message|contact|sms)\b/i,
  /\bno\s+(more\s+)?(texts?|messages?|sms)\b/i,
  /\bwrong\s+number\b/i,
  /\bnot\s+(my|the)\s+number\b/i,
];

const WRONG_NUMBER_PATTERNS = [
  /\bwrong\s+number\b/i,
  /\bnot\s+(my|the)\s+number\b/i,
  /\byou\s+have\s+the\s+wrong\b/i,
];

const HELP_KEYWORDS = new Set(['HELP', 'INFO']);
const HELP_RESPONSE_TEMPLATE =
  'Waves Pest Control: text or call (941) 297-5749 for support. ' +
  'Reply STOP to opt out. Msg & data rates may apply.';
const STOP_CONFIRMATION_TEMPLATE =
  "You've been unsubscribed from Waves Pest Control SMS. Reply START to re-subscribe.";

// A vendor can offer the recipient a reply instruction without asking Waves
// to stop. Only a complete instruction starting a sentence or line can be
// removed; narrated attempts and requests elsewhere must still win.
const REPLY_OPT_OUT_INSTRUCTION = /(^|[.!?;\r\n])\s*(?:reply|respond|text|say)\s+(?:with\s+)?["'\u2018\u2019\u201C\u201D]?(?:no|stop|unsubscribe)["'\u2018\u2019\u201C\u201D]?\s+(?:if\s+you\s+(?:want|need)(?:\s+(?:me|us))?\s+to\s+|to\s+)(?:stop\s+(?:texting|messaging|texts?|messages?|sms)(?:\s+(?:you|me))?|unsubscribe|opt\s*out)\b(?=\s*(?:[.!?;\r\n]|$))/gi;

// Same shape, but for a vendor footer that invites a STOP/NO reply keyed on
// "wrong number" or "sent in error" rather than "stop texting" \u2014 e.g. "Reply
// STOP if this is the wrong number." / "Text STOP if wrong number." / "Reply
// STOP if you received this in error." Left unstripped, WRONG_NUMBER_PATTERNS
// below reads the footer's own "wrong number" as the recipient's own reply
// and the classifier treats a vendor pitch as a real wrong-number opt-out
// (codex P0, 2026-09-11). A genuine human reply ("sorry wrong number", "you
// have the wrong number") never matches this reply-instruction shape, so it
// still falls through to WRONG_NUMBER_PATTERNS untouched.
const REPLY_WRONG_NUMBER_FOOTER = /(^|[.!?;\r\n])\s*(?:reply|respond|text|say)\s+(?:with\s+)?["'\u2018\u2019\u201C\u201D]?(?:no|stop|unsubscribe)["'\u2018\u2019\u201C\u201D]?\s+if\s+(?:this\s+is\s+)?(?:you(?:'re|\s+are)\s+)?(?:not\s+the\s+intended\s+recipient|(?:the\s+)?wrong\s+number|you\s+(?:received|got)\s+this\s+(?:in\s+error|by\s+mistake))\b(?=\s*(?:[.!?;\r\n]|$))/gi;

// Same footer, condition-first order \u2014 "If this is the wrong number, reply
// STOP." / "If wrong number, text STOP." \u2014 rather than reply-first (codex
// P0, 2026-09-11: the reply-first regex above does not match this ordering,
// so WRONG_NUMBER_PATTERNS still reads the footer's own wording as consent).
const CONDITION_FIRST_WRONG_NUMBER_FOOTER = /(^|[.!?;\r\n])\s*if\s+(?:this\s+is\s+)?(?:you(?:'re|\s+are)\s+)?(?:not\s+the\s+intended\s+recipient|(?:the\s+)?wrong\s+number|you\s+(?:received|got)\s+this\s+(?:in\s+error|by\s+mistake))\s*,?\s*(?:please\s+)?(?:reply|respond|text|say)\s+(?:with\s+)?["'\u2018\u2019\u201C\u201D]?(?:no|stop|unsubscribe)["'\u2018\u2019\u201C\u201D]?\b(?=\s*(?:[.!?;\r\n]|$))/gi;

function normalizeBody(body) {
  return String(body || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTapbackPrefix(body) {
  const text = normalizeBody(body);
  const match = text.match(/^(liked|disliked|loved|laughed at|emphasized|questioned)\s+["'](.+)["']$/i);
  return match ? match[2].trim() : text;
}

function compactKeyword(body) {
  return normalizeBody(body)
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function detectSmsOptCommand(body, { ignoreReplyInstructions = false } = {}) {
  const normalized = normalizeBody(ignoreReplyInstructions
    ? String(body || '')
      .replace(REPLY_OPT_OUT_INSTRUCTION, '$1')
      .replace(REPLY_WRONG_NUMBER_FOOTER, '$1')
      .replace(CONDITION_FIRST_WRONG_NUMBER_FOOTER, '$1')
    : body);
  if (!normalized) return { action: null };

  const tapbackStripped = stripTapbackPrefix(normalized);
  const keyword = compactKeyword(tapbackStripped);

  if (EXACT_OPT_IN.has(keyword)) {
    return {
      action: 'opt_in',
      reason: 'opt_in_keyword',
      sourceKeyword: keyword,
      detectionMethod: tapbackStripped === normalized ? 'exact_keyword' : 'tapback_exact_keyword',
    };
  }

  if (EXACT_OPT_OUT.has(keyword)) {
    return {
      action: 'opt_out',
      reason: keyword.includes('WRONG') ? 'wrong_number' : 'opt_out_keyword',
      sourceKeyword: keyword,
      detectionMethod: tapbackStripped === normalized ? 'exact_keyword' : 'tapback_exact_keyword',
    };
  }

  if (/^STO+P+$/.test(keyword)) {
    return {
      action: 'opt_out',
      reason: 'opt_out_natural_language',
      sourceKeyword: keyword,
      detectionMethod: tapbackStripped === normalized ? 'typo_keyword' : 'tapback_typo_keyword',
    };
  }

  const wrongNumberMatch = WRONG_NUMBER_PATTERNS.find((pattern) => pattern.test(normalized));
  if (wrongNumberMatch) {
    return {
      action: 'opt_out',
      reason: 'wrong_number',
      sourceKeyword: wrongNumberMatch.source,
      detectionMethod: 'natural_language',
    };
  }

  const optOutMatch = OPT_OUT_PATTERNS.find((pattern) => pattern.test(normalized));
  if (optOutMatch) {
    return {
      action: 'opt_out',
      reason: 'opt_out_natural_language',
      sourceKeyword: optOutMatch.source,
      detectionMethod: 'natural_language',
    };
  }

  return { action: null };
}

function detectOptOut(body) {
  const result = detectSmsOptCommand(body);
  if (result.action !== 'opt_out') {
    return { optOut: false, source: null, matched: null };
  }
  return {
    optOut: true,
    source: result.detectionMethod && result.detectionMethod.includes('keyword') ? 'keyword' : 'natural_language',
    matched: result.sourceKeyword || null,
  };
}

function detectHelp(body) {
  const keyword = compactKeyword(body);
  if (HELP_KEYWORDS.has(keyword)) return { help: true, matched: keyword };
  return { help: false, matched: null };
}

module.exports = {
  detectSmsOptCommand,
  detectOptOut,
  detectHelp,
  HELP_RESPONSE_TEMPLATE,
  STOP_CONFIRMATION_TEMPLATE,
  _internals: {
    normalizeBody,
    stripTapbackPrefix,
    compactKeyword,
    HELP_KEYWORDS,
  },
};
