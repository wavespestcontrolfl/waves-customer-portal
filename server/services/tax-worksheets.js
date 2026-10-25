/**
 * Sales tax (Florida DR-15) and 1099-NEC worksheets for the Tax area,
 * GATE_TAX_WORKSHEETS (nested under GATE_BANK_IMPORT). Both read the books
 * only; the one write on these screens is Mark filed, through the filing
 * calendar's own PUT /filings/:id.
 *
 * DR-15: gross sales are the P&L revenue for the period (receipts less the
 * sales tax inside them), and the tax, its taxable base and its county surtax
 * come from salesTaxLegsForWindow, the figures the P&L itself backs out, so
 * the worksheet, the P&L and the return engine never disagree. Exempt sales
 * are the rest: residential work, which Florida does not tax.
 *
 * 1099-NEC: contract labor (Schedule C line 11) and legal and professional
 * (line 17) payments, grouped by payee. Card, debit card and platform
 * payments are left out: the card network or the platform reports them on a
 * 1099-K. Payee names come from the bank text (the vendor name a bank-import
 * expense carries); W-9s and name corrections are a later phase.
 */
const db = require('../models/db');
const { buildPnlReport, salesTaxLegsForWindow, dateCellStr } = require('./pnl-report');
const sharedBills = require('./tax-shared-bills');
const { etDateString } = require('../utils/datetime-et');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const money = (n) => `$${round2(n).toFixed(2)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Florida's DR-15 filing frequencies: monthly, quarterly, semiannual, annual.
// A month's label is the filing calendar's period_label ("Oct 2026").
const PERIOD_KINDS = {
  month: { count: 12, months: 1, label: (y, i) => `${MONTHS[i - 1]} ${y}` },
  quarter: { count: 4, months: 3, label: (y, i) => `Q${i} ${y}` },
  half: { count: 2, months: 6, label: (y, i) => `H${i} ${y}` },
  year: { count: 1, months: 12, label: (y) => `${y}` },
};

// DR-15N: the collection allowance is 2.5% of the first $1,200 of tax due ($30
// at most), only on a return filed electronically and paid on time. A late
// return owes 10% of the tax due, at least $50 even when no tax is due; DOR
// adds the interest itself.
const ALLOWANCE_RATE = 0.025;
const ALLOWANCE_TAX_CAP = 1200;
const PENALTY_RATE = 0.10;
const PENALTY_MIN = 50;

// A return or form due on a weekend or a state or federal holiday is due the
// next business day (DR-15N; IRS for the 1099-NEC). Holidays: the federal list
// (5 U.S.C. 6103; a Saturday holiday is observed Friday, a Sunday one Monday)
// plus Florida's day after Thanksgiving.
const FIXED_HOLIDAYS = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]];
// [month, weekday (0 = Sunday), nth (-1 = last)]: MLK, Washington, Memorial,
// Labor, Columbus, Thanksgiving
const FLOATING_HOLIDAYS = [[1, 1, 3], [2, 1, 3], [5, 1, -1], [9, 1, 1], [10, 1, 2], [11, 4, 4]];

function nthWeekday(y, m, weekday, n) {
  if (n < 0) {
    const last = lastDay(y, m);
    return last - ((new Date(Date.UTC(y, m - 1, last)).getUTCDay() - weekday + 7) % 7);
  }
  return 1 + ((weekday - new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 7) % 7) + (n - 1) * 7;
}

function observed(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ({ 6: -1, 0: 1 }[d.getUTCDay()] || 0));
  return d.toISOString().slice(0, 10);
}

function holidays(y) {
  const thanksgiving = nthWeekday(y, 11, 4, 4);
  return new Set([
    // next year's New Year's Day can be observed on Dec 31 of this year
    ...[...FIXED_HOLIDAYS.map(([m, d]) => isoDate(y, m, d)), isoDate(y + 1, 1, 1)].map(observed),
    ...FLOATING_HOLIDAYS.map(([m, wd, n]) => isoDate(y, m, nthWeekday(y, m, wd, n))),
    isoDate(y, 11, thanksgiving + 1),
  ]);
}

function nextBusinessDay(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  const closed = () => [0, 6].includes(d.getUTCDay()) || holidays(d.getUTCFullYear()).has(d.toISOString().slice(0, 10));
  while (closed()) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function periodFor(kind, year, index) {
  const k = PERIOD_KINDS[kind];
  if (!k) throw sharedBills.httpError(400, 'kind must be month, quarter, half or year');
  const y = sharedBills.parseYear(year);
  const i = kind === 'year' ? 1 : Number(index);
  if (!Number.isInteger(i) || i < 1 || i > k.count) {
    throw sharedBills.httpError(400, `index must be a whole number from 1 to ${k.count} for a ${kind}`);
  }
  const first = (i - 1) * k.months + 1;
  const last = first + k.months - 1;
  return {
    kind, year: y, index: kind === 'year' ? null : i, label: k.label(y, i),
    start: isoDate(y, first, 1), end: isoDate(y, last, lastDay(y, last)),
  };
}

// A DR-15 is due on the 20th of the month after the period.
function dr15DueDate(periodEnd) {
  const [y, m] = periodEnd.split('-').map(Number);
  return nextBusinessDay(m === 12 ? isoDate(y + 1, 1, 20) : isoDate(y, m + 1, 20));
}

// The DR-15 lines from the period's figures. A return is on time only when it
// is filed AND its tax is paid by the due date: `filedOn` and `paidOn` come
// from the filing calendar row, and a missing one is judged from `today`.
function dr15Lines({ grossSales, taxable, tax, surtax, dueDate, today, filedOn = null, paidOn = null }) {
  const taxDue = Math.max(0, round2(tax));
  const late = (filedOn || today) > dueDate || (taxDue > 0 && (paidOn || today) > dueDate);
  const allowance = late ? 0 : round2(ALLOWANCE_RATE * Math.min(taxDue, ALLOWANCE_TAX_CAP));
  const penalty = late ? round2(Math.max(PENALTY_MIN, PENALTY_RATE * taxDue)) : 0;
  return {
    late,
    lines: {
      gross_sales: round2(grossSales),
      exempt_sales: round2(Math.max(0, grossSales - taxable)),
      taxable_amount: round2(taxable),
      tax_collected: taxDue,
      surtax_collected: round2(surtax),
      collection_allowance: allowance,
      penalty,
      amount_due: round2(taxDue - allowance + penalty),
    },
    allowance_note: late
      ? `None: the return is past its ${dueDate} due date.`
      : `If you e-file and pay by ${dueDate}: 2.5% of the first $1,200 of tax, $30 at most.`,
    penalty_note: late
      ? 'Late: 10% of the tax due, at least $50 even with no tax due. DOR can waive it on request.'
      : `None if you file and pay by ${dueDate}.`,
  };
}

function filingOut(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    period_label: row.period_label,
    due_date: dateCellStr(row.due_date) || null,
    filed_date: dateCellStr(row.filed_date) || null,
    paid_date: dateCellStr(row.paid_date) || null,
    amount_paid: row.amount_paid == null ? null : Number(row.amount_paid),
    confirmation_number: row.confirmation_number || null,
  };
}

async function salesTaxSheet({ kind = 'month', year, index } = {}) {
  const period = periodFor(kind, year, index);
  const today = etDateString();
  if (period.start > today) throw sharedBills.httpError(400, `${period.label} has not started`);
  const [pnl, legs, filingRow] = await Promise.all([
    buildPnlReport(db, period.start, period.end),
    salesTaxLegsForWindow(db, period.start, period.end),
    db('tax_filing_calendar').where({ filing_type: 'dr15_sales_tax', period_label: period.label }).first(),
  ]);
  const filing = filingOut(filingRow);
  const filedOn = filing && ['filed', 'paid'].includes(filing.status) ? (filing.filed_date || filing.paid_date) : null;
  const paidOn = filing?.paid_date || null;
  const dueDate = dr15DueDate(period.end);
  const grossSales = Number(pnl.revenue?.total) || 0;
  const sheet = dr15Lines({ grossSales, taxable: legs.taxable, tax: legs.tax, surtax: legs.surtax, dueDate, today, filedOn, paidOn });
  const warnings = [
    period.end >= today && { code: 'in_progress', text: `This period runs to ${period.end}; the figures will change.` },
    pnl.coverage?.complete === false && { code: 'pnl_coverage', text: `Sales may be incomplete: ${pnl.coverage.note}` },
    legs.taxable > grossSales && { code: 'taxable_over_gross', text: `The taxable amount (${money(legs.taxable)}) is more than gross sales (${money(grossSales)}). Check the period's refunds and credits.` },
  ].filter(Boolean);
  return { period: { ...period, in_progress: period.end >= today }, due_date: dueDate, ...sheet, filing, warnings };
}

