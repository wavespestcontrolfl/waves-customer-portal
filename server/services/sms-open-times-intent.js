/**
 * When the texting AI's shadow drafter should look up OPEN TIMES, judged from the thread and not only from
 * the one inbound text, and which named day of the picker the customer asked about (texting AI gap 1, owner
 * 2026-11-26 "BUILD 1-6"). Pure and deterministic: no database read, no model call.
 *
 *   threadBookingIntent({ smsHistory, inboundMessage, inboundPhone, now })
 *     -> { carried, reason: 'prior_inbound' | 'staff_asked' | null, texts: string[], customerTexts: string[] }
 *   A short follow-up ("Anytime is fine", "Yes, please!", "Totally flexible") carries the booking talk of the
 *   thread: the customer's own earlier text asked to book or move a visit, or the last staff reply asked which
 *   day or time works. `texts` is that booking talk (the staff question and the
 *   customer's request before it): the drafter's job identity step reads it with the follow-up, so the times are sized
 *   for the job the thread named (Codex #8658 r1). `customerTexts` is the customer's own part, which the re-service
 *   lane decision reads. Only rows of this sender count: a reply sent to another contact on the account is skipped.
 *   Reminders, receipts and other automated texts never carry it (only the human reply
 *   types of sms-response-policy count), and a staff reply that asks nothing ends the booking talk.
 *
 *   namedDayMatcher(text)
 *     -> null | (dayLabel) => string[]
 *   The days the customer named ("Thursday", "Dec 3", "12/3", "the 19th"), matched against a picker day label
 *   ("Thursday, December 3"): the names that day answers. The drafter adds the first day the picker offers for
 *   each name, even past its first three days; the picker's own horizon still bounds it.
 */
const { hasRescheduleOrAwayIntent, isSmsReaction, outboundAsksForReply } = require('./sms-intent');
const { HUMAN_REPLY_TYPES } = require('./sms-response-policy');
const { phoneIdentityKey } = require('../utils/phone');

// The booking talk a follow-up can carry is recent: three days, and at most the last four earlier texts.
const THREAD_WINDOW_MS = 72 * 60 * 60 * 1000;
const THREAD_ROWS = 4;
// A follow-up is short. A long text says what it wants on its own (the webhook's own test judges it).
const FOLLOW_UP_MAX_CHARS = 160;
// The words of a reply to "what day works?" or "would Monday at 9 work?". Whole words only.
const FOLLOW_UP_RE = /\b(?:yes|yeah|yea|yep|yup|sure|ok|okay|k|please|pls|sounds good|that works|works|work for|fine|any ?time|any ?day|whenever|flexible|available|availability|free|open|either|prefer|better|earlier|later|asap|soon|soonest|first|next|morning|mornings|afternoon|afternoons|evening|after|before|between|week|weekend|am|pm)\b/i;
// Booking words. The customer's earlier text must carry one (or the reschedule / away test of sms-intent); a bare
// time word ("thanks for coming today") is not a booking ask. A staff question may carry one or any scheduling word.
const BOOKING_RE = /\b(?:availab\w*|slots?|time ?frame|reschedul\w*|book\w*|schedul\w*|appointment|appt|works? for you|good time|good day|what day|which day|what time|come (?:out|back|by|over)|when can you|can you come|another (?:day|time))\b/i;

// A staff question about booking or timing: a booking word, a named day or date, or a time of day. sms-intent's wide scheduling test
// is not used here: its "are you" makes "Are you still seeing ants?" a booking question (Codex pre-push r2). A greeting
// ("Good morning") is not a time of day.
const STAFF_TIME_RE = /\b(?:\d{1,2}(?::\d{2})?\s*(?:a\.?m\b\.?|p\.?m\b\.?)|(?<!good\s)(?:morning|afternoon|evening)|tomorrow|tonight|next week|come|stop by)/i;

// A short reply: reply words, or a bare day or date ("12/3", "Dec 3?") answering "what day works?".
function isFollowUpShape(text) {
  const body = String(text || '').trim();
  if (!body || body.length > FOLLOW_UP_MAX_CHARS || isSmsReaction(body)) return false;
  return FOLLOW_UP_RE.test(body.replace(/[\u2018\u2019]/g, "'")) || namedDayMatcher(body) !== null;
}

function isBookingAsk(body) {
  return BOOKING_RE.test(body) || hasRescheduleOrAwayIntent(body);
}

function isStaffBookingAsk(body) {
  return outboundAsksForReply(body) && (BOOKING_RE.test(body) || STAFF_TIME_RE.test(body) || namedDayMatcher(body) !== null);
}

