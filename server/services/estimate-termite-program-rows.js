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

module.exports = { authoritativeMappedTermiteEnvelope, pricedTermiteProgram, selectedTermiteAnnualPlanRows };