// 1099-NEC threshold: $600 for payments through 2025, $2,000 for payments made
// after 2025 (P.L. 119-21; indexed for inflation after 2026). Due Jan 31 of
// the next year, or the next business day.
const necThreshold = (year) => (year >= 2026 ? 2000 : 600);
const necDueDate = (year) => nextBusinessDay(isoDate(year + 1, 1, 31));

const SCHEDULE_C_1099_LINES = ['11', '17'];
const LEFT_OUT_CHANNELS = new Set(['card', 'debit_card', 'platform']);

// How a payment left the business: the expense's payment method first, then
// the bank text, first match wins. Fiverr and Upwork come before the payment
// apps because they file 1099-Ks for the work bought through them.
const CHANNEL_RULES = [
  ['platform', /\b(?:fiverr|upwork)\b/i],
  ['zelle', /\bzelle\b/i],
  ['venmo', /\bvenmo\b/i],
  ['cash_app', /cash\s*app|square\s*cash/i],
  ['paypal', /\bpaypal\b/i],
  ['wise', /\bwise\b|transferwise/i],
  ['debit_card', /debit\s*card|card\s+purchase|\bpos\b|checkcard/i],
  ['check', /\bche(?:ck|que)\b|\bchk\b/i],
  ['bank_transfer', /transfer|\bach\b|\bwire\b|bill\s*pay/i],
];

