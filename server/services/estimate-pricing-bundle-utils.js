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

module.exports = {
  moneyCents,
  moneyMatches,
  pricingBundleMatchesEstimateTotals,
};
