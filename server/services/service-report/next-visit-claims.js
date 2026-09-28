// Strict validation for typed-report appointment copy. The rule set fails
// closed: it never lists the phrasings an appointment may take, it lists the
// one appointment the copy may describe.
//
// 1. SENTENCES: copy is judged sentence by sentence (splitSentences, shared
//    with the ratified-care list and the stale-claim filter).
//
// 2. TENSE: a sentence that describes the completed visit ("We treated on
//    Sep. 3", "Since our visit on Aug. 1, activity has dropped") is history,
//    not an appointment, and is not validated. Anything short of clearly
//    past — a future or present marker anywhere, or a visit claim not
//    anchored in the past — stays under validation.
//
// 3. TOKENS: one tokenizer reads every temporal token in a sentence — dates
//    (any case, "may"/"mar" too unless they are the verb), numeric dates,
//    ordinals, weekdays, bare months, arrival ranges, clock times,
//    o'clock/noon/midnight, day periods, relative dates ("tomorrow", "next
//    week"), and spans ("in 7 days", "a week from Monday"). Scans run on
//    word-number-normalized text, so "eight AM" and "September third" are
//    judged like their digit forms.
//
// 4. ALLOWLIST OF ONE: inside a future visit claim, EVERY token must agree
//    with the authoritative next visit — its date, weekday, month, day, the
//    arrival window itself, and a part of the day that window covers. A
//    relative date or an exact clock time never agrees (the promise is a
//    dated window); a span agrees only when the ratified Today's Result
//    states it ("A follow-up visit in 10–14 days is recommended"). No token
//    type is ignored, so an unlisted phrasing fails closed.
//
// 5. OTHER COPY: a sentence that makes no visit claim still may not state an
//    appointment-shaped fact (window, clock time, date, weekday, relative
//    date) unless it is ratified care copied verbatim ("Contact us at 8 AM
//    if activity returns"). Day periods, spans, and bare months are ordinary
//    care language there ("water in the morning", "results within two
//    weeks").

const { normalizeWordNumbers } = require('./activity-indicators');

