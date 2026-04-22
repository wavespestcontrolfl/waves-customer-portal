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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { hasSchedulingIntent };
