// Strict validation for typed-report appointment copy. Temporal facts describe
// the authoritative next visit unless they are copied from ratified,
// non-appointment customer care.
//
// Two rule sets live here, and every scan goes through them:
//
// 1. TEMPORAL FORMS: what counts as a date, weekday, relative date, arrival
//    window, or exact clock time. Scans run on word-number-normalized text,
//    so "eight AM", "nine in the morning", "half past eight", and
//    "September third" are judged exactly like their digit forms. Arrival
//    windows are read in dash and prose form ("between 8 and 10", "from 8
//    to 10 AM") and compared by value. A relative duration ("in 7 days",
//    "within two weeks") is a date only inside a visit claim.
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
// An arrival range, dash or prose: "8–10 AM", "8 AM to 10 AM", "between 8
// and 10", "from 8 to 10 in the morning". arrivalRanges() decides which
// matches are times rather than counts ("between 2 and 3 traps").
const RANGE_POINT = String.raw`${HOUR_12}(?:[:.][0-5]\d)?`;
const RANGE_TEXT_RE = new RegExp(
  String.raw`(?<![\d:.])(?:\b(between|from)\s+)?(${RANGE_POINT})(\s*${MERIDIEM_TEXT}(?![a-z\d]))?(\s*[–—-]\s*|\s+(?:and|to|till?|until|through|thru)\s+)(${RANGE_POINT})(${CLOCK_SUFFIX})?`,
  'gi',
);
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
// A span of time from today: "in 7 days", "within 2 weeks", "in a couple
// of days", "after 2 or 3 days", "7 days from now", "within the next week".
// Only a visit claim turns it into an appointment date ("We will be back in
// 7 days"); in care copy it is an expectation ("results show within 2 weeks").
// A visit claim's span is grounded only by a span the ratified care copy
// states itself ("A follow-up visit in 10–14 days is recommended"), never by
// a numeral another fact happens to ground (7 traps).
const DURATION_COUNT = String.raw`(?:\d+(?:\s*(?:[–—-]|to|or)\s*\d+)?|an?|(?:a\s+)?(?:couple|few)(?:\s+(?:of|more))?|several|another)`;
const DURATION_UNIT = String.raw`(?:hours?|days?|weeks?|months?)`;
const RELATIVE_DURATION_RE = new RegExp(
  String.raw`\b(?:(?:in|within|after)\s+(?:(?:about|around|roughly|approximately|another|the\s+next|the\s+coming)\s+)?(?:${DURATION_COUNT}\s+)?(?:more\s+)?${DURATION_UNIT}|${DURATION_COUNT}\s+${DURATION_UNIT}\s+(?:from\s+(?:now|today)|later))\b`,
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

// One sentence splitter for everything that judges copy sentence by
// sentence: the visit-claim scope of a duration, the ratified-care list, and
// the stale-claim filter below. A period that closes an abbreviation is not a
// sentence end, so a date or time never detaches from its visit claim
// ("Your next visit is Sep. 3." is one sentence, not a claim plus an exempt
// "3."). Decimals ("1.5") never reach it: no space follows their period.
const CALENDAR_ABBR_END = /\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\.$/;
const CALENDAR_START = new RegExp(`^(?:${WEEKDAY_NAMES}|${MONTH_NAMES}|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\\b`);
const MERIDIEM_END = /\b[ap]\.m\.$/i;
// Titles, "etc."-style abbreviations, and single-letter initials ("J.",
// "U.S.").
const TITLE_ABBR_END = /(?:^|[\s(.])(?:mrs?|ms|dr|st|jr|sr|etc|vs|approx|e\.g|i\.e|[a-z])\.$/i;

function continuesSentence(before, after) {
  // "a.m. tomorrow", "approx. five": a lowercase word never opens a sentence.
  if (/^[a-z]/.test(after)) return true;
  // "8 a.m. Monday" stays one time; "at 8 a.m. Your next visit" is two.
  if (MERIDIEM_END.test(before)) return CALENDAR_START.test(after);
  // "Sep. 3", "Mon. Aug. 4"
  if (CALENDAR_ABBR_END.test(before)) return /^\d/.test(after) || CALENDAR_START.test(after);
  return TITLE_ABBR_END.test(before);
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

function durationSpans(text) {
  return [...String(text).matchAll(new RegExp(RELATIVE_DURATION_RE.source, 'gi'))].map((match) => {
    const raw = match[0].toLowerCase().replace(/\s+/g, ' ');
    return {
      raw,
      unit: /(hour|day|week|month)s?\b/.exec(raw)[1],
      numbers: raw.match(/\d+/g) || [],
      words: raw.replace(/^(?:in|within|after) /, ''),
    };
  });
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
// ten in the morning"), or when "between"/"from" opens it and the clause ends
// or a timing word follows ("arriving between 7 and 8.", "from 8 to 10 on
// Monday"). "between 2 and 3 traps" and "2 to 3 weeks" are not.
function arrivalRanges(text) {
  const ranges = [];
  for (const match of String(text).matchAll(new RegExp(RANGE_TEXT_RE.source, 'gi'))) {
    const [raw, opener = '', start, startMeridiem, separator, end, suffix] = match;
    if (separator.trim().toLowerCase() === 'and' && opener.toLowerCase() !== 'between') continue;
    if (!startMeridiem && !suffix) {
      const rest = String(text).slice(match.index + raw.length);
      if (!opener || !new RegExp(`^${BARE_HOUR_END}`, 'i').test(rest)) continue;
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

// Every arrival window must be the authoritative window, and no exact clock
// time may appear at all: the customer promise is a window, never a time,
// including either endpoint of the window.
function clockWindowProblems(text, facts) {
  const problems = [];
  const [expected = null] = arrivalRanges(facts?.nextVisit?.window || '');
  let withoutRanges = String(text);
  for (const range of arrivalRanges(text).reverse()) {
    if (!sameRange(range, expected)) problems.unshift(`ungrounded_window:${normalizeWindowText(range.raw)}`);
    withoutRanges = `${withoutRanges.slice(0, range.index)} ${withoutRanges.slice(range.index + range.raw.length)}`;
  }
  for (const match of withoutRanges.matchAll(new RegExp(CLOCK_TIME_RE.source, 'gi'))) {
    problems.push(`ungrounded_time:${normalizeWindowText(match[0])}`);
  }
  return problems;
}

// A relative date is never the authoritative visit; a span is one only inside
// a visit claim, and only when the ratified care does not state it.
function relativeDateProblems(text, groundedCare) {
  const relativeDates = [...text.matchAll(new RegExp(RELATIVE_APPOINTMENT_DATE_RE.source, 'gi'))]
    .map((match) => match[0]);
  const ratifiedSpans = groundedCare.flatMap((sentence) => durationSpans(normalizeTemporalText(sentence)));
  for (const sentence of splitSentences(text)) {
    if (!isVisitClaim(sentence)) continue;
    relativeDates.push(...durationSpans(sentence)
      .filter((span) => !ratifiedSpan(span, ratifiedSpans))
      .map((span) => span.raw));
  }
  return relativeDates.map((relative) => `ungrounded_relative_date:${relative.toLowerCase().replace(/\s+/g, ' ')}`);
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
  problems.push(...relativeDateProblems(validationText, options.groundedCareExemptions || []));
  return problems;
}

// Ratified copy (Today's Result, next step, recap) that promises a visit at
// a time the authoritative next visit contradicts is stale. It is removed
// sentence by sentence before the copy reaches any consumer (the prompt, the
// deterministic fallback, the mandatory-care append, the care exemptions), so
// no path can publish it beside the dated visit. A sentence grounds its own
// recommended span, as it would in the model's copy. With no authoritative
// visit there is nothing to contradict and the copy is kept as written.
function withoutStaleVisitClaims(block, nextVisit) {
  if (!nextVisit) return block;
  return splitSentences(block)
    .filter((sentence) => !isVisitClaim(sentence)
      || !nextVisitProblems(sentence, { nextVisit }, { groundedCareExemptions: [sentence] }).length)
    .join(' ');
}

module.exports = {
  nextVisitProblems, isVisitClaim, splitSentences, withoutStaleVisitClaims,
};
