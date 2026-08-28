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

// The quoted body is a negated class, NOT `.+`, for two reasons. (1) `.` never
// matches \n, and a tapback quotes the original message VERBATIM — every
// appointment template is multi-line ("…4:00 PM.\n\nReschedule here: <url>"),
// so `.+` could not span the quote, the reaction read as ordinary prose, and
// its quoted "Reschedule here:" line tripped the reschedule detector into
// belling the owner about a visit nobody asked to move (2026-08-11).
// (2) Stopping at the first closing delimiter keeps a greedy match from
// swallowing a real ask that FOLLOWS the quote and happens to end in one:
// `Liked “…” Actually, can we reschedule to “Friday”` must stay an ask, not
// a reaction. Both failure directions are covered in sms-intent.test.js.
// Fails safe: a reaction quoting a body that itself contains a quote reads as
// a real message, which surfaces it to the owner rather than silencing it.
const SMS_REACTION_TARGET_RE = '(?:[\\u201c"][^\\u201d"]+[\\u201d"]|an?\\s+(?:image|photo|video|audio message|attachment|message))';
const SMS_REACTION_RE = new RegExp(`^(liked|loved|disliked|laughed at|emphasized|questioned)\\s+${SMS_REACTION_TARGET_RE}$`, 'i');
const REMOVED_SMS_REACTION_RE = new RegExp(`^removed\\s+(?:a|an)\\s+(?:like|heart|dislike|laugh|emphasis|question mark)\\s+from\\s+${SMS_REACTION_TARGET_RE}$`, 'i');
// iOS 17.4+/18 emoji tapbacks arrive as `Reacted ❤️ to "…"` / `Removed ❤️ from
// "…"` (any emoji, incl. skin-tone + ZWJ sequences). Missed until 2026-08-28:
// the quoted appointment text then read as prose and tripped the scheduling
// detector + the full bell/push pipeline.
const EMOJI_SEQ_RE = '(?:\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\u200d|\\ufe0f|\\p{Regional_Indicator}|[0-9#*]\\ufe0f?\\u20e3)+';
const EMOJI_SMS_REACTION_RE = new RegExp(`^reacted\\s+${EMOJI_SEQ_RE}\\s+to\\s+${SMS_REACTION_TARGET_RE}$`, 'iu');
const REMOVED_EMOJI_SMS_REACTION_RE = new RegExp(`^removed\\s+${EMOJI_SEQ_RE}\\s+from\\s+${SMS_REACTION_TARGET_RE}$`, 'iu');

