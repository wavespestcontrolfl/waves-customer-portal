const SERVICE_LINE_LABELS = {
  commercial_pest: 'Commercial Pest Control',
  commercial_lawn: 'Commercial Lawn Treatment',
  commercial_tree_shrub: 'Commercial Tree & Shrub',
  commercial_mosquito: 'Commercial Mosquito',
  commercial_termite_bait: 'Commercial Termite Bait Monitoring',
  commercial_rodent_bait: 'Commercial Rodent Bait Stations',
  pest: 'Pest Control',
  lawn: 'Lawn Care',
  mosquito: 'Mosquito',
  tree_shrub: 'Tree & Shrub',
  palm_injection: 'Palm Injection',
  rodent: 'Rodent',
  termite: 'Termite',
};

const SERVICE_LINE_PATTERNS = [
  ['commercial_pest', /commercial.*pest|pest.*commercial|commercial_pest/],
  ['commercial_lawn', /commercial.*lawn|commercial.*turf|lawn.*commercial|commercial_lawn/],
  ['commercial_tree_shrub', /commercial.*(tree|shrub|ornamental)|(tree|shrub|ornamental).*commercial|commercial_tree_shrub/],
  ['commercial_mosquito', /commercial.*mosquito|mosquito.*commercial|commercial_mosquito/],
  ['commercial_termite_bait', /commercial.*termite|termite.*commercial|commercial_termite_bait/],
  ['commercial_rodent_bait', /commercial.*rodent|rodent.*commercial|commercial_rodent_bait/],
  ['termite', /termite|foam|trench(?:ing)?|bora\s*care|boracare|termidor|trelona|advance|preslab|pre\s*slab|wdo/],
  ['mosquito', /mosquito/],
  ['rodent', /rodent|rat|mouse|mice/],
  ['palm_injection', /\bpalm\s*injection\b|\bpalm\s*treatment\b|\blethal\s*bronzing\b|\bpalms?\b/],
  ['lawn', /lawn|turf|fertili[sz]|weed|topdress|top\s*dress|dethatch|plugging|overseed/],
  ['tree_shrub', /tree|shrub|ornamental/],
  ['pest', /pest|exterminator|roach|cockroach|palmetto\s+knockdown|flea|wasp|bed\s*bug|bedbug|ant|spider|silverfish|earwig|general/],
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
  const keys = SERVICE_LINE_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([key]) => key);
  return keys.filter((key) => {
    // When a commercial key matched, drop its residential counterpart — the
    // commercial patterns are a superset of the residential ones (e.g.
    // 'Commercial Mosquito' matches both commercial_mosquito and mosquito), so
    // without this the inferred serviceLines / newsletter segmentation get
    // polluted with duplicate residential categories.
    if (key === 'pest' && keys.includes('commercial_pest')) return false;
    if (key === 'lawn' && keys.includes('commercial_lawn')) return false;
    if (key === 'tree_shrub' && keys.includes('commercial_tree_shrub')) return false;
    if (key === 'mosquito' && keys.includes('commercial_mosquito')) return false;
    if (key === 'termite' && keys.includes('commercial_termite_bait')) return false;
    if (key === 'rodent' && keys.includes('commercial_rodent_bait')) return false;
    return true;
  });
}

