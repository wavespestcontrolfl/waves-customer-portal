/**
 * Discount stacking — client companion of server/services/discount-stack.js
 * (never import the server module into the Vite bundle). Every discount
 * preview in the admin app derives its dollars from here so the number on
 * screen is the number the server saves. Parity is enforced by a test that
 * runs the same random fixtures through both modules directly
 * (discountStack.server-parity.test.js) plus a shuffle-invariance property
 * test (discountStack.shuffle-property.test.js), mirroring
 * server/tests/discount-stack-canonical-order-property.test.js.
 *
 * Owner ruling 2026-09-11 ("lesser of the two"): stacked discounts compound
 * in sequence, each on what is left — 10% then 5% is 14.5%, never an
 * additive 15%. Dollar credits come off FIRST, percentages compound on the
 * remainder. `compound: false` is the pre-ruling math, kept so a surface can
 * preview what the server will save while GATE_DISCOUNT_STACKING is dark.
 *
 * CANONICAL ORDER (stackOrder below; full rationale + the Codex rounds that
 * forced each step lives on the server module) — every discount sorts by
 * ONE key, most significant first: SLOT (fixed, any slot, first; then line
 * percent/free_service; then document percent/free_service), KIND (fixed <
 * percent < free_service), VALUE (larger amount first), CAP (tighter cap
 * first, percentages only), SCOPE (wider eligibleLines first), IDENTITY
 * (stable id beats input position; identified before anonymous), INDEX
 * (last resort).
 *
 * `normalize()` is the one thing this file adds beyond a straight port:
 * server callers already hand every function the camelCase shape; client
 * callers pass raw catalog rows (discount_type, max_discount_dollars,
 * discount_key) or the camelCase shape interchangeably. Every field-reading
 * function normalizes its input first (idempotent on an already-normalized
 * object), so the canonical-order logic stays byte-identical to the server's.
 */

export function isPercentDiscountType(type) {
  return type === 'percentage' || type === 'variable_percentage';
}

export function isFixedDiscountType(type) {
  return type === 'fixed_amount' || type === 'variable_amount';
}

// A VARIABLE/CUSTOM catalog preset — the operator types the real amount per
// use. Split in two so a picker knows which value to prompt for. Detected
// ONLY by the variable_* type or the explicit seeded custom_percent /
// custom_dollar key -- GitHub review round 3 P1 (PR #4656): this used to
// ALSO treat any fixed_amount/percentage row with a non-positive catalog
// `amount` as custom (matching the server's OWN isVariableOrCustomDiscountPreset
// / normalizeDiscountAmount, which honor a client-supplied override for the
// exact same broad rule) -- but a REAL zero-percent non-stackable catalog
// tier (WaveGuard Bronze: discount_type 'percentage', amount 0, no
// discount_key at all) is not a custom preset at all, and prompting for one
// on it let an operator's typed value persist as a real recurring discount
// on a tier that is supposed to be a flat, non-editable zero. The
// server-side rule stays broader (out of this slice's file-ownership
// scope), but nothing on this surface can trigger it once the client never
// prompts for (or sends an override on) a non-custom zero-amount preset.
export function isCustomAmountPreset(d) {
  return d?.discount_type === 'variable_amount'
    || (d?.discount_type === 'fixed_amount' && d?.discount_key === 'custom_dollar');
}

export function isCustomPercentagePreset(d) {
  return d?.discount_type === 'variable_percentage'
    || (d?.discount_type === 'percentage' && d?.discount_key === 'custom_percent');
}

