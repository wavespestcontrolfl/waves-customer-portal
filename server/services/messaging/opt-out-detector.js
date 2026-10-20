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
  /\bno\s+more\s+(texts?|messages?|sms)\b/i,
  /\bwrong\s+number\b/i,
  /\bnot\s+(my|the)\s+number\b/i,
];

// A bare "no text(s)" / "no messages" stays a stop request almost everywhere ("No texts please",
// "Can I get no texts from you?", "No texts, only calls?"). It is NOT one only when the sentence
// reports, in the past tense, a text that never came, as a complaint did on 2026-10-19 ("I got the
// confirmation but no text that day" unsubscribed the customer twice). The evidence:
//   - a receiving or reporting word just before it ("got no text", "there was no message",
//     "there's been no text", "have had no texts"; a bare "been" or "was" is not one);
//   - an arrival or delivery word just after it ("no text came", "no text was received", "no
//     messages were delivered"; a time word or a bare "delivered" is not one: "No texts delivered
//     to this number please" is a request);
//   - "that day" just after it, with a receiving verb (got, received, saw, heard) earlier in the
//     same comma clause.
// No evidence counts after a conditional, request or speech word earlier in the sentence (if,
// unless, rather, wish, prefer, want, need, ask, request, like, say, tell): "I would prefer it if I
// received no texts" and "I asked that no messages were sent to me" are requests. Nor before a
// "keep it that way" wording after it ("I got no texts, keep it that way" is a request), nor when
// a word about the future ends the phrase, within four words and no comma ("I got the
// confirmation but no text that day or ever again" is a request). Only words that close the
// phrase count (anymore, ever again, "or from now on"): "from now on" alone can open the next
// request ("I got no text that day and from now on please text me the day before").
// Sentences end at . ! ? or ; (a line break or a comma does not end one: "No\ntexts please" is a
// request). "No more texts" stays a stop request anywhere (OPT_OUT_PATTERNS above).
const NO_TEXTS = /\bno\s+(?:text\s+messages?|texts?|messages?|sms)\b/gi;
const PAST_REPORT_JUST_BEFORE = /\b(?:got|gotten|received|saw|seen|heard|had|there(?:'s|\s+has|\s+have)\s+been|there\s+(?:was|were)|(?:was|were)\s+there)\s+$/i;
const PAST_ARRIVAL_AFTER = /^\s+(?:came|arrived|showed\s+up|went\s+out|(?:was|were|got|(?:has|have|had)\s+been)\s+(?:sent|received|delivered))\b/i;
const THAT_DAY_AFTER = /^\s+that\s+day\b/i;
const PAST_RECEIVING_EARLIER = /\b(?:got|gotten|received|saw|heard)\b/i;
const REQUEST_CONTEXT_EARLIER = /\b(?:if|unless|rather|wish|prefer|prefers|preferred|want|wants|wanted|need|needs|needed|ask|asks|asked|request|requests|requested|like|say|says|said|tell|tells|told)\b/i;
const KEYWORD_FILLER = /\b(?:please|pls|plz|thanks|thank\s+you|thx|now|asap|already|just)\b/gi;
const REQUEST_CONTEXT_AFTER = /\b(?:(?:keep|leave)\s+(?:it|them)\s+(?:that\s+way|like\s+that|off)|(?:stay|stays|remain|remains)\s+that\s+way|(?:want|prefer|like)\s+it\s+(?:that\s+way|like\s+that))\b/i;
const FUTURE_AFTER = /^(?:\s+[\w']+){0,4}?\s+(?:anymore|any\s+more|ever\s+again|(?:or|nor)\s+(?:from\s+now\s+on|going\s+forward|in\s+the\s+future))\b/i;
const STOP_LANGUAGE = /(?<!\b(?:don'?t|do\s+not|never|not|won'?t|can'?t|didn'?t|doesn'?t)\s+)\b(?:stop(?!\s+(?:by|over|in|at|back)\b)|stopp|unsubscribe|unsub|opt[\s-]?out|revoke|leave\s+me\s+alone|lose\s+my\s+number|take\s+me\s+off|remove\s+me|(?:don'?t|do\s+not)\s+(?:text|message|contact|call|send|email|bother))\b/i;

function sentencesOf(body) {
  const pieces = String(body || '').replace(/[\u2018\u2019]/g, "'").match(/[^.!?;]+[.!?;]*/g) || [];
  return pieces.map((piece) => piece.replace(/[.!?;]+$/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// 'request', 'report' (a missing-text complaint) or null (no "no texts" in the sentence).
function noTextsKind(text) {
  const matches = [...text.matchAll(NO_TEXTS)];
  if (!matches.length) return null;
  const isRequest = matches.some((match) => {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    const sameClause = before.split(',').pop();
    const reportsPastText = !REQUEST_CONTEXT_EARLIER.test(before) && !REQUEST_CONTEXT_AFTER.test(after)
      && !FUTURE_AFTER.test(after)
      && (PAST_REPORT_JUST_BEFORE.test(before) || PAST_ARRIVAL_AFTER.test(after)
        || (THAT_DAY_AFTER.test(after) && PAST_RECEIVING_EARLIER.test(sameClause)));
    return !reportsPastText;
  });
  return isRequest ? 'request' : 'report';
}

function asksForNoTexts(body) {
  const sentences = sentencesOf(body);
  const kinds = sentences.map(noTextsKind);
  if (kinds.includes('request')) return true;
  // A missing-text report is exempt, but not when the message also says stop: explicit stop
  // language or a "keep it that way" wording anywhere ("I got no text. Stop contacting me", "I got
  // no texts. Please keep it that way"; "stop by" is a visit and "don't stop" is the opposite), or
  // a clause that is a plain opt-out keyword with polite words around it
  // ("I got no text. Cancel please"; "Cancel it" names a visit, not texts). The exact-keyword
  // check above only reads a whole message.
  if (!kinds.includes('report')) return false;
  if (STOP_LANGUAGE.test(body) || REQUEST_CONTEXT_AFTER.test(body)) return true;
  return String(body || '').split(/[.!?;,\n\r]+/).some((clause) => {
    const keyword = compactKeyword(clause.replace(KEYWORD_FILLER, ' '));
    return EXACT_OPT_OUT.has(keyword) || /^STO+P+$/.test(keyword);
  });
}

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

// Footer-stripping (a set of regexes that removed a vendor's own reply
// instruction before matching) was removed 2026-09-11 (codex round 3 P0
// 3987949450 / P1 3987949459 design fix). It existed only to keep a
// NON-eligible sender's own compliance footer ("Reply STOP to stop
// messages.") from being misread as their opt-out \u2014 but this detector now
// only ever runs against a COMPLIANCE-ELIGIBLE sender's full, untouched
// text (server/routes/twilio-webhook.js resolves eligibility before calling
// this at all); a non-eligible sender's text never reaches
// `detectSmsOptCommand` for opt-out purposes in the first place, so there is
// nothing left to strip. See docs/public-route-contracts.md:200-260 and the
// "Consent-before-classification" section of PR #4244.
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

function detectSmsOptCommand(body) {
  const normalized = normalizeBody(body);
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

  if (asksForNoTexts(body)) {
    return {
      action: 'opt_out',
      reason: 'opt_out_natural_language',
      sourceKeyword: NO_TEXTS.source,
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