const MERIDIEM_TEXT = String.raw`[ap]\.?\s?m\.?`;
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_DATE_TEXT = 'Jan(?:\\.|uary)?|Feb(?:\\.|ruary)?|Mar(?:\\.|ch)?|Apr(?:\\.|il)?|May\\.?|Jun(?:\\.|e)?|Jul(?:\\.|y)?|Aug(?:\\.|ust)?|Sep(?:\\.|t\\.?|tember)?|Oct(?:\\.|ober)?|Nov(?:\\.|ember)?|Dec(?:\\.|ember)?';
const WEEKDAY_NAMES = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
// Abbreviated weekdays count inside a month-day date ("Tue., Aug 3"), and
// standalone only capitalized inside a visit claim ("Back Tue."): lowercase
// "sun"/"sat"/"wed" are ordinary words.
const WEEKDAY_DATE_TEXT = `${WEEKDAY_NAMES}|Mon\\.?|Tues?\\.?|Wed(?:s)?\\.?|Thu(?:rs?)?\\.?|Fri\\.?|Sat\\.?|Sun\\.?`;
const HOUR_12 = String.raw`(?:1[0-2]|0?[1-9])`;
// A minute part after a 12-hour hour: "8:30", "8.30", and the normalized
// word forms "8 30" (eight thirty) and "8 oh 5" (eight oh five).
const MINUTE_TEXT = String.raw`(?:[:.][0-5]\d|\s+[1-5]\d|\s+oh\s+\d)`;
// What turns a bare hour into a clock time.
const CLOCK_SUFFIX = String.raw`(?:\s*${MERIDIEM_TEXT}(?![a-z\d])|\s*o[’']?\s?clock\b|\s+in\s+the\s+(?:morning|afternoon|evening)\b|\s+at\s+night\b|\s+on\s+the\s+dot\b)`;
// A bare hour is only a clock time when the clause ends after it or a
// timing word follows: "arriving at 8." and "at 8 sharp" are times, while
// "a capture at 2 traps" and "after 2 or 3 days" are counts.
const BARE_HOUR_END = String.raw`(?=\s*(?:[.,;:!?)]|$)|\s+(?:sharp|tomorrow|today|tonight|on\s+(?:${WEEKDAY_NAMES}|${MONTH_NAMES}|the\s+\d))\b)`;
const EXACT_TIME_PARTS = [
  String.raw`(?<![\d:.])${HOUR_12}${MINUTE_TEXT}?${CLOCK_SUFFIX}`,
  String.raw`(?<![\d:.])(?:[01]?\d|2[0-3]):[0-5]\d(?![\d:])`,
  String.raw`\b(?:noon|midnight)\b`,
  String.raw`\b(?:(?:half|quarter)\s+(?:past|after|to|till?)|[1-5]?\d\s+(?:past|after))\s+${HOUR_12}${BARE_HOUR_END}`,
  String.raw`\b(?:at|around|before|after|until|till|til)\s+${HOUR_12}(?:[:.][0-5]\d)?${BARE_HOUR_END}`,
];
const CLOCK_TIME_RE = new RegExp(EXACT_TIME_PARTS.join('|'), 'gi');
// Inside a visit claim any hour after an arrival word is a time ("arriving
// 8.", "by 10 on Monday").
const CLAIM_CLOCK_TIME_RE = new RegExp([
  ...EXACT_TIME_PARTS,
  String.raw`\b(?:arriv\w*|by|starting|about|approximately|near|no\s+later\s+than)\s+${HOUR_12}(?:[:.][0-5]\d)?${BARE_HOUR_END}`,
].join('|'), 'gi');
// An arrival range, dash or prose: "8–10 AM", "8 AM to 10 AM", "between 8
// and 10", "from 8 to 10 in the morning". arrivalRanges() decides which
// matches are times rather than counts ("between 2 and 3 traps").
const RANGE_POINT = String.raw`${HOUR_12}(?:[:.][0-5]\d)?`;
const RANGE_TEXT_RE = new RegExp(
  String.raw`(?<![\d:.])(?:\b(between|from)\s+)?(${RANGE_POINT})(\s*${MERIDIEM_TEXT}(?![a-z\d]))?(\s*[–—-]\s*|\s+(?:and|or|to|till?|until|through|thru)\s+)(${RANGE_POINT})(?!\d)(${CLOCK_SUFFIX})?`,
  'gi',
);
// Words that make a following bare range an arrival window inside a claim
// ("arriving 7 to 8.").
const CLAIM_RANGE_LEAD_RE = /\b(?:arriv\w*|at|around|about|window(?:\s+(?:is|of))?)\s*$/i;
const YEAR_TEXT = String.raw`(?:\s*,?\s*(?:(?:in|of)\s+)?\(?(\d{4}|[’']?\d{2})(?![\d:]|\s*(?:${MERIDIEM_TEXT}|[–—-]))\)?)?`;
// Month-first ("Monday, Aug. 3rd") and day-first ("the 3rd of September").
const DATE_TEXT_RE = new RegExp(
  `\\b(?:(${WEEKDAY_DATE_TEXT}),?\\s+)?(${MONTH_DATE_TEXT})\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b${YEAR_TEXT}`
  + `|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_DATE_TEXT})(?![a-z])${YEAR_TEXT}`,
  'gi',
);
const NUMERIC_DATE_RE = /\b(?:(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?)\b/g;
// Relative dates that are appointment-shaped in any copy.
const RELATIVE_APPOINTMENT_DATE_RE = new RegExp(
  `\\b(?:tomorrow|tonight|next\\s+(?:day|week|month)|(?:(?:next|this)\\s+(?:coming\\s+)?|coming\\s+|following\\s+)(?:${WEEKDAY_NAMES})|(?:${WEEKDAY_NAMES})\\s+after\\s+next)\\b`,
  'gi',
);
// A relational date describes a visit only in terms of another date ("the
// day after Monday", "the Tuesday after Labor Day", "a week after our last
// visit"), never as the grounded date or weekday itself — unlike a bare
// weekday or date, which might agree, this can never be the authoritative
// visit's own rendering, so it is judged inside a visit claim like any other
// relative date (codex P1 on #5055 followups: "the day after Monday" reads
// as agreeing because the trailing weekday token alone matches). Timing
// anchored on the visit itself ("mow the day before your next visit") is
// preparation advice, not another date for the visit.
// A quantified/plural count leading the relational phrase ("two days after
// Labor Day", "three weeks after the treatment", "a couple of days after
// the visit") — run on word-number-normalized text, so word counts are
// digits by the time this matches. The target is captured (group 1) so the
// visit-anchor exemption below can be scoped to non-promise sentences only.
const RELATIONAL_DATE_COUNT = String.raw`(?:the|a|\d+|a\s+couple\s+of|a\s+few|several)\s+`;
const RELATIONAL_DATE_RE = new RegExp(
  `\\b(?:${RELATIONAL_DATE_COUNT})?(?:${WEEKDAY_NAMES}|days?|weeks?|months?)\\s+(?:after|before)\\s+(next\\b|${WEEKDAY_NAMES}\\b|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|[a-z]+(?:\\s+[a-z]+){0,2}(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?)`,
  'gi',
);
// Timing anchored on the visit itself ("mow the day before your next
// visit") is preparation advice, not another date for the visit — UNLESS
// the sentence is itself a provider visit promise ("We will return the day
// before your next visit" still states timing for our return and must be
// judged like any other relational date).
const RELATIONAL_DATE_ANCHOR_RE = /^(?:your|the|our|this|each|every)\s+(?:(?:next|scheduled|upcoming|planned|booked|follow[-\s]?up|return|regular|second)\s+){0,2}(?:visit|appointment|service|treatment|application)s?\b/i;
// Every other relative date, judged inside a visit claim: "today" (not the
// possessive "today's visit", which names the completed visit), "this
// afternoon", "next weekend", "the following week".
const CLAIM_RELATIVE_DATE_RE = /\b(?:today(?![’']s)|yesterday|(?:next|this|coming|following|upcoming)\s+(?:coming\s+)?(?:weekend|week|month|year|morning|afternoon|evening|night)|weekend)\b/gi;
// A span of time from today: "in 7 days", "within 2 weeks", "in a couple
// of days", "after 2 or 3 days", "7 days from now", "a week from Monday".
// Only a visit claim turns it into an appointment date ("We will be back in
// 7 days"); in care copy it is an expectation ("results show within 2
// weeks"). A visit claim's span is grounded only by a span the ratified care
// copy states itself, never by a numeral another fact happens to ground.
const DURATION_COUNT = String.raw`(?:\d+(?:\s*(?:[–—-]|to|or)\s*\d+)?|an?|(?:a\s+)?(?:couple|few)(?:\s+(?:of|more))?|several|another)`;
const DURATION_UNIT = String.raw`(?:minutes?|hours?|days?|weeks?|months?|years?)`;
const RELATIVE_DURATION_RE = new RegExp(
  String.raw`\b(?:(?:in|within|after)\s+(?:(?:about|around|roughly|approximately|another|the\s+next|the\s+coming)\s+)?(?:${DURATION_COUNT}\s+)?(?:more\s+)?${DURATION_UNIT}|${DURATION_COUNT}\s+${DURATION_UNIT}\s+(?:(?:from|after)\s+(?:now|today|tomorrow|then|${WEEKDAY_NAMES})|later))\b`,
  'gi',
);
const BARE_MONTH_RE = new RegExp(`\\b(${MONTH_NAMES}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\\b\\.?`, 'gi');
// Months that are also ordinary words: "may" (the modal), "mar"/"march"
// (the verbs).
const AMBIGUOUS_MONTH_RE = /^(?:may|mar|march)\.?$/i;
const WEEKDAY_ABBR_RE = /\b(Mon|Tues?|Weds?|Thu(?:rs?)?|Fri|Sat|Sun)\b\.?/g;
// An ordinal is a day of the month when the clause ends after it or a
// function word follows ("back on the 4th.", "the 4th at 8"); followed by a
// noun it is a count ("a second visit", "the 2nd floor").
const ORDINAL_DAY_RE = /\b(?:(?:on|by|before|after|until)\s+the\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th))\b(?=\s*(?:[.,;:!?)]|$)|\s+(?:at|between|from|by|in|on|and|or|to|through|thru|until|till|for|when|with|so|arriving|around|before|after|of|if|but|as)\b)/gi;
const DAY_PERIOD_RE = /\b(?:morning|afternoon|evening|night|overnight|mid-?day)s?\b|\b(?:AM|PM)\b|(?<![a-z])[ap]\.m\.?/g;
const OCLOCK_RE = /\bo[’']?\s?clock\b/gi;

const ORDINAL_DAYS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
const ORDINAL_RE = new RegExp(`\\b(?:(twenty|thirty)[-\\s]+)?(${Object.keys(ORDINAL_DAYS).join('|')})\\b`, 'gi');
const MONTH_INDEX = MONTH_NAMES.split('|').map((month) => month.slice(0, 3).toLowerCase());

// Word ordinals become "3rd"-style digits ("thirty-first" → "31st") and word
// numbers become digits, so every temporal rule is written once, for digits.
function normalizeTemporalText(value) {
  const ordinals = String(value || '').replace(ORDINAL_RE, (full, tens, unit) => {
    const day = (tens ? (tens.toLowerCase() === 'twenty' ? 20 : 30) : 0) + ORDINAL_DAYS[unit.toLowerCase()];
    const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
    return `${day}${suffix}`;
  });
  return normalizeWordNumbers(ordinals);
}

// --- Visit claims -----------------------------------------------------------
// Who can make a visit: we/I, our staff by role (article and one modifier
// optional: "the service technician", "technician"), or the company. "They"
// is deliberately absent: in care copy it is the pests ("if they come back").
const PROVIDER_SUBJECT = String.raw`(?:i|we|waves|someone|somebody|(?:(?:the|your|our)\s+)?(?:[a-z]+\s+)?(?:technicians?|techs?|team|crew|specialists?|inspectors?|professionals?))`;
// What a visit is, as a verb: returning, coming, arriving, stopping by,
// checking back, following up, being back/there/out, re-treating, seeing you.
const VISIT_VERB = String.raw`(?:return\w*|com(?:e|es|ing)|came|arriv\w*|visit\w*|back|(?:stop|swing|drop)\w*\s+by|check\w*\s+(?:back|in|on)|follow\w*[-\s]+up|head\w*\s+(?:out|over|back)|re-?treat\w*|re-?inspect\w*|re-?servic\w*|see\s+you|be\s+(?:there|out|over))`;
// A clause coordinated onto a provider-subject clause with "and"/"but"/
// "then"/";" carries that subject forward when it names no subject of its
// own ("we checked all traps and will return tomorrow", "...but will come
// back next week"): the provider never stopped being the subject, only the
// clause changed. A clause that opens with its own subject — the provider
// again, someone else ("you", "they"), or any other noun immediately
// followed by a verb of its own ("activity subsided", "it will come back")
// — resets what later clauses inherit; a coordinator that merely joins two
// words inside the CURRENT clause's own object ("interior and exterior
// bait stations", "the front and back yard") is not a clause boundary at
// all (codex P1 on #5262: an unbounded provider clause, a mid-sentence
// subject change, and a noun-phrase "and" all broke the old fixed-distance
// lookbehind this replaces). A bare "back" needs an auxiliary ("and will be
// back") so "the front and back yard" is never a visit.
const OTHER_CLAUSE_SUBJECT_RE = String.raw`\b(?:you|your|they|them|customers?|homeowners?|tenants?)\b`;
// "and" before a number joins a range ("between 7 and 8"), not two clauses.
const CLAUSE_COORDINATOR_RE = String.raw`(?:,\s*)?\b(?:and|but|then)\b(?!\s*\d)\s*|;\s*`;
const CLAUSE_AUX = String.raw`(?:will|would|shall|should|can|could|may|might|must|also|then|soon|likely|definitely|be|is|are|am|plans?\s+to|planning\s+to|going\s+to|gonna|expect\s+to|intend\s+to)`;
// A leading adverb, or a short introductory phrase ending in a comma, that
// may sit before a coordinated clause's real subject or verb ("and then
// Waves will return", "and, once the eggs hatch, we will return").
const CLAUSE_LEAD_RE = String.raw`(?:(?:then|also|soon|likely|definitely)\s+)?(?:[a-z][a-z ,'-]{0,30},\s*)?`;
const CLAUSE_INHERIT_VERB_RE = new RegExp(
  `^${CLAUSE_LEAD_RE}(?:(?:${CLAUSE_AUX})\\s+){1,3}${VISIT_VERB}\\b|^${CLAUSE_LEAD_RE}(?!back\\b)${VISIT_VERB}\\b`,
  'i',
);
const CLAUSE_LEAD_ONLY_RE = new RegExp(`^${CLAUSE_LEAD_RE}`, 'i');
const CLAUSE_OWN_PROVIDER_RE = new RegExp(`^${CLAUSE_LEAD_RE}${PROVIDER_SUBJECT}\\b`, 'i');
const CLAUSE_OWN_OTHER_RE = new RegExp(`^${CLAUSE_LEAD_RE}${OTHER_CLAUSE_SUBJECT_RE}`, 'i');
// A clause start that names no recognized subject but still reads as a
// genuine new clause (a noun immediately followed by a verb of its own) —
// distinguished from a noun-phrase continuation of the PREVIOUS clause's
// object ("exterior bait stations", which has no verb after "exterior").
const CLAUSE_OWN_VERB_SUBJECT_RE = new RegExp(
  `^${CLAUSE_LEAD_RE}[a-z][a-z'-]*\\s+(?:[a-z]+ly\\s+)?(?:(?:has|have|had|is|are|was|were|will|would|shall|should|can|could|may|might|must)\\b|[a-z]{2,}(?:ed|s)\\b)`,
  'i',
);

// The opening clause's subject is whichever comes first in it — a provider
// ("Today we carefully inspected…", "After checking every trap, our
// technician…") or anyone else ("You can mow…") — so an unpunctuated
// lead-in never hides it.
const OPENING_SUBJECT_RE = new RegExp(`\\b${PROVIDER_SUBJECT}\\b|${OTHER_CLAUSE_SUBJECT_RE}`, 'i');
const PROVIDER_ONLY_RE = new RegExp(`^${PROVIDER_SUBJECT}$`, 'i');
function openingSubject(text) {
  const first = new RegExp(CLAUSE_COORDINATOR_RE, 'i').exec(text);
  const found = OPENING_SUBJECT_RE.exec(first ? text.slice(0, first.index) : text);
  if (!found) return null;
  return PROVIDER_ONLY_RE.test(found[0]) ? 'provider' : 'other';
}

// The visit-verb claim carried by a coordinated clause with no subject of
// its own — walks every coordinator in the sentence, tracking which
// subject is "in scope" clause by clause, rather than a fixed character
// window back to the last provider mention.
function coordinatedClauseClaims(text) {
  const claims = [];
  let subject = openingSubject(text);
  const re = new RegExp(CLAUSE_COORDINATOR_RE, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const boundaryEnd = m.index + m[0].length;
    const rest = text.slice(boundaryEnd);
    if (CLAUSE_OWN_PROVIDER_RE.test(rest)) { subject = 'provider'; continue; }
    if (CLAUSE_OWN_OTHER_RE.test(rest)) { subject = 'other'; continue; }
    if (CLAUSE_INHERIT_VERB_RE.test(rest)) {
      if (subject === 'provider') {
        const verbMatch = CLAUSE_INHERIT_VERB_RE.exec(rest);
        const lead = CLAUSE_LEAD_ONLY_RE.exec(rest)[0];
        claims.push({
          kind: 'verb',
          match: { 0: verbMatch[0].slice(lead.length), index: boundaryEnd + lead.length },
          before: text.slice(0, boundaryEnd),
        });
      }
      continue;
    }
    if (CLAUSE_OWN_VERB_SUBJECT_RE.test(rest)) { subject = 'other'; continue; }
    // A phrase-level "and"/"but" inside the current clause's own object —
    // not a clause boundary; keep scanning with the same subject in scope.
  }
  return claims;
}

// [pattern, kind]: a "verb" claim is past when its own verb is; a "noun"
// claim is past when a past word anchors it ("today's visit", "since our
// visit"); "future" claims (openers, scheduling, "see you") never are.
const VISIT_CLAIMS = [
  // Provider subject, up to three auxiliary words, visit verb: "we'll be
  // back", "we are returning", "the technician returns", "our team is
  // scheduled to come out", "the tech's return".
  [String.raw`\b${PROVIDER_SUBJECT}(?:[’'](?:ll|re|s|m|d|ve))?(?:\s+[a-z’']+){0,3}?\s+${VISIT_VERB}\b`, 'verb'],
  // Subjectless openers: "Back Tuesday to check traps", "Returning tomorrow".
  [String.raw`^\s*(?:back|returning|coming\s+back|arriving|checking\s+back|following\s+up)\b`, 'future'],
  // The visit named as a thing: any visit, appointment, arrival, follow-up,
  // re-treatment, service call, or next/scheduled service or check.
  [String.raw`\b(?:visit(?:s|ed|ing)?|appointments?|arrival|follow[-\s]?ups?|re-?treatments?|re-?inspections?|service\s+(?:call|date|day|window)s?|(?:next|upcoming|scheduled|return|follow[-\s]?up)\s+(?:services?|treatments?|inspections?|checks?|trips?|stops?)|our\s+return)\b`, 'noun'],
  // Scheduling stated as done, and the customer told to expect us.
  [String.raw`\b(?:re)?scheduled\b|\bbooked\b|\bslated\b|\bsee\s+you\b|\bexpect\s+(?:us|(?:the|your|our)\s+(?:[a-z]+\s+)?(?:technician|tech|team|crew|specialist))\b`, 'future'],
].map(([source, kind]) => ({ re: new RegExp(source, 'gi'), kind }));
// A customer's own booking request is not our visit: "Call us at 8 AM to
// book a visit" asks the customer to act at 8 AM. Only the indefinite
// request form is removed before classification; "Please schedule your
// visit for Tuesday" and "We'll do another visit Tuesday" stay claims.
const CUSTOMER_BOOKING_RE = /\b(?:to|and)\s+(?:book|schedule|request|arrange|set\s+up)\s+(?:a|an|another)\s+(?:[a-z-]+\s+)?(?:visit|appointment|follow[-\s]?up|service|treatment|inspection)\b/gi;

function visitClaimMatches(sentence) {
  const text = String(sentence || '').replace(CUSTOMER_BOOKING_RE, ' ');
  const staticMatches = VISIT_CLAIMS.flatMap(({ re, kind }) => [...text.matchAll(new RegExp(re.source, 'gi'))]
    .map((match) => ({ kind, match, before: text.slice(0, match.index) })));
  return [...staticMatches, ...coordinatedClauseClaims(text)];
}

// A genuine provider PROMISE — a verb or an unmistakably future claim — as
// opposed to a sentence that is only classified as a "claim" because it
// names the visit as a bare noun ("the day before your next visit" inside
// customer prep advice). Used only to scope the relational-date anchor
// exemption below: a customer instruction that merely mentions the next
// visit is not itself a promise about when we return.
function isProviderVisitPromise(sentence) {
  return visitClaimMatches(sentence).some(({ kind }) => kind !== 'noun');
}

function isVisitClaim(sentence) {
  return visitClaimMatches(sentence).length > 0;
}

// --- Tense -------------------------------------------------------------------
const PAST_VERB = String.raw`(?:[a-z]+ed|came|went|found|saw|took|left|made|gave|got|put|brought|caught|kept|began|did|ran|spent|swept|laid|set|dug|hung|sprayed)`;
// Any of these keeps a sentence under validation, whatever else it says: a
// future or modal verb, a scheduling word, a present-tense visit verb, or a
// date the visit is "for".
const FUTURE_MARKER_RE = new RegExp([
  String.raw`\b(?:will|shall|won[’']t|gonna|going\s+to|can|should|must|might|needs?\s+to|next|upcoming|coming|returning|arriving|tomorrow|tonight|soon|until|till)\b`,
  String.raw`[’']ll\b`,
  String.raw`\b(?:expect\w*|plan\w*|(?:re)?schedul\w*|book(?:s|ed|ing)?|slated|reserv\w*|arrang\w*|confirm\w*|moved|pushed|shifted)\b`,
  String.raw`\b(?:returns|arrives|comes|visits|(?:stops|swings|drops)\s+by|checks\s+(?:back|in)|heads\s+(?:out|over|back)|see\s+you|be\s+(?:back|there|out|over))\b`,
  String.raw`\b(?:i|we|you|they|technicians?|techs?|team|crew)\s+(?:return|arrive|come|visit|stop|swing|drop|check|head|re-?treat|re-?inspect|follow)\b`,
  String.raw`^\s*(?:back|returning|coming|arriving|checking|following|visit|see)\b`,
  String.raw`\bfor\s+(?:${WEEKDAY_NAMES}|${MONTH_NAMES}|the\s+\d)`,
].join('|'), 'i');
const PAST_MARKER_RE = new RegExp([
  String.raw`\b(?:i|we|you|they|he|she|it|technicians?|techs?|team|crew|specialists?|inspectors?)(?:[’'](?:ve|d))?\s+(?:(?:also|already|just|then|first|carefully|thoroughly|fully|all|both)\s+)?${PAST_VERB}\b`,
  String.raw`\b(?:was|were|had|has|have|been)\s+(?:(?:also|already|just|then|all|not)\s+)?${PAST_VERB}\b`,
  String.raw`\b(?:was|were|had|did|since|yesterday|ago)\b`,
  String.raw`\b(?:last|previous|prior|earlier|recent|past)\s+(?:visit|service|treatment|inspection|appointment|time)s?\b`,
].join('|'), 'i');
// What anchors a named visit in the past: "today's visit", "this visit",
// "since our visit", "during the visit", "we completed your … visit" (only
// verbs that perform the visit: "we noted your follow-up as Tuesday" and
// "we set the follow-up" name a future one). The
// anchor governs the visit only within its own phrase: no clause
// punctuation, conjunction, or present verb between them ("We inspected the
// traps, and the follow-up is Tuesday" is not anchored).
const PAST_ANCHOR_RE = new RegExp(String.raw`\b(?:today[’']?s?|this|last|previous|prior|earlier|recent|since|during|yesterday[’']?s?|completed|performed|conducted|finished|did)(?:\s+(?!(?:and|but|or|so|then|while|is|are)\b)[a-z0-9’'-]+){0,4}\s+$`, 'i');
const PAST_VISIT_VERB_RE = /\b(?:was|were|had|has|have|did)\b|[’']ve\b|\b(?:came|visited|returned|arrived|stopped|swung|dropped|checked|followed|headed|re-?treated|re-?inspected|re-?serviced)\b/i;
const PRESENT_AUX_RE = /\b(?:will|shall|going|gonna|is|are|am|be)\b|[’'](?:ll|re|m)\b/i;

// True when the sentence describes the completed visit rather than the next
// one: nothing in it looks forward, and every visit it names is anchored in
// the past (a sentence with no visit claim needs a past-tense verb).
function describesCompletedVisit(sentence) {
  const text = String(sentence || '');
  if (FUTURE_MARKER_RE.test(text)) return false;
  const claims = visitClaimMatches(text);
  if (!claims.length) return PAST_MARKER_RE.test(text);
  return claims.every(({ kind, match, before }) => {
    if (kind === 'future') return false;
    if (kind === 'verb') return PAST_VISIT_VERB_RE.test(match[0]) && !PRESENT_AUX_RE.test(match[0]);
    return /ed$/i.test(match[0]) || PAST_ANCHOR_RE.test(before);
  });
}

function isFutureVisitClaim(sentence) {
  return isVisitClaim(sentence) && !describesCompletedVisit(sentence);
}

// --- Sentences ---------------------------------------------------------------

// One sentence splitter for everything that judges copy sentence by
// sentence. A period that closes an abbreviation is not a sentence end, so a
// date or time never detaches from its visit claim ("Your next visit is Sep.
// 3." is one sentence, not a claim plus an exempt "3."). Decimals ("1.5")
// never reach it: no space follows their period.
const CALENDAR_ABBR_END = /\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\.$/;
const CALENDAR_START = new RegExp(`^(?:${WEEKDAY_NAMES}|${MONTH_NAMES}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\\b`);
const MERIDIEM_END = /\b[ap]\.m\.$/i;
// Abbreviations that end a clause ("…, etc. We will return") end the
// sentence before a capitalized word, like any other period.
const TERMINAL_ABBR_END = /(?:^|[\s(.])(?:etc|approx|e\.g|i\.e|jr|sr|inc|ltd|co)\.$/i;
// Titles and initials lead into a name ("Dr. Lee", "St. Mark", "J. Smith",
// "U.S. Postal"), so a capitalized word continues them.
const PREFIX_ABBR_END = /(?:^|[\s(.])(?:mrs?|ms|dr|st|vs|[a-z])\.$/i;

function continuesSentence(before, after) {
  // "a.m. tomorrow", "etc. before dusk": a lowercase word never opens a
  // sentence.
  if (/^[a-z]/.test(after)) return true;
  // "8 a.m. Monday" and "Sep. 3" stay one date or time; "at 8 a.m. Your next
  // visit" and "etc. We will return" are two sentences.
  if (MERIDIEM_END.test(before)) return CALENDAR_START.test(after);
  if (CALENDAR_ABBR_END.test(before) || TERMINAL_ABBR_END.test(before)) {
    return /^\d/.test(after) || CALENDAR_START.test(after);
  }
  return PREFIX_ABBR_END.test(before);
}

function splitSentences(block) {
  const text = String(block || '');
  const sentences = [];
  let start = 0;
  for (const boundary of text.matchAll(/[.!?]\s+/g)) {
    const end = boundary.index + 1;
    const next = boundary.index + boundary[0].length;
    if (text[boundary.index] === '.' && continuesSentence(text.slice(start, end), text.slice(next))) continue;
    sentences.push(text.slice(start, end).trim());
    start = next;
  }
  sentences.push(text.slice(start).trim());
  return sentences.filter(Boolean);
}

// --- Values -------------------------------------------------------------------

function normalizeWindowText(value) {
  return String(value || '').replace(/\s*([ap])\.?\s?m\.?(?![a-z])/gi, ' $1M')
    .replace(/[–—-]/g, '–').replace(/\s+/g, ' ').trim().toUpperCase();
}

function dayPeriod(text) {
  const value = String(text || '').toLowerCase();
  if (/morning/.test(value)) return 'AM';
  if (/afternoon|evening|night/.test(value)) return 'PM';
  const meridiem = /([ap])\.?\s?m/.exec(value);
  return meridiem ? `${meridiem[1].toUpperCase()}M` : null;
}

// A duration governed by a visit word just before it: a visit noun
// ("visit in 10–14 days", "follow-up in 30 days"), or a visit verb only
// when the sentence promises OUR return ("we will return within 2
// weeks") — "Activity may return within 2 weeks" and "You may return
// indoors after 2 hours" time something else.
const VISIT_NOUN_DURATION_RE = new RegExp(
  String.raw`\b(?:visits?|appointments?|follow[-\s]?ups?|rechecks?|re-?treatments?)\b(?:\s+[a-z’']+){0,2}?\s+(${RELATIVE_DURATION_RE.source})`,
  'gi',
);
const VISIT_VERB_DURATION_RE = new RegExp(
  String.raw`\b${VISIT_VERB}\b(?:\s+[a-z’']+){0,2}?\s+(${RELATIVE_DURATION_RE.source})`,
  'gi',
);

function attachedDurations(text) {
  const matches = [...String(text).matchAll(VISIT_NOUN_DURATION_RE)];
  if (isProviderVisitPromise(text)) matches.push(...String(text).matchAll(VISIT_VERB_DURATION_RE));
  return matches.map((match) => ({ index: match.index + match[0].length - match[1].length, raw: match[1] }));
}

function visitDurationSpans(text) {
  return attachedDurations(text).map(({ raw }) => durationSpan(raw));
}

function durationSpan(text) {
  const raw = text.toLowerCase().replace(/\s+/g, ' ');
  return {
    raw,
    unit: /(minute|hour|day|week|month|year)s?\b/.exec(raw)[1],
    numbers: raw.match(/\d+/g) || [],
    words: raw.replace(/^(?:in|within|after) /, ''),
  };
}

// Same unit, and either numerals the ratified span carries ("in 14 days"
// inside "in 10–14 days") or, with no numeral, the same words ("in a couple
// of days").
function ratifiedSpan(span, ratifiedSpans) {
  return ratifiedSpans.some((ratified) => ratified.unit === span.unit && (span.numbers.length
    ? span.numbers.every((number) => ratified.numbers.includes(number))
    : ratified.words === span.words));
}

function rangePoint(text) {
  const [hour, minute = '0'] = text.split(/[:.]/);
  return { hour: Number(hour), minute: Number(minute) };
}

// The arrival ranges in the text, as values. A range is a time range when
// either end carries a meridiem or part of the day ("8 to 10 AM", "eight to
// ten in the morning"), or when "between"/"from" (or, in a visit claim, an
// arrival word or a dash) opens it and the clause ends or a timing word
// follows ("arriving between 7 and 8.", "from 8 to 10 on Monday"). "between
// 2 and 3 traps" and "2 to 3 weeks" are not.
function arrivalRanges(text, { claim = false } = {}) {
  const ranges = [];
  const source = String(text);
  for (const match of source.matchAll(new RegExp(RANGE_TEXT_RE.source, 'gi'))) {
    const [raw, opener = '', start, startMeridiem, separator, end, suffix] = match;
    if (separator.trim().toLowerCase() === 'and' && opener.toLowerCase() !== 'between') continue;
    if (!startMeridiem && !suffix) {
      const led = opener || (claim && (/[–—-]/.test(separator) || CLAIM_RANGE_LEAD_RE.test(source.slice(0, match.index))));
      if (!led || !new RegExp(`^${BARE_HOUR_END}`, 'i').test(source.slice(match.index + raw.length))) continue;
    }
    const endPeriod = dayPeriod(suffix);
    ranges.push({
      raw,
      index: match.index,
      start: rangePoint(start),
      end: rangePoint(end),
      startPeriod: dayPeriod(startMeridiem) || endPeriod,
      endPeriod,
    });
  }
  return ranges;
}

// Same hours and minutes as the authoritative window; a stated half of the
// day must match it too ("between 8 and 10" names the 8–10 AM window).
function sameRange(range, expected) {
  return Boolean(expected)
    && range.start.hour === expected.start.hour && range.start.minute === expected.start.minute
    && range.end.hour === expected.end.hour && range.end.minute === expected.end.minute
    && (!range.startPeriod || range.startPeriod === expected.startPeriod)
    && (!range.endPeriod || range.endPeriod === expected.endPeriod);
}

// The parts of the day the authoritative window covers: "8–10 AM" is the
// morning (and AM); "4–6 PM" is the afternoon and the evening.
function windowPeriods(window) {
  const periods = new Set();
  if (!window) return periods;
  const hour24 = (point, period) => (point.hour % 12) + (period === 'PM' ? 12 : 0);
  const start = hour24(window.start, window.startPeriod);
  let end = hour24(window.end, window.endPeriod);
  if (window.end.minute === 0) end -= 1;
  for (let hour = start; hour <= Math.max(start, end); hour += 1) {
    periods.add(hour < 12 ? 'AM' : 'PM');
    periods.add(hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : hour < 21 ? 'evening' : 'night');
    if (hour === 11 || hour === 12) periods.add('midday');
  }
  return periods;
}

function sameMonth(written, expected) {
  return Boolean(written && expected)
    && written.replace(/\.$/, '').slice(0, 3).toLowerCase() === expected.slice(0, 3).toLowerCase();
}

// "may"/"mar"/"march" are the modal or the verb when a word follows them
// ("one may need moving", "stains may mar the finish") — unless that word
// leads into a day ("may the 4th") — or, capitalized mid-sentence, always a
// month ("back in May when").
function monthWordIsVerb(word, text, index) {
  if (!AMBIGUOUS_MONTH_RE.test(word)) return false;
  if (/^[A-Z]/.test(word) && /\S/.test(text.slice(0, index))) return false;
  return /^\s+(?!(?:the|of)\s+\d)[a-z]/i.test(text.slice(index + word.length));
}

// --- Tokens -------------------------------------------------------------------
// Each rule finds its tokens in the sentence (earlier rules mask what they
// consumed, so "9 in the morning" is one time, not a time and a period) and
// judges one token against the authoritative appointment. claimOnly rules
// read tokens that are ordinary care language outside a visit claim.
const lower = (raw) => raw.toLowerCase().replace(/\s+/g, ' ').trim();
const regexTokens = (re, text) => [...text.matchAll(new RegExp(re.source, re.flags))]
  .map((match) => ({ index: match.index, raw: match[0], match }));

const TOKEN_RULES = [
  {
    // A relational date ("the day after Monday", "two days after August 3")
    // is never the visit's own date, even when the weekday or date it names
    // agrees. First, so the date inside it is consumed with it rather than
    // judged alone. Timing anchored on the visit itself is preparation
    // advice unless the sentence promises our return ("Mow the day before
    // your next visit" stays; "We will return the day before your next
    // visit" does not).
    claimOnly: true,
    find: (text) => regexTokens(RELATIONAL_DATE_RE, text)
      .filter(({ match, index }) => !(RELATIONAL_DATE_ANCHOR_RE.test(match[1])
        && !isProviderVisitPromise(`${text.slice(0, index)} ${text.slice(index + match[0].length)}`))),
    problem: ({ raw }) => `ungrounded_relative_date:${lower(raw)}`,
  },
  {
    // A span of time is visit timing only when it times the visit: always in
    // a promise of our return, and in a sentence that merely mentions a visit
    // only when attached to it ("your follow-up visit in 10–14 days"), never
    // outcome timing beside it ("Results should appear within 2 weeks after
    // your visit").
    claimOnly: true,
    find: (text) => {
      const tokens = regexTokens(RELATIVE_DURATION_RE, text);
      if (isProviderVisitPromise(text)) return tokens;
      const attached = attachedDurations(text).map(({ index }) => index);
      return tokens.filter(({ index }) => attached.includes(index));
    },
    problem: ({ raw }, expected) => {
      const span = durationSpan(raw);
      return ratifiedSpan(span, expected.ratifiedSpans) ? null : `ungrounded_relative_date:${span.raw}`;
    },
  },
  {
    find: (text, claim) => arrivalRanges(text, { claim }).map((range) => ({ index: range.index, raw: range.raw, range })),
    problem: ({ raw, range }, expected) => (sameRange(range, expected.window) ? null : `ungrounded_window:${normalizeWindowText(raw)}`),
  },
  {
    // An exact time never agrees: the promise is the window, not a time in it.
    find: (text, claim) => regexTokens(claim ? CLAIM_CLOCK_TIME_RE : CLOCK_TIME_RE, text),
    problem: ({ raw }) => `ungrounded_time:${normalizeWindowText(raw)}`,
  },
  {
    // "Monday, Aug. 3rd", "the 3rd of September", "may 4" (never "1 may need")
    find: (text) => regexTokens(DATE_TEXT_RE, text).filter(({ match, index }) => {
      if (!match[6]) return true;
      return !monthWordIsVerb(match[6], text, index + match[0].indexOf(match[6], match[5].length));
    }),
    problem: ({ raw, match }, expected) => {
      const [, weekday, month, day, year, dayBefore, monthAfter, yearAfter] = match;
      const ok = expected.day !== null
        && sameMonth(month || monthAfter, expected.month)
        && Number(day || dayBefore) === expected.day
        && (!weekday || sameMonth(weekday, expected.weekday))
        && !(year || yearAfter);
      if (ok) return null;
      // A spelled-out weekday that contradicts is named on its own too.
      const wrongWeekday = weekday && new RegExp(`^(?:${WEEKDAY_NAMES})$`, 'i').test(weekday)
        && weekday.toLowerCase() !== expected.weekday.toLowerCase();
      return [`ungrounded_date:${raw.trim()}`, ...(wrongWeekday ? [`ungrounded_weekday:${weekday}`] : [])];
    },
  },
  {
    claimOnly: true,
    find: (text) => regexTokens(NUMERIC_DATE_RE, text),
    problem: ({ raw, match }, expected) => {
      const [, isoYear, isoMonth, isoDay, month, day, year] = match;
      const ok = !isoYear && !year && expected.day !== null
        && MONTH_INDEX[Number(month || isoMonth) - 1] === expected.month.slice(0, 3).toLowerCase()
        && Number(day || isoDay) === expected.day;
      return ok ? null : `ungrounded_date:${raw}`;
    },
  },
  {
    // A relative date is never the authoritative visit, which is dated.
    find: (text) => regexTokens(RELATIVE_APPOINTMENT_DATE_RE, text),
    problem: ({ raw }) => `ungrounded_relative_date:${lower(raw)}`,
  },
  {
    claimOnly: true,
    find: (text) => regexTokens(CLAIM_RELATIVE_DATE_RE, text),
    problem: ({ raw }) => `ungrounded_relative_date:${lower(raw)}`,
  },
  {
    find: (text) => regexTokens(new RegExp(`\\b(?:${WEEKDAY_NAMES})\\b`, 'gi'), text),
    problem: ({ raw }, expected) => (raw.toLowerCase() === expected.weekday.toLowerCase() ? null : `ungrounded_weekday:${raw}`),
  },
  {
    claimOnly: true,
    find: (text) => regexTokens(WEEKDAY_ABBR_RE, text),
    problem: ({ raw }, expected) => (sameMonth(raw, expected.weekday) ? null : `ungrounded_weekday:${raw.replace(/\.$/, '')}`),
  },
  {
    claimOnly: true,
    find: (text) => regexTokens(BARE_MONTH_RE, text)
      .filter(({ raw, index }) => !monthWordIsVerb(raw.replace(/\.$/, ''), text, index)),
    problem: ({ raw }, expected) => (sameMonth(raw, expected.month) ? null : `ungrounded_date:${raw.replace(/\.$/, '')}`),
  },
  {
    claimOnly: true,
    find: (text) => regexTokens(ORDINAL_DAY_RE, text),
    problem: ({ raw, match }, expected) => (Number(match[1] || match[2]) === expected.day ? null : `ungrounded_date:${raw.trim()}`),
  },
  {
    claimOnly: true,
    find: (text) => regexTokens(DAY_PERIOD_RE, text),
    problem: ({ raw }, expected) => {
      const word = lower(raw).replace(/s$/, '').replace('mid-day', 'midday').replace('overnight', 'night');
      const period = /^[ap]\.?m\.?$/.test(word) ? `${word[0].toUpperCase()}M` : word;
      return expected.periods.has(period) ? null : `ungrounded_day_period:${word}`;
    },
  },
  {
    claimOnly: true,
    find: (text) => regexTokens(OCLOCK_RE, text),
    problem: ({ raw }) => `ungrounded_time:${normalizeWindowText(raw)}`,
  },
];

function temporalTokens(sentence, claim) {
  let masked = sentence;
  const tokens = [];
  for (const rule of TOKEN_RULES) {
    if (rule.claimOnly && !claim) continue;
    const found = rule.find(masked, claim);
    for (const token of found) {
      tokens.push({ ...token, rule });
      masked = `${masked.slice(0, token.index)}${' '.repeat(token.raw.length)}${masked.slice(token.index + token.raw.length)}`;
    }
  }
  return tokens.sort((a, b) => a.index - b.index);
}

// The timing a future visit claim states, bound to the clause that makes
// the claim: a date in a care clause joined to it ("Water the lawn Monday,
// and we will check the traps at your next visit") times the watering, not
// the visit. In a promise of our return any timeframe word counts too —
// "later in the week", "in 10 business days", "soon" all say when.
const CLAUSE_PREFIX_RE = /^(?:,\s*)?\b(?:and|but|then)\b\s*|^;\s*/i;
const RETURN_TIMEFRAME_RE = /\b(?:later|soon|shortly|sometime|eventually|days?|weeks?|months?|weekends?|mornings?|afternoons?|evenings?|nights?|tonight|tomorrow|holidays?)\b/gi;

// Visit-anchored preparation timing ("the day before your scheduled
// visit") times the customer's step, so it never makes a clause a promise of
// our return or supplies its timeframe words.
function withoutVisitAnchoredTiming(text) {
  return text.replace(new RegExp(RELATIONAL_DATE_RE.source, 'gi'), (phrase, anchor) => (
    RELATIONAL_DATE_ANCHOR_RE.test(anchor) ? ' '.repeat(phrase.length) : phrase));
}

// The visit named only as the anchor of a customer step ("Water at 6 AM
// before your scheduled visit", "Keep pets off the lawn until your next
// visit") makes no claim about when we come: the step's own timing is the
// customer's.
const VISIT_ANCHOR_MENTION_RE = /\b(?:before|after|until|till|by|at|for|during|ahead\s+of|prior\s+to|between)\s+(?:(?:your|the|our|this|each|every|a|an)\s+)?(?:(?:next|scheduled|upcoming|planned|booked|follow[-\s]?up|return|regular|second)\s+){0,2}(?:visits?|appointments?|services?|treatments?|follow[-\s]?ups?|inspections?)\b/gi;
const withoutAnchorMentions = (text) => text.replace(VISIT_ANCHOR_MENTION_RE, (phrase) => ' '.repeat(phrase.length));
// A clause with no subject of its own right after a promise of our return
// continues that promise ("We will return and check the traps Monday").
// A clause opening with its own subject (a pronoun, or a noun before an
// auxiliary or past verb: "activity subsided") or with an instruction to
// the customer ("keep pets inside", "call us") does not continue it.
const OWN_SUBJECT_START_RE = new RegExp(`^${CLAUSE_LEAD_RE}(?:${PROVIDER_SUBJECT}\\b|${OTHER_CLAUSE_SUBJECT_RE}|[a-z][a-z'-]*\\s+(?:[a-z]+ly\\s+)?(?:has|have|had|is|are|was|were|will|would|shall|should|can|could|may|might|must|[a-z]{2,}ed)\\b)`, 'i');
const CUSTOMER_STEP_START_RE = new RegExp(`^${CLAUSE_LEAD_RE}(?:please\\s+)?(?:keep|water|mow|avoid|stay|wait|call|contact|text|let|close|remove|leave|store|seal|clean|vacuum|sweep|don[’']?t|do\\s+not|make\\s+sure|be\\s+sure)\\b`, 'i');

function claimClauses(text) {
  const cuts = [0, ...[...text.matchAll(new RegExp(CLAUSE_COORDINATOR_RE, 'gi'))].map((m) => m.index), text.length];
  const coordinated = coordinatedClauseClaims(text).map(({ match }) => match.index);
  const clauses = [];
  cuts.slice(0, -1).forEach((start, i) => {
    const end = cuts[i + 1];
    const raw = text.slice(start, end);
    const offset = start + (CLAUSE_PREFIX_RE.exec(raw)?.[0].length || 0);
    const body = text.slice(offset, end);
    const carried = coordinated.some((index) => index >= start && index < end);
    const previous = clauses[clauses.length - 1];
    const continues = Boolean(previous?.promise) && !OWN_SUBJECT_START_RE.test(body) && !CUSTOMER_STEP_START_RE.test(body);
    const unanchored = withoutVisitAnchoredTiming(body);
    clauses.push({
      start,
      end,
      offset,
      raw,
      body: unanchored,
      claim: carried || continues || isVisitClaim(withoutAnchorMentions(body)),
      promise: carried || continues || isProviderVisitPromise(withoutAnchorMentions(unanchored)),
    });
  });
  return clauses;
}

const RETURN_TIMEFRAME_TEST_RE = new RegExp(RETURN_TIMEFRAME_RE.source, 'i');

// True when one clause states timing for the visit it claims.
function clauseStatesTiming(clause) {
  if (!clause.claim) return false;
  return temporalTokens(normalizeTemporalText(clause.body), true).length > 0
    || (clause.promise && RETURN_TIMEFRAME_TEST_RE.test(clause.body));
}

function visitTimingTokens(sentence) {
  const text = normalizeTemporalText(sentence);
  const clauses = claimClauses(text);
  const clauseAt = (index) => clauses.find((clause) => index >= clause.start && index < clause.end);
  const tokens = temporalTokens(text, true).filter((token) => clauseAt(token.index)?.claim);
  const covered = (index) => tokens.some((token) => index >= token.index && index < token.index + token.raw.length);
  for (const clause of clauses.filter(({ promise }) => promise)) {
    for (const match of clause.body.matchAll(RETURN_TIMEFRAME_RE)) {
      const index = clause.offset + match.index;
      if (!covered(index)) tokens.push({ index, raw: match[0] });
    }
  }
  return { text, clauses, clauseAt, tokens: tokens.sort((a, b) => a.index - b.index) };
}

function expectedAppointment(facts, groundedCare) {
  const nextVisit = facts?.nextVisit || {};
  const date = new RegExp(`^(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})$`, 'i')
    .exec(String(nextVisit.date || '').trim());
  const [window = null] = arrivalRanges(nextVisit.window || '');
  return {
    weekday: date?.[1] || '',
    month: date?.[2] || '',
    day: date ? Number(date[3]) : null,
    window,
    periods: windowPeriods(window),
    // Only a duration attached to the visit itself ("a follow-up visit in
    // 10–14 days", "we will return in 2 weeks") can ground a
    // relative-duration visit promise. Outcome timing never does, even in a
    // sentence that mentions a visit ("Results should appear within 2 weeks
    // after your visit") — codex P1 on #5055 follow-ups.
    ratifiedSpans: groundedCare.flatMap((sentence) => visitDurationSpans(normalizeTemporalText(sentence))),
  };
}

// With a visit on the schedule, the narrative never says when we return
// (owner ruling 2026-09-28): every temporal token in a future visit claim is
// a problem even when it agrees — the report's upcoming-visits section is
// the one place the date appears. With none scheduled, every temporal token
// in a future visit claim is ungrounded except a duration the ratified copy
// attached to the visit. Appointment-shaped tokens outside a claim are
// judged against the schedule either way.
function nextVisitProblems(text, facts, options = {}) {
  const groundedCare = options.groundedCareExemptions || [];
  // One exemption boundary before every scan: ratified care copied verbatim
  // leaves the text only when it is not a future visit claim.
  const exemptText = groundedCare.reduce((copy, sentence) => {
    const care = String(sentence || '').trim();
    return care && !isFutureVisitClaim(withoutAnchorMentions(care)) ? copy.replaceAll(care, ' ') : copy;
  }, String(text));
  const expected = expectedAppointment(facts, groundedCare);
  const scheduled = Boolean(facts?.nextVisit);
  const problems = [];
  for (const sentence of splitSentences(exemptText)) {
    if (describesCompletedVisit(sentence)) continue;
    if (scheduled) {
      const { text, clauseAt, tokens } = visitTimingTokens(sentence);
      problems.push(...tokens.map((token) => `visit_timing_stated:${lower(token.raw)}`));
      // tokens outside any claim clause keep their ordinary schedule check
      for (const token of temporalTokens(text, false).filter(({ index }) => !clauseAt(index)?.claim)) {
        problems.push(...[token.rule.problem(token, expected)].flat().filter(Boolean));
      }
      continue;
    }
    for (const token of temporalTokens(normalizeTemporalText(sentence), isVisitClaim(sentence))) {
      problems.push(...[token.rule.problem(token, expected)].flat().filter(Boolean));
    }
  }
  return problems;
}

// With a visit on the schedule, ratified copy (Today's Result, next step,
// recap) loses every future visit claim that says when (owner ruling
// 2026-09-28), agreeing or not, before the copy reaches any consumer (the
// prompt, the deterministic fallback, the mandatory-care append, the care
// exemptions). A visit claim with no timing ("We will check the traps at
// your next visit") and a sentence about the completed visit ("At today's
// September 28 visit, we inspected the traps") are kept. With nothing
// scheduled the copy is kept as written.
function withoutTimedVisitClaims(block, nextVisit) {
  if (!nextVisit) return block;
  return splitSentences(block)
    .map((sentence) => (isFutureVisitClaim(sentence) && visitTimingTokens(sentence).tokens.length
      ? withoutTimedClauses(sentence) : sentence))
    .filter(Boolean)
    .join(' ');
}

// Only the clause that times the visit leaves: "Keep the traps dry, and we
// will return Monday." keeps "Keep the traps dry." — ratified care is never
// lost because stale scheduling prose was appended to it.
function withoutTimedClauses(sentence) {
  const clauses = claimClauses(sentence);
  const kept = clauses.filter((clause) => !clauseStatesTiming(clause));
  if (!kept.length) return '';
  const joined = kept.map((clause, i) => (i === 0 ? clause.raw.replace(CLAUSE_PREFIX_RE, '') : clause.raw)).join('')
    .replace(/[\s,;:–—-]+$/, '').replace(/[.!?]+$/, '').trim();
  if (!joined) return '';
  const terminal = /[.!?]$/.exec(sentence.trim())?.[0] || '.';
  return `${joined[0].toUpperCase()}${joined.slice(1)}${terminal}`;
}

module.exports = {
  nextVisitProblems, isVisitClaim, splitSentences, withoutTimedVisitClaims,
};
