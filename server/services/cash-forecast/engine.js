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
 * owed, not cash. Payroll counts its full cost on the pay date, never again as the tax deposit.
 */
const { addETDays, addETBusinessDays, etDateString, etWeekStart } = require('../../utils/datetime-et');
const { RATES } = require('../payroll-calc');

const WEEKS = 13;
const MAX_LAG_DAYS = 91;
const SETTLE_BUSINESS_DAYS = 2; // page rule: card money reaches the bank ~2 business days after payment
const ACH_IN_FLIGHT_BUSINESS_DAYS = 3; // a 'processing' bank payment settles, then pays out
const TRAILING_WEEKS = 8;
const MIN_COHORT = 20; // a lag with fewer watched visits keeps the last share instead of a noisy one

const noon = (day) => new Date(`${day}T12:00:00Z`);
const addDays = (day, n) => etDateString(addETDays(noon(day), n));
const addBusinessDays = (day, n) => (n > 0 ? etDateString(addETBusinessDays(noon(day), n)) : day);
const dayDiff = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cents = (n) => Math.round((Number(n) || 0) * 100);
const daysInMonth = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const lastYearMonth = (day) => `${Number(day.slice(0, 4)) - 1}${day.slice(4, 7)}`;

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
  if (day < weeks[0].from) return null;
  for (const w of weeks) if (day >= w.start && day <= w.end) return w.index;
  return null;
}

function daysOfWeek(week) {
  return Array.from({ length: week.days }, (_, i) => addDays(week.from, i));
}

// ── Collection curves ───────────────────────────────────────────────────────────────────────────────
// samples: [{ value, ageDays, paid: [{ lagDays, amount }] }]. Returns curve[t], t = 0..91: cash collected
// by day t per $1 of value, among samples watched for at least t days (age >= t). Work that was never
// invoiced, sat in a draft or was never paid stays in the denominator, so it is never counted as cash
// (Fable round 1). Monotone: a lag never shows less than the lag before it.
function collectionCurve(samples, { minCohort = MIN_COHORT } = {}) {
  const curve = new Array(MAX_LAG_DAYS + 1).fill(0);
  let last = 0;
  for (let t = 0; t <= MAX_LAG_DAYS; t += 1) {
    let value = 0;
    let cash = 0;
    let n = 0;
    for (const s of samples) {
      if (!(Number(s.value) > 0) || !(s.ageDays >= t)) continue;
      n += 1;
      value += Number(s.value);
      for (const p of s.paid || []) if (p.lagDays <= t) cash += Number(p.amount) || 0;
    }
    if (n >= minCohort && value > 0) last = Math.max(last, cash / value);
    curve[t] = last;
  }
  return { curve, cohort: samples.filter((s) => Number(s.value) > 0).length };
}

// Adds amount x (curve[t] - curve[t-1]) for each lag t >= fromLag on the day the money lands: eventDay + t,
// then SETTLE business days. `norm` rescales a conditional share (an invoice still open at age s).
// `land(day, t)` is the per-run memo of that date math (thousands of visit x lag pairs).
function spread(into, eventDay, amount, curve, land, { fromLag = 0, norm = 1 } = {}) {
  if (!(amount > 0) || !(norm > 0)) return;
  for (let t = fromLag; t <= MAX_LAG_DAYS; t += 1) {
    const share = curve[t] - (t > 0 ? curve[t - 1] : 0);
    if (share > 0) addTo(into, land(eventDay, t), (amount * share) / norm);
  }
}

function lander() {
  const memo = new Map();
  return (day, t) => {
    const key = `${day}|${t}`;
    let out = memo.get(key);
    if (!out) { out = addBusinessDays(addDays(day, t), SETTLE_BUSINESS_DAYS); memo.set(key, out); }
    return out;
  };
}

function addTo(map, day, amount) {
  if (!amount) return;
  map.set(day, (map.get(day) || 0) + amount);
}

// ── Season (decision 3 A) ───────────────────────────────────────────────────────────────────────────
// Last year's receipts by month (owner-typed cents). ratioFor(day) = last year's daily rate in that
// day's month over last year's daily rate across the trailing window. Null when a month is missing.
function seasonRatios(receipts, trailingDays, windowDays) {
  const daily = (ym) => {
    const v = receipts && receipts[ym];
    return Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) / 100 / daysInMonth(ym) : null;
  };
  const missing = new Set();
  let refSum = 0;
  for (const d of trailingDays) {
    const r = daily(lastYearMonth(d));
    if (r === null) missing.add(lastYearMonth(d)); else refSum += r;
  }
  for (const d of windowDays) if (daily(lastYearMonth(d)) === null) missing.add(lastYearMonth(d));
  const ref = trailingDays.length ? refSum / trailingDays.length : 0;
  if (missing.size || !(ref > 0)) return { ratioFor: null, missingMonths: [...missing].sort() };
  return { ratioFor: (day) => daily(lastYearMonth(day)) / ref, missingMonths: [] };
}

