const SERVICE_LINE_LABELS = {
  pest: 'Pest Control',
  lawn: 'Lawn Care',
  mosquito: 'Mosquito',
  tree_shrub: 'Tree & Shrub',
  rodent: 'Rodent',
  termite: 'Termite',
};

const SERVICE_LINE_PATTERNS = [
  ['termite', /termite|bora\s*care|boracare|termidor|trelona|advance|preslab|pre\s*slab|wdo/],
  ['mosquito', /mosquito/],
  ['rodent', /rodent|rat|mouse|mice/],
  ['lawn', /lawn|turf|fertili[sz]|weed|topdress|top\s*dress|dethatch|plugging|overseed/],
  ['tree_shrub', /tree|shrub|palm|ornamental/],
  ['pest', /pest|roach|cockroach|flea|wasp|bed\s*bug|bedbug|ant|spider|silverfish|earwig|general/],
];

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

function cleanText(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function serviceKeysFromText(...parts) {
  const text = cleanText(parts.filter(Boolean).join(' '));
  if (!text) return [];
  return SERVICE_LINE_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([key]) => key);
}

function numberOrNull(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getEstimateMonthlyTotal(estimate) {
  return numberOrNull(estimate?.monthlyTotal, estimate?.monthly_total);
}

function getEstimateOnetimeTotal(estimate) {
  return numberOrNull(estimate?.onetimeTotal, estimate?.onetime_total, estimate?.oneTimeTotal);
}

function addLine(linesByKey, key, amount, amountBasis = 'monthly') {
  if (!key) return;
  const existing = linesByKey.get(key) || { key, amount: null, amountBasis };
  if (Number.isFinite(amount) && amount > 0) {
    existing.amount = Number.isFinite(existing.amount)
      ? Math.round((existing.amount + amount) * 100) / 100
      : Math.round(amount * 100) / 100;
    existing.amountBasis = amountBasis;
  }
  linesByKey.set(key, existing);
}

function recurringServicesFromData(data) {
  const recurring = data?.result?.recurring || data?.engineResult?.recurring || null;
  const services = Array.isArray(recurring?.services) ? recurring.services : [];
  if (!services.length) return [];

  const rawAmounts = services.map((service) =>
    numberOrNull(
      service?.mo,
      service?.monthly,
      service?.monthlyTotal,
      service?.monthly_total,
      service?.amount,
    ),
  );
  const rawSum = rawAmounts.reduce((sum, amount) => sum + (Number.isFinite(amount) ? amount : 0), 0);
  const grandTotal = numberOrNull(recurring?.grandTotal, recurring?.monthlyTotal, recurring?.monthly_total);
  const ratio = rawSum > 0 && grandTotal > 0 ? grandTotal / rawSum : 1;

  const linesByKey = new Map();
  services.forEach((service, index) => {
    const keys = serviceKeysFromText(
      service?.service,
      service?.serviceKey,
      service?.service_key,
      service?.name,
      service?.label,
    );
    const amount = rawAmounts[index];
    const prorated = Number.isFinite(amount) && amount > 0 ? amount * ratio : amount;
    addLine(linesByKey, keys[0] || 'unknown', prorated, 'monthly');
  });

  return Array.from(linesByKey.values());
}

function selectedServiceKeysFromInputs(inputs = {}) {
  const keys = [];
  if (inputs.svcPest || inputs.svcOnetimePest || inputs.svcRoach || inputs.svcFlea || inputs.svcFleaExterior || inputs.svcWasp || inputs.svcBedbug) keys.push('pest');
  if (inputs.svcLawn || inputs.svcOnetimeLawn || inputs.svcPlugging || inputs.svcTopdress || inputs.svcDethatch) keys.push('lawn');
  if (inputs.svcMosquito || inputs.svcOnetimeMosquito) keys.push('mosquito');
  if (inputs.svcTs || inputs.svcInjection) keys.push('tree_shrub');
  if (inputs.svcRodentBait || inputs.svcRodentTrap || inputs.svcRodentSanitation || inputs.svcExclusion) keys.push('rodent');
  if (inputs.svcTermiteBait || inputs.svcTrenching || inputs.svcBoracare || inputs.svcPreslab || inputs.svcFoam) keys.push('termite');
  return unique(keys);
}

function fallbackAmountForKey(estimate, key, keyCount) {
  if (keyCount !== 1) return null;
  if (key === 'termite') return getEstimateOnetimeTotal(estimate) || getEstimateMonthlyTotal(estimate);
  return getEstimateMonthlyTotal(estimate);
}

function inferEstimateServiceLines(estimate = {}) {
  const data = parseEstimateData(estimate.estimateData ?? estimate.estimate_data);
  const recurringLines = recurringServicesFromData(data);
  if (recurringLines.length) return recurringLines;

  const inputKeys = selectedServiceKeysFromInputs(data?.inputs || data?.engineInputs || {});
  const textKeys = serviceKeysFromText(
    estimate.serviceInterest,
    estimate.service_interest,
    data?.inputs?.leadServiceInterest,
    data?.engineInputs?.serviceInterest,
    estimate.description,
    estimate.notes,
  );
  const keys = unique([...inputKeys, ...textKeys]);

  if (!keys.length) return [{ key: 'unknown', amount: null, amountBasis: 'unknown' }];
  return keys.map((key) => ({
    key,
    amount: fallbackAmountForKey(estimate, key, keys.length),
    amountBasis: key === 'termite' ? 'one_time' : 'monthly',
  }));
}

function inferEstimateServiceInterest(estimate = {}) {
  const explicit = String(estimate.serviceInterest || estimate.service_interest || '').trim();
  if (explicit) return explicit;

  const labels = inferEstimateServiceLines(estimate)
    .map((line) => SERVICE_LINE_LABELS[line.key])
    .filter(Boolean);
  return labels.length ? unique(labels).join(' + ') : null;
}

module.exports = {
  SERVICE_LINE_LABELS,
  inferEstimateServiceInterest,
  inferEstimateServiceLines,
  parseEstimateData,
  serviceKeysFromText,
};
