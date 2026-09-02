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

function intervalPriceFromAnnual(annualAmount, frequencyKey) {
  return roundMoney((Number(annualAmount || 0) * billingIntervalMonthsForFrequencyKey(frequencyKey)) / 12);
}

/**
 * Per-application (per-visit) charge for a plan billed per completed
 * application. The billing-cadence amount equals the visit charge only when
 * the billing interval matches the visit cadence (quarterly pest: four
 * charges, four visits). Service-tier plans PRESENT a monthly price but
 * deliver a different visit count (tree & shrub 6x standard / 4x light, the
 * lawn ladders, mosquito seasonal) — their true per-application price is the
 * plan's exact annual divided by its visits. Stamping the monthly display
 * rate instead undercollects on every calendar month without a visit
 * (tree & shrub audit 2026-07-18: six completions x annual/12 collects half
 * the accepted annual). With an unknown visit count a per-visit cadence
 * (quarterly / bimonthly / every-6-weeks — one charge per visit) still bills
 * the cadence amount, and so does a MONTHLY cadence on residential pest
 * control, whose monthly plan IS twelve visits (legacy rows encode
 * { frequency: 'monthly' } with no visitsPerYear — pre-push codex P0). A
 * monthly cadence on any other family is a tier plan's display rate whose
 * visit count could not be read, so the amount is unknown (null) and the
 * converter parks the fee instead of repeating that under-collection
 * (validation audit DATA-001, 2026-09-02). Callers pass the unit's
 * serviceKey as that family evidence.
 */