function numberOrNull(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function measurementMetadata(source = {}) {
  const metadata = {};
  if (source.measurements) metadata.measurements = source.measurements;
  if (source.palmCountSource !== undefined) metadata.palmCountSource = source.palmCountSource;
  if (source.palmCountWasManualOverride !== undefined) metadata.palmCountWasManualOverride = !!source.palmCountWasManualOverride;
  if (source.servicePalmCountDiffersFromPropertyPalmCount !== undefined) {
    metadata.servicePalmCountDiffersFromPropertyPalmCount = !!source.servicePalmCountDiffersFromPropertyPalmCount;
  }
  if (Array.isArray(source.measurementWarnings)) metadata.measurementWarnings = source.measurementWarnings;
  if (source.requiresMeasurement !== undefined) metadata.requiresMeasurement = !!source.requiresMeasurement;
  if (source.requiresManualReview !== undefined) metadata.requiresManualReview = !!source.requiresManualReview;
  if (Array.isArray(source.manualReviewReasons)) metadata.manualReviewReasons = source.manualReviewReasons;
  if (source.inputSourceSummary) metadata.inputSourceSummary = source.inputSourceSummary;
  return metadata;
}

function mergeMeasurementMetadata(existing = {}, next = {}) {
  const merged = { ...existing };
  if (next.measurements) {
    merged.measurements = {
      ...(merged.measurements || {}),
      ...next.measurements,
    };
  }
  if (next.measurementWarnings) {
    merged.measurementWarnings = unique([...(merged.measurementWarnings || []), ...next.measurementWarnings]);
  }
  if (next.manualReviewReasons) {
    merged.manualReviewReasons = unique([...(merged.manualReviewReasons || []), ...next.manualReviewReasons]);
  }
  if (next.requiresMeasurement !== undefined) {
    merged.requiresMeasurement = !!merged.requiresMeasurement || !!next.requiresMeasurement;
  }
  if (next.requiresManualReview !== undefined) {
    merged.requiresManualReview = !!merged.requiresManualReview || !!next.requiresManualReview;
  }
  if (next.inputSourceSummary) merged.inputSourceSummary = next.inputSourceSummary;
  if (next.palmCountSource !== undefined) merged.palmCountSource = next.palmCountSource;
  if (next.palmCountWasManualOverride !== undefined) merged.palmCountWasManualOverride = !!next.palmCountWasManualOverride;
  if (next.servicePalmCountDiffersFromPropertyPalmCount !== undefined) {
    merged.servicePalmCountDiffersFromPropertyPalmCount = !!next.servicePalmCountDiffersFromPropertyPalmCount;
  }
  return merged;
}

function commercialMetadata(line = {}) {
  if (!line.isCommercial && !String(line.service || '').startsWith('commercial_')) return {};
  return {
    commercialPricingMode: line.commercialPricingMode,
    isCommercial: !!line.isCommercial,
    commercialSubtype: line.commercialSubtype || null,
    originalRequestedService: line.originalRequestedService || null,
    quoteRequired: !!line.quoteRequired,
    requiresManualReview: !!line.requiresManualReview,
    autoQuoteRequiresAdminApproval: !!line.autoQuoteRequiresAdminApproval,
    manualReviewReasons: Array.isArray(line.manualReviewReasons) ? line.manualReviewReasons : [],
    taxable: line.taxable,
    taxCategory: line.taxCategory || null,
    pricingConfidence: line.pricingConfidence || null,
    reason: line.reason || null,
  };
}

function commercialKeyFromService(service) {
  const key = String(service || '').toLowerCase();
  if (key === 'commercial_pest') return 'commercial_pest';
  if (key === 'commercial_lawn') return 'commercial_lawn';
  if (key === 'commercial_tree_shrub') return 'commercial_tree_shrub';
  if (key === 'commercial_mosquito') return 'commercial_mosquito';
  if (key === 'commercial_termite_bait') return 'commercial_termite_bait';
  if (key === 'commercial_rodent_bait') return 'commercial_rodent_bait';
  return null;
}

function commercialManualLinesFromData(data) {
  const sources = [
    ...(Array.isArray(data?.manualQuoteLines) ? data.manualQuoteLines : []),
    ...(Array.isArray(data?.commercialManualQuoteLines) ? data.commercialManualQuoteLines : []),
    ...(Array.isArray(data?.result?.lineItems) ? data.result.lineItems : []),
    ...(Array.isArray(data?.engineResult?.lineItems) ? data.engineResult.lineItems : []),
    ...(Array.isArray(data?.result?.specItems) ? data.result.specItems : []),
    ...(Array.isArray(data?.result?.oneTime?.specItems) ? data.result.oneTime.specItems : []),
  ];
  const seen = new Set();
  return sources
    .map((line) => {
      const key = commercialKeyFromService(line?.service);
      if (!key) return null;
      // Priced commercial programs (auto_estimate, e.g. commercial_lawn /
      // commercial_tree_shrub) are NOT manual-quote lines — they surface as
      // recurring services. Only genuine manual-quote lines (commercial pest)
      // belong here; otherwise the priced line is double-counted.
      const isManual = !!line.quoteRequired || !!line.requiresManualReview;
      if (!isManual) return null;
      const id = `${key}|${line.originalRequestedService || ''}`;
      if (seen.has(id)) return null;
      seen.add(id);
      return {
        key,
        service: line.service,
        amount: numberOrNull(line.monthly, line.price, line.amount),
        amountBasis: 'manual_quote',
        ...commercialMetadata(line),
      };
    })
    .filter(Boolean);
}

// Priced commercial recurring lines (commercial_lawn / commercial_tree_shrub
// auto_estimate). The public quote flow persists these under
// engineResult.lineItems (no recurring.services block), so without this they'd
// fall back to service_interest text and be classified as residential, losing
// the commercial metadata.
function commercialPricedLinesFromData(data) {
  const sources = [
    ...(Array.isArray(data?.engineResult?.lineItems) ? data.engineResult.lineItems : []),
    ...(Array.isArray(data?.result?.lineItems) ? data.result.lineItems : []),
  ];
  const seen = new Set();
  return sources
    .map((line) => {
      const key = commercialKeyFromService(line?.service);
      if (!key) return null;
      // Manual commercial lines are handled by commercialManualLinesFromData.
      if (line.quoteRequired === true || line.requiresManualReview === true) return null;
      const amount = numberOrNull(line.monthly, line.mo, line.amount);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        key,
        service: line.service,
        amount,
        amountBasis: 'monthly',
        ...commercialMetadata(line),
      };
    })
    .filter(Boolean);
}

