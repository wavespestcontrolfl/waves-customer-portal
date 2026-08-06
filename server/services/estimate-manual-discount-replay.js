// Stored-manual-discount reconstruction for engine replays.
//
// The admin estimator posts its manual discount two ways: the ASSEMBLED
// engine object rides only the transient calculateEstimate call, while the
// persisted blob keeps the applied discount at summary level
// (estimate_data.summary.manualDiscount, mirrored on result.manualDiscount /
// result.totals.manualDiscount by the engine). Replays that rebuild pricing
// from engineRequest/engineInputs/inputs therefore reprice WITHOUT the
// discount unless something re-injects it — which is how an accepted quote
// can bill the undiscounted figure while its stored totals still show the
// discount (2026-08-05 T&S add-on accept, account b5f6e627: billed 32.87/mo
// against stored 354.96/yr). operatorPriceAdjustment (agent flows) already
// has this re-injection; this helper is the same mechanism for the stored
// summary object, shared by the public replay (estimate-public
// extractEngineInputs) and the save-path replay (admin-estimate-persistence).
//
// Only identity + math inputs are reconstructed. amount/recurringAmount and
// the other computed fields are engine outputs and never re-injected (the
// engine recomputes them per cadence); internalReason is audit-only text and
// is deliberately never carried into a replay (codex P1 on #2947 — replayed
// summaries are spread into public tokenized payloads).
//
// FIXED-discount scope (codex #3241 r1 P1): the engine allocates a FIXED
// dollar value proportionally across the recurring/one-time bases on every
// compute, with no input pin for the split — so re-injecting a FIXED
// discount whose original compute gave the one-time bucket a nonzero slice
// would let each per-cadence replay REALLOCATE the credit against that
// cadence's recurring base while acceptance keeps billing the persisted
// one-time total, and the two slices could sum to more or less than the
// promised value. A stored oneTimeAmount of exactly 0 proves no discountable
// one-time bucket existed, so the allocation is replay-stable and injection
// is faithful; anything else keeps the pre-existing behavior (no injection)
// rather than introduce a new mis-sum. PERCENT is per-bucket by definition
// and always replay-stable.

function candidateList(estData = {}) {
  const root = estData?.result && typeof estData.result === 'object'
    ? estData.result
    : (estData?.engineResult && typeof estData.engineResult === 'object' ? estData.engineResult : estData);
  return [
    estData?.summary?.manualDiscount,
    root?.manualDiscount,
    root?.totals?.manualDiscount,
    root?.summary?.manualDiscount,
  ];
}

function storedManualDiscountForReplay(estData = {}) {
  const stored = candidateList(estData).find((item) => item
    && typeof item === 'object'
    && (item.type === 'PERCENT' || item.type === 'FIXED')
    && Number(item.value) > 0);
  if (!stored) return null;
  // Strictly a STORED numeric zero (codex #3241 r2 P1): Number() coerces
  // null / '' / false / whitespace to 0, which would let unknown legacy
  // allocations masquerade as proven-zero and replay anyway.
  if (stored.type === 'FIXED'
    && !(typeof stored.oneTimeAmount === 'number' && stored.oneTimeAmount === 0)) {
    return null;
  }
  const out = {
    source: stored.source || 'stored_summary_replay',
    type: stored.type === 'PERCENT' ? 'PERCENT' : 'FIXED',
    value: Number(stored.value),
    label: stored.label || stored.catalogName || 'Discount',
    eligibility: stored.eligibility ?? null,
    // Preserved as stored so a replay reproduces the same eligibility
    // warnings the original compute stamped — never promoted to true.
    eligibilityConfirmed: stored.eligibilityConfirmed === true,
    floorBreachAcknowledged: stored.floorBreachAcknowledged === true,
  };
  // Ladder slicing (manualDiscountForRecurringBase) anchors a FIXED
  // discount's recurring slice on the saved one-time allocation — carry the
  // proven-zero slice through so downstream consumers of the injected
  // object read the same anchor the stored object carries.
  if (stored.type === 'FIXED') out.oneTimeAmount = 0;
  if (stored.presetId) out.presetId = stored.presetId;
  if (stored.presetKey) out.presetKey = stored.presetKey;
  if (stored.catalogName) out.catalogName = stored.catalogName;
  if (stored.catalogCategory) out.catalogCategory = stored.catalogCategory;
  if (stored.stack) out.stack = stored.stack;
  return out;
}

module.exports = { storedManualDiscountForReplay };