// Pure conversation-closers: the whole message is courtesy — "Thanks!",
// "Ok great", "Sounds good, see you then", "👍". Deliberately narrow: a bare
// "yes"/"no" is NOT courtesy (it answers a question we asked), a question
// mark or any scheduling/reschedule signal disqualifies, and anything mixed
// ("Thanks, but you missed the backyard") falls through to the normal
// pipeline. The drafter's own contract already defines this class as
// "warrants NO reply" — this is the deterministic notification-side twin.
const COURTESY_TOKEN_RE = String.raw`(?:thanks?|thank\s+(?:you|u)|thx|ty|tysm|ok(?:ay)?|sounds\s+(?:good|great|perfect)|great|perfect|awesome|cool|nice|wonderful|got\s+it|will\s+do|noted|understood|no\s+(?:problem|worries)|np|you\s+(?:too|as\s+well)|all\s+good|good\s+deal|appreciate\s+(?:it|you|that|ya)|much\s+appreciated|see\s+(?:you|ya)\s+(?:then|soon|tomorrow|there)|have\s+a\s+(?:good|great|nice|wonderful)\s+(?:one|day|night|evening|weekend)|cheers|my\s+pleasure|(?:you'?re\s+)?welcome|(?:so|very)\s+much|again|a\s+lot|for\s+(?:the\s+)?(?:update|info|heads\s+up|letting\s+(?:me|us)\s+know)|i\s+appreciate\s+(?:it|you|that)|we\s+appreciate\s+(?:it|you|that)|(?:that'?s|that\s+is)\s+(?:great|perfect|fine|awesome)|all\s+set|(?:will|talk\s+to\s+you)\s+(?:then|soon|later))`;
// Tokens that only close a thread when they sit NEXT TO a real closer: a bare
// "Ok" / "Okay" can answer an operational question ("does 9am work?") the
// same way a bare "yes" does, so alone it stays loud. Bare affirmatives
// (sure/yep/yup) and greetings are not in the grammar at all (hook P1).
const WEAK_ONLY_RE = /^(?:ok(?:ay)?)[\s,.!\-]*$/iu;
const COURTESY_ONLY_RE = new RegExp(`^(?:${COURTESY_TOKEN_RE}\\s*[,.!\\-]*\\s*){1,5}$`, 'iu');
// One trailing addressee after a THANKS-family token ("Thanks Adam", "Thank
// you guys!"). Only KNOWN addressees qualify — the people customers actually
// thank by name here plus generic team words. A denylist cannot be fail-safe
// ("Thanks spider" is a sighting, not a closer — hook P1 ×2).
const THANKS_FAMILY_RE = String.raw`(?:thanks?|thank\s+(?:you|u)|thx|ty|tysm|appreciate\s+(?:it|you|that|ya)|much\s+appreciated|got\s+it|(?:you'?re\s+)?welcome|my\s+pleasure)`;
const KNOWN_ADDRESSEES = new Set(['adam', 'virginia', 'sandy', 'waves', 'guys', 'team', 'all', 'yall', 'everyone', 'both', 'man', 'buddy', 'friend', 'sir', 'maam', 'bro', 'brother', 'dude']);
const COURTESY_WITH_NAME_RE = new RegExp(`^(?:${COURTESY_TOKEN_RE}\\s*[,.!\\-]*\\s*){0,3}${THANKS_FAMILY_RE}\\s*,?\\s*(?:you\\s+)?([a-z']{2,15})[,.!]*$`, 'iu');
// Emoji that read as an acknowledgement when they are the WHOLE message.
// Anything outside this list (❓ 🚨 📞 🐜 …) is a request, not a closer
// (hook P1), so it is left in place and the courtesy grammar fails on it.
const ACK_EMOJI_RE = /(?:[\u{1F44D}\u{1F44C}\u{1F64F}\u{1F44F}\u{1F64C}\u{1F91D}\u{1F4AF}\u{1FAF6}\u{1F60A}\u{1F642}\u{1F600}\u{1F601}\u{1F603}\u{1F604}\u{1F917}\u{1F970}\u{1F60D}\u{1F618}\u{1F44B}\u{2705}\u{2714}\u{2764}\u{1F9E1}\u{1F49B}\u{1F49A}\u{1F499}\u{1F49C}\u{1F5A4}\u{1F90D}\u{2665}\u{263A}\u{2728}\u{1F389}\u{1F44A}\u{1F498}\u{1F495}\u{1F496}\u{1F497}\u{1F49E}]\ufe0f?(?:\p{Emoji_Modifier}|\u200d\p{Extended_Pictographic}\ufe0f?)*)+/gu;
const COURTESY_MAX_CHARS = 60;

/**
 * True when the message is a pure conversation closer with nothing to answer.
 *
 * `awaitingAnswer` = did OUR last text ask the customer a question or give a
 * reply directive? Default true = strict: nothing is quiet without context.
 * With awaitingAnswer=false, gratitude / sign-offs ("Thanks!", "Appreciate it
 * Adam"), bare affirmatives ("Sounds good", "Okay") and acknowledgement emoji
 * (👍 🙏 ❤️) are closers. With an open question every one of them stays loud —
 * after "does 9am work?" a 👍 is the answer, and "Thanks!" is a non-answer.
 * Always loud: any "?", digits, scheduling/reschedule/away signal, mixed
 * content, non-acknowledgement emoji (❓ 🚨 🐜). Fail-safe direction: doubt →
 * false.
 */
