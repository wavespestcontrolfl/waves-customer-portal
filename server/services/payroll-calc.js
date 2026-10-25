/**
 * Basic payroll math for Waves' own W-2 employees, one paycheck at a time.
 *
 * Owner 2026-10-25: "can we start building basic now, and add layers to it at
 * later stages?", after "i dont want to pay them 50 a mointh". This replaces
 * the 2026-10-23 ruling to buy Gusto and build nothing. In the basic plan the
 * portal prepares the numbers; the owner pays the employee and makes every tax
 * deposit and filing himself. Layer 1 is this pure calculator: nothing calls
 * it yet, and it reads and writes nothing.
 *
 * For one pay period it returns:
 * - Gross pay: regular minutes at the hourly rate, overtime minutes at 1.5
 *   times it. The overtime premium (the extra half) is also returned on its
 *   own, because from tax year 2026 the W-2 reports qualified overtime
 *   compensation (IRS Pub. 15-T (2026), What's New).
 * - Federal income tax withholding: Pub. 15-T (2026) Worksheet 1A with the
 *   Percentage Method Tables for Automated Payroll Systems, for a Form W-4
 *   from 2020 or later only. A new hire signs the current form, so the
 *   allowance-based method for 2019 and earlier forms is not built.
 * - Social Security (6.2%, up to the year's wage base) and Medicare (1.45%),
 *   each paid by both the employee and Waves, plus the employee-only 0.9%
 *   Additional Medicare Tax on wages over $200,000 in the calendar year.
 * - Employer-only taxes on the first $7,000 of each employee's wages in the
 *   calendar year: FUTA at the 0.6% net rate (6.0% less the full 5.4% credit
 *   for paying state unemployment tax on time), and Florida reemployment tax
 *   at the rate Florida assigns the employer (Florida DOR: "The initial tax
 *   rate for new employers is .0270 (2.7%)").
 *
 * The tax year is the pay date's calendar year, because wages are taxed when
 * paid. A pay date in a year without tables throws: the calculator never
 * falls back to an older year's tables. Money is integer cents; each tax line
 * rounds half-up to the cent.
 */
const { payrollUnits } = require('../utils/payroll-units');
const { validCalendarDate } = require('../utils/datetime-et');

const PAY_PERIODS_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };

// Pub. 15-T puts "married filing separately" in the single schedules.
const SCHEDULE_FOR_STATUS = {
  single: 'single',
  married_separately: 'single',
  married_jointly: 'married_jointly',
  head_of_household: 'head_of_household',
};

// Each schedule row: [at least (column A), tentative amount (C), percent (D)],
// in dollars. Column E (the amount the wage exceeds) always equals column A.
const TAX_YEARS = {
  2026: {
    // IRS Pub. 15-T (2026), Worksheet 1A line 1g: used only when the Step 2
    // box of Form W-4 is not checked.
    noCheckboxAdjustment: { married_jointly: 12900, single: 8600, head_of_household: 8600 },
    // IRS Pub. 15-T (2026), 2026 Percentage Method Tables for Automated
    // Payroll Systems.
    standard: {
      married_jointly: [
        [0, 0, 0], [19300, 0, 10], [44100, 2480, 12], [120100, 11600, 22],
        [230700, 35932, 24], [422850, 82048, 32], [531750, 116896, 35], [788000, 206583.50, 37],
      ],
      single: [
        [0, 0, 0], [7500, 0, 10], [19900, 1240, 12], [57900, 5800, 22],
        [113200, 17966, 24], [209275, 41024, 32], [263725, 58448, 35], [648100, 192979.25, 37],
      ],
      head_of_household: [
        [0, 0, 0], [15550, 0, 10], [33250, 1770, 12], [83000, 7740, 22],
        [121250, 16155, 24], [217300, 39207, 32], [271750, 56631, 35], [656150, 191171, 37],
      ],
    },
    step2Checkbox: {
      married_jointly: [
        [0, 0, 0], [16100, 0, 10], [28500, 1240, 12], [66500, 5800, 22],
        [121800, 17966, 24], [217875, 41024, 32], [272325, 58448, 35], [400450, 103291.75, 37],
      ],
      single: [
        [0, 0, 0], [8050, 0, 10], [14250, 620, 12], [33250, 2900, 22],
        [60900, 8983, 24], [108938, 20512, 32], [136163, 29224, 35], [328350, 96489.63, 37],
      ],
      head_of_household: [
        [0, 0, 0], [12075, 0, 10], [20925, 885, 12], [45800, 3870, 22],
        [64925, 8077.50, 24], [112950, 19603.50, 32], [140175, 28315.50, 35], [332375, 95585.50, 37],
      ],
    },
    // IRS Topic 751: the 2026 Social Security wage base.
    socialSecurityWageBase: 184500,
  },
};

