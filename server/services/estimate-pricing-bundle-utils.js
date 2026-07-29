function moneyCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function moneyMatches(left, right) {
  const a = moneyCents(left);
  const b = moneyCents(right);
  return a != null && b != null && Math.abs(a - b) <= 1;
}

function pricingBundleMatchesEstimateTotals(bundle = {}, estimate = {}) {
  const monthly = Number(estimate.monthly_total ?? estimate.monthlyTotal ?? 0);
  const annual = Number(estimate.annual_total ?? estimate.annualTotal ?? 0);
  if (!(monthly > 0) && !(annual > 0)) return true;

  const frequencies = Array.isArray(bundle.frequencies) ? bundle.frequencies : [];
  return frequencies.some((freq) => {
    const freqMonthly = Number(freq?.monthly);
    const explicitAnnual = Number(freq?.annual);
    const freqAnnual = explicitAnnual > 0
      ? explicitAnnual
      : (freqMonthly > 0 ? freqMonthly * 12 : null);
    const monthlyOk = monthly > 0 ? moneyMatches(freqMonthly, monthly) : true;
    const annualOk = annual > 0 ? moneyMatches(freqAnnual, annual) : true;
    return monthlyOk && annualOk;
  });
}

// Curve provenance for an UNSTAMPED pest replay (codex #2966 r7-r9 P1s,
// extended to the public read path 2026-07-28): stored engineInputs and
// persisted Admin-V2 engineRequests predate version stamping, and agent
// drafts persist raw engineResult lineItems. The provenance signal is the
// STORED RESULT — an unstamped pest input with a priced stored pest line is
// a replay of that line's curve (unstamped line = v1). No stored pest line
// = pest was just added: genuinely new, caller keeps the live default.
function resolveStoredPestPricingVersion(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return null;
  const root = estimateData.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : estimateData;
  const storedPestLine = (Array.isArray(root?.recurring?.services) ? root.recurring.services : [])
    .find((svc) => svc?.service === 'pest_control')
    || root?.results?.pest
    || (Array.isArray(estimateData?.engineResult?.lineItems) ? estimateData.engineResult.lineItems : [])
      .find((li) => li?.service === 'pest_control')
    || null;
  if (!storedPestLine) return null;
  return storedPestLine.pricingVersion === 'v2' ? 'v2' : 'v1';
}

module.exports = {
  moneyCents,
  moneyMatches,
  pricingBundleMatchesEstimateTotals,
  resolveStoredPestPricingVersion,
};
