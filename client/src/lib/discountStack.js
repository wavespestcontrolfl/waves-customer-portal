/**
 * Discount stacking — client companion of server/services/discount-stack.js
 * (never import the server module into the Vite bundle). Every discount
 * preview in the admin app derives its dollars from here so the number on
 * screen is the number the server saves.
 *
 * Owner ruling 2026-09-11 ("lesser of the two"): stacked discounts compound
 * in sequence — 10% then 5% is 14.5%, never an additive 15% — and dollar
 * credits come off first, with the percentages compounding on what is
 * left. Non-stackable catalog groups (the WaveGuard tiers) never combine.
 *
 * `compound: false` is the pre-ruling math, so a surface can preview what
 * the server will actually save while GATE_DISCOUNT_STACKING is dark
 * (useDiscountStacking reads the gate).
 */

export function isPercentDiscountType(type) {
  return type === 'percentage' || type === 'variable_percentage';
}

export function isFixedDiscountType(type) {
  return type === 'fixed_amount' || type === 'variable_amount';
}

/**
 * Is this catalog row a VARIABLE/CUSTOM preset — one whose real amount the
 * operator types per use, so the catalog's own `amount` stays 0 and the
 * entered value is stored on the row? The variable_* types, plus the seeded
 * custom_percent / custom_dollar rows and any row of a fixed/percent type
 * left with no positive amount.
 *
 * One pair of predicates because FOUR surfaces have to agree: the Create
 * Appointment picker, the Edit Appointment (SchedulePage) picker, the
 * invoice builder's picker, and — on the server — reconstructStoredLineSlot
 * and lineItemDiscountTerm (isVariableOrCustomDiscountPreset in
 * server/services/discount-stack.js). Every round of review on this lane
 * found another copy that had missed the variable_* types and so skipped the
 * operator prompt, creating a zero-valued slot the server then dropped
 * (Codex #4405 r2 and r3).
 */
export function isCustomAmountPreset(d) {
  return d?.discount_type === 'variable_amount'
    || (d?.discount_type === 'fixed_amount'
      && (d?.discount_key === 'custom_dollar' || !(Number(d?.amount) > 0)));
}

export function isCustomPercentagePreset(d) {
  return d?.discount_type === 'variable_percentage'
    || (d?.discount_type === 'percentage'
      && (d?.discount_key === 'custom_percent' || !(Number(d?.amount) > 0)));
}

