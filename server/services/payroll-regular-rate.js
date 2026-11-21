/**
 * The extra overtime that bonus, commission and allowance pay causes (owner
 * ruling 2026-10-29, D5 part 1). Pure: no database, no clock, nothing sent.
 *
 * Federal overtime law (FLSA) sets the overtime rate from the REGULAR RATE: all
 * pay for the week's hours worked, divided by those hours (29 CFR 778.109). A
 * review bonus, a sales commission and a cash health allowance count (778.208 to
 * 778.211, 778.215 for a cash option), and so does an employer HSA contribution
 * that the employee may take as cash. The hourly pay already carries the
 * straight time for every hour, so each overtime hour is owed one more half of
 * the line pay per hour worked:
 *
 *   extra premium for a week = 1/2 x (line pay allocated to the week / hours
 *   worked in the week) x overtime hours
 *
 * Rules:
 * - A line with a span (a commission or a monthly allowance that covers several
 *   workweeks) is split EQUALLY over the workweeks of the span (29 CFR 778.120),
 *   whether or not the technician worked that week. A line without a span stays
 *   in its own week.
 * - The base hourly rate is not an input, so a raise between weeks cannot change
 *   the figure. The hourly pay of each week was paid at that week's own rate.
 * - Paid time off and holiday hours are not hours worked and never enter here.
 *   The caller passes only worked minutes (regular plus overtime).
 * - A week with no overtime, no hours or no approved timesheet earns no premium.
 * - Integer cents, one rounding per week on a check. Line shares are kept as exact
 *   fractions until then, so splitting 100 cents over 3 weeks loses nothing before
 *   the round.
 * - Which way a week rounds. One workweek's line pay can arrive on more than one
 *   check: a commission on the week's own check, then a bonus that covers the same
 *   week months later, or a late line first and the week's own run after it. Each
 *   check prices only its own lines. If every check rounded half up, two checks
 *   could pay 1 cent less for the week than one check with both lines (33 + 33
 *   against 67). So:
 *     the FIRST check that pays line pay for a week rounds half up (the same BigInt
 *     half-up rule payroll-calc.js uses), exactly as a week on one check always did;
 *     a check that pays line pay for a week that a finalized check ALREADY paid line
 *     pay for (`roundUpWeeks`) rounds that week UP to the next whole cent.
 *   Why this is enough: a figure rounded up is never below its exact value, and at
 *   most one check for a week rounds half up (off by under half a cent), so the
 *   checks for a week never add up to less than the half-up premium on the week's
 *   whole line pay. And no check depends on the AMOUNT another check paid: a later
 *   check pays at least what its own lines earn alone, so voiding an earlier check
 *   never leaves a later one short. The cost is under 1 cent per week, per later
 *   check.
 *
 * Minutes arrive like computePaycheck's: numbers or decimal strings, read at two
 * decimals (hundredths of a minute). The units cancel in the formula.
 */
const { payrollUnits } = require('../utils/payroll-units');
const { roundDiv } = require('./payroll-calc');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

function nonNegativeUnits(value, label) {
  if (value == null || value === '') return 0n;
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error(`${label} must be a non-negative number`);
  return payrollUnits(text);
}

