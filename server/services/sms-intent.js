/**
 * Inbound SMS intent detection.
 *
 * Used by the Twilio webhook to decide whether the AI auto-reply is allowed
 * to answer. Scheduling-intent messages are high-stakes — a wrong "fully
 * booked" auto-reply to a customer who already has an appointment erodes
 * trust fast. Until the AI has reliable appointment-lookup tool-use, these
 * messages bypass auto-reply and land in Virginia's inbox.
 *
 *   hasSchedulingIntent(body) -> boolean
 *   isSmsReaction(body) -> boolean
 *
 * Returns true if the body looks like it's asking about timing, scheduling,
 * an existing appointment, or coordinating an arrival window.
 */

// Single phrases/tokens that strongly imply scheduling intent. We match on
// word boundaries where possible to avoid false positives on substrings.
const KEYWORDS = [
  'appointment', 'appt', 'booked', 'schedule', 'scheduled', 'rescheduled',
  'rescheduling', 'reschedule', 'reschedule', 'booking', 'coming', 'come',
  'arriving', 'arrive', 'arrival', 'window', 'eta', 'time slot',
  'what time', 'when will', 'are we', 'are you', 'see you', 'tomorrow',
  'today', 'tonight', 'yesterday', 'this week', 'next week', 'this morning',
  'this afternoon', 'this evening', 'on the schedule', 'still on', 'confirm',
  'confirmed', 'confirmation',
];

const DAY_NAMES = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
];

// Month names work as a scheduling signal when paired with a number ("April
// 17") — bare "May" is too ambiguous to gate on. The regex below captures
// "<month> <day>" patterns as an intent trigger.
const MONTH_DAY_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i;

// "Friday the 17th" / "17th" / "on the 12th" — ordinal date references.
const ORDINAL_DATE_RE = /\b(?:the\s+)?\d{1,2}(?:st|nd|rd|th)\b/i;

// Bare time of day: "3pm", "at 3", "10:30am", "noon", "morning"
const TIME_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b|\b(?:noon|midnight|morning|afternoon|evening)\b/i;

const SMS_REACTION_TARGET_RE = '(?:[\\u201c"].+[\\u201d"]|an?\\s+(?:image|photo|video|audio message|attachment|message))';
const SMS_REACTION_RE = new RegExp(`^(liked|loved|disliked|laughed at|emphasized|questioned)\\s+${SMS_REACTION_TARGET_RE}$`, 'i');
const REMOVED_SMS_REACTION_RE = new RegExp(`^removed\\s+(?:a|an)\\s+(?:like|heart|dislike|laugh|emphasis|question mark)\\s+from\\s+${SMS_REACTION_TARGET_RE}$`, 'i');

function hasSchedulingIntent(body) {
  if (!body || typeof body !== 'string') return false;
  const lower = body.toLowerCase();

  for (const kw of KEYWORDS) {
    // Word-ish boundary — allow leading/trailing non-letter.
    const re = new RegExp(`(^|[^a-z])${escapeRe(kw)}([^a-z]|$)`);
    if (re.test(lower)) return true;
  }

  for (const d of DAY_NAMES) {
    const re = new RegExp(`(^|[^a-z])${d}([^a-z]|$)`);
    if (re.test(lower)) return true;
  }

  if (MONTH_DAY_RE.test(body)) return true;
  if (TIME_RE.test(body)) return true;

  // Ordinal alone is weak; pair it with a date-ish word.
  if (ORDINAL_DATE_RE.test(body) && /\b(?:on|the|for|at|see)\b/i.test(body)) return true;

  return false;
}

function isSmsReaction(body) {
  if (!body || typeof body !== 'string') return false;
  const text = body.trim();
  return SMS_REACTION_RE.test(text) || REMOVED_SMS_REACTION_RE.test(text);
}

