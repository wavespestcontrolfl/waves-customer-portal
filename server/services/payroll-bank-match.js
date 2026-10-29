/**
 * Payroll bank match (GATE_PAYROLL_BANK_MATCH, owner 2026-10-28, payroll item 8):
 * the PURE rules that pair a bank line with a finalized paycheck or a payroll tax
 * payment. No database access here; server/services/bank-import.js loads the
 * candidates, asks these functions for a plan, and does the claim with the same
 * guards its expense and payout matches use (repo rule 15: one matcher).
 *
 * Policy (repo rule 14): an exact, one-to-one pair auto-links. Anything else
 * (several checks with one amount, several bank lines with one amount, a check
 * number that disagrees, an amount one cent away) is a SUGGESTION for the owner.
 *
 *   Net pay        a debit on a business account equal to a finalized, not-voided
 *                  check's net_cents, dated pay_date - 3 days to pay_date + 45 days
 *                  (a paper check clears late); a bank transfer window is
 *                  pay_date - 3 to pay_date + 7.
 *   Federal tax    an IRS / EFTPS debit equal to a payroll:941_deposit calendar row.
 *   Florida RT-6   a Florida Department of Revenue debit equal to a payroll:rt6 row.
 *   FUTA           not matched: the calendar writes a FUTA alert row with no amount.
 */

const NET_PAY_DAYS_BEFORE = 3;
const NET_PAY_DAYS_AFTER_CHECK = 45;
const NET_PAY_DAYS_AFTER_TRANSFER = 7;
const TAX_DAYS_AFTER_DUE = 14;
// A one-cent miss is a lead for the owner, never a match.
const NEAR_MISS_CENTS = 1;
const SUGGESTION_CAP = 10;

// IRS payments as a bank statement prints them: EFTPS, IRS Direct Pay (USATAXPYMT)
// and "US TREASURY ... TAX PYMT" style lines.
const FEDERAL_TAX_RE = /\b(usa\s*tax\s*pymt|usataxpymt|eftps|irs\s+(usa\s*)?tax\s*(pymt|payment)|irs\s+treas\s*\d*\s*tax\s*(pymt|payment)|irs\s+direct\s*pay|us\s+treasury.{0,30}\b(irs|tax))\b/i;
// Florida Department of Revenue. A sales and use tax payment goes to the same agency,
// so a description that says sales tax is never an RT-6.
const FLORIDA_DOR_RE = /\b(fl(orida)?\s+(dept|department)\.?\s+(of\s+)?rev(enue)?|fl\s*dor|fldor|florida\s+revenue|floridarevenue|state\s+of\s+fl(orida)?.{0,20}revenue)\b/i;
const SALES_TAX_RE = /\bsales\b|\bdr-?15\b|\buse\s+tax\b/i;

const centsOf = (amount) => Math.round(Number(amount) * 100);
const day = (v) => String(v).slice(0, 10);

function addDays(dateStr, days) {
  const d = new Date(`${day(dateStr)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Any tax-agency debit, payroll tax or not (IRS, Florida DOR including its sales tax payment, DR-15): never net pay.
function isTaxAgencyLine(description) {
  const text = String(description || '');
  return FEDERAL_TAX_RE.test(text) || FLORIDA_DOR_RE.test(text) || /\bsales\s*(and\s+use\s*)?tax\b|\bdr-?15\b|\buse\s+tax\b/i.test(text);
}

function taxPaymentKind(description) {
  const text = String(description || '');
  if (FEDERAL_TAX_RE.test(text)) return 'federal';
  if (FLORIDA_DOR_RE.test(text) && !SALES_TAX_RE.test(text)) return 'florida';
  return null;
}

// The numbers a statement line prints after "check" / "chk" / "check #".
function checkNumbersIn(description) {
  const out = [];
  const re = /\b(?:check|chk|ck)\s*(?:no\.?|number|#)?\s*0*(\d{1,10})\b/gi;
  let m = re.exec(String(description || ''));
  while (m) { out.push(m[1]); m = re.exec(String(description || '')); }
  return out;
}

const stripZeros = (v) => String(v || '').trim().replace(/^0+(?=\d)/, '');

// Does the line PRINT this check number (the number after CHECK / CHK / CK #)? A number anywhere else in
// the description (a reference, a store number) is not evidence: "CHECK 1099 REF 1042" prints 1099.
function carriesCheckNumber(description, checkNumber) {
  const wanted = stripZeros(checkNumber);
  if (!wanted || !/^\d+$/.test(wanted)) return false;
  return checkNumbersIn(description).map(stripZeros).includes(wanted);
}

function netPayWindow(check) {
  const payDate = day(check.pay_date);
  const after = check.pay_method === 'bank_transfer' ? NET_PAY_DAYS_AFTER_TRANSFER : NET_PAY_DAYS_AFTER_CHECK;
  return { from: addDays(payDate, -NET_PAY_DAYS_BEFORE), to: addDays(payDate, after) };
}

// 'payroll:941_deposit:2026-10' and its ':balance:n' rows -> the month; 'payroll:rt6:2026-Q3' -> the quarter.
// start / end are the first and last day of the pay period the row's amount is built from.
function taxFamily(filing) {
  const key = String(filing.source_key || '');
  if (/:review:\d+$/.test(key)) return null;
  const [prefix, kind, period] = key.split(':');
  if (prefix !== 'payroll') return null;
  if (kind === '941_deposit' && /^\d{4}-\d{2}/.test(period || '')) {
    const start = `${period.slice(0, 7)}-01`;
    const nextMonth = new Date(`${start}T00:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    return { tax: 'federal', start, end: addDays(nextMonth.toISOString().slice(0, 10), -1) };
  }
  if (kind === 'rt6' && /^\d{4}-Q[1-4]/.test(period || '')) {
    const q = Number(period.slice(6, 7));
    const start = `${period.slice(0, 4)}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
    const next = new Date(`${start}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 3);
    return { tax: 'florida', start, end: addDays(next.toISOString().slice(0, 10), -1) };
  }
  return null;
}

