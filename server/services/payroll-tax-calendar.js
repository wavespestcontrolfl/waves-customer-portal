/**
 * Basic payroll, layer 2 (GATE_PAYROLL_TAX_CALENDAR, owner 2026-10-25, "can we
 * start building basic now, and add layers to it at later stages?"): the
 * amount and due date of every payroll tax deposit and filing, written to the
 * existing Tax page filing calendar (tax_filing_calendar). The 14-day reminder
 * is the existing 8:23 ET tax deadline text; this module adds no notification.
 * The portal prepares. The owner pays and files. Nothing here moves money or
 * sends anything to a customer or an employee.
 *
 * Periods follow the PAY DATE (Pub 15: a deposit follows the date wages are
 * paid). Rows come only from FINALIZED payroll_checks; drafts and voided
 * checks are never counted.
 *
 * Out of scope: semiweekly depositors (the $50,000 lookback), the $100,000
 * next-day deposit rule, and FUTA deposits. A new employer is a monthly
 * depositor (Pub 15), so every month gets one deposit row. A FUTA deposit is
 * needed only once a year's FUTA passes $500 (about 12 employees), so this
 * calendar writes one alert row for that year and leaves the amount to the
 * owner and the accountant; Form 940 carries the full year FUTA.
 *
 * Due dates: IRS dates move to the next day that is not a Saturday, Sunday or
 * legal holiday (Pub 509: legal holidays in the District of Columbia). Florida
 * RT-6 dates move past Saturday, Sunday and state or federal holidays (RT-6
 * instructions; the Friday after Thanksgiving is a state holiday, s. 110.117,
 * F.S.). The new hire report is due 20 calendar days after hire (s. 409.2576,
 * F.S.) with no roll.
 *
 * The sync inserts a row once (source_key 'payroll:<kind>:<period>'), keeps an
 * 'upcoming' row current, deletes an 'upcoming' row whose duty is gone, and
 * never touches a row in any other status (the owner or another job moved it).
 * A row that carries an amount and was marked done is a payment on record. If
 * a pay run later changes the liability above what the marked rows cover, a
 * new 'upcoming' balance row (key '<row>:balance:<n>') holds the difference.
 * Every row built from checks stores source_digest, a hash of exactly those
 * checks. If a Form 941, RT-6, 940 or W-2/W-3 row was marked done and its
 * checks have since changed (a void and replacement), a review row (key
 * '<row>:review:<n>', n one above the highest marked review) asks the owner to
 * check the figures; marking it done stores the current digest, which becomes
 * the latest acknowledged state. A return to an earlier digest raises a new
 * review. Only the base and review rows count, never a balance row. A period
 * with a marked row stays covered even when every check in it is voided (zero
 * totals, the digest of the empty set), so a filed return still gets its
 * review row. A marked row with no digest (not written by this sync) never
 * gets a review row.
 */
const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { payrollTaxCalendarLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');

// The day layer 2 was built. Earlier staff are not new hires.
const NEW_HIRE_FLOOR = '2026-10-25';
const NEW_HIRE_DAYS = 20;
// A FUTA deposit is due once the year's running total passes $500.00.
const FUTA_ALERT_THRESHOLD_CENTS = 50000;
const BALANCE_SEPARATOR = ':balance:';
const REVIEW_SEPARATOR = ':review:';
// Filings whose figures come from the checks but carry no amount of their own.
// If the checks behind one change after it was marked done, a review row asks
// the owner to look. A deposit is money only, so it never gets a review row.
const REVIEW_TYPES = new Set(['payroll_941', 'payroll_rt6', 'payroll_940', 'payroll_w2']);
const SOURCE_PREFIX = 'payroll:';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const utc = (s) => new Date(`${s}T00:00:00Z`);
const fromUtc = (d) => ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
const addDays = (s, n) => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
};
const weekday = (s) => utc(s).getUTCDay(); // 0 Sunday .. 6 Saturday
const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// n-th (1-based) given weekday of a month (month 1-12).
function nthWeekday(year, month, wd, n) {
  const first = weekday(ymd(year, month, 1));
  return ymd(year, month, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
}

function lastWeekday(year, month, wd) {
  const last = lastDayOfMonth(year, month);
  const lastWd = weekday(ymd(year, month, last));
  return ymd(year, month, last - ((lastWd - wd + 7) % 7));
}

// Fixed-date holiday: a Saturday is observed the Friday before, a Sunday the
// Monday after. Returns null for a Saturday January 1 (the Friday is Dec 31 of
// the year before, which the previous year's set carries).
function observed(year, month, day) {
  const s = ymd(year, month, day);
  const wd = weekday(s);
  if (wd === 6) return month === 1 && day === 1 ? null : addDays(s, -1);
  if (wd === 0) return addDays(s, 1);
  return s;
}

// Federal holidays of 5 U.S.C. 6103(a), without Inauguration Day.
function federalHolidays(year) {
  const days = [
    observed(year, 1, 1),
    nthWeekday(year, 1, 1, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 1, 3), // Washington's Birthday
    lastWeekday(year, 5, 1), // Memorial Day
    observed(year, 6, 19), // Juneteenth
    observed(year, 7, 4),
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 10, 1, 2), // Columbus Day
    observed(year, 11, 11),
    nthWeekday(year, 11, 4, 4), // Thanksgiving
    observed(year, 12, 25),
  ];
  // January 1 of the next year on a Saturday is observed Friday, Dec 31.
  if (weekday(ymd(year + 1, 1, 1)) === 6) days.push(ymd(year, 12, 31));
  return days.filter(Boolean);
}

