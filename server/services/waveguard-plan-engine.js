const db = require('../models/db');
const protocols = require('../config/protocols.json');
const { etDateString, etParts, parseETDateTime } = require('../utils/datetime-et');
const { summarizeLedgerRows } = require('./nutrient-ledger');
const { evaluateWaveGuardManagerApprovals } = require('./waveguard-approval-engine');
const { convertToOz, normalizeQuantityToOz } = require('./product-costing');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TRACK_BY_GRASS = {
  st_augustine: 'st_augustine',
  bermuda: 'bermuda',
  zoysia: 'zoysia',
  bahia: 'bahia',
};

const PROTOCOL_LINE_SCOPES = new Set([
  'BROADCAST_FULL',
  'SPOT_ALLOWANCE',
  'CONDITIONAL_SPOT',
  'CONDITIONAL_RESCUE',
  'PREMIUM_ONLY',
  'INSPECTION_ONLY',
  'BRANCH_ONE_OF',
  'FIRST_YEAR_ONLY',
  'HISTORY_RISK_ONLY',
]);

const MAY_FERTILIZER_BRANCH = {
  branchGroupId: 'MAY_P_INDEX_FERTILIZER',
  mutuallyExclusive: true,
  selectionRule: {
    if: 'soilPIndex < 80',
    use: 'LESCO_24_2_11',
    elseUse: 'LESCO_24_0_11',
  },
  defaultWhenNoSoilTest: 'LESCO_24_0_11',
  pricingModeWhenUnknown: 'MAX_BRANCH_COST_FOR_MARGIN_SAFETY',
};

function toServiceDate(value, fallback = new Date()) {
  const dateOnly = value
    ? String(value instanceof Date ? value.toISOString() : value).slice(0, 10)
    : etDateString(fallback);
  const parsed = parseETDateTime(`${dateOnly}T12:00`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function monthDayValue(month, day) {
  if (!month || !day) return null;
  return Number(month) * 100 + Number(day);
}

function dateMonthDayValue(date) {
  const et = etParts(date);
  return et.month * 100 + et.day;
}

function isDateInWindow(date, rule) {
  const start = monthDayValue(rule.restricted_start_month, rule.restricted_start_day);
  const end = monthDayValue(rule.restricted_end_month, rule.restricted_end_day);
  if (!start || !end) return false;
  const current = dateMonthDayValue(date);
  return start <= end
    ? current >= start && current <= end
    : current >= start || current <= end;
}

function parseMaybeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeProtocolProductText(value) {
  return normalizeText(
    String(value || '')
      .replace(/\([^)]*\$[^)]*\)/g, ' ')
      .replace(/^[★⚠\s-]+/g, ' ')
      .replace(/\bblackout\b/ig, ' ')
      .replace(/\bweather gated\b/ig, ' ')
  );
}

function productAliases(productOrName) {
  const name = typeof productOrName === 'string'
    ? productOrName
    : productOrName?.name;
  const normalized = normalizeText(name);
  const configuredAliases = typeof productOrName === 'string'
    ? []
    : (productOrName?.aliases || []).map(normalizeText).filter(Boolean);
  const tokens = normalized.split(' ').filter(Boolean);
  const withoutVendor = tokens.length > 1 ? tokens.slice(1) : tokens;
  const withoutVendorAndNpk = withoutVendor.filter((token) => !/^\d+$/.test(token));
  return [
    normalized,
    ...configuredAliases,
    withoutVendor.join(' '),
    withoutVendorAndNpk.join(' '),
    tokens.filter((token) => !/^\d+$/.test(token)).join(' '),
  ].filter((alias, index, arr) => alias && alias.length > 5 && arr.indexOf(alias) === index);
}

function parseProtocolLines(text, role) {
  if (!text) return [];
  return String(text)
    .split('\n')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => ({
      raw,
      role,
      conditional: role !== 'base' || /^if\b/i.test(raw) || /\bif\b/i.test(raw),
      product: null,
      ...classifyProtocolLine(raw, role),
    }));
}

