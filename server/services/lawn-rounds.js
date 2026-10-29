// Lawn 9x rounds calendar (owner 2026-10-28). A 9x lawn plan books one visit
// per round in nine fixed rounds a year instead of a 42-day custom series,
// which drifts 13 days a year and skips program steps. Pure date math, no DB.
//
// Program year Y runs Dec 25 of Y-1 through Dec 24 of Y. Round starts are ET
// calendar dates that repeat every year; a round ends the day before the next
// one starts. Rounds 1-8 are 40 days and round 9 is 45 days in a non-leap
// year; Feb 29 only makes round 2 one day longer.
const { parseETDateTime, etParts, etDateString, addETDays } = require('../utils/datetime-et');

const LAWN_ROUNDS_9 = 'lawn_rounds_9';
const ROUNDS_PER_YEAR = 9;

// Round start as [month, day]. Round 1 starts in the PREVIOUS calendar year
// (Dec 25 of Y-1); every other round starts in the program year itself.
const LAWN_ROUND_TABLE = Object.freeze([
  Object.freeze({ round: 1, startMonth: 12, startDay: 25, startsPrevYear: true }),
  Object.freeze({ round: 2, startMonth: 2, startDay: 3, startsPrevYear: false }),
  Object.freeze({ round: 3, startMonth: 3, startDay: 15, startsPrevYear: false }),
  Object.freeze({ round: 4, startMonth: 4, startDay: 24, startsPrevYear: false }),
  Object.freeze({ round: 5, startMonth: 6, startDay: 3, startsPrevYear: false }),
  Object.freeze({ round: 6, startMonth: 7, startDay: 13, startsPrevYear: false }),
  Object.freeze({ round: 7, startMonth: 8, startDay: 22, startsPrevYear: false }),
  Object.freeze({ round: 8, startMonth: 10, startDay: 1, startsPrevYear: false }),
  Object.freeze({ round: 9, startMonth: 11, startDay: 10, startsPrevYear: false }),
]);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function etNoon(dateStr) {
  return parseETDateTime(`${dateStr}T12:00`);
}

function addDays(dateStr, days) {
  return etDateString(addETDays(etNoon(dateStr), days));
}

function diffDays(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

function isValidDateStr(dateStr) {
  return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr) && !isNaN(etNoon(dateStr).getTime());
}

// First day of a round in a program year.
function roundStart(programYear, round) {
  const row = LAWN_ROUND_TABLE[round - 1];
  return ymd(row.startsPrevYear ? programYear - 1 : programYear, row.startMonth, row.startDay);
}

// Last day (INCLUSIVE) of a round in a program year: the day before the next
// round starts; round 9 ends Dec 24 of the program year.
function roundEnd(programYear, round) {
  if (round === ROUNDS_PER_YEAR) return ymd(programYear, 12, 24);
  return addDays(roundStart(programYear, round + 1), -1);
}

// Which round a date sits in. `start` and `end` are both INCLUSIVE
// 'YYYY-MM-DD' strings; `length` is the day count (end - start + 1). Returns
// null for an unparseable date.
function roundOf(dateStr) {
  const safe = dateOnly(dateStr);
  if (!isValidDateStr(safe)) return null;
  const [year, month, day] = safe.split('-').map(Number);
  const programYear = month === 12 && day >= 25 ? year + 1 : year;
  for (let round = ROUNDS_PER_YEAR; round >= 1; round--) {
    const start = roundStart(programYear, round);
    if (safe >= start) {
      const end = roundEnd(programYear, round);
      return { programYear, round, start, end, length: diffDays(start, end) + 1 };
    }
  }
  return null;
}

// The i-th round date after an anchor (i = 0 is the anchor). The anchor sits
// in round r0 at offset o days from that round's start; occurrence i lands in
// round r0 + i (rolling into later program years) at the same offset (capped
// to the round's last day), snapped to the anchor's weekday. The snap picks
// the nearest matching weekday (a tie goes forward) and is pulled back inside
// the round by +/-7 days, so every occurrence stays in its own round on the
// anchor's weekday. Consecutive gaps are therefore 35, 42 or 49 days.
function lawnRoundDate(anchorDateStr, i = 0) {
  const anchor = dateOnly(anchorDateStr) || etDateString();
  if (!isValidDateStr(anchor)) return anchor;
  const steps = Math.trunc(Number(i) || 0);
  if (steps === 0) return anchor;
  const home = roundOf(anchor);
  const offset = diffDays(home.start, anchor);
  const ordinal = home.programYear * ROUNDS_PER_YEAR + (home.round - 1) + steps;
  const programYear = Math.floor(ordinal / ROUNDS_PER_YEAR);
  const round = (((ordinal % ROUNDS_PER_YEAR) + ROUNDS_PER_YEAR) % ROUNDS_PER_YEAR) + 1;
  const start = roundStart(programYear, round);
  const end = roundEnd(programYear, round);
  const length = diffDays(start, end) + 1;

  const targetStr = addDays(start, Math.min(offset, length - 1));
  const wantWeekday = etParts(etNoon(anchor)).dayOfWeek;
  const haveWeekday = etParts(etNoon(targetStr)).dayOfWeek;
  const forward = (wantWeekday - haveWeekday + 7) % 7; // 0..6
  // Nearest weekday; 7 is odd so there is never a true tie, forward wins ties.
  let snapped = addDays(targetStr, forward <= 3 ? forward : forward - 7);
  if (snapped < start) snapped = addDays(snapped, 7);
  else if (snapped > end) snapped = addDays(snapped, -7);
  return snapped;
}

module.exports = {
  LAWN_ROUNDS_9,
  ROUNDS_PER_YEAR,
  LAWN_ROUND_TABLE,
  roundOf,
  roundStart,
  roundEnd,
  lawnRoundDate,
};
