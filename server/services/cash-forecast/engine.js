/**
 * 13-week cash forecast engine (owner 2026-11-04 "A A A A", Banking decision page).
 *
 * Pure: no database, no clock, no network. Every date is an ET calendar day 'YYYY-MM-DD'; the loader
 * (load.js) binds "today" from the app clock and does every read. The pool is both checking accounts
 * (decision 2 A). Each week has two end balances (decision 3 A): booked work only (the safe edge), and
 * booked plus expected new money, which shows only when last year's monthly receipts cover the months
 * it needs (a flat season would be far too high in winter).
 *
 * Rules (decision page): a dollar counts once, at the step it has reached (visit -> invoice -> payment
 * -> payout); card money reaches the bank 2 business days after it is paid; prepaid visits bring no new
 * cash; a card charge counts when it posts, never again as the card payment; a card balance is money
 * owed, not cash. A pay run pays its net on the pay date and its taxes on the deposit rows' due dates;
 * a planned hire (no deposit rows yet) counts its full cost on the pay date, the safe side.
 *
 * Shape: every money source returns flows { day, line, amount }; LINES says each line's side (in / out)
 * and edge (both balances, the expected balance only, or the hire scenario); one pass sums the flows
 * into weeks.
 */
const { addETDays, addETBusinessDays, etDateString, etWeekStart } = require('../../utils/datetime-et');
const { RATES } = require('../payroll-calc');

const WEEKS = 13;
const MAX_LAG_DAYS = 91;
const SETTLE_BUSINESS_DAYS = 2; // page rule: card money reaches the bank ~2 business days after payment
const ACH_IN_FLIGHT_BUSINESS_DAYS = 3; // a 'processing' bank payment settles, then pays out
const TRAILING_WEEKS = 8;
const MIN_COHORT = 20; // a lag with fewer watched samples keeps the last share instead of a noisy one

// line -> [side, edge]. edge 'both' moves both end balances; 'expected' only the expected one; 'hire'
// is the planned hire, shown as its own scenario.
const LINES = {
  stripe: ['in', 'both'],
  visits: ['in', 'both'],
  invoices: ['in', 'both'],
  dues: ['in', 'both'],
  new_work: ['in', 'expected'],
  prepay_sales: ['in', 'expected'],
  products_fuel: ['out', 'both'],
  products_fuel_extra: ['out', 'expected'],
  ai_software: ['out', 'both'],
  card_payments_off_feed: ['out', 'both'],
  other_spending: ['out', 'both'],
  card_owed: ['out', 'both'],
  payroll: ['out', 'both'],
  taxes: ['out', 'both'],
  planned: ['out', 'both'],
  hire: ['out', 'hire'],
};

// The input contract load.js builds: amounts are finite dollars, days are 'YYYY-MM-DD'.
const EMPTY_INPUT = {
  opening: { bankUsd: null, cardOwedUsd: 0, partial: false },
  stripe: { availableUsd: 0, pendingUsd: 0, payouts: [] },
  visitCohort: [],
  invoiceCohort: [],
  booked: [],
  openInvoices: [],
  dues: [],
  trailing: { visits: 0, workValueUsd: 0, prepaySalesUsd3m: 0 },
  bankLines: [],
  poolAccounts: [],
  feedCards: [],
  payroll: [],
  taxRows: [],
  items: [],
  settings: { last_year_receipts: {} },
  missing: [],
};

const noon = (day) => new Date(`${day}T12:00:00Z`);
const addDays = (day, n) => etDateString(addETDays(noon(day), n));
const addBusinessDays = (day, n) => (n > 0 ? etDateString(addETBusinessDays(noon(day), n)) : day);
const dayDiff = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const cents = (n) => Math.round(n * 100);
const daysInMonth = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const lastYearMonth = (day) => `${Number(day.slice(0, 4)) - 1}${day.slice(4, 7)}`;
const flow = (day, line, amount) => ({ day, line, amount });
const sum = (list, pick) => list.reduce((s, x) => s + pick(x), 0);