function matchCatalogProduct(line, products) {
  // De-branded pest lines keep brand names out of the display text and supply
  // them via catalogProductHints (from the visit's lineMeta) so the catalog
  // product still attaches. Legacy lines fall back to the raw text as before.
  const matchText = Array.isArray(line.catalogProductHints) && line.catalogProductHints.length
    ? line.catalogProductHints.join(' ')
    : line.raw;
  const normalizedLine = normalizeProtocolProductText(matchText);
  if (!normalizedLine) return null;
  const lineNpk = parseNpkFromText(matchText);

  const candidates = products
    .map((product) => {
      const name = normalizeText(product.name);
      if (!name) return null;
      const productNpk = parseNpkFromText(product.name);
      const aliases = productAliases(product);
      const direct = aliases.some((alias) => normalizedLine.includes(alias));
      const reverse = aliases.some((alias) => alias.includes(normalizedLine));
      const firstTwo = name.split(' ').slice(0, 2).join(' ');
      const tokenMatch = firstTwo.length > 5 && normalizedLine.includes(firstTwo);
      if (!direct && !reverse && !tokenMatch) return null;
      const hasInventoryPrice = Number(product.cost_per_unit || 0) > 0 || Number(product.best_price || 0) > 0;
      const needsPricingPenalty = product.needs_pricing === true ? -75 : 0;
      const npkScore = lineNpk && productNpk
        ? (lineNpk.n === productNpk.n && lineNpk.p === productNpk.p && lineNpk.k === productNpk.k ? 150 : -250)
        : 0;
      return {
        product,
        score: name.length + (direct ? 100 : 0) + (tokenMatch ? 20 : 0) + (hasInventoryPrice ? 50 : 0) + needsPricingPenalty + npkScore,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return enrichProductAnalysis(candidates[0]?.product || null);
}

function enrichProductAnalysis(product) {
  if (!product) return null;
  const parsedNpk = parseNpkFromText(product.name);
  if (!parsedNpk) return product;
  return {
    ...product,
    analysis_n: product.analysis_n ?? parsedNpk.n,
    analysis_p: product.analysis_p ?? parsedNpk.p,
    analysis_k: product.analysis_k ?? parsedNpk.k,
  };
}

function productHasNitrogen(product) {
  return Number(product?.analysis_n || 0) > 0;
}

function productHasPhosphorus(product) {
  return Number(product?.analysis_p || 0) > 0;
}

function parseNpkFromText(value) {
  const match = String(value || '').match(/\b(\d{1,2})-(\d{1,2})-(\d{1,2})\b/);
  if (!match) return null;
  return {
    n: Number(match[1]),
    p: Number(match[2]),
    k: Number(match[3]),
  };
}

function itemHasNitrogen(item) {
  if (item.product) return productHasNitrogen(item.product);
  const npk = parseNpkFromText(item.raw);
  return Number(npk?.n || 0) > 0;
}

function itemHasPhosphorus(item) {
  if (item.product) return productHasPhosphorus(item.product);
  const npk = parseNpkFromText(item.raw);
  return Number(npk?.p || 0) > 0;
}

function itemIsPgr(item) {
  const category = normalizeText(item.product?.category);
  const raw = normalizeText(item.raw);
  return category.includes('plant growth regulator')
    || category === 'pgr'
    || raw.includes('primo')
    || raw.includes('pgr');
}

function getProductGroups(product) {
  return {
    moa: product?.moa_group || null,
    frac: product?.frac_group || null,
    irac: product?.irac_group || null,
    hrac: product?.hrac_group || null,
  };
}

function normalizeOptionList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeOptionList(item));
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function classifyProtocolLine(raw, role) {
  const text = normalizeText(raw);
  const hasDollarCost = /\$[\d.]+/.test(String(raw || ''));
  const scope = (() => {
    if (text.includes('if p') && (text.includes('24 2 11') || text.includes('24 0 11'))) {
      return 'BRANCH_ONE_OF';
    }
    if (text.includes('skip') && !hasDollarCost) return 'INSPECTION_ONLY';
    if (text.includes('soil sample')) return 'FIRST_YEAR_ONLY';
    if (text.includes('drive by scout') || text.includes('scout') || text.includes('audit') || text.includes('wellness touchpoint') || text.includes('annual report')) {
      return 'INSPECTION_ONLY';
    }
    if (text.includes('premium only') || text.startsWith('premium ') || text.includes(' premium ')) {
      return 'PREMIUM_ONLY';
    }
    if (text.includes('if sedge') || text.includes('dismiss') || text.includes('sedgehammer')) {
      return 'CONDITIONAL_SPOT';
    }
    if (text.includes('if threshold') || text.includes('curative') || text.includes('rescue') || text.includes('if active') || text.includes('if large patch') || text.includes('if severe')) {
      return 'CONDITIONAL_RESCUE';
    }
    if (text.includes('celsius') || text.includes('speedzone') || text.includes('three way') || text.includes('atrazine')) {
      return 'SPOT_ALLOWANCE';
    }
    if (text.includes('history')) return 'HISTORY_RISK_ONLY';
    return role === 'conditional' ? 'CONDITIONAL_RESCUE' : 'BROADCAST_FULL';
  })();

  const conditionFlag = (() => {
    if (scope === 'BRANCH_ONE_OF') return 'soil_p_index';
    if (scope === 'CONDITIONAL_SPOT' && (text.includes('sedge') || text.includes('dismiss'))) return 'sedge_present';
    if (text.includes('large patch')) return text.includes('active') ? 'active_disease' : 'large_patch_history';
    if (text.includes('chinch')) return 'chinch_threshold_met';
    if (text.includes('armyworm')) return 'armyworm_threshold_met';
    if (text.includes('mole cricket')) return 'mole_cricket_threshold_met';
    if (text.includes('hydretain') || text.includes('moisture') || text.includes('drought')) return 'drought_stress';
    if (scope === 'PREMIUM_ONLY') return 'premium_plan';
    if (scope === 'FIRST_YEAR_ONLY') return 'first_year';
    if (scope === 'SPOT_ALLOWANCE') return 'weed_pressure';
    return 'none';
  })();

  const areaFactors = (() => {
    if (text.includes('celsius')) {
      return {
        areaFactorDefault: 0.25,
        areaFactorClean: 0.125,
        areaFactorHeavy: 0.35,
        areaFactorBroadcast: 1,
      };
    }
    if (text.includes('dismiss') || text.includes('sedgehammer')) {
      return {
        areaFactorDefault: 0.1,
        areaFactorClean: 0.05,
        areaFactorHeavy: 0.2,
        areaFactorBroadcast: 1,
      };
    }
    if (scope === 'SPOT_ALLOWANCE') {
      return {
        areaFactorDefault: 0.25,
        areaFactorClean: 0.125,
        areaFactorHeavy: 0.35,
        areaFactorBroadcast: 1,
      };
    }
    return {
      areaFactorDefault: scope === 'INSPECTION_ONLY' ? 0 : 1,
      areaFactorClean: scope === 'INSPECTION_ONLY' ? 0 : 1,
      areaFactorHeavy: scope === 'INSPECTION_ONLY' ? 0 : 1,
      areaFactorBroadcast: scope === 'INSPECTION_ONLY' ? 0 : 1,
    };
  })();

  return {
    scope: PROTOCOL_LINE_SCOPES.has(scope) ? scope : 'BROADCAST_FULL',
    conditionFlag,
    branchGroupId: scope === 'BRANCH_ONE_OF' ? MAY_FERTILIZER_BRANCH.branchGroupId : null,
    ...areaFactors,
  };
}

function isConditionalSelected(item, options = {}) {
  if (!item.conditional) return true;
  const selectedIds = new Set(normalizeOptionList(options.selectedConditionalProductIds));
  const selectedNames = new Set(normalizeOptionList(options.selectedConditionalProductNames).map(normalizeText));
  const selectedRaw = new Set(normalizeOptionList(options.selectedConditionalRaw).map(normalizeText));
  return (item.product?.id && selectedIds.has(String(item.product.id)))
    || (item.product?.name && selectedNames.has(normalizeText(item.product.name)))
    || selectedRaw.has(normalizeText(item.raw));
}

function productBranchKey(item) {
  const text = normalizeText(`${item.raw || ''} ${item.product?.name || ''}`);
  if (text.includes('24 2 11')) return 'LESCO_24_2_11';
  if (text.includes('24 0 11')) return 'LESCO_24_0_11';
  return null;
}

function soilPIndexFromContext(context = {}) {
  const candidates = [
    context.soilPIndex,
    context.soil_p_index,
    context.soilPhosphorusIndex,
    context.soil_phosphorus_index,
    context.profile?.soil_p_index,
    context.profile?.soilPIndex,
    context.profile?.soil_phosphorus_index,
  ];
  for (const value of candidates) {
    if (value === '' || value == null) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function selectedMayFertilizerBranch(context = {}) {
  const soilPIndex = soilPIndexFromContext(context);
  if (soilPIndex == null) return {
    branchKey: MAY_FERTILIZER_BRANCH.defaultWhenNoSoilTest,
    soilPIndex: null,
    reason: 'default_no_soil_test',
  };
  return soilPIndex < 80
    ? { branchKey: MAY_FERTILIZER_BRANCH.selectionRule.use, soilPIndex, reason: 'soil_p_index_below_80' }
    : { branchKey: MAY_FERTILIZER_BRANCH.selectionRule.elseUse, soilPIndex, reason: 'soil_p_index_80_or_above' };
}

function normalizeFlagValues(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => normalizeFlagValues(item));
  if (typeof value === 'object') {
    return Object.entries(value)
      .filter(([, enabled]) => !!enabled)
      .map(([key]) => key);
  }
  return normalizeOptionList(value);
}

function normalizedFlagSet(...values) {
  return new Set(values.flatMap((value) => normalizeFlagValues(value)).map(normalizeText));
}

function isPremiumOrDroughtPrep(options = {}) {
  const flags = normalizedFlagSet(
    options.conditionFlags,
    options.condition_flags,
    options.propertyFlags,
    options.property_flags,
    options.stressFlags,
    options.stress_flags,
  );
  const plan = normalizeText(options.plan || options.serviceTier || options.waveguardTier);
  return plan === 'premium'
    || plan === 'premium 12'
    || plan === 'platinum'
    || options.includePremiumOnly === true
    || flags.has('drought stress')
    || flags.has('drought prep');
}

function resolveProtocolItems(lines, products, options = {}, context = {}) {
  const branchSelection = selectedMayFertilizerBranch({ ...context, ...options });
  const selectionContext = {
    ...context,
    ...options,
    plan: options.plan || context.plan || context.service?.waveguard_tier || context.serviceTier || context.waveguardTier,
  };
  const matchedItems = lines.map((line) => ({
    ...line,
    product: matchCatalogProduct(line, products),
  }));
  const explicitBranchSelection = matchedItems.find((item) => (
    item.scope === 'BRANCH_ONE_OF'
    && item.branchGroupId === MAY_FERTILIZER_BRANCH.branchGroupId
    && isConditionalSelected(item, options)
  ));
  const effectiveBranchSelection = explicitBranchSelection
    ? {
        branchKey: productBranchKey(explicitBranchSelection),
        soilPIndex: branchSelection.soilPIndex,
        reason: 'explicit_branch_selection',
      }
    : branchSelection;

  return matchedItems.map((item) => {
    let selected = isConditionalSelected(item, options);
    let selectionReason = selected ? 'base_or_explicit_selection' : 'conditional_not_selected';

    if (item.scope === 'BRANCH_ONE_OF' && item.branchGroupId === MAY_FERTILIZER_BRANCH.branchGroupId) {
      const branchKey = productBranchKey(item);
      selected = branchKey === effectiveBranchSelection.branchKey;
      selectionReason = selected ? effectiveBranchSelection.reason : 'mutually_exclusive_branch_not_selected';
      item.branch = {
        ...MAY_FERTILIZER_BRANCH,
        selectedBranchKey: effectiveBranchSelection.branchKey,
        productBranchKey: branchKey,
        soilPIndex: effectiveBranchSelection.soilPIndex,
      };
    }

    if (item.scope === 'PREMIUM_ONLY') {
      const premiumEligible = isPremiumOrDroughtPrep(selectionContext);
      if (premiumEligible) {
        selected = true;
        selectionReason = 'premium_or_drought_prep_selected';
      } else {
        selected = false;
        selectionReason = 'premium_or_drought_prep_not_selected';
      }
    }

    return {
      ...item,
      selected,
      selectionReason,
    };
  });
}

function effectiveAreaFactor(line, property = {}) {
  if (line?.scope === 'BROADCAST_FULL' || line?.scope === 'BRANCH_ONE_OF') return 1;
  if (line?.scope === 'INSPECTION_ONLY') return 0;
  if (line?.scope === 'FIRST_YEAR_ONLY' && property.isFirstYear === false) return 0;
  if (line?.scope === 'PREMIUM_ONLY' && !isPremiumOrDroughtPrep(property)) return 0;
  if (line?.scope === 'FIRST_YEAR_ONLY' || line?.scope === 'PREMIUM_ONLY') return 1;

  if (line?.scope === 'SPOT_ALLOWANCE' || line?.scope === 'CONDITIONAL_SPOT') {
    const pressure = normalizeText(property.weedPressure || property.weed_pressure);
    if (pressure === 'clean') return Number(line.areaFactorClean ?? 0.125);
    if (pressure === 'heavy') return Number(line.areaFactorHeavy ?? 0.35);
    if (pressure === 'broadcast' || pressure === 'uniform') return Number(line.areaFactorBroadcast ?? 1);
    return Number(line.areaFactorDefault ?? 0.25);
  }

  if (line?.scope === 'CONDITIONAL_RESCUE' || line?.scope === 'HISTORY_RISK_ONLY') {
    const flags = normalizedFlagSet(property.conditionFlags, property.condition_flags, property.propertyFlags, property.property_flags, property.stressFlags, property.stress_flags);
    const flag = normalizeText(line.conditionFlag);
    if (line.selected === true) return 1;
    return flag && flags.has(flag) ? 1 : 0;
  }

  return 0;
}

function parseVisitNutrientTargets(notes) {
  const text = String(Array.isArray(notes) ? notes.join(' ') : notes || '');
  const nApp = text.match(/\bN\s+app\b[^@.]*@\s*([\d.]+)\s*lb\s*N\s*(?:\/|per)?\s*1K/i);
  const nRate = text.match(/\bN\s+rate:?\s*([\d.]+)\s*lb\s*N/i);
  const kApp = text.match(/\bK\s+app\b[^@.]*@\s*([\d.]+)\s*lb\s*K\s*(?:\/|per)?\s*1K/i);
  const kRate = text.match(/\bK\s+rate:?\s*([\d.]+)\s*lb\s*K/i);
  const numberOrNull = (match) => {
    const value = match ? Number(match[1]) : null;
    return Number.isFinite(value) ? value : null;
  };
  return {
    targetNPer1000: numberOrNull(nApp) ?? numberOrNull(nRate),
    targetKPer1000: numberOrNull(kApp) ?? numberOrNull(kRate),
  };
}

function derivedNutrientRate(product, nutrient, targetPer1000) {
  const target = Number(targetPer1000);
  const enriched = enrichProductAnalysis(product);
  const analysis = Number(enriched?.[nutrient] || 0);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(analysis) || analysis <= 0) return null;
  return Number((target / (analysis / 100)).toFixed(4));
}

function productRatePer1000(product, options = {}) {
  const catalogRate = Number(product?.default_rate_per_1000 || 0);
  if (catalogRate > 0) {
    return {
      rate: catalogRate,
      unit: product?.rate_unit || null,
      source: 'catalog_default_rate',
    };
  }

  const nRate = derivedNutrientRate(product, 'analysis_n', options.targetNPer1000);
  if (nRate != null) {
    return {
      rate: nRate,
      unit: 'lb',
      source: 'target_n_analysis',
      targetNPer1000: Number(options.targetNPer1000),
    };
  }

  const kRate = derivedNutrientRate(product, 'analysis_k', options.targetKPer1000);
  if (kRate != null) {
    return {
      rate: kRate,
      unit: 'lb',
      source: 'target_k_analysis',
      targetKPer1000: Number(options.targetKPer1000),
    };
  }

  return {
    rate: 0,
    unit: product?.rate_unit || null,
    source: 'missing_rate',
  };
}

function productUnitSizeOz(product) {
  const explicit = Number(product?.unit_size_oz || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return normalizeQuantityToOz(product?.container_size);
}

function materialCostForAmount(product, amount, amountUnit) {
  const quantity = Number(amount);
  if (!product || !Number.isFinite(quantity) || quantity <= 0) return null;

  const costPerUnit = product.cost_per_unit != null ? Number(product.cost_per_unit) : null;
  if (Number.isFinite(costPerUnit) && costPerUnit >= 0) {
    const costUnit = product.cost_unit || amountUnit;
    const amountOz = convertToOz(quantity, amountUnit);
    const costUnitOz = convertToOz(1, costUnit);
    const convertedQuantity = amountOz != null && costUnitOz != null
      ? amountOz / costUnitOz
      : quantity;
    return {
      cost: Number((convertedQuantity * costPerUnit).toFixed(2)),
      source: 'inventory_cost_per_unit',
      costPerUnit,
      costUnit,
      pricedQuantity: Number(convertedQuantity.toFixed(4)),
    };
  }

  const bestPrice = product.best_price != null ? Number(product.best_price) : null;
  const unitSizeOz = productUnitSizeOz(product);
  const amountOz = convertToOz(quantity, amountUnit);
  if (
    Number.isFinite(bestPrice) && bestPrice >= 0
    && Number.isFinite(unitSizeOz) && unitSizeOz > 0
    && amountOz != null
  ) {
    return {
      cost: Number(((amountOz / unitSizeOz) * bestPrice).toFixed(2)),
      source: 'inventory_best_price_package_size',
      bestPrice,
      unitSizeOz,
      pricedQuantity: Number(amountOz.toFixed(4)),
      costUnit: 'oz',
    };
  }

  return null;
}

function calculateProductAmount({
  product,
  lawnSqft,
  carrierGalPer1000,
  areaFactor = 1,
  targetNPer1000 = null,
  targetKPer1000 = null,
} = {}) {
  const factor = Math.max(0, Number(areaFactor ?? 1));
  const treatedUnits = (Number(lawnSqft || 0) * factor) / 1000;
  const rateInfo = productRatePer1000(product, { targetNPer1000, targetKPer1000 });
  const rate = Number(rateInfo.rate || 0);
  const unit = rateInfo.unit || null;
  const amount = treatedUnits > 0 && rate > 0 ? Number((treatedUnits * rate).toFixed(3)) : null;
  const carrierGallons = treatedUnits > 0 && Number(carrierGalPer1000 || 0) > 0
    ? Number((treatedUnits * Number(carrierGalPer1000)).toFixed(2))
    : null;
  const materialCost = amount != null ? materialCostForAmount(product, amount, unit) : null;
  return {
    ratePer1000: rate || null,
    rateUnit: unit,
    rateSource: rateInfo.source,
    targetNPer1000: rateInfo.targetNPer1000 ?? null,
    targetKPer1000: rateInfo.targetKPer1000 ?? null,
    areaFactor: factor,
    treatedSqft: Number(lawnSqft || 0) && factor ? Number((Number(lawnSqft || 0) * factor).toFixed(2)) : null,
    amount,
    amountUnit: unit,
    carrierGallons,
    materialCost: materialCost?.cost ?? null,
    materialCostSource: materialCost?.source || null,
    materialCostDetail: materialCost,
  };
}

function summarizeMaterialCost(items = []) {
  const selectedItems = items.filter((item) => item?.selected !== false);
  const hasMaterialCost = (item) => item.mix?.materialCost != null && Number.isFinite(Number(item.mix.materialCost));
  const pricedItems = selectedItems.filter(hasMaterialCost);
  const missingItems = selectedItems.filter((item) => item.product && item.mix?.amount && !hasMaterialCost(item));
  const total = pricedItems.reduce((sum, item) => sum + Number(item.mix.materialCost), 0);
  return {
    total: Number(total.toFixed(2)),
    pricedLineCount: pricedItems.length,
    selectedLineCount: selectedItems.length,
    missingPriceCount: missingItems.length,
    source: pricedItems.length ? 'inventory_mix_material_cost' : 'unavailable',
    missingPriceProducts: missingItems.map((item) => ({
      productId: item.product.id,
      productName: item.product.name,
    })),
  };
}

function buildMixOrder(items) {
  const order = [
    'water_conditioner',
    'dry_wg_wdg_wp_df',
    'liquid_flowable_sc',
    'ec_ew',
    'solution_sl',
    'liquid_fertilizer',
    'adjuvant_last',
  ];
  const rank = new Map(order.map((key, index) => [key, index]));
  return items
    .filter((item) => item.product)
    .slice()
    .sort((a, b) => {
      const ar = rank.has(a.product.mixing_order_category) ? rank.get(a.product.mixing_order_category) : 99;
      const br = rank.has(b.product.mixing_order_category) ? rank.get(b.product.mixing_order_category) : 99;
      return ar - br || a.product.name.localeCompare(b.product.name);
    })
    .map((item, index) => ({
      step: index + 1,
      productId: item.product.id,
      productName: item.product.name,
      category: item.product.mixing_order_category || 'unclassified',
      instruction: item.product.mixing_instructions || item.raw,
    }));
}

function summarizeOrdinanceStatus({ date, ordinances, candidateItems }) {
  const blocks = [];
  const warnings = [];
  const activeWindows = ordinances.filter((rule) => isDateInWindow(date, rule));
  const hasNitrogen = candidateItems.some((item) => itemHasNitrogen(item));
  const hasPhosphorus = candidateItems.some((item) => itemHasPhosphorus(item));

  for (const rule of activeWindows) {
    if (rule.restricted_nitrogen && hasNitrogen) {
      blocks.push({
        code: 'nitrogen_blackout',
        severity: 'block',
        message: `${rule.jurisdiction_name} restricts nitrogen during this visit window.`,
        source: rule.source_name || null,
      });
    }
    if (rule.restricted_phosphorus && hasPhosphorus) {
      blocks.push({
        code: 'phosphorus_blackout',
        severity: 'block',
        message: `${rule.jurisdiction_name} restricts phosphorus during this visit window.`,
        source: rule.source_name || null,
      });
    }
  }

  const phosphorusSoilTestRule = ordinances.find((rule) => rule.phosphorus_requires_soil_test);
  if (phosphorusSoilTestRule && hasPhosphorus) {
    warnings.push({
      code: 'phosphorus_soil_test',
      severity: 'warning',
      message: `${phosphorusSoilTestRule.jurisdiction_name} requires soil-test support before phosphorus is applied.`,
    });
  }

  if (!ordinances.length) {
    warnings.push({
      code: 'ordinance_unknown',
      severity: 'warning',
      message: 'No active municipality ordinance row matched this property.',
    });
  }

  return { activeWindows, blocks, warnings };
}

function summarizeCalibration({ calibration, calibrations, date }) {
  const activeCalibrations = Array.isArray(calibrations)
    ? calibrations
    : (calibration ? [calibration] : []);

  if (!activeCalibrations.length) {
    return {
      selected: null,
      blocks: [{
        code: 'missing_calibration',
        severity: 'block',
        message: 'No active equipment calibration is available for mix math.',
      }],
      warnings: [],
    };
  }

  if (activeCalibrations.length > 1 && !calibration) {
    return {
      selected: null,
      blocks: [{
        code: 'equipment_selection_required',
        severity: 'block',
        message: 'Multiple active equipment calibrations exist. Select the intended equipment system before mix math can be trusted.',
      }],
      warnings: [],
      options: activeCalibrations.map((row) => ({
        equipmentSystemId: row.equipment_system_id,
        systemName: row.system_name,
        systemType: row.system_type,
        carrierGalPer1000: row.carrier_gal_per_1000 ? Number(row.carrier_gal_per_1000) : null,
        tankCapacityGal: row.tank_capacity_gal ? Number(row.tank_capacity_gal) : null,
        expiresAt: row.expires_at || null,
      })),
    };
  }

  const selected = calibration || activeCalibrations[0];
  const warnings = [];
  const blocks = [];
  if (selected.expires_at && new Date(selected.expires_at) < date) {
    blocks.push({
      code: 'expired_calibration',
      severity: 'block',
      message: `Calibration for ${selected.system_name || selected.name || 'selected equipment'} is expired.`,
    });
  }

  if (!selected.tank_capacity_gal) {
    warnings.push({
      code: 'missing_tank_capacity',
      severity: 'warning',
      message: 'Equipment tank capacity is missing; tank-fill checks are limited.',
    });
  }

  return { selected, blocks, warnings };
}

function calculateNutrients(items, lawnSqft) {
  const treatedUnits = Number(lawnSqft || 0) / 1000;
  const totals = { n: 0, p: 0, k: 0 };
  for (const item of items) {
    const amount = Number(item.mix?.amount || 0);
    if (!item.product || !amount || !treatedUnits) continue;
    const pounds = amountToPounds(amount, item.mix?.amountUnit || item.product.rate_unit);
    if (pounds == null) continue;
    totals.n += pounds * (Number(item.product.analysis_n || 0) / 100);
    totals.p += pounds * (Number(item.product.analysis_p || 0) / 100);
    totals.k += pounds * (Number(item.product.analysis_k || 0) / 100);
  }
  return {
    nPer1000: treatedUnits ? Number((totals.n / treatedUnits).toFixed(3)) : 0,
    pPer1000: treatedUnits ? Number((totals.p / treatedUnits).toFixed(3)) : 0,
    kPer1000: treatedUnits ? Number((totals.k / treatedUnits).toFixed(3)) : 0,
  };
}

function amountToPounds(amount, unit) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const normalized = normalizeText(unit);
  if (['lb', 'lbs', 'pound', 'pounds'].includes(normalized)) return n;
  if (['oz', 'ounce', 'ounces'].includes(normalized)) return n / 16;
  // Fluid ounces are volume. Without density/specific gravity, treating
  // them as pounds would corrupt N/P compliance math.
  if (['fl oz', 'fl_oz', 'floz', 'fluid ounce', 'fluid ounces'].includes(normalized)) return null;
  return null;
}

function findNutrientProductsMissingRates(items) {
  return items.filter((item) => {
    if (!item.product) return false;
    const hasNutrients = Number(item.product.analysis_n || 0) > 0
      || Number(item.product.analysis_p || 0) > 0
      || Number(item.product.analysis_k || 0) > 0;
    return hasNutrients && !item.mix?.amount;
  });
}

function findNutrientProductsMissingConversions(items) {
  return items.filter((item) => {
    if (!item.product || !item.mix?.amount) return false;
    const hasComplianceNutrients = Number(item.product.analysis_n || 0) > 0
      || Number(item.product.analysis_p || 0) > 0;
    if (!hasComplianceNutrients) return false;
    return amountToPounds(item.mix.amount, item.mix.amountUnit || item.product.rate_unit) == null;
  });
}

function selectProtocolVisit(profile, serviceDate) {
  const trackKey = profile?.track_key && protocols.lawn?.[profile.track_key]
    ? profile.track_key
    : TRACK_BY_GRASS[profile?.grass_type] || null;
  const track = trackKey ? protocols.lawn?.[trackKey] : null;
  const month = MONTH_ABBR[etParts(serviceDate).month - 1];
  const visit = track?.visits?.find((v) => v.month === month) || null;
  return { trackKey, track, month, visit };
}

async function getApplicableOrdinances(knex, profile) {
  if (!profile) return [];
  const county = String(profile.county || '').trim();
  const city = String(profile.municipality || '').trim();
  if (!county && !city) return [];

  let query = knex('municipality_ordinances').where({ active: true });
  query = query.where(function () {
    if (county) this.orWhere(function () {
      this.where({ jurisdiction_type: 'county' }).whereILike('county', county);
    });
    if (city) this.orWhere(function () {
      this.where({ jurisdiction_type: 'city' }).whereILike('city', city);
    });
  });
  return query;
}

async function getLatestAssessment(knex, customerId) {
  const row = await knex('lawn_assessments')
    .where({ customer_id: customerId })
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .first()
    .catch(() => null);
  if (!row) return null;
  return {
    ...row,
    stress_flags: parseMaybeJson(row.stress_flags, row.stress_flags || null),
    adjusted_scores: parseMaybeJson(row.adjusted_scores, row.adjusted_scores || null),
  };
}

async function getActiveCalibrations(knex, filters = {}) {
  const query = knex('equipment_calibrations as ec')
    .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where('ec.active', true)
    .where('es.active', true)
    .select(
      'ec.*',
      'es.name as system_name',
      'es.system_type',
      'es.tank_capacity_gal',
      'es.default_application_type',
    )
    .orderBy('es.system_type', 'asc')
    .orderBy('ec.expires_at', 'asc');

  if (filters.equipmentSystemId) {
    query.where('ec.equipment_system_id', filters.equipmentSystemId);
  }
  if (filters.calibrationId) {
    query.where('ec.id', filters.calibrationId);
  }

  return query.catch(() => []);
}

async function getProducts(knex) {
  const products = await knex('products_catalog')
    .where(function () {
      this.where({ active: true }).orWhereNull('active');
    })
    .select(
      'id', 'name', 'category', 'active_ingredient', 'moa_group',
      'frac_group', 'irac_group', 'hrac_group',
      'analysis_n', 'analysis_p', 'analysis_k',
      'default_rate_per_1000', 'rate_unit',
      'best_price', 'cost_per_unit', 'cost_unit', 'container_size', 'unit_size_oz', 'needs_pricing',
      'mixing_order_category', 'mixing_instructions',
      'label_verified_at',
    )
    .catch(() => []);

  if (!products.length) return products;

  const productIds = products.map((product) => product.id).filter(Boolean);
  const aliases = productIds.length
    ? await knex('product_aliases')
      .whereIn('product_id', productIds)
      .select('product_id', 'alias_name')
      .catch(() => [])
    : [];
  const aliasesByProduct = aliases.reduce((acc, row) => {
    if (!acc[row.product_id]) acc[row.product_id] = [];
    acc[row.product_id].push(row.alias_name);
    return acc;
  }, {});

  return products.map((product) => ({
    ...product,
    aliases: aliasesByProduct[product.id] || [],
  }));
}

function calculateNutrientLedgerFromRows(rows, products, lawnSqft, year) {
  const treatedUnits = Number(lawnSqft || 0) / 1000;
  const totals = { n: 0, p: 0, k: 0 };
  for (const row of rows) {
    const product = matchCatalogProduct({ raw: row.product_name }, products);
    const amount = Number(row.total_amount || 0);
    if (!product || !amount) continue;
    const pounds = amountToPounds(amount, row.amount_unit);
    if (pounds == null) continue;
    totals.n += pounds * (Number(product.analysis_n || 0) / 100);
    totals.p += pounds * (Number(product.analysis_p || 0) / 100);
    totals.k += pounds * (Number(product.analysis_k || 0) / 100);
  }

  return {
    year,
    nApplied: treatedUnits ? Number((totals.n / treatedUnits).toFixed(3)) : 0,
    pApplied: treatedUnits ? Number((totals.p / treatedUnits).toFixed(3)) : 0,
    kApplied: treatedUnits ? Number((totals.k / treatedUnits).toFixed(3)) : 0,
    totalN: Number(totals.n.toFixed(3)),
    totalP: Number(totals.p.toFixed(3)),
    totalK: Number(totals.k.toFixed(3)),
  };
}

async function calculateNutrientLedger(knex, customerId, products, lawnSqft, serviceDate = new Date()) {
  const year = etParts(serviceDate).year;
  const ledgerRows = await knex('property_nutrient_ledger')
    .where({ customer_id: customerId, application_year: year })
    .select(
      'application_date',
      'product_name',
      'analysis',
      'amount_used',
      'amount_unit',
      'n_applied_per_1000',
      'p_applied_per_1000',
      'k_applied_per_1000',
      'slow_release_n_pct',
      'municipality',
      'county',
      'blackout_status',
      'service_product_id',
    )
    .orderBy('application_date', 'asc')
    .catch(() => null);

  const ledgerSummary = Array.isArray(ledgerRows) && ledgerRows.length
    ? summarizeLedgerRows(ledgerRows, year)
    : null;

  const serviceProductQuery = knex('service_products as sp')
    .join('service_records as sr', 'sp.service_record_id', 'sr.id')
    .where('sr.customer_id', customerId)
    .where('sr.service_date', '>=', `${year}-01-01`)
    .select('sp.id', 'sp.product_name', 'sp.total_amount', 'sp.amount_unit');

  const ledgerServiceProductIds = (ledgerRows || [])
    .map((row) => row.service_product_id)
    .filter(Boolean);
  if (ledgerServiceProductIds.length) {
    serviceProductQuery.whereNotIn('sp.id', ledgerServiceProductIds);
  }

  const rows = await serviceProductQuery.catch(() => []);
  const fallbackSummary = calculateNutrientLedgerFromRows(rows, products, lawnSqft, year);
  if (ledgerSummary) {
    return {
      year,
      nApplied: Number((ledgerSummary.nApplied + fallbackSummary.nApplied).toFixed(3)),
      pApplied: Number((ledgerSummary.pApplied + fallbackSummary.pApplied).toFixed(3)),
      kApplied: Number((ledgerSummary.kApplied + fallbackSummary.kApplied).toFixed(3)),
      totalN: Number((ledgerSummary.totalN + fallbackSummary.totalN).toFixed(3)),
      totalP: Number((ledgerSummary.totalP + fallbackSummary.totalP).toFixed(3)),
      totalK: Number((ledgerSummary.totalK + fallbackSummary.totalK).toFixed(3)),
      entries: ledgerSummary.entries + rows.length,
      source: rows.length ? 'combined_ledger_and_service_products' : 'property_nutrient_ledger',
    };
  }

  return {
    ...fallbackSummary,
    entries: rows.length,
    source: 'service_products_fallback',
  };
}

function summarizeAnnualN({ currentN, projectedVisitN, annualNLimit }) {
  const used = Number(currentN || 0);
  const visit = Number(projectedVisitN || 0);
  const limit = Number(annualNLimit || 0);
  const projected = Number((used + visit).toFixed(3));
  const remainingBeforeVisit = limit ? Number(Math.max(limit - used, 0).toFixed(3)) : null;
  const remainingAfterVisit = limit ? Number(Math.max(limit - projected, 0).toFixed(3)) : null;
  const percentUsedAfterVisit = limit ? Number(((projected / limit) * 100).toFixed(1)) : null;
  const status = !limit
    ? 'unknown_limit'
    : projected > limit
      ? 'exceeded'
      : projected >= limit * 0.9
        ? 'near_limit'
        : 'ok';

  return {
    used,
    projected,
    visit,
    limit,
    remainingBeforeVisit,
    remainingAfterVisit,
    percentUsedAfterVisit,
    status,
    unit: 'lb N / 1,000 sqft / year',
  };
}

async function buildPlanForService(serviceId, options = {}) {
  const knex = options.db || db;
  const now = options.now || new Date();

  const service = await knex('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .leftJoin('technicians as t', 'ss.technician_id', 't.id')
    .where('ss.id', serviceId)
    .select(
      'ss.*',
      'c.first_name', 'c.last_name', 'c.address_line1', 'c.city', 'c.state', 'c.zip',
      'c.waveguard_tier',
      't.name as technician_name',
    )
    .first();

  if (!service) {
    const err = new Error('Scheduled service not found');
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }

  const serviceDate = toServiceDate(service.scheduled_date, now);
  const profile = await knex('customer_turf_profiles')
    .where({ customer_id: service.customer_id, active: true })
    .first()
    .catch(() => null);
  const products = await getProducts(knex);
  const latestAssessment = await getLatestAssessment(knex, service.customer_id);
  const stressFlags = latestAssessment?.stress_flags || {};
  const ordinances = await getApplicableOrdinances(knex, profile);
  const activeCalibrations = await getActiveCalibrations(knex, {
    equipmentSystemId: options.equipmentSystemId,
    calibrationId: options.calibrationId,
  });
  const nutrientLedger = await calculateNutrientLedger(knex, service.customer_id, products, profile?.lawn_sqft, serviceDate);

  const { trackKey, track, month, visit } = selectProtocolVisit(profile, serviceDate);
  const baseLines = parseProtocolLines(visit?.primary, 'base');
  const conditionalLines = parseProtocolLines(visit?.secondary, 'conditional');
  const nutrientTargets = parseVisitNutrientTargets(visit?.notes);
  const candidateItems = resolveProtocolItems([...baseLines, ...conditionalLines], products, options, {
    profile,
    service,
    stressFlags,
  });
  const plannedCandidateItems = candidateItems.filter((item) => item.selected);

  const calibrationSummary = summarizeCalibration({ calibrations: activeCalibrations, date: serviceDate });
  const calibration = calibrationSummary.selected;
  const carrier = Number(calibration?.carrier_gal_per_1000 || 0);
  const lawnSqft = Number(profile?.lawn_sqft || 0);
  const planItems = candidateItems.map((item) => ({
    raw: item.raw,
    role: item.role,
    conditional: item.conditional,
    scope: item.scope,
    conditionFlag: item.conditionFlag,
    branchGroupId: item.branchGroupId,
    branch: item.branch || null,
    areaFactorDefault: item.areaFactorDefault,
    areaFactorClean: item.areaFactorClean,
    areaFactorHeavy: item.areaFactorHeavy,
    areaFactorBroadcast: item.areaFactorBroadcast,
    selectionReason: item.selectionReason,
    selected: item.selected,
    matched: !!item.product,
    product: item.product ? {
      id: item.product.id,
      name: item.product.name,
      category: item.product.category,
      activeIngredient: item.product.active_ingredient,
      groups: getProductGroups(item.product),
      labelVerifiedAt: item.product.label_verified_at || null,
      analysis_n: item.product.analysis_n,
      analysis_p: item.product.analysis_p,
      analysis_k: item.product.analysis_k,
      bestPrice: item.product.best_price != null ? Number(item.product.best_price) : null,
      costPerUnit: item.product.cost_per_unit != null ? Number(item.product.cost_per_unit) : null,
      costUnit: item.product.cost_unit || null,
      containerSize: item.product.container_size || null,
      unitSizeOz: item.product.unit_size_oz != null ? Number(item.product.unit_size_oz) : null,
      needsPricing: item.product.needs_pricing === true,
      mixing_order_category: item.product.mixing_order_category,
      mixing_instructions: item.product.mixing_instructions,
    } : null,
    mix: item.product ? calculateProductAmount({
      product: item.product,
      lawnSqft,
      carrierGalPer1000: carrier,
      areaFactor: effectiveAreaFactor(item, {
        plan: options.plan || service.waveguard_tier,
        weedPressure: options.weedPressure,
        conditionFlags: options.conditionFlags,
        propertyFlags: options.propertyFlags,
        stressFlags,
        isFirstYear: options.isFirstYear,
      }),
      ...nutrientTargets,
    }) : null,
  }));
  const plannedItems = planItems.filter((item) => item.selected);
  const materialCostSummary = summarizeMaterialCost(plannedItems);

  const ordinanceSummary = summarizeOrdinanceStatus({ date: serviceDate, ordinances, candidateItems: plannedCandidateItems });
  const nutrientProjection = calculateNutrients(plannedItems, lawnSqft);
  const warnings = [
    ...ordinanceSummary.warnings,
    ...calibrationSummary.warnings,
  ];
  const blocks = [
    ...ordinanceSummary.blocks,
    ...calibrationSummary.blocks,
  ];

  if (!profile) {
    blocks.push({
      code: 'missing_turf_profile',
      severity: 'block',
      message: 'Customer has no active turf profile. Create the profile before planning a WaveGuard treatment.',
    });
  }
  if (profile && !profile.lawn_sqft) {
    blocks.push({
      code: 'missing_lawn_area',
      severity: 'block',
      message: 'Turf profile is missing lawn square footage, so mix amounts cannot be calculated.',
    });
  }
  if (!track || !visit) {
    blocks.push({
      code: 'missing_protocol_visit',
      severity: 'block',
      message: `No WaveGuard protocol visit found for ${trackKey || 'unmapped track'} in ${month}.`,
    });
  }
  if (candidateItems.some((item) => !item.product)) {
    warnings.push({
      code: 'unmatched_protocol_products',
      severity: 'warning',
      message: 'Some protocol lines did not match products_catalog rows; exact label math is limited until the protocol is normalized.',
    });
  }

  const missingNutrientRates = findNutrientProductsMissingRates(plannedItems);
  for (const item of missingNutrientRates) {
    blocks.push({
      code: 'missing_nutrient_rate',
      severity: 'block',
      productId: item.product.id,
      productName: item.product.name,
      message: `${item.product.name} has nutrient analysis but no verified default rate, so N/P/K projection cannot be trusted.`,
    });
  }

  const missingNutrientConversions = findNutrientProductsMissingConversions(plannedItems);
  for (const item of missingNutrientConversions) {
    blocks.push({
      code: 'missing_nutrient_density',
      severity: 'block',
      productId: item.product.id,
      productName: item.product.name,
      message: `${item.product.name} uses a volume rate with N/P analysis but no density, so N/P projection cannot be trusted.`,
    });
  }

  if (
    (stressFlags.drought_stress || stressFlags.heat_stress || stressFlags.recent_scalp)
    && plannedCandidateItems.some((item) => itemIsPgr(item))
  ) {
    blocks.push({
      code: 'pgr_on_stressed_turf',
      severity: 'block',
      message: 'Latest assessment flags turf stress; PGR requires manager approval before it can stay on the plan.',
    });
  }

  const annualNLimit = Number(profile?.annual_n_budget_target || ordinances.find((o) => o.annual_n_limit_per_1000)?.annual_n_limit_per_1000 || 4);
  const annualN = summarizeAnnualN({
    currentN: nutrientLedger.nApplied,
    projectedVisitN: nutrientProjection.nPer1000,
    annualNLimit,
  });
  if (annualN.status === 'near_limit' || annualN.status === 'exceeded') {
    warnings.push({
      code: 'annual_n_budget_near_limit',
      severity: annualN.status === 'exceeded' ? 'block' : 'warning',
      message: `Projected annual N is ${annualN.projected}/${annualN.limit} lb per 1,000 sq ft.`,
    });
    if (annualN.status === 'exceeded') {
      blocks.push({
        code: 'annual_n_budget_exceeded',
        severity: 'block',
        message: `This plan would exceed the annual N budget (${annualN.projected}/${annualN.limit}).`,
      });
    }
  }

  const managerApprovals = await evaluateWaveGuardManagerApprovals(knex, {
    customerId: service.customer_id,
    service,
    plan: {
      protocol: { base: planItems.filter((item) => item.role === 'base'), conditional: planItems.filter((item) => item.role === 'conditional') },
      mixCalculator: { items: plannedItems },
      propertyGate: { latestAssessment: latestAssessment ? { stressFlags } : null, trackKey, trackName: track?.name || null },
    },
    products: plannedItems
      .filter((item) => item.product)
      .map((item) => ({
        productId: item.product.id,
        name: item.product.name,
        rate: item.mix?.ratePer1000,
        rateUnit: item.mix?.rateUnit,
      })),
    serviceDate: etDateString(serviceDate),
  });
  for (const block of managerApprovals.blocks) blocks.push(block);
  for (const warning of managerApprovals.warnings) warnings.push(warning);

  const status = blocks.length ? 'blocked' : warnings.length ? 'warning' : 'approved';

  return {
    status,
    serviceId: service.id,
    generatedAt: now.toISOString(),
    propertyGate: {
      customerId: service.customer_id,
      customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),
      service: service.service_type,
      serviceTier: service.waveguard_tier || null,
      trackKey,
      trackName: track?.name || null,
      month,
      visit: visit?.visit || null,
      lawnSqft: profile?.lawn_sqft || null,
      municipality: profile?.municipality || service.city || null,
      county: profile?.county || null,
      ordinanceStatus: ordinanceSummary.activeWindows.length ? 'restricted_window_active' : 'no_active_blackout',
      annualN: {
        ...annualN,
        ledgerSource: nutrientLedger.source || null,
        ledgerEntries: nutrientLedger.entries || 0,
      },
      latestAssessment: latestAssessment ? {
        id: latestAssessment.id,
        serviceDate: latestAssessment.service_date,
        overallScore: latestAssessment.overall_score,
        stressFlags,
      } : null,
      warnings,
      blocks,
      managerApprovals,
    },
    protocol: {
      objective: visit?.notes || null,
      base: planItems.filter((item) => item.role === 'base'),
      conditional: planItems.filter((item) => item.role === 'conditional'),
      blocked: blocks,
    },
    mixCalculator: {
      equipmentSystemId: calibration?.equipment_system_id || null,
      carrierGalPer1000: calibration?.carrier_gal_per_1000 ? Number(calibration.carrier_gal_per_1000) : null,
      tankCapacityGal: calibration?.tank_capacity_gal ? Number(calibration.tank_capacity_gal) : null,
      lawnSqft: profile?.lawn_sqft || null,
      nutrientProjection,
      materialCostSummary,
      items: plannedItems,
      conditionalOptions: planItems.filter((item) => item.role === 'conditional' && !item.selected),
    },
    equipmentCalibration: calibrationSummary,
    mixingOrder: buildMixOrder(plannedItems),
    closeout: {
      requiredPhotos: ['before', 'after'],
      captureActualProductAmounts: true,
      customerRecapPreview: visit
        ? `${month} WaveGuard visit planned for ${track?.name || 'selected turf track'}.`
        : null,
    },
  };
}

module.exports = {
  buildPlanForService,
  calculateProductAmount,
  parseVisitNutrientTargets,
  summarizeMaterialCost,
  effectiveAreaFactor,
  calculateNutrientLedgerFromRows,
  calculateNutrients,
  summarizeAnnualN,
  buildMixOrder,
  findNutrientProductsMissingRates,
  findNutrientProductsMissingConversions,
  isDateInWindow,
  matchCatalogProduct,
  amountToPounds,
  classifyProtocolLine,
  parseProtocolLines,
  resolveProtocolItems,
  selectedMayFertilizerBranch,
  MAY_FERTILIZER_BRANCH,
  isConditionalSelected,
  summarizeCalibration,
  summarizeOrdinanceStatus,
};
