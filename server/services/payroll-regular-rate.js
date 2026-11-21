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
 * - Integer cents, one rounding per week. Line shares are kept as exact fractions
 *   until then, so splitting 100 cents over 3 weeks loses nothing before the round.
 * - The premium of the check's OWN pay week (`payWeek`) rounds half up, the same
 *   BigInt half-up rule payroll-calc.js uses. The premium of every other week
 *   rounds UP to the next whole cent.
 *   Why: one workweek's line pay can arrive on more than one check (a commission
 *   on the week's own check, then a bonus that covers the same week months later).
 *   Each check prices only its own lines. If both rounded half up, two checks could
 *   pay 1 cent less for the week than one check with both lines (33 + 33 against
 *   67). A week has one live pay run (payroll_runs_one_live_week) and a technician
 *   one check on it, so at most one check rounds a week half up (off by under half
 *   a cent). Every other check that pays for that week rounds up (never below its
 *   exact share). So the checks for a week, however many and in any order, never
 *   add up to less than the half-up premium on the week's whole line pay. The cost
 *   is under 1 cent per earlier week with overtime, per check.
 *   A caller that gives no `payWeek` gets every week rounded up.
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

// numerator / denominator, rounded up to a whole number. Both are zero or more, and the denominator is never zero.
const ceilDiv = (numerator, denominator) => (numerator + denominator - 1n) / denominator;

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

/**
 * weeks: [{ weekStart, regularMinutes, overtimeMinutes }] for the weeks that have
 *   an approved timesheet (a week left out counts as no hours worked).
 * lines: [{ id?, amountCents, weekStart } or { id?, amountCents, coversFrom, coversTo }]
 *   weekStart is the earned week (a Monday) and is used only when there is no span.
 * payWeek: the pay week of the check the lines are on (any date in it), or null.
 * Returns { extraPremiumCents, weeks: [{ weekStart, workedMinutes, overtimeMinutes,
 *   allocatedCents, premiumCents }] } with one entry per week that holds line pay,
 *   oldest first. allocatedCents is the week's line pay rounded to the cent for
 *   display; the premium comes from the exact share.
 */
function lineOvertimePremium({ weeks = [], lines = [], payWeek = null }) {
  const ownWeek = payWeek == null ? null : staffWeekStartForWorkDate(payWeek);
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
    // 1/2 x (share / worked) x overtime, with share over the common denominator. Half up for the check's own pay week,
    // up for any other week: see the rules above.
    const rounded = weekStart === ownWeek ? roundDiv : ceilDiv;
    const premium = hours.worked > 0n && hours.overtime > 0n
      ? rounded(share * hours.overtime, 2n * denominator * hours.worked)
      : 0n;
    extra += premium;
    return {
      weekStart,
      workedMinutes: Number(hours.worked) / 100,
      overtimeMinutes: Number(hours.overtime) / 100,
      allocatedCents: Number(roundDiv(share, denominator)),
      premiumCents: Number(premium),
    };
  });
  return { extraPremiumCents: Number(extra), weeks: breakdown };
}

module.exports = { lineOvertimePremium, weeksOfLine };