// IRS Pub 509: "any legal holiday in the District of Columbia".
function legalHolidaysIrs(year) {
  const days = federalHolidays(year);
  days.push(observed(year, 4, 16)); // DC Emancipation Day
  if ((year - 1965) % 4 === 0) {
    const inauguration = ymd(year, 1, 20);
    const wd = weekday(inauguration);
    if (wd === 0) days.push(ymd(year, 1, 21));
    else if (wd !== 6) days.push(inauguration);
  }
  return new Set(days);
}

// Florida RT-6 instructions: state or federal holiday.
function legalHolidaysFlorida(year) {
  const days = federalHolidays(year);
  days.push(addDays(nthWeekday(year, 11, 4, 4), 1)); // Friday after Thanksgiving
  return new Set(days);
}

function rollWith(holidaysOf, date) {
  const cache = new Map();
  const holidays = (year) => {
    if (!cache.has(year)) cache.set(year, holidaysOf(year));
    return cache.get(year);
  };
  let day = date;
  for (;;) {
    const wd = weekday(day);
    if (wd !== 0 && wd !== 6 && !holidays(Number(day.slice(0, 4))).has(day)) return day;
    day = addDays(day, 1);
  }
}

const rollIrs = (date) => rollWith(legalHolidaysIrs, date);
const rollFlorida = (date) => rollWith(legalHolidaysFlorida, date);