// ── Bank lines -> money-out lines ───────────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z& ]+/g, ' ').replace(/\s+/g, ' ').trim();
const CARD_PAYMENT_RE = /CAPITAL ONE|AMEX EPAYMENT|AMERICAN EXPRESS|\bCITI\b|CARD PAYMENT|CRCARDPMT|CR CARD PMT|CARDMEMBER/;
const CARD_RETURN_RE = /\bRETURN(ED)?\b/;
// Payroll funding to the Mercury paycheck account is the pay run's money, counted from payroll checks.
const PAYROLL_FUNDING_RE = /\bMERCURY\b/;
const AI_RE = /ANTHROPIC|CLAUDE|OPENAI|CHATGPT/;
const SUPPLY_RE = /SITEONE|SITE ONE|LESCO/;
const FUEL_RE = /\bSHELL\b|CHEVRON|EXXON|MOBIL\b|MARATHON|RACETRAC|WAWA|SUNOCO|CIRCLE K|SPEEDWAY|MURPHY|CITGO|VALERO/;
const CATEGORY_LINE = { Supplies: 'products_fuel', 'Vehicle Expenses': 'products_fuel', 'Software & Technology': 'ai_software' };

function lineKind(line) {
  const byCategory = CATEGORY_LINE[line.category];
  if (byCategory) return byCategory;
  const d = norm(line.description);
  if (AI_RE.test(d)) return 'ai_software';
  if (SUPPLY_RE.test(d) || FUEL_RE.test(d)) return 'products_fuel';
  return 'other_spending';
}

// lines: [{ id, day, account, direction 'debit'|'credit', amount, description, category, modeled }].
// pool = checking labels in the pool; feedCards = card labels in the bank feed. Returns the debit totals
// per line over [from, to] after the exclusions. Money in comes from the portal (visits, invoices, dues,
// Stripe), never from bank credits; other money into the pool is not counted (the safe side).
function classifySpend(lines, { pool, feedCards, from, to }) {
  const inPool = new Set(pool);
  const isFeedCard = new Set(feedCards);
  const used = new Set();
  const byCents = (l) => cents(l.amount);
  const sorted = [...lines].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : String(a.id).localeCompare(String(b.id))));
  const pair = (debitTest, creditTest, maxDays) => {
    for (const d of sorted) {
      if (used.has(d.id) || d.direction !== 'debit' || !debitTest(d)) continue;
      const match = sorted.find((c) => !used.has(c.id) && c.direction === 'credit' && creditTest(c, d)
        && byCents(c) === byCents(d) && Math.abs(dayDiff(d.day, c.day)) <= maxDays);
      if (match) { used.add(d.id); used.add(match.id); }
    }
  };
  // 1. Matched transfers between pool accounts cancel (decision 2 A). Unmatched transfer lines stay in:
  //    that money really left the pool (another bank, savings, a payroll account).
  pair((d) => inPool.has(d.account), (c, d) => inPool.has(c.account) && c.account !== d.account, 2);
  // 2. A payment to a feed card is the card's own charges again: both sides out.
  pair((d) => inPool.has(d.account), (c) => isFeedCard.has(c.account), 3);

  const totals = { products_fuel: 0, ai_software: 0, card_payments_off_feed: 0, other_spending: 0 };
  for (const l of sorted) {
    if (used.has(l.id) || l.modeled || l.direction !== 'debit' || l.day < from || l.day > to) continue;
    const amount = Number(l.amount) || 0;
    if (!(amount > 0)) continue;
    const pooled = inPool.has(l.account);
    const feedCard = isFeedCard.has(l.account);
    if (!pooled && !feedCard) continue;
    const d = norm(l.description);
    if (pooled && PAYROLL_FUNDING_RE.test(d)) continue;
    // 3. A returned card payment on the card is not a purchase.
    if (feedCard && CARD_RETURN_RE.test(d)) continue;
    // 4. A payment to a card NOT in the feed is the only sight of that money: it stays, as its own line.
    if (pooled && CARD_PAYMENT_RE.test(d)) { totals.card_payments_off_feed += amount; continue; }
    totals[lineKind(l)] += amount;
  }
  return { totals };
}

