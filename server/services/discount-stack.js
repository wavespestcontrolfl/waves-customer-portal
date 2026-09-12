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
 * step (both test suites run the same worked examples). That now includes
 * stackDocumentDiscounts and its allocateProRata: it WAS server-only, on the
 * reasoning that no client code sends invoice-level discountIds and the
 * preview only stacked line-attached discounts, but a stored
 * appointment-level stamp reaches the whole document and the invoice
 * preview has to stack it the same way (AdminInvoicesPage's
 * invoiceDiscountDollars calls the mirror). Change the algorithm here and
 * the client copy must change with it, or the preview and the saved total
 * disagree again — the failure Codex #4405 r3 found.
 */

function isPercentDiscountType(type) {
  return type === 'percentage' || type === 'variable_percentage';
}

function isFixedDiscountType(type) {
  return type === 'fixed_amount' || type === 'variable_amount';
}

/**
 * Is this catalog row a VARIABLE/CUSTOM preset — one whose real amount the
 * operator types per use, so the catalog's own `amount` stays 0 (or a
 * placeholder) and the entered value is stored on the visit / line item?
 * The variable_* types, plus the seeded custom_percent / custom_dollar
 * rows and any row of a fixed type left with no positive amount.
 *
 * One predicate because two surfaces have to agree on it: the invoice
 * service reads the operator value off the line item (lineItemDiscountTerm)
 * and the schedule route reconstructs an untouched stored slot from it
 * (reconstructPrimaryLineSlot). They disagreed until Codex #4405 r2 — the
 * route required the catalog amount to EQUAL the stored amount before it
 * would trust the term, which a custom preset can never satisfy, so a
 * stored custom 10% collapsed into a flat dollar credit on restack.
 */
