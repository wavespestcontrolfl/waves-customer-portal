/**
 * Tech Rewards yearly pay statement (Plan D5-6, owner ruling 2026-11-20). One technician's pay for one calendar year,
 * read only: wages, commission, review pay, the health allowance, the season bonus, stay bonus and December gift, Waves'
 * own money on top of pay (its 2% SIMPLE IRA contribution and the HSA money, as each paycheck stored them; the deposits
 * themselves are not recorded in the portal), the taxes withheld, the technician's own SIMPLE IRA savings and net pay.
 * It writes nothing: no pay line, no pay run row, no message.
 *
 * It works nothing out. Every figure is the sum of a figure payroll stored on a paycheck when the pay run was finalized
 * (payroll_checks, written by payroll-runs.js from payroll-calc.js computePaycheck), so a finalized year never changes when a
 * rate, a gate or a setting changes later.
 *
 * Which paychecks: the technician's FINALIZED checks of FINALIZED pay runs with a PAY DATE in the year. Pay counts in the
 * year of its pay date, as on Form W-2 (payroll-form-figures.js readFormFigures) and in a pay stub's year to date
 * (payroll-runs.js getStub). So gross pay here is the year's W-2 box 5 (w2Figures sums the same paychecks), and work done
 * in the last week of December, with a January pay date, shows in the next year's statement. A draft and a voided check never
 * count. Finalized is not the same as sent: a bank-transfer check can still wait for its Mercury send, so the screen says
 * "amounts from finalized paychecks", never "paid".
 *
 * The season bonus, stay bonus and December gift are one stored figure on a check (tech_rewards_cents). The statement splits
 * it by the kind of the paid pay lines the check holds (payroll_pay_lines), the rows payroll paid it from. The rows of
 * `pay` always add up to grossCents: a part no row names (a split that does not add up) goes to otherCents, never away.
 *
 * Not on the statement: the value of benefits Waves buys (dental, vision, disability). Payroll holds no record of them.
 *
 * ONE read-only REPEATABLE READ snapshot covers the reads, so the split and the totals come from the same paychecks.
 *
 * Privacy: the figures are the technician's own totals. No customer name, id or address is read or returned.
 */
const db = require('../models/db');
const { ScoreboardError } = require('./tech-rewards-scoreboard');
const { etDateString } = require('../utils/datetime-et');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRST_YEAR = 2020;
const LAST_YEAR = 2100;

// payroll_checks column -> the statement's name for its yearly sum. A null column (a check made before the column
// existed, or with its gate off) counts as 0.
const CHECK_SUMS = Object.freeze({
  gross_cents: 'gross',
  regular_pay_cents: 'regularPay',
  overtime_pay_cents: 'overtimePay',
  pto_pay_cents: 'ptoPay',
  holiday_pay_cents: 'holidayPay',
  commission_cents: 'commission',
  review_bonus_cents: 'reviewBonus',
  health_allowance_cents: 'healthAllowance',
  tech_rewards_cents: 'techRewards',
  line_overtime_premium_cents: 'lineOvertimePremium',
  hsa_employer_cents: 'hsaEmployer',
  simple_employer_cents: 'simpleEmployer',
  simple_deferral_cents: 'simpleDeferral',
  federal_income_tax_cents: 'federalIncomeTax',
  social_security_cents: 'socialSecurity',
  medicare_cents: 'medicare',
  additional_medicare_cents: 'additionalMedicare',
  net_cents: 'net',
});
// payroll_pay_lines kind -> its row in `pay`.
const REWARD_ROWS = Object.freeze({ season_bonus: 'seasonBonusCents', stay_bonus: 'stayBonusCents', december_gift: 'decemberGiftCents' });

const cents = (value) => Number(value) || 0;

/** The year asked for: none = the current year in Eastern time. Anything but a four-digit year from 2020 to 2100 is a 400. */
function parseYear(input, today) {
  if (input === undefined || input === null || input === '') return Number(today.slice(0, 4));
  const text = String(input);
  if (!/^\d{4}$/.test(text) || Number(text) < FIRST_YEAR || Number(text) > LAST_YEAR) {
    throw new ScoreboardError(400, 'INVALID_YEAR', 'Year must be a four-digit year, 2020 or later.');
  }
  return Number(text);
}

/**
 * The statement from the year's sums. Pure. `sums` holds the CHECK_SUMS names plus checkCount, firstPayDate and
 * lastPayDate; `rewards` is cents by pay line kind; `years` the years the technician has a paycheck in.
 */
