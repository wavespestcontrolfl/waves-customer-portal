/**
 * Discount stacking — the ONE rule for how several discounts combine on a
 * base amount, shared by every surface that saves an operator-picked
 * discount (schedule create/edit, invoices, dispatch checkout).
 *
 * Owner ruling 2026-09-11 ("lesser of the two"): stacked discounts compound
 * in sequence, each on what is left, so 10% then 5% is 14.5% — never an
 * additive 15%. By the same principle dollar credits come off FIRST and the
 * percentages then compound on the remainder ($111 − $25 = $86, then 10% =
 * $8.60), which is the smaller total discount of the two orders.
 *
 * `compound: false` is the pre-ruling behavior, kept so GATE_DISCOUNT_STACKING
 * can dark-ship the change: every discount resolves independently against the
 * full base, and a visit's appointment-level discount applies after the line
 * discounts rather than before. Callers pass the gate's value; nothing here
 * reads the environment.
 *
 * Tier discounts (catalog stack_group 'tier', is_stackable=false) never
 * combine with each other: Silver + Gold, Bronze + Silver, ... are refused.
 * Any non-stackable catalog group follows the same rule.
 *
 * The client mirror is client/src/lib/discountStack.js — keep the two in
 * step (both test suites run the same worked examples).
 */

function isPercentDiscountType(type) {
  return type === 'percentage' || type === 'variable_percentage';
}

function isFixedDiscountType(type) {
  return type === 'fixed_amount' || type === 'variable_amount';
}