function normalize(input) {
  return {
    ...EMPTY_INPUT,
    ...input,
    opening: { ...EMPTY_INPUT.opening, ...input.opening },
    stripe: { ...EMPTY_INPUT.stripe, ...input.stripe },
    trailing: { ...EMPTY_INPUT.trailing, ...input.trailing },
    settings: { ...EMPTY_INPUT.settings, ...input.settings },
  };
}

// ── Weeks ───────────────────────────────────────────────────────────────────────────────────────────
// Monday-Sunday ET. Week 0 counts only today and the days after it.
function buildWeeks(today) {
  const first = etWeekStart(noon(today));
  return Array.from({ length: WEEKS }, (_, index) => {
    const start = addDays(first, 7 * index);
    const from = index === 0 ? today : start;
    const end = addDays(start, 6);
    return { index, start, end, from, days: dayDiff(from, end) + 1 };
  });
}

function weekOf(weeks, day) {
  const w = weeks.find((x) => day >= x.from && day <= x.end);
  return w ? w.index : null;
}

function daysOfWeek(week) {
  return Array.from({ length: week.days }, (_, i) => addDays(week.from, i));
}

// ── Collection curves ───────────────────────────────────────────────────────────────────────────────
// samples: [{ value, ageDays, paid: [{ lagDays, amount }] }]. curve[t], t = 0..91: cash collected by day
// t per $1 of value, among samples watched for at least t days. Work never invoiced, left in a draft or
// never paid stays in the denominator, so it never counts as cash (Fable round 1). Never falls.
function collectionCurve(samples, { minCohort = MIN_COHORT } = {}) {
  const valued = samples.filter((s) => s.value > 0);
  const curve = new Array(MAX_LAG_DAYS + 1).fill(0);
  let last = 0;
  for (let t = 0; t <= MAX_LAG_DAYS; t += 1) {
    const watched = valued.filter((s) => s.ageDays >= t);
    const value = sum(watched, (s) => s.value);
    const cash = sum(watched, (s) => sum(s.paid.filter((p) => p.lagDays <= t), (p) => p.amount));
    if (watched.length >= minCohort) last = Math.max(last, cash / value);
    curve[t] = last;
  }
  return { curve, cohort: valued.length };
}

// The day money paid on day eventDay + t lands in the bank. Memoized per run: thousands of pairs.
function lander() {
  const memo = new Map();
  return (day, t) => {
    const key = `${day}|${t}`;
    if (!memo.has(key)) memo.set(key, addBusinessDays(addDays(day, t), SETTLE_BUSINESS_DAYS));
    return memo.get(key);
  };
}

// Flows for amount x (curve[t] - curve[t-1]) on each lag t >= fromLag (curve[-1] = 0); `norm` rescales a
// conditional share (an invoice still open at its age).
function spread(line, eventDay, amount, curve, land, { fromLag = 0, norm = 1 } = {}) {
  const out = [];
  for (let t = fromLag; t <= MAX_LAG_DAYS; t += 1) {
    const share = curve[t] - (curve[t - 1] || 0);
    // the landing day only for a lag that moves money (each new day costs ET date math)
    if (share > 0 && amount > 0) out.push(flow(land(eventDay, t), line, (amount * share) / norm));
  }
  return out;
}

// ── Season (decision 3 A) ───────────────────────────────────────────────────────────────────────────
// Last year's receipts by month (owner-typed cents). ratioFor(day) = last year's daily rate in that
// day's month over last year's daily rate across the trailing window. Null when a month is missing.
function seasonRatios(receipts, trailingDays, windowDays) {
  const daily = (ym) => (Number.isFinite(receipts[ym]) ? receipts[ym] / 100 / daysInMonth(ym) : null);
  const months = [...new Set([...trailingDays, ...windowDays].map(lastYearMonth))];
  const missingMonths = months.filter((ym) => daily(ym) === null).sort();
  if (missingMonths.length) return { ratioFor: null, missingMonths };
  const ref = sum(trailingDays, (d) => daily(lastYearMonth(d))) / trailingDays.length;
  if (!(ref > 0)) return { ratioFor: null, missingMonths };
  return { ratioFor: (day) => daily(lastYearMonth(day)) / ref, missingMonths };
}

