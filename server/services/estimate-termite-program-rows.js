'use strict';

// Mapped results supersede retained raw drafts. Read the sold program without
// pricing/DB dependencies so delivery, acceptance and replay share precedence.
function authoritativeMappedTermiteEnvelope(estimateData) {
  const result = estimateData?.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : estimateData;
  const tmBait = result?.results?.tmBait;
  return tmBait && typeof tmBait === 'object' ? tmBait : null;
}

// Published website quotes may persist only engineResult.lineItems. The
// mapped result wins when both shapes are present, as it does for replay.
function pricedTermiteProgram(estimateData) {
  const mapped = authoritativeMappedTermiteEnvelope(estimateData);
  if (mapped) return String(mapped.plan || '').toLowerCase();
  const result = estimateData?.result && typeof estimateData.result === 'object'
    ? estimateData.result : estimateData;
  const raw = [result?.lineItems, estimateData?.engineResult?.lineItems]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .find((li) => String(li?.service || '').toLowerCase() === 'termite_bait');
  return String(raw?.plan || '').toLowerCase();
}

function selectedTermiteAnnualPlanRows(estimateData) {
  const isPlan = (v) => String(v || '').toLowerCase() === 'annual_protection';
  const result = estimateData?.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : estimateData;
  // The one-time station-setup row lives at result.oneTime.items regardless
  // of which shape supplied the recurring annual line below — computed once
  // and reused by both branches (codex P1, slice 3a restructure: the
  // mapped-envelope branch used to return early WITHOUT it, so a real
  // V1-mapper-shaped estimate — the current production shape — silently
  // dropped its disclosed setup fee from every downstream reader of this
  // helper, including the billing snapshot).
  const setupItems = [result?.oneTime?.items]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((item) => String(item?.service || '').toLowerCase() === 'termite_bait_installation'
      && String(item?.kind || '').toLowerCase() === 'setup');
  const mapped = authoritativeMappedTermiteEnvelope(estimateData);
  if (mapped) return isPlan(mapped.plan) ? [mapped, ...setupItems] : [];
  const rawLines = [result?.lineItems, estimateData?.engineResult?.lineItems]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((li) => String(li?.service || '').toLowerCase() === 'termite_bait' && isPlan(li?.plan));
  return [...rawLines, ...setupItems];
}

module.exports = { authoritativeMappedTermiteEnvelope, pricedTermiteProgram, selectedTermiteAnnualPlanRows };