function perApplicationChargeAmount({
  billingCadence = null,
  annualRate,
  monthlyRate,
  visitsPerYear,
  serviceKey = null,
} = {}) {
  const cadenceAmount = roundMoney(billingCadence?.amount);
  const visits = Number(visitsPerYear);
  if (!Number.isFinite(visits) || visits <= 0) {
    // Unknown visit count: a per-visit cadence still bills the cadence
    // amount (one charge per visit by construction), and so does monthly
    // residential pest — its monthly plan IS twelve visits. A MONTHLY
    // cadence on any other family is the display rate of a tier plan whose
    // visit count we could not read — stamping it repeats the T&S
    // 2026-07-18 under-collection, so the amount is unknown and the
    // converter parks the fee (DATA-001).
    if (String(billingCadence?.frequencyKey || '') !== 'monthly') return cadenceAmount;
    return String(serviceKey || '') === 'pest_control' ? cadenceAmount : null;
  }
  const annual = Number(annualRate || 0);
  const monthly = Number(monthlyRate ?? billingCadence?.monthlyRate ?? 0);
  // Same correspondence guard as resolveBillingCadence: an annual that
  // diverges from monthly x 12 is not this plan's recurring annual — derive
  // from the monthly instead. An annual with no monthly at all is trusted.
  const annualCorresponds = annual > 0 && monthly > 0 && Math.abs(annual - monthly * 12) <= 0.5;
  const planAnnual = (annualCorresponds || (annual > 0 && !(monthly > 0))) ? annual : monthly * 12;
  if (!(planAnnual > 0)) return cadenceAmount;
  return roundMoney(planAnnual / visits);
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

// A PINNED pre-realignment rodent bait row (legacyPinnedReplay, no
// per-application marker) is the legacy MONTHLY-billed plan: its visitsPerYear
// is an operational cadence, not a billing unit. It never drives the billing
// cadence — with it, a rodent-only legacy accept inferred "quarterly" and
// stamped annual ÷ 4 ($147) where the disclosed lane is the monthly figure
// ($49). Shared with the converter, which routes the same rows through the
// legacy supplement path (codex #3591 r19/r20 P0).
function isPinnedLegacyRodentRow(svc = {}) {
  return svc?.legacyPinnedReplay === true
    && String(svc?.service || '').toLowerCase() === 'rodent_bait'
    && svc?.perApplicationBilled !== true;
}

// New-model evidence on a rodent row (mirrors rodentBaitLegacyReplaySignal's
// own test): the bracket engine stamps every row it prices with at least one
// of these; a pre-realignment row carries none.
function rodentRowHasNewModelMarker(svc = {}) {
  return svc?.perApplicationBilled === true
    || Number(svc?.stations) > 0
    || svc?.pricingBasis === 'RODENT_BAIT_BRACKET';
}

// Legacy-rodent predicate for a STORED estimate (codex #3591 r37 P0): the
// replay paths pin a pre-realignment row (legacyPinnedReplay) before it
// reaches billing/conversion, but a manual "mark as won" hands the STORED
// shape straight over — a pre-realignment quote-wizard row then has neither
// the pin nor a new-model marker, and a disclosed $49/mo plan would be
// stamped per-application at ~$147/completion. So the stored estimate's own
// legacy signal (rodentBaitLegacyReplaySignal) also classifies: when the
// stored result reads as legacy, every rodent_bait row without new-model
// evidence IS the legacy monthly plan. Returns a row predicate.
function legacyRodentRowPredicateFor(estimateData) {
  const data = parseEstimateData(estimateData);
  let storedLegacy = null;
  try {
    storedLegacy = require('./rodent-bait-legacy-replay').rodentBaitLegacyReplaySignal(data);
  } catch { storedLegacy = null; }
  return (svc = {}) => {
    if (isPinnedLegacyRodentRow(svc)) return true;
    if (!storedLegacy) return false;
    return String(svc?.service || '').toLowerCase() === 'rodent_bait' && !rodentRowHasNewModelMarker(svc);
  };
}

function collectRecurringServices(estimateData) {
  const data = parseEstimateData(estimateData);
  const isLegacyRodentRow = legacyRodentRowPredicateFor(data);
  const lists = [
    data.result?.recurring?.services,
    data.recurring?.services,
    data.results?.recurring?.services,
    data.services,
  ];
  const primary = lists.flatMap((list) => (Array.isArray(list) ? list : []));
  // Engine-backed recurring rows (codex #3591 r42 P1): a post-realignment
  // quote-wizard save persists its rodent row ONLY under
  // engineResult.lineItems (no mapped recurring container), so the cadence
  // must read it there or a manual win falls back to the monthly
  // equivalent. Recurring engine lines carry annual/monthly (one-time lines
  // carry price alone — the engine's own oneTimeItems rule); a row whose
  // service key the mapped lists already carry is not duplicated.
  const primaryKeys = new Set(primary
    .map((svc) => String(svc?.service || svc?.serviceKey || svc?.service_key || '').toLowerCase())
    .filter(Boolean));
  const engineRows = [data.engineResult?.lineItems, data.result?.lineItems]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((li) => li && typeof li === 'object'
      && (Number(li.annual) > 0 || Number(li.monthly) > 0)
      && !primaryKeys.has(String(li.service || li.serviceKey || li.service_key || '').toLowerCase()));
  return [...primary, ...engineRows].filter((svc) => !isLegacyRodentRow(svc));
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
  annualRate,
  frequencyKey,
  estimateData,
  fallbackFrequencyKey = 'monthly',
} = {}) {
  // `inferred` records whether the cadence came from the caller's key or
  // the estimate's own data, as opposed to the fallback: a fallback-only
  // cadence is a display convenience, never evidence of a per-application
  // price (validation audit DATA-001 / pre-push codex P0 — the accept path
  // stamped a fabricated quarterly amount on the reserved visit).
  const evidenced = normalizeFrequencyKey(frequencyKey)
    || inferFrequencyKeyFromEstimateData(estimateData)
    || null;
  const normalized = evidenced
    || normalizeFrequencyKey(fallbackFrequencyKey)
    || 'monthly';
  const display = displayForFrequencyKey(normalized);
  // The engine's annual is the exact plan price (quarterly $392 = 4 x $98);
  // the monthly is its rounded display ($32.67). Deriving the interval charge
  // from the rounded monthly overbills by cents (32.67 * 3 = 98.01 vs the
  // quoted 98.00), so when a caller supplies an annual that corresponds to
  // this monthly (±$0.50 — a diverging annual is not this plan's recurring
  // annual), the interval charge derives from the annual instead. Monthly
  // cadence is unchanged either way: round(annual / 12) IS the rounded
  // monthly the customer was quoted.
  const annual = Number(annualRate || 0);
  const monthly = Number(monthlyRate || 0);
  const annualCorresponds = annual > 0 && monthly > 0 && Math.abs(annual - monthly * 12) <= 0.5;
  const amount = annualCorresponds
    ? intervalPriceFromAnnual(annual, normalized)
    : intervalPriceFromMonthly(monthlyRate, normalized);

  return {
    frequencyKey: normalized,
    inferred: !!evidenced,
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

/**
 * The single source of truth for "this customer stays a monthly member
 * through an estimate accept" — shared by the converter's accept path and
 * the estimate display surfaces so the billing disclosure can never drift
 * from the billing behavior. Only NULL (legacy) or an explicit
 * monthly_membership lane preserves — any explicit non-monthly lane
 * (per_application/annual_prepay/per_visit/one_time) converts per the owner
 * ruling; lingering tier/rate fields on an explicit per-visit customer must
 * not resurrect membership billing (Codex #2836 r3).
 */
function customerPreservesMonthlyMembership(customer = {}) {
  return ['active_customer', 'won', 'at_risk'].includes(customer.pipeline_stage)
    && Number(customer.monthly_rate) > 0
    && (customer.billing_mode == null || customer.billing_mode === 'monthly_membership');
}

module.exports = {
  billingIntervalMonthsForFrequencyKey,
  collectRecurringServices,
  customerPreservesMonthlyMembership,
  displayForFrequencyKey,
  isPinnedLegacyRodentRow,
  rodentRowHasNewModelMarker,
  legacyRodentRowPredicateFor,
  frequencyKeyFromVisitsPerYear,
  inferFrequencyKeyFromEstimateData,
  intervalPriceFromAnnual,
  intervalPriceFromMonthly,
  normalizeFrequencyKey,
  parseEstimateData,
  perApplicationChargeAmount,
  resolveBillingCadence,
  roundMoney,
};
