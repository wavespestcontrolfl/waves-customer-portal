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
 * CHUNKING POLICY (keep this comment and the doc in sync with any change) is
 * ALLOWLIST-WITH-VETO, not a blocklist: a completed sentence streams
 * progressively ONLY when it is BOTH allowlisted-safe (`isStreamSafe`) AND
 * not vetoed (`needsHold`). Earlier drafts of this policy held a sentence
 * only when it matched a commitment-phrase BLOCKLIST — but a blocklist for
 * "this sentence claims something happened" never converges: Codex found
 * "I'll book that" slipping the original hold-verb list, and the very next
 * pass found "I'll take care of that", "let me put that through", "I'll get
 * that over to the team", "consider it handled" — an unbounded set of ways
 * to phrase the same claim. Inverting to an allowlist ends that chase: an
 * ordinary declarative statement — even an innocuous one like "We treat for
 * ants and roaches." — now holds by DEFAULT, and only a small, enumerable
 * set of genuinely safe shapes (see `isStreamSafe` below) is allowed to
 * flush early. This costs nothing real: the actual latency win was never
 * "stream everything until proven risky", it was always the LEADING
 * acknowledgment/filler ("Sure, let me check on that for you.") ahead of
 * the model's real content — and that is exactly what the allowlist covers.
 *   1. Flush at a completed sentence boundary — '.', '!' or '?', optionally
 *      followed by one closing quote/paren, followed by whitespace. A
 *      trailing fragment with no boundary yet is held by the caller for the
 *      next delta. A '.' is deliberately NOT treated as a boundary when the
 *      token right before it is a common abbreviation (Mr/Mrs/Ms/Dr/St/Ave/
 *      Blvd/Rd/Ln/Ct/Hwy/Jr/Sr/vs/etc/approx/No/Mt/Ft/Pt/Apt/Ste/e.g/i.e/
 *      a.m/p.m/U.S — see ABBREVIATIONS) or a single-letter initial ("J.
 *      Smith") — holding a little longer than strictly necessary is always
 *      the safe direction.
 *   2. A completed sentence streams ONLY if `isStreamSafe` says so — the
 *      WHOLE trimmed sentence matches the SAFE_FILLER grammar (zero or more
 *      acknowledgments — sure/okay/great/got it/thanks/... — optionally
 *      followed by exactly ONE read-only clause: a modal (let me / I'll /
 *      I'm going to / I can / give me a moment to...) plus a read-only verb
 *      (check / look / look up / take a look / pull up / see / find /
 *      double-check — NEVER a write verb) and an optional object, or a bare
 *      "one moment" / "hang on" / "bear with me"; optional trailing
 *      "please"; terminal punctuation — see SAFE_FILLER_RE for the exact
 *      grammar) OR the sentence is a question (ends in '?'). "Let me check
 *      on that and I'll take care of it." has TWO clauses and does NOT
 *      match (the grammar allows exactly one, anchored end to end).
 *   3. Independently of `isStreamSafe`, `needsHold` VETOES a sentence —
 *      still holds it even if it would otherwise be allowlisted-safe (e.g.
 *      "Is nine a.m. open?" is a question but holds on the date/time veto)
 *      — when it contains a dollar amount (reusing
 *      eval/voice-relay-spoken-checks's amountMentions — the one regex bank
 *      this repo already trusts to recognize digit and spelled-out amounts,
 *      EN + ES), ANY digit or a date/time expression, a negation, a
 *      COMMITMENT-OR-SUCCESS CLAIM (an explicit commitment verb OR a
 *      success phrase that asserts the same thing without one — see
 *      COMMITMENT_OR_SUCCESS_RE), or a FUTURE/MODAL WRITE COMMITMENT ("I'll
 *      book that", a bare -ing write verb — see WRITE_COMMITMENT_RE). Once
 *      a sentence fails EITHER check (not allowlisted, or vetoed), every
 *      sentence after it in the SAME model round holds too — never
 *      reordered, never partially released mid-round. Independently,
 *      relay-conversation.js's round loop also stops flushing the moment any
 *      tool_use content block starts streaming (belt-and-braces for text
 *      that might follow a tool call, though in practice a tool call's own
 *      preceding text has usually already streamed by then).
 *   4. The held tail is only ever spoken once the round's finalMessage() is
 *      known AND the write-tool suppression check the block renderer already
 *      runs (WRITE_TOOLS / hasPendingWrite in relay-conversation.js) has
 *      cleared it — so a caller can never hear an amount, a date, a
 *      negation, or a stated commitment/success claim (or any other
 *      un-allowlisted statement) before the tool call that would make it
 *      true has actually run. This is the "run the same checks the block
 *      path runs on it" step from the brief: today the block renderer's
 *      only pre-speech check IS that write-tool suppression (no
 *      per-sentence semantic grader runs in the live path —
 *      voice-relay-spoken-checks is an offline eval grader, not a live
 *      gate), so PR C reuses that exact check rather than inventing a
 *      second, parallel one.
 *   5. EVERY progressive send — not just the round's first — revalidates the
 *      same late-supersession recheck the block renderer runs immediately
 *      before speaking (a reconnect can take the CallSid claim mid-round;
 *      there is no synchronous cross-socket takeover signal to shortcut
 *      this with, so each send re-reads the DB claim), serialized in order
 *      through a per-round promise chain — see relay-conversation.js's
 *      `_queueOrFlush`.
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
// whitespace — see policy note 1 above. '!'/'?' are always real boundaries;
// a '.' additionally needs to clear the abbreviation check below.
const BOUNDARY_RE = /[.!?]["'’)\]]?\s+/g;

// A '.' right after one of these (case-insensitive) is not a sentence
// boundary. Multi-period abbreviations (e.g., i.e., a.m., p.m., U.S.) are
// listed with their internal dots — WORD_BEFORE_PERIOD_RE below scans
// letters AND dots backward, so it captures "a.m" whole. A bare single
// letter ("J." as an initial) is handled separately, not listed here.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'ave', 'blvd', 'rd', 'ln', 'ct', 'hwy', 'jr', 'sr',
  'vs', 'etc', 'approx', 'no', 'mt', 'ft', 'pt', 'apt', 'ste',
  'e.g', 'i.e', 'a.m', 'p.m', 'u.s',
]);
const WORD_BEFORE_PERIOD_RE = /[A-Za-z.]+$/;

/** The letters+dots token immediately before `periodIndex` in `text`. */
function wordBeforePeriod(text, periodIndex) {
  const m = WORD_BEFORE_PERIOD_RE.exec(text.slice(0, periodIndex));
  return m ? m[0] : '';
}

/** Is the '.' at `periodIndex` an abbreviation's period, not a sentence end? */
function isAbbreviationPeriod(text, periodIndex) {
  const word = wordBeforePeriod(text, periodIndex);
  if (!word) return false;
  if (word.length === 1) return true; // a single-letter initial ("J.")
  return ABBREVIATIONS.has(word.toLowerCase());
}

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

// A FUTURE/MODAL WRITE COMMITMENT — "I'll book that", "I'm going to
// reschedule that", "let me submit that" — claims the same outcome
// COMMITMENT_OR_SUCCESS_RE catches for a COMPLETED action, just phrased as
// about-to-happen. A bare -ing form of a write verb ("Booking that now.")
// holds on its own, modal or not. Read-only verbs (check, look, pull up,
// see, find) are never in WRITE_VERBS_*, so "Let me check on that for you."
// / "One moment while I pull that up." still stream (P1-b).
const WRITE_COMMITMENT_MODAL_SOURCE = "i['’]ll|i will|i['’]m going to|i am going to|we['’]ll|we will|let me|i can|i['’]m|i am|going to";
const WRITE_VERBS_BASE_SOURCE = 'book|schedule|reschedule|refund|cancel|submit|send|text|email|charge|transfer|file|reserve|set up|put you down|add|confirm|note|pass|log|save|create|process';
const WRITE_VERBS_ING_SOURCE = 'booking|scheduling|rescheduling|refunding|cancelling|canceling|submitting|sending|texting|emailing|charging|transferring|filing|reserving|setting up|putting you down|adding|confirming|noting|passing|logging|saving|creating|processing';
const WRITE_COMMITMENT_RE = new RegExp(
  `\\b(?:${WRITE_COMMITMENT_MODAL_SOURCE})\\s+(?:to\\s+)?(?:${WRITE_VERBS_BASE_SOURCE}|${WRITE_VERBS_ING_SOURCE})\\b`
  + `|\\b(?:${WRITE_VERBS_ING_SOURCE})\\b`,
  'i',
);

// ── SAFE_FILLER grammar (allowlist) ─────────────────────────────────────────
// A phrase BLOCKLIST for commitments does not converge: every round finds
// another way to say "handled" ("I'll take care of that", "let me put that
// through", "consider it handled", ...) that no finite hold-verb list will
// ever fully enumerate. Streaming a bare sentence therefore no longer
// defaults to safe — see `isStreamSafe` below, which `needsHold` above still
// VETOES (an amount/date/negation/commitment sentence is held regardless of
// how it's phrased). Acknowledgments, one read-only "let me check on that"
// clause, and questions are the actual latency win (the leading filler
// before the model's real content); a full declarative statement — even an
// innocuous one like "We treat for ants and roaches." — now holds by
// default, same as an unrecognized commitment phrasing would.
const ACK_SOURCE = 'sure|okay|ok|all right|alright|great|perfect|absolutely|of course|got it|gotcha|'
  + 'thank you|thanks|sounds good|happy to help|you bet|certainly|yes|yeah|yep|hi|hello';
// One acknowledgment, or a list of them joined by , . or ! (each optionally
// padded with whitespace) — "Sure, okay." / "Great! Perfect."
const ACKS_SOURCE = `(?:${ACK_SOURCE})(?:\\s*[,.!]\\s*(?:${ACK_SOURCE}))*`;
// A single read-only clause: a modal (let me / I'll / I'm going to / I can /
// give me a moment to...) plus a read-only verb (never a write verb — see
// WRITE_VERBS_* above, which this deliberately does not reuse any of) and an
// optional object. "Let me check on that and I'll take care of it." has TWO
// clauses joined by "and" and must NOT match — the grammar allows exactly
// ONE, anchored end to end below.
const FILLER_MODAL_SOURCE = "let me|i['’]ll|i will|i['’]m going to|i can|give me a (?:moment|sec|second)(?: (?:to|while i))?";
const FILLER_VERB_SOURCE = 'take a look|look up|look|check|pull up|see|find|double-check';
const FILLER_PREP_SOURCE = 'on|at|into|for|up';
const FILLER_OBJECT_SOURCE = 'that|this|it|your (?:account|info|information|details|file|address|records?)';
const FILLER_CLAUSE_SOURCE = `(?:${FILLER_MODAL_SOURCE}) (?:quickly )?(?:${FILLER_VERB_SOURCE})`
  + `(?: (?:(?:${FILLER_PREP_SOURCE}) )?(?:${FILLER_OBJECT_SOURCE}))?(?: for you)?`;
// A short hold-on phrase stands in for the read-only clause on its own.
const FILLER_WAIT_SOURCE = 'one moment|just a moment|one sec|just a sec|hang on|bear with me';
const FILLER_CLAUSE_OR_WAIT_SOURCE = `(?:(?:${FILLER_CLAUSE_SOURCE})|(?:${FILLER_WAIT_SOURCE}))`;
const SAFE_FILLER_RE = new RegExp(
  '^\\s*(?:'
  + `${ACKS_SOURCE}(?:\\s*[,.!]\\s*${FILLER_CLAUSE_OR_WAIT_SOURCE})?` // acks, optionally + one clause
  + `|${FILLER_CLAUSE_OR_WAIT_SOURCE}` // or just the clause, no acks
  + `)(?: please)?\\s*[.!?]["'’)\\]]?\\s*$`,
  'i',
);
// A question streams only when it is ONE clause that is plainly a question:
// an optional acknowledgment, then a question word/auxiliary, then no clause
// joiner (, ; : dashes, and/so/but/because) before the final '?' — and,
// like every streamed sentence, needsHold still vetoes it ("What time on
// Tuesday works?" holds). A
// statement with a question tacked on ("I've handled that, anything
// else?") is two clauses and holds.
const QUESTION_WORD_SOURCE = "what|what['’]s|when|where|which|who|whose|how|why|is|are|was|were|do|does|did|"
  + "can|could|would|will|should|shall|may|have|has|anything|any|is there|are there";
const QUESTION_RE = new RegExp(
  `^\\s*(?:${ACKS_SOURCE}\\s*[,.!]\\s*)?(?:${QUESTION_WORD_SOURCE})\\b`
  + "(?:(?![,;:\u2013\u2014]|\\s-\\s|\\b(?:and|so|but|because)\\b)[^?])*\\?[\"'’)\\]]?\\s*$",
  'i',
);

/**
 * Is this completed sentence provably commitment-free — safe to speak
 * before the model's full reply (and any tool call it might make) is known?
 * The allowlist half of the policy; `needsHold` above is the veto that
 * still wins regardless (an amount/date/negation/commitment phrase holds
 * even inside a question, e.g. "Is nine a.m. open?").
 */
function isStreamSafe(sentence) {
  const t = String(sentence || '').trim();
  if (!t) return false;
  if (SAFE_FILLER_RE.test(t)) return true;
  return QUESTION_RE.test(t);
}

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
    // A '.' right after a common abbreviation or a single-letter initial is
    // not a sentence boundary (P2-e) — keep scanning past it rather than
    // splitting here. '!' and '?' never need this check.
    if (m[0][0] === '.' && isAbbreviationPeriod(text, m.index)) {
      re.lastIndex = m.index + 1;
      continue;
    }
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
  if (WRITE_COMMITMENT_RE.test(t)) return true;
  return false;
}

module.exports = {
  splitSentences, needsHold, isStreamSafe, NON_ENGLISH_HINT_RE, BOUNDARY_RE, NEGATION_RE, DATE_TIME_RE,
  COMMITMENT_OR_SUCCESS_RE, WRITE_COMMITMENT_RE, ABBREVIATIONS, isAbbreviationPeriod, SAFE_FILLER_RE, QUESTION_RE,
};
