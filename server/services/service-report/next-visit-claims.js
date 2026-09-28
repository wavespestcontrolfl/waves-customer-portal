// Strict validation for typed-report appointment copy. Temporal facts describe
// the authoritative next visit unless they are copied from ratified,
// non-appointment customer care.
//
// Two rule sets live here, and every scan goes through them:
//
// 1. TEMPORAL FORMS: what counts as a date, weekday, relative date, arrival
//    window, or exact clock time. Scans run on word-number-normalized text,
//    so "eight AM", "nine in the morning", "half past eight", and
//    "September third" are judged exactly like their digit forms.
//
// 2. VISIT CLAIMS: which ratified care sentences talk about our visit. A
//    ratified sentence copied verbatim is exempt from the temporal scans only
//    when it makes no visit claim ("Contact us at 8 AM if activity returns",
//    "Water for 20 minutes at 6 AM"). Any visit claim keeps the whole
//    sentence under validation, including mixed sentences, so an unlisted
//    phrasing fails closed instead of exempting an appointment promise.

const { normalizeWordNumbers } = require('./activity-indicators');

const MERIDIEM_TEXT = String.raw`[ap]\.?\s?m\.?`;
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_DATE_TEXT = 'Jan(?:\\.|uary)?|Feb(?:\\.|ruary)?|Mar(?:\\.|ch)?|Apr(?:\\.|il)?|May\\.?|Jun(?:\\.|e)?|Jul(?:\\.|y)?|Aug(?:\\.|ust)?|Sep(?:\\.|t\\.?|tember)?|Oct(?:\\.|ober)?|Nov(?:\\.|ember)?|Dec(?:\\.|ember)?';
const WEEKDAY_NAMES = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
// Abbreviated weekdays only count inside a month-day date ("Tue., Aug 3");
// standalone, "Sun"/"Sat"/"Wed" are ordinary words.
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
const EXACT_TIME_TEXT = [
  String.raw`(?<![\d:.])${HOUR_12}${MINUTE_TEXT}?${CLOCK_SUFFIX}`,
  String.raw`(?<![\d:.])(?:[01]?\d|2[0-3]):[0-5]\d(?![\d:])`,
  String.raw`\b(?:noon|midnight)\b`,
  String.raw`\b(?:(?:half|quarter)\s+(?:past|after|to|till?)|[1-5]?\d\s+(?:past|after))\s+${HOUR_12}${BARE_HOUR_END}`,
  String.raw`\b(?:at|around|before|after|until|till|til)\s+${HOUR_12}(?:[:.][0-5]\d)?${BARE_HOUR_END}`,
].join('|');
const WINDOW_TEXT_RE = new RegExp(String.raw`(?<![\d:])\d{1,2}(?::\d{2})?\s*(?:${MERIDIEM_TEXT})?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*${MERIDIEM_TEXT}(?![a-z])`, 'gi');
const CLOCK_TIME_RE = new RegExp(EXACT_TIME_TEXT, 'gi');
const YEAR_TEXT = String.raw`(?:\s*,?\s*(?:(?:in|of)\s+)?\(?(\d{4}|[’']?\d{2})(?![\d:]|\s*(?:${MERIDIEM_TEXT}|[–—-]))\)?)?`;
// Month-first ("Monday, Aug. 3rd") and day-first ("the 3rd of September").
const DATE_TEXT_RE = new RegExp(
  `\\b(?:(${WEEKDAY_DATE_TEXT}),?\\s+)?(${MONTH_DATE_TEXT})\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b${YEAR_TEXT}`
  + `|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_DATE_TEXT})(?![a-z])${YEAR_TEXT}`,
  'gi',
);
const RELATIVE_APPOINTMENT_DATE_RE = new RegExp(
  `\\b(?:tomorrow|tonight|next\\s+(?:day|week|month)|(?:(?:next|this)\\s+(?:coming\\s+)?|coming\\s+|following\\s+)(?:${WEEKDAY_NAMES})|(?:${WEEKDAY_NAMES})\\s+after\\s+next)\\b`,
  'gi',
);

