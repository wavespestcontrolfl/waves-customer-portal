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

// Dollars -> integer cents, and back. Every dollar amount that reaches this
// module (gross, remaining, a stored discount amount) is already meant to
// be cent-precision — `cents()` above is the existing normalization for
// that — so `dollarsToCents` just rounds to the nearest integer cent,
// which is a no-op except for absorbing float noise left over from a
// caller's own arithmetic (e.g. 0.1 + 0.2). A genuinely sub-cent input
// (an operator or an upstream calc that hands this module $1.005) is
// normalized the same way money always is at the boundary: round HALF UP
// to the nearest cent, both here and in `cents()` above — never truncated,
// never banker's-rounded.
function dollarsToCents(dollars) {
  return Math.round((Number(dollars) || 0) * 100);
}

function centsToDollars(intCents) {
  return intCents / 100;
}

// Half-up round of the exact rational `numerator / denominator` (both
// non-negative integers) to the nearest integer, computed with NO
// intermediate floating-point division of the two operands — only the
// well-known integer identity floor((2n + d) / (2d)), whose own division
// is exact because 2n+d and 2d are both integers and the true quotient
// lands exactly on an integer whenever the halfway case is the question
// (the case ordinary `Math.round(n / d)` gets wrong: dividing dollars by
// a fraction first, e.g. 20.70 * 0.05, can leave the product one ulp
// below the true half-cent boundary — 1.035 comes back as
// 1.0349999999999999 in IEEE754 double — so an ordinary Math.round on
// that already-corrupted value rounds DOWN to $1.03 instead of the
// correct half-up $1.04). Working entirely in integers until this one
// division sidesteps that: the boundary is only ever crossed by the true
// mathematical value, never by representation error.
function roundHalfUpCents(numerator, denominator) {
  if (!(denominator > 0)) return 0;
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

function capDollars(dollars, maxDiscountDollars) {
  if (maxDiscountDollars == null || maxDiscountDollars === '') return dollars;
  const cap = Number(maxDiscountDollars);
  return Number.isFinite(cap) ? Math.min(dollars, Math.max(0, cap)) : dollars;
}

// The dollar (or percent) figure a discount row carries under either
// naming convention this module sees in practice — a catalog row's
// `amount` and a visit/invoice term's `discountAmount`. One place to read
// it so discountStepDollars and stackOrder's percent-rate comparison can
// never disagree about which field a given caller used.
function resolveDiscountAmount(discount) {
  return Number(discount?.amount ?? discount?.discountAmount) || 0;
}

// Dollars ONE discount takes off `remaining`, clamped to [0, remaining].
function discountStepDollars(discount, remaining) {
  if (!discount || !(remaining > 0)) return 0;
  const amount = resolveDiscountAmount(discount);
  let dollars = 0;
  if (isPercentDiscountType(discount.discountType)) {
    // Integer-cents basis-point math (Codex P1): remainingCents and
    // pctBasisPoints are both exact integers, so roundHalfUpCents' single
    // division depends only on the true mathematical ratio, never on the
    // float noise `remaining * (amount / 100)` used to produce (dollars *
    // 0.05-ish fraction, then round). amount is normalized to hundredths
    // of a percent (2 more decimal digits than the percent itself) —
    // plenty of precision for any catalog or operator-entered rate, and
    // documented here as the one place that precision is decided.
    const remainingCents = dollarsToCents(remaining);
    const pctBasisPoints = Math.round(amount * 100);
    const dollarsCents = roundHalfUpCents(remainingCents * pctBasisPoints, 10000);
    dollars = capDollars(centsToDollars(dollarsCents), discount.maxDiscountDollars);
  } else if (isFixedDiscountType(discount.discountType)) {
    dollars = amount;
  } else if (discount.discountType === 'free_service') {
    dollars = remaining;
  }
  return Math.min(remaining, Math.max(0, cents(dollars)));
}

// Fixed credits first (in the order given), then percentages, then a free
// service (which takes whatever is left).
//
// Percentages compound multiplicatively, so in EXACT math 5% then 10% and
// 10% then 5% reach the identical final total — multiplication commutes.
// But each step is rounded to the nearest cent as it's taken, and the SUM
// of independently-rounded steps is not itself commutative: $99 at 5% then
// 10% (in that input order) totaled a cent different from 10% then 5%
// before this fix (Codex pre-push audit P2). Rather than carry exact
// unrounded fractions through the whole stack (which would still need a
// rule for how to divide the eventual rounding among the individual
// items), percentages are sorted into ONE canonical order regardless of
// how the caller listed them — largest rate first, ties broken by input
// index for stability — so two calls stacking the SAME set of percentages
// always compound in the SAME sequence and land on the SAME total, no
// matter which order they were entered in. Each item's reported `dollars`
// still reflects its own place in that canonical compounding (mapped back
// to its original input index for the caller), which is what keeps
// per-term reporting exact: it sums to totalDollars precisely because it
// IS the sequence that produced totalDollars, not a separate estimate of
// it. Fixed credits and the free-service catch-all are unaffected — a
// fixed dollar figure doesn't depend on compounding order the way a
// percentage does, and there is normally at most one free service in a
// stack (it takes whatever remains, regardless of position).
function stackOrder(discounts) {
  const rank = (d) => (isFixedDiscountType(d?.discountType) ? 0 : isPercentDiscountType(d?.discountType) ? 1 : 2);
  return discounts
    .map((discount, index) => ({ discount, index }))
    .sort((a, b) => {
      const rankDiff = rank(a.discount) - rank(b.discount);
      if (rankDiff !== 0) return rankDiff;
      if (rank(a.discount) === 1) {
        const rateDiff = resolveDiscountAmount(b.discount) - resolveDiscountAmount(a.discount);
        if (rateDiff !== 0) return rateDiff;
      }
      return a.index - b.index;
    });
}

// Spread `totalDollars` pro rata across `poolLines` by `weightOf(line)`,
// in integer cents, with a deterministic largest-remainder rounding so the
// shares always sum to exactly totalDollars. `pool` is the caller's own
// sum of weightOf(line) over poolLines — passed in rather than recomputed
// here because the caller already needed it to size totalDollars via
// discountStepDollars/stackDiscounts before allocating it. Calls
// `apply(line, share)` to let the caller fold each share into its own line
// shape. Shared by stackVisitDiscounts (the fixed-appointment-credit pass
// and the percentage/free-service pass) and stackDocumentDiscounts (the
// analogous fixed-document-credit pass) — same technique, same rounding,
// so a line's pro-rata share means the same cent-for-cent thing on every
// surface.
//
// weightOf(line) doubles as each line's own CEILING here — every current
// caller passes the line's own remaining balance as the weight, which is
// exactly the amount that line has left to absorb, so a share can never
// exceed weightOf(line) without over-discounting that line specifically.
// The old "last line takes the undistributed remainder" technique (Codex
// #4405 r3, fixed there for the negative-share case) didn't enforce that
// per-line ceiling: it only kept every share >= 0 and the total exactly
// right, so an unlucky split could still hand the LAST line more than its
// own balance holds — an $0.08 credit over $0.04/$0.04/$0.04/$0.01
// balances rounded three shares up to $0.02 each (proportional, floor-then-
// bump), leaving $0.02 for a line that only has $0.01 (Codex P1).
//
// This version floors every line's raw proportional share first (which,
// since totalCents <= poolCents by construction, can never floor ABOVE
// that line's own cap), then hands out the few leftover cents one at a
// time — largest fractional remainder first, line index as the tiebreak
// for determinism — skipping any line already at its cap. A line at its
// cap already has a raw share with zero fractional remainder (a whole
// number of cents divides its own cap exactly), so it always sorts behind
// every line that still has room; the total headroom left across the pool
// is provably >= the leftover being distributed, so this always finishes
// in one pass over `poolLines`, never exceeding any line's own balance.
function allocateProRata(poolLines, pool, weightOf, totalDollars, apply) {
  if (!poolLines.length) return;
  const poolCents = dollarsToCents(pool);
  // totalDollars is always <= pool by construction (discountStepDollars
  // clamps whatever it resolves to the pool it was computed against), but
  // clamp again here defensively so a future caller bug can never demand
  // more than the pool actually holds.
  const totalCents = Math.max(0, Math.min(dollarsToCents(totalDollars), poolCents));
  if (poolCents <= 0 || totalCents <= 0) {
    poolLines.forEach((line) => apply(line, 0));
    return;
  }
  const capCents = poolLines.map((line) => Math.max(0, dollarsToCents(weightOf(line))));
  const shares = capCents.map((cap) => Math.floor((totalCents * cap) / poolCents));
  const remainders = capCents.map((cap, i) => (totalCents * cap) / poolCents - shares[i]);
  let leftover = totalCents - shares.reduce((sum, share) => sum + share, 0);
  const order = shares
    .map((_, i) => i)
    .sort((a, b) => remainders[b] - remainders[a] || a - b);
  for (const idx of order) {
    if (leftover <= 0) break;
    if (shares[idx] < capCents[idx]) {
      shares[idx] += 1;
      leftover -= 1;
    }
  }
  poolLines.forEach((line, i) => apply(line, centsToDollars(shares[i])));
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
  // compound:false (legacy/gate-off): each discount is still individually
  // sized against the FULL base — that's the defining legacy behavior,
  // kept as-is — but several full-base discounts can together add up to
  // more than the base holds ($80 + $50 fixed on a $100 base is $130).
  // `budget` bounds what the AGGREGATE (and so each item, in the same
  // fixed-then-percent-then-free-service order the loop already uses) is
  // allowed to count toward the total, so totalDollars never exceeds
  // `full` and the invariant totalDollars === full - net holds here too
  // (Codex pre-push audit P2). compound:true doesn't need this — its own
  // `remaining` already shrinks step to step, so discountStepDollars'
  // own clamp keeps every step within what's left.
  let budget = full;
  const dollarsByIndex = new Array(list.length).fill(0);
  for (const { discount, index } of stackOrder(list)) {
    const raw = discountStepDollars(discount, compound ? remaining : full);
    const dollars = compound ? raw : Math.min(raw, Math.max(0, cents(budget)));
    dollarsByIndex[index] = dollars;
    if (compound) {
      remaining = cents(remaining - dollars);
    } else {
      budget = cents(budget - dollars);
    }
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
  // Which pass the appointment discount belongs to is one decision, not
  // two: step 2 (the fixed-credit pass) takes it exactly when compounding
  // AND it's a fixed credit; step 4 (the percent / legacy-catch-all pass)
  // takes it in every other case where it exists at all. Computing that
  // once here and reusing it (negated) in step 4's own condition removes
  // the duplicated `compound` / `isFixedDiscountType(appt...)` logic that
  // used to appear, inverted, in both conditions separately.
  const apptInFixedPass = compound && !!appt && isFixedDiscountType(appt.discountType);

  // 1. Fixed line credits (legacy: every line credit, in one pass).
  for (const line of state) {
    if (!compound || isFixedDiscountType(line.lineDiscount?.discountType)) {
      line.lineDiscountDollars = discountStepDollars(line.lineDiscount, line.remaining);
      line.remaining = cents(line.remaining - line.lineDiscountDollars);
    }
  }

  // 2. Fixed appointment credit, spread pro rata over the eligible lines.
  let appointmentDiscountDollars = 0;
  if (apptInFixedPass) {
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
  if (appt && !apptInFixedPass) {
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
 * document-wide terms, each against its own remaining pool. A document-
 * level term reaches EVERY line by default, but an `eligibleLines` array on
 * the term (index into `lines`) narrows it to a subset — fixed, percentage,
 * and free_service terms all honor it (steps 2 and 4 both resolve one term
 * at a time against just the lines it reaches), the replay of a scheduled
 * appointment discount's own "Applies to" line scope. There is still no
 * compound:false: the gate-off path never reaches this function, so
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

  // 4. DOCUMENT percent/free_service terms — same per-term pool technique
  // as the fixed pass above (step 2), now honoring `eligibleLines` for
  // these types too (Codex pre-push audit P1). This used to batch every
  // non-fixed document term into one stackDiscounts() call against the
  // total remainder across ALL lines, on the reasoning that "the only
  // scoped document term today is a frozen appointment stamp, which is
  // always fixed_amount" — but calculateVisitFinancialsForAddons already
  // supports a service-SCOPED percentage appointment discount, and the
  // catalog has a service-scoped free_service preset; replaying either as
  // a document term here computed against every line regardless of scope,
  // so an unrelated service got discounted too, and a scoped free_service
  // term could zero the WHOLE invoice instead of just its own line.
  // Resolved one term at a time against its own eligible pool's CURRENT
  // remainder — an unscoped term still reaches every line still carrying a
  // balance and, since its pool then equals the old finalBase, compounds
  // to the identical total a document-wide percentage always had. Per-line
  // allocation is a natural side effect of needing a real per-term pool at
  // all now (the old "no consumer needs a per-line share" reasoning no
  // longer holds once scoping requires this pool in the first place), and
  // it's what actually lets the eligible line's own net reflect the
  // discount instead of just the aggregate documentTerms[].dollars figure.
  //
  // Processed in the SAME canonical order stackOrder gives stackDiscounts
  // (Codex pre-push audit P1, round 2): percentages here used to compound
  // in plain input order, so the shared engine disagreed with itself — the
  // exact discounts entered in the same order gave a different total
  // through stackDocumentDiscounts than through stackDiscounts. Running
  // stackOrder over just the non-fixed terms (it already sorts percentages
  // rate-descending, index tiebreak, and free_service last) and mapping its
  // sub-list index back to each term's real position in docTerms keeps
  // every term's own eligibleLines and its docDollars/result slot exactly
  // where the caller put it — only the ORDER they're resolved in changes.
  const docNonFixedIdx = docTerms
    .map((t, i) => (!isFixedDiscountType(t?.discountType) ? i : -1))
    .filter((i) => i >= 0);
  const docNonFixedOrder = stackOrder(docNonFixedIdx.map((i) => docTerms[i]));
  for (const { index: subIdx } of docNonFixedOrder) {
    const termIdx = docNonFixedIdx[subIdx];
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