// ── Planned items ───────────────────────────────────────────────────────────────────────────────────
function occurrences(item, from, to) {
  const first = item.first_date;
  const last = item.last_date && item.last_date < to ? item.last_date : to;
  if (!first || first > last) return [];
  const out = [];
  const push = (day) => { if (day >= from && day <= last) out.push(day); };
  if (item.cadence === 'once') { push(first); return out; }
  if (item.cadence === 'weekly' || item.cadence === 'biweekly') {
    const step = item.cadence === 'weekly' ? 7 : 14;
    let day = first;
    if (day < from) day = addDays(day, Math.ceil(dayDiff(day, from) / step) * step);
    for (; day <= last; day = addDays(day, step)) push(day);
    return out;
  }
  // monthly: the first date's day of the month, or the month's last day when it is shorter
  const anchor = Number(first.slice(8, 10));
  let y = Number(first.slice(0, 4));
  let m = Number(first.slice(5, 7));
  for (let guard = 0; guard < 400; guard += 1) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const day = `${ym}-${String(Math.min(anchor, daysInMonth(ym))).padStart(2, '0')}`;
    if (day > last) break;
    push(day);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

// A hire's cash cost per check: gross + employer Social Security and Medicare, plus FUTA and Florida
// reemployment tax on the first $7,000 of the calendar year (payroll-calc.js RATES). Counted on the
// pay date, so a 941 deposit due after the window never hides it (Fable round 1).
function hireCosts(item, days) {
  const grossCents = Number(item.amount_cents) || 0;
  const fica = RATES.socialSecurityBp + RATES.medicareBp;
  const capped = RATES.futaBp + RATES.floridaNewEmployerBp;
  const ytd = new Map();
  return days.map((day) => {
    const year = day.slice(0, 4);
    const before = ytd.get(year) || 0;
    const cappedWages = Math.max(0, Math.min(grossCents, RATES.futaAndStateWageBaseCents - before));
    ytd.set(year, before + grossCents);
    return { day, usd: (grossCents + Math.round((grossCents * fica) / 10000) + Math.round((cappedWages * capped) / 10000)) / 100 };
  });
}

// ── The forecast ────────────────────────────────────────────────────────────────────────────────────
function computeForecast(input) {
  const today = input.today;
  const weeks = buildWeeks(today);
  const windowEnd = weeks[WEEKS - 1].end;
  const windowDays = weeks.flatMap(daysOfWeek);
  const trailingFrom = addDays(weeks[0].start, -7 * TRAILING_WEEKS);
  const trailingTo = addDays(weeks[0].start, -1);
  const trailingDays = Array.from({ length: 7 * TRAILING_WEEKS }, (_, i) => addDays(trailingFrom, i));
  const missing = [...(input.missing || [])];

  const visitCurve = collectionCurve(input.visitCohort || []);
  const invoiceCurve = collectionCurve(input.invoiceCohort || []);
  const land = lander();

  const inBooked = { stripe: new Map(), visits: new Map(), invoices: new Map(), dues: new Map() };
  const inExpected = { new_work: new Map(), prepay_sales: new Map() };
  const out = { card_owed: new Map(), payroll: new Map(), taxes: new Map(), planned: new Map(), hire: new Map() };

  // Stripe: money already charged, not yet in the bank.
  const stripe = input.stripe || {};
  addTo(inBooked.stripe, addBusinessDays(today, 1), Number(stripe.availableUsd) || 0);
  addTo(inBooked.stripe, addBusinessDays(today, SETTLE_BUSINESS_DAYS), Number(stripe.pendingUsd) || 0);
  for (const p of stripe.payouts || []) {
    // arrivalDay is Stripe's UTC calendar-day marker, compared as a day (never converted to ET). A row
    // whose day has passed has landed: the live bank balance already holds it.
    if (p.arrivalDay && p.arrivalDay >= today) addTo(inBooked.stripe, p.arrivalDay, Number(p.amountUsd) || 0);
  }

  // Booked visits -> cash through the per-visit collection curve.
  const bookedValue = new Array(WEEKS).fill(0);
  const bookedVisits = new Array(WEEKS).fill(0);
  for (const v of input.booked || []) {
    const w = weekOf(weeks, v.day);
    if (w === null) continue;
    bookedVisits[w] += 1;
    if (v.value > 0) {
      bookedValue[w] += v.value;
      spread(inBooked.visits, v.day, v.value, visitCurve.curve, land);
    }
  }

  // Open invoices: P(paid on day t | still open at age s), from the invoice curve.
  let lateBeyond = { count: 0, usd: 0 };
  for (const inv of input.openInvoices || []) {
    const amount = Number(inv.amountUsd) || 0;
    if (!(amount > 0)) continue;
    if (inv.processing) {
      addTo(inBooked.invoices, addBusinessDays(today, ACH_IN_FLIGHT_BUSINESS_DAYS + SETTLE_BUSINESS_DAYS), amount);
      continue;
    }
    const s = Math.max(0, Math.round(inv.ageDays || 0));
    const remaining = s <= MAX_LAG_DAYS ? 1 - invoiceCurve.curve[s] : 0;
    if (s > MAX_LAG_DAYS || remaining <= 0.001) { lateBeyond = { count: lateBeyond.count + 1, usd: lateBeyond.usd + amount }; continue; }
    // From the day it was sent: lag s is today, so the first share it can still collect is tomorrow's.
    spread(inBooked.invoices, addDays(today, -s), amount, invoiceCurve.curve, land, { fromLag: s + 1, norm: remaining });
  }
  if (lateBeyond.count) missing.push({ kind: 'invoices_late_beyond', count: lateBeyond.count, usd: round2(lateBeyond.usd) });

  // Monthly dues on the billing day (today's run may already be in Stripe, so from tomorrow).
  for (const d of input.dues || []) {
    if (d.day > today) addTo(inBooked.dues, addBusinessDays(d.day, SETTLE_BUSINESS_DAYS), Number(d.amountUsd) || 0);
  }

  // Expected new money (decision 3 A), only with last year's months.
  const trailing = input.trailing || {};
  const season = seasonRatios(input.settings?.last_year_receipts || {}, trailingDays, windowDays);
  const expectedAvailable = !!season.ratioFor;
  const baselineDaily = (Number(trailing.workValueUsd) || 0) / trailingDays.length;
  const visitsDaily = (Number(trailing.visits) || 0) / trailingDays.length;
  const prepayDaily = (Number(trailing.prepaySalesUsd3m) || 0) / 91;
  const expectedVisits = [...bookedVisits];
  if (expectedAvailable) {
    for (const w of weeks) {
      const days = daysOfWeek(w);
      const want = days.reduce((sum, d) => sum + baselineDaily * season.ratioFor(d), 0);
      const newWork = Math.max(0, want - bookedValue[w.index]);
      for (const d of days) {
        spread(inExpected.new_work, d, newWork / days.length, visitCurve.curve, land);
        addTo(inExpected.prepay_sales, addBusinessDays(d, SETTLE_BUSINESS_DAYS), prepayDaily * season.ratioFor(d));
      }
      expectedVisits[w.index] = Math.max(bookedVisits[w.index], days.reduce((sum, d) => sum + visitsDaily * season.ratioFor(d), 0));
    }
  } else {
    missing.push({ kind: 'last_year_months', months: season.missingMonths });
  }

  // Money out from the last 8 complete weeks of bank lines.
  const spend = classifySpend(input.bankLines || [], { pool: input.poolAccounts || [], feedCards: input.feedCards || [], from: trailingFrom, to: trailingTo });
  const weekly = Object.fromEntries(Object.entries(spend.totals).map(([k, v]) => [k, v / TRAILING_WEEKS]));
  const perVisit = trailing.visits > 0 ? spend.totals.products_fuel / trailing.visits : 0;

  const items = (input.items || []).filter((i) => i.active !== false);
  const payoffItems = items.filter((i) => i.kind === 'card_payoff');
  if (!payoffItems.length && weekly.card_payments_off_feed > 0) missing.push({ kind: 'card_payoff_plan', weekly_usd: round2(weekly.card_payments_off_feed) });

  // Card owed today: past charges not yet paid.
  addTo(out.card_owed, today, Number(input.opening?.cardOwedUsd) || 0);

  // Payroll checks: full cost on the pay date; the tax deposits later are the same money.
  const checkDays = new Set();
  for (const c of input.payroll || []) {
    if (c.payDay < today || c.payDay > windowEnd) continue;
    checkDays.add(c.payDay);
    addTo(out.payroll, c.payDay, Number(c.cashCostUsd) || 0);
  }
  for (const t of input.taxRows || []) {
    if (t.dueDay >= today && t.dueDay <= windowEnd && Number(t.amountUsd) > 0) addTo(out.taxes, t.dueDay, Number(t.amountUsd));
  }
  for (const item of items) {
    const days = occurrences(item, today, windowEnd);
    if (item.kind === 'hire') {
      for (const h of hireCosts(item, days)) if (!checkDays.has(h.day)) addTo(out.hire, h.day, h.usd);
    } else {
      for (const d of days) addTo(out.planned, d, (Number(item.amount_cents) || 0) / 100);
    }
  }

  // Weeks.
  const sumWeek = (map, w) => {
    let s = 0;
    for (const [day, amount] of map) if (weekOf(weeks, day) === w.index) s += amount;
    return s;
  };
  const opening = input.opening?.bankUsd;
  const start = Number.isFinite(opening) ? opening : 0;
  let booked = start;
  let expected = start;
  let hireTotal = 0;
  const rows = weeks.map((w) => {
    const frac = w.days / 7;
    const moneyIn = {
      stripe: sumWeek(inBooked.stripe, w),
      visits: sumWeek(inBooked.visits, w),
      invoices: sumWeek(inBooked.invoices, w),
      dues: sumWeek(inBooked.dues, w),
    };
    const extra = expectedAvailable ? { new_work: sumWeek(inExpected.new_work, w), prepay_sales: sumWeek(inExpected.prepay_sales, w) } : { new_work: 0, prepay_sales: 0 };
    const moneyOut = {
      products_fuel: perVisit * bookedVisits[w.index],
      ai_software: weekly.ai_software * frac,
      card_payments_off_feed: payoffItems.length ? 0 : weekly.card_payments_off_feed * frac,
      other_spending: weekly.other_spending * frac,
      card_owed: sumWeek(out.card_owed, w),
      payroll: sumWeek(out.payroll, w),
      taxes: sumWeek(out.taxes, w),
      planned: sumWeek(out.planned, w),
    };
    const productsExpected = perVisit * expectedVisits[w.index];
    const hire = sumWeek(out.hire, w);
    const inTotal = Object.values(moneyIn).reduce((a, b) => a + b, 0);
    const outTotal = Object.values(moneyOut).reduce((a, b) => a + b, 0);
    booked += inTotal - outTotal;
    expected += inTotal + extra.new_work + extra.prepay_sales - (outTotal - moneyOut.products_fuel + productsExpected);
    hireTotal += hire;
    return {
      week_start: w.start,
      week_end: w.end,
      days: w.days,
      money_in: roundAll({ ...moneyIn, ...extra }),
      money_out: roundAll({ ...moneyOut, products_fuel_expected: productsExpected, hire }),
      end_booked: round2(booked),
      end_expected: expectedAvailable ? round2(expected) : null,
      end_booked_with_hire: round2(booked - hireTotal),
      end_expected_with_hire: expectedAvailable ? round2(expected - hireTotal) : null,
    };
  });

  return {
    today,
    window_end: windowEnd,
    opening: { bank_usd: Number.isFinite(opening) ? round2(opening) : null, partial: !!input.opening?.partial, card_owed_usd: round2(input.opening?.cardOwedUsd) },
    expected_available: expectedAvailable,
    weeks: rows,
    lowest: {
      booked: lowestOf(rows, 'end_booked'),
      expected: expectedAvailable ? lowestOf(rows, 'end_expected') : null,
      booked_with_hire: lowestOf(rows, 'end_booked_with_hire'),
      expected_with_hire: expectedAvailable ? lowestOf(rows, 'end_expected_with_hire') : null,
    },
    method: {
      settle_business_days: SETTLE_BUSINESS_DAYS,
      trailing_weeks: TRAILING_WEEKS,
      trailing_from: trailingFrom,
      trailing_to: trailingTo,
      visit_cohort: visitCurve.cohort,
      collected_per_dollar_by_day_30: round4(visitCurve.curve[30]),
      collected_per_dollar_by_day_91: round4(visitCurve.curve[MAX_LAG_DAYS]),
      invoice_cohort: invoiceCurve.cohort,
      weekly_usd: roundAll(weekly),
      products_fuel_per_visit_usd: round2(perVisit),
      baseline_weekly_work_usd: round2(baselineDaily * 7),
    },
    missing,
  };
}

function roundAll(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, round2(v)]));
}
function round4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}
function lowestOf(rows, key) {
  let low = null;
  for (const r of rows) if (r[key] !== null && (low === null || r[key] < low.usd)) low = { week_start: r.week_start, usd: r[key] };
  return low;
}

module.exports = {
  computeForecast,
  _private: { buildWeeks, weekOf, collectionCurve, spread, lander, seasonRatios, classifySpend, occurrences, hireCosts, addDays, addBusinessDays, dayDiff, MAX_LAG_DAYS, WEEKS, TRAILING_WEEKS },
};
