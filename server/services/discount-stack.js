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
 * CANONICAL ORDER (the complete key — replaces the slot-only and cap-
 * only notes from earlier rounds; this is the ONE place to read the rule,
 * not the two together). Every discount, at any slot, sorts by ONE key,
 * most significant first:
 *
 *   1. SLOT — fixed dollar credits, any slot, first; then every LINE-slot
 *      percentage/free_service; then every DOCUMENT-slot percentage/
 *      free_service (Codex pre-push audit P1, round 3: a line-scoped term
 *      resolves on its own line before a document-wide term ever sees the
 *      remainder — the #4405 product rule, "a stored visit stamp rides
 *      the invoice stack frozen and ahead of the rest"; $100 with a line
 *      10% and a document 50%-capped-$10 is $80 either way, never $81 —
 *      slot outranks rate). "Fixed dollar credits, any slot, first" means
 *      exactly that: a line's own fixed credit and a document/appointment
 *      fixed credit are ONE ordered pass, not "every line credit,
 *      unconditionally, then the document credit" — that split (fixed
 *      through round 6) still let a narrower line credit run before a
 *      WIDER document credit that should have gone first per step 5 below
 *      (Codex pre-push audit P1, round 7: $50/$100 lines, a line-0 $80
 *      credit plus an $80 document/appointment credit netted $20 running
 *      line-first, never the $46.67 the wider credit gives running
 *      first — the total already enforced when both were document
 *      terms). stackVisitDiscounts and stackDocumentDiscounts implement
 *      the PERCENT/free_service half of this split natively (their line/
 *      appointment and line/document-term structure IS the two slots);
 *      for FIXED credits specifically, both merge every line's own fixed
 *      term and every document/appointment fixed term into one list —
 *      each line term tagged with a synthetic single-line scope purely so
 *      step 5's scope comparator can rank it against a document term —
 *      and run stackOrder over the WHOLE list before any of them apply.
 *      stackDiscounts has no lines of its own, so a discount MAY carry
 *      `slot: 'document'` — everything else defaults to 'line'.
 *   2. KIND — within a slot, fixed before percentage before free_service.
 *   3. VALUE — among terms of the same kind and slot, the larger `amount`
 *      first: for percentages this is RATE (Codex pre-push audit P2,
 *      round 3: rounding drift made $99 at 5%-then-10% total a cent
 *      different from 10%-then-5%, even though the two orders are
 *      mathematically identical — one canonical sequence removes the
 *      drift); for fixed credits it's the dollar amount itself (Codex
 *      pre-push audit round 6: two same-scope fixed credits with
 *      different face values had NO tiebreak at all before this, so the
 *      per-line pro-rata SPLIT between them could differ by a cent
 *      depending on which one happened to be listed first, even though
 *      the aggregate they produce together is provably the same either
 *      way — verified against 20,000 randomized trials with zero
 *      exceptions). One comparator (`resolveDiscountAmount` already reads
 *      the same field regardless of kind), not two.
 *   4. CAP — among percentages tied on rate, the MORE restrictive
 *      maxDiscountDollars first; uncapped reads as an infinite cap, so it
 *      always sorts last among rate ties (Codex pre-push audit P2, round
 *      4: $100 at 50% capped $10 plus 50% uncapped is $45 net either way,
 *      never the $40 that "uncapped first" gives).
 *   5. SCOPE — among terms tied on everything above (this reaches FIXED
 *      terms too, which have no cap concept — but DO reach this step
 *      whenever two of them tie on value as well), the term reaching MORE
 *      eligible lines resolves first: an unscoped term
 *      (reaches every line) sorts before any scoped subset, and between
 *      two scoped subsets the one with more line ids sorts first; an
 *      exact tie (identical eligibleLines, same length and ids) falls
 *      through to the next check. Direction verified by brute force, not
 *      assumed (Codex pre-push audit P1+P2, round 5): for a FIXED term,
 *      resolving the WIDER scope first is never worse and often strictly
 *      better — 0 counterexamples across 20,000 randomized line-count /
 *      amount / scope combinations ($80 scoped to one $50 line plus an
 *      unscoped $80 across a $50+$100 pair nets $46.67 with the unscoped
 *      credit running first, never the $20 that scoped-first gives — the
 *      wide credit takes close to the same amount wherever it runs, so
 *      long as its combined pool stays above its face value, while the
 *      narrow credit's OWN achievable amount shrinks once the wide one
 *      has already drawn on its one shared line; running the insensitive
 *      one first and the sensitive one last against the now-smaller
 *      remainder yields the smaller total). The mirror guess — narrower
 *      scope first, echoing "tighter cap first" — is NOT the same
 *      principle wearing a different hat and was rejected after the same
 *      brute force showed it is never the smaller-discount order: for
 *      caps the TIGHT constraint is insensitive to position and goes
 *      first, but for scope the WIDE constraint is the insensitive one,
 *      so it goes first instead — the common thread is "run whichever
 *      term's own take barely depends on the current state first, save
 *      the state-sensitive one for the shrunken remainder," which points
 *      opposite ways for these two attributes, not the same way. For a
 *      PERCENTAGE term sharing a rate and cap, no universal direction
 *      exists at all — the same sweep found each order strictly smaller
 *      about as often as the other (a near-even split, unlike the fixed
 *      case's unanimous result) — so this module applies the SAME wider-
 *      first convention there too, for one consistent rule across every
 *      kind rather than a kind-dependent tie-break; it is not claimed to
 *      always minimize a scoped-percentage tie, only to make it
 *      deterministic, which is the property actually required.
 *   6. IDENTITY — among terms tied on everything above, a stable id
 *      (a term's `id`, or `discount_key` if that's what it carries)
 *      beats input position: two DISTINCT catalog discounts that happen
 *      to tie on slot/kind/value/cap/scope used to fall back to array
 *      position, so which discount got credited with which dollar figure
 *      could swap whenever a picker listed them in a different order —
 *      invisible to the total, but not to DiscountEngine's own
 *      bookkeeping, which maps figures back to catalog rows and rolls
 *      per-discount usage totals through recordInvoiceDiscounts (Codex
 *      pre-push audit P2, round 7). A term with no identity at all still
 *      falls straight through to index, same as every term did before
 *      this step existed.
 *   7. INDEX — the caller's own input position, used ONLY when two terms
 *      are byte-identical in slot, kind, value, cap, scope, AND identity
 *      (order provably cannot matter between them).
 *
 * This key governs every place this module orders discounts: stackOrder
 * (used directly by stackDiscounts, and internally by both
 * stackVisitDiscounts and stackDocumentDiscounts) AND
 * stackDocumentDiscounts' fixed and non-fixed document-term passes alike
 * (Codex pre-push audit P1, round 5: the fixed-document-term pass used to
 * iterate in plain input order with NO canonicalization at all — a
 * service-scoped $80 credit and an unscoped $80 credit on $50/$100 lines
 * left $20 net in one order and $46.67 in the other, because the
 * unscoped credit spread across both lines FIRST whenever it happened to
 * be listed first). Per-item `dollars` always maps back to the caller's
 * OWN input position — only the SEQUENCE they compound in is
 * canonicalized, never the reported identity of which discount produced
 * which figure.
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

// Which slot a discount belongs to for the precedence rule above. Only
// stackDiscounts' flat list needs this read explicitly — stackVisitDiscounts
// and stackDocumentDiscounts already know a term's slot from WHERE it came
// from (a line vs the appointment/document level) and never set this field.
// Defaulting an unmarked discount to 'line' is what keeps every existing
// stackDiscounts caller (none of which have ever heard of `slot`) getting
// the exact same result as before: with nothing marked 'document', every
// item is in the one slot and rate order alone decides the sequence.
function resolveDiscountSlot(discount) {
  return discount?.slot === 'document' ? 'document' : 'line';
}

// A discount's cap for the tie-break above, as a number the "smaller cap
// first" comparator can subtract directly: maxDiscountDollars when it's a
// finite number, or +Infinity for no cap at all (or a non-numeric value —
// same fail-open reading capDollars already uses) so "uncapped" naturally
// sorts after every real cap without a separate null-check in the sort.
function resolveDiscountCap(discount) {
  const cap = Number(discount?.maxDiscountDollars);
  return discount?.maxDiscountDollars == null || discount?.maxDiscountDollars === '' || !Number.isFinite(cap)
    ? Infinity
    : cap;
}

// More restrictive (smaller) cap sorts FIRST; two caps that are exactly
// equal — including two uncapped terms, both +Infinity — are a genuine
// tie and return 0, not NaN. Plain subtraction breaks here: Infinity -
// Infinity is NaN, and a comparator that ever returns NaN stops being a
// valid total order (Array.prototype.sort's behavior on a NaN result is
// unspecified — it silently skipped the scope tiebreak below it, the bug
// this comment is here to prevent regressing). Comparing for exact
// equality first, before ever subtracting, is what keeps two uncapped
// percentages falling through to the scope check instead.
function compareDiscountCap(a, b) {
  const capA = resolveDiscountCap(a);
  const capB = resolveDiscountCap(b);
  if (capA === capB) return 0;
  if (capA === Infinity) return 1;
  if (capB === Infinity) return -1;
  return capA - capB;
}

// A discount's SCOPE for the final tie-break: how many lines it reaches,
// and which ones. `eligibleLines` absent/null means "every line" — read
// as +Infinity width so it sorts before any finite (narrower) scope; a
// present array's width is its own length, and its `ids` are the line
// indexes sorted ascending for a stable, order-independent identity (a
// caller could hand the same set in any order without changing what this
// module treats as "the same scope"). `ids` is null for an unscoped
// discount — there's nothing to compare lexicographically, and the width
// check alone already separates it from every scoped term.
function resolveDiscountScope(discount) {
  const eligibleLines = discount?.eligibleLines;
  if (!Array.isArray(eligibleLines)) return { width: Infinity, ids: null };
  return { width: eligibleLines.length, ids: [...eligibleLines].map(Number).sort((a, b) => a - b) };
}

// Wider scope (more eligible lines, unscoped widest of all) sorts FIRST;
// see the module header's SCOPE step for the direction and why it's
// opposite the cap rule's "tighter first." A tie on width falls through to
// a lexicographic compare of the sorted line ids — deterministic, though
// no minimizing direction was found (or needed) between two same-size
// scopes — and a tie on BOTH (including two unscoped terms, where `ids`
// is null for both) returns 0, leaving the decision to the index tiebreak.
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

// A term's stable identity for the LAST tiebreak before input index — the
// catalog id (or discount_key, whichever a caller's term shape carries),
// not the array position. Two DISTINCT discounts that tie on every other
// attribute (slot, kind, value, cap, scope) used to fall straight to
// index, so which discount got credited with which per-term dollar figure
// swapped whenever a picker happened to list them in a different order —
// invisible to totals, but not to DiscountEngine's own bookkeeping, which
// maps figures back to catalog rows and rolls per-discount usage totals
// through recordInvoiceDiscounts (Codex pre-push audit P2, round 7).
// `undefined` (neither field present) means there's no identity at all —
// resolved deterministically below rather than left as a bare tie.
function resolveDiscountId(discount) {
  return discount?.id ?? discount?.discount_key ?? undefined;
}

// IDENTIFIED terms sort before ANONYMOUS ones (the choice is arbitrary —
// a catalog-backed discount taking precedence over a legacy/constructed
// one with neither id nor discount_key — but it has to be SOME fixed
// choice, stated once here, not "whichever one this pairwise comparison
// happens to see first"). Two identified terms compare by identity
// string; two anonymous terms tie here and fall through to index.
//
// Returning 0 for "either side lacks an identity" (the pre-round-8 rule)
// is not a valid comparator: it makes anonymous-vs-identified pairs
// intransitive. Three terms a/b/anonymous, tied on rate — a < b by
// identity, but a-vs-anonymous and b-vs-anonymous BOTH returned 0 — gives
// Array.prototype.sort no fixed point to anchor anonymous against, so
// its position (and therefore whether it lands between a and b or
// outside them) depended on which pairwise comparisons the sort
// algorithm happened to run, which depended on the INPUT order (Codex
// pre-push audit P2, round 8): the exact repro let identified b end up
// crediting $10 or $9, and identified a $8.10 or $10, purely from
// shuffling the SAME three terms. Anonymous terms are now a distinct,
// deterministically-placed group instead of an ambiguous non-comparison,
// so every identified pair keeps the SAME relative order regardless of
// how many anonymous terms sit between them or where.
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
// integer-cents basis-point math (Codex P1), so roundHalfUpCents' single
// division depends only on the true mathematical ratio, never the float
// noise `baseDollars * (ratePercent / 100)` produces (dollars * 0.05-ish
// fraction, then round) — 5% of $20.70 is the correct half-up $1.04, never
// the $1.03 that ordinary float multiplication-then-round gives.
// `ratePercent` is normalized to hundredths of a percent (2 more decimal
// digits than the percent itself) — plenty of precision for any catalog or
// operator-entered rate, and documented here as the one place that
// precision is decided. Exported (Codex pre-push audit P1, round 6) so a
// caller that hasn't been migrated onto the full stackDiscounts/
// stackDocumentDiscounts/stackVisitDiscounts API yet — today,
// invoice.js's manual-discount line, which still computes its own
// percentages outside this module pending slice 5 — can still round the
// ONE way this module ever rounds a percentage, rather than maintaining
// an independent (and, until this fix, independently-buggy) copy of the
// same formula. discountStepDollars below is this function's own first
// caller, not a parallel implementation.
function percentageDiscountDollars(baseDollars, ratePercent, maxDiscountDollars) {
  const baseCents = dollarsToCents(baseDollars);
  const pctBasisPoints = Math.round((Number(ratePercent) || 0) * 100);
  const dollarsCents = roundHalfUpCents(baseCents * pctBasisPoints, 10000);
  return capDollars(centsToDollars(dollarsCents), maxDiscountDollars);
}

// Dollars ONE discount takes off `remaining`, clamped to [0, remaining].
function discountStepDollars(discount, remaining) {
  if (!discount || !(remaining > 0)) return 0;
  const amount = resolveDiscountAmount(discount);
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

// Implements the module header's CANONICAL ORDER key: SLOT, then KIND,
// then (percentages only) RATE and CAP, then SCOPE for everything, then
// INDEX as the last resort. `rank` encodes SLOT+KIND as five buckets: 0
// fixed (any slot), 1 line-percent, 2 line-free_service, 3 document-
// percent, 4 document-free_service. A caller who never sets `slot` puts
// every percentage/free_service in the line bucket — slot never
// distinguishes anything, and the ranking collapses to a plain fixed-
// then-percent-then-free_service order, unchanged from before slot
// existed. See the header for why each step is in this order and how its
// direction was verified.
function stackOrder(discounts) {
  const rank = (d) => {
    if (isFixedDiscountType(d?.discountType)) return 0;
    const slotBase = resolveDiscountSlot(d) === 'document' ? 3 : 1;
    return isPercentDiscountType(d?.discountType) ? slotBase : slotBase + 1;
  };
  const isPercentRank = (r) => r === 1 || r === 3;
  return discounts
    .map((discount, index) => ({ discount, index }))
    .sort((a, b) => {
      const rankA = rank(a.discount);
      const rankDiff = rankA - rank(b.discount);
      if (rankDiff !== 0) return rankDiff;
      // VALUE: largest first — resolveDiscountAmount reads the same
      // `amount` field for every kind, so this is "rate descending" for a
      // percentage and "amount descending" for a fixed credit alike (one
      // comparator, not two). A free_service's amount is always 0, so
      // this is a no-op tie for it, falling straight through to scope.
      // Two same-scope FIXED terms with different face values never had
      // ANY tiebreak before this (round 5): the AGGREGATE they produce is
      // provably the same regardless of which one runs first (each still
      // takes its own full face value as long as neither gets clamped),
      // verified by 20,000 randomized trials with zero exceptions — but
      // the PER-LINE pro-rata split can differ by a cent depending on
      // processing order when they share overlapping lines, so this still
      // needs a deterministic direction even though no total is at stake;
      // largest-first was picked for symmetry with the rate rule, not
      // because either direction is "the lesser of the two" here.
      const valueDiff = resolveDiscountAmount(b.discount) - resolveDiscountAmount(a.discount);
      if (valueDiff !== 0) return valueDiff;
      if (isPercentRank(rankA)) {
        const capDiff = compareDiscountCap(a.discount, b.discount);
        if (capDiff !== 0) return capDiff;
      }
      // SCOPE applies at every rank, not just percentages — a fixed term
      // has no cap to tie-break on, but it still needs a scope check
      // (round-5 fix: two same-rank, same-value fixed terms used to fall
      // straight through to index, the finding at :578).
      const scopeDiff = compareDiscountScope(a.discount, b.discount);
      if (scopeDiff !== 0) return scopeDiff;
      // IDENTITY: a stable catalog id/discount_key beats input position
      // for two DISTINCT discounts that tie on everything above (round 7)
      // — a term with no identity at all still falls through to index.
      const identityDiff = compareDiscountIdentity(a.discount, b.discount);
      if (identityDiff !== 0) return identityDiff;
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
  // `budget` bounds what the AGGREGATE (and so each item, in processing
  // order) is allowed to count toward the total, so totalDollars never
  // exceeds `full` and the invariant totalDollars === full - net holds
  // here too (Codex pre-push audit P2). compound:true doesn't need this —
  // its own `remaining` already shrinks step to step, so
  // discountStepDollars' own clamp keeps every step within what's left.
  //
  // Processing order itself differs by mode, deliberately: compound:true
  // uses the CANONICAL ORDER (stackOrder) because that's the whole point
  // of the gate-on rule — the same set of discounts must compound the
  // same way regardless of how a caller happened to list them. compound
  // :false is a DIFFERENT contract: it exists to reproduce whatever each
  // caller's own pre-lane math already did, callers that (before this
  // module existed) each had their own ordering convention with no
  // canonical-order concept at all — DiscountEngine's calculateDiscounts
  // is the first live example, priority-ordered from the catalog, not
  // sorted by kind/rate/cap/scope. Reordering that legacy path here would
  // make the delegation something OTHER than a byte-identical parity
  // shim, so compound:false walks the list in EXACTLY the order given —
  // whichever order that is — and lets the clamp (not a canonicalizer)
  // decide how a face-value overflow gets distributed.
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

  // 1 & 2. Fixed credits. Legacy (compound:false): every line's own
  // discount, whatever its type, resolves here unconditionally, in given
  // order — no canonicalization for the gate-off path (see stackDiscounts'
  // own compound:false comment for why: it exists to reproduce a caller's
  // pre-lane math, not to compound). Compounding (compound:true): ALL
  // fixed credits, line AND appointment alike, are ordered by the
  // module's ONE canonical key before ANY of them apply — not "every
  // line credit first, then the appointment credit," which bypassed the
  // header's own "fixed dollar credits, any slot, first" rule and let an
  // unconditional line-first pass beat a wider appointment credit that
  // should have run first (Codex pre-push audit P1, round 7): $50/$100
  // lines, an $80 line-0 credit and an $80 appointment credit used to net
  // $20 running line-first, never the $46.67 the wider appointment
  // credit gives when it rightly runs first — the same total
  // stackDocumentDiscounts already produced when both were document
  // terms. A line's own fixed credit is tagged with a synthetic single-
  // line `eligibleLines` purely so compareDiscountScope sees it as
  // narrower than the appointment credit (which carries no eligibleLines
  // of its own, reading as unscoped/widest by default); nothing else
  // reads that synthetic tag — the actual dollar computation below still
  // reads the line's real, untagged `lineDiscount`.
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

  // 1 & 2. Fixed credits — LINE terms and DOCUMENT terms alike, ordered
  // by the module's ONE canonical key before ANY of them apply (Codex
  // pre-push audit P1, round 7). The old split — every line's own fixed
  // terms first, unconditionally, THEN document fixed terms in their own
  // canonical order (round 5) — still bypassed the header's own "fixed
  // dollar credits, any slot, first" rule whenever a document credit was
  // WIDER than a line's own credit: $50/$100 lines, a line-0 $80 credit
  // plus an $80 document credit used to net $20 running line-first, never
  // the $46.67 the wider document credit gives when it rightly runs first
  // — the total already enforced when BOTH were document terms (round 5).
  // A line's own fixed term is tagged with a synthetic single-line
  // `eligibleLines` purely so compareDiscountScope treats it as narrower
  // than a same-or-wider document term; the actual computation below
  // still reads each term's real, untagged shape, and two fixed terms
  // sharing one line still compare on VALUE (checked before SCOPE) same
  // as always, unaffected by the tag they now share.
  const docDollars = new Array(docTerms.length).fill(0);
  // A document term normally reaches EVERY line. `eligibleLines` (an array
  // of line indexes) restricts one to a subset — the invoice replay of a
  // scheduled appointment discount narrowed to one service through
  // discount_service_key_filter. Spreading such a credit over every line
  // moves the base the OTHER lines' percentages compound on, so a $30
  // add-on-only credit on two $100 lines turned a 10% primary-line discount
  // from $10 into $8.50 (Codex #4405 r3 P1). Terms are resolved one at a
  // time against their own pool, in canonical order — an unscoped term
  // still reaches every line still carrying a balance, and a scoped term
  // only ever consumes the balance of the lines it actually reaches.
  const termReachesLine = (term, lineIdx) => (
    !Array.isArray(term?.eligibleLines) || term.eligibleLines.includes(lineIdx)
  );
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
  percentageDiscountDollars,
  stackDiscounts,
  stackVisitDiscounts,
  stackDocumentDiscounts,
  stackGroupConflict,
  assertStackGroups,
};
