/**
 * The booking exchange a short reply answers, for the texting AI's shadow drafter (texting AI gap 1, owner 2026-11-26
 * "BUILD 1-6"), and which named day of the picker the customer asked about. Pure and deterministic: no database read,
 * no model call.
 *
 *   bookingExchange({ smsHistory, currentSmsLogId, inboundMessage, inboundPhone })
 *     -> null | { staffText, customerTexts: string[] }
 *   One rule, built once: the history is cut at the row of the text being drafted (currentSmsLogId), so a later row
 *   never reads as what the text answers. Walking back from there: this sender's own texts, up to the latest human
 *   staff text within 72 hours of the drafted text: the first outbound row must be a person's send (manual, ai_approved,
 *   ai_revised) from the Waves line the customer texted to this sender, or nothing is carried. It is an exchange only when that staff text
 *   asks the customer's availability or proposes a visit in an explicit form ("what day works", "when works for you",
 *   "would Thursday work", "are you available", "we can come Monday", "I have Tuesday at 9 open"); a day or time
 *   mentioned alone never counts. The drafted text must be a short reply (a yes, timing words, a day or a date).
 *   customerTexts = this sender's texts after the staff text, oldest first, the drafted text last.
 *   Fail closed (null): no sender phone, the drafted row not in the history or with no Waves line, an unreadable date,
 *   another number's text (or this customer's text to another line) inside the exchange, any automated or AI assistant
 *   text inside it, no staff text in the window, or a staff text that does not ask.
 *
 *   namedDayMatcher(text)
 *     -> null | (dayLabel) => string[]
 *   The days the customer named ("Thursday", "Dec 3", "12/3", "the 19th"), matched against a picker day label
 *   ("Thursday, December 3"): the names that day answers. The drafter adds the first day the picker offers for
 *   each name, even past its first three days; the picker's own horizon still bounds it.
 */
const { isSmsReaction } = require('./sms-intent');
const { phoneIdentityKey } = require('../utils/phone');