function isVariableOrCustomDiscountPreset(row) {
  const amount = Number(row?.amount) || 0;
  return (
    row?.discount_type === 'variable_percentage' ||
    row?.discount_type === 'variable_amount' ||
    (row?.discount_type === 'percentage' &&
      (row?.discount_key === 'custom_percent' || !(amount > 0))) ||
    (row?.discount_type === 'fixed_amount' &&
      (row?.discount_key === 'custom_dollar' || !(amount > 0)))
  );
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

// Spread `totalDollars` pro rata across `poolLines` by `weightOf(line)`,
// the LAST line absorbing the rounding remainder so the shares always sum
// to exactly totalDollars (never more, by a cent, than what the discount
// itself resolved to). `pool` is the caller's own sum of weightOf(line)
// over poolLines — passed in rather than recomputed here because the
// caller already needed it to size totalDollars via discountStepDollars/
// stackDiscounts before allocating it. Calls `apply(line, share)` to let
// the caller fold each share into its own line shape. Shared by
// stackVisitDiscounts (the fixed-appointment-credit pass and the
// percentage/free-service pass) and stackDocumentDiscounts (the analogous
// fixed-document-credit pass) — same technique, same rounding, so a line's
// pro-rata share means the same cent-for-cent thing on every surface.
function allocateProRata(poolLines, pool, weightOf, totalDollars, apply) {
  let allocated = 0;
  poolLines.forEach((line, i) => {
    // Each preliminary share rounds independently, so several can round UP
    // and together exceed the amount being split — $0.03 over weights
    // 3/1/1/1 rounds to $0.02/$0.01/$0.01 and leaves the last line
    // -$0.01. A negative share is not a discount: downstream it lands as a
    // negative appointment share on a visit line, and addonOnlyTotal drops
    // it, misbilling a covered-series add-on by a cent (Codex #4405 r3).
    // Clamping every share to what is still undistributed keeps the
    // remainder method honest — shares stay >= 0 and still sum to exactly
    // totalDollars, with the last line absorbing whatever is left.
    const undistributed = cents(totalDollars - allocated);
    const share = i === poolLines.length - 1
      ? Math.max(0, undistributed)
      : Math.max(0, Math.min(undistributed, cents(totalDollars * (weightOf(line) / pool))));
    allocated = cents(allocated + share);
    apply(line, share);
  });
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
 * Returns { lines: [{ lineDiscountDollars, net, appointmentDiscountDollars }],
 * subtotal (after line discounts), appointmentDiscountDollars, total }.
 * Each line's `appointmentDiscountDollars` is its pro-rata SHARE of the
 * scalar `appointmentDiscountDollars` (0 when the line wasn't eligible, or
 * compound is false — the legacy order never allocated the appointment
 * discount to a line, only to the visit total, so this is always 0 there).
 * The per-line shares always sum to exactly the scalar (last-eligible-line
 * takes the rounding remainder — same technique for both the fixed-credit
 * pass and the percentage/free-service pass below). `lineDiscountDollars`,
 * `net`, `subtotal`, the scalar `appointmentDiscountDollars`, and `total`
 * are unchanged by this field — it is purely additive, so a caller that
 * only reads those keeps getting exactly what it got before (Codex #4405
 * r1 P1: a covered member's add-on total needs this to net out the
 * appointment-level dollars it currently drops on the floor).
 */
function stackVisitDiscounts({ lines, appointmentDiscount, compound = true }) {
  const input = Array.isArray(lines) ? lines : [];
  const state = input.map((line) => ({
    gross: Math.max(0, cents(line?.gross)),
    remaining: Math.max(0, cents(line?.gross)),
    lineDiscount: line?.lineDiscount || null,
    eligible: line?.eligible !== false,
    lineDiscountDollars: 0,
    appointmentDiscountDollars: 0,
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
    allocateProRata(eligible, pool, (line) => line.remaining, appointmentDiscountDollars, (line, share) => {
      line.remaining = cents(Math.max(0, line.remaining - share));
      line.appointmentDiscountDollars = cents(line.appointmentDiscountDollars + share);
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
  // (legacy: every appointment discount type lands here). The scalar is
  // computed exactly as before; the per-line allocation is a NEW, purely
  // additive step (same pro-rata / last-takes-the-remainder technique as
  // step 2) that only runs when compounding — legacy (compound=false) has
  // no per-line meaning for the appointment discount, so every line's
  // appointmentDiscountDollars stays 0 there, unchanged from before this
  // field existed.
  if (appt && (!compound || !isFixedDiscountType(appt.discountType))) {
    const eligibleLines = state.filter((line) => line.eligible);
    const base = cents(eligibleLines.reduce((sum, line) => sum + line.remaining, 0));
    appointmentDiscountDollars = discountStepDollars(appt, base);
    if (compound) {
      // poolLines is empty (a no-op inside allocateProRata) whenever there
      // is nothing to allocate — no separate `> 0` guard needed.
      const poolLines = eligibleLines.filter((line) => line.remaining > 0);
      allocateProRata(poolLines, base, (line) => line.remaining, appointmentDiscountDollars, (line, share) => {
        line.appointmentDiscountDollars = cents(line.appointmentDiscountDollars + share);
      });
    }
  }

  const outLines = state.map((line) => ({
    lineDiscountDollars: line.lineDiscountDollars,
    net: cents(Math.max(0, line.gross - line.lineDiscountDollars)),
    appointmentDiscountDollars: line.appointmentDiscountDollars,
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
 * The document model: several lines, each carrying its OWN ORDERED list of
 * discount terms (unlike stackVisitDiscounts' one-slot-per-line model — an
 * invoice line can carry a frozen stored stamp plus one or more fresh
 * picks), plus one shared list of document-wide terms that reach every
 * line (an invoice's manually-picked discountIds). Same four-step order as
 * stackVisitDiscounts: (1) each line's own fixed terms, in the order
 * given; (2) fixed document-wide terms, spread pro rata over lines that
 * still carry a balance (allocateProRata — same technique, same rounding,
 * as stackVisitDiscounts' fixed-appointment-credit pass); (3) each line's
 * own percent/free_service terms, on what's left; (4) percent/free_service
 * document-wide terms, on the total remainder across every line. A
 * document-level term reaches EVERY line — there is no `eligible` scoping
 * here, unlike the appointment discount above (no surface today needs a
 * per-line "Applies to" filter on an invoice-level discount) — and there
 * is no compound:false: the gate-off path never reaches this function, so
 * callers keep their own pre-lane math for that case (invoice.js's
 * create() computes each line discount off its own full line and each
 * manual discount independently against the untouched subtotal, exactly
 * as it did before this function existed).
 *
 * lines: [{ gross, terms: [{ discountType, amount, maxDiscountDollars? }, ...] }]
 * documentTerms: [{ discountType, amount, maxDiscountDollars? }, ...]
 * Returns { lines: [{ termDollars: [...], net }], documentTerms: [{ dollars }] }
 * — termDollars and documentTerms are parallel to the input arrays, same
 * convention as stackDiscounts' `items`.
 */
function stackDocumentDiscounts({ lines, documentTerms }) {
  const lineInput = Array.isArray(lines) ? lines : [];
  const docTerms = Array.isArray(documentTerms) ? documentTerms : [];

  const state = lineInput.map((line) => {
    const gross = Math.max(0, cents(line?.gross));
    const terms = Array.isArray(line?.terms) ? line.terms : [];
    return { gross, terms, termDollars: new Array(terms.length).fill(0), remaining: gross };
  });

  // 1. Fixed LINE terms, each line on its own gross.
  for (const line of state) {
    const fixedIdx = line.terms
      .map((t, i) => (isFixedDiscountType(t?.discountType) ? i : -1))
      .filter((i) => i >= 0);
    const stacked = stackDiscounts(line.gross, fixedIdx.map((i) => line.terms[i]), { compound: true });
    fixedIdx.forEach((termIdx, i) => { line.termDollars[termIdx] = stacked.items[i].dollars; });
    line.remaining = stacked.net;
  }

  // 2. Fixed DOCUMENT terms, spread pro rata over lines that still carry a
  // balance after step 1.
  const docDollars = new Array(docTerms.length).fill(0);
  const docFixedIdx = docTerms
    .map((t, i) => (isFixedDiscountType(t?.discountType) ? i : -1))
    .filter((i) => i >= 0);
  // A document term normally reaches EVERY line. `eligibleLines` (an array
  // of line indexes) restricts one to a subset — the invoice replay of a
  // scheduled appointment discount narrowed to one service through
  // discount_service_key_filter. Spreading such a credit over every line
  // moves the base the OTHER lines' percentages compound on, so a $30
  // add-on-only credit on two $100 lines turned a 10% primary-line discount
  // from $10 into $8.50 (Codex #4405 r3 P1). Terms are resolved one at a
  // time against their own pool: for unscoped terms that is exactly the
  // compounding stackDiscounts gave (stackOrder keeps input order within a
  // homogeneous fixed list), and a scoped term now only consumes the
  // balance of the lines it actually reaches.
  const termReachesLine = (term, lineIdx) => (
    !Array.isArray(term?.eligibleLines) || term.eligibleLines.includes(lineIdx)
  );
  for (const termIdx of docFixedIdx) {
    const term = docTerms[termIdx];
    const pool = state.filter((line, i) => line.remaining > 0 && termReachesLine(term, i));
    const poolTotal = cents(pool.reduce((sum, line) => sum + line.remaining, 0));
    const dollars = discountStepDollars(term, poolTotal);
    docDollars[termIdx] = dollars;
    if (!pool.length) continue;
    allocateProRata(pool, poolTotal, (line) => line.remaining, dollars, (line, share) => {
      line.remaining = cents(Math.max(0, line.remaining - share));
    });
  }

  // 3. LINE percent/free_service terms, on what's left after steps 1-2.
  for (const line of state) {
    const nonFixedIdx = line.terms
      .map((t, i) => (!isFixedDiscountType(t?.discountType) ? i : -1))
      .filter((i) => i >= 0);
    const stacked = stackDiscounts(line.remaining, nonFixedIdx.map((i) => line.terms[i]), { compound: true });
    nonFixedIdx.forEach((termIdx, i) => { line.termDollars[termIdx] = stacked.items[i].dollars; });
    line.remaining = stacked.net;
  }

  // 4. DOCUMENT percent/free_service terms, on the total remainder across
  // every line (no per-line allocation — no consumer needs a document
  // percentage's per-line share today, unlike the fixed pass above whose
  // allocation step 3 depends on). `eligibleLines` is deliberately NOT
  // honored here: the only scoped document term today is a frozen
  // appointment stamp, which is always fixed_amount and so never reaches
  // this pass. A scoped document PERCENTAGE would need its own pool here.
  const docNonFixedIdx = docTerms
    .map((t, i) => (!isFixedDiscountType(t?.discountType) ? i : -1))
    .filter((i) => i >= 0);
  const finalBase = cents(state.reduce((sum, line) => sum + line.remaining, 0));
  const docNonFixedStacked = stackDiscounts(finalBase, docNonFixedIdx.map((i) => docTerms[i]), { compound: true });
  docNonFixedIdx.forEach((termIdx, i) => { docDollars[termIdx] = docNonFixedStacked.items[i].dollars; });

  return {
    lines: state.map((line) => ({ termDollars: line.termDollars, net: line.remaining })),
    documentTerms: docDollars.map((dollars) => ({ dollars })),
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
  isVariableOrCustomDiscountPreset,
  stackDiscounts,
  stackVisitDiscounts,
  stackDocumentDiscounts,
  stackGroupConflict,
  assertStackGroups,
};
