/**
 * relay-stream-renderer.js — PR C: pure sentence-chunking + hold-policy
 * helpers for VOICE_RELAY_RENDERER=stream. No side effects and no session
 * state — RelayConversation (relay-conversation.js) owns the actual Twilio
 * sends and transcript entries; this module only decides WHERE a completed
 * sentence boundary is and WHETHER a given sentence is safe to speak before
 * the model's full reply is known. See the selector + integration notes in
 * relay-conversation.js's file header and docs/conversationrelay-booking-plan.md
 * for the narrative version of this policy.
 *
 * CHUNKING POLICY (keep this comment and the doc in sync with any change):
 *   1. Flush at a completed sentence boundary — '.', '!' or '?', optionally
 *      followed by one closing quote/paren, followed by whitespace. A
 *      trailing fragment with no boundary yet is held by the caller for the
 *      next delta; a missed boundary (an abbreviation like "Dr.") just holds
 *      a little longer than strictly necessary — the safe direction always.
 *   2. A completed sentence is HELD (never sent as a progressive chunk) when
 *      it contains a dollar amount (reusing eval/voice-relay-spoken-checks's
 *      amountMentions — the one regex bank this repo already trusts to
 *      recognize digit and spelled-out amounts, EN + ES), ANY digit or a date/time
 *      expression, a negation, or a COMMITMENT-OR-SUCCESS CLAIM: an explicit
 *      commitment verb (booked / scheduled / sent / charged / refunded /
 *      confirmed / ...) OR a success phrase that asserts the same thing
 *      without one ("you're all set", "taken care of", "got you booked",
 *      "on the calendar", "I've sent that over", ...) — see
 *      COMMITMENT_OR_SUCCESS_RE below for the full list. Once a sentence is
 *      held, every sentence after it in the SAME model round is held too —
 *      never reordered, never partially released mid-round. Independently,
 *      relay-conversation.js's round loop also stops flushing the moment any
 *      tool_use content block starts streaming (belt-and-braces for text
 *      that might follow a tool call, though in practice a tool call's own
 *      preceding text has usually already streamed by then — the hold list
 *      above is what actually keeps a false "you're all set" off the air).
 *   3. The held tail is only ever spoken once the round's finalMessage() is
 *      known AND the write-tool suppression check the block renderer already
 *      runs (WRITE_TOOLS / hasPendingWrite in relay-conversation.js) has
 *      cleared it — so a caller can never hear an amount, a date, a
 *      negation, or a stated commitment/success claim before the tool call
 *      that would make it true has actually run. This is the "run the same
 *      checks the block path runs on it" step from the brief: today the
 *      block renderer's only pre-speech check IS that write-tool suppression
 *      (no per-sentence semantic grader runs in the live path —
 *      voice-relay-spoken-checks is an offline eval grader, not a live
 *      gate), so PR C reuses that exact check rather than inventing a
 *      second, parallel one.
 *   4. Every progressive send is also gated, ONCE per round, on the same
 *      late-supersession recheck the block renderer runs immediately before
 *      speaking (a reconnect can take the CallSid claim mid-round) — see
 *      relay-conversation.js's `_gateFirstFlush`.
 */

let _amountMentions = null;
/** Lazy + cached: keeps the (large) eval spoken-checks module out of the
 * block renderer's (the default's) require graph — it is only ever touched
 * by a session actually running VOICE_RELAY_RENDERER=stream. */
function amountMentions(text) {
  if (!_amountMentions) {
    _amountMentions = require('../eval/voice-relay-spoken-checks')._internals.amountMentions;
  }
  return _amountMentions(text);
}

// The date/negation/commitment regexes below are ENGLISH-ONLY. A Spanish
// session never flushes progressively at all (RelayConversation starts its
// stream state already holding — block timing), and this is the belt for an
// English session whose model answers in Spanish anyway: any sentence with
// Spanish orthography or a common Spanish function/success word is held to
// finalize, where the write-tool check applies. A false hold only costs
// latency, never correctness.
const NON_ENGLISH_HINT_RE = /[áéíóúñü¿¡]|\b(?:el|la|los|las|le|les|un|una|en|que|de|del|por|con|muy|pero|y|es|son|hay|aqu[ií]|ahora|momento|mensaje|servicio|listo|lista|ya|est[aá]|qued[oó]|cita|usted|su|sus|para|gracias|agendad[oa]s?|reservad[oa]s?|confirmad[oa]s?|programad[oa]s?|enviad[oa]s?|hoy|mañana|nunca|tampoco|ningun[oa]?)\b/i;