// Rates in basis points (1/100 of a percent).
const SOCIAL_SECURITY_BP = 620n;
const MEDICARE_BP = 145n;
const ADDITIONAL_MEDICARE_BP = 90n;
const ADDITIONAL_MEDICARE_THRESHOLD_CENTS = 20000000n;
const FUTA_BP = 60n;
const STATE_AND_FUTA_WAGE_BASE_CENTS = 700000n;
const FLORIDA_NEW_EMPLOYER_RATE_BP = 270;

const max0 = (n) => (n > 0n ? n : 0n);
const min = (a, b) => (a < b ? a : b);

// Half-up division for non-negative BigInts.
function roundDiv(numerator, denominator) {
  const quotient = numerator / denominator;
  return (numerator % denominator) * 2n >= denominator ? quotient + 1n : quotient;
}

function nonNegativeCents(value, label) {
  const cents = payrollUnits(value);
  if (cents < 0n) throw new Error(`${label} cannot be negative`);
  return cents;
}

function schedulesForYear(year) {
  const tables = TAX_YEARS[year];
  if (!tables) throw new Error(`No federal withholding tables for ${year} yet`);
  const toCents = (rows) => rows.map(([atLeast, tentative, percent]) => [
    payrollUnits(atLeast), payrollUnits(tentative), BigInt(percent) * 100n,
  ]);
  const mapSchedules = (byStatus) => Object.fromEntries(
    Object.entries(byStatus).map(([status, rows]) => [status, toCents(rows)]),
  );
  return {
    noCheckboxAdjustment: Object.fromEntries(
      Object.entries(tables.noCheckboxAdjustment).map(([s, v]) => [s, payrollUnits(v)]),
    ),
    standard: mapSchedules(tables.standard),
    step2Checkbox: mapSchedules(tables.step2Checkbox),
    socialSecurityWageBase: payrollUnits(tables.socialSecurityWageBase),
  };
}

// Pub. 15-T (2026) Worksheet 1A, 2020-or-later Form W-4. Lines are cents.
function incomeTaxWithholding(wagesCents, periods, w4, tables) {
  if (w4.exempt) return { withheld: 0n, lines: { exempt: true } };
  const schedule = SCHEDULE_FOR_STATUS[w4.filingStatus];
  const line1c = wagesCents * periods;
  const line1d = nonNegativeCents(w4.step4aOtherIncome, 'W-4 Step 4(a)');
  const line1e = line1c + line1d;
  const line1f = nonNegativeCents(w4.step4bDeductions, 'W-4 Step 4(b)');
  const line1g = w4.step2Checkbox ? 0n : tables.noCheckboxAdjustment[schedule];
  const line1h = line1f + line1g;
  const line1i = max0(line1e - line1h);
  const rows = (w4.step2Checkbox ? tables.step2Checkbox : tables.standard)[schedule];
  const [atLeast, tentative, percentBp] = rows.reduce((found, row) => (line1i >= row[0] ? row : found));
  // The annual tentative amount (lines 2c + 2f) scaled by 10,000 (cents times
  // basis points), divided by the pay periods and rounded to the cent (2h).
  const line2h = roundDiv(tentative * 10000n + (line1i - atLeast) * percentBp, periods * 10000n);
  const line3a = nonNegativeCents(w4.step3Amount, 'W-4 Step 3');
  const line3b = roundDiv(line3a, periods);
  const line3c = max0(line2h - line3b);
  const line4a = nonNegativeCents(w4.step4cExtraWithholding, 'W-4 Step 4(c)');
  const line4b = line3c + line4a;
  return {
    withheld: line4b,
    lines: { line1a: wagesCents, line1c, line1d, line1e, line1f, line1g, line1h, line1i, line2h, line3a, line3b, line3c, line4a, line4b },
  };
}

function validateW4(w4) {
  if (!w4) throw new Error('No Form W-4 on file');
  if (!(Number(w4.formYear) >= 2020)) {
    throw new Error('Only a 2020 or later Form W-4 is supported');
  }
  if (!SCHEDULE_FOR_STATUS[w4.filingStatus]) {
    throw new Error(`Unknown W-4 filing status: ${w4.filingStatus}`);
  }
}

function taxYearOf(payDate) {
  const date = validCalendarDate(payDate);
  if (!date) throw new Error('payDate must be a real YYYY-MM-DD date');
  return Number(date.slice(0, 4));
}

