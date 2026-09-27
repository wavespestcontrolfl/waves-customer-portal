// Strict validation for typed-report appointment copy. Temporal facts describe
// the authoritative next visit unless they are copied from ratified,
// non-appointment customer care.

const MERIDIEM_TEXT = String.raw`[ap]\.?m\.?`;
const CLOCK_HOUR_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const EXACT_TIME_TEXT = String.raw`(?:\d{1,2}(?::\d{2})?\s*${MERIDIEM_TEXT}|(?:[01]?\d|2[0-3]):[0-5]\d|\b(?:noon|midnight)\b)`;
const WINDOW_TEXT_RE = new RegExp(String.raw`(?<!\d)\d{1,2}(?::\d{2})?\s*(?:${MERIDIEM_TEXT})?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*${MERIDIEM_TEXT}(?![a-z])`, 'gi');
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const MONTH_DATE_TEXT = 'Jan(?:\\.|uary)?|Feb(?:\\.|ruary)?|Mar(?:\\.|ch)?|Apr(?:\\.|il)?|May\\.?|Jun(?:\\.|e)?|Jul(?:\\.|y)?|Aug(?:\\.|ust)?|Sep(?:\\.|t\\.?|tember)?|Oct(?:\\.|ober)?|Nov(?:\\.|ember)?|Dec(?:\\.|ember)?';
const WEEKDAY_NAMES = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
const DATE_TEXT_RE = new RegExp(`\\b(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_DATE_TEXT})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(?:(?:in|of)\\s+)?\\(?(\\d{4}|[’']?\\d{2})(?![\\d:]|\\s*(?:${MERIDIEM_TEXT}|[–—-]))\\)?)?`, 'gi');
const CLOCK_TIME_RE = new RegExp(String.raw`(?<![\d:])${EXACT_TIME_TEXT}(?![a-z\d:])`, 'gi');
const WORD_CLOCK_TIME_RE = new RegExp(String.raw`\b(?:${CLOCK_HOUR_WORDS})(?:\s*${MERIDIEM_TEXT}|\s+o[’']clock)\b`, 'gi');
const RELATIVE_APPOINTMENT_DATE_RE = new RegExp(`\\b(?:tomorrow|tonight|next\\s+(?:day|week|month)|(?:next|this)\\s+(?:${WEEKDAY_NAMES}))\\b`, 'gi');
const APPOINTMENT_CARE_RE = /\b(?:next|upcoming)\s+(?:visit|appointment|service|follow[-\s]?up)\b|\b(?:arrival|appointment|visit|service)\s+(?:is|will\s+be|scheduled|booked|set)\b|\b(?:will|[’']ll)\s+(?:visit|return|arrive|be\s+(?:back|there)|come\s+back|check\s+back|follow[-\s]+up)\b|\b(?:i|we|(?:the|our)\s+(?:technician|tech|team|crew|specialist))\s+(?:(?:am|is|are)\s+(?:returning|arriving|coming\s+back|checking\s+back|following[-\s]+up)|(?:returns?|arrives?|come(?:s)?\s+back|check(?:s)?\s+back|follow(?:s)?[-\s]+up))\b/i;

function normalizeWindowText(value) {
  return String(value || '').replace(/\s*([ap])\.?m\.?(?![a-z])/gi, ' $1M')
    .replace(/[–—-]/g, '–').replace(/\s+/g, ' ').trim().toUpperCase();
}

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
  for (const match of withoutRanges.matchAll(new RegExp(WORD_CLOCK_TIME_RE.source, 'gi'))) {
    problems.push(`ungrounded_time:${normalizeWindowText(match[0])}`);
  }
  return problems;
}

// Every window, month-day, weekday, relative date, and exact clock time must
// match the typed report's authoritative appointment facts.
function nextVisitProblems(text, facts, options = {}) {
  // Apply one exemption boundary before every date/window/clock scan. A
  // ratified care sentence may contain any of those temporal forms, while an
  // appointment-shaped next step must remain visible to every validator.
  const validationText = (options.groundedCareExemptions || []).reduce((copy, sentence) => {
    const groundedCare = String(sentence || '').trim();
    return groundedCare && !APPOINTMENT_CARE_RE.test(groundedCare)
      ? copy.replaceAll(groundedCare, ' ')
      : copy;
  }, String(text));
  const problems = clockWindowProblems(validationText, facts);
  const expected = facts.nextVisit || {};
  const expectedDate = new RegExp(`^(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})$`, 'i')
    .exec(String(expected.date).trim());
  for (const match of validationText.matchAll(new RegExp(DATE_TEXT_RE.source, 'gi'))) {
    const [, , month, day, year] = match;
    const ok = expectedDate
      && month.slice(0, 3).toLowerCase() === expectedDate[2].slice(0, 3).toLowerCase()
      && Number(day) === Number(expectedDate[3])
      && !year;
    if (!ok) problems.push(`ungrounded_date:${match[0].trim()}`);
  }
  const [, expectedWeekday = ''] = expectedDate || [];
  for (const match of validationText.matchAll(new RegExp(`\\b(${WEEKDAY_NAMES})\\b`, 'gi'))) {
    if (match[1].toLowerCase() !== expectedWeekday.toLowerCase()) {
      problems.push(`ungrounded_weekday:${match[1]}`);
    }
  }
  for (const match of validationText.matchAll(new RegExp(RELATIVE_APPOINTMENT_DATE_RE.source, 'gi'))) {
    problems.push(`ungrounded_relative_date:${match[0].toLowerCase()}`);
  }
  return problems;
}

module.exports = { nextVisitProblems };
