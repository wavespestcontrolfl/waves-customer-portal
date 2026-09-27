// Shared validation for model-written appointment copy. The typed-report
// narrative validates every date/window because all temporal facts in that
// lane are the next visit. The pest recap wrapper uses appointmentClaimProblems
// so unrelated work dates and aftercare times remain valid prose.

const MERIDIEM_TEXT = String.raw`[ap]\.?m\.?`;
const WINDOW_TEXT_RE = new RegExp(String.raw`(?<!\d)\d{1,2}(?::\d{2})?\s*(?:${MERIDIEM_TEXT})?\s*[–—-]\s*\d{1,2}(?::\d{2})?\s*${MERIDIEM_TEXT}(?![a-z])`, 'gi');
const MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
const WEEKDAY_NAMES = 'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday';
const DATE_TEXT_RE = new RegExp(`\\b(?:(${WEEKDAY_NAMES}),?\\s+)?(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(?:(?:in|of)\\s+)?\\(?(\\d{4}|[’']?\\d{2})(?![\\d:]|\\s*(?:${MERIDIEM_TEXT}|[–—-]))\\)?)?`, 'gi');
// A separately dated future return/arrival is an appointment claim regardless
// of who the sentence names. Start at the future action rather than maintaining
// a technician/crew/specialist subject list. Window-only restatements remain
// part of the grounded appointment copy and do not create a duplicate claim.
const FUTURE_DATED_APPOINTMENT_ACTION = String.raw`(?:will|[’']ll)\s+(?:(?:not|never)\s+)?(?:return|arrive|be\s+back|come\s+back|check\s+back|follow[-\s]+up)\b(?=[^\n.!?]{0,80}\b(?:(?:on|for|by)\s+)?(?:${WEEKDAY_NAMES}|${MONTH_NAMES}|today|tomorrow|next\s+(?:day|week|month)|\d{1,2}\s*[/-]\s*\d{1,2})\b)`;
const APPOINTMENT_CLAIM_RE = new RegExp(
  `\\b(?:(?:(?:your|the)\\s+)?(?:next|upcoming)\\s+(?:visit|appointment|service|follow[-\\s]?up)(?:\\s*:\\s*|\\s+(?:is|has\\s+been|will\\s+be|scheduled|booked|set|on|for)\\b)|(?:we(?:\\s+will|[’']ll)?\\s+)?see\\s+you\\b|we(?:\\s+will|[’']ll)\\s+(?:return|arrive|be\\s+back|come\\s+back|check\\s+back|follow[-\\s]+up)\\b|${FUTURE_DATED_APPOINTMENT_ACTION}|(?:(?:your|the|our|estimated)\\s+)?arrival(?:\\s+(?:time|window))?(?:\\s*:\\s*|\\s+(?:is|will\\s+be|at|on)\\b)|(?:appointment|visit|follow[-\\s]?up)\\s+(?:is\\s+)?(?:scheduled|booked|set)\\b)`,
  'i',
);
const CLOCK_TIME_RE = new RegExp(String.raw`(?<!\d)\d{1,2}(?::\d{2})?\s*${MERIDIEM_TEXT}(?![a-z])`, 'gi');
const NON_AFFIRMATIVE_APPOINTMENT_RE = /\b(?:is|has\s+been|will\s+be)\s+(?:not|never)\b|\b(?:not|never)\s+(?:scheduled|booked|set)\b|\bno\s+longer\s+(?:scheduled|booked|set)\b|\b(?:will|[’']ll)\s+(?:not|never)\s+(?:return|arrive|be\s+back|come\s+back|check\s+back|follow[-\s]+up)\b|\bcancell?ed\b/i;
// Exempt one short aftercare instruction ending in an until-time. Never cross
// a clause boundary, appointment action, or earlier clock time: those signals
// must remain visible to the temporal validator even when the sentence starts
// with an instruction verb ("Leave the gate open ... who will arrive at 8 PM").
const AFTERCARE_APPOINTMENT_ACTION = String.raw`(?:arriv(?:e|es|ed|ing|al)|(?:will|[’']ll)\s+(?:return|be\s+back|come\s+back|check\s+back|follow[-\s]+up))`;
const AFTERCARE_TIME_RE = new RegExp(
  String.raw`\b(?:keep|leave|avoid|do not)\b(?:(?!\b${AFTERCARE_APPOINTMENT_ACTION}\b|\d{1,2}(?::\d{2})?\s*${MERIDIEM_TEXT}(?![a-z]))[^\n,.!?;]){1,100}?\buntil\s+\d{1,2}(?::\d{2})?\s*${MERIDIEM_TEXT}(?![a-z])`,
  'gi',
);

function maskAftercareTimes(text) {
  const source = String(text || '');
  return source.replace(new RegExp(AFTERCARE_TIME_RE.source, 'gi'), (instruction, offset) => {
    // A comma or semicolon can introduce an arrival continuation. Inspect the
    // rest of this sentence after the complete meridiem (including a.m./p.m.'s
    // final dot) before deciding that the clock belongs only to aftercare.
    if (/\b\d{1,2}(?::\d{2})?\s*[ap]m\.$/i.test(instruction)) return ' ';
    const continuation = source.slice(offset + instruction.length).match(/^[^\n.!?]{0,80}/)?.[0] || '';
    const action = new RegExp(`\\b${AFTERCARE_APPOINTMENT_ACTION}\\b`, 'i').exec(continuation);
    const groundedClaim = new RegExp(APPOINTMENT_CLAIM_RE.source, 'i').exec(continuation);
    return action && (!groundedClaim || action.index < groundedClaim.index)
      ? instruction
      : ' ';
  });
}

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

// Any arrival-window or month-day mention must match the supplied next visit
// exactly (weekday too, when written). Standalone weekdays and clock times are
// checked as well so a reformatted claim cannot flip the day or meridiem.
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
  // Check weekday words once, including those already inside a dated claim.
  const [, expectedWeekday = ''] = expectedDate || [];
  for (const match of String(text).matchAll(new RegExp(`\\b(${WEEKDAY_NAMES})\\b`, 'gi'))) {
    if (match[1].toLowerCase() !== expectedWeekday.toLowerCase()) {
      problems.push(`ungrounded_weekday:${match[1]}`);
    }
  }
  return problems;
}

function appointmentClaimProblems(text, facts) {
  const source = String(text || '');
  // Clock and window promises are precise regardless of who the writer names
  // as the subject. Screen the full output rather than expanding a list of
  // technician/crew/agent aliases. Only the established aftercare forms may
  // carry a separate clock time in a pest recap.
  const withoutAftercareTimes = maskAftercareTimes(source);
  const temporalProblems = clockWindowProblems(withoutAftercareTimes, facts);
  const claims = source
    // A dotted meridiem can precede more of the same appointment claim.
    .split(/(?<!\b[ap]\.m\.)(?<=[.!?])\s+/i)
    .flatMap((sentence) => {
      const markers = [...sentence.matchAll(new RegExp(APPOINTMENT_CLAIM_RE.source, 'gi'))];
      return markers.map((marker, index) => sentence.slice(
        marker.index,
        markers[index + 1]?.index ?? sentence.length,
      ).trim());
    });
  if (!claims.length) {
    return [...new Set([
      ...temporalProblems,
      ...(facts?.nextVisit?.date ? ['missing_appointment_claim'] : []),
    ])];
  }
  if (!facts?.nextVisit?.date) return [...new Set([...temporalProblems, 'ungrounded_appointment_claim'])];

  const problems = [
    ...temporalProblems,
    ...(claims.length > 1 ? ['duplicate_appointment_claim'] : []),
  ];
  for (const claim of claims) {
    // Recaps can append a separate aftercare instruction to the appointment
    // sentence. Keep that exception here: typed reports validate every time.
    const appointmentCopy = maskAftercareTimes(claim);
    problems.push(...nextVisitProblems(appointmentCopy, facts));
    if (NON_AFFIRMATIVE_APPOINTMENT_RE.test(claim)) problems.push('negated_appointment_claim');
    if (!claim.toLowerCase().includes(String(facts.nextVisit.date).toLowerCase())) {
      problems.push('unsupported_appointment_date');
    }
    if (facts.nextVisit.window
      && !normalizeWindowText(claim).includes(normalizeWindowText(facts.nextVisit.window))) {
      problems.push('unsupported_appointment_window');
    }
  }
  return [...new Set(problems)];
}

module.exports = { nextVisitProblems, appointmentClaimProblems };
