'use strict';

// Which termite PROGRAM a persisted estimate payload was sold under, read
// from the stored row alone. A pure shape predicate with no DB or pricing
// dependency, so the send gate in routes/admin-estimates can consult it
// without pulling in the persistence module (which callers routinely mock).
//
// The annual protection plan (ruling A-1, plan §A2) can appear in three
// places, and a client-fallback payload that never went through the engine
// carries the mapped ones only — so all three are swept, same shape as the
// bond/rental selectors in admin-estimate-persistence:
//   - the raw engine line: `termite_bait` stamped plan='annual_protection';
//   - the mapped envelope: results.tmBait.plan;
//   - the one-time "Station Setup" item the legacy mapper emits for a plan
//     (`termite_bait_installation` with kind='setup').
function selectedTermiteAnnualPlanRows(estimateData) {
  const isPlan = (v) => String(v || '').toLowerCase() === 'annual_protection';
  const rawLines = [estimateData?.engineResult?.lineItems, estimateData?.result?.lineItems]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((li) => String(li?.service || '').toLowerCase() === 'termite_bait' && isPlan(li?.plan));
  const mapped = [estimateData?.result?.results?.tmBait, estimateData?.results?.tmBait]
    .filter((tm) => tm && typeof tm === 'object' && isPlan(tm.plan));
  const setupItems = [estimateData?.result?.oneTime?.items, estimateData?.oneTime?.items]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((item) => String(item?.service || '').toLowerCase() === 'termite_bait_installation'
      && String(item?.kind || '').toLowerCase() === 'setup');
  return [...rawLines, ...mapped, ...setupItems];
}

module.exports = { selectedTermiteAnnualPlanRows };
