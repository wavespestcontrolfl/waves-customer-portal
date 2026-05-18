function validateEstimateDeliveryOptions({
  showOneTimeOption,
  billByInvoice,
  onetimeTotal,
  monthlyTotal,
  annualTotal,
  estimateData,
}) {
  const oneTimeAmount = Number(onetimeTotal || 0);
  const recurringAmount = Math.max(Number(monthlyTotal || 0), Number(annualTotal || 0));
  if (showOneTimeOption && oneTimeAmount <= 0) {
    return 'Offer one-time option requires a one-time total on the estimate.';
  }
  if (showOneTimeOption) {
    const nonPestRecurring = nonPestRecurringServicesForOneTimeOption(estimateData);
    if (nonPestRecurring.length > 0) {
      const names = nonPestRecurring.slice(0, 3).join(', ');
      const suffix = nonPestRecurring.length > 3 ? ', and other recurring services' : '';
      return `Offer one-time option is only supported for pest-only recurring estimates. Remove ${names}${suffix} or turn off the one-time choice.`;
    }
  }
  if (billByInvoice && oneTimeAmount <= 0 && recurringAmount <= 0) {
    return 'Bill by invoice requires a billable recurring or one-time total.';
  }
  return null;
}

function parseEstimateData(estimateData) {
  if (!estimateData) return null;
  if (typeof estimateData === 'string') {
    try {
      return JSON.parse(estimateData);
    } catch {
      return null;
    }
  }
  return typeof estimateData === 'object' ? estimateData : null;
}

function recurringServiceRowsFromEstimateData(estimateData) {
  const data = parseEstimateData(estimateData);
  const result = data?.result && typeof data.result === 'object'
    ? data.result
    : (data && typeof data === 'object' ? data : {});
  const nestedRecurring = result.results?.recurring && typeof result.results.recurring === 'object'
    ? result.results.recurring
    : {};
  return [
    ...(Array.isArray(result.recurring?.services) ? result.recurring.services : []),
    ...(Array.isArray(nestedRecurring.services) ? nestedRecurring.services : []),
  ].filter((row) => row && typeof row === 'object');
}

function recurringServiceLabel(row) {
  return String(row?.displayName || row?.name || row?.label || row?.service || '').trim();
}

function isPestRecurringService(row) {
  const label = recurringServiceLabel(row).toLowerCase();
  const service = String(row?.service || '').toLowerCase();
  return label.includes('pest') || service.includes('pest');
}

function nonPestRecurringServicesForOneTimeOption(estimateData) {
  const seen = new Set();
  return recurringServiceRowsFromEstimateData(estimateData)
    .filter((row) => !isPestRecurringService(row))
    .map((row) => recurringServiceLabel(row) || 'Unnamed recurring service')
    .filter((label) => {
      const key = label.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

module.exports = {
  nonPestRecurringServicesForOneTimeOption,
  validateEstimateDeliveryOptions,
};
