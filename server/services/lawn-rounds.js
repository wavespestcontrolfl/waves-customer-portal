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

// The i-th round date after `base` (a visit in the series), counted in rounds
// and placed from the SERIES ANCHOR's offset and weekday. lawnRoundDate hops
// from whatever date it is given, and each hop snaps to the weekday again
// (a hop gains 2 days a round), so extending a series one visit at a time from
// its latest visit drifts toward the end of every round (a Jan 12 anchor ends
// a year later on Jan 25). Extension, top-up and reseed hop from the latest
// visit, so they pass the anchor: the answer is then the same date the series
// was seeded with. No anchor, or an unreadable one: hop from `base`, as
// lawnRoundDate does. i = 0 is `base` itself.
function lawnRoundDateFrom(anchorDateStr, baseDateStr, i = 0) {
  const base = dateOnly(baseDateStr);
  const steps = Math.trunc(Number(i) || 0);
  const anchorRound = roundOf(anchorDateStr);
  const baseRound = roundOf(base);
  if (!anchorRound || !baseRound) return lawnRoundDate(base, steps);
  if (steps === 0) return base;
  return lawnRoundDate(dateOnly(anchorDateStr), roundOrdinal(base) - roundOrdinal(anchorDateStr) + steps);
}

// Position of a date on the continuous round timeline: round 1 of program
// year Y is Y * 9. Null for an unreadable date.
function roundOrdinal(dateStr) {
  const home = roundOf(dateStr);
  return home ? home.programYear * ROUNDS_PER_YEAR + (home.round - 1) : null;
}

// The dates a recurring series already occupies, for a walk that places new
// visits. Every date blocks its own day (the Set itself). Only a CADENCE
// visit owns a lawn round (`cadence`): a booster extra shares
// recurring_parent_id but carries is_recurring = false and sits on top of the
// plan, so it must never stand in for a round's regular visit. add() records
// a cadence date (every date a walk places is one); addExtra() a booster's.
// Copying another SeriesDates keeps which dates are extras.
class SeriesDates extends Set {
  constructor(dates = []) {
    super();
    this.cadence = new Set();
    if (dates instanceof SeriesDates) {
      for (const d of dates) super.add(d);
      for (const d of dates.cadence) this.cadence.add(d);
      return;
    }
    for (const d of dates || []) this.add(d);
  }

  add(date) {
    super.add(date);
    this.cadence.add(date);
    return this;
  }

  addExtra(date) {
    super.add(date);
    return this;
  }
}

// A SeriesDates from scheduled_services rows ({ scheduled_date, is_recurring }).
// A row without is_recurring counts as a cadence visit (the reading before
// boosters were told apart). `toDate` normalizes the stored date.
function seriesDatesFromRows(rows, toDate = dateOnly) {
  const out = new SeriesDates();
  for (const row of rows || []) {
    const d = toDate(row?.scheduled_date);
    if (!d) continue;
    if (row.is_recurring === false) out.addExtra(d);
    else out.add(d);
  }
  return out;
}

// True when `dates` (any iterable of 'YYYY-MM-DD', or a SeriesDates) already
// holds a visit in the same round as `dateStr`. A series owes one visit a
// round: a candidate whose round is taken is not a missing visit, it is a
// second one. A SeriesDates answers from its cadence visits only.
function roundTaken(dates, dateStr) {
  const want = roundOrdinal(dateStr);
  if (want == null) return false;
  const pool = dates instanceof SeriesDates ? dates.cadence : dates;
  for (const d of pool || []) if (roundOrdinal(d) === want) return true;
  return false;
}

// Which v13 program step a rounds visit takes (owner 2026-10-29). The 12x program names its step by the calendar month; a rounds
// visit takes the step of its ROUND, so a visit placed a week early or late still gets its own round's products. `month` is the
// v13 step's month (1-12); `variant` names the rounds-only form of that step:
//   'cadence9'  the step's cadenceVariants["9"] (April's LESCO Dimension 18-0-10, 0.5 lb N) - round 2
//   'rounds'    the step's roundVariants.lawn_rounds_9 (February's 24-0-11 at 1.0 lb N) - round 3
//   null        the step as written
// The spot and weed rows of a rounds visit do NOT follow this map; they follow the real date (roundSpotMonth).
const ROUND_STEPS = Object.freeze({
  1: Object.freeze({ month: 1, variant: null }),
  2: Object.freeze({ month: 4, variant: 'cadence9' }),
  3: Object.freeze({ month: 2, variant: 'rounds' }),
  4: Object.freeze({ month: 5, variant: null }),
  5: Object.freeze({ month: 6, variant: null }),
  6: Object.freeze({ month: 8, variant: null }),
  7: Object.freeze({ month: 9, variant: null }),
  8: Object.freeze({ month: 10, variant: null }),
  9: Object.freeze({ month: 12, variant: null }),
});