// Reschedule/away intent — a strict SUBSET of scheduling intent. Scheduling
// intent only decides whether the AI auto-reply stands down; this detector
// decides whether to raise a "customer is asking to move or miss an upcoming
// visit" flag, so it must not fire on ordinary timing questions ("what time
// are you coming?"). Recall is weighted over precision within that subset:
// a false positive costs one owner bell, a false negative is the 2026-08-05
// incident class where a 12:30am "can we reschedule?" text was followed by
// the visit running (and invoicing) on schedule.
const RESCHEDULE_DIRECT_RE = /\b(?:re-?schedul\w*|re-?book\w*|postpon\w*|different\s+(?:day|date|time)|another\s+(?:day|date|time)|(?:can|could)\s+we\s+(?:do|move|push|change)\s+(?:it|this|that|the\s+\w+)?\s*(?:to|till|until|for)\s+(?:next|another|a\s+different|later|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day)|skip\s+(?:this|the|my|that)\s+(?:one|visit|service|month|week|appointment|appt)|skip\s+(?:today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|next\s+week))\b/i;
// Move-verbs only count with a displacement preposition or an appointment
// noun nearby — bare "moving" ("we're moving the couch") must not fire.
// Move-verbs need an APPOINTMENT object or an explicit temporal target —
// "change the date on my invoice" / "move the card payment" must not flag
// (codex #3232 r4).
const MOVE_VERB_RE = /\b(?:mov(?:e|ing)|push(?:ed|ing)?|bump(?:ed|ing)?|chang(?:e|ing))\b(?:[^.!?\n]{0,40}\b(?:appointment|appt|service|visit)\b|[^.!?\n]{0,40}\b(?:till|until|to)\s+(?:next\s+(?:week|month)|tomorrow|late[r]?\s+\w+|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|(?:october|november|december|january|february|march|april|may|june|july|august|september)|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})\b|[^.!?\n]{0,40}\b(?:an?\s+hour|half\s+an?\s+hour|(?:one|two|three|four|five|\d+)\s+(?:hours?|min(?:ute)?s?))\b)/i;
const CANCEL_RE = /\bcancel\w*\b/i;
// cancel* alone is unusable — "did you cancel autopay?" / "don't cancel"
// are not reschedule asks (codex #3232 r3): require appointment context,
// exclude negations and non-appointment objects.
const CANCEL_CONTEXT_RE = /\b(?:appointment|appt|visit|service|treatment|today|tomorrow|(?:next|this)\s+week|the\s+\d{1,2}(?:st|nd|rd|th)|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day)\b/i;
const CANCEL_NEGATION_RE = /\b(?:don'?t|do\s+not|not|never|no\s+need\s+to)\s+(?:want\s+to\s+|need\s+to\s+|going\s+to\s+)?cancel/i;
const CANCEL_NONAPPT_RE = /\bcancel\w*\s+(?:[\w'’]+\s+){0,2}?(?:invoice|autopay|payment|card|subscription|estimate|quote)s?\b/i;
const AWAY_RE = /\b(?:out\s+of\s+town|on\s+vacation|leav(?:e|ing)\s+for\s+vacation|going\s+out\s+of\s+town|(?:won'?t|will\s+not|not\s+going\s+to)\s+be\s+(?:home|here|there|in\s+town)|away\s+(?:until|till|through|for)|travel(?:ing|ling)\s+(?:until|till|through|next|this)|back\s+(?:in\s+town\s+)?(?:on|until|till)\b|not\s+(?:be\s+)?back\s+(?:till|until)|(?:am|'m)\s+away\b|away\s+(?:this|next)\s+(?:week|month)|not\s+(?:at\s+)?home\s+(?:today|tomorrow|this|next|until|till))\b/i;
// Away + permission = a heads-up, not a reschedule ask ("won't be home but
// here's the gate code" / "exterior only is fine"). Permission only
// suppresses the AWAY leg — an explicit reschedule/cancel verb still wins.
const AWAY_PERMISSION_RE = /\b(?:gate\s*code|door\s+(?:is\s+|will\s+be\s+)?(?:open|unlocked)|garage\s+(?:is\s+|will\s+be\s+)?open|no\s+need\s+to\s+(?:be|get|come)\s+in|don'?t\s+need\s+to\s+(?:be|get|come)\s+in|(?:it|that)'?s\s+fine|exterior\s+(?:only\s+)?(?:is\s+)?fine|(?:you|y'?all)\s+can\s+still\s+(?:come|do|spray|treat)|go\s+ahead)\b/i;

function hasRescheduleOrAwayIntent(body) {
  if (!body || typeof body !== 'string') return false;
  if (isSmsReaction(body)) return false;
  // Phone keyboards produce typographic apostrophes — "won\u2019t" must match
  // the same patterns as "won't".
  const text = body.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  const cancelAsk = CANCEL_RE.test(text) && CANCEL_CONTEXT_RE.test(text)
    && !CANCEL_NEGATION_RE.test(text) && !CANCEL_NONAPPT_RE.test(text)
    // Acknowledgments / status questions about a DONE cancellation are
    // not requests (codex r18): "Has my appointment been canceled?",
    // "Did you cancel…?", "Thanks for canceling."
    // Perfect/passive/interrogative DONE-forms only (codex r19): "I have
    // to cancel" and "I was hoping to cancel" are active requests.
    && !(/\b(?:has|have|had|was|were)\b[^.!?]{0,30}\b(?:been\s+)?cancell?ed\b|\bdid\s+you\s+cancel\b|\bthanks?\s+(?:you\s+)?for\s+cancel/i.test(text)
      // …unless a FRESH cancel ask follows the acknowledgment (codex r22).
      && !/\b(?:need|want|like|have)\s+to\s+cancel|\bplease\s+cancel|\bcancel\w*(?:\s+\w+){0,2}\s+again\b/i.test(text));
  // "don't reschedule us, you can still come" is the opposite of a
  // reschedule ask (codex r5).
  // A FRESH request anywhere overrides status/acknowledgment clauses
  // (codex r15/r16): "…been rescheduled, but I need to reschedule again."
  const freshAsk = /\b(?:need|want|like|have)\s+to\s+re-?schedul|\bre-?schedul\w*(?:\s+\w+){0,2}\s+again\b/i.test(text);
  const negated = /\b(?:don'?t|do\s+not|no\s+need\s+to|not\s+necessary\s+to|never)\s+(?:\w+\s+){0,2}?(?:reschedul|re-?book|move|change)/i.test(text)
    // Present-perfect confirmations / status questions (codex r13) and
    // past acknowledgments (codex r9) — both yield to a fresh ask.
    || (!freshAsk && /\b(?:has|have|had|is|was)\b[^.!?]{0,30}\bbeen\s+re-?schedul/i.test(text))
    || (!freshAsk && /\b(?:thanks?\s+for|thank\s+you\s+for|already|were|was|got)\s+(?:being\s+)?re-?schedul/i.test(text))
    // Non-appointment reschedule objects (codex r16): "reschedule my
    // autopay/payment" is billing, not an appointment change.
    || /\b(?:re-?schedul\w*|postpon\w*|mov(?:e|ing)|push(?:ing|ed)?|defer(?:ring)?|delay(?:ing)?|chang(?:e|ing))\s+(?:[\w'’]+\s+){0,2}?(?:autopay|payment|invoice|card|subscription|bill|billing)s?\b/i.test(text)
    // Billing subjects with date-only phrasing (codex r23): "can I make
    // my payment a different day?"
    || /\b(?:autopay|payment|invoice|card|subscription|bill|billing)s?\b[^.!?]{0,30}\b(?:different|another)\s+(?:day|date|time)\b|\b(?:different|another)\s+(?:day|date|time)\b[^.!?]{0,20}\b(?:autopay|payment|invoice|bill|billing)s?\b/i.test(text);
  if (!negated && (RESCHEDULE_DIRECT_RE.test(text) || MOVE_VERB_RE.test(text))) return true;
  if (cancelAsk) return true;
  // Past absences are history, not a request (codex r17): "we were out
  // of town last week".
  const pastAway = /\b(?:were|was|got\s+back|just\s+got\s+back|returned)\b[^.!?]{0,25}\b(?:out\s+of\s+town|on\s+vacation|away)\b|\b(?:out\s+of\s+town|on\s+vacation|away)\b[^.!?]{0,15}\blast\s+(?:week|month|weekend)\b/i.test(text);
  return AWAY_RE.test(text) && !AWAY_PERMISSION_RE.test(text) && !pastAway;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { hasSchedulingIntent, isSmsReaction, hasRescheduleOrAwayIntent };