// ── Bank lines -> money-out lines ───────────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z& ]+/g, ' ').replace(/\s+/g, ' ').trim();
// A card payment from checking reads "CAPITAL ONE"; "Capital One Bank" is the other side of a transfer
// between the checking accounts (prod wording, 2026-11-05), so it is never a card payment.
const CARD_PAYMENT_RE = /CAPITAL ONE(?! BANK)|AMEX EPAYMENT|AMERICAN EXPRESS|\bCITI\b|CARD PAYMENT|CRCARDPMT|CR CARD PMT|CARDMEMBER/;
const CARD_PAYMENT_CREDIT_RE = /\bPYMT\b|\bPAYMENT\b|\bPMT\b/;
const CARD_RETURN_RE = /\bRETURN(ED)?\b/;
// Payroll funding to the Mercury paycheck account is the pay run's money, counted from pay runs.
const PAYROLL_FUNDING_RE = /\bMERCURY\b/;
// One side of a transfer between the checking accounts names it: "TRANSFER WITHDRAWAL To ....3098" /
// "TRANSFER DEPOSIT From ....3965" (the other account's last 4 digits).
const TRANSFER_RE = /\bTRANSFER\b|\bXFER\b/i;
const AI_RE = /ANTHROPIC|CLAUDE|OPENAI|CHATGPT/;
const SUPPLY_FUEL_RE = /SITEONE|SITE ONE|LESCO|\bSHELL\b|CHEVRON|EXXON|MOBIL\b|MARATHON|RACETRAC|WAWA|SUNOCO|CIRCLE K|SPEEDWAY|MURPHY|CITGO|VALERO/;
const CATEGORY_LINE = { Supplies: 'products_fuel', 'Vehicle Expenses': 'products_fuel', 'Software & Technology': 'ai_software' };

function namesTransferTo(line, other) {
  const text = String(line.description || '');
  const digits = (String(other.account).match(/(\d{4})$/) || [])[1];
  return TRANSFER_RE.test(text) && (!digits || text.includes(digits));
}

// Rules for one debit, in order: the first that matches names its line (null = not spending).
const SPEND_RULES = [
  [(l, d, k) => k.pooled && PAYROLL_FUNDING_RE.test(d), null],
  [(l, d, k) => k.feedCard && CARD_RETURN_RE.test(d), null], // a returned card payment is no purchase
  // A payment to a card NOT in the feed is the only sight of that money: its own line.
  [(l, d, k) => k.pooled && CARD_PAYMENT_RE.test(d), 'card_payments_off_feed'],
  [(l) => CATEGORY_LINE[l.category] === 'products_fuel', 'products_fuel'],
  [(l) => CATEGORY_LINE[l.category] === 'ai_software', 'ai_software'],
  [(l, d) => AI_RE.test(d), 'ai_software'],
  [(l, d) => SUPPLY_FUEL_RE.test(d), 'products_fuel'],
  [() => true, 'other_spending'],
];