// A tax payment can be made any time from the start of its period to a little after the due date.
function taxWindow(filing) {
  const family = taxFamily(filing);
  if (!family) return null;
  return { tax: family.tax, from: family.start, to: addDays(filing.due_date, TAX_DAYS_AFTER_DUE), periodEnd: family.end };
}

// While the pay period is still open another run can raise the row's amount, so an exact amount is not yet
// proof. Only a row the owner already recorded paying (amount_paid) is settled before the period ends.
const periodOpen = (filing, window, txnDate) => (filing.amount_paid === null || filing.amount_paid === undefined)
  && day(txnDate) <= window.periodEnd;

// The amount a calendar row stands for: what the owner recorded paying, else what is due.
function filingCents(filing) {
  const amount = filing.amount_paid !== null && filing.amount_paid !== undefined ? filing.amount_paid : filing.amount_due;
  if (amount === null || amount === undefined || amount === '') return null;
  return centsOf(amount);
}

const inWindow = (date, window) => day(date) >= window.from && day(date) <= window.to;
const isBankDebit = (row) => row && row.direction === 'debit' && row.account_type === 'bank';

function checkCandidate(check, row) {
  return {
    kind: 'check',
    id: check.id,
    name: check.employee_name,
    netCents: Number(check.net_cents),
    payDate: day(check.pay_date),
    checkNumber: check.check_number || null,
    ...(centsOf(row.amount) === Number(check.net_cents) ? {} : { nearMiss: true }),
  };
}

function filingCandidate(filing, row) {
  const cents = filingCents(filing);
  return {
    kind: 'tax',
    id: filing.id,
    title: filing.title,
    amountCents: cents,
    dueDate: day(filing.due_date),
    ...(centsOf(row.amount) === cents ? {} : { nearMiss: true }),
  };
}

/**
 * Plan for one bank line against finalized, unmatched paychecks.
 *   row      { id, txn_date, description, amount, direction, account_type }
 *   checks   unmatched finalized checks { id, employee_name, net_cents, pay_date, pay_method, check_number }
 *   peers    the OTHER unmatched bank debits { id, txn_date, description, amount, direction, account_type }
 *   rejected check ids the owner already unlinked from this line
 * Returns { action: 'link', check } | { action: 'suggest', candidates } | { action: 'none' }.
 */