// The thread rows before the current text, newest first, while they are recent: the current inbound text is often
// already the first row (the webhook logs it before drafting) and is skipped once, by its body; an unreadable or old
// row ends the list (the booking talk must be recent and provably so).
function priorRows(smsHistory, inboundMessage, cutoff) {
  const rows = (Array.isArray(smsHistory) ? smsHistory : []).filter((m) => m && typeof m.body === 'string' && m.body.trim());
  const current = String(inboundMessage || '').trim();
  const skip = rows.length && rows[0].direction === 'inbound' && rows[0].body.trim() === current ? 1 : 0;
  const recent = [];
  for (const row of rows.slice(skip, skip + THREAD_ROWS)) {
    const at = new Date(row.date).getTime();
    if (!Number.isFinite(at) || at < cutoff) break;
    recent.push(row);
  }
  return recent;
}

// Whose row it is: 'staff' (a human reply sent to this sender), 'customer' (this sender's own text), or 'skip' (an automated
// text, another contact's text, a reply sent to another contact on the same account, or a reply with no readable number).
function rowRole(row, sender) {
  if (row.direction === 'outbound') {
    if (!HUMAN_REPLY_TYPES.includes(row.type) || phoneIdentityKey(row.toPhone) !== sender) return 'skip';
    return 'staff';
  }
  return row.direction === 'inbound' && phoneIdentityKey(row.fromPhone) === sender ? 'customer' : 'skip';
}

// The same sender's texts before the staff question, back to the staff reply before it: the request the question answers
// ("Can you come out for the lawn?" -> "What day works?" -> "Anytime"), oldest first.
function exchangeCustomerTexts(rows, sender) {
  const texts = [];
  for (const row of rows) {
    const role = rowRole(row, sender);
    if (role === 'staff') break;
    if (role === 'customer') texts.unshift(row.body);
  }
  return texts;
}

function threadBookingIntent({ smsHistory, inboundMessage, inboundPhone, now = Date.now() } = {}) {
  const none = { carried: false, reason: null, texts: [], customerTexts: [] };
  const sender = phoneIdentityKey(inboundPhone);
  if (!sender || !isFollowUpShape(inboundMessage)) return none;
  const rows = priorRows(smsHistory, inboundMessage, (now instanceof Date ? now.getTime() : Number(now)) - THREAD_WINDOW_MS);
  for (const [i, row] of rows.entries()) {
    const role = rowRole(row, sender);
    // The first human reply to this sender decides: a booking question carries the follow-up, anything else ends the talk.
    if (role === 'staff') {
      if (!isStaffBookingAsk(row.body)) return none;
      const customerTexts = exchangeCustomerTexts(rows.slice(i + 1), sender);
      return { carried: true, reason: 'staff_asked', texts: [...customerTexts, row.body], customerTexts };
    }
    if (role === 'customer' && isBookingAsk(row.body)) return { carried: true, reason: 'prior_inbound', texts: [row.body], customerTexts: [row.body] };
  }
  return none;
}

const WEEKDAY_RE = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b|\b(tues?|weds?|thu|thur|thurs|fri)\b\.?/gi;
const WEEKDAY_ABBREV = { tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', weds: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
const NUMERIC_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g;
const ORDINAL_RE = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;
// "Thursday, December 3" (availability.js fullDate and the scheduler's day label).
const LABEL_RE = /^([A-Za-z]+),\s+([A-Za-z]+)\s+(\d{1,2})$/;

function parseLabel(label) {
  const m = LABEL_RE.exec(String(label || '').trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  return month < 0 ? null : { weekday: m[1].toLowerCase(), month: month + 1, day: Number(m[3]) };
}

function namedDaysIn(text) {
  const body = String(text || '');
  const weekdays = new Set();
  const dates = [];
  const daysOfMonth = new Set();
  for (const m of body.matchAll(WEEKDAY_RE)) weekdays.add(m[1] ? m[1].toLowerCase() : WEEKDAY_ABBREV[m[2].toLowerCase()]);
  for (const m of body.matchAll(MONTH_DAY_RE)) {
    const month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3))) + 1;
    dates.push({ month, day: Number(m[2]) });
  }
  for (const m of body.matchAll(NUMERIC_DATE_RE)) dates.push({ month: Number(m[1]), day: Number(m[2]) });
  for (const m of body.matchAll(ORDINAL_RE)) daysOfMonth.add(Number(m[1]));
  return { weekdays, dates: dates.filter((d) => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31), daysOfMonth };
}

function namedDayMatcher(text) {
  const named = namedDaysIn(text);
  if (!named.weekdays.size && !named.dates.length && !named.daysOfMonth.size) return null;
  // The names a picker day answers ([] = none): one key per name, so "Thursday or Friday" wants one day of each.
  return (label) => {
    const day = parseLabel(label);
    if (!day) return [];
    return [
      ...(named.weekdays.has(day.weekday) ? [`weekday:${day.weekday}`] : []),
      ...named.dates.filter((d) => d.month === day.month && d.day === day.day).map((d) => `date:${d.month}/${d.day}`),
      ...(named.daysOfMonth.has(day.day) ? [`day:${day.day}`] : []),
    ];
  };
}

module.exports = {
  threadBookingIntent,
  namedDayMatcher,
  _internals: { isFollowUpShape, priorRows, parseLabel, namedDaysIn, THREAD_WINDOW_MS, THREAD_ROWS },
};