// lines: [{ id, day, account, direction, amount, description, category, modeled }]. Debit totals per
// line over [from, to]. Money in comes from the portal (visits, invoices, dues, Stripe), never from bank
// credits; other money into the pool is not counted (the safe side).
function classifySpend(lines, { pool, feedCards, from, to }) {
  const inPool = new Set(pool);
  const isFeedCard = new Set(feedCards);
  const used = new Set();
  const sorted = [...lines].sort((a, b) => a.day.localeCompare(b.day) || String(a.id).localeCompare(String(b.id)));
  const credits = sorted.filter((c) => c.direction === 'credit');
  const pair = (debitTest, creditTest, maxDays) => {
    for (const d of sorted.filter((x) => x.direction === 'debit' && debitTest(x))) {
      const match = credits.find((c) => !used.has(c.id) && !used.has(d.id) && cents(c.amount) === cents(d.amount)
        && Math.abs(dayDiff(d.day, c.day)) <= maxDays && creditTest(c, d));
      if (match) [d.id, match.id].forEach((id) => used.add(id));
    }
  };
  // 1. Transfers between pool accounts cancel (decision 2 A) only with wording that names the other
  //    account; anything else stays in: that money really left the pool.
  pair((d) => inPool.has(d.account), (c, d) => inPool.has(c.account) && c.account !== d.account
    && (namesTransferTo(d, c) || namesTransferTo(c, d)), 2);
  // 2. A payment to a feed card is the card's own charges again: both sides out, when both read as one.
  pair((d) => inPool.has(d.account) && CARD_PAYMENT_RE.test(norm(d.description)),
    (c) => isFeedCard.has(c.account) && CARD_PAYMENT_CREDIT_RE.test(norm(c.description)), 3);

  const totals = { products_fuel: 0, ai_software: 0, card_payments_off_feed: 0, other_spending: 0 };
  const counted = sorted.filter((l) => l.direction === 'debit' && !used.has(l.id) && !l.modeled
    && l.day >= from && l.day <= to && l.amount > 0 && (inPool.has(l.account) || isFeedCard.has(l.account)));
  for (const l of counted) {
    const kind = { pooled: inPool.has(l.account), feedCard: isFeedCard.has(l.account) };
    const d = norm(l.description);
    const line = SPEND_RULES.find(([test]) => test(l, d, kind))[1];
    if (line) totals[line] += l.amount;
  }
  return { totals };
}

// ── Planned items ───────────────────────────────────────────────────────────────────────────────────
const STEP_DAYS = { weekly: 7, biweekly: 14 };

// monthly: the first date's day of the month, or the month's last day when it is shorter
function monthlyDays(first, last) {
  const anchor = Number(first.slice(8, 10));
  const out = [];
  for (let m = 0; m < 400; m += 1) {
    const ym = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1 + m, 1)).toISOString().slice(0, 7);
    const day = `${ym}-${String(Math.min(anchor, daysInMonth(ym))).padStart(2, '0')}`;
    if (day > last) break;
    out.push(day);
  }
  return out;
}

function steppedDays(first, step, from, last) {
  const out = [];
  const start = first < from ? addDays(first, Math.ceil(dayDiff(first, from) / step) * step) : first;
  for (let d = start; d <= last; d = addDays(d, step)) out.push(d);
  return out;
}

function occurrences(item, from, to) {
  const last = item.last_date && item.last_date < to ? item.last_date : to;
  const days = {
    once: () => [item.first_date],
    monthly: () => monthlyDays(item.first_date, last),
    weekly: () => steppedDays(item.first_date, STEP_DAYS.weekly, from, last),
    biweekly: () => steppedDays(item.first_date, STEP_DAYS.biweekly, from, last),
  }[item.cadence]();
  return days.filter((d) => d >= from && d <= last);
}

// A hire's cash cost per check: gross + employer Social Security and Medicare, plus FUTA and Florida
// reemployment tax on the first $7,000 of the calendar year (payroll-calc.js RATES). Counted on the
// pay date, so a 941 deposit due after the window never hides it (Fable round 1). `before` = the item's
// own checks earlier in the same calendar year, which already used part of the $7,000.
function hireCosts(item, days, before = []) {
  const grossCents = item.amount_cents;
  const fica = RATES.socialSecurityBp + RATES.medicareBp;
  const capped = RATES.futaBp + RATES.floridaNewEmployerBp;
  const ytd = new Map();
  for (const day of before) ytd.set(day.slice(0, 4), (ytd.get(day.slice(0, 4)) || 0) + grossCents);
  return days.map((day) => {
    const year = day.slice(0, 4);
    const used = ytd.get(year) || 0;
    const cappedWages = Math.max(0, Math.min(grossCents, RATES.futaAndStateWageBaseCents - used));
    ytd.set(year, used + grossCents);
    return { day, usd: (grossCents + Math.round((grossCents * fica) / 10000) + Math.round((cappedWages * capped) / 10000)) / 100 };
  });
}