function paymentChannel(paymentMethod, text) {
  const method = String(paymentMethod || '').toLowerCase();
  if (['card', 'cash', 'check'].includes(method)) return method;
  const hit = CHANNEL_RULES.find(([, re]) => re.test(String(text || '')));
  return hit ? hit[0] : 'unknown';
}

// The payee inside a bank text: "Zelle money sent to Pat Example" gives
// "Pat Example". A check or a Wise transfer does not name the person paid:
// such a payment is never added to anyone else's and is marked unresolved.
const PAYEE_PATTERNS = [
  /\bzelle\b(?:\s+money)?(?:\s+sent)?(?:\s+payment)?\s+to\s+(.+)/i,
  /\bvenmo\b(?:\s+payment)?(?:\s+to)?\s+(.+)/i,
  /cash\s*app\*?\s*(?:to\s+)?(.+)/i,
  /\bpaypal\s*\*\s*(.+)/i,
];
const NO_PAYEE = [/\bwise\b|transferwise/i, /^\s*che(?:ck|que)\b|^\s*chk\b/i];
const REFERENCE_TAIL = /\s+(?:conf(?:irmation)?|ref(?:erence)?|id|trn|txn)\b.*$/i;
const tidy = (text) => text.replace(REFERENCE_TAIL, '').replace(/\b\d{5,}\b/g, '').replace(/[\s,.-]+$/, '').replace(/\s+/g, ' ').trim();

