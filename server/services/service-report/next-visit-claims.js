// Strict validation for typed-report appointment copy. Every temporal fact in
// this lane describes the authoritative next visit.

const MERIDIEM_TEXT = String.raw`[ap]\.?m\.?`;
const EXACT_TIME_TEXT = String.raw`(?:\d{1,2}(?::\d{2})?\s*${MERIDIEM_TEXT}|(?:[01]?\d|2[0-3]):[0-5]\d|noon|midnight)`;
const WINDOW_TEXT_RE = new RegExp(String.raw`(?<!\d)\d{1,2}(?::\d{2})?\s*(?:${MERIDIEM_TEXT})?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*${MERIDIEM_TEXT}(?![a-z])`, 'gi');
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const WEEKDAY_NAMES = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
const DATE_TEXT_RE = new RegExp(`\\b(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(?:(?:in|of)\\s+)?\\(?(\\d{4}|[’']?\\d{2})(?![\\d:]|\\s*(?:${MERIDIEM_TEXT}|[–—-]))\\)?)?`, 'gi');
const CLOCK_TIME_RE = new RegExp(String.raw`(?<![\d:])${EXACT_TIME_TEXT}(?![a-z\d:])`, 'gi');
const RELATIVE_APPOINTMENT_DATE_RE = /\b(?:tomorrow|tonight|next\s+(?:day|week|month))\b/gi;

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
  return problems;
}

// Every window, month-day, weekday, relative date, and exact clock time must
// match the typed report's authoritative appointment facts.
function nextVisitProblems(text, facts) {
  const problems = clockWindowProblems(text, facts);
  const expected = facts.nextVisit || {};
  const expectedDate = new RegExp(`^(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})$`, 'i')
    .exec(String(expected.date).trim());
  for (const match of String(text).matchAll(new RegExp(DATE_TEXT_RE.source, 'gi'))) {
    const [, , month, day, year] = match;
    const ok = expectedDate
      && month.toLowerCase() === expectedDate[2].toLowerCase()
      && Number(day) === Number(expectedDate[3])
      && !year;
    if (!ok) problems.push(`ungrounded_date:${match[0].trim()}`);
  }
  const [, expectedWeekday = ''] = expectedDate || [];
  for (const match of String(text).matchAll(new RegExp(`\\b(${WEEKDAY_NAMES})\\b`, 'gi'))) {
    if (match[1].toLowerCase() !== expectedWeekday.toLowerCase()) {
      problems.push(`ungrounded_weekday:${match[1]}`);
    }
  }
  for (const match of String(text).matchAll(new RegExp(RELATIVE_APPOINTMENT_DATE_RE.source, 'gi'))) {
    problems.push(`ungrounded_relative_date:${match[0].toLowerCase()}`);
  }
  return problems;
}

module.exports = { nextVisitProblems };