// ── Money sources (each returns flows) ──────────────────────────────────────────────────────────────
// Stripe: money already charged, not yet in the bank. arrivalDay is Stripe's UTC calendar-day marker,
// compared as a day (never converted to ET); a day that has passed has landed in the live balance.
function stripeFlows(i, c) {
  return [
    flow(addBusinessDays(c.today, 1), 'stripe', i.stripe.availableUsd),
    flow(addBusinessDays(c.today, SETTLE_BUSINESS_DAYS), 'stripe', i.stripe.pendingUsd),
    ...i.stripe.payouts.filter((p) => p.arrivalDay >= c.today).map((p) => flow(p.arrivalDay, 'stripe', p.amountUsd)),
  ];
}

// Booked visits: cash through the per-visit curve; products and fuel per visit on the visit day.
function bookedFlows(i, c) {
  return c.booked.flatMap((v) => [flow(v.day, 'products_fuel', c.perVisit), ...spread('visits', v.day, v.value, c.visitCurve, c.land)]);
}

// Open invoices: P(paid on day t | unpaid when today began, at age s). Past the curve -> listed apart.
function invoiceFlows(i, c) {
  return i.openInvoices.flatMap((inv) => {
    if (inv.processing) return [flow(addBusinessDays(c.today, ACH_IN_FLIGHT_BUSINESS_DAYS + SETTLE_BUSINESS_DAYS), 'invoices', inv.amountUsd)];
    const s = Math.max(0, Math.round(inv.ageDays));
    const remaining = s <= MAX_LAG_DAYS ? 1 - (c.invoiceCurve[s - 1] || 0) : 0;
    if (remaining > 0.001) return spread('invoices', addDays(c.today, -s), inv.amountUsd, c.invoiceCurve, c.land, { fromLag: s, norm: remaining });
    c.lateBeyond.push(inv.amountUsd);
    return [];
  });
}

// Monthly dues on the billing day (today's run may already be in Stripe, so from tomorrow).
function duesFlows(i, c) {
  return i.dues.filter((d) => d.day > c.today).map((d) => flow(addBusinessDays(d.day, SETTLE_BUSINESS_DAYS), 'dues', d.amountUsd));
}

// Expected new money (decision 3 A), only with last year's months: the work above what is booked at last
// year's pace for the month, plus new prepay sales, and the products that extra work uses.
function expectedFlows(i, c) {
  if (!c.season.ratioFor) return [];
  const pace = (d) => c.season.ratioFor(d) / c.trailingDays.length;
  return c.weeks.flatMap((w) => {
    const days = daysOfWeek(w);
    const newWork = Math.max(0, sum(days, (d) => i.trailing.workValueUsd * pace(d)) - c.bookedValue[w.index]);
    const extraVisits = Math.max(0, sum(days, (d) => i.trailing.visits * pace(d)) - c.bookedVisits[w.index]);
    return days.flatMap((d) => [
      ...spread('new_work', d, newWork / days.length, c.visitCurve, c.land),
      flow(addBusinessDays(d, SETTLE_BUSINESS_DAYS), 'prepay_sales', (i.trailing.prepaySalesUsd3m / 91) * c.season.ratioFor(d)),
      flow(d, 'products_fuel_extra', (c.perVisit * extraVisits) / days.length),
    ]);
  });
}

// Spending from the last 8 complete weeks, a seventh of the weekly rate each day. A card payoff plan
// stands in for the off-feed card payments only between its first and last dates (its own payments
// are planned items); before or after it, the trailing line applies (the safe side).
function spendFlows(i, c) {
  const covered = (d) => c.payoffs.some((it) => d >= it.first_date && !(it.last_date < d));
  return c.windowDays.flatMap((d) => [
    flow(d, 'ai_software', c.weekly.ai_software / 7),
    flow(d, 'other_spending', c.weekly.other_spending / 7),
    flow(d, 'card_payments_off_feed', covered(d) ? 0 : c.weekly.card_payments_off_feed / 7),
  ]);
}

// Card owed today (past charges not yet paid), pay runs (net on the pay date; their taxes are tax
// rows) and tax payments due in the window.
function obligationFlows(i, c) {
  const inWindow = (day) => day >= c.today && day <= c.windowEnd;
  return [
    flow(c.today, 'card_owed', i.opening.cardOwedUsd),
    ...i.payroll.filter((p) => inWindow(p.payDay)).map((p) => flow(p.payDay, 'payroll', p.cashCostUsd)),
    ...i.taxRows.filter((t) => inWindow(t.dueDay)).map((t) => flow(t.dueDay, 'taxes', t.amountUsd)),
  ];
}

