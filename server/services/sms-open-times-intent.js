/**
 * Which named day of the picker the customer asked about, for the texting AI's shadow drafter (texting AI gap 1, owner
 * 2026-11-26 "BUILD 1-6"). Pure and deterministic: no database read, no model call.
 *
 *   namedDayMatcher(text)
 *     -> null | (dayLabel) => string[]
 *   The days the customer named ("Thursday", "Dec 3", "12/3", "the 19th"), matched against a picker day label
 *   ("Thursday, December 3"): the names that day answers. The drafter adds the first day the picker offers for
 *   each name, even past its first three days; the picker's own horizon still bounds it.
 */
const { dateOnlyString } = require('../utils/date-only');

const WEEKDAY_RE = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b|\b(tues?|weds?|thu|thur|thurs|fri)\b\.?/gi;
const WEEKDAY_ABBREV = { tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', weds: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/gi;
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g;
const ORDINAL_RE = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;
// "Thursday, December 3" (availability.js fullDate and the scheduler's day label).
const LABEL_RE = /^([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2})$/;
// A weekday right before its date ("Thursday Dec 10", "Thu, 12/10", "Friday the 11th") is one day, not two.
const PAIR_GAP_RE = /^[\s,]*$/;

function parseLabel(label) {
  const m = LABEL_RE.exec(String(label || '').trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  return month < 0 ? null : { weekday: m[1].toLowerCase(), month: month + 1, day: Number(m[3]) };
}

const fullYear = (raw) => (raw ? (raw.length === 2 ? 2000 + Number(raw) : Number(raw)) : null);

// Every day or date token in the text, in text order: { start, end, weekday } or { start, end, month?, day, year? }.
function dayTokens(body) {
  const tokens = [];
  const at = (m, fields) => tokens.push({ start: m.index, end: m.index + m[0].length, ...fields });
  for (const m of body.matchAll(WEEKDAY_RE)) at(m, { weekday: m[1] ? m[1].toLowerCase() : WEEKDAY_ABBREV[m[2].toLowerCase()] });
  for (const m of body.matchAll(MONTH_DAY_RE)) {
    at(m, { month: MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3))) + 1, day: Number(m[2]), year: fullYear(m[3]) });
  }
  for (const m of body.matchAll(NUMERIC_DATE_RE)) at(m, { month: Number(m[1]), day: Number(m[2]), year: fullYear(m[3]) });
  for (const m of body.matchAll(ORDINAL_RE)) at(m, { day: Number(m[1]) });
  return tokens
    .filter((t) => t.weekday || ((t.month === undefined || (t.month >= 1 && t.month <= 12)) && t.day >= 1 && t.day <= 31))
    .sort((a, b) => a.start - b.start);
}

function requestKey(r) {
  const date = r.month ? `date:${r.month}/${r.day}${r.year ? `/${r.year}` : ''}` : (r.day ? `day:${r.day}` : '');
  return [r.weekday ? `weekday:${r.weekday}` : '', date].filter(Boolean).join('+');
}

// The days the customer asked for, each one request: a weekday, a date (month and day, maybe a year), a day of the month,
// or a weekday paired with the date right after it.
function namedDaysIn(text) {
  const body = String(text || '');
  const tokens = dayTokens(body);
  const requests = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const next = tokens[i + 1];
    const paired = t.weekday && next && !next.weekday && PAIR_GAP_RE.test(body.slice(t.end, next.start));
    const r = paired ? { ...next, weekday: t.weekday } : t;
    if (paired) i += 1;
    requests.set(requestKey(r), r);
  }
  return [...requests.entries()].map(([key, r]) => ({ key, weekday: r.weekday || null, month: r.month || null, day: r.day || null, year: r.year || null }));
}

// A picker day answers a request when every part the customer gave matches. A year is checked against the day's ISO date; a
// day with no readable ISO date never answers a request with a year.
function answers(r, day, isoYear) {
  return (!r.weekday || r.weekday === day.weekday)
    && (!r.month || r.month === day.month)
    && (!r.day || r.day === day.day)
    && (!r.year || r.year === isoYear);
}

function namedDayMatcher(text) {
  const requests = namedDaysIn(text);
  if (!requests.length) return null;
  // The requests a picker day answers ([] = none): one key per request, so "Thursday or Friday" wants one day of each.
  return (label, isoDate = null) => {
    const day = parseLabel(label);
    if (!day) return [];
    const ymd = dateOnlyString(isoDate);
    const isoYear = ymd ? Number(ymd.slice(0, 4)) : null;
    return requests.filter((r) => answers(r, day, isoYear)).map((r) => r.key);
  };
}