function composeStatement({ technician, year, currentYear, sums, rewards = {}, years = [] }) {
  const pay = {
    regularPayCents: cents(sums.regularPay),
    overtimePayCents: cents(sums.overtimePay),
    ptoPayCents: cents(sums.ptoPay),
    holidayPayCents: cents(sums.holidayPay),
    commissionCents: cents(sums.commission),
    reviewBonusCents: cents(sums.reviewBonus),
    healthAllowanceCents: cents(sums.healthAllowance),
    ...Object.fromEntries(Object.entries(REWARD_ROWS).map(([kind, key]) => [key, cents(rewards[kind])])),
    lineOvertimePremiumCents: cents(sums.lineOvertimePremium),
  };
  const grossCents = cents(sums.gross);
  const named = Object.values(pay).reduce((total, value) => total + value, 0);
  const fromWaves = { simpleEmployerCents: cents(sums.simpleEmployer), hsaEmployerCents: cents(sums.hsaEmployer) };
  // Medicare is one line on a stub's year: the regular tax and the additional 0.9% together (W-2 box 6).
  const withheld = {
    federalIncomeTaxCents: cents(sums.federalIncomeTax),
    socialSecurityCents: cents(sums.socialSecurity),
    medicareCents: cents(sums.medicare) + cents(sums.additionalMedicare),
  };
  return {
    technician: { id: technician.id, name: technician.name },
    year,
    // The picker's years, newest first: every year with a paycheck, and always this year and the one shown.
    years: [...new Set([...years, currentYear, year])].sort((a, b) => b - a),
    checkCount: cents(sums.checkCount),
    firstPayDate: sums.firstPayDate || null,
    lastPayDate: sums.lastPayDate || null,
    pay: { ...pay, otherCents: grossCents - named, grossCents },
    fromWaves,
    totalCents: grossCents + fromWaves.simpleEmployerCents + fromWaves.hsaEmployerCents,
    withheld: { ...withheld, totalCents: withheld.federalIncomeTaxCents + withheld.socialSecurityCents + withheld.medicareCents },
    simpleSavingsCents: cents(sums.simpleDeferral),
    netCents: cents(sums.net),
  };
}

// The technician's paychecks that count: finalized checks of finalized pay runs.
const finalChecks = (conn, technicianId) => conn('payroll_checks as c')
  .join('payroll_runs as r', 'r.id', 'c.run_id')
  .where({ 'c.technician_id': technicianId, 'c.status': 'finalized', 'r.status': 'finalized' });
const inYear = (query, year) => query.where('c.pay_date', '>=', `${year}-01-01`).where('c.pay_date', '<=', `${year}-12-31`);

async function readStatement(conn, technicianId, year, currentYear) {
  const technician = await conn('technicians').where({ id: technicianId }).first('id', 'name');
  if (!technician) throw new ScoreboardError(404, 'NOT_FOUND', 'Technician not found.');
  const sums = await inYear(finalChecks(conn, technicianId), year).first(
    conn.raw('COUNT(*)::int AS "checkCount"'),
    conn.raw(`to_char(MIN(c.pay_date), 'YYYY-MM-DD') AS "firstPayDate"`),
    conn.raw(`to_char(MAX(c.pay_date), 'YYYY-MM-DD') AS "lastPayDate"`),
    ...Object.entries(CHECK_SUMS).map(([column, name]) => conn.raw('COALESCE(SUM(c.??), 0) AS ??', [column, name])),
  );
  const rewardRows = await inYear(finalChecks(conn, technicianId), year)
    .join('payroll_pay_lines as l', 'l.check_id', 'c.id')
    .where('l.status', 'paid')
    .whereIn('l.kind', Object.keys(REWARD_ROWS))
    .groupBy('l.kind')
    .select('l.kind', conn.raw('SUM(l.amount_cents) AS cents'));
  const yearRows = await finalChecks(conn, technicianId)
    .distinct(conn.raw('EXTRACT(YEAR FROM c.pay_date)::int AS year'));
  return composeStatement({
    technician,
    year,
    currentYear,
    sums,
    rewards: Object.fromEntries(rewardRows.map((row) => [row.kind, row.cents])),
    years: yearRows.map((row) => row.year),
  });
}

/**
 * One technician's statement for a year. `technicianId` must be a uuid (ScoreboardError 400); an unknown technician is
 * 404; `year` is a query-string value (parseYear). `now` is for tests (a Date). One REPEATABLE READ, read-only transaction.
 */
async function getYearStatement(technicianId, year, { now = new Date() } = {}) {
  if (typeof technicianId !== 'string' || !UUID_RE.test(technicianId)) throw new ScoreboardError(400, 'INVALID_TECHNICIAN', 'Technician id is not valid.');
  const today = etDateString(now);
  const asked = parseYear(year, today);
  return db.transaction((trx) => readStatement(trx, technicianId.toLowerCase(), asked, Number(today.slice(0, 4))), { isolationLevel: 'repeatable read', readOnly: true });
}

module.exports = { getYearStatement, composeStatement, parseYear };