function isCourtesyOnly(body, { awaitingAnswer = true } = {}) {
  const raw = String(body || '').trim();
  if (!raw || raw.length > COURTESY_MAX_CHARS) return false;
  if (/[?]/.test(raw)) return false;
  const stripped = raw.replace(ACK_EMOJI_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!stripped) return !awaitingAnswer; // acknowledgement-emoji-only
  if (/[?]/.test(stripped) || /\d/.test(stripped)) return false;
  if (hasSchedulingIntent(stripped) || hasRescheduleOrAwayIntent(stripped)) return false;
  if (WEAK_ONLY_RE.test(stripped)) return !awaitingAnswer; // bare ok / okay
  const named = COURTESY_WITH_NAME_RE.exec(stripped);
  const grammar = COURTESY_ONLY_RE.test(stripped)
    || (Boolean(named) && KNOWN_ADDRESSEES.has(named[1].toLowerCase().replace(/'/g, '')));
  if (!grammar) return false;
  // Gratitude honors the open question too: "Thanks!" after "please confirm
  // someone will be home" did not answer it (hook P1). The tiers differ only
  // in what the grammar accepts; the context decides for all of them.
  return !awaitingAnswer;
}

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

// Multi-line quoted bodies are handled by the negated class in
// SMS_REACTION_TARGET_RE, not by normalizing whitespace here — collapsing
// first would let the match run past the quote's own closing delimiter and
// swallow a real ask that follows it. See that comment for both cases.
function isSmsReaction(body) {
  if (!body || typeof body !== 'string') return false;
  const text = body.trim();
  return SMS_REACTION_RE.test(text) || REMOVED_SMS_REACTION_RE.test(text)
    || EMOJI_SMS_REACTION_RE.test(text) || REMOVED_EMOJI_SMS_REACTION_RE.test(text);
}

// Reschedule/away intent — a strict SUBSET of scheduling intent. Scheduling
// intent only decides whether the AI auto-reply stands down; this detector
// decides whether to raise a "customer is asking to move or miss an upcoming
// visit" flag, so it must not fire on ordinary timing questions ("what time
// are you coming?"). Recall is weighted over precision within that subset:
// a false positive costs one owner bell, a false negative is the 2026-08-05
// incident class where a 12:30am "can we reschedule?" text was followed by
// the visit running (and invoicing) on schedule.
const RESCHEDULE_DIRECT_RE = /\b(?:re-?schedul\w*|re-?book\w*|postpon\w*|(?:miss(?:ing)?|delay(?:ing)?)\b\s+(?:[\w'\u2019]+\s+){0,2}?(?:appointment|appt|visit|service)\b|(?:put|hold)\s+off\s+(?:on\s+)?(?:[\w'\u2019]+\s+){0,2}?(?:appointment|appt|visit|service|treatment)s?\b|different\s+(?:day|date|time)|another\s+(?:day|date|time)|(?:can|could)\s+we\s+(?:do|move|push|change)\s+(?:it|this|that|the\s+\w+)?\s*(?:to|till|until|for)\s+(?:next|another|a\s+different|later|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day)|skip\s+(?:(?:this|the|my|that|our)\s+)?(?:\w+\s+)?(?:one|visit|service|treatment|month|week|appointment|appt)|skip\s+(?:today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|next\s+week)|(?:today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|next\s+(?:week|month)|(?:this\s+)?(?:morning|afternoon|evening))\s+instead|(?:today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|next\s+week|that\s+(?:day|date|time))\b[^.!?]{0,10}\b(?:doesn'?t|does\s+not|won'?t|will\s+not)\s+work)\b/i;
// Move-verbs only count with a displacement preposition or an appointment
// noun nearby — bare "moving" ("we're moving the couch") must not fire.
// Move-verbs need an APPOINTMENT object or an explicit temporal target —
// "change the date on my invoice" / "move the card payment" must not flag
// (codex #3232 r4).
const MOVE_VERB_RE = /\b(?:mov(?:e|ing)|push(?:ed|ing)?|bump(?:ed|ing)?|chang(?:e|ing))\b(?:[^.!?\n]{0,40}\b(?:appointment|appt|visit)\b|[^.!?\n]{0,40}\b(?:(?:today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day)(?:'s)?\s+(?:treatment|service)s?\b|(?:treatment|service)s?\b[^.!?\n]{0,25}\b(?:today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|next\s+(?:week|month)|this\s+week)\b)|[^.!?\n]{0,40}\bservice\b[^.!?\n]{0,30}\b(?:till|until|to\s+(?:next\s+(?:week|month)|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day))\b|[^.!?\n]{0,40}\b(?:till|until|to)\s+(?:next\s+(?:week|month)|tomorrow|late[r]?\s+\w+|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|(?:october|november|december|january|february|march|april|may|june|july|august|september)|\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})\b|[^.!?\n]{0,40}\b(?:an?\s+hour|half\s+an?\s+hour|(?:one|two|three|four|five|\d+)\s+(?:hours?|min(?:ute)?s?))\b)/i;
const CANCEL_RE = /\bcancel\w*\b/i;
// cancel* alone is unusable — "did you cancel autopay?" / "don't cancel"
// are not reschedule asks (codex #3232 r3): require appointment context,
// exclude negations and non-appointment objects.
const CANCEL_CONTEXT_RE = /\b(?:appointment|appt|visit|service|treatment|today|tomorrow|(?:next|this)\s+week|the\s+\d{1,2}(?:st|nd|rd|th)|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day)\b/i;
// Up to three intervening words catch subjects and passives (codex r27):
// "don't want YOU TO cancel", "don't want MY APPOINTMENT canceled",
// "was not ASKING TO cancel".
const CANCEL_NEGATION_RE = /\b(?:don'?t|do\s+not|not|never|no\s+need\s+to)\s+(?:\w+\s+){0,3}?cancel/i;
const CANCEL_NONAPPT_RE = /\bcancel\w*\s+(?:[\w'’]+\s+){0,2}?(?:invoice|autopay|payment|card|subscription|estimate|quote)s?\b/i;
const AWAY_RE = /\b(?:out\s+of\s+town|on\s+vacation|leav(?:e|ing)\s+for\s+vacation|going\s+out\s+of\s+town|(?:won'?t|will\s+not|not\s+going\s+to|can'?t|cannot|can\s+not)\s+be\s+(?:home|here|there|available|around|in\s+town)|(?:won'?t|will\s+not)\s+be\s+able\s+to\s+(?:attend|make|come|be\s+(?:there|home))|(?:am|'m|are|'re|is)\s+unable\s+to\s+(?:attend|make|be\s+(?:there|home))|unable\s+to\s+attend|(?:can'?t|cannot|can\s+not)\s+attend\b|(?:am|'m|are|'re|is)\s+(?:not\s+(?:available|around|home|here|there|in\s+town)|unavailable)\b|(?:can'?t|cannot|can\s+not|won'?t)\s+make\s+(?:it\s+)?(?:[\w'’]+\s+){0,2}?(?:appointment|appt|visit|service|today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day)|(?:nobody|no\s+one)\s+(?:will\s+be|is|'?s\s+going\s+to\s+be)\s+(?:home|here|there)|away\s+(?:until|till|through|for)|travel(?:ing|ling)\s+(?:until|till|through|next|this|today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|on\s+(?:mon|tues?|wednes|thurs?|fri|satur|sun)day)|back\s+(?:in\s+town\s+)?(?:on|until|till)\b|not\s+(?:be\s+)?back\s+(?:till|until)|(?:we|i)(?:\s+all)?\s+(?:am|are|will\s+be|are\s+going\s+to\s+be|going\s+to\s+be|gonna\s+be)\s+(?:gone|away)\b|(?:we|i)'(?:ll|re|m)\s+(?:all\s+)?(?:be\s+)?(?:gone|away)\b|(?:am|'m)\s+away\b|away\s+(?:this|next)\s+(?:week|month)|not\s+(?:at\s+)?home\s+(?:today|tomorrow|this|next|until|till))\b/i;
// Away + permission = a heads-up, not a reschedule ask ("won't be home but
// here's the gate code" / "exterior only is fine"). Permission only
// suppresses the AWAY leg — an explicit reschedule/cancel verb still wins.
const AWAY_PERMISSION_RE = /\b(?:(?:the\s+)?gate\s*code\s+is\b|gate\s*code\b[^.!?]{0,25}?[:#]\s*\d{3,}|(?:i|we)\s+(?:do\s+)?have\s+(?:a|the)\s+gate\s*code\b|(?:here'?s|i'?ll\s+(?:text|send|give|leave)(?:\s+you)?)\s+(?:the\s+)?gate\s*code|(?:can|could|may|feel\s+free\s+to|just|please)\s+use\s+(?:the\s+)?gate\s*code|door\s+(?:is\s+|will\s+be\s+)?(?:open|unlocked)|garage\s+(?:is\s+|will\s+be\s+)?open|no\s+need\s+to\s+(?:be|get|come)\s+in|don'?t\s+need\s+to\s+(?:be|get|come)\s+in|(?:it|that)'?s\s+fine|exterior\s+(?:only\s+)?(?:is\s+)?fine|(?:you|y'?all)\s+can\s+still\s+(?:come|do|spray|treat)|(?:can|please|okay\s+to|ok\s+to|feel\s+free\s+to|just)\s+go\s+ahead|(?:^|[.!?]\s+)go\s+ahead)\b/i;

// Explicit stand-down asks (codex #3232 r39): "Please don't come
// tomorrow" is a reschedule-class request even though no move/cancel verb
// appears. Requires an appointment or future-time object so "don't come
// to the front door" stays quiet.
// Clause-scoped no-need stand-downs (codex r49): a visit noun AND a
// future-time reference are both required — "we don't need service on
// the shed" stays quiet.
const NO_NEED_RE = /\b(?:don'?t|won'?t|do\s+not|will\s+not|no)\s+need\s+(?:for\s+)?(?:[\w'\u2019]+\s+){0,2}?(?:service|appointment|appt|visit|treatment)s?\b[^.!?]{0,20}\b(?:today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|this\s+week|next\s+week)\b|\b(?:don'?t|won'?t|do\s+not|will\s+not)\s+need\s+(?:today|tomorrow)(?:'s)?\s+(?:service|appointment|appt|visit|treatment)s?\b/i;
const DONT_COME_RE = /\b(?:(?:please\s+)?(?:don'?t|do\s+not)|can\s+you\s+not|could\s+you\s+not)\s+(?:come|show\s+up|stop\s+by|treat|spray|service)\b(?!\s+(?:to|through|via|by|in(?:side)?|around|near)\b[^.!?]{0,20}\b(?:door|gate|entrance|back|front|side|garage|yard|porch|driveway|house))(?!\s+(?:the\s+|my\s+|our\s+)?(?:front|back|side|garden|inside|indoors|interior|bed|bush|plant|shrub|lawn|yard))[^.!?]{0,25}\b(?:today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|appointment|appt|visit|this\s+week|next\s+week)\b|\b(?:today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|appointment|appt|visit)\b[^.!?]{0,30}\b(?:(?:please\s+)?(?:don'?t|do\s+not)|can\s+you\s+not|could\s+you\s+not)\s+(?:come|show\s+up|stop\s+by|treat|spray|service)\b(?!\s+(?:to|through|via|by|in(?:side)?|around|near)\b[^.!?]{0,20}\b(?:door|gate|entrance|back|front|side|garage|yard|porch|driveway|house))(?!\s+(?:the\s+|my\s+|our\s+)?(?:front|back|side|garden|inside|indoors|interior|bed|bush|plant|shrub|lawn|yard))/i;

function hasRescheduleOrAwayIntent(body) {
  if (!body || typeof body !== 'string') return false;
  if (isSmsReaction(body)) return false;
  // Phone keyboards produce typographic apostrophes — "won\u2019t" must match
  // the same patterns as "won't".
  const text = body.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
  // A fresh cancel ask that TARGETS the appointment overrides the
  // whole-message negation/billing vetoes (codex r28): "Please don't
  // cancel autopay. I need to cancel tomorrow's service." Guarded the
  // same way as needAsk — a negated need/want phrase is not fresh.
  const freshCancelAppt = /\b(?:(?:need|want|like|have)\s+to|please)\s+cancel\s+(?:[\w'’]+\s+){0,2}?(?:appointment|appt|visit|service|treatment)s?\b|(?:^|[.!?;]\s*)cancel\s+(?:[\w'’]+\s+){0,2}?(?:appointment|appt|visit|service|treatment)s?\b/i.test(text)
    && !/\b(?:don'?t|do\s+not|doesn'?t|won'?t|not|no|never)\s+(?:\w+\s+){0,2}?(?:need|want|like|have)\s+to\s+cancel/i.test(text);
  // Past-event reports (codex r44): "I had to miss yesterday's
  // appointment" reports history — a clause-scoped past reference next
  // to the action verb vetoes both the cancel and direct branches.
  const pastReport = /\b(?:miss(?:ed|ing)?|delay(?:ed|ing)?|postpon\w*|put\s+off|skipp?(?:ed|ing)?|cancell?\w*|re-?schedul\w*)\b[^.!?]{0,30}\b(?:yesterday|last\s+(?:week|month))\b/i.test(text);
  // A fresh cancel ask outranks the past-report veto ("Thanks for
  // canceling last week. I need to cancel Friday too") — same override
  // the done-forms clause uses (codex r22/r44).
  const freshCancel = /\b(?:need|want|like|have)\s+to\s+cancel|\bplease\s+cancel|\b(?:can|could)\s+(?:we|you|i)\s+(?:please\s+)?cancel|\bcancel\w*(?:\s+\w+){0,2}\s+again\b/i.test(text);
  const cancelAsk = CANCEL_RE.test(text) && CANCEL_CONTEXT_RE.test(text)
    && !(pastReport && !freshCancel)
    && (freshCancelAppt || (!CANCEL_NEGATION_RE.test(text) && !CANCEL_NONAPPT_RE.test(text)))
    // Acknowledgments / status questions about a DONE cancellation are
    // not requests (codex r18): "Has my appointment been canceled?",
    // "Did you cancel…?", "Thanks for canceling."
    // Perfect/passive/interrogative DONE-forms only (codex r19): "I have
    // to cancel" and "I was hoping to cancel" are active requests.
    && !(/\b(?:has|have|had|is|are|was|were)\b[^.!?]{0,30}\b(?:been\s+)?cancell?ed\b|\bdid\s+you\s+cancel\b|\bthanks?\s+(?:you\s+)?for\s+cancel/i.test(text)
      // …unless a FRESH cancel ask follows the acknowledgment (codex r22).
      && !/\b(?:need|want|like|have)\s+to\s+cancel|\bplease\s+cancel|\bcancel\w*(?:\s+\w+){0,2}\s+again\b/i.test(text));
  // "don't reschedule us, you can still come" is the opposite of a
  // reschedule ask (codex r5).
  // A FRESH request anywhere overrides status/acknowledgment clauses
  // (codex r15/r16): "…been rescheduled, but I need to reschedule again."
  // A need/want phrase governed by a negation is the OPPOSITE of a fresh
  // ask (codex r26): "I don't need to reschedule" / "no need to
  // reschedule" must not disarm the negation guard below.
  const needAsk = /\b(?:need|want|like|have)\s+to\s+(?:re-?schedul|postpon)/i.test(text)
    && !/\b(?:don'?t|do\s+not|doesn'?t|won'?t|not|no|never)\s+(?:\w+\s+){0,2}?(?:need|want|like|have)\s+to\s+(?:re-?schedul|postpon)/i.test(text);
  // Correction verbs beyond reschedule/postpone need an appointment-ish
  // object or temporal target (codex r27) — "please move my appointment
  // to Friday" / "please skip Friday" are fresh asks; "please move
  // forward with the treatment" is not.
  const GUARDED_MOVE = "(?:mov(?:e|ing)|skip|re-?book|chang(?:e|ing))\\b[^.!?]{0,25}\\b(?:appointment|appt|visit|service|us|me|today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|next\\s+(?:week|month)|this\\s+week)\\b";
  const freshAsk = needAsk
    || /\b(?:can|could)\s+(?:we|you|i)\s+(?:please\s+)?(?:re-?schedul|postpon)/i.test(text)
    || /\bplease\s+(?:re-?schedul|postpon)|\bactually\b[^.!?]{0,30}\b(?:please|can|could|need|want)\b[^.!?]{0,20}\b(?:re-?schedul|postpon)|\b(?:re-?schedul|postpon)\w*(?:\s+\w+){0,2}\s+again\b/i.test(text)
    || new RegExp(`\\bplease\\s+${GUARDED_MOVE}|\\bactually\\b[^.!?]{0,30}\\b(?:please|can|could|need|want)\\b[^.!?]{0,20}\\b${GUARDED_MOVE}`, 'i').test(text);
  // A fresh ask whose OBJECT is explicitly the appointment (codex r41):
  // only this form may override the billing-object vetoes — "reschedule
  // my payment" must not.
  const freshApptAsk = /\b(?:(?:need|want|like|have)\s+to|please)\s+(?:re-?schedul\w*|postpon\w*)\s+(?:[\w'\u2019]+\s+){0,2}?(?:appointment|appt|visit|service)s?\b/i.test(text);
  // A self-correction ("Don't reschedule Tuesday. Actually, please
  // reschedule for Friday.") is a live ask — the fresh ask outranks the
  // whole-message negation scan (codex r24).
  // Negation/status/acknowledgment vetoes must cover every verb the
  // detectors match — postpone and skip included (codex #3232 r25):
  // "Don't postpone my appointment" / "Has it been postponed?" /
  // "Did you skip tomorrow?" are not fresh asks.
  const negated = (!freshAsk && /\b(?:don'?t|do\s+not|no\s+need\s+to|not\s+necessary\s+to|never)\s+(?:\w+\s+){0,2}?(?:reschedul|re-?book|move|change|postpon|skip|delay|miss|(?:put|hold)\s+off)/i.test(text))
    || (!freshAsk && pastReport)
    // Present-perfect confirmations / status questions (codex r13) and
    // past acknowledgments (codex r9) — both yield to a fresh ask.
    || (!freshAsk && /\b(?:has|have|had|is|was)\b[^.!?]{0,30}\bbeen\s+(?:re-?schedul|postpon|skipp?)/i.test(text))
    || (!freshAsk && /\b(?:thanks?\s+for|thank\s+you\s+for|already|were|was|got)\s+(?:being\s+)?(?:re-?schedul|postpon|skipp)/i.test(text))
    // Status QUESTIONS about a move that may already have happened
    // (codex r25): "Did you skip/reschedule tomorrow?" asks, not asks-for.
    || (!freshAsk && /\bdid\s+you\b[^.!?]{0,25}\b(?:re-?schedul|postpon|skip|mov)/i.test(text))
    // Non-appointment reschedule objects (codex r16): "reschedule my
    // autopay/payment" is billing, not an appointment change. A
    // SEPARATELY grounded appointment ask in the same message overrides
    // the billing clause (codex r41): "postpone my payment. Also
    // reschedule tomorrow's appointment."
    || (!freshApptAsk && /\b(?:re-?schedul\w*|postpon\w*|skipp?\w*|mov(?:e|ing)|push(?:ing|ed)?|defer(?:ring)?|delay(?:ing)?|chang(?:e|ing))\s+(?:[\w'’]+\s+){0,3}?(?:autopay|payment|invoice|card|subscription|bill|billing)s?\b|\b(?:autopay|payment|invoice|bill|billing)s?\b[^.!?]{0,25}\bskip\b/i.test(text))
    // Billing subjects with date-only phrasing (codex r23): "can I make
    // my payment a different day?"
    || (!freshApptAsk && /\b(?:autopay|payment|invoice|card|subscription|bill|billing)s?\b[^.!?]{0,30}\b(?:different|another)\s+(?:day|date|time)\b|\b(?:different|another)\s+(?:day|date|time)\b[^.!?]{0,20}\b(?:autopay|payment|invoice|bill|billing)s?\b/i.test(text));
  if (!negated && (RESCHEDULE_DIRECT_RE.test(text) || MOVE_VERB_RE.test(text))) return true;
  if (cancelAsk) return true;
  if (DONT_COME_RE.test(text)) return true;
  if (NO_NEED_RE.test(text)) return true;
  // Permission suppresses only the CLAUSE it shares with the away
  // statement (codex r49): "use the gate code for today's service. I
  // won't be home next week" carries a fresh, unpermissioned absence.
  const PAST_AWAY_CLAUSE_RE = /\b(?:were|was|got\s+back|just\s+got\s+back|returned)\b[^.!?]{0,25}\b(?:out\s+of\s+town|on\s+vacation|away)\b|\b(?:out\s+of\s+town|on\s+vacation|away)\b[^.!?]{0,15}\blast\s+(?:week|month|weekend)\b|\b(?:was|were)\s+unable\s+to\s+(?:attend|make)\b|\b(?:couldn'?t|could\s+not)\s+(?:attend|make)\s+(?:it\s+)?(?:[\w'\u2019]+\s+){0,2}?(?:appointment|appt|visit|service|yesterday)\b|\bunable\s+to\s+attend\b[^.!?]{0,20}\byesterday/i;
  const clauses = text.split(/[.!?;\n]+/);
  return clauses.some((clause) => {
    // History vetoes only ITS clause (codex r51): "I was out of town
    // last week. I won't be home tomorrow" carries a fresh absence.
    if (PAST_AWAY_CLAUSE_RE.test(clause)) return false;
    const awayMatch = AWAY_RE.exec(clause);
    if (!awayMatch) return false;
    const permMatch = AWAY_PERMISSION_RE.exec(clause);
    if (!permMatch) return true;
    // Both in one clause: permission governs the away statement only when
    // they share a temporal target (codex r50) — "use the gate code for
    // TODAY's service but I won't be home NEXT WEEK" is a fresh,
    // unpermissioned absence.
    const TEMPORAL = /(today|tomorrow|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|next\s+week|this\s+week|next\s+month)/i;
    const nearTemporal = (idx) => {
      // The governing time usually FOLLOWS the phrase — search forward
      // first, backward as fallback.
      const fwd = clause.slice(idx, idx + 70).match(TEMPORAL);
      if (fwd) return fwd[1].toLowerCase().replace(/\s+/g, ' ');
      const back = clause.slice(Math.max(0, idx - 40), idx).match(TEMPORAL);
      return back ? back[1].toLowerCase().replace(/\s+/g, ' ') : null;
    };
    const awayT = nearTemporal(awayMatch.index);
    const permT = nearTemporal(permMatch.index);
    return Boolean(awayT && permT && awayT !== permT);
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { hasSchedulingIntent, isSmsReaction, isCourtesyOnly, hasRescheduleOrAwayIntent };