// A text a person at Waves sent: typed, or an AI draft a person approved or revised. The AI assistant's own sends and every
// automated text (reminders, receipts) are not.
const STAFF_SENT_TYPES = new Set(['manual', 'ai_approved', 'ai_revised']);
const EXCHANGE_WINDOW_MS = 72 * 60 * 60 * 1000;
// At most this many rows are walked back from the drafted text (the context holds 20).
const EXCHANGE_MAX_ROWS = 8;
// A reply is short. A long text says what it wants on its own (the webhook's own test judges it).
const REPLY_MAX_CHARS = 160;
// A reply opens with a yes, or answers with timing words, a day or a date. A new request that merely contains a polite word
// ("Please email my receipt") is neither.
const AFFIRM_START_RE = /^\W*(?:yes|yeah|yea|yep|yup|sure|ok|okay|k|sounds good|that works|perfect|great|absolutely|definitely)\b/i;
const TIMING_ANSWER_RE = /\b(?:any ?time|any ?day|whenever|flexible|available|availability|either (?:day|one|time)|prefer|better|earlier|later|asap|soonest|mornings?|afternoons?|evenings?|after \d|before \d|between \d|next week|this week|weekends?|\d{1,2}(?::\d{2})?\s*(?:am|pm)|that'?s fine|that is fine|fine (?:by|with) me|works? for (?:me|us)|works)\b/i;
// The explicit forms of a staff text that asks availability or proposes a visit. Nothing else carries a reply: a day,
// a time or "are you ..." alone ("Did you see ants after Thursday's treatment?", "Are you still seeing ants?") never does.
const DAY_OR_TIME = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|this (?:week|morning|afternoon|evening)|next week|(?:in the )?(?:morning|afternoon|evening)|\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)|\\d{1,2}/\\d{1,2})';
const STAFF_ASKS_RE = [
  /\b(?:what|which) (?:days?|times?|dates?)(?: of (?:the )?week)? (?:works?|would work|is good|are good|is best|is better|suits?|do you prefer|would you prefer|would you like)\b/i,
  /\bwhen (?:works|would work|is good|is best|is a good time|are you (?:available|free|home))\b/i,
  /\b(?:are|would|will) you (?:be )?(?:available|free|home)\b/i,
  /\bwhat(?:'s| is) your availability\b/i,
  /\blet (?:me|us) know (?:what|which|when)\b[^.?!]*\b(?:day|time|works?)\b/i,
  new RegExp(`\\b(?:would|does|do|will|could|can) (?:${DAY_OR_TIME}|this|that|it|either)(?: [\\w':]+){0,3} work\\b`, 'i'),
  new RegExp(`\\b(?:we|i) (?:can|could) (?:come|stop|swing) (?:out |by |over |back )?(?:on )?${DAY_OR_TIME}`, 'i'),
  new RegExp(`\\b(?:we|i) (?:have|got) (?:an? )?(?:opening|spot|slot)s?\\b|\\b(?:we|i) (?:have|got) [^.?!]{0,30}${DAY_OR_TIME}[^.?!]{0,20}\\b(?:open|available)\\b`, 'i'),
];

function staffAsksAvailability(body) {
  return STAFF_ASKS_RE.some((re) => re.test(String(body || '')));
}

function isShortReply(text) {
  const body = String(text || '').trim();
  if (!body || body.length > REPLY_MAX_CHARS || isSmsReaction(body)) return false;
  const plain = body.replace(/[\u2018\u2019]/g, "'");
  return AFFIRM_START_RE.test(plain) || TIMING_ANSWER_RE.test(plain) || namedDayMatcher(plain) !== null;
}

// The drafted text's own row: where it sits, when it came in, and the Waves line the customer texted. null when any is unknown.
function draftedRow(rows, currentSmsLogId) {
  const at = rows.findIndex((m) => m && m.id != null && String(m.id) === String(currentSmsLogId));
  const row = rows[at];
  const draftedAt = row ? new Date(row.date).getTime() : NaN;
  const line = phoneIdentityKey(row?.toPhone);
  return Number.isFinite(draftedAt) && line ? { at, draftedAt, line } : null;
}

// A person at Waves sent it, from this line to this sender (an automated text, an AI assistant send, another line or another contact: no).
function staffSentOnThread(row, sender, line) {
  return STAFF_SENT_TYPES.has(row.type) && phoneIdentityKey(row.toPhone) === sender && phoneIdentityKey(row.fromPhone) === line;
}

function customerTextOnThread(row, sender, line) {
  return row.direction === 'inbound' && phoneIdentityKey(row.fromPhone) === sender && phoneIdentityKey(row.toPhone) === line;
}

function bookingExchange({ smsHistory, currentSmsLogId, inboundMessage, inboundPhone } = {}) {
  const sender = phoneIdentityKey(inboundPhone);
  const rows = Array.isArray(smsHistory) ? smsHistory : [];
  const drafted = sender && currentSmsLogId && isShortReply(inboundMessage) ? draftedRow(rows, currentSmsLogId) : null;
  if (!drafted) return null;
  const customerTexts = [String(inboundMessage)];
  for (const row of rows.slice(drafted.at + 1, drafted.at + 1 + EXCHANGE_MAX_ROWS)) {
    const rowAt = new Date(row?.date).getTime();
    if (!Number.isFinite(rowAt) || drafted.draftedAt - rowAt > EXCHANGE_WINDOW_MS) return null;
    // The first outbound row decides: a person's ask on this thread carries the reply; any other outbound text stops the walk.
    if (row.direction === 'outbound') return staffSentOnThread(row, sender, drafted.line) && staffAsksAvailability(row.body) ? { staffText: String(row.body), customerTexts } : null;
    // Another number's text, or this customer's text to another Waves line: it may answer something else, so nothing is carried.
    if (!customerTextOnThread(row, sender, drafted.line)) return null;
    if (typeof row.body === 'string' && row.body.trim()) customerTexts.unshift(row.body);
  }
  return null;
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
  bookingExchange,
  namedDayMatcher,
  _internals: { isShortReply, staffAsksAvailability, parseLabel, namedDaysIn },
};