function positiveCents(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive whole number of cents`);
  return BigInt(value);
}

const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
const lcm = (a, b) => (a / gcd(a, b)) * b;

// The Monday of every workweek a line covers, oldest first. No span: the earned week only.
// The weeks of a span depend on its two dates only, and a span of a year is about 50 date steps (each one a time zone
// conversion). A pay run asks for the same span several times per line, so the last answers are kept. Callers get a copy.
const SPAN_WEEKS = new Map();
const SPAN_WEEKS_MAX = 200;

function weeksOfLine(line) {
  if (line.coversFrom == null && line.coversTo == null) return [staffWeekStartForWorkDate(line.weekStart)];
  if (line.coversFrom == null || line.coversTo == null || line.coversFrom > line.coversTo) {
    throw new Error('A pay line span needs both dates, the first not after the last');
  }
  const key = `${line.coversFrom}|${line.coversTo}`;
  const kept = SPAN_WEEKS.get(key);
  if (kept) return [...kept];
  const last = staffWeekStartForWorkDate(line.coversTo);
  const weeks = [];
  for (let week = staffWeekStartForWorkDate(line.coversFrom); week <= last; week = addStaffWorkDays(week, 7)) weeks.push(week);
  if (SPAN_WEEKS.size >= SPAN_WEEKS_MAX) SPAN_WEEKS.delete(SPAN_WEEKS.keys().next().value);
  SPAN_WEEKS.set(key, weeks);
  return [...weeks];
}

// numerator / denominator, rounded up to a whole number. Both are zero or more, and the denominator is never zero.
const ceilDiv = (numerator, denominator) => (numerator + denominator - 1n) / denominator;

/**
 * weeks: [{ weekStart, regularMinutes, overtimeMinutes }] for the weeks that have
 *   an approved timesheet (a week left out counts as no hours worked).
 * lines: [{ id?, amountCents, weekStart } or { id?, amountCents, coversFrom, coversTo }]
 *   weekStart is the earned week (a Monday) and is used only when there is no span.
 * roundUpWeeks: the weeks (any date in each) that a finalized check already paid line
 *   pay for. Their premium rounds up; every other week rounds half up.
 * Returns { extraPremiumCents, weeks: [{ weekStart, workedMinutes, overtimeMinutes,
 *   allocatedCents, premiumCents }] } with one entry per week that holds line pay,
 *   oldest first. allocatedCents is the week's line pay rounded to the cent for
 *   display; the premium comes from the exact share. A week that was rounded up
 *   carries roundedUp: true, so a stored row says which rule priced it.
 */
function lineOvertimePremium({ weeks = [], lines = [], roundUpWeeks = [] }) {
  const hoursByWeek = new Map();
  for (const week of weeks) {
    const regular = nonNegativeUnits(week.regularMinutes, 'Regular minutes');
    const overtime = nonNegativeUnits(week.overtimeMinutes, 'Overtime minutes');
    const key = staffWeekStartForWorkDate(week.weekStart);
    const seen = hoursByWeek.get(key) || { worked: 0n, overtime: 0n };
    hoursByWeek.set(key, { worked: seen.worked + regular + overtime, overtime: seen.overtime + overtime });
  }

  const spans = lines.map((line) => ({
    cents: positiveCents(line.amountCents, 'Pay line amount'),
    weeks: weeksOfLine(line),
  }));
  if (!spans.length) return { extraPremiumCents: 0, weeks: [] };
  const up = new Set([...roundUpWeeks].map((week) => staffWeekStartForWorkDate(week)));

  // Every share is cents / (weeks in its span); put them over one common denominator.
  const denominator = spans.reduce((acc, span) => lcm(acc, BigInt(span.weeks.length)), 1n);
  const shareByWeek = new Map();
  for (const span of spans) {
    const share = span.cents * (denominator / BigInt(span.weeks.length));
    for (const week of span.weeks) shareByWeek.set(week, (shareByWeek.get(week) || 0n) + share);
  }

  let extra = 0n;
  const breakdown = [...shareByWeek.keys()].sort().map((weekStart) => {
    const share = shareByWeek.get(weekStart);
    const hours = hoursByWeek.get(weekStart) || { worked: 0n, overtime: 0n };
    const roundedUp = up.has(weekStart);
    // 1/2 x (share / worked) x overtime, with share over the common denominator: half up, or up for a week that a
    // finalized check already paid line pay for (see the rules above).
    const premium = hours.worked > 0n && hours.overtime > 0n
      ? (roundedUp ? ceilDiv : roundDiv)(share * hours.overtime, 2n * denominator * hours.worked)
      : 0n;
    extra += premium;
    return {
      weekStart,
      workedMinutes: Number(hours.worked) / 100,
      overtimeMinutes: Number(hours.overtime) / 100,
      allocatedCents: Number(roundDiv(share, denominator)),
      premiumCents: Number(premium),
      ...(roundedUp ? { roundedUp: true } : {}),
    };
  });
  return { extraPremiumCents: Number(extra), weeks: breakdown };
}

module.exports = { lineOvertimePremium, weeksOfLine };