const toNumbers = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]),
);

/**
 * One paycheck. Amounts in dollars and minutes may be numbers or the decimal
 * strings Postgres NUMERIC columns return. ytdGrossWages is the employee's
 * gross wages already paid in the same calendar year, before this paycheck.
 * reemploymentRateBp is Florida's rate for Waves in basis points (270 = 2.7%).
 * All returned money is integer cents.
 */
function computePaycheck({
  payDate,
  payFrequency = 'weekly',
  hourlyRate,
  regularMinutes = 0,
  overtimeMinutes = 0,
  ytdGrossWages = 0,
  w4,
  reemploymentRateBp = FLORIDA_NEW_EMPLOYER_RATE_BP,
}) {
  const taxYear = taxYearOf(payDate);
  const tables = schedulesForYear(taxYear);
  const periods = PAY_PERIODS_PER_YEAR[payFrequency];
  if (!periods) throw new Error(`Unknown pay frequency: ${payFrequency}`);
  validateW4(w4);
  const rateCents = payrollUnits(hourlyRate);
  if (rateCents <= 0n) throw new Error('No pay rate set');
  if (!Number.isInteger(reemploymentRateBp) || reemploymentRateBp < 0) {
    throw new Error('reemploymentRateBp must be a whole number of basis points');
  }

  // Minutes arrive in hundredths (payrollUnits); hours = minutes / 60.
  const regularHundredths = nonNegativeCents(regularMinutes, 'Regular minutes');
  const overtimeHundredths = nonNegativeCents(overtimeMinutes, 'Overtime minutes');
  const regularPay = roundDiv(rateCents * regularHundredths, 6000n);
  const overtimePay = roundDiv(rateCents * overtimeHundredths * 3n, 12000n);
  const overtimePremium = roundDiv(rateCents * overtimeHundredths, 12000n);
  const gross = regularPay + overtimePay;

  const ytd = nonNegativeCents(ytdGrossWages, 'Year-to-date wages');
  const socialSecurityWages = min(gross, max0(tables.socialSecurityWageBase - ytd));
  const socialSecurity = roundDiv(socialSecurityWages * SOCIAL_SECURITY_BP, 10000n);
  const medicare = roundDiv(gross * MEDICARE_BP, 10000n);
  const additionalMedicareWages = max0(ytd + gross - ADDITIONAL_MEDICARE_THRESHOLD_CENTS)
    - max0(ytd - ADDITIONAL_MEDICARE_THRESHOLD_CENTS);
  const additionalMedicare = roundDiv(additionalMedicareWages * ADDITIONAL_MEDICARE_BP, 10000n);
  const capWages = min(gross, max0(STATE_AND_FUTA_WAGE_BASE_CENTS - ytd));
  const futa = roundDiv(capWages * FUTA_BP, 10000n);
  const floridaReemployment = roundDiv(capWages * BigInt(reemploymentRateBp), 10000n);

  const { withheld, lines } = incomeTaxWithholding(gross, BigInt(periods), w4, tables);
  // A tiny check with extra Step 4(c) withholding can owe more than it pays.
  // Withhold what the check covers and report the rest; never a negative net.
  const available = max0(gross - socialSecurity - medicare - additionalMedicare);
  const federalIncomeTax = min(withheld, available);

  return {
    taxYear,
    payPeriodsPerYear: periods,
    ...toNumbers({
      hourlyRateCents: rateCents,
      regularPayCents: regularPay,
      overtimePayCents: overtimePay,
      overtimePremiumCents: overtimePremium,
      grossPayCents: gross,
      federalIncomeTaxCents: federalIncomeTax,
      federalIncomeTaxShortfallCents: withheld - federalIncomeTax,
      socialSecurityEmployeeCents: socialSecurity,
      medicareEmployeeCents: medicare,
      additionalMedicareCents: additionalMedicare,
      netPayCents: gross - federalIncomeTax - socialSecurity - medicare - additionalMedicare,
      socialSecurityEmployerCents: socialSecurity,
      medicareEmployerCents: medicare,
      futaCents: futa,
      floridaReemploymentCents: floridaReemployment,
    }),
    taxableWages: toNumbers({
      socialSecurityCents: socialSecurityWages,
      medicareCents: gross,
      additionalMedicareCents: additionalMedicareWages,
      futaCents: capWages,
      floridaReemploymentCents: capWages,
    }),
    withholdingWorksheet: toNumbers(lines),
  };
}

module.exports = { computePaycheck, TAX_YEARS, PAY_PERIODS_PER_YEAR };