const ORDINAL_DAYS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
};
const ORDINAL_RE = new RegExp(`\\b(?:(twenty|thirty)[-\\s]+)?(${Object.keys(ORDINAL_DAYS).join('|')})\\b`, 'gi');

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
const VISIT_CLAIM_RES = [
  // Provider subject, up to three auxiliary words, visit verb: "we'll be
  // back", "we are returning", "the technician returns", "our team is
  // scheduled to come out", "the tech's return".
  new RegExp(String.raw`\b${PROVIDER_SUBJECT}(?:[’'](?:ll|re|s|m|d|ve))?(?:\s+[a-z’']+){0,3}?\s+${VISIT_VERB}\b`, 'i'),
  // Subjectless openers: "Back Tuesday to check traps", "Returning tomorrow".
  /^\s*(?:back|returning|coming\s+back|arriving|checking\s+back|following\s+up)\b/i,
  // The visit named as a thing: any visit, appointment, arrival, follow-up,
  // re-treatment, service call, or next/scheduled service or check.
  /\b(?:visit(?:s|ed|ing)?|appointments?|arrival|follow[-\s]?ups?|re-?treatments?|re-?inspections?|service\s+(?:call|date|day|window)s?|(?:next|upcoming|scheduled|return|follow[-\s]?up)\s+(?:services?|treatments?|inspections?|checks?|trips?|stops?)|our\s+return)\b/i,
  // Scheduling stated as done, and the customer told to expect us.
  /\b(?:re)?scheduled\b|\bbooked\b|\bslated\b|\bsee\s+you\b|\bexpect\s+(?:us|(?:the|your|our)\s+(?:[a-z]+\s+)?(?:technician|tech|team|crew|specialist))\b/i,
];
// A customer's own booking request is not our visit: "Call us at 8 AM to
// book a visit" asks the customer to act at 8 AM. Only the indefinite
// request form is removed before classification; "Please schedule your
// visit for Tuesday" and "We'll do another visit Tuesday" stay claims.
const CUSTOMER_BOOKING_RE = /\b(?:to|and)\s+(?:book|schedule|request|arrange|set\s+up)\s+(?:a|an|another)\s+(?:[a-z-]+\s+)?(?:visit|appointment|follow[-\s]?up|service|treatment|inspection)\b/gi;

function isVisitClaim(sentence) {
  const text = String(sentence || '').replace(CUSTOMER_BOOKING_RE, ' ');
  return VISIT_CLAIM_RES.some((re) => re.test(text));
}

// --- Scans -------------------------------------------------------------------

function normalizeWindowText(value) {
  return String(value || '').replace(/\s*([ap])\.?\s?m\.?(?![a-z])/gi, ' $1M')
    .replace(/[–—-]/g, '–').replace(/\s+/g, ' ').trim().toUpperCase();
}

// Every arrival window must be the authoritative window, and no exact clock
// time may appear at all: the customer promise is a window, never a time,
// including either endpoint of the window.
function clockWindowProblems(text, facts) {
  const problems = [];
  const expectedWindow = normalizeWindowText(facts?.nextVisit?.window);
  for (const match of String(text).matchAll(new RegExp(WINDOW_TEXT_RE.source, 'gi'))) {
    if (normalizeWindowText(match[0]) !== expectedWindow) {
      problems.push(`ungrounded_window:${normalizeWindowText(match[0])}`);
    }
  }
  const withoutRanges = String(text).replace(new RegExp(WINDOW_TEXT_RE.source, 'gi'), ' ');
  for (const match of withoutRanges.matchAll(new RegExp(CLOCK_TIME_RE.source, 'gi'))) {
    problems.push(`ungrounded_time:${normalizeWindowText(match[0])}`);
  }
  return problems;
}

// Every window, month-day, weekday, relative date, and exact clock time must
// match the typed report's authoritative appointment facts.
function nextVisitProblems(text, facts, options = {}) {
  // One exemption boundary before every scan: ratified care copied verbatim
  // leaves the text only when it makes no visit claim.
  const exemptText = (options.groundedCareExemptions || []).reduce((copy, sentence) => {
    const groundedCare = String(sentence || '').trim();
    return groundedCare && !isVisitClaim(groundedCare)
      ? copy.replaceAll(groundedCare, ' ')
      : copy;
  }, String(text));
  const validationText = normalizeTemporalText(exemptText);
  const problems = clockWindowProblems(validationText, facts);
  const expected = facts.nextVisit || {};
  const expectedDate = new RegExp(`^(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})$`, 'i')
    .exec(String(expected.date).trim());
  const [, expectedWeekday = ''] = expectedDate || [];
  for (const match of validationText.matchAll(new RegExp(DATE_TEXT_RE.source, 'gi'))) {
    const weekday = match[1];
    const month = match[2] || match[6];
    const day = match[3] || match[5];
    const year = match[4] || match[7];
    // Lowercase "may"/"mar" are the verbs ("one may need moving" normalizes
    // to "1 may"), never a month the model would write.
    if (/^ma[yr]$/.test(month)) continue;
    const ok = expectedDate
      && month.slice(0, 3).toLowerCase() === expectedDate[2].slice(0, 3).toLowerCase()
      && Number(day) === Number(expectedDate[3])
      && (!weekday || weekday.slice(0, 3).toLowerCase() === expectedWeekday.slice(0, 3).toLowerCase())
      && !year;
    if (!ok) problems.push(`ungrounded_date:${match[0].trim()}`);
  }
  for (const match of validationText.matchAll(new RegExp(`\\b(${WEEKDAY_NAMES})\\b`, 'gi'))) {
    if (match[1].toLowerCase() !== expectedWeekday.toLowerCase()) {
      problems.push(`ungrounded_weekday:${match[1]}`);
    }
  }
  for (const match of validationText.matchAll(new RegExp(RELATIVE_APPOINTMENT_DATE_RE.source, 'gi'))) {
    problems.push(`ungrounded_relative_date:${match[0].toLowerCase().replace(/\s+/g, ' ')}`);
  }
  return problems;
}

module.exports = { nextVisitProblems, isVisitClaim };