// Planned items. A check is never matched to a planned hire (it may be another employee's): the hire
// runs to its last date; once pay runs exist from its dates on, they project that pay themselves, so
// the owner is asked to end the item.
function itemFlows(i, c) {
  const firstCheck = i.payroll.map((p) => p.payDay).filter((d) => d >= c.today).sort()[0];
  return c.items.flatMap((item) => {
    const days = occurrences(item, c.today, c.windowEnd);
    if (item.kind !== 'hire') return days.map((d) => flow(d, 'planned', item.amount_cents / 100));
    if (days.some((d) => d >= firstCheck)) c.missing.push({ kind: 'hire_overlaps_pay_runs', label: item.label, first_pay_day: firstCheck });
    const earlier = occurrences(item, `${c.today.slice(0, 4)}-01-01`, addDays(c.today, -1));
    return hireCosts(item, days, earlier).map((h) => flow(h.day, 'hire', h.usd));
  });
}

const SOURCES = [stripeFlows, bookedFlows, invoiceFlows, duesFlows, expectedFlows, spendFlows, obligationFlows, itemFlows];

// ── Context: everything the sources share ───────────────────────────────────────────────────────────
function context(i) {
  const weeks = buildWeeks(i.today);
  const trailingFrom = addDays(weeks[0].start, -7 * TRAILING_WEEKS);
  const trailingTo = addDays(weeks[0].start, -1);
  const trailingDays = Array.from({ length: 7 * TRAILING_WEEKS }, (_, n) => addDays(trailingFrom, n));
  const windowDays = weeks.flatMap(daysOfWeek);
  const booked = i.booked.map((v) => ({ ...v, week: weekOf(weeks, v.day) })).filter((v) => v.week !== null);
  // work = the visit's value as booked work (for the expected line); value = the cash still to come
  // (0 once invoiced: the invoice brings that cash).
  const byWeek = (pick) => weeks.map((w) => sum(booked.filter((v) => v.week === w.index), pick));
  const spend = classifySpend(i.bankLines, { pool: i.poolAccounts, feedCards: i.feedCards, from: trailingFrom, to: trailingTo }).totals;
  const items = i.items.filter((it) => it.active !== false);
  // A payoff plan that has ended stands in for nothing.
  const payoffs = items.filter((it) => it.kind === 'card_payoff' && !(it.last_date < i.today));
  const visit = collectionCurve(i.visitCohort);
  const invoice = collectionCurve(i.invoiceCohort);
  return {
    today: i.today,
    weeks,
    windowDays,
    windowEnd: weeks[WEEKS - 1].end,
    trailingFrom,
    trailingTo,
    trailingDays,
    booked,
    bookedValue: byWeek((v) => ('work' in v ? v.work : v.value)),
    bookedVisits: byWeek(() => 1),
    season: seasonRatios(i.settings.last_year_receipts, trailingDays, windowDays),
    visitCurve: visit.curve,
    visitCohort: visit.cohort,
    invoiceCurve: invoice.curve,
    invoiceCohort: invoice.cohort,
    land: lander(),
    weekly: Object.fromEntries(Object.entries(spend).map(([k, v]) => [k, v / TRAILING_WEEKS])),
    perVisit: i.trailing.visits > 0 ? spend.products_fuel / i.trailing.visits : 0,
    items,
    payoffs,
    missing: [...i.missing],
    lateBeyond: [],
  };
}

// ── Weeks from flows ────────────────────────────────────────────────────────────────────────────────
const lineNames = (side) => Object.keys(LINES).filter((k) => LINES[k][0] === side);
const zeros = (names) => Object.fromEntries(names.map((k) => [k, 0]));

