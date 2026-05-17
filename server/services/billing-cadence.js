function roundMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeFrequencyKey(value) {
  if (value == null) return null;

  if (typeof value === 'number') {
    return frequencyKeyFromVisitsPerYear(value);
  }

  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;

  const compact = raw.replace(/[^a-z0-9]/g, '');
  if (compact === 'monthly' || compact === 'month' || compact === 'everymonth' || compact === '12x' || compact === '12xperyear') {
    return 'monthly';
  }
  if (
    compact === 'bimonthly'
    || compact === 'bimonth'
    || compact === 'bimonthlytreatment'
    || compact === 'everyothermonth'
    || compact === 'everytwomonths'
    || compact === 'every2months'
    || compact === '6x'
    || compact === '6xperyear'
  ) {
    return 'bi_monthly';
  }
  if (
    compact === 'quarterly'
    || compact === 'quarter'
    || compact === 'quarterlytreatment'
    || compact === 'everyquarter'
    || compact === 'everythreemonths'
    || compact === 'every3months'
    || compact === '4x'
    || compact === '4xperyear'
  ) {
    return 'quarterly';
  }

  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return frequencyKeyFromVisitsPerYear(numeric);
  }

  return null;
}

function frequencyKeyFromVisitsPerYear(visitsPerYear) {
  const n = Number(visitsPerYear || 0);
  if (n >= 12) return 'monthly';
  if (n >= 6) return 'bi_monthly';
  if (n > 0) return 'quarterly';
  return null;
}

function billingIntervalMonthsForFrequencyKey(key) {
  const normalized = normalizeFrequencyKey(key);
  if (normalized === 'quarterly') return 3;
  if (normalized === 'bi_monthly') return 2;
  return 1;
}

function intervalPriceFromMonthly(monthlyAmount, frequencyKey) {
  return roundMoney(Number(monthlyAmount || 0) * billingIntervalMonthsForFrequencyKey(frequencyKey));
}

function parseEstimateData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

function serviceNameLooksLikePest(service) {
  const name = [
    service?.service,
    service?.service_key,
    service?.name,
    service?.label,
    service?.displayName,
    service?.serviceName,
    service?.service_type,
  ].filter(Boolean).join(' ');
  return /pest/i.test(name);
}

function frequencyFromService(service) {
  if (!service || typeof service !== 'object') return null;
  const candidates = [
    service.frequency,
    service.frequencyKey,
    service.billing,
    service.cadence,
    service.label,
    service.visitsPerYear,
    service.visits,
    service.apps,
    service.freq,
  ];
  for (const candidate of candidates) {
    const key = normalizeFrequencyKey(candidate);
    if (key) return key;
  }
  return null;
}

function collectRecurringServices(estimateData) {
  const data = parseEstimateData(estimateData);
  const lists = [
    data.result?.recurring?.services,
    data.recurring?.services,
    data.results?.recurring?.services,
    data.services,
  ];
  return lists.flatMap((list) => (Array.isArray(list) ? list : []));
}

function inferFrequencyKeyFromEstimateData(estimateData) {
  const data = parseEstimateData(estimateData);
  const directCandidates = [
    data.customerSelection?.frequency,
    data.customerSelection?.frequencyKey,
    data.customerSelection?.frequencyLabel,
    data.selectedFrequency,
    data.selectedFrequencyKey,
    data.frequency,
    data.frequencyKey,
    data.inputs?.services?.pest?.frequency,
    data.engineInputs?.services?.pest?.frequency,
    data.result?.inputs?.services?.pest?.frequency,
  ];
  for (const candidate of directCandidates) {
    const key = normalizeFrequencyKey(candidate);
    if (key) return key;
  }

  const services = collectRecurringServices(data);
  const pestService = services.find(serviceNameLooksLikePest);
  const pestFrequency = frequencyFromService(pestService);
  if (pestFrequency) return pestFrequency;

  for (const service of services) {
    const key = frequencyFromService(service);
    if (key) return key;
  }

  return null;
}

function displayForFrequencyKey(key) {
  const normalized = normalizeFrequencyKey(key) || 'monthly';
  if (normalized === 'quarterly') {
    return {
      frequencyLabel: 'Quarterly',
      periodLabel: 'quarter',
      priceSuffix: '/quarter',
      displaySuffix: '/ quarter',
      planLabel: 'Quarterly plan',
      visitChargeNoun: 'quarterly visit',
    };
  }
  if (normalized === 'bi_monthly') {
    return {
      frequencyLabel: 'Bi-monthly',
      periodLabel: 'bi-monthly treatment',
      priceSuffix: '/bi-monthly treatment',
      displaySuffix: '/ bi-monthly treatment',
      planLabel: 'Bi-monthly plan',
      visitChargeNoun: 'bi-monthly visit',
    };
  }
  return {
    frequencyLabel: 'Monthly',
    periodLabel: 'month',
    priceSuffix: '/mo',
    displaySuffix: '/ mo',
    planLabel: 'Monthly plan',
    visitChargeNoun: 'monthly service',
  };
}

function resolveBillingCadence({
  monthlyRate,
  frequencyKey,
  estimateData,
  fallbackFrequencyKey = 'monthly',
} = {}) {
  const normalized = normalizeFrequencyKey(frequencyKey)
    || inferFrequencyKeyFromEstimateData(estimateData)
    || normalizeFrequencyKey(fallbackFrequencyKey)
    || 'monthly';
  const display = displayForFrequencyKey(normalized);
  const amount = intervalPriceFromMonthly(monthlyRate, normalized);

  return {
    frequencyKey: normalized,
    frequencyLabel: display.frequencyLabel,
    intervalMonths: billingIntervalMonthsForFrequencyKey(normalized),
    monthlyRate: roundMoney(monthlyRate),
    amount,
    periodLabel: display.periodLabel,
    priceSuffix: display.priceSuffix,
    displaySuffix: display.displaySuffix,
    planLabel: display.planLabel,
    visitChargeLabel: `Charged after each ${display.visitChargeNoun}`,
  };
}

module.exports = {
  billingIntervalMonthsForFrequencyKey,
  collectRecurringServices,
  displayForFrequencyKey,
  frequencyKeyFromVisitsPerYear,
  inferFrequencyKeyFromEstimateData,
  intervalPriceFromMonthly,
  normalizeFrequencyKey,
  parseEstimateData,
  resolveBillingCadence,
  roundMoney,
};