// Sentence boundary: '.', '!' or '?', one optional closing quote/paren, then
// whitespace. Deliberately simple — see policy note 1 above.
const BOUNDARY_RE = /[.!?]["'’)\]]?\s+/g;

const NEGATION_RE = /\b(no|not|never|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|don['’]t|doesn['’]t|didn['’]t|won['’]t|wouldn['’]t|can['’]t|cannot|couldn['’]t|shouldn['’]t|nobody|nothing|none|without|no longer|not yet)\b/i;

// Date/time: deliberately STRUCTURAL rather than a phrase list, since a
// scheduling claim can be phrased endless ways. ANY digit holds (times,
// ordinals like "the 15th", counts, addresses — a false hold only costs
// latency). Beyond digits: weekday/month names, relative day/part-of-day and
// calendar-unit words, and spelled-out clock times ("at nine", "two
// o'clock", "nine thirty", "on the fifteenth"). Bare "one" is NOT matched on
// its own so the "one moment" filler still streams.
const HOUR_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const ORDINAL_WORDS = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|'
  + 'thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|'
  + 'twenty[- ](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|thirty[- ]first';
const DATE_TIME_RE = new RegExp(
  '\\d'
  + '|\\b(?:'
  + 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekday|weekend|'
  + 'january|february|march|april|may|june|july|august|september|october|november|december|'
  + 'today|tomorrow|tonight|yesterday|morning|afternoon|evening|noon|midday|midnight|overnight|'
  + 'week|weeks|month|months|asap|a\\.m\\.|p\\.m\\.|am|pm|o[\'’]clock|'
  + `(?:at|by|around|until|till|after|before|from|between)\\s+(?:${HOUR_WORDS})\\b|`
  + `(?:${HOUR_WORDS})\\s+(?:thirty|fifteen|forty[- ]five|o[\'’]clock)|`
  // An ordinal is a date when it closes a phrase ("how about the fifteenth?")
  // or follows on/by/for/until/after/before the — not "the first question".
  + `the\\s+(?:${ORDINAL_WORDS})(?=\\s*(?:[.,!?;]|$|of\\b|at\\b|in\\b))|`
  + `(?:on|by|for|until|till|after|before|from)\\s+the\\s+(?:${ORDINAL_WORDS})\\b`
  + ')',
  'i',
);

// A COMMITMENT-OR-SUCCESS CLAIM: an explicit commitment verb, OR a success
// phrase that asserts the same outcome without using one of those verbs
// ("you're all set" claims exactly what "booked" claims). Deliberately
// broad — a false hold just delays a safe sentence to finalize (still spoken
// the same call), where a missed one could speak a completed-action claim
// before the tool that would make it true has run. See policy note 2 above.
const COMMITMENT_OR_SUCCESS_RE = new RegExp(
  '\\b('
  + 'booked|scheduled|re-?scheduled|sent|texted|emailed|charged|refunded|confirmed|cancell?ed|filed|submitted|'
  + 'transferred|saved|logged|reserved|created|completed|done|processed'
  + ')\\b'
  + '|\\ball set\\b'
  + "|\\byou[’']re set\\b"
  + '|\\btaken care of\\b'
  + '|\\bgot you (?:down|in|scheduled|booked)\\b'
  + '|\\bput you down\\b'
  + '|\\bon the (?:calendar|schedule|books)\\b'
  + '|\\blocked in\\b'
  + '|\\bset up\\b'
  + '|\\bon (?:its|the) way\\b'
  + "|\\bI[’']ve (?:sent|booked|scheduled|added|noted|passed)\\b"
  + '|\\bsomeone will (?:call|reach|text)\\b',
  'i',
);

/**
 * Split a growing buffer into complete sentences (each carrying its own
 * trailing boundary whitespace, exactly as found) plus whatever incomplete
 * fragment is left at the end. Sentences concatenated with `rest` always
 * reconstruct `buffer` byte-for-byte — no trimming happens here.
 */
function splitSentences(buffer) {
  const text = String(buffer || '');
  const sentences = [];
  let start = 0;
  const re = new RegExp(BOUNDARY_RE.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    sentences.push(text.slice(start, end));
    start = end;
  }
  return { sentences, rest: text.slice(start) };
}

/** Does this completed sentence need to wait for the full reply? */
function needsHold(sentence) {
  const t = String(sentence || '');
  if (!t.trim()) return false;
  if (NON_ENGLISH_HINT_RE.test(t)) return true;
  if (amountMentions(t).length) return true;
  if (DATE_TIME_RE.test(t)) return true;
  if (NEGATION_RE.test(t)) return true;
  if (COMMITMENT_OR_SUCCESS_RE.test(t)) return true;
  return false;
}

module.exports = { splitSentences, needsHold, NON_ENGLISH_HINT_RE, BOUNDARY_RE, NEGATION_RE, DATE_TIME_RE, COMMITMENT_OR_SUCCESS_RE };