function payeeOf(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const pattern = PAYEE_PATTERNS.map((re) => re.exec(raw)).find(Boolean);
  if (!pattern && NO_PAYEE.some((re) => re.test(raw))) return { name: `${tidy(raw)} (payee not in the bank text)`, identified: false };
  const name = tidy(pattern ? pattern[1] : raw.replace(/^(?:debit\s+card\s+purchase|online\s+transfer\s+to|payment\s+to)\s*-?\s*/i, ''));
  return name ? { name, identified: true } : { name: 'Unknown payee', identified: false };
}
const payeeKey = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// rows: { expense_id, date, amount, payment_method, vendor_name, description, bank_text, line, category }
function build1099List(year, rows) {
  const threshold = necThreshold(year);
  const payees = new Map();
  const leftOut = { count: 0, total: 0, by_channel: {} };
  for (const r of rows) {
    const amount = round2(r.amount);
    const text = r.bank_text || r.vendor_name || r.description || '';
    const channel = paymentChannel(r.payment_method, text);
    if (LEFT_OUT_CHANNELS.has(channel)) {
      const c = leftOut.by_channel[channel] || (leftOut.by_channel[channel] = { count: 0, total: 0 });
      c.count += 1; c.total = round2(c.total + amount);
      leftOut.count += 1; leftOut.total = round2(leftOut.total + amount);
      continue;
    }
    const { name, identified } = payeeOf(r.vendor_name || r.description || r.bank_text);
    const key = identified ? payeeKey(name) : `unresolved:${r.expense_id}`;
    const p = payees.get(key) || { key, name, unresolved: !identified, total: 0, count: 0, channels: [], lines: [], payments: [] };
    p.total = round2(p.total + amount);
    p.count += 1;
    if (!p.channels.includes(channel)) p.channels.push(channel);
    if (!p.lines.includes(r.line)) p.lines.push(r.line);
    p.payments.push({ expense_id: r.expense_id, date: r.date, amount, channel, line: r.line, category: r.category, text });
    payees.set(key, p);
  }
  const list = [...payees.values()]
    .map((p) => ({ ...p, needs_1099: p.total >= threshold, unclear_method: p.channels.includes('unknown') }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { year, threshold, due_date: necDueDate(year), payees: list, left_out: leftOut };
}

// No "?" in raw SQL: knex reads it as a binding.
const P2P_TEXT_SQL = "description ~* '(zelle|venmo|cash\\s*app|\\mwise\\M)'";

async function form1099List(year) {
  const y = sharedBills.parseYear(year);
  const start = `${y}-01-01`;
  const end = `${y}-12-31`;
  const [rows, inbox] = await Promise.all([
    db('expenses as e')
      .join('expense_categories as c', 'c.id', 'e.category_id')
      .whereRaw('trim(c.irs_line) in (?, ?)', SCHEDULE_C_1099_LINES)
      .whereBetween('e.expense_date', [start, end])
      .orderBy([{ column: 'e.expense_date' }, { column: 'e.id' }])
      .select(
        'e.id as expense_id', 'e.expense_date', 'e.amount', 'e.payment_method', 'e.vendor_name', 'e.description',
        db.raw('trim(c.irs_line) as line'), 'c.name as category',
        db.raw('(select b.description from bank_transactions b where b.matched_expense_id = e.id order by b.txn_date, b.id limit 1) as bank_text'),
      ),
    // Payment-app debits not booked yet: until they are, the list may be short.
    db('bank_transactions')
      .where({ direction: 'debit', status: 'unmatched' })
      .whereBetween('txn_date', [start, end])
      .whereRaw(P2P_TEXT_SQL)
      .select(db.raw('COUNT(*)::int as count'), db.raw("COALESCE(SUM(amount), 0)::text as total"))
      .first(),
  ]);
  const list = build1099List(y, rows.map((r) => ({ ...r, date: dateCellStr(r.expense_date) })));
  return {
    ...list,
    inbox_pending: { count: Number(inbox?.count) || 0, total: round2(inbox?.total) },
    notes: [
      'Venmo, Cash App and PayPal: a payment sent as a business (goods and services) payment is reported by the app on a 1099-K and needs no 1099-NEC.',
      'Names come from the bank text. A check or a Wise transfer does not name the person paid, so it stays on its own line until you know who it was. W-9 requests and name corrections come with the filing step.',
      'Rent paid to a person goes on a 1099-MISC and is not in this list.',
      ...(y >= 2027 ? ['The $2,000 threshold is indexed for inflation from 2027; check the IRS figure for this year.'] : []),
    ],
  };
}

module.exports = {
  salesTaxSheet,
  form1099List,
  // pure, for tests
  periodFor,
  dr15DueDate,
  dr15Lines,
  paymentChannel,
  payeeOf,
  build1099List,
  necThreshold,
  necDueDate,
};