const THREAD_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const THREAD_MAX_TURNS = 4;
const FOLLOWUP_MAX_CHARS = 90;
const FOLLOWUP_MAX_WORDS = 14;

const CONFIRMED_OUTBOUND_STATUSES = new Set(['sent', 'delivered']);
const HUMAN_OUTBOUND_TYPES = new Set(['', 'manual', 'ai_approved', 'ai_revised', 'sms_agent', 'staff_reply']);

const NON_SCHEDULING_ADMIN_TOPIC_RE = /\b(?:invoice|bill(?:ing)?|pay(?:ment|ing|ed)?|card|charge|charged|zelle|autopay|receipt|refund|credit|email(?:ed|ing)?|cancel(?:l?ed|l?ing|lation)?|complain(?:t|ing)?|unhappy|upset|price|pricing|quote|cost|estimate|how much|gate\s*code|lock\s*box|stop|unsubscribe|opt\s*out|pet\s*safe)\b/i;

const PEST_REPORT_TOPIC_RE = /\b(?:ants?|roach(?:es)?|spider|termite|wasp|bee|flea|tick|rat|mice|mouse|rodent|mosquito|weed|fungus|brown\s+patch)\b/i;

const FOLLOWUP_SCHEDULING_REPLY_RE = /\b(?:any\s*time|anytime|flexible|whenever|either(?:\s+(?:one|works|day|time))?|wide\s+open|open\s+(?:all|any|this|next)|works?\s+for\s+me|that\s+works|sounds\s+good|yes\s+please|mornings?|afternoons?|before\s+noon|after\s+lunch|next\s+week|this\s+week|earlier|later|sooner|first\s+thing|in\s+the\s+a\.?m\.?|in\s+the\s+p\.?m\.?|a\.m\.|p\.m\.|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i;

const STAFF_SCHEDULING_QUESTION_RE = /(?:\b(?:what|which)\s+(?:day|days|time|times|window)\b|\b(?:morning|afternoon)\s+or\s+(?:morning|afternoon)\b|\b(?:when|what\s+day|what\s+time)\b[^.?!]{0,45}\b(?:work|best|good|prefer|come\s+out|schedule|reschedule|move|book)\b|\b(?:would\s+you\s+like|do\s+you\s+want|want\s+me)\s+to\s+(?:schedule|reschedule|move|book)\b|\b(?:let\s+(?:us|me)\s+know)\b[^.?!]{0,45}\b(?:day|time|morning|afternoon|when|works)\b)/i;

const STAFF_EXPLICIT_VISIT_SUBJECT_RE = /\b(?:visit|appointment|service|tech|technician|come\s+out|pest|lawn|mosquito|treatment|spray)\b/i;

const NON_APPOINTMENT_SUBJECT_RE = /\b(?:phone\s*call|call\s+you|give\s+you\s+a\s+call|call\s+back|callback|quick\s+call|speak\s+by\s+phone|talk\s+on\s+the\s+phone|invoice|bill(?:ing)?|payment|charge|refund|card\s+on\s+file|autopay)\b/i;

const CUSTOMER_WITHDRAWAL_RE = /\b(?:never\s*mind|nevermind|forget\s+it|disregard|keep\s+(?:my|our|the)\s+(?:visit|appointment|time|slot|date|schedule)|leave\s+it(?:\s+as\s+is)?|don'?t\s+(?:move|change|reschedule|worry\s+about\s+it)|no\s+need|we'?re\s+good|all\s+good|i'?m\s+good)\b/i;

const CUSTOMER_SCHEDULING_ASK_RE = /\b(?:reschedule|rebook|schedule|book\s+(?:a|an|my|our)|move\s+(?:my|the|our)|change\s+(?:my|the|our)\s+(?:appointment|visit|day|time)|openings?|available|availability|when\s+can\s+(?:you|someone|a\s+tech)\s+come|come\s+out\s+(?:next|this|on|sooner|earlier))\b/i;

function lastTenDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

function isShortSchedulingFollowUp(text) {
  const clean = String(text || '').trim();
  if (!clean || clean.length > FOLLOWUP_MAX_CHARS) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length > FOLLOWUP_MAX_WORDS) return false;
  if (CUSTOMER_WITHDRAWAL_RE.test(clean)) return false;
  if (NON_SCHEDULING_ADMIN_TOPIC_RE.test(clean) || PEST_REPORT_TOPIC_RE.test(clean)) return false;
  return FOLLOWUP_SCHEDULING_REPLY_RE.test(clean) || namedDaysIn(clean).length > 0;
}

function isEligibleThreadTurn(row, sender10, nowMs, currentBodyNorm) {
  if (!row || !row.body || !row.date) return false;
  const ts = new Date(row.date).getTime();
  if (!Number.isFinite(ts) || ts > nowMs || nowMs - ts > THREAD_LOOKBACK_MS) return false;
  const bodyNorm = String(row.body).trim().toLowerCase();
  if (!bodyNorm) return false;

  if (row.direction === 'inbound') {
    if (lastTenDigits(row.fromPhone) !== sender10) return false;
    // Skip echo of the current inbound text itself if already written to sms_log.
    if (bodyNorm === currentBodyNorm && nowMs - ts < 120000) return false;
    return true;
  }

  if (row.direction === 'outbound') {
    if (lastTenDigits(row.toPhone) !== sender10) return false;
    if (!CONFIRMED_OUTBOUND_STATUSES.has(String(row.status || '').toLowerCase())) return false;
    const msgType = String(row.type || '').trim().toLowerCase();
    return HUMAN_OUTBOUND_TYPES.has(msgType);
  }

  return false;
}

function isCustomerAppointmentAsk(body) {
  const clean = String(body || '');
  if (!CUSTOMER_SCHEDULING_ASK_RE.test(clean)) return false;
  if (NON_APPOINTMENT_SUBJECT_RE.test(clean)) return false;
  if (CUSTOMER_WITHDRAWAL_RE.test(clean)) return false;
  if (NON_SCHEDULING_ADMIN_TOPIC_RE.test(clean)) return false;
  return true;
}

function isCustomerTopicBarrier(text) {
  return (
    CUSTOMER_WITHDRAWAL_RE.test(text)
    || NON_APPOINTMENT_SUBJECT_RE.test(text)
    || NON_SCHEDULING_ADMIN_TOPIC_RE.test(text)
    || PEST_REPORT_TOPIC_RE.test(text)
  );
}

function isContinuingStaffQuestion(recent, idx) {
  const body = String(recent[idx]?.body || '');
  if (!isStaffAppointmentQuestion(body)) return false;
  return STAFF_EXPLICIT_VISIT_SUBJECT_RE.test(body) || !precedingCustomerIsNonAppointment(recent, idx);
}

function collectCurrentCustomerTurns(recent, startIdx) {
  const collected = [];
  for (let j = startIdx; j < recent.length && collected.length < 3; j += 1) {
    // Continue through preceding staff scheduling questions in the same active
    // thread so multi-turn exchanges preserve the requested service, while
    // stopping at any staff closure, non-appointment question, withdrawal, or
    // topic switch.
    if (recent[j].direction === 'outbound') {
      if (isContinuingStaffQuestion(recent, j)) continue;
      break;
    }
    const text = String(recent[j].body).trim();
    if (isCustomerAppointmentAsk(text)) {
      collected.push(text);
      continue;
    }
    if (isCustomerTopicBarrier(text)) break;
    collected.push(text);
  }
  return collected.reverse();
}

function isStaffAppointmentQuestion(body) {
  const clean = String(body || '');
  if (!STAFF_SCHEDULING_QUESTION_RE.test(clean)) return false;
  if (NON_APPOINTMENT_SUBJECT_RE.test(clean)) return false;
  return true;
}

function precedingCustomerIsNonAppointment(recent, staffIdx) {
  const prev = recent[staffIdx + 1];
  if (!prev || prev.direction !== 'inbound') return false;
  const text = String(prev.body || '');
  return NON_APPOINTMENT_SUBJECT_RE.test(text) || NON_SCHEDULING_ADMIN_TOPIC_RE.test(text);
}

/**
 * Pure, deterministic multi-turn SMS thread continuity for short scheduling
 * follow-ups ("Anytime works", "Tuesday afternoon", "Morning is best").
 * Enforces strict same-sender phone isolation, confirmed sent/delivered staff
 * replies, automated-message skipping, withdrawal/topic-change barriers, and
 * thread-close detection.
 */
function threadSchedulingFollowUp({ inboundMessage, inboundPhone, smsHistory, now = new Date() } = {}) {
  if (!isShortSchedulingFollowUp(inboundMessage)) {
    return { carried: false, reason: 'not_short_followup', anchorText: '' };
  }
  const sender10 = lastTenDigits(inboundPhone);
  if (!sender10) {
    return { carried: false, reason: 'no_sender_phone', anchorText: '' };
  }

  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) {
    return { carried: false, reason: 'invalid_now', anchorText: '' };
  }
  const currentBodyNorm = String(inboundMessage || '').trim().toLowerCase();

  const recent = (Array.isArray(smsHistory) ? smsHistory : [])
    .filter((row) => isEligibleThreadTurn(row, sender10, nowMs, currentBodyNorm))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, THREAD_MAX_TURNS);

  for (let i = 0; i < recent.length; i += 1) {
    const turn = recent[i];
    if (turn.direction === 'outbound') {
      if (isStaffAppointmentQuestion(turn.body)) {
        if (!STAFF_EXPLICIT_VISIT_SUBJECT_RE.test(String(turn.body || '')) && precedingCustomerIsNonAppointment(recent, i)) {
          return { carried: false, reason: 'non_appointment_subject', anchorText: '' };
        }
        const priorCustomer = collectCurrentCustomerTurns(recent, i + 1);
        const anchorText = [...priorCustomer, `Staff asked: ${String(turn.body).trim()}`].join('\n');
        return { carried: true, reason: 'staff_scheduling_question', anchorText };
      }
      return { carried: false, reason: 'staff_closed_thread', anchorText: '' };
    }
    if (isCustomerAppointmentAsk(turn.body)) {
      return { carried: true, reason: 'prior_customer_booking_ask', anchorText: String(turn.body).trim() };
    }
    if (isCustomerTopicBarrier(turn.body)) {
      return { carried: false, reason: 'customer_changed_topic', anchorText: '' };
    }
  }

  return { carried: false, reason: 'no_thread_booking_context', anchorText: '' };
}