function cents(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function capDollars(dollars, maxDiscountDollars) {
  if (maxDiscountDollars == null || maxDiscountDollars === '') return dollars;
  const cap = Number(maxDiscountDollars);
  return Number.isFinite(cap) ? Math.min(dollars, Math.max(0, cap)) : dollars;
}

// Dollars ONE discount takes off `remaining`, clamped to [0, remaining].
function discountStepDollars(discount, remaining) {
  if (!discount || !(remaining > 0)) return 0;
  const amount = Number(discount.amount ?? discount.discountAmount) || 0;
  let dollars = 0;
  if (isPercentDiscountType(discount.discountType)) {
    dollars = capDollars(remaining * (amount / 100), discount.maxDiscountDollars);
  } else if (isFixedDiscountType(discount.discountType)) {
    dollars = amount;
  } else if (discount.discountType === 'free_service') {
    dollars = remaining;
  }
  return Math.min(remaining, Math.max(0, cents(dollars)));
}

// Fixed credits first (in the order given), then percentages, then a free
// service (which takes whatever is left).
function stackOrder(discounts) {
  const rank = (d) => (isFixedDiscountType(d?.discountType) ? 0 : isPercentDiscountType(d?.discountType) ? 1 : 2);
  return discounts
    .map((discount, index) => ({ discount, index }))
    .sort((a, b) => rank(a.discount) - rank(b.discount) || a.index - b.index);
}

/**
 * Stack several discounts on one base amount.
 * discounts: [{ discountType, amount, maxDiscountDollars? }]
 * compound=false resolves each against the full base instead (legacy).
 * Returns { items: [{ index, dollars }] (input order), totalDollars, net }.
 */
function stackDiscounts(base, discounts, { compound = true } = {}) {
  const list = Array.isArray(discounts) ? discounts : [];
  const full = Math.max(0, cents(base));
  let remaining = full;
  const dollarsByIndex = new Array(list.length).fill(0);
  for (const { discount, index } of stackOrder(list)) {
    const dollars = discountStepDollars(discount, compound ? remaining : full);
    dollarsByIndex[index] = dollars;
    if (compound) remaining = cents(remaining - dollars);
  }
  const items = dollarsByIndex.map((dollars, index) => ({ index, dollars }));
  const totalDollars = cents(items.reduce((sum, item) => sum + item.dollars, 0));
  return { items, totalDollars, net: cents(Math.max(0, full - totalDollars)) };
}

/**
 * The visit model: one discount slot per line plus one appointment-level
 * slot that reaches the lines the caller marks `eligible` (scope filter and
 * percent exclusions are the caller's — see admin-schedule).
 *
 * lines: [{ gross, lineDiscount: { discountType, amount, maxDiscountDollars? } | null, eligible }]
 * appointmentDiscount: { discountType, amount, maxDiscountDollars? } | null
 *
 * Same fixed-before-percent order across BOTH slots: a fixed appointment
 * credit is spread over the eligible lines (pro rata to what each still
 * carries) before any line percentage compounds, so the dollars stamped on
 * each line are the ones the invoice replays. compound=false keeps the
 * legacy order instead — every line discount off its own gross, then the
 * appointment discount over the eligible nets.
 *
 * Returns { lines: [{ lineDiscountDollars, net }], subtotal (after line
 * discounts), appointmentDiscountDollars, total }.
 */
function stackVisitDiscounts({ lines, appointmentDiscount, compound = true }) {
  const input = Array.isArray(lines) ? lines : [];
  const state = input.map((line) => ({
    gross: Math.max(0, cents(line?.gross)),
    remaining: Math.max(0, cents(line?.gross)),
    lineDiscount: line?.lineDiscount || null,
    eligible: line?.eligible !== false,
    lineDiscountDollars: 0,
  }));
  const appt = appointmentDiscount && appointmentDiscount.discountType ? appointmentDiscount : null;

  // 1. Fixed line credits (legacy: every line credit, in one pass).
  for (const line of state) {
    if (!compound || isFixedDiscountType(line.lineDiscount?.discountType)) {
      line.lineDiscountDollars = discountStepDollars(line.lineDiscount, line.remaining);
      line.remaining = cents(line.remaining - line.lineDiscountDollars);
    }
  }

  // 2. Fixed appointment credit, spread pro rata over the eligible lines.
  let appointmentDiscountDollars = 0;
  if (compound && appt && isFixedDiscountType(appt.discountType)) {
    const eligible = state.filter((line) => line.eligible && line.remaining > 0);
    const pool = cents(eligible.reduce((sum, line) => sum + line.remaining, 0));
    appointmentDiscountDollars = discountStepDollars(appt, pool);
    let allocated = 0;
    eligible.forEach((line, i) => {
      const share = i === eligible.length - 1
        ? cents(appointmentDiscountDollars - allocated)
        : cents(appointmentDiscountDollars * (line.remaining / pool));
      allocated = cents(allocated + share);
      line.remaining = cents(Math.max(0, line.remaining - share));
    });
  }

  // 3. Line percentages / free service, each on what its line still carries.
  for (const line of state) {
    const type = line.lineDiscount?.discountType;
    if (compound && (isPercentDiscountType(type) || type === 'free_service')) {
      line.lineDiscountDollars = discountStepDollars(line.lineDiscount, line.remaining);
      line.remaining = cents(line.remaining - line.lineDiscountDollars);
    }
  }

  // 4. Appointment percentage / free service on the eligible remainder
  // (legacy: every appointment discount type lands here).
  if (appt && (!compound || !isFixedDiscountType(appt.discountType))) {
    const base = cents(state.reduce((sum, line) => (line.eligible ? sum + line.remaining : sum), 0));
    appointmentDiscountDollars = discountStepDollars(appt, base);
  }

  const outLines = state.map((line) => ({
    lineDiscountDollars: line.lineDiscountDollars,
    net: cents(Math.max(0, line.gross - line.lineDiscountDollars)),
  }));
  const subtotal = cents(outLines.reduce((sum, line) => sum + line.net, 0));
  return {
    lines: outLines,
    subtotal,
    appointmentDiscountDollars,
    total: cents(Math.max(0, subtotal - appointmentDiscountDollars)),
  };
}

/**
 * Catalog stack-group rule: rows in the same non-stackable stack_group
 * (the WaveGuard tiers, promo, relationship) never combine. Returns the
 * first conflict { group, names } or null. Rows without a group, or
 * marked stackable, combine freely.
 */
function stackGroupConflict(rows) {
  const seen = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.stack_group || row.is_stackable === true) continue;
    const group = String(row.stack_group);
    const held = seen.get(group) || [];
    // The SAME catalog row on two different lanes (two service lines, two
    // invoice lines) is fine — each reaches its own line. Anything else in
    // one non-stackable group collides: a different row in the group, the
    // same row twice on one lane, or a document-wide slot (the appointment
    // discount, an invoice-level discount) that reaches a line already
    // carrying that group.
    const clash = held.find((first) => (
      String(first.id || first.name) !== String(row.id || row.name)
      || first.spansAll === true
      || row.spansAll === true
      || String(first.scope ?? '') === String(row.scope ?? '')
    ));
    if (clash) {
      return { group, names: [clash.name || 'discount', row.name || 'discount'] };
    }
    seen.set(group, [...held, row]);
  }
  return null;
}

function assertStackGroups(rows) {
  const conflict = stackGroupConflict(rows);
  if (!conflict) return;
  const label = conflict.group === 'tier' ? 'WaveGuard tier discount' : `${conflict.group} discount`;
  const err = new Error(`Only one ${label} can apply: ${conflict.names.join(' and ')} cannot be combined`);
  err.status = 400;
  throw err;
}

module.exports = {
  isPercentDiscountType,
  isFixedDiscountType,
  stackDiscounts,
  stackVisitDiscounts,
  stackGroupConflict,
  assertStackGroups,
};