function cents(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function capDollars(dollars, maxDiscountDollars) {
  if (maxDiscountDollars == null || maxDiscountDollars === '') return dollars;
  const cap = Number(maxDiscountDollars);
  return Number.isFinite(cap) ? Math.min(dollars, Math.max(0, cap)) : dollars;
}

// Accepts either the catalog row shape ({ discount_type, amount,
// max_discount_dollars }) or the camelCase stamp shape.
function normalize(discount) {
  if (!discount) return null;
  return {
    discountType: discount.discountType || discount.discount_type || null,
    amount: discount.amount ?? discount.discountAmount ?? 0,
    maxDiscountDollars: discount.maxDiscountDollars ?? discount.max_discount_dollars ?? null,
  };
}

function discountStepDollars(raw, remaining) {
  const discount = normalize(raw);
  if (!discount || !(remaining > 0)) return 0;
  const amount = Number(discount.amount) || 0;
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

function stackOrder(discounts) {
  const rank = (d) => {
    const type = normalize(d)?.discountType;
    return isFixedDiscountType(type) ? 0 : isPercentDiscountType(type) ? 1 : 2;
  };
  return discounts
    .map((discount, index) => ({ discount, index }))
    .sort((a, b) => rank(a.discount) - rank(b.discount) || a.index - b.index);
}

/**
 * Stack several discounts on one base. compound=false resolves each against
 * the full base instead (legacy).
 * Returns { items: [{ index, dollars }], totalDollars, net }.
 */
export function stackDiscounts(base, discounts, { compound = true } = {}) {
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
 * The visit model: one line slot per line plus one appointment slot that
 * reaches the lines marked `eligible`. Mirrors the server byte for byte.
 * lines: [{ gross, lineDiscount, eligible }]
 */
/**
 * Split `totalDollars` across `poolLines` in proportion to weightOf(line),
 * the last line absorbing the rounding remainder so the shares sum to
 * exactly totalDollars. Every share is clamped to what is still
 * undistributed: without that, several independently-rounded shares can
 * together exceed the total and leave the last line a NEGATIVE share
 * ($0.02 over four equal lines gives $0.01/$0.01/$0.01/-$0.01). Mirrors
 * allocateProRata in server/services/discount-stack.js cent for cent.
 */
function allocateProRata(poolLines, pool, weightOf, totalDollars, apply) {
  let allocated = 0;
  poolLines.forEach((line, i) => {
    const undistributed = cents(totalDollars - allocated);
    const share = i === poolLines.length - 1
      ? Math.max(0, undistributed)
      : Math.max(0, Math.min(undistributed, cents(totalDollars * (weightOf(line) / pool))));
    allocated = cents(allocated + share);
    apply(line, share);
  });
}

export function stackVisitDiscounts({ lines, appointmentDiscount, compound = true }) {
  const input = Array.isArray(lines) ? lines : [];
  const state = input.map((line) => ({
    gross: Math.max(0, cents(line?.gross)),
    remaining: Math.max(0, cents(line?.gross)),
    lineDiscount: normalize(line?.lineDiscount),
    eligible: line?.eligible !== false,
    lineDiscountDollars: 0,
  }));
  const appt = normalize(appointmentDiscount);
  const apptActive = appt && appt.discountType ? appt : null;

  for (const line of state) {
    if (!compound || isFixedDiscountType(line.lineDiscount?.discountType)) {
      line.lineDiscountDollars = discountStepDollars(line.lineDiscount, line.remaining);
      line.remaining = cents(line.remaining - line.lineDiscountDollars);
    }
  }

  let appointmentDiscountDollars = 0;
  if (compound && apptActive && isFixedDiscountType(apptActive.discountType)) {
    const eligible = state.filter((line) => line.eligible && line.remaining > 0);
    const pool = cents(eligible.reduce((sum, line) => sum + line.remaining, 0));
    appointmentDiscountDollars = discountStepDollars(apptActive, pool);
    allocateProRata(eligible, pool, (line) => line.remaining, appointmentDiscountDollars, (line, share) => {
      line.remaining = cents(Math.max(0, line.remaining - share));
    });
  }

  for (const line of state) {
    const type = line.lineDiscount?.discountType;
    if (compound && (isPercentDiscountType(type) || type === 'free_service')) {
      line.lineDiscountDollars = discountStepDollars(line.lineDiscount, line.remaining);
      line.remaining = cents(line.remaining - line.lineDiscountDollars);
    }
  }

  if (apptActive && (!compound || !isFixedDiscountType(apptActive.discountType))) {
    const base = cents(state.reduce((sum, line) => (line.eligible ? sum + line.remaining : sum), 0));
    appointmentDiscountDollars = discountStepDollars(apptActive, base);
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
 * The invoice document model, mirroring stackDocumentDiscounts in
 * server/services/discount-stack.js. Several lines, each with its OWN
 * ordered term list, plus document-wide terms that reach every line (or,
 * with `eligibleLines`, a named subset — a scheduled appointment discount
 * narrowed to one service). Same four steps as the visit stack: line fixed
 * terms, document fixed terms spread pro rata, line percentages, document
 * percentages.
 *
 * This used to be server-only: the invoice preview stacked each parent line
 * in isolation, which was right until a stored APPOINTMENT-level stamp (no
 * parent line, reaching the whole document) had to participate. Without the
 * mirror the preview showed $85 on a $100 invoice where the server saved
 * $85.50.
 *
 * lines: [{ gross, terms: [{ discountType, amount, maxDiscountDollars? }] }]
 * documentTerms: [{ discountType, amount, maxDiscountDollars?, eligibleLines? }]
 * Returns { lines: [{ termDollars: [...], net }], documentTerms: [{ dollars }] }.
 */
export function stackDocumentDiscounts({ lines, documentTerms }) {
  const lineInput = Array.isArray(lines) ? lines : [];
  const docTerms = Array.isArray(documentTerms) ? documentTerms : [];

  const state = lineInput.map((line) => {
    const gross = Math.max(0, cents(line?.gross));
    const terms = Array.isArray(line?.terms) ? line.terms : [];
    return { gross, terms, termDollars: new Array(terms.length).fill(0), remaining: gross };
  });

  // 1. Fixed LINE terms, each on its own gross.
  for (const line of state) {
    const fixedIdx = line.terms
      .map((t, i) => (isFixedDiscountType(t?.discountType) ? i : -1))
      .filter((i) => i >= 0);
    const stacked = stackDiscounts(line.gross, fixedIdx.map((i) => line.terms[i]), { compound: true });
    fixedIdx.forEach((termIdx, i) => { line.termDollars[termIdx] = stacked.items[i].dollars; });
    line.remaining = stacked.net;
  }

  // 2. Fixed DOCUMENT terms, each over its own eligible pool.
  const docDollars = new Array(docTerms.length).fill(0);
  const termReachesLine = (term, lineIdx) => (
    !Array.isArray(term?.eligibleLines) || term.eligibleLines.includes(lineIdx)
  );
  docTerms.forEach((term, termIdx) => {
    if (!isFixedDiscountType(term?.discountType)) return;
    const pool = state.filter((line, i) => line.remaining > 0 && termReachesLine(term, i));
    const poolTotal = cents(pool.reduce((sum, line) => sum + line.remaining, 0));
    docDollars[termIdx] = discountStepDollars(term, poolTotal);
    if (!pool.length) return;
    allocateProRata(pool, poolTotal, (line) => line.remaining, docDollars[termIdx], (line, share) => {
      line.remaining = cents(Math.max(0, line.remaining - share));
    });
  });

  // 3. LINE percent/free_service terms, on what is left.
  for (const line of state) {
    const nonFixedIdx = line.terms
      .map((t, i) => (!isFixedDiscountType(t?.discountType) ? i : -1))
      .filter((i) => i >= 0);
    const stacked = stackDiscounts(line.remaining, nonFixedIdx.map((i) => line.terms[i]), { compound: true });
    nonFixedIdx.forEach((termIdx, i) => { line.termDollars[termIdx] = stacked.items[i].dollars; });
    line.remaining = stacked.net;
  }

  // 4. DOCUMENT percent/free_service terms, on the total remainder.
  const docNonFixedIdx = docTerms
    .map((t, i) => (t && !isFixedDiscountType(t.discountType) ? i : -1))
    .filter((i) => i >= 0);
  const finalBase = cents(state.reduce((sum, line) => sum + line.remaining, 0));
  const docNonFixedStacked = stackDiscounts(finalBase, docNonFixedIdx.map((i) => docTerms[i]), { compound: true });
  docNonFixedIdx.forEach((termIdx, i) => { docDollars[termIdx] = docNonFixedStacked.items[i].dollars; });

  return {
    lines: state.map((line) => ({ termDollars: line.termDollars, net: line.remaining })),
    documentTerms: docDollars.map((dollars) => ({ dollars })),
  };
}

/** First non-stackable stack_group clash among catalog rows, or null. */
export function stackGroupConflict(rows) {
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

/**
 * Catalog rows a picker may still offer once `chosen` rows are on the
 * document: a non-stackable group already in use hides its other members
 * (the same row stays offered — one tier on two lines is fine).
 */
export function stackablePresets(presets, chosen, { scope, spansAll = false } = {}) {
  const usedGroups = new Map();
  for (const row of Array.isArray(chosen) ? chosen : []) {
    if (!row || !row.stack_group || row.is_stackable === true) continue;
    const group = String(row.stack_group);
    usedGroups.set(group, [...(usedGroups.get(group) || []), row]);
  }
  return (Array.isArray(presets) ? presets : []).filter((preset) => {
    if (!preset?.stack_group || preset.is_stackable === true) return true;
    const held = usedGroups.get(String(preset.stack_group)) || [];
    // Mirrors stackGroupConflict: the same row stays offered only where it
    // would land on a different lane and neither side spans the document.
    return held.every((row) => (
      String(row.id || row.name) === String(preset.id || preset.name)
      && row.spansAll !== true
      && !spansAll
      && String(row.scope ?? '') !== String(scope ?? '')
    ));
  });
}