// The step a booked visit takes, or null. ONLY a visit whose own row says recurring_pattern 'lawn_rounds_9' has one (the pattern is
// written on rounds series only, so no gate is read); every other visit (12x, legacy 9x, one-time, other services) returns null and
// is planned exactly as before. `row` needs recurring_pattern and scheduled_date.
function roundStepForVisit(row) {
  if (row?.recurring_pattern !== LAWN_ROUNDS_9) return null;
  const home = roundOf(row.scheduled_date);
  if (!home) return null;
  const step = ROUND_STEPS[home.round];
  return { round: home.round, programYear: home.programYear, month: step.month, variant: step.variant };
}

// The month (1-12) whose window supplies the weed and spot rows of a rounds visit (every as-needed row: lawn-program.js isAsNeededRow):
// the real date's month, with ONE exception the approved page states. The St. Augustine green-up rule (Celsius alone, no Certainty;
// February window data) covers all of round 2, real dates Feb 3 to Mar 14, so a St. Augustine round-2 visit dated in March reads
// February's rows (February's only disease row is the Velista large patch spring pass and it has no insect spot rows; March's take-all line comes on the round-3 visit). `realMonth` is 1-12.
function roundSpotMonth({ round, realMonth, grassTrack }) {
  if (Number(round) === 2 && Number(realMonth) === 3 && grassTrack === 'st_augustine') return 2;
  return Number(realMonth);
}

// The size rule for moves (owner 2026-10-31): on a lawn_rounds_9 series a date move of this many days or fewer, inside one round,
// moves ONLY that visit (no sibling shift, no re-anchor); a bigger move re-anchors as before. Every other pattern is untouched.
const ROUNDS_ONE_OFF_MAX_DAYS = 7;

// The visit's REGULAR date: the cadence position a date exception deviated from, else its own date. Measuring a move from here
// (not from the moved date) stops repeated small moves from walking a visit across its round.
function roundsRegularDate(row) {
  return dateOnly(row?.date_exception === true && row?.date_exception_cadence_date
    ? row.date_exception_cadence_date
    : row?.scheduled_date);
}

// The dates a one-off move may land on: within maxDays of the regular date AND inside that date's round. Null when the pattern is
// not lawn_rounds_9 or the date is unreadable. { maxDays, fromDate, roundStart, roundEnd, start, end }: start/end are the window's
// first and last day (inclusive); roundStart/roundEnd are the round's own bounds (what the customer page discloses).
function roundsOneOffWindow(pattern, fromDateStr, { maxDays = ROUNDS_ONE_OFF_MAX_DAYS } = {}) {
  if (pattern !== LAWN_ROUNDS_9) return null;
  const fromDate = dateOnly(fromDateStr);
  const home = isValidDateStr(fromDate) ? roundOf(fromDate) : null;
  if (!home) return null;
  const lo = addDays(fromDate, -maxDays);
  const hi = addDays(fromDate, maxDays);
  return { maxDays, fromDate, roundStart: home.start, roundEnd: home.end, start: lo < home.start ? home.start : lo, end: hi > home.end ? home.end : hi };
}

// True when moving a visit of `pattern` from `fromDateStr` (its regular date) to `toDateStr` is a one-off: lawn_rounds_9 only, both
// dates valid, at most maxDays apart, both in the same round.
function roundsMoveIsOneOff(pattern, fromDateStr, toDateStr, opts) {
  const window = roundsOneOffWindow(pattern, fromDateStr, opts);
  const to = dateOnly(toDateStr);
  return !!window && isValidDateStr(to) && to >= window.start && to <= window.end;
}

// The same verdict for MOVING a scheduled_services row (needs recurring_pattern, scheduled_date, and when present
// date_exception + date_exception_cadence_date). Keeping the row on its own date is no move, so never a one-off.
function roundsRowMoveIsOneOff(row, toDateStr, opts) {
  return dateOnly(toDateStr) !== dateOnly(row?.scheduled_date)
    && roundsMoveIsOneOff(row?.recurring_pattern, roundsRegularDate(row), toDateStr, opts);
}

// True when moving `row` from `fromDateStr` to `toDateStr` changes its date AND shifts its series: the date changes and
// the move is not a lawn rounds one-off (size rule). Shared by the rebooker's series preview, rain-out's series shift
// and the call reschedule plan, so they decide alike.
function datesMoveSeries(row, fromDateStr, toDateStr) {
  const to = dateOnly(toDateStr);
  return !!to && to !== dateOnly(fromDateStr) && !roundsRowMoveIsOneOff(row, to);
}

module.exports = {
  LAWN_ROUNDS_9,
  ROUNDS_ONE_OFF_MAX_DAYS,
  roundsRegularDate,
  roundsOneOffWindow,
  roundsMoveIsOneOff,
  roundsRowMoveIsOneOff,
  datesMoveSeries,
  ROUND_STEPS,
  roundStepForVisit,
  roundSpotMonth,
  ROUNDS_PER_YEAR,
  LAWN_ROUND_TABLE,
  roundOf,
  roundStart,
  roundEnd,
  lawnRoundDate,
  lawnRoundDateFrom,
  roundOrdinal,
  roundTaken,
  SeriesDates,
  seriesDatesFromRows,
};