function cents(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function dollarsToCents(dollars) {
  return Math.round((Number(dollars) || 0) * 100);
}

function centsToDollars(intCents) {
  return intCents / 100;
}

// Half-up round of numerator/denominator with NO intermediate float
// division — floor((2n + d) / (2d)). Ordinary Math.round(n / d) rounds the
// WRONG way at an exact half-cent boundary (1.035 -> 1.0349999999999999 in
// IEEE754, so $1.04 comes back as $1.03).
function roundHalfUpCents(numerator, denominator) {
  if (!(denominator > 0)) return 0;
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

function capDollars(dollars, maxDiscountDollars) {
  if (maxDiscountDollars == null || maxDiscountDollars === '') return dollars;
  const cap = Number(maxDiscountDollars);
  return Number.isFinite(cap) ? Math.min(dollars, Math.max(0, cap)) : dollars;
}

// The ONE normalization point: a catalog row, the camelCase stamp shape, or
// an already-normalized object (spread-copied below to tag a synthetic
// scope) — every downstream resolver calls this first. slot/eligibleLines/id
// are camelCase-only in every caller this module has ever seen.
function normalize(discount) {
  if (!discount) return null;
  return {
    discountType: discount.discountType || discount.discount_type || null,
    amount: discount.amount ?? discount.discountAmount ?? 0,
    maxDiscountDollars: discount.maxDiscountDollars ?? discount.max_discount_dollars ?? null,
    slot: discount.slot === 'document' ? 'document' : 'line',
    eligibleLines: Array.isArray(discount.eligibleLines) ? discount.eligibleLines : null,
    id: discount.id ?? discount.discount_key ?? undefined,
  };
}

function resolveDiscountAmount(discount) {
  return Number(normalize(discount)?.amount) || 0;
}

function resolveDiscountSlot(discount) {
  return normalize(discount)?.slot === 'document' ? 'document' : 'line';
}

// A finite maxDiscountDollars, or +Infinity for "no cap" so uncapped always
// sorts after every real cap.
function resolveDiscountCap(discount) {
  const n = normalize(discount);
  const cap = Number(n?.maxDiscountDollars);
  return n?.maxDiscountDollars == null || n?.maxDiscountDollars === '' || !Number.isFinite(cap)
    ? Infinity
    : cap;
}

// Smaller cap sorts FIRST; equal caps (including two uncapped, both
// +Infinity) are a genuine tie (0), never NaN — plain subtraction of two
// Infinitys is NaN, which breaks sort's total-order contract.
function compareDiscountCap(a, b) {
  const capA = resolveDiscountCap(a);
  const capB = resolveDiscountCap(b);
  if (capA === capB) return 0;
  if (capA === Infinity) return 1;
  if (capB === Infinity) return -1;
  return capA - capB;
}

// A discount's SCOPE: how many lines it reaches, and which ones.
// `eligibleLines` absent means "every line" — +Infinity width, so it sorts
// before any finite (narrower) scope. `ids` are sorted-ascending so two
// scopes carrying the same set in different orders compare equal.
function resolveDiscountScope(discount) {
  const eligibleLines = normalize(discount)?.eligibleLines;
  if (!Array.isArray(eligibleLines)) return { width: Infinity, ids: null };
  return { width: eligibleLines.length, ids: [...eligibleLines].map(Number).sort((a, b) => a - b) };
}

// Wider scope (unscoped widest of all) sorts FIRST; a tie on width falls
// through to a lexicographic compare of the sorted line ids, and a tie on
// both leaves the decision to the identity/index tiebreaks.
function compareDiscountScope(a, b) {
  const scopeA = resolveDiscountScope(a);
  const scopeB = resolveDiscountScope(b);
  if (scopeA.width !== scopeB.width) return scopeB.width - scopeA.width;
  if (!scopeA.ids || !scopeB.ids) return 0;
  for (let i = 0; i < scopeA.ids.length; i++) {
    if (scopeA.ids[i] !== scopeB.ids[i]) return scopeA.ids[i] - scopeB.ids[i];
  }
  return 0;
}

function resolveDiscountId(discount) {
  return normalize(discount)?.id;
}

// IDENTIFIED terms sort before ANONYMOUS ones (arbitrary but fixed).
// Returning 0 whenever EITHER side lacks an identity is not a valid
// comparator — it makes anonymous-vs-identified pairs intransitive and lets
// an anonymous term's position depend on shuffle order (see the server
// property test's round-8 case).
function compareDiscountIdentity(a, b) {
  const idA = resolveDiscountId(a);
  const idB = resolveDiscountId(b);
  const hasA = idA !== undefined;
  const hasB = idB !== undefined;
  if (hasA !== hasB) return hasA ? -1 : 1;
  if (!hasA) return 0;
  const strA = String(idA);
  const strB = String(idB);
  if (strA === strB) return 0;
  return strA < strB ? -1 : 1;
}

// A percentage discount's dollars against `baseDollars`, cent-exact:
// integer-cents basis-point math, so roundHalfUpCents' single division
// depends only on the true ratio, never the float noise
// `baseDollars * (ratePercent / 100)` produces — 5% of $20.70 is the
// correct half-up $1.04, never $1.03.
export function percentageDiscountDollars(baseDollars, ratePercent, maxDiscountDollars) {
  const baseCents = dollarsToCents(baseDollars);
  const pctBasisPoints = Math.round((Number(ratePercent) || 0) * 100);
  const dollarsCents = roundHalfUpCents(baseCents * pctBasisPoints, 10000);
  return capDollars(centsToDollars(dollarsCents), maxDiscountDollars);
}

// Dollars ONE discount takes off `remaining`, clamped to [0, remaining].
function discountStepDollars(raw, remaining) {
  const discount = normalize(raw);
  if (!discount || !(remaining > 0)) return 0;
  const amount = Number(discount.amount) || 0;
  let dollars = 0;
  if (isPercentDiscountType(discount.discountType)) {
    dollars = percentageDiscountDollars(remaining, amount, discount.maxDiscountDollars);
  } else if (isFixedDiscountType(discount.discountType)) {
    dollars = amount;
  } else if (discount.discountType === 'free_service') {
    dollars = remaining;
  }
  return Math.min(remaining, Math.max(0, cents(dollars)));
}

// Implements the CANONICAL ORDER key above. `rank` encodes SLOT+KIND as
// five buckets: 0 fixed (any slot), 1 line-percent, 2 line-free_service, 3
// document-percent, 4 document-free_service — no `slot` set always lands in
// the line bucket, so a flat stackDiscounts() call collapses to plain
// fixed-then-percent-then-free_service.
function stackOrder(discounts) {
  const rank = (d) => {
    const type = normalize(d)?.discountType;
    if (isFixedDiscountType(type)) return 0;
    const slotBase = resolveDiscountSlot(d) === 'document' ? 3 : 1;
    return isPercentDiscountType(type) ? slotBase : slotBase + 1;
  };
  const isPercentRank = (r) => r === 1 || r === 3;
  return discounts
    .map((discount, index) => ({ discount, index }))
    .sort((a, b) => {
      const rankA = rank(a.discount);
      const rankDiff = rankA - rank(b.discount);
      if (rankDiff !== 0) return rankDiff;
      const valueDiff = resolveDiscountAmount(b.discount) - resolveDiscountAmount(a.discount);
      if (valueDiff !== 0) return valueDiff;
      if (isPercentRank(rankA)) {
        const capDiff = compareDiscountCap(a.discount, b.discount);
        if (capDiff !== 0) return capDiff;
      }
      const scopeDiff = compareDiscountScope(a.discount, b.discount);
      if (scopeDiff !== 0) return scopeDiff;
      const identityDiff = compareDiscountIdentity(a.discount, b.discount);
      if (identityDiff !== 0) return identityDiff;
      return a.index - b.index;
    });
}

// Spread `totalDollars` pro rata across `poolLines` by `weightOf(line)`, in
// integer cents, largest-remainder rounding so shares sum to exactly
// totalDollars AND no share exceeds that line's own weight (its balance).
// The naive "last line takes the rounding remainder" technique doesn't
// enforce that ceiling: an $0.08 credit over $0.04/$0.04/$0.04/$0.01
// balances could round three shares up to $0.02, leaving $0.02 for a line
// that only holds $0.01. This floors every raw proportional share first
// (which can never exceed its own cap), then hands out the leftover cents
// one at a time, largest fractional remainder first, skipping a line
// already at its cap.
function allocateProRata(poolLines, pool, weightOf, totalDollars, apply) {
  if (!poolLines.length) return;
  const poolCents = dollarsToCents(pool);
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

// Stack several discounts on one base amount. compound=false resolves each
// against the full base instead (legacy) — `budget` bounds the aggregate so
// several full-base discounts never total more than the base holds, walking
// the list in EXACTLY the order given (no canonicalization) to reproduce a
// caller's own pre-lane math. Returns
// { items: [{ index, dollars }] (input order), totalDollars, net }.
export function stackDiscounts(base, discounts, { compound = true } = {}) {
  const list = Array.isArray(discounts) ? discounts : [];
  const full = Math.max(0, cents(base));
  let remaining = full;
  let budget = full;
  const dollarsByIndex = new Array(list.length).fill(0);
  const order = compound
    ? stackOrder(list)
    : list.map((discount, index) => ({ discount, index }));
  for (const { discount, index } of order) {
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

// The visit model: one discount slot per line plus one appointment-level
// slot reaching the lines the caller marks `eligible`. Mirrors
// stackVisitDiscounts in server/services/discount-stack.js — same four-step
// order (fixed credits across BOTH slots in one canonical pass, then line
// percent/free_service, then any leftover appointment discount), same
// per-line appointmentDiscountDollars pro-rata share.
// lines: [{ gross, lineDiscount, eligible }]. Returns
// { lines: [{ lineDiscountDollars, net, appointmentDiscountDollars }],
// subtotal, appointmentDiscountDollars, total }.
export function stackVisitDiscounts({ lines, appointmentDiscount, compound = true }) {
  const input = Array.isArray(lines) ? lines : [];
  const state = input.map((line) => ({
    gross: Math.max(0, cents(line?.gross)),
    remaining: Math.max(0, cents(line?.gross)),
    lineDiscount: normalize(line?.lineDiscount),
    eligible: line?.eligible !== false,
    lineDiscountDollars: 0,
    appointmentDiscountDollars: 0,
  }));
  const apptNormalized = normalize(appointmentDiscount);
  const appt = apptNormalized && apptNormalized.discountType ? apptNormalized : null;
  const apptInFixedPass = compound && !!appt && isFixedDiscountType(appt.discountType);

  // 1 & 2. Fixed credits. Legacy: every line's own discount resolves here
  // unconditionally, in given order. Compounding: ALL fixed credits, line
  // AND appointment alike, are ordered by the canonical key before ANY
  // apply — a line's own fixed credit is tagged with a synthetic
  // single-line eligibleLines purely so compareDiscountScope treats it as
  // narrower than the (unscoped) appointment credit.
  let appointmentDiscountDollars = 0;
  if (!compound) {
    for (const line of state) {
      line.lineDiscountDollars = discountStepDollars(line.lineDiscount, line.remaining);
      line.remaining = cents(line.remaining - line.lineDiscountDollars);
    }
  } else {
    const fixedOps = [];
    state.forEach((line, lineIdx) => {
      if (isFixedDiscountType(line.lineDiscount?.discountType)) {
        fixedOps.push({ kind: 'line', lineIdx, discount: { ...line.lineDiscount, eligibleLines: [lineIdx] } });
      }
    });
    if (apptInFixedPass) fixedOps.push({ kind: 'appt', discount: appt });
    for (const { index: opIdx } of stackOrder(fixedOps.map((op) => op.discount))) {
      const op = fixedOps[opIdx];
      if (op.kind === 'line') {
        const line = state[op.lineIdx];
        line.lineDiscountDollars = discountStepDollars(line.lineDiscount, line.remaining);
        line.remaining = cents(line.remaining - line.lineDiscountDollars);
      } else {
        const eligible = state.filter((l) => l.eligible && l.remaining > 0);
        const pool = cents(eligible.reduce((sum, l) => sum + l.remaining, 0));
        appointmentDiscountDollars = discountStepDollars(appt, pool);
        allocateProRata(eligible, pool, (l) => l.remaining, appointmentDiscountDollars, (l, share) => {
          l.remaining = cents(Math.max(0, l.remaining - share));
          l.appointmentDiscountDollars = cents(l.appointmentDiscountDollars + share);
        });
      }
    }
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
  if (appt && !apptInFixedPass) {
    const eligibleLines = state.filter((line) => line.eligible);
    const base = cents(eligibleLines.reduce((sum, line) => sum + line.remaining, 0));
    appointmentDiscountDollars = discountStepDollars(appt, base);
    if (compound) {
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

// The document model: several lines, each with its OWN ordered term list,
// plus document-wide terms that reach every line (or, with `eligibleLines`
// on a term, a named subset — a scheduled appointment discount narrowed to
// one service). Mirrors stackDocumentDiscounts in
// server/services/discount-stack.js: (1) fixed LINE and DOCUMENT terms
// together, ONE canonically-ordered pass; (2) LINE percent/free_service
// terms on what's left; (3) DOCUMENT percent/free_service terms, each
// against its own eligible pool, in canonical order.
// lines: [{ gross, terms: [{ discountType, amount, maxDiscountDollars? }] }]
// documentTerms: [{ discountType, amount, maxDiscountDollars?, eligibleLines? }]
// Returns { lines: [{ termDollars: [...], net }], documentTerms: [{ dollars }] }.
export function stackDocumentDiscounts({ lines, documentTerms }) {
  const lineInput = Array.isArray(lines) ? lines : [];
  const docTerms = (Array.isArray(documentTerms) ? documentTerms : []).map(normalize);

  const state = lineInput.map((line) => {
    const gross = Math.max(0, cents(line?.gross));
    const terms = (Array.isArray(line?.terms) ? line.terms : []).map(normalize);
    return { gross, terms, termDollars: new Array(terms.length).fill(0), remaining: gross };
  });

  const termReachesLine = (term, lineIdx) => (
    !Array.isArray(term?.eligibleLines) || term.eligibleLines.includes(lineIdx)
  );

  // 1. Fixed credits — LINE terms and DOCUMENT terms together, ordered by
  // the canonical key before ANY of them apply (never "every line's own
  // fixed terms first, unconditionally, then document terms" — that split
  // lets a narrower line credit run before a WIDER document credit that
  // should have gone first per the SCOPE step).
  const docDollars = new Array(docTerms.length).fill(0);
  const fixedOps = [];
  state.forEach((line, lineIdx) => {
    line.terms.forEach((term, termIdx) => {
      if (isFixedDiscountType(term?.discountType)) {
        fixedOps.push({ kind: 'line', lineIdx, termIdx, discount: { ...term, eligibleLines: [lineIdx] } });
      }
    });
  });
  docTerms.forEach((term, termIdx) => {
    if (isFixedDiscountType(term?.discountType)) {
      fixedOps.push({ kind: 'document', termIdx, discount: term });
    }
  });
  for (const { index: opIdx } of stackOrder(fixedOps.map((op) => op.discount))) {
    const op = fixedOps[opIdx];
    if (op.kind === 'line') {
      const line = state[op.lineIdx];
      const dollars = discountStepDollars(line.terms[op.termIdx], line.remaining);
      line.termDollars[op.termIdx] = dollars;
      line.remaining = cents(line.remaining - dollars);
    } else {
      const term = docTerms[op.termIdx];
      const pool = state.filter((line, i) => line.remaining > 0 && termReachesLine(term, i));
      const poolTotal = cents(pool.reduce((sum, line) => sum + line.remaining, 0));
      const dollars = discountStepDollars(term, poolTotal);
      docDollars[op.termIdx] = dollars;
      if (!pool.length) continue;
      allocateProRata(pool, poolTotal, (line) => line.remaining, dollars, (line, share) => {
        line.remaining = cents(Math.max(0, line.remaining - share));
      });
    }
  }

  // 2. LINE percent/free_service terms, on what's left after step 1.
  for (const line of state) {
    const nonFixedIdx = line.terms
      .map((t, i) => (!isFixedDiscountType(t?.discountType) ? i : -1))
      .filter((i) => i >= 0);
    const stacked = stackDiscounts(line.remaining, nonFixedIdx.map((i) => line.terms[i]), { compound: true });
    nonFixedIdx.forEach((termIdx, i) => { line.termDollars[termIdx] = stacked.items[i].dollars; });
    line.remaining = stacked.net;
  }

  // 3. DOCUMENT percent/free_service terms, each against its own eligible
  // pool's current remainder, resolved in canonical order — an unscoped
  // term still reaches every line still carrying a balance, and a scoped
  // term only ever consumes the balance of the lines it actually reaches.
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

// First non-stackable stack_group clash among catalog rows, or null. Same
// rule as server/services/discount-stack.js's stackGroupConflict (a
// client-side warning ahead of Save, not the enforcement boundary, which is
// always the server's assertStackGroups).
export function stackGroupConflict(rows) {
  const seen = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.stack_group || row.is_stackable === true) continue;
    const group = String(row.stack_group);
    const held = seen.get(group) || [];
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

// Catalog rows a picker may still offer once `chosen` rows are on the
// document: a non-stackable group already in use hides its other members
// (the same row stays offered — one tier on two lines is fine).
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
    return held.every((row) => (
      String(row.id || row.name) === String(preset.id || preset.name)
      && row.spansAll !== true
      && !spansAll
      && String(row.scope ?? '') !== String(scope ?? '')
    ));
  });
}