function planNetPay({ row, checks, peers = [], rejected = [] }) {
  if (!isBankDebit(row) || !(Number(row.amount) > 0)) return { action: 'none' };
  // A line that names the IRS or the Florida DOR is a tax payment, whatever its amount: it never becomes net pay.
  if (isTaxAgencyLine(row.description)) return { action: 'none' };
  const cents = centsOf(row.amount);
  const open = checks.filter((c) => !rejected.includes(c.id) && Number(c.net_cents) > 0 && inWindow(row.txn_date, netPayWindow(c)));
  const exact = open.filter((c) => Number(c.net_cents) === cents);
  const near = open.filter((c) => Math.abs(Number(c.net_cents) - cents) === NEAR_MISS_CENTS);
  if (exact.length === 0) {
    return near.length ? { action: 'suggest', candidates: near.slice(0, SUGGESTION_CAP).map((c) => checkCandidate(c, row)) } : { action: 'none' };
  }

  // The line prints a check number. It decides only when it is clear: exactly one paycheck carries that
  // number, the line prints no other number, and no other eligible bank line prints the same number.
  const printed = checkNumbersIn(row.description).map(stripZeros);
  const byNumber = exact.filter((c) => carriesCheckNumber(row.description, c.check_number));
  if (byNumber.length === 1) {
    const [numbered] = byNumber;
    const window = netPayWindow(numbered);
    const sameNumberElsewhere = peers.some((p) => p.id !== row.id && isBankDebit(p) && centsOf(p.amount) === cents
      && inWindow(p.txn_date, window) && carriesCheckNumber(p.description, numbered.check_number));
    const onlyThatNumber = printed.every((n) => n === stripZeros(numbered.check_number));
    if (!sameNumberElsewhere && onlyThatNumber) return { action: 'link', check: numbered };
    return { action: 'suggest', candidates: [checkCandidate(numbered, row)] };
  }
  if (byNumber.length > 1) return { action: 'suggest', candidates: byNumber.slice(0, SUGGESTION_CAP).map((c) => checkCandidate(c, row)) };
  const contradicted = printed.length > 0 && exact.some((c) => c.check_number && !printed.includes(stripZeros(c.check_number)));
  if (contradicted) return { action: 'suggest', candidates: exact.slice(0, SUGGESTION_CAP).map((c) => checkCandidate(c, row)) };

  if (exact.length > 1) return { action: 'suggest', candidates: exact.slice(0, SUGGESTION_CAP).map((c) => checkCandidate(c, row)) };

  // One check, one amount: the line must also be the only open line that could be this check.
  const check = exact[0];
  const window = netPayWindow(check);
  const rivals = peers.filter((p) => p.id !== row.id && isBankDebit(p) && !isTaxAgencyLine(p.description) && centsOf(p.amount) === cents && inWindow(p.txn_date, window));
  if (rivals.length > 0) return { action: 'suggest', candidates: [checkCandidate(check, row)] };
  return { action: 'link', check };
}

/**
 * Plan for one bank line against payroll tax calendar rows (federal deposit, RT-6).
 *   filings  unmatched calendar rows { id, source_key, title, due_date, amount_due, amount_paid }
 * Returns { action: 'link', filing, tax } | { action: 'suggest', candidates } | { action: 'none' }.
 */
function planTaxPayment({ row, filings, peers = [], rejected = [] }) {
  if (!isBankDebit(row) || !(Number(row.amount) > 0)) return { action: 'none' };
  const tax = taxPaymentKind(row.description);
  if (!tax) return { action: 'none' };
  const cents = centsOf(row.amount);
  const open = [];
  for (const filing of filings) {
    if (rejected.includes(filing.id)) continue;
    const window = taxWindow(filing);
    const amount = filingCents(filing);
    if (!window || window.tax !== tax || amount === null || amount <= 0 || !inWindow(row.txn_date, window)) continue;
    open.push({ filing, window, amount });
  }
  const exact = open.filter((o) => o.amount === cents);
  const near = open.filter((o) => Math.abs(o.amount - cents) === NEAR_MISS_CENTS);
  if (exact.length === 0) {
    return near.length ? { action: 'suggest', candidates: near.slice(0, SUGGESTION_CAP).map((o) => filingCandidate(o.filing, row)) } : { action: 'none' };
  }
  if (exact.length > 1) return { action: 'suggest', candidates: exact.slice(0, SUGGESTION_CAP).map((o) => filingCandidate(o.filing, row)) };
  const [only] = exact;
  // Chosen: an exact amount inside a pay period that is still open is a suggestion, not a link.
  if (periodOpen(only.filing, only.window, row.txn_date)) return { action: 'suggest', candidates: [filingCandidate(only.filing, row)] };
  const rivals = peers.filter((p) => p.id !== row.id && isBankDebit(p) && centsOf(p.amount) === cents
    && taxPaymentKind(p.description) === tax && inWindow(p.txn_date, only.window));
  if (rivals.length > 0) return { action: 'suggest', candidates: [filingCandidate(only.filing, row)] };
  return { action: 'link', filing: only.filing, tax };
}

// Server-side check for the owner's own pick: the same amount (one cent of slack) and window rules.
function isPlausibleCheckLink(row, check) {
  return isBankDebit(row) && Math.abs(centsOf(row.amount) - Number(check.net_cents)) <= NEAR_MISS_CENTS
    && inWindow(row.txn_date, netPayWindow(check));
}

function isPlausibleTaxLink(row, filing) {
  const window = taxWindow(filing);
  const amount = filingCents(filing);
  return isBankDebit(row) && !!window && amount !== null && Math.abs(centsOf(row.amount) - amount) <= NEAR_MISS_CENTS
    && inWindow(row.txn_date, window) && taxPaymentKind(row.description) === window.tax;
}

module.exports = {
  NET_PAY_DAYS_BEFORE,
  NET_PAY_DAYS_AFTER_CHECK,
  NET_PAY_DAYS_AFTER_TRANSFER,
  TAX_DAYS_AFTER_DUE,
  taxPaymentKind,
  isTaxAgencyLine,
  checkNumbersIn,
  carriesCheckNumber,
  netPayWindow,
  taxWindow,
  filingCents,
  planNetPay,
  planTaxPayment,
  isPlausibleCheckLink,
  isPlausibleTaxLink,
};