function getEstimateMonthlyTotal(estimate) {
  return numberOrNull(estimate?.monthlyTotal, estimate?.monthly_total);
}

function getEstimateOnetimeTotal(estimate) {
  return numberOrNull(estimate?.onetimeTotal, estimate?.onetime_total, estimate?.oneTimeTotal);
}

function addLine(linesByKey, key, amount, amountBasis = 'monthly', metadata = {}) {
  if (!key) return;
  const existing = linesByKey.get(key) || { key, amount: null, amountBasis };
  if (Number.isFinite(amount) && amount > 0) {
    existing.amount = Number.isFinite(existing.amount)
      ? Math.round((existing.amount + amount) * 100) / 100
      : Math.round(amount * 100) / 100;
    existing.amountBasis = amountBasis;
  }
  Object.assign(existing, mergeMeasurementMetadata(existing, metadata));
  linesByKey.set(key, existing);
}

function recurringServicesFromData(data) {
  const recurring = data?.result?.recurring || data?.engineResult?.recurring || null;
  const services = Array.isArray(recurring?.services) ? recurring.services : [];

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
    addLine(linesByKey, keys[0] || 'unknown', prorated, 'monthly', measurementMetadata(service));
  });

  const injection = data?.result?.results?.injection || data?.result?.injection || data?.engineResult?.results?.injection;
  const palmMonthly = numberOrNull(
    injection?.mo,
    injection?.monthly,
    recurring?.palmInjectionMo,
    recurring?.palm_injection_mo,
  );
  if (Number.isFinite(palmMonthly) && palmMonthly > 0) {
    addLine(
      linesByKey,
      'palm_injection',
      palmMonthly,
      'monthly',
      measurementMetadata(injection || {})
    );
  }

  return Array.from(linesByKey.values());
}

function oneTimeServicesFromData(data) {
  const sources = [
    ...(Array.isArray(data?.result?.oneTime?.items) ? data.result.oneTime.items : []),
    ...(Array.isArray(data?.result?.oneTime?.specItems) ? data.result.oneTime.specItems : []),
    ...(Array.isArray(data?.result?.specItems) ? data.result.specItems : []),
    ...(Array.isArray(data?.engineResult?.oneTime?.items) ? data.engineResult.oneTime.items : []),
    ...(Array.isArray(data?.engineResult?.oneTime?.specItems) ? data.engineResult.oneTime.specItems : []),
    ...(Array.isArray(data?.engineResult?.specItems) ? data.engineResult.specItems : []),
  ];
  if (!sources.length) return [];

  const linesByKey = new Map();
  const seen = new Set();
  sources.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (commercialKeyFromService(item.service)) return;
    if (item.onProg === true || item.includedOnProgram === true) return;
    const detail = item.detail || item.det || item.note || '';
    const identity = [
      item.service || '',
      item.serviceKey || item.service_key || '',
      item.name || item.label || '',
      item.price ?? item.amount ?? item.total ?? '',
      detail,
    ].join('|');
    if (seen.has(identity)) return;
    seen.add(identity);
    const keys = serviceKeysFromText(
      item?.service,
      item?.serviceKey,
      item?.service_key,
      item?.name,
      item?.label,
      detail,
    );
    addLine(
      linesByKey,
      keys[0] || 'unknown',
      numberOrNull(item?.price, item?.amount, item?.total),
      'one_time',
      measurementMetadata(item)
    );
  });
  return Array.from(linesByKey.values());
}

function selectedServiceKeysFromInputs(inputs = {}) {
  const keys = [];
  if (inputs.svcPest || inputs.svcOnetimePest || inputs.svcRoach || inputs.svcFlea || inputs.svcFleaExterior || inputs.svcWasp || inputs.svcBedbug) keys.push('pest');
  if (inputs.svcLawn || inputs.svcOnetimeLawn || inputs.svcPlugging || inputs.svcTopdress || inputs.svcDethatch) keys.push('lawn');
  if (inputs.svcMosquito || inputs.svcOnetimeMosquito) keys.push('mosquito');
  if (inputs.svcTs) keys.push('tree_shrub');
  if (inputs.svcInjection) keys.push('palm_injection');
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
  const commercialManualLines = commercialManualLinesFromData(data);
  const recurringLines = recurringServicesFromData(data);
  // Priced commercial lines persisted under engineResult.lineItems — skip keys
  // already surfaced via recurring.services (admin flow) to avoid duplicates.
  const recurringKeys = new Set(recurringLines.map((line) => line.key));
  const commercialPricedLines = commercialPricedLinesFromData(data)
    .filter((line) => !recurringKeys.has(line.key));
  const commercialLines = [...commercialPricedLines, ...commercialManualLines];
  if (commercialLines.length) {
    return [
      ...commercialLines,
      ...recurringLines,
      ...oneTimeServicesFromData(data),
    ];
  }
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
