'use strict';

// Shared by the Edit-appointment editor (client/src/pages/admin/SchedulePage.jsx)
// and the server's own legacy-visit-edit-preservation decision (slice 4 of
// #4405, admin-schedule.js's legacyEconomicsPreservationDecision) — the ONE
// place either side derives what an UNCHANGED stored row's own save would
// submit, so the server's notion of "this save touched no money" can never
// drift from what the client actually sends. Three rounds of GitHub review
// each found a real legacy-data shape the server's own independent
// re-derivation missed (a gross-vs-net fallback mismatch, a null total
// wrongly coerced, an add-on row predating the base_price column) — moving
// the derivation here, imported by BOTH sides instead of hand-mirrored on
// the server, removes that whole class of bug: the server literally runs
// the client's own logic against the stored row and diffs the result
// against what was actually posted, rather than guessing a shape.
//
// Both functions are pure — no DOM, no fetch, no server model access — so
// they load in either runtime unmodified. Money values are accepted as
// whatever the caller already has (number, numeric string, or null/
// undefined) and returned as numbers (or null when nothing can be
// derived); callers format/stringify for their own context (an <input>
// value on the client, a comparison operand on the server).

// The primary line's own submission when the primary ITSELF is untouched,
// mirroring the Edit-appointment form's price-field seed
// (SchedulePage.jsx, ~1700-1725): a structured primaryLinePrice is trusted
// as-is; a pre-column legacy row (primaryLinePrice null) derives it as the
// stored TOTAL minus every add-on's own GROSS — preferring `basePrice`,
// falling back to `estimatedPrice` ONLY when `basePrice` itself was never
// recorded, NEVER subtracting the add-ons' own NET when a gross exists
// (GitHub round 3 P0: subtracting net instead of gross reconstructs the
// wrong primary and can reject preservation on a genuinely unchanged
// notes-only save). Returns null when nothing can be derived (an
// unpriced/unknown total) — the caller decides what an unresolvable
// derivation means for its own purposes.
function deriveLegacyPrimarySubmission({ primaryLinePrice, estimatedPrice, addons }) {
  const addonsKnown = Array.isArray(addons);
  // primaryLinePrice is the primary line's own GROSS (before any
  // appointment-level discount — see the PUT route's own
  // `updates.primary_line_price = primaryGross`); estimatedPrice is the
  // visit's stored NET total. A KNOWN gross is always the seed, zero add-on
  // lines included. Round 5 on #4657 (:6083) briefly seeded a zero-add-on
  // visit from the NET instead, because an untouched save then echoed the
  // gross and wiped the stored appointment discount — but that echo is the
  // SERVER's job (computeSingleServiceEstimatedPricePlan's own
  // isUnchangedGrossEcho backstop, added in that same round), and the net
  // seed itself was wrong money: the single-service save path applies a
  // CHANGED appointment discount to whatever this field posts as the
  // gross, so replacing 10%-off on a $100 primary stored at $90 with a 20%
  // preset compounded onto the net and persisted $72 instead of $80
  // (GitHub Codex round 10 on #4657, P1, :49). A legacy row with NO stored
  // gross still falls through to the total below, unchanged.
  if (addonsKnown && primaryLinePrice != null && primaryLinePrice !== '') {
    const structured = Number(primaryLinePrice);
    return Number.isFinite(structured) ? structured : null;
  }
  const total = (estimatedPrice != null && estimatedPrice !== '') ? Number(estimatedPrice) : null;
  if (total == null || !Number.isFinite(total)) return null;
  if (addonsKnown && addons.length > 0) {
    const addonGross = addons.reduce((sum, a) => {
      const gross = a?.basePrice != null ? a.basePrice : (a?.estimatedPrice != null ? a.estimatedPrice : 0);
      const n = Number(gross);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
    return Math.max(0, Math.round((total - addonGross) * 100) / 100);
  }
  return total;
}

// ONE add-on line's submission when that line ITSELF is untouched,
// mirroring SchedulePage.jsx's own per-line derivation (~2560-2589): a
// real gross (base_price) AND a discount round-trips the FULL stamp
// (base + discount id/type/amount/name) so the recipient can reconstruct
// the exact same net; anything else — no discount at all, OR a discount
// whose base_price was never recorded (a legacy row predating that
// column: migration 20260504000004 added the discount columns before
// 20260511000002 added base_price — GitHub round 3 P0) — sends only the
// flat NET price with no discount fields, because the sender genuinely
// has no gross to round-trip and must not guess one. Both shapes are
// real, stored rows; a recipient comparing against ONLY the stamped shape
// would misclassify the second as an edit and discard its discount audit.
function deriveLegacyAddonSubmission({
  basePrice, netPrice, discountType, discountAmount, discountId, discountName,
}) {
  if (discountType && basePrice != null && basePrice !== '') {
    return {
      basePrice: Number(basePrice),
      discountType,
      discountAmount: (discountAmount != null && discountAmount !== '') ? Number(discountAmount) : null,
      discountId: discountId || null,
      discountName: discountName || null,
    };
  }
  return {
    price: (netPrice != null && netPrice !== '') ? Number(netPrice) : null,
  };
}

module.exports = { deriveLegacyPrimarySubmission, deriveLegacyAddonSubmission };
