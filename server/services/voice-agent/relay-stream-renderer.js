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
 *      recognize digit and spelled-out amounts, EN + ES), a date/time
 *      expression, a negation, or a commitment verb (booked / scheduled /
 *      sent / charged / refunded / confirmed / ...). Once a sentence is
 *      held, every sentence after it in the SAME model round is held too —
 *      never reordered, never partially released mid-round.
 *   3. The held tail is only ever spoken once the round's finalMessage() is
 *      known AND the write-tool suppression check the block renderer already
 *      runs (WRITE_TOOLS / hasPendingWrite in relay-conversation.js) has
 *      cleared it — so a caller can never hear an amount, a date, a
 *      negation, or a stated commitment before the tool call that would make
 *      it true has actually run. This is the "run the same checks the block
 *      path runs on it" step from the brief: today the block renderer's only
 *      pre-speech check IS that write-tool suppression (no per-sentence
 *      semantic grader runs in the live path — voice-relay-spoken-checks is
 *      an offline eval grader, not a live gate), so PR C reuses that exact
 *      check rather than inventing a second, parallel one.
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

// Sentence boundary: '.', '!' or '?', one optional closing quote/paren, then
// whitespace. Deliberately simple — see policy note 1 above.
const BOUNDARY_RE = /[.!?]["'’)\]]?\s+/g;

const NEGATION_RE = /\b(no|not|never|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|don['’]t|doesn['’]t|didn['’]t|won['’]t|wouldn['’]t|can['’]t|cannot|couldn['’]t|shouldn['’]t|nobody|nothing|none|without|no longer|not yet)\b/i;

const DATE_TIME_RE = new RegExp(
  '\\b('
  + 'sunday|monday|tuesday|wednesday|thursday|friday|saturday|'
  + 'january|february|march|april|may|june|july|august|september|october|november|december|'
  + 'today|tomorrow|tonight|yesterday|'
  + '\\d{1,2}:\\d{2}\\s*(?:am|pm)?|\\d{1,2}\\s?(?:am|pm|a\\.m\\.|p\\.m\\.)'
  + ')\\b',
  'i',
);

const COMMITMENT_VERB_RE = /\b(booked|scheduled|re-?scheduled|sent|texted|emailed|charged|refunded|confirmed|cancell?ed|filed|submitted|transferred|saved|logged)\b/i;

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
  if (amountMentions(t).length) return true;
  if (DATE_TIME_RE.test(t)) return true;
  if (NEGATION_RE.test(t)) return true;
  if (COMMITMENT_VERB_RE.test(t)) return true;
  return false;
}

module.exports = { splitSentences, needsHold, BOUNDARY_RE, NEGATION_RE, DATE_TIME_RE, COMMITMENT_VERB_RE };
