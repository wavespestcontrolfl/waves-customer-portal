// Shared validation for model-written appointment copy. The typed-report
// narrative validates every date/window because all temporal facts in that
// lane are the next visit. The pest recap wrapper uses appointmentClaimProblems
// so unrelated work dates and aftercare times remain valid prose.

const WINDOW_TEXT_RE = /\b\d{1,2}(?::\d{2})?\s*(?:AM|PM)?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b/gi;
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const WEEKDAY_NAMES = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
const DATE_TEXT_RE = new RegExp(`\\b(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})\\b(?:,?\\s+(\\d{4}))?`, 'gi');
const APPOINTMENT_CLAIM_RE = new RegExp(
  `\\b(?:(?:(?:your|the)\\s+)?(?:next|upcoming)\\s+(?:visit|appointment|service)(?:\\s*:\\s*|\\s+(?:is|has\\s+been|will\\s+be|scheduled|booked|set|on|for)\\b)|(?:we(?:\\s+will|[’']ll)?\\s+)?see\\s+you\\b|we(?:\\s+will|[’']ll)\\s+(?:return|arrive|be\\s+back)\\b|(?:appointment|visit|follow[-\\s]?up)\\s+(?:is\\s+)?(?:scheduled|booked|set)\\b)`,
  'i',
);

function normalizeWindowText(value) {
  return String(value || '').replace(/[–—-]/g, '–').replace(/\s+/g, ' ').trim().toUpperCase();
}

// Any arrival-window or month-day mention must match the supplied next visit
// exactly (weekday too, when written). Standalone weekdays and clock times are
// checked as well so a reformatted claim cannot flip the day or meridiem.
function nextVisitProblems(text, facts) {
  const problems = [];
  const expected = facts.nextVisit || {};
  const expectedWindow = normalizeWindowText(expected.window);
  for (const match of String(text).matchAll(new RegExp(WINDOW_TEXT_RE.source, 'gi'))) {
    if (normalizeWindowText(match[0]) !== expectedWindow) {
      problems.push(`ungrounded_window:${match[0].trim()}`);
    }
  }
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
  // Check weekday words once, including those already inside a dated claim.
  const [, expectedWeekday = ''] = expectedDate || [];
  for (const match of String(text).matchAll(new RegExp(`\\b(${WEEKDAY_NAMES})\\b`, 'gi'))) {
    if (match[1].toLowerCase() !== expectedWeekday.toLowerCase()) {
      problems.push(`ungrounded_weekday:${match[1]}`);
    }
  }
  const allowedTimes = new Set();
  const win = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*–\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/.exec(expectedWindow);
  if (win) {
    const [, startHour, startMinute = '00', startMeridiem, endHour, endMinute = '00', endMeridiem] = win;
    allowedTimes.add(`${Number(startHour)}:${startMinute} ${startMeridiem || endMeridiem}`);
    allowedTimes.add(`${Number(endHour)}:${endMinute} ${endMeridiem}`);
  }
  const withoutRanges = String(text).replace(new RegExp(WINDOW_TEXT_RE.source, 'gi'), ' ');
  for (const match of withoutRanges.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/gi)) {
    const normalized = `${Number(match[1])}:${match[2] || '00'} ${match[3].toUpperCase()}`;
    if (!allowedTimes.has(normalized)) problems.push(`ungrounded_time:${match[0].trim()}`);
  }
  return problems;
}

function appointmentClaimProblems(text, facts) {
  const claims = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      const marker = APPOINTMENT_CLAIM_RE.exec(sentence);
      return marker ? sentence.slice(marker.index) : '';
    })
    .filter(Boolean)
    .join(' ');
  if (!claims) return facts?.nextVisit?.date ? ['missing_appointment_claim'] : [];
  if (!facts?.nextVisit?.date) return ['ungrounded_appointment_claim'];

  const problems = nextVisitProblems(claims, facts);
  if (!claims.toLowerCase().includes(String(facts.nextVisit.date).toLowerCase())) {
    problems.push('unsupported_appointment_date');
  }
  if (facts.nextVisit.window
    && !normalizeWindowText(claims).includes(normalizeWindowText(facts.nextVisit.window))) {
    problems.push('unsupported_appointment_window');
  }
  return [...new Set(problems)];
}

module.exports = { nextVisitProblems, appointmentClaimProblems };
