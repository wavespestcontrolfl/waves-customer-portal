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
 * - Integer cents. Each week's premium rounds half up once (the same BigInt
 *   half-up rule payroll-calc.js uses). Line shares are kept as exact fractions
 *   until then, so splitting 100 cents over 3 weeks loses nothing before the round.
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
function weeksOfLine(line) {
  if (line.coversFrom == null && line.coversTo == null) return [staffWeekStartForWorkDate(line.weekStart)];
  if (line.coversFrom == null || line.coversTo == null || line.coversFrom > line.coversTo) {
    throw new Error('A pay line span needs both dates, the first not after the last');
  }
  const last = staffWeekStartForWorkDate(line.coversTo);
  const weeks = [];
  for (let week = staffWeekStartForWorkDate(line.coversFrom); week <= last; week = addStaffWorkDays(week, 7)) weeks.push(week);
  return weeks;
}

/**
 * weeks: [{ weekStart, regularMinutes, overtimeMinutes }] for the weeks that have
 *   an approved timesheet (a week left out counts as no hours worked).
 * lines: [{ id?, amountCents, weekStart } or { id?, amountCents, coversFrom, coversTo }]
 *   weekStart is the earned week (a Monday) and is used only when there is no span.
 * Returns { extraPremiumCents, weeks: [{ weekStart, workedMinutes, overtimeMinutes,
 *   allocatedCents, premiumCents }] } with one entry per week that holds line pay,
 *   oldest first. allocatedCents is the week's line pay rounded to the cent for
 *   display; the premium comes from the exact share.
 */
function lineOvertimePremium({ weeks = [], lines = [] }) {
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
    // 1/2 x (share / worked) x overtime, with share over the common denominator.
    const premium = hours.worked > 0n && hours.overtime > 0n
      ? roundDiv(share * hours.overtime, 2n * denominator * hours.worked)
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