function resolveThreadSchedulingContext({
  frozen,
  liveOpenTimes,
  directTimesAsked,
  realAnswersOn,
  continuityOn,
  inboundMessage,
  inboundPhone,
  context,
  asOf,
} = {}) {
  if (frozen || !liveOpenTimes || !realAnswersOn || !continuityOn) {
    return { timesAsked: Boolean(directTimesAsked), carried: false, reason: null, carryReason: null, anchorText: '' };
  }
  const now = asOf instanceof Date ? asOf : new Date();
  const out = threadSchedulingFollowUp({
    inboundMessage,
    inboundPhone,
    smsHistory: context?.smsHistory,
    now,
  });
  const carried = Boolean(!directTimesAsked && out.carried);
  return {
    ...out,
    carried,
    carryReason: carried ? out.reason : null,
    anchorText: out.carried ? out.anchorText : '',
    timesAsked: Boolean(directTimesAsked || out.carried),
  };
}

function buildThreadIdentityInput(threadFollowUp, inboundMessage) {
  if (threadFollowUp?.anchorText) {
    return `${threadFollowUp.anchorText}\nCustomer follow-up: ${inboundMessage}`;
  }
  return inboundMessage;
}

function disambiguateThreadIdentity(threadFollowUp, identity, context, openEstimate) {
  if ((!threadFollowUp?.carried && !threadFollowUp?.anchorText) || !identity?.certain) return identity;
  const fallbackReasons = new Set(['single_upcoming', 'engine_default', 'last_completed', 'next_of_series', 'open_estimate']);
  if (!fallbackReasons.has(identity.reason)) return identity;
  const serviceTypes = new Set(
    (context?.upcomingServices || [])
      .map((s) => String(s?.type || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const hasOpenEstimate = Boolean(openEstimate || context?.pendingEstimate);
  if (serviceTypes.size > 1 || (hasOpenEstimate && identity.reason !== 'open_estimate')) {
    return { serviceType: null, certain: false, reason: 'thread_ambiguous' };
  }
  return identity;
}

function effectiveSchedulingIntent(directSchedulingIntent, openTimesStamp) {
  return Boolean(directSchedulingIntent || openTimesStamp?.open_times_from_thread);
}

module.exports = {
  namedDayMatcher,
  threadSchedulingFollowUp,
  resolveThreadSchedulingContext,
  buildThreadIdentityInput,
  disambiguateThreadIdentity,
  effectiveSchedulingIntent,
  _internals: { parseLabel, namedDaysIn, isShortSchedulingFollowUp, lastTenDigits },
};
