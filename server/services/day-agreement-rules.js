'use strict';

/**
 * Day-only agreement shadow: the deterministic rules (owner 2026-10-20).
 *
 * Pure functions, no database, no model. The model judges what the office
 * SHOULD do (prompts/day-agreement-v1.js); these rules decide whether the
 * shadow sweep records a would_book or would_move, and each failing rule is
 * recorded as the skip reason. Nothing here books, moves or texts anyone.
 */

const MIN_CONFIDENCE = 0.7;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['new_visit', 'move'];
// A moved visit must be one the office can move: not started, not finished.
const MOVABLE_STATUSES = ['pending', 'confirmed'];
// A visit that no longer holds a place on the calendar.
const DEAD_STATUSES = ['cancelled', 'canceled', 'skipped', 'no_show', 'rescheduled'];
// How old an agreement may be when it is judged. A text thread keeps up to 50
// messages, so older agreements in it are history, not news.
const MAX_AGE_MS = { call: 24 * 3600 * 1000, sms: 6 * 3600 * 1000 };
const REASON_MAX_CHARS = 200;

// Cheap text prefilter for the SMS leg: a weekday name or abbreviation,
// today, tomorrow, a m/d date or an ordinal ("the 24th"). Written with
// character classes only so the SAME pattern runs in Postgres (~*) and in
// JavaScript (RegExp, flag i).
const DAY_WORD_PATTERN = '(^|[^a-z])(mon(day)?|tue(s|sday)?|wed(s|nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?|today|tomorrow|tmrw)([^a-z]|$)'
  + '|[0-9]{1,2}/[0-9]{1,2}'
  + '|[0-9]{1,2}(st|nd|rd|th)([^a-z]|$)';
const DAY_WORD_RE = new RegExp(DAY_WORD_PATTERN, 'i');

const isString = (v) => typeof v === 'string' && v.trim() !== '';

// A real calendar day written YYYY-MM-DD ("2026-02-30" is not one).
function validDay(value) {
  if (!isString(value) || !ISO_DAY.test(value.trim())) return false;
  const [y, m, d] = value.trim().split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// The model's free-text reason is stored. It is told to leave out names, numbers
// and addresses; this clips it and masks a street address (house number and
// street), any phone-like run, any number of three or more digits (account, gate,
// reference numbers) and any "#12" reference anyway. An ISO date is kept: it is
// no personal detail and the reason reads better with it.
const STREET_WORDS = 'street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|place|pl|circle|cir|terrace|ter|trail|trl|highway|hwy|parkway|pkwy|loop|run|path|point|pt|bay';
const ADDRESS_RE = new RegExp(`\\b\\d{1,6}[a-z]?\\s+(?:[a-z0-9.'-]+\\s+){0,3}(?:${STREET_WORDS})\\b\\.?`, 'gi');
const NUMBER_RE = /(\d{4}-\d{2}-\d{2})|\d[\d\s().-]{5,}\d|#\s*\d+|\d{3,}/g;

function safeReason(text) {
  return String(text || '')
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(ADDRESS_RE, '[address]')
    .replace(NUMBER_RE, (match, isoDate) => (isoDate ? match : '[number]'))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REASON_MAX_CHARS);
}

// One model object into the shape the rules and the table use. Vocabulary
// slips fail soft (a bad kind or day is caught by the rules, not here).
function normalizeAgreement(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const text = (v) => (isString(v) ? v.trim() : null);
  const confidence = Number(a.confidence);
  return {
    at: text(a.at),
    act: a.act === true,
    kind: isString(a.kind) ? a.kind.trim().toLowerCase() : null,
    day: text(a.day),
    from_day: text(a.from_day),
    daypart: isString(a.daypart) ? a.daypart.trim().toLowerCase() : null,
    service: text(a.service) ? text(a.service).slice(0, 60) : null,
    blockers: (Array.isArray(a.blockers) ? a.blockers : []).filter(isString).map((b) => b.trim().slice(0, 40)).slice(0, 8),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    reason: safeReason(a.reason),
  };
}

// The answer must be usable to be accepted: an act:true object needs a known
// kind and a real day. Returns a short code, or null. An unusable answer fails
// its leg in dispatchWithFallback so the backup model gets a turn.
function unusableReason(agreements) {
  if (!Array.isArray(agreements) || !agreements.length) return 'no_agreements';
  for (const raw of agreements) {
    const a = normalizeAgreement(raw);
    if (!a.act) continue;
    if (!KINDS.includes(a.kind)) return 'kind_invalid';
    if (!validDay(a.day)) return 'day_invalid';
  }
  return null;
}

