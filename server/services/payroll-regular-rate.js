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
 * - A week paid on more than one check. One workweek's line pay can arrive on several
 *   checks: a commission on the week's own check, then a bonus that covers the same
 *   week months later, or a late line first and the week's own run after it. If every
 *   check priced its own lines and rounded half up, two checks could pay 1 cent less
 *   for the week than one check with both lines (33 + 33 against 67). So a check pays,
 *   for each week, the LARGER of two figures:
 *     (a) THE FLOOR, from its own lines only. The first check that pays line pay for
 *         a week rounds half up (the same BigInt half-up rule payroll-calc.js uses),
 *         exactly as a week on one check always did. A check for a week that a
 *         finalized check ALREADY paid line pay for rounds UP to the next whole cent.
 *     (b) THE SHORTFALL: the half-up premium on the week's WHOLE line pay (its own
 *         lines plus the lines finalized checks already paid for that week), less
 *         the premium those checks stored for the week.
 *   What (a) gives: a figure rounded up is never below its exact value, and at most
 *   one check for a week rounds half up, so checks priced by (a) never add up to
 *   less than one check with every line. And a check never pays less than its own
 *   lines earn alone, whatever another check paid: a void of an earlier check never
 *   leaves a later one short, and the checks left after any void still cover the
 *   lines that are left.
 *   What (b) gives: checks priced before this rule (each half up) can already be
 *   short together. The next check for the week makes the week whole, so after
 *   every check the week's checks add up to at least the premium on the whole.
 *   The cost of (a) is under 1 cent per week, per later check. A void of the check
 *   that made up an older shortfall leaves the older checks as they were before this
 *   rule; the next check for the week makes it up again.
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
 * earlierLines: the PAID lines of finalized checks, same shape. Only one that shares a
 *   week with `lines` matters. Such a week takes the rounded-up floor.
 * earlierPremiums: [{ weekStart, premiumCents }] the line premium finalized checks
 *   stored for a week (several rows for a week add up).
 * roundUpWeeks: weeks (any date in each) to give the rounded-up floor when the caller
 *   knows them without the lines: the scoreboard, from a stored week row.
 * Returns { extraPremiumCents, weeks: [{ weekStart, workedMinutes, overtimeMinutes,
 *   allocatedCents, premiumCents }] } with one entry per week that holds line pay,
 *   oldest first. allocatedCents is the week's line pay rounded to the cent for
 *   display; the premium comes from the exact share. A week whose floor was rounded
 *   up carries roundedUp: true, and a week with earlier line pay or premium carries
 *   earlierAllocatedCents and earlierPremiumCents, so a stored row says how it was
 *   priced.
 */
function lineOvertimePremium({ weeks = [], lines = [], earlierLines = [], earlierPremiums = [], roundUpWeeks = [] }) {
  const hoursByWeek = new Map();
  for (const week of weeks) {
    const regular = nonNegativeUnits(week.regularMinutes, 'Regular minutes');
    const overtime = nonNegativeUnits(week.overtimeMinutes, 'Overtime minutes');
    const key = staffWeekStartForWorkDate(week.weekStart);
    const seen = hoursByWeek.get(key) || { worked: 0n, overtime: 0n };
    hoursByWeek.set(key, { worked: seen.worked + regular + overtime, overtime: seen.overtime + overtime });
  }

  const spanOf = (line) => ({ cents: positiveCents(line.amountCents, 'Pay line amount'), weeks: weeksOfLine(line) });
  const spans = lines.map(spanOf);
  if (!spans.length) return { extraPremiumCents: 0, weeks: [] };
  const own = new Set(spans.flatMap((span) => span.weeks));
  // only an earlier line that shares a week with this check matters
  const before = earlierLines.map(spanOf).filter((span) => span.weeks.some((week) => own.has(week)));

  // Every share is cents / (weeks in its span); put them over one common denominator.
  const denominator = [...spans, ...before].reduce((acc, span) => lcm(acc, BigInt(span.weeks.length)), 1n);
  const sharesOf = (list) => {
    const byWeek = new Map();
    for (const span of list) {
      const share = span.cents * (denominator / BigInt(span.weeks.length));
      for (const week of span.weeks) byWeek.set(week, (byWeek.get(week) || 0n) + share);
    }
    return byWeek;
  };
  const shareByWeek = sharesOf(spans);
  const earlierShareByWeek = sharesOf(before);
  const paidByWeek = new Map();
  for (const row of earlierPremiums) {
    const cents = Number(row.premiumCents || 0);
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('An earlier premium must be a whole number of cents, zero or more');
    const key = staffWeekStartForWorkDate(row.weekStart);
    paidByWeek.set(key, (paidByWeek.get(key) || 0n) + BigInt(cents));
  }
  const up = new Set([...roundUpWeeks].map((week) => staffWeekStartForWorkDate(week)));
  for (const week of earlierShareByWeek.keys()) up.add(week);

  let extra = 0n;
  const breakdown = [...shareByWeek.keys()].sort().map((weekStart) => {
    const share = shareByWeek.get(weekStart);
    const earlierShare = earlierShareByWeek.get(weekStart) || 0n;
    const paid = paidByWeek.get(weekStart) || 0n;
    const hours = hoursByWeek.get(weekStart) || { worked: 0n, overtime: 0n };
    const roundedUp = up.has(weekStart);
    let premium = 0n;
    if (hours.worked > 0n && hours.overtime > 0n) {
      // 1/2 x (line pay / worked) x overtime, with the line pay over the common denominator
      const divisor = 2n * denominator * hours.worked;
      // (a) the floor, from this check's lines only: up when a finalized check already paid line pay for the week
      const floor = (roundedUp ? ceilDiv : roundDiv)(share * hours.overtime, divisor);
      // (b) the shortfall: the premium on the week's whole line pay, less what the earlier checks paid
      const shortfall = roundDiv((share + earlierShare) * hours.overtime, divisor) - paid;
      premium = shortfall > floor ? shortfall : floor;
    }
    extra += premium;
    return {
      weekStart,
      workedMinutes: Number(hours.worked) / 100,
      overtimeMinutes: Number(hours.overtime) / 100,
      allocatedCents: Number(roundDiv(share, denominator)),
      premiumCents: Number(premium),
      ...(roundedUp ? { roundedUp: true } : {}),
      ...(earlierShare > 0n || paid > 0n
        ? { earlierAllocatedCents: Number(roundDiv(earlierShare, denominator)), earlierPremiumCents: Number(paid) }
        : {}),
    };
  });
  return { extraPremiumCents: Number(extra), weeks: breakdown };
}

module.exports = { lineOvertimePremium, weeksOfLine };