const dollars = (cents) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${pad(Math.abs(cents) % 100)}`;
const quarterOf = (month) => Math.ceil(month / 3);
const quarterLabel = (year, q) => `Q${q} ${year}`;
const quarterKey = (year, q) => `${year}-Q${q}`;
// The 15th, or the last day, of the month after (year, month).
function nextMonthDay(year, month, day) {
  const y = month === 12 ? year + 1 : year;
  const m = month === 12 ? 1 : month + 1;
  return ymd(y, m, day === 'last' ? lastDayOfMonth(y, m) : day);
}
const afterQuarterDue = (year, q) => nextMonthDay(year, q * 3, 'last');

const num = (v) => Number(v) || 0;
const TAX_COLUMNS = [
  'federal_income_tax_cents', 'social_security_cents', 'medicare_cents',
  'additional_medicare_cents', 'employer_social_security_cents', 'employer_medicare_cents',
];
// Every money column of payroll_checks; the digest covers all of them.
const DIGEST_COLUMNS = [
  'gross_cents', 'regular_pay_cents', 'overtime_pay_cents', 'overtime_premium_cents',
  ...TAX_COLUMNS, 'net_cents', 'futa_cents', 'fl_reemployment_cents', 'ytd_gross_before_cents',
];
// sha256 (first 32 hex) of the sorted [id, pay_date, money columns] list.
function digestOf(checks) {
  const list = checks
    .map((check) => [String(check.id ?? ''), String(check.pay_date).slice(0, 10), ...DIGEST_COLUMNS.map((col) => num(check[col]))])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 32);
}
const taxCents = (check) => TAX_COLUMNS.reduce((sum, col) => sum + num(check[col]), 0);

const zeroTotals = (extra) => ({ tax: 0, futa: 0, reemployment: 0, checks: [], ...extra });

// The periods (month 'YYYY-MM', quarter 'YYYY-Qn', year 'YYYY') of payroll rows
// the owner already marked done, read from their source keys. New hire and FUTA
// alert keys name no period; ':balance:' and ':review:' suffixes are dropped.
function rememberedPeriods(sourceKeys) {
  const out = { months: new Set(), quarters: new Set(), years: new Set() };
  for (const key of sourceKeys) {
    const duty = String(key).split(BALANCE_SEPARATOR)[0].split(REVIEW_SEPARATOR)[0];
    const [, kind, period] = duty.split(':');
    if (kind === '941_deposit' && /^\d{4}-\d{2}$/.test(period || '')) out.months.add(period);
    else if ((kind === '941' || kind === 'rt6') && /^\d{4}-Q[1-4]$/.test(period || '')) out.quarters.add(period);
    else if ((kind === '940' || kind === 'w2') && /^\d{4}$/.test(period || '')) out.years.add(period);
  }
  return out;
}

// Totals by month, quarter and year, keyed from the pay date. A remembered
// period with no finalized check left gets zero totals, so its duties keep
// being checked against the rows already marked done.
function totalsOf(checks, remembered) {
  const months = new Map();
  const quarters = new Map();
  const years = new Map();
  const bump = (map, key, check, extra) => {
    const t = map.get(key) || zeroTotals();
    t.checks.push(check);
    t.tax += taxCents(check);
    t.futa += num(check.futa_cents);
    t.reemployment += num(check.fl_reemployment_cents);
    Object.assign(t, extra);
    map.set(key, t);
  };
  for (const check of checks) {
    const pay = String(check.pay_date).slice(0, 10);
    const year = Number(pay.slice(0, 4));
    const month = Number(pay.slice(5, 7));
    bump(months, `${year}-${pad(month)}`, check, { year, month });
    bump(quarters, quarterKey(year, quarterOf(month)), check, { year, q: quarterOf(month) });
    bump(years, String(year), check, { year });
  }
  for (const key of remembered.months) {
    if (!months.has(key)) months.set(key, zeroTotals({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) }));
  }
  for (const key of remembered.quarters) {
    if (!quarters.has(key)) quarters.set(key, zeroTotals({ year: Number(key.slice(0, 4)), q: Number(key.slice(6, 7)) }));
  }
  for (const key of remembered.years) {
    if (!years.has(key)) years.set(key, zeroTotals({ year: Number(key) }));
  }
  return { months, quarters, years };
}

// a. Monthly federal deposit.
function depositRow(t) {
  const label = `${MONTHS[t.month - 1]} ${t.year}`;
  return {
    source_key: `${SOURCE_PREFIX}941_deposit:${t.year}-${pad(t.month)}`,
    filing_type: 'payroll_941_deposit',
    title: `Federal payroll tax deposit — ${label}`,
    period_label: label,
    due_date: rollIrs(nextMonthDay(t.year, t.month, 15)),
    amount_due: dollars(t.tax),
    source_digest: digestOf(t.checks),
    notes: 'Pay on EFTPS by 8 PM ET the day before the due date (or IRS Direct Pay). Withheld federal income tax plus both halves of Social Security and Medicare.',
  };
}

// b. and c. Form 941 and Florida RT-6 for one quarter (t has no checks: zeros).
function quarterRows(year, q, t) {
  const label = quarterLabel(year, q);
  const source_digest = digestOf(t.checks);
  return [{
    source_key: `${SOURCE_PREFIX}941:${quarterKey(year, q)}`,
    filing_type: 'payroll_941',
    title: `Form 941 — ${label}`,
    period_label: label,
    due_date: rollIrs(afterQuarterDue(year, q)),
    source_digest,
    notes: `Total tax for the quarter: $${dollars(t.tax)}. The monthly deposit rows hold the payments. File by mail or e-file.`,
  }, {
    source_key: `${SOURCE_PREFIX}rt6:${quarterKey(year, q)}`,
    filing_type: 'payroll_rt6',
    title: `Florida RT-6 — ${label}`,
    period_label: label,
    due_date: rollFlorida(afterQuarterDue(year, q)),
    amount_due: dollars(t.reemployment),
    source_digest,
    notes: 'File and pay on the Florida Department of Revenue site. E-pay by 5 PM ET on the business day before the due date. File even with no wages.',
  }];
}

// First quarter with a check or a marked row through the quarter containing
// today (or the last one of those, if that is later).
function quarterSpan(quarters, today) {
  const sorted = [...quarters.values()].sort((a, b) => (a.year - b.year) || (a.q - b.q));
  const last = sorted[sorted.length - 1];
  let endYear = last.year;
  let endQ = last.q;
  const now = String(today || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(now)) {
    const ty = Number(now.slice(0, 4));
    const tq = quarterOf(Number(now.slice(5, 7)));
    if (ty > endYear || (ty === endYear && tq > endQ)) { endYear = ty; endQ = tq; }
  }
  const span = [];
  for (let year = sorted[0].year, q = sorted[0].q; year < endYear || (year === endYear && q <= endQ);) {
    span.push([year, q]);
    if (q === 4) { year += 1; q = 1; } else q += 1;
  }
  return span;
}

// d. FUTA over $500 alert, e. Form 940 and f. W-2/W-3 of one year.
function yearRows(year, yearTotals, quarters) {
  const rows = [];
  let cumulative = 0;
  for (let q = 1; q <= 4; q += 1) {
    cumulative += (quarters.get(quarterKey(year, q)) || { futa: 0 }).futa;
    if (cumulative <= FUTA_ALERT_THRESHOLD_CENTS) continue;
    rows.push({
      source_key: `${SOURCE_PREFIX}futa_over_500:${year}`,
      filing_type: 'payroll_futa_alert',
      title: `FUTA passed $500 — deposit due (Q${q} ${year})`,
      period_label: `Tax Year ${year}`,
      due_date: rollIrs(afterQuarterDue(year, q)),
      notes: `FUTA for the year passed $500 in Q${q}. Deposit the undeposited FUTA on EFTPS by the due date. This calendar does not work out FUTA deposits; check the amount with your accountant.`,
    });
    break;
  }
  const jan31 = rollIrs(ymd(year + 1, 1, 31));
  rows.push({
    source_key: `${SOURCE_PREFIX}940:${year}`,
    filing_type: 'payroll_940',
    title: `Form 940 — Tax Year ${year}`,
    period_label: `Tax Year ${year}`,
    due_date: jan31,
    amount_due: dollars(yearTotals.futa),
    source_digest: digestOf(yearTotals.checks),
    notes: `FUTA for the year: $${dollars(yearTotals.futa)}. Deposits already made reduce what is paid with the return. File by mail or e-file.`,
  }, {
    source_key: `${SOURCE_PREFIX}w2:${year}`,
    filing_type: 'payroll_w2',
    title: `W-2 and W-3 — Tax Year ${year}`,
    period_label: `Tax Year ${year}`,
    due_date: jan31,
    source_digest: digestOf(yearTotals.checks),
    notes: 'File W-2s and the W-3 on SSA Business Services Online; give each employee a W-2 by the same date.',
  });
  return rows;
}

// g. Florida new hire report. A prospective person is not hired yet.
function hireRow(hire) {
  if (hire.employment_type !== 'w2' || hire.employment_status === 'prospective') return null;
  const hired = String(hire.hire_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hired) || hired < NEW_HIRE_FLOOR) return null;
  return {
    source_key: `${SOURCE_PREFIX}new_hire:${hire.id}`,
    filing_type: 'payroll_new_hire',
    title: `Florida new hire report — ${hire.name}`,
    period_label: `Hired ${hired}`,
    due_date: addDays(hired, NEW_HIRE_DAYS),
    notes: 'Report at the Florida New Hire Reporting Center.',
  };
}

/**
 * checks: finalized payroll_checks rows (pay_date 'YYYY-MM-DD' + cents columns).
 * hires: W-2 technicians ({ id, name, hire_date, employment_type, employment_status }).
 * today: 'YYYY-MM-DD' in ET. remembered: source keys of rows already marked
 * done; their periods are covered even when no finalized check is left in them.
 * Returns the obligations sorted by due date.
 */
function payrollObligations({ checks = [], hires = [], today, remembered = [] }) {
  const { months, quarters, years } = totalsOf(checks, rememberedPeriods(remembered));
  const rows = [...months.values()].map(depositRow);
  if (quarters.size) {
    for (const [year, q] of quarterSpan(quarters, today)) {
      rows.push(...quarterRows(year, q, quarters.get(quarterKey(year, q)) || { tax: 0, reemployment: 0, checks: [] }));
    }
  }
  for (const [year, t] of years) rows.push(...yearRows(Number(year), t, quarters));
  for (const hire of hires) {
    const row = hireRow(hire);
    if (row) rows.push(row);
  }
  return rows
    .map((row) => ({ amount_due: null, source_digest: null, ...row }))
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.source_key.localeCompare(b.source_key));
}

const toCents = (v) => Math.round(Number(v) * 100) || 0;

/**
 * Turns the obligations (amount = the full liability) into the rows the
 * calendar should hold, given the rows already marked done (status other than
 * 'upcoming'; each { source_key, amount_paid, amount_due }).
 *   - No marked row for a duty: the base row.
 *   - Marked rows and no amount on the duty (a return, W-2, new hire, FUTA
 *     alert): nothing, the duty is done.
 *   - Marked rows and an amount: what the marked rows cover (amount_paid, else
 *     amount_due) comes off the liability. A positive rest becomes a balance
 *     row '<base>:balance:<count of marked rows>'; otherwise nothing.
 *   - A filing in REVIEW_TYPES whose latest acknowledged state (the marked
 *     review row with the highest number, else the marked base row) holds a
 *     digest different from the current source_digest: a review row
 *     '<base>:review:<highest marked n + 1>' (no amount).
 * Both can apply to one duty (RT-6, Form 940).
 */
// The n of a '<base>:review:<n>' key, else 0.
const reviewNumber = (key) => {
  const m = /:review:(\d+)$/.exec(String(key));
  return m ? Number(m[1]) : 0;
};

function withBalances(obligations, markedRows) {
  const marked = new Map();
  for (const row of markedRows) {
    const duty = String(row.source_key).split(BALANCE_SEPARATOR)[0].split(REVIEW_SEPARATOR)[0];
    if (!marked.has(duty)) marked.set(duty, []);
    marked.get(duty).push(row);
  }
  const wanted = [];
  for (const ob of obligations) {
    const done = marked.get(ob.source_key);
    if (!done) { wanted.push(ob); continue; }
    // The latest acknowledged state of a filing is its marked review row with
    // the highest number, else its marked base row. The number comes from the
    // key, never from a timestamp. A balance row says nothing about the return.
    let latest = null;
    let latestReview = 0;
    for (const row of done) {
      const n = reviewNumber(row.source_key);
      if (n > latestReview) { latestReview = n; latest = row; }
    }
    if (!latest) latest = done.find((row) => row.source_key === ob.source_key) || null;
    if (REVIEW_TYPES.has(ob.filing_type) && ob.source_digest && latest
      && latest.source_digest && latest.source_digest !== ob.source_digest) {
      wanted.push({
        ...ob,
        source_key: `${ob.source_key}${REVIEW_SEPARATOR}${latestReview + 1}`,
        title: `${ob.title} — figures changed after it was marked done`,
        amount_due: null,
        notes: 'A pay run changed after this was marked done. Check the figures; a corrected return may be needed (941-X, RT-8A, amended 940 or W-2c).',
      });
    }
    if (ob.amount_due === null || ob.amount_due === undefined) continue;
    const covered = done.reduce((sum, row) => sum + toCents(row.amount_paid ?? row.amount_due ?? 0), 0);
    const rest = toCents(ob.amount_due) - covered;
    if (rest <= 0) continue;
    wanted.push({
      ...ob,
      source_key: `${ob.source_key}${BALANCE_SEPARATOR}${done.length}`,
      title: `${ob.title} — balance after a correction`,
      amount_due: dollars(rest),
      notes: `${ob.notes} A pay run changed after this was marked done; $${dollars(rest)} more is due. A corrected return may be needed.`,
    });
  }
  return wanted;
}

const CHANGED_FIELDS = ['title', 'period_label', 'due_date', 'amount_due', 'notes', 'source_digest'];
const normalizeAmount = (v) => (v === null || v === undefined ? null : Number(v).toFixed(2));

/**
 * Brings the payroll rows of tax_filing_calendar up to date. Gate off: returns
 * before any query. One transaction under an advisory lock so a finalize hook
 * and the daily job never write the same duty twice.
 */
async function syncPayrollFilings({ conn = db, today = etDateString() } = {}) {
  if (!payrollTaxCalendarLive()) return { skipped: 'gate_off' };
  return conn.transaction(async (trx) => {
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext('payroll-tax-calendar'))");
    const checks = await trx('payroll_checks').where({ status: 'finalized' }).select(
      'id', trx.raw("to_char(pay_date, 'YYYY-MM-DD') AS pay_date"), ...DIGEST_COLUMNS,
    );
    const hires = await trx('technicians')
      .where({ employment_type: 'w2' })
      .whereNot('employment_status', 'prospective')
      .whereNotNull('hire_date')
      .where('hire_date', '>=', NEW_HIRE_FLOOR)
      .select('id', 'name', 'employment_type', 'employment_status', trx.raw("to_char(hire_date, 'YYYY-MM-DD') AS hire_date"));
    const existing = await trx('tax_filing_calendar')
      .where('source_key', 'like', `${SOURCE_PREFIX}%`)
      .select('id', 'source_key', 'status', 'title', 'period_label', 'amount_due', 'amount_paid', 'notes', 'source_digest',
        trx.raw("to_char(due_date, 'YYYY-MM-DD') AS due_date"));
    const markedRows = existing.filter((row) => row.status !== 'upcoming');
    const obligations = withBalances(
      payrollObligations({ checks, hires, today, remembered: markedRows.map((row) => row.source_key) }),
      markedRows,
    );
    const byKey = new Map(existing.map((row) => [row.source_key, row]));
    const result = { inserted: 0, updated: 0, deleted: 0 };

    for (const ob of obligations) {
      const row = byKey.get(ob.source_key);
      if (!row) {
        await trx('tax_filing_calendar').insert({
          filing_type: ob.filing_type, title: ob.title, period_label: ob.period_label,
          due_date: ob.due_date, status: 'upcoming', amount_due: ob.amount_due,
          notes: ob.notes, source_key: ob.source_key, source_digest: ob.source_digest,
        });
        result.inserted += 1;
        continue;
      }
      if (row.status !== 'upcoming') continue;
      const changed = CHANGED_FIELDS.some((field) => (field === 'amount_due'
        ? normalizeAmount(row[field]) !== normalizeAmount(ob[field])
        : (row[field] ?? null) !== (ob[field] ?? null)));
      if (!changed) continue;
      // The status check is in the UPDATE itself: the rows were read without a
      // lock and the filings route does not take this advisory lock, so a row the
      // owner marked filed or paid after the read must be left alone.
      result.updated += await trx('tax_filing_calendar').where({ id: row.id, status: 'upcoming' }).update({
        title: ob.title, period_label: ob.period_label, due_date: ob.due_date,
        amount_due: ob.amount_due, notes: ob.notes, source_digest: ob.source_digest, updated_at: trx.fn.now(),
      });
    }

    const wanted = new Set(obligations.map((ob) => ob.source_key));
    const stale = existing.filter((row) => row.status === 'upcoming' && !wanted.has(row.source_key));
    if (stale.length) {
      // Same guard: never delete a row marked done after the read, and never one
      // that holds something the owner entered (a payment, a date or a
      // confirmation number), even if it was moved back to upcoming.
      result.deleted = await trx('tax_filing_calendar')
        .whereIn('id', stale.map((row) => row.id)).where('status', 'upcoming')
        .whereNull('amount_paid').whereNull('paid_date').whereNull('filed_date').whereNull('confirmation_number')
        .del();
    }
    return result;
  });
}

// The finalize and void hooks and the daily job use this: a calendar problem
// must never fail or roll back a pay run. The log carries no row data.
async function syncPayrollFilingsSafe(opts) {
  try {
    return await syncPayrollFilings(opts);
  } catch (err) {
    logger.warn(`[payroll-tax-calendar] sync failed: ${err.code || err.name || 'error'}`);
    return { failed: true };
  }
}

module.exports = {
  NEW_HIRE_FLOOR,
  legalHolidaysIrs,
  legalHolidaysFlorida,
  rollIrs,
  rollFlorida,
  payrollObligations,
  withBalances,
  syncPayrollFilings,
  syncPayrollFilingsSafe,
};
