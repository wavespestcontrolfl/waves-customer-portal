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