// daypart text into a start-time window in minutes: from (inclusive) to
// before (exclusive). null = unreadable. "any" and no daypart = the whole day.
// "after HH:MM" starts at that hour or later; "before HH:MM" starts earlier.
function parseDaypart(daypart) {
  const text = isString(daypart) ? daypart.trim().toLowerCase() : 'any';
  const named = { any: [0, 1440], morning: [0, 720], afternoon: [720, 1020], evening: [1020, 1440] }[text];
  if (named) return { from: named[0], before: named[1] };
  const m = /^(after|before) (\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  if (Number(m[2]) > 23 || Number(m[3]) > 59) return null;
  return m[1] === 'after' ? { from: minutes, before: 1440 } : { from: 0, before: minutes };
}

const slotMinutes = (slot) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(slot?.start_time || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// The slots the day's picker offered, kept to whole-hour starts (owner rule:
// visits start on the hour) inside the daypart. Order is the picker's order.
function slotsForDaypart(slots, daypart) {
  const window = parseDaypart(daypart);
  if (!window) return [];
  return (Array.isArray(slots) ? slots : []).filter((slot) => {
    const start = slotMinutes(slot);
    return start !== null && start % 60 === 0 && start >= window.from && start < window.before;
  });
}

// The first slot the picker would take: best-ranked slot inside the daypart.
function chooseSlot(slots, daypart) {
  return slotsForDaypart(slots, daypart)[0] || null;
}

const isLive = (visit) => !DEAD_STATUSES.includes(String(visit.status || '').toLowerCase());
const after = (value, moment) => value != null && new Date(value).getTime() > moment.getTime();

// Each rule: [skip reason, predicate that is TRUE when the rule FAILS]. The
// first failure is the recorded reason, so order is cheapest-and-clearest first.
const RULES = [
  ['model_no_act', ({ a }) => !a.act],
  // An act:true answer that also lists a blocker contradicts itself: the safe reading is no.
  ['model_blocker', ({ a }) => a.blockers.length > 0],
  ['low_confidence', ({ a }) => !(a.confidence >= MIN_CONFIDENCE)],
  ['kind_invalid', ({ a }) => !KINDS.includes(a.kind)],
  ['day_invalid', ({ a }) => !validDay(a.day)],
  // Same-day is skipped: "you're my next stop" and "I'll swing by" are not bookings.
  ['day_not_after_today', ({ a, todayET }) => !(a.day > todayET)],
  ['no_customer', ({ customerId }) => !customerId],
  ['stale_moment', ({ agreedAt, now, kind }) => !agreedAt || agreedAt.getTime() > now.getTime() + 300000
    || now.getTime() - agreedAt.getTime() > MAX_AGE_MS[kind]],
  ['daypart_unreadable', ({ a }) => parseDaypart(a.daypart) === null],
  ['staff_already_acted', ({ visitsOnDay, agreedAt }) => visitsOnDay.some((v) => isLive(v)
    && (after(v.created_at, agreedAt) || after(v.updated_at, agreedAt)))],
  ['move_target_unclear', ({ a }) => a.kind === 'move' && !validDay(a.from_day)],
  ['move_same_day', ({ a }) => a.kind === 'move' && a.from_day === a.day],
  ['move_visit_missing', ({ a, movable }) => a.kind === 'move' && movable.length === 0],
  ['move_visit_ambiguous', ({ a, movable }) => a.kind === 'move' && movable.length > 1],
  ['day_has_visit', ({ visitsOnDay }) => visitsOnDay.some(isLive)],
];

/**
 * Decide one agreement moment. Pure.
 *
 * @param {object} p
 * @param {object} p.agreement   the model's object (normalized here)
 * @param {'call'|'sms'} p.kind  the source kind
 * @param {string|null} p.customerId
 * @param {string} p.todayET     today's ET date, YYYY-MM-DD
 * @param {Date} p.agreedAt      when the agreement was made
 * @param {Date} p.now
 * @param {Array} p.visitsOnDay  the customer's visits dated the agreed day
 *                               ({ id, status, created_at, updated_at })
 * @param {Array} p.visitsOnFromDay  the customer's visits dated from_day
 * @returns {{ pass: boolean, reason: string|null, agreement: object,
 *             kind: string|null, day: string|null, fromVisitId: string|null }}
 */
function decideAgreement({
  agreement, kind, customerId, todayET, agreedAt, now, visitsOnDay = [], visitsOnFromDay = [],
}) {
  const a = normalizeAgreement(agreement);
  const movable = visitsOnFromDay.filter((v) => MOVABLE_STATUSES.includes(String(v.status || '').toLowerCase()));
  const context = { a, kind, customerId, todayET, agreedAt, now, visitsOnDay, movable };
  const failed = RULES.find(([, fails]) => fails(context));
  if (failed) return { pass: false, reason: failed[0], agreement: a, kind: a.kind, day: a.day, fromVisitId: null };
  return {
    pass: true, reason: null, agreement: a, kind: a.kind, day: a.day,
    fromVisitId: a.kind === 'move' ? movable[0].id : null,
  };
}

module.exports = {
  MIN_CONFIDENCE,
  MAX_AGE_MS,
  MOVABLE_STATUSES,
  DEAD_STATUSES,
  KINDS,
  DAY_WORD_PATTERN,
  DAY_WORD_RE,
  validDay,
  safeReason,
  normalizeAgreement,
  unusableReason,
  parseDaypart,
  slotsForDaypart,
  chooseSlot,
  decideAgreement,
};
