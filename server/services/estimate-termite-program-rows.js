'use strict';

// Which termite PROGRAM a persisted estimate payload was sold under, read
// from the stored row alone. A pure shape predicate with no DB or pricing
// dependency, so the send gate in routes/admin-estimates can consult it
// without pulling in the persistence module (which callers routinely mock).
//
// The annual protection plan (ruling A-1, plan §A2) can appear in three
// places, and a client-fallback payload that never went through the engine
// carries the mapped ones only:
//   - the raw engine line: `termite_bait` stamped plan='annual_protection';
//   - the mapped envelope: results.tmBait.plan;
//   - the one-time "Station Setup" item the legacy mapper emits for a plan
//     (`termite_bait_installation` with kind='setup').
//
// A revision replaces `result` with a newly mapped envelope but can retain
// the draft's older `engineResult`. Once a mapped tmBait exists it is the
// authoritative program result and raw/setup fallbacks must not resurrect a
// stale selection. Raw-only legacy payloads remain supported.
function authoritativeMappedTermiteEnvelope(estimateData) {
  const result = estimateData?.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : estimateData;
  const tmBait = result?.results?.tmBait;
  return tmBait && typeof tmBait === 'object' ? tmBait : null;
}

function selectedTermiteAnnualPlanRows(estimateData) {
  const isPlan = (v) => String(v || '').toLowerCase() === 'annual_protection';
  const result = estimateData?.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : estimateData;
  const mapped = authoritativeMappedTermiteEnvelope(estimateData);
  if (mapped) return isPlan(mapped.plan) ? [mapped] : [];
  const rawLines = [result?.lineItems, estimateData?.engineResult?.lineItems]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((li) => String(li?.service || '').toLowerCase() === 'termite_bait' && isPlan(li?.plan));
  const setupItems = [result?.oneTime?.items]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((item) => String(item?.service || '').toLowerCase() === 'termite_bait_installation'
      && String(item?.kind || '').toLowerCase() === 'setup');
  return [...rawLines, ...setupItems];
}

module.exports = { authoritativeMappedTermiteEnvelope, selectedTermiteAnnualPlanRows };