function weekRows(c, flows, start) {
  const rows = c.weeks.map((w) => ({ week: w, in: zeros(lineNames('in')), out: zeros(lineNames('out')), edge: { both: 0, expected: 0, hire: 0 } }));
  const weekByDay = new Map(c.windowDays.map((d) => [d, weekOf(c.weeks, d)]));
  for (const f of flows) {
    const w = weekByDay.get(f.day);
    if (w === undefined) continue; // before today or after the window
    const [side, edge] = LINES[f.line];
    rows[w][side][f.line] += f.amount;
    rows[w].edge[edge] += side === 'in' ? f.amount : -f.amount;
  }
  const running = { both: start, expected: start, hire: 0 };
  const shown = (n) => (c.season.ratioFor ? round2(n) : null);
  return rows.map((r) => {
    running.both += r.edge.both;
    running.expected += r.edge.both + r.edge.expected;
    running.hire += r.edge.hire; // hire flows are money out, so this runs negative
    return {
      week_start: r.week.start,
      week_end: r.week.end,
      days: r.week.days,
      money_in: roundAll(r.in),
      money_out: roundAll(r.out),
      end_booked: round2(running.both),
      end_expected: shown(running.expected),
      end_booked_with_hire: round2(running.both + running.hire),
      end_expected_with_hire: shown(running.expected + running.hire),
    };
  });
}

// What the forecast cannot see, from the run itself (the loader adds its own facts first).
function runFacts(c) {
  const facts = [
    { when: c.lateBeyond.length > 0, fact: { kind: 'invoices_late_beyond', count: c.lateBeyond.length, usd: round2(sum(c.lateBeyond, (x) => x)) } },
    { when: !c.season.ratioFor, fact: { kind: 'last_year_months', months: c.season.missingMonths } },
    { when: !c.payoffs.length && c.weekly.card_payments_off_feed > 0, fact: { kind: 'card_payoff_plan', weekly_usd: round2(c.weekly.card_payments_off_feed) } },
  ];
  return facts.filter((f) => f.when).map((f) => f.fact);
}

function computeForecast(input) {
  const i = normalize(input);
  const c = context(i);
  const flows = SOURCES.flatMap((source) => source(i, c));
  const known = Number.isFinite(i.opening.bankUsd);
  const weeks = weekRows(c, flows, known ? i.opening.bankUsd : 0);
  return {
    today: c.today,
    window_end: c.windowEnd,
    opening: { bank_usd: known ? round2(i.opening.bankUsd) : null, partial: !!i.opening.partial, card_owed_usd: round2(i.opening.cardOwedUsd) },
    expected_available: !!c.season.ratioFor,
    weeks,
    lowest: {
      booked: lowestOf(weeks, 'end_booked'),
      expected: lowestOf(weeks, 'end_expected'),
      booked_with_hire: lowestOf(weeks, 'end_booked_with_hire'),
      expected_with_hire: lowestOf(weeks, 'end_expected_with_hire'),
    },
    method: {
      settle_business_days: SETTLE_BUSINESS_DAYS,
      trailing_weeks: TRAILING_WEEKS,
      trailing_from: c.trailingFrom,
      trailing_to: c.trailingTo,
      visit_cohort: c.visitCohort,
      collected_per_dollar_by_day_30: round4(c.visitCurve[30]),
      collected_per_dollar_by_day_91: round4(c.visitCurve[MAX_LAG_DAYS]),
      invoice_cohort: c.invoiceCohort,
      weekly_usd: roundAll(c.weekly),
      products_fuel_per_visit_usd: round2(c.perVisit),
      baseline_weekly_work_usd: round2((i.trailing.workValueUsd / c.trailingDays.length) * 7),
    },
    missing: [...c.missing, ...runFacts(c)],
  };
}

function roundAll(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, round2(v)]));
}

// The lowest end balance of one series; null when the series is not shown.
function lowestOf(rows, key) {
  const shown = rows.filter((r) => r[key] !== null);
  if (!shown.length) return null;
  const low = shown.reduce((a, b) => (b[key] < a[key] ? b : a));
  return { week_start: low.week_start, usd: low[key] };
}

module.exports = {
  computeForecast,
  _private: {
    buildWeeks, weekOf, collectionCurve, spread, lander, seasonRatios, classifySpend, occurrences, hireCosts,
    addDays, addBusinessDays, dayDiff, MAX_LAG_DAYS, WEEKS, TRAILING_WEEKS,
  },
};
