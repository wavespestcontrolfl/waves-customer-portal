const db = require('../models/db');
const { savepointRead } = require('../utils/savepoint-read');
const { lawnProtocols, LAWN_V13_VERSION, lawnV13AnyGrassTrack, lawnV13NoBahiaProgram, visitForCadence, unknownCadenceWarning, roundStepForPlan, visitForRound, visitWithSpotLines } = require('./lawn-program');
const { lawnProhibitedProductBlock, treatedPropertyType } = require('./lawn-prohibited-products');
const featureGates = require('../config/feature-gates');
const logger = require('./logger');
const { V13_TROUBLE_N_TARGETS, FUNGUS_NITROGEN_NOTE_KEY, RECLAIMED_N_FRACTION, RECLAIMED_NITROGEN_NOTE_KEY } = require('../config/lawn-v13-nitrogen-targets');
const { V13_TROUBLE_PRODUCT_SWAPS, PRODUCT_SWAP_NOTE_KEY, swapOnlyRule } = require('../config/lawn-v13-trouble-product-swaps');
const { V13_CHINCH_TETRINO, CHINCH_TETRINO_NOTE_KEY, CHINCH_TETRINO_NOTE } = require('../config/lawn-v13-chinch-rate');
const { normalizeGrassType, resolveTrackKey, recordedGrassNamesBahia } = require('./lawn-grass-context');
const { etDateString, etParts, parseETDateTime } = require('../utils/datetime-et');
const { summarizeLedgerRows } = require('./nutrient-ledger');
const { LAWN_ROUNDS_9, roundSpotMonth } = require('./lawn-rounds');
const roundsCatchUp = require('./lawn-rounds-catchup');
const { evaluateWaveGuardManagerApprovals } = require('./waveguard-approval-engine');
const { convertToOz, normalizeQuantityToOz } = require('./product-costing');
const {
  getProtocolWindowContext,
  summarizeProtocolContext,
} = require('./lawn-protocol-operating-layer');
const { describeInventoryConversion } = require('./inventory-units');
const { resolveAddressCounty } = require('../config/address-county');
const bermudaRemoval = require('./lawn-bermuda-removal');
const { lawnCompletionDefaultsEnabled, loadLawnCompletionContext, buildLawnCompletionDefaults, matchesLawnCompletionProtocol, archivedLawnRecipeMatches } = require('./lawn-completion-defaults');

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

function parseProtocolLines(text, role, { exactName = false } = {}) {
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
      ...(exactName ? { exactName: true } : {}),
      ...classifyProtocolLine(raw, role),
    }));
}

// How a product's name relates to the line a v13 program spells.
// A line that spells whole catalog names (the v13 lawn program, `exact_catalog_names`) matches ONLY a product whose
// full name it spells: a missing product leaves the line unmatched, never a partial-name stand-in (Acelepryn for
// Tetrino because both say "Insecticide"). A product whose configured alias IS the spelled name also matches (a row
// the catalog holds under another name), but only when no row has the exact name (matchCatalogProduct ranks it last).
function nameRelation(product, name, normalizedLine, spelledName) {
  const nameMatch = normalizedLine.includes(name);
  const aliasMatch = !nameMatch && Boolean(spelledName) && (product.aliases || []).map(normalizeText).includes(spelledName);
  return { nameMatch, aliasMatch };
}

// Words that say what KIND of product a name is, or who sells it, not WHICH product it is. A fuzzy match that rests
// only on these is not a match: "Reliant Systemic Fungicide" is not "Headway Fungicide" because both say
// "fungicide", and "Manganese sulfate (Southern Ag)" is not "SpeedZone Southern" because both say "southern".
const GENERIC_NAME_WORDS = new Set([
  'fungicide', 'insecticide', 'herbicide', 'miticide', 'nematicide', 'fertilizer', 'bait', 'systemic', 'liquid',
  'granular', 'granules', 'soluble', 'concentrate', 'professional', 'southern', 'ag',
]);
// The seller of the LESCO line: part of the name, so "lesco 24" still identifies a product by its analysis, but not a
// word that identifies it alone or in a pair.
const SELLER_NAME_WORDS = new Set(['lesco']);

function hasDistinctiveWord(text) {
  return String(text || '').split(' ').some((token) => token && !GENERIC_NAME_WORDS.has(token));
}

// The words that identify a product: its name without numbers (NPK, rates), kind words and the seller. A line that
// spells every one of at least two of them names the product even when it orders or brackets them differently
// ("Manganese sulfate (Southern Ag)" for "Southern Ag Manganese Sulfate").
function distinctiveWords(name) {
  return name.split(' ').filter((token) => token.length > 2 && /[a-z]/.test(token) && !GENERIC_NAME_WORDS.has(token) && !SELLER_NAME_WORDS.has(token));
}

// The legacy fuzzy match: any alias of the product inside the line (direct), the line inside an alias (reverse), or
// the product's first two words inside the line. Each needs a distinctive word. The fourth route, allWords, is a
// fallback: every distinctive word of the product inside the line, in any order. It is not a direct hit, it ranks
// below every other route (see matchCatalogProduct), and it refuses a number the name lacks or the line contradicts.
function fuzzyNameMatch(product, name, normalizedLine) {
  const aliases = productAliases(product);
  const direct = aliases.some((alias) => normalizedLine.includes(alias) && hasDistinctiveWord(alias));
  const reverse = hasDistinctiveWord(normalizedLine) && aliases.some((alias) => alias.includes(normalizedLine));
  const firstTwo = name.split(' ').slice(0, 2).join(' ');
  const tokenMatch = firstTwo.length > 5 && normalizedLine.includes(firstTwo) && hasDistinctiveWord(firstTwo);
  const allWords = allWordsMatch(name, normalizedLine);
  return { direct, tokenMatch, allWords, matched: direct || reverse || tokenMatch || allWords, allWordsOnly: allWords && !direct && !reverse && !tokenMatch };
}

// Every distinctive word of the name is in the line, at least two of them, and the numbers agree: each number in the
// name is in the line, and a number right after a matched word in the line ("Ima-Jet 10") is in the name. So
// "Arborjet Ima-Jet 10" never reaches "Arborjet Ima-Jet Systemic Insecticide", a different product and rate.
function allWordsMatch(name, normalizedLine) {
  const words = distinctiveWords(name);
  if (words.length < 2) return false;
  const lineTokens = normalizedLine.split(' ');
  const nameTokens = new Set(name.split(' '));
  if (!words.every((word) => lineTokens.includes(word))) return false;
  const isNumber = (token) => /^\d+$/.test(token);
  if (name.split(' ').filter(isNumber).some((token) => !lineTokens.includes(token))) return false;
  return !lineTokens.some((token, i) => i > 0 && isNumber(token) && words.includes(lineTokens[i - 1]) && !nameTokens.has(token));
}

// Ranking: a longer name, a direct alias hit, a priced product and a matching NPK analysis rank higher; a product
// still needing pricing, or a different NPK analysis, ranks lower.
function candidateScore(product, name, { direct, tokenMatch }, lineNpk) {
  const productNpk = parseNpkFromText(product.name);
  const hasInventoryPrice = Number(product.cost_per_unit || 0) > 0 || Number(product.best_price || 0) > 0;
  const needsPricingPenalty = product.needs_pricing === true ? -75 : 0;
  const npkScore = lineNpk && productNpk
    ? (lineNpk.n === productNpk.n && lineNpk.p === productNpk.p && lineNpk.k === productNpk.k ? 150 : -250)
    : 0;
  return name.length + (direct ? 100 : 0) + (tokenMatch ? 20 : 0) + (hasInventoryPrice ? 50 : 0) + needsPricingPenalty + npkScore;
}

// One product against one line: { product, aliasOnly, score }, or null when it is not a candidate.
function scoreCatalogCandidate(product, { line, normalizedLine, lineNpk, spelledName }) {
  const name = normalizeText(product.name);
  if (!name) return null;
  const { nameMatch, aliasMatch } = nameRelation(product, name, normalizedLine, spelledName);
  if (line.exactName && !nameMatch && !aliasMatch) return null;
  const fuzzy = fuzzyNameMatch(product, name, normalizedLine);
  if (!fuzzy.matched) return null;
  return { product, aliasOnly: aliasMatch, allWordsOnly: fuzzy.allWordsOnly, score: candidateScore(product, name, fuzzy, lineNpk) };
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
  // The product name a v13 line spells: the text before " \u2014 " (the migrations resolve a recipe name the same
  // way: the exact catalog name, else an exact alias).
  const spelledName = normalizeProtocolProductText(String(matchText || '').split(' \u2014 ')[0]);

  const candidates = products
    .map((product) => scoreCatalogCandidate(product, { line, normalizedLine, lineNpk, spelledName }))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // Exact name first, else alias: an alias-only row stands in only when no row spells the name.
  const named = line.exactName && candidates.some((candidate) => !candidate.aliasOnly)
    ? candidates.filter((candidate) => !candidate.aliasOnly) : candidates;
  // A row matched only because the line spells all its distinctive words ranks below every other kind of match, so
  // an exact full name or a real alias hit always outranks it, whatever the name lengths.
  const ranked = named.some((candidate) => !candidate.allWordsOnly)
    ? named.filter((candidate) => !candidate.allWordsOnly) : named;
  return enrichProductAnalysis(ranked[0]?.product || null);
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

// The staged v13 protocol's product rows by catalog id, only while GATE_LAWN_V13
// is live and that version is the one resolved; empty otherwise.
function v13ProtocolRows(structuredProtocol) {
  if (featureGates.lawnV13Live?.() !== true || structuredProtocol?.version !== LAWN_V13_VERSION) return new Map();
  // A step row and an ordinary row may name one catalog product: each line reads its own kind (rowFor).
  return bermudaRemoval.rowsByProduct((structuredProtocol.products || []).filter((row) => row.productId));
}

// GATE_LAWN_V13: every lawn visit plans from the staged v13 protocol or not at
// all. The recipe lines come from lawnProtocols() for the whole portal, so any
// other structured protocol (the staged row missing because the migration did not
// run or the track had no active baseline, or a visit pinned to an older version)
// would pair v13 products and catalog-default rates with another version's windows
// and gates. The reverse also holds: a visit already pinned to the staged v13
// protocol while the gate is OFF would show legacy-recipe amounts against v13
// windows. Either way the plan withholds its calculated products and blocks
// instead; the pin is read from the appointment itself, so this does not depend on
// the completion-default gates. Returns the block, or null.
// A v13 recipe line (exact catalog names) that matched no active product, because the catalog row that carries its
// name (or an alias of it) is INACTIVE: getProducts leaves inactive rows out, so without this the line would just
// vanish (a base application disappearing). A base line is a block, a conditional line a warning; both name
// the product and say the office must activate it. A line with no inactive row is unmatched as before.
async function lawnV13InactiveProductNotices(knex, items, { strict = false } = {}) {
  const unmatched = (items || []).filter((item) => item.exactName === true && !item.product && String(item.raw || '').includes(' \u2014 '));
  if (!unmatched.length) return { blocks: [], warnings: [] };
  const inactive = await savepointRead(knex, (k) => k('products_catalog').where({ active: false }).select('id', 'name'))
    .catch((err) => { if (strict) throw err; return []; });
  if (!inactive.length) return { blocks: [], warnings: [] };
  const aliasRows = await savepointRead(knex, (k) => k('product_aliases').whereIn('product_id', inactive.map((row) => row.id)).select('product_id', 'alias_name'))
    .catch((err) => { if (strict) throw err; return []; });
  const namesOf = (row) => [row.name, ...aliasRows.filter((alias) => String(alias.product_id) === String(row.id)).map((alias) => alias.alias_name)].map(normalizeText);
  const blocks = [];
  const warnings = [];
  const seen = new Set();
  for (const item of unmatched) {
    const spelled = String(item.raw).split(' \u2014 ')[0].trim();
    if (seen.has(`${item.role}:${spelled}`) || !inactive.some((row) => namesOf(row).includes(normalizeText(spelled)))) continue;
    seen.add(`${item.role}:${spelled}`);
    const notice = {
      code: 'lawn_v13_product_inactive',
      severity: item.role === 'base' ? 'block' : 'warning',
      productName: spelled,
      message: `${spelled} is inactive in the catalog; the office must activate it. This visit's plan cannot include it until then${item.role === 'base' ? ', so no amount is planned for the step' : ''}.`,
    };
    (item.role === 'base' ? blocks : warnings).push(notice);
  }
  return { blocks, warnings };
}

function lawnV13PlanBlock({ trackKey, service, structuredProtocol }) {
  if (featureGates.lawnV13Live?.() === true) {
    if (!trackKey || structuredProtocol?.version === LAWN_V13_VERSION) return null;
    return { code: 'lawn_v13_protocol_missing', severity: 'block', message: `This visit has no staged ${LAWN_V13_VERSION} lawn protocol (not loaded for this track, or the visit is pinned to an older version); suggested amounts are unavailable. Enter the actual work.` };
  }
  if (service?.lawn_protocol_version === LAWN_V13_VERSION || structuredProtocol?.version === LAWN_V13_VERSION) {
    return { code: 'lawn_v13_gate_off', severity: 'block', message: `This visit is pinned to the ${LAWN_V13_VERSION} lawn protocol but GATE_LAWN_V13 is off; suggested amounts are unavailable. Enter the actual work.` };
  }
  return null;
}

// What a staged v13 product row's gates mean in the field, for the plan item the
// panel and job card show: one table, one loop. `required` = a condition the tech
// must meet or check before applying (the plan has no evidence to clear it);
// otherwise an instruction. `when` is the extra test for a gate the plan CAN judge
// from its context: novToMarOnly against the service month, northPortBlocked
// against the visit's resolved municipality, spreaderVisitOnly against the window's
// production mode. Keys not in the table carry no field text. Order is display order.
const NOV_TO_MAR = (month) => month > 3 && month < 11;
const isNorthPort = (municipality) => /north\s*port/i.test(String(municipality || ''));
// North Port bans nitrogen and phosphorus from April 1 to September 30: is this calendar month (1-12) inside that span? The ONE test for
// the stored northPortBlocked note of a rounds visit and for the round-3 nitrogen hold (roundsNitrogenHold), so the two never disagree.
const northPortNpBanMonth = (month) => Number(month) >= 4 && Number(month) <= 9;
const V13_GATE_NOTES = [
  { key: 'minDistanceFromWaterFt', required: true, text: (ft) => `Keep ${ft} ft from ponds, lakes and canals; skip that strip.` },
  { key: 'holdForTropicalWatch', required: true, text: () => 'Hold the application if a tropical storm or hurricane is forecast.' },
  // A rounds visit judges the weed and spot rule by the real date (`spotMonthNumber`); every other visit by the service month.
  { key: 'novToMarOnly', required: true, when: (ctx) => (ctx.spotMonthNumber ?? ctx.monthNumber) != null && NOV_TO_MAR(ctx.spotMonthNumber ?? ctx.monthNumber), text: () => 'Use only from November through March; this visit is outside that season.' },
  { key: 'spreaderVisitOnly', required: true, when: (ctx) => /hose|reel/i.test(String(ctx.productionMode || '')), text: () => 'Granular product: apply on a spreader visit, not from the hose pass.' },
  // The stored gate was written for the step's own month (North Port bans N and P Apr 1 to Sep 30). A rounds visit can read a step of
  // another season (round 2 reads April's Dimension row in Feb and Mar), so it judges the ban by the REAL date (`realMonthNumber`).
  { key: 'northPortBlocked', required: true, when: (ctx) => isNorthPort(ctx.municipality) && (ctx.realMonthNumber == null || northPortNpBanMonth(ctx.realMonthNumber)), text: () => 'Not allowed in North Port this month; skip this product.' },
  { key: 'northPortProductWindow', required: true, when: (ctx) => isNorthPort(ctx.municipality), text: () => 'North Port holds this product from June to September until the city confirms. Do not apply it at this visit.' },
  { key: 'applyAlone', text: () => 'Apply alone: no other product in the tank.' },
  { key: 'ownPass', text: () => 'Apply as its own spreader pass: do not blend with the month\'s granular or any other product.' },
  { key: 'delayWateringOrMowingHours', text: (hours) => `Delay watering (irrigation) or mowing for ${hours} hours after application (label).` },
  { key: 'delayWateringHours', text: (hours) => `Delay watering for ${hours} hours.` },
  { key: 'noWaterIn', text: () => 'Do not water this in.' },
  { key: 'tankMixWith', text: (product) => `Tank mix with ${product}.` },
  { key: 'concentration', text: (value) => `Concentration ${value}.` },
  { key: 'paleTurfRate', text: (rate) => `Pale turf rate: ${rate}.` },
  { key: 'rateRange', text: (range) => `Label rate range ${range}.` },
  { key: 'sunnyTurfOnly', text: () => 'Sunny turf only; the amount covers the sunny share of the lawn.' },
  // Bermuda removal step (GATE_LAWN_BERMUDA_REMOVAL; rows tagged gates.bermudaRemoval).
  { key: 'bermudaRemoval', text: () => 'Bermuda removal: Recognition, Fusilade II and the surfactant go in one mix, mapped bermuda areas plus a 3 ft border.' },
  { key: 'requiresProduct', text: (product) => `Apply only together with ${product}.` },
  { key: 'activelyGrowingOnly', required: true, text: () => 'Spray only when the bermuda is actively growing.' },
  { key: 'morningUnderF', required: true, text: (degrees) => `Spray in the morning, with the temperature under ${degrees}°F.` },
  { key: 'noRainOrIrrigationHours', text: (hours) => `No rain or irrigation for ${hours} hours after the spray.` },
  { key: 'noMowDaysBeforeAfter', text: (days) => `Do not mow for ${days} days before or after the spray.` },
  { key: 'skipCelsiusInBermudaArea', text: () => 'Skip the Celsius weed spot in the bermuda area today.' },
  // Zoysia only (migration 20261006220600): the mix is the manufacturer's 2(ee) recommendation, not the printed label.
  { key: 'zoysia2eeOnHand', required: true, text: () => 'Zoysia: this mix is a Syngenta FIFRA 2(ee) recommendation (2023-03-28), not the printed label — keep the 2(ee) on hand when applying.' },
];

function v13GateNotes(gates, context = {}) {
  const g = gates && typeof gates === 'object' ? gates : {};
  return V13_GATE_NOTES
    .filter((entry) => g[entry.key] && (!entry.when || entry.when(context)))
    .map((entry) => ({ key: entry.key, severity: entry.required ? 'required' : 'note', text: entry.text(g[entry.key]) }));
}

// The selected items' required gate notes as plan warnings, and an apply-alone
// product selected beside any other product as a block. Shared by the plan and
// the tank sheet so the two never disagree. Items need { product, gateNotes }.
function v13SelectedGateWarnings(selectedItems) {
  return selectedItems.flatMap((item) => (item.gateNotes || []).filter((note) => note.severity === 'required').map((note) => ({
    code: 'lawn_v13_product_gate', severity: 'warning', gate: note.key,
    productId: item.product?.id || null, productName: item.product?.name || null,
    message: `${item.product?.name || 'Product'}: ${note.text}`,
  })));
}

// The apply-alone blocks for the SELECTED lines of a visit or a tank sheet, judged
// before any quantity is computed so both can withhold the selection's amounts.
// A line is { product, selected }; rowOf(line) is its staged v13 row, or null.
function v13SelectionBlocks(lines, rowOf, gateContext) {
  return v13ApplyAloneBlocks(lines.filter((line) => line.selected && line.product).map((line) => ({
    product: line.product,
    gateNotes: v13GateNotes(rowOf(line)?.gates, gateContext),
  })));
}

function v13ApplyAloneBlocks(selectedItems) {
  return selectedItems
    .filter((item) => item.product && item.gateNotes?.some((note) => note.key === 'applyAlone')
      && selectedItems.some((other) => other !== item && other.product))
    .map((item) => ({
      code: 'lawn_v13_apply_alone', severity: 'block', productId: item.product.id, productName: item.product.name,
      message: `${item.product.name} is applied alone, but other products are selected with it. Remove them from the mix or apply them separately.`,
    }));
}

// The same rows for a reader with no visit (the tank sheet, the cost audit): one
// track and month, read from the database. Empty with the gate off. With the gate
// on and no staged v13 protocol it throws (code lawn_v13_protocol_missing): the v13
// recipe must never be priced or mixed at catalog-default rates.
//
// `spotMonth` (1-12; a rounds visit's tank sheet): the weed and spot rows come from that month's window while every other row comes from
// `monthName`'s (getProtocolWindowContext roundStep). Absent, one window, as always. `catchUp` (with spotMonth): the spring pre-emergent
// catch-up row of the March window joins them (lawn-rounds-catchup.js).
async function loadV13RowsForMonth(knex, trackKey, monthName, { includeBermudaRemoval = false, spotMonth = null, catchUp = false } = {}) {
  if (featureGates.lawnV13Live?.() !== true) return new Map();
  const serviceDate = new Date(Date.UTC(2026, MONTH_ABBR.indexOf(monthName), 15, 16));
  const summary = summarizeProtocolContext(await getProtocolWindowContext(knex, {
    serviceDate, grassTrack: trackKey, strict: true, planning: true, ...(includeBermudaRemoval ? { includeBermudaRemoval: true } : {}),
    ...(spotMonth ? { roundStep: roundsCatchUp.roundStepFields({ month: MONTH_ABBR.indexOf(monthName) + 1, spotMonth }, catchUp) } : {}),
  }));
  if (summary?.version !== LAWN_V13_VERSION) {
    throw Object.assign(new Error(`GATE_LAWN_V13 is on but the staged ${LAWN_V13_VERSION} protocol is missing for ${trackKey}`), { code: 'lawn_v13_protocol_missing' });
  }
  return v13ProtocolRows(summary);
}

// How a matched staged v13 protocol row sets the planned rate: its own stated
// rate, else (a lb_n / lb_k nutrition row) the visit's nutrient target. Spread
// into calculateProductAmount; {} for no row (gate off, or no v13 match).
function v13RateOptions(row) {
  if (!row) return {};
  if (Number(row.ratePer1000) > 0) return { protocolRate: { rate: row.ratePer1000, unit: row.rateUnit } };
  if (/^lb_[nk]/i.test(String(row.rateUnit || ''))) return { deriveNutrientFirst: true };
  return {};
}

// A v13 row computes an amount only when it is a whole-lawn row that states a rate
// (or a nutrient target to derive one from). A spot row (backpack work on an area
// the tech measures) or a label-rate row (Dylox) has no area, carrier or rate the
// plan knows, so it gets no quantity anywhere: the tech enters the area treated and
// the amount used. This is the one chokepoint the plan, the tank sheet and the
// completion defaults all go through.
function v13RowCalculates(row) {
  return row.applicationMode !== 'spot'
    && (Number(row.ratePer1000) > 0 || /^lb_[nk]/i.test(String(row.rateUnit || '')));
}

// The label rate as reference text for a row that gets no quantity: a stated
// concentration first (a surfactant is a percent of the tank, never a per-1,000 rate),
// then the row's rate, the label range, the catalog default.
function v13SpotReference(row, product) {
  const gates = row.gates || {};
  const perThousand = (rate, unit) => (Number(rate) > 0 ? `Label rate ${[rate, unit].filter(Boolean).join(' ')} per 1,000 sq ft` : null);
  return (gates.concentration ? `Label concentration ${gates.concentration}` : null)
    || perThousand(row.ratePer1000, row.rateUnit)
    || (gates.rateRange ? `Label rate ${gates.rateRange}` : null)
    || perThousand(product?.default_rate_per_1000, product?.rate_unit);
}

// A whole-lawn product the v13 program limits to sunny turf (Tetrino): the share
// of the lawn that is sunny, from the turf profile's sun exposure. No sun
// exposure on file is the half the cost model assumed.
const SUNNY_TURF_SHARE = { full_sun: 1, partial_shade: 0.5, heavy_shade: 0 };

function effectiveAreaFactor(line, property = {}) {
  if (line?.scope === 'BROADCAST_FULL' && line.sunnyTurfOnly) return SUNNY_TURF_SHARE[property.sunExposure] ?? 0.5;
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

// GATE_LAWN_NOV_LARGE_PATCH_N / GATE_LAWN_DEC_LARGE_PATCH_K: does the visit's property have an ACTIVE mapped trouble area of this type
// that carries the rule's evidence? `evidence: 'large_patch'` asks lawn-trouble-areas loadActiveLargePatch: a "fungus" area also stands
// for gray leaf spot, Pythium, dollar spot, fairy ring and rust, so only an area whose newest fungicide application names large patch
// counts, and an unknown disease is "no". A gate that is off or a visit with no property is "no" (the normal target stands). A read that
// fails is "no" too, with its code logged, UNLESS `strict` (a persisted or fail-closed reader: the previsit brief, the strict plan): then
// it THROWS, so nothing stores the normal target as if it were the answer. The property resolution and the read share ONE savepoint
// either way, so a query that fails inside either cannot leave a transaction (packet closeout) aborted for the queries after it.
// The day (YYYY-MM-DD, ET) a booked visit is scheduled for, the date large patch evidence is read as of; null when the visit has none
// (the reference tank sheet): then no application is excluded.
function visitDay(service) {
  const value = service?.scheduled_date;
  if (!value) return null;
  return etDateString(toServiceDate(value));
}

async function hasActiveTroubleArea(knex, service, type, { strict = false, evidence = null } = {}) {
  const areas = require('./lawn-trouble-areas');
  try {
    const found = await savepointRead(knex, async (k) => {
      const propertyId = await areas.propertyOf(k, service, { strict });
      if (!propertyId) return [];
      // The evidence is dated: the visit's scheduled day (ET), so a later application never decides an earlier visit.
      return evidence === 'large_patch' ? areas.loadActiveLargePatch(k, propertyId, { asOf: visitDay(service) }) : areas.loadActive(k, propertyId);
    });
    return found.some((area) => area.type === type);
  } catch (err) {
    logger.warn(`[plan] trouble areas unreadable for ${service?.id}: ${err?.code || err?.name || 'Error'}`);
    if (strict) throw err;
    return false;
  }
}

// The recipe text of a visit whose nitrogen target was cut, so what staff read (the line's `raw`, the visit's primary and notes) agrees
// with the amount the plan computes. Rewrites only the shapes the v13 recipe uses; a line or note the pattern does not match stays as
// written (the cut and the line note still apply: the amount and the note are never dependent on this text). `why` is the reason in
// the words the line states it with: 'active patch mapped' (GATE_LAWN_NOV_LARGE_PATCH_N) or 'reclaimed water, half' (GATE_LAWN_RECLAIMED_HALF_N).
const NITROGEN_LINE = /(\d+(?:\.\d+)?) lb per 1,000 sq ft \((\d+(?:\.\d+)?) lb N\)/;
const NITROGEN_NOTE = /\bN\s+rate:?\s*(\d+(?:\.\d+)?)\s*lb\s*N/i;
// The line suffix never says "large patch": classifyProtocolLine reads that phrase in a line as a disease-gated line (conditionFlag
// active_disease), and the cut line must classify exactly as the line it replaces. The notes say it in full (CUT_WHY_NOTE).
const CUT_WHY = Object.freeze({ fungus: 'active patch mapped', reclaimed: 'reclaimed water, half' });
const CUT_WHY_NOTE = Object.freeze({ ...CUT_WHY, fungus: 'active large patch mapped' });
// The reason a cut states in the visit text: the rule that set the smaller target, and the other one too when both applied.
const nitrogenCutWhy = (decision, words = CUT_WHY) => (decision.why === 'reclaimed' && decision.fungusApplied ? `${words.reclaimed}; ${words.fungus}` : words[decision.why]);
function nitrogenAdjustedVisit(visit, cut, why, noteWhy = why) {
  const primary = typeof visit.primary !== 'string' ? visit.primary : visit.primary.split('\n').map((line) => {
    const found = line.match(NITROGEN_LINE);
    if (!found || !(Number(found[2]) > cut)) return line;
    const rate = ((Number(found[1]) * cut) / Number(found[2])).toFixed(1);
    return `${line.replace(found[0], `${rate} lb per 1,000 sq ft (${cut} lb N)`)}, ${why}`;
  }).join('\n');
  const notes = typeof visit.notes !== 'string' ? visit.notes
    : visit.notes.replace(NITROGEN_NOTE, (whole, normal) => (Number(normal) > cut ? `N rate: ${cut} lb N (${noteWhy}; normal ${normal} lb N)` : whole));
  return { ...visit, primary, notes };
}

// The ONE decision whether the nitrogen target of a November visit at one property is cut, for every reader that states it (the plan,
// the tank sheet, the previsit brief): the reduced target (config/lawn-v13-nitrogen-targets.js), else null. Gate first: with
// GATE_LAWN_NOV_LARGE_PATCH_N off (or not a v13 program) nothing is read. Never raises a target; no matching month, a target already
// at or under the cut, or no active mapped area of the rule's type = null. `strict`: a failed area read throws (see hasActiveTroubleArea).
async function fungusNitrogenCut(knex, service, { targetN, monthNumber, v13Active, strict = false }) {
  if (!v13Active || !featureGates.lawnNovLargePatchNLive()) return null;
  const rule = V13_TROUBLE_N_TARGETS.find((entry) => entry.month === monthNumber);
  if (!rule || !(targetN > rule.targetNPer1000) || !(await hasActiveTroubleArea(knex, service, rule.troubleType, { strict, evidence: rule.evidence }))) return null;
  return rule.targetNPer1000;
}

// The catalog names of the combination pre-emergent plus fertilizer bags (LESCO Dimension 0.21% 18-0-10 ... Pre-Emergent Plus
// Fertilizer; Stonewall 15-0-15 ... Pre-Emergent Plus Fertilizer). The bag is sized by the pre-emergent rate, not by its nitrogen.
const PRE_EMERGENT_BAG = /\bPre-?Emergent Plus Fertilizer\b/i;
const isPreEmergentBag = (text) => PRE_EMERGENT_BAG.test(String(text ?? ''));

// What keeps a bag at its full rate on a reclaimed lawn (GATE_LAWN_RECLAIMED_HALF_N): a bag whose rate is set by something other than its
// nitrogen. 'pre_emergent': a pre-emergent plus fertilizer (October and the 9x April Dimension): halving N would halve the pre-emergent.
// 'potash': a visit that states a potassium target (December 10-0-22): reclaimed water adds N, not K, and the potash is for cold weather and
// large patch, so halving the bag would halve the K2O. null: an ordinary nitrogen bag, which is halved.
function keptBagReason({ primary, targetK }) {
  if (isPreEmergentBag(primary)) return 'pre_emergent';
  return targetK > 0 ? 'potash' : null;
}

// GATE_LAWN_RECLAIMED_HALF_N (owner 2026-10-05, 2026-10-23): half of the visit's nitrogen target at a property marked reclaimed
// (lawn-reclaimed-water.js), `{ cut }`; or `{ kept }` (a keptBagReason) when the visit's bag keeps its full rate and the line says so.
// null = not reclaimed, gate off, not a v13 plan, or a visit with no nitrogen target above zero (no read at all in the last three cases).
async function reclaimedNitrogenCut(knex, service, { targetN, v13Active, keep = null, strict = false }) {
  if (!v13Active || !featureGates.lawnReclaimedHalfNLive() || !(targetN > 0)) return null;
  if (!(await require('./lawn-reclaimed-water').isReclaimedService(knex, service, { strict }))) return null;
  return keep ? { kept: keep } : { cut: Number((targetN * RECLAIMED_N_FRACTION).toFixed(3)) };
}

// Both nitrogen rules as ONE decision (the plan, the tank sheet and the previsit brief all call this): `{ cut, why, reclaimed, keptFor }`
// or null. `cut` is the reduced target, the SMALLER of the rules that apply (never raised), else null; `why` names the rule that set
// it (a CUT_WHY key); `reclaimed` is 'half' when the reclaimed rule set the cut and 'kept' when it left a bag at full rate (`keptFor` says why).
async function nitrogenDecision(knex, service, { targetN, monthNumber, v13Active, keep = null, strict = false }) {
  const fungus = await fungusNitrogenCut(knex, service, { targetN, monthNumber, v13Active, strict });
  const water = await reclaimedNitrogenCut(knex, service, { targetN, v13Active, keep, strict });
  const half = water?.cut ?? null;
  if (fungus == null && half == null && !water) return null;
  const byWater = half != null && (fungus == null || half <= fungus);
  return {
    cut: byWater ? half : fungus,
    why: byWater ? 'reclaimed' : 'fungus',
    reclaimed: byWater ? 'half' : (water?.kept ? 'kept' : null),
    ...(water?.kept ? { keptFor: water.kept } : {}),
    // The fungus rule applied too (its target was the larger one, so the smaller reclaimed target won): its spreader instruction still stands.
    ...(fungus != null ? { fungusApplied: true } : {}),
  };
}

// GATE_LAWN_DEC_LARGE_PATCH_K: the ONE decision whether a visit's whole-lawn bag is swapped for a mapped trouble area
// (config/lawn-v13-trouble-product-swaps.js), for every reader that states it (the plan, the tank sheet, the previsit brief): the
// matching rule, else null. Gate first: with the gate off (or not a v13 program) nothing is read. The visit's own recipe line must be
// the rule's `from` product, so a recipe that moved on is never half-swapped. `strict`: a failed area read throws (see hasActiveTroubleArea).
async function troubleProductSwap(knex, service, { visit, monthNumber, v13Active, strict = false }) {
  if (!v13Active || !visit) return null;
  const rule = V13_TROUBLE_PRODUCT_SWAPS.find((entry) => entry.month === monthNumber);
  if (!rule || featureGates[rule.gate]?.() !== true) return null;
  const hasFrom = String(visit.primary || '').split('\n').some((line) => line.split(' \u2014 ')[0].trim() === rule.from);
  if (!hasFrom || !(await hasActiveTroubleArea(knex, service, rule.troubleType, { strict, evidence: rule.evidence }))) return null;
  return rule;
}

// The visit as a swap states it: the rule's line in place of the `from` line, and the nitrogen target the rule sets (the normal one
// stays visible in the note).
function swappedVisit(visit, rule) {
  const primary = String(visit.primary).split('\n').map((line) => (line.split(' \u2014 ')[0].trim() === rule.from ? rule.line : line)).join('\n');
  const notes = typeof visit.notes !== 'string' ? visit.notes
    : visit.notes.replace(NITROGEN_NOTE, (whole, normal) => `N rate: ${rule.targetN} lb N (active large patch mapped; normal ${normal} lb N)`);
  return { ...visit, primary, notes };
}

// GATE_LAWN_CHINCH_TETRINO_RATE: does the visit's property have a chinch trouble area that is ACTIVE or was resolved within the last
// 365 days? Same failure rules as hasActiveTroubleArea: off or no property is "no"; a failed read is "no" with its code logged, UNLESS
// `strict` (the previsit brief): then it THROWS. The property resolution and the read share ONE savepoint.
async function hasChinchMapped(knex, service, { strict = false } = {}) {
  const areas = require('./lawn-trouble-areas');
  try {
    return await savepointRead(knex, async (k) => {
      const propertyId = await areas.propertyOf(k, service, { strict });
      return propertyId ? areas.hasAreaOfType(k, propertyId, V13_CHINCH_TETRINO.troubleType, { withinDays: V13_CHINCH_TETRINO.resolvedWithinDays }) : false;
    });
  } catch (err) {
    logger.warn(`[plan] chinch areas unreadable for ${service?.id}: ${err?.code || err?.name || 'Error'}`);
    if (strict) throw err;
    return false;
  }
}

// Would a Tetrino application at the raised rate fit the label limits the v13 cap entry holds (lawn-v13-count-caps.js: 1.47 fl oz per
// 1,000 sq ft a year, 28 days between applications), over the lawn's recorded applications and this visit's date? The same limit reader the
// plan uses (application-limits checkLimits, the visit's own ledger rows left out). A hard block = the raise does not fit, and the visit
// plans the normal rate (which the plan then judges by the same reader: if even that is blocked, the line is held with the limit's
// message). The Tetrino product is found by the cap entry's identity; one that cannot be found leaves the raise to the plan's own limit
// read. `strict`: a failed read throws; otherwise it keeps the normal rate.
async function chinchRaiseFits(knex, service, { strict = false } = {}) {
  const { capIdMap } = require('../config/lawn-v13-count-caps');
  const limits = require('./application-limits');
  try {
    const ids = [...(await capIdMap(knex))].filter(([, entry]) => entry.name === V13_CHINCH_TETRINO.productName).map(([id]) => id);
    for (const id of ids) {
      const result = await savepointRead(knex, (k) => limits.checkLimits(service.customer_id, id, toServiceDate(service.scheduled_date), k, {
        proposed: { ratePer1000: V13_CHINCH_TETRINO.ratePer1000, unit: V13_CHINCH_TETRINO.rateUnit }, proposal: true,
        excludeScheduledServiceId: service.id, propertyId: service.property_id || null,
      }));
      if (result?.blocks?.length) return false;
    }
    return true;
  } catch (err) {
    logger.warn(`[plan] chinch Tetrino limits unreadable for ${service?.id}: ${err?.code || err?.name || 'Error'}`);
    if (strict) throw err;
    return false;
  }
}

// The ONE decision whether the May Tetrino rate at one property is raised, for every reader that states it (the plan, the tank sheet,
// the previsit brief): the raised rate (config/lawn-v13-chinch-rate.js), else null. Gate first: with GATE_LAWN_CHINCH_TETRINO_RATE off
// (or not a v13 program) nothing is read. Only May; `normalRate` is the visit's stated rate, and a rate already at or above the raised
// one is never touched. The raise needs a mapped chinch area AND room under the label limits (chinchRaiseFits). `strict`: a failed read
// throws (see hasChinchMapped).
async function chinchTetrinoRate(knex, service, { monthNumber, statedRate = V13_CHINCH_TETRINO.normalRate, v13Active, strict = false }) {
  if (!v13Active || !featureGates.lawnChinchTetrinoRateLive()) return null;
  if (monthNumber !== V13_CHINCH_TETRINO.month || !(Number(statedRate) < V13_CHINCH_TETRINO.ratePer1000)) return null;
  if (!(await hasChinchMapped(knex, service, { strict }))) return null;
  return (await chinchRaiseFits(knex, service, { strict })) ? V13_CHINCH_TETRINO.ratePer1000 : null;
}

const isChinchTetrinoRow = (row) => !!row && [row.productName, row.protocolProductName].some((name) => String(name || '').trim() === V13_CHINCH_TETRINO.productName);

// The staged rows with the May Tetrino row's stated rate raised to `rate`, so the plan amount, the tank sheet, the limit reader's
// proposed application and the completion defaults all read the same number. The same Map back for no raise (byte-identical), else a
// copy; only the Tetrino row changes, and only a row that states a lower rate.
function chinchRateRows(rows, rate) {
  if (rate == null || !(rows instanceof Map)) return rows;
  const raised = new Map(rows);
  for (const [key, row] of rows) {
    if (isChinchTetrinoRow(row) && !bermudaRemoval.isStepRow(row) && Number(row.ratePer1000) > 0 && Number(row.ratePer1000) < rate) raised.set(key, { ...row, ratePer1000: rate });
  }
  return raised;
}

// The recipe text of a May visit whose Tetrino rate was raised, so what staff read (the line's `raw`, the visit's primary) agrees with
// the amount the plan computes. Rewrites only the shape the v13 recipe uses; a line the pattern does not match stays as written (the
// raise and the line note still apply: the amount and the note never depend on this text).
const TETRINO_LINE = new RegExp(`^(${V13_CHINCH_TETRINO.productName} \u2014 )(\\d+(?:\\.\\d+)?)( fl oz per 1,000 sq ft)`);
function chinchAdjustedVisit(visit, rate) {
  if (typeof visit?.primary !== 'string') return visit;
  const primary = visit.primary.split('\n').map((line) => {
    const found = line.match(TETRINO_LINE);
    if (!found || !(Number(found[2]) < rate)) return line;
    return `${line.replace(TETRINO_LINE, `$1${rate}$3`)}, chinch bugs mapped`;
  }).join('\n');
  return { ...visit, primary };
}

// A visit's nutrient targets, for the plan and the tank sheet alike, so the plan amount, the mix sheet, the completion defaults, the
// yearly limit check and the Fast Complete planned amount all read the same number. Returns the visit the lines are parsed from (an
// adjusted copy when the nitrogen target was cut: nitrogenDecision, the May Tetrino rate was raised: chinchTetrinoRate, or the whole-lawn bag
// was swapped: troubleProductSwap; else the visit itself), its targets, `nitrogenCut` (the reduced N target, else null) and, only when they
// apply, `chinchRate` (the raised Tetrino rate), `productSwap` (the swap rule) and `reclaimedWater` ('half' when the reclaimed rule set the cut,
// 'kept' when a pre-emergent or potash bag was left at full rate, `keptFor`: 'pre_emergent' | 'potash'; `fungusAlso` when the fungus rule
// applied too). Without any of them the result is the same three keys as before, so a gate that is off changes nothing a reader can see.
// Call it BEFORE the visit's lines are parsed.
async function visitNutrientTargets(knex, service, { visit, month, v13Active, strict = false }) {
  const targets = parseVisitNutrientTargets(visit?.notes);
  const monthNumber = MONTH_ABBR.indexOf(month) + 1;
  // The swap is December's, the Tetrino raise May's: they never meet on one visit. A swapped bag carries no nitrogen (its target is 0), so
  // neither nitrogen rule applies to a swapped visit.
  const swap = await troubleProductSwap(knex, service, { visit, monthNumber, v13Active, strict });
  if (swap) {
    const swapped = swappedVisit(visit, swap);
    return { visit: swapped, targets: parseVisitNutrientTargets(swapped.notes), nitrogenCut: null, productSwap: swap };
  }
  const decision = visit ? await nitrogenDecision(knex, service, {
    targetN: targets.targetNPer1000, monthNumber, v13Active,
    keep: keptBagReason({ primary: visit.primary, targetK: targets.targetKPer1000 }), strict,
  }) : null;
  const chinchRate = visit ? await chinchTetrinoRate(knex, service, { monthNumber, v13Active, strict }) : null;
  if (!decision && chinchRate == null) return { visit, targets, nitrogenCut: null };
  const water = decision?.reclaimed ? {
    reclaimedWater: decision.reclaimed, ...(decision.keptFor ? { keptFor: decision.keptFor } : {}), ...(decision.fungusApplied ? { fungusAlso: true } : {}),
  } : {};
  const cut = decision?.cut ?? null;
  const nitrogenAdjusted = cut == null ? visit : nitrogenAdjustedVisit(visit, cut, nitrogenCutWhy(decision), nitrogenCutWhy(decision, CUT_WHY_NOTE));
  return {
    visit: chinchRate == null ? nitrogenAdjusted : chinchAdjustedVisit(nitrogenAdjusted, chinchRate),
    targets: cut == null ? targets : { ...targets, targetNPer1000: cut },
    nitrogenCut: cut,
    ...water,
    ...(chinchRate == null ? {} : { chinchRate }),
  };
}

// Is this catalog product the bag the swap puts down? By IDENTITY, not by its current name: the staged protocol row that carries the swap's
// trigger (or the swap's name) is linked to a catalog product id, and that is the product, so a catalog rename that keeps the old name as an
// alias (the matcher still resolves the line to it) does not lose the flag or the note. Falls back to the exact name when the rows are not
// at hand (the reference sheet).
function isSwapProduct(product, productSwap, v13Rows) {
  if (!productSwap || !product) return false;
  const row = v13Rows instanceof Map ? v13Rows.get(String(product.id)) : null;
  if (row) return swapOnlyRule(row)?.key === productSwap.key;
  return product.name === productSwap.to;
}

// The line note for the swapped bag (in the line's gateNotes, like the nitrogen cut's). [] for every other line.
function productSwapNotes(product, productSwap, v13Rows) {
  if (!isSwapProduct(product, productSwap, v13Rows)) return [];
  return [{ key: PRODUCT_SWAP_NOTE_KEY, severity: 'note', text: productSwap.note }];
}

// The line note for a nitrogen bag sized for the reduced target (in the line's gateNotes, the way the Fast Complete sheet and the
// plan panel already show a line's notes). [] for any line the cut did not size.
const FUNGUS_EXCLUSION = 'Close the spreader over the patch and 6 ft around it.';
function fungusNitrogenNotes(mix, nitrogenCut) {
  if (nitrogenCut == null || mix?.rateSource !== 'target_n_analysis' || mix.targetNPer1000 !== nitrogenCut) return [];
  return [{
    key: FUNGUS_NITROGEN_NOTE_KEY,
    severity: 'note',
    text: `Active large patch mapped: nitrogen reduced to ${nitrogenCut} lb N (${Number(mix.ratePer1000).toFixed(1)} lb per 1,000). ${FUNGUS_EXCLUSION}`,
  }];
}

// The reclaimed-water line notes (GATE_LAWN_RECLAIMED_HALF_N): "half nitrogen today" on the bag the halved target sized, and on a
// bag that keeps its rate (pre-emergent plus fertilizer, winter potash) the reason it was not halved. `found` is what visitNutrientTargets returned.
function reclaimedNitrogenNotes(mix, product, found) {
  if (found?.reclaimedWater === 'half') {
    if (mix?.rateSource !== 'target_n_analysis' || mix.targetNPer1000 !== found.nitrogenCut) return [];
    return [{ key: RECLAIMED_NITROGEN_NOTE_KEY, severity: 'note', text: `Reclaimed water: half nitrogen today (${found.nitrogenCut} lb N, ${Number(mix.ratePer1000).toFixed(1)} lb per 1,000).` }];
  }
  if (found?.reclaimedWater === 'kept') {
    const text = found.keptFor === 'potash' && Number(product?.analysis_k) > 0
      ? 'Reclaimed water: this bag carries the winter potash, so its full rate stays today.'
      : (found.keptFor === 'pre_emergent' && isPreEmergentBag(product?.name)
        ? 'Reclaimed water: this bag carries the pre-emergent, so its full rate stays today.' : null);
    if (text) return [{ key: RECLAIMED_NITROGEN_NOTE_KEY, severity: 'note', text }];
  }
  return [];
}

// Every nitrogen line note of one visit's decision, for one planned line: the reclaimed-water note and the fungus note. When the smaller
// reclaimed target set the amount and the fungus rule applied as well, the fungus note keeps only its spreader instruction (its own
// "reduced to" figures would contradict the amount the line now states).
function nitrogenCutNotes(mix, product, found) {
  const reclaimed = reclaimedNitrogenNotes(mix, product, found);
  if (found?.reclaimedWater !== 'half') return [...reclaimed, ...fungusNitrogenNotes(mix, found?.nitrogenCut ?? null)];
  return found.fungusAlso && reclaimed.length ? [...reclaimed, { key: FUNGUS_NITROGEN_NOTE_KEY, severity: 'note', text: `Active large patch mapped. ${FUNGUS_EXCLUSION}` }] : reclaimed;
}

// The line note for a Tetrino line planned at the raised chinch rate. [] for any line the raise did not size.
function chinchTetrinoNotes(row, mix, chinchRate) {
  if (chinchRate == null || !isChinchTetrinoRow(row) || mix?.rateSource !== 'protocol_rate' || mix.ratePer1000 !== chinchRate) return [];
  return [{ key: CHINCH_TETRINO_NOTE_KEY, severity: 'note', text: CHINCH_TETRINO_NOTE }];
}

function derivedNutrientRate(product, nutrient, targetPer1000) {
  const target = Number(targetPer1000);
  const enriched = enrichProductAnalysis(product);
  const analysis = Number(enriched?.[nutrient] || 0);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(analysis) || analysis <= 0) return null;
  return Number((target / (analysis / 100)).toFixed(4));
}

function productRatePer1000(product, options = {}) {
  // The matched staged v13 protocol row's own rate (GATE_LAWN_V13) comes first:
  // a catalog row can carry no default rate (Stonewall 4FL) yet the program
  // states one.
  if (Number(options.protocolRate?.rate) > 0) {
    return { rate: Number(options.protocolRate.rate), unit: options.protocolRate.unit || product?.rate_unit || null, source: 'protocol_rate' };
  }
  // A v13 nutrition row (rate unit lb_n / lb_k) states a nutrient target, not a
  // bag rate: derive from the visit's N / K target before any catalog default
  // (the catalog's 4.2 lb default is one bag rate, not every month's target).
  const deriveFirst = options.deriveNutrientFirst === true;
  const catalogRate = Number(product?.default_rate_per_1000 || 0);
  if (catalogRate > 0 && !(deriveFirst && (derivedNutrientRate(product, 'analysis_n', options.targetNPer1000) != null
    || derivedNutrientRate(product, 'analysis_k', options.targetKPer1000) != null))) {
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
  protocolRate = null,
  deriveNutrientFirst = false,
} = {}) {
  const factor = Math.max(0, Number(areaFactor ?? 1));
  const treatedUnits = (Number(lawnSqft || 0) * factor) / 1000;
  const rateInfo = productRatePer1000(product, { targetNPer1000, targetKPer1000, protocolRate, deriveNutrientFirst });
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

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stockStatusForProduct(product) {
  if (!product) return 'unmapped';
  if (product.active === false) return 'inactive';
  const onHand = numberOrNull(product.inventory_on_hand);
  if (onHand == null) return 'not_tracked';
  if (onHand <= 0) return 'depleted';
  const threshold = numberOrNull(product.low_stock_threshold);
  if (threshold != null && onHand <= threshold) return 'low';
  return 'ok';
}

function buildProductInventorySnapshot(product, mix = null) {
  if (!product) return null;
  const status = stockStatusForProduct(product);
  const onHand = numberOrNull(product.inventory_on_hand);
  const threshold = numberOrNull(product.low_stock_threshold);
  const unit = product.inventory_unit || null;
  const plannedAmount = numberOrNull(mix?.amount);
  const plannedAmountUnit = mix?.amountUnit || null;
  const plannedInventory = plannedAmount && plannedAmountUnit && unit
    ? describeInventoryConversion(plannedAmount, plannedAmountUnit, unit)
    : null;
  const plannedAmountInventoryUnit = plannedInventory?.amount ?? null;
  let warning = null;
  if (status === 'inactive') warning = 'Product is inactive in the catalog.';
  else if (status === 'not_tracked') warning = 'Inventory is not tracked for this product.';
  else if (status === 'depleted') warning = 'No inventory is currently on hand.';
  else if (status === 'low') warning = 'Inventory is at or below the low-stock threshold.';
  else if (plannedInventory && !plannedInventory.convertible) warning = `Cannot convert planned ${plannedAmountUnit} to inventory ${unit}.`;
  else if (plannedAmountInventoryUnit != null && onHand != null && plannedAmountInventoryUnit > onHand) warning = 'Planned amount exceeds current inventory on hand.';

  return {
    status,
    onHand,
    unit,
    lowStockThreshold: threshold,
    plannedAmount,
    plannedAmountUnit,
    plannedAmountInventoryUnit,
    conversionConfidence: plannedInventory?.confidence || (plannedAmount && plannedAmountUnit && unit ? 'needs_review' : null),
    conversionReason: plannedInventory?.reason || null,
    warning,
  };
}

function summarizeInventoryStatus(items = []) {
  const warnings = [];
  const blocks = [];
  for (const item of items) {
    if (!item.product) {
      warnings.push({
        code: 'inventory_product_unmatched',
        severity: 'warning',
        message: `Protocol line is not mapped to inventory: ${item.raw}`,
      });
      continue;
    }
    const inventory = item.product.inventory || buildProductInventorySnapshot(item.product, item.mix);
    if (!inventory) continue;
    const payload = {
      productId: item.product.id,
      productName: item.product.name,
      inventory,
    };
    if (inventory.status === 'inactive') {
      blocks.push({
        ...payload,
        code: 'inventory_product_inactive',
        severity: 'block',
        message: `${item.product.name} is inactive in products_catalog and cannot be planned.`,
      });
    } else if (inventory.status === 'depleted') {
      blocks.push({
        ...payload,
        code: 'inventory_depleted',
        severity: 'block',
        message: `${item.product.name} has no inventory on hand.`,
      });
    } else if (
      inventory.plannedAmountInventoryUnit != null
      && inventory.onHand != null
      && inventory.plannedAmountInventoryUnit > inventory.onHand
    ) {
      blocks.push({
        ...payload,
        code: 'inventory_insufficient_stock',
        severity: 'block',
        message: `${item.product.name} requires ${inventory.plannedAmountInventoryUnit} ${inventory.unit}, but only ${inventory.onHand} ${inventory.unit} is on hand.`,
      });
    } else if (inventory.status === 'low') {
      warnings.push({
        ...payload,
        code: 'inventory_low_stock',
        severity: 'warning',
        message: `${item.product.name} is at or below its low-stock threshold.`,
      });
    } else if (inventory.status === 'not_tracked') {
      warnings.push({
        ...payload,
        code: 'inventory_not_tracked',
        severity: 'warning',
        message: `${item.product.name} does not have inventory_on_hand set.`,
      });
    } else if (inventory.conversionReason) {
      warnings.push({
        ...payload,
        code: 'inventory_unit_conversion_review',
        severity: 'warning',
        message: `${item.product.name} planned unit cannot be converted to inventory unit (${inventory.plannedAmountUnit || 'unknown'} to ${inventory.unit || 'unknown'}).`,
      });
    }
  }
  return {
    status: blocks.length ? 'blocked' : warnings.length ? 'warning' : 'ok',
    blocks,
    warnings,
  };
}

// `cappedIds`: products an application limit holds (v13 capped lines): they get no amount
// and no place in the mix.
const MIX_ORDER = Object.freeze([
  'water_conditioner',
  'dry_wg_wdg_wp_df',
  'liquid_flowable_sc',
  'ec_ew',
  'solution_sl',
  'liquid_fertilizer',
  'adjuvant_last',
]);

function buildMixOrder(items, cappedIds = new Set()) {
  const order = MIX_ORDER;
  const rank = new Map(order.map((key, index) => [key, index]));
  return items
    .filter((item) => item.product && !cappedIds.has(String(item.product.id)))
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

// The rig is a convenience for tank-fill math, never a gate (owner ruling
// 2026-09-07: the "select a rig" block had produced zero assignments in
// prod and held every lawn visit). The assigned rig wins, a lone active rig
// is used, and among several the tank rigs decide: one tank rig, or every
// tank rig on the same carrier (both 110-gal rigs run the same gun and
// pace), resolves; tank rigs that disagree resolve nothing and the protocol
// window's default carrier applies downstream. Backpacks never decide a
// tank mix.
function resolveAmongActive(activeCalibrations) {
  const tanks = activeCalibrations.filter((row) => row.system_type === 'tank');
  if (!tanks.length) return null;
  const carriers = new Set(tanks.map((row) => Number(row.carrier_gal_per_1000 || 0)));
  if (carriers.size !== 1) return null;
  return tanks.find((row) => row.calibration_status === 'field_verified') || tanks[0];
}

function summarizeCalibration({ calibration, calibrations, assigned = false }) {
  const activeCalibrations = Array.isArray(calibrations)
    ? calibrations
    : (calibration ? [calibration] : []);
  const selected = calibration
    || (activeCalibrations.length === 1 ? activeCalibrations[0] : null)
    || (activeCalibrations.length > 1 ? resolveAmongActive(activeCalibrations) : null);
  // inferred = the engine picked the rig, the visit did not name it. Mix
  // math may use it; completion must not record it as equipment used
  // (Codex #4124 r2 P1).
  const inferred = !calibration && Boolean(selected);
  // unresolved = the visit names a rig whose calibration is no longer
  // active (deactivated / deleted since). Not a block — the protocol
  // carrier applies — but the closeout must clear the stale assignment
  // rather than persist it as equipment used (Codex #4124 r3 P1).
  const unresolved = Boolean(assigned) && !activeCalibrations.length;
  const warnings = [];
  if (unresolved) {
    warnings.push({
      code: 'assigned_rig_unresolved',
      severity: 'warning',
      message: 'The rig assigned to this visit has no active calibration; the protocol carrier is used and the assignment is not recorded as used.',
    });
  }
  if (selected && !selected.tank_capacity_gal) {
    warnings.push({
      code: 'missing_tank_capacity',
      severity: 'warning',
      message: 'Equipment tank capacity is missing; tank-fill checks are limited.',
    });
  }
  return { selected, inferred, unresolved, blocks: [], warnings };
}

// Quantities are mixed for the treated (visit) area; the annual budget is per
// 1,000 sq ft of the WHOLE property, so the projection divides by the saved
// property area when a visit-only override is smaller than it.
function calculateNutrients(items, lawnSqft, { propertyLawnSqft = null } = {}) {
  const treatedUnits = Number(lawnSqft || 0) / 1000;
  const budgetUnits = Math.max(treatedUnits, Number(propertyLawnSqft || 0) / 1000);
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
    nPer1000: budgetUnits ? Number((totals.n / budgetUnits).toFixed(3)) : 0,
    pPer1000: budgetUnits ? Number((totals.p / budgetUnits).toFixed(3)) : 0,
    kPer1000: budgetUnits ? Number((totals.k / budgetUnits).toFixed(3)) : 0,
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

// The applications a year of a lawn visit's series, from the recurrence the
// scheduler places its visits by (`recurring_pattern`, plus `recurring_interval_days`
// for a 'custom' gap; every_6_weeks is the 42-day gap). null for any other recurrence.
// lawn_rounds_9 (nine fixed rounds a year) is the same 9x plan as every_6_weeks.
const RECURRENCE_VISITS = { every_6_weeks: 9, [LAWN_ROUNDS_9]: 9, monthly: 12, monthly_nth_weekday: 12, bimonthly: 6 };
function lawnVisitsFromRecurrence(pattern, intervalDays) {
  const key = String(pattern || '').toLowerCase();
  if (RECURRENCE_VISITS[key]) return RECURRENCE_VISITS[key];
  const days = Number(intervalDays);
  if (key !== 'custom' || !(days > 0)) return null;
  return [[38, 46, 9], [28, 33, 12], [56, 65, 6]].find(([min, max]) => days >= min && days <= max)?.[2] ?? null;
}

// The applications a year (6, 9 or 12) of the lawn plan this visit belongs to, or
// null when no source states one. Ranked by authority: the catalog service the
// visit is booked under (its key and name are the plan's own identity; the
// codebase already trusts it over stale labels), then the series' recurrence (what
// actually dates the visits, and what a generic "Lawn Care" booking carries), then
// the visit's own service name. All text goes through the one resolver the plan
// sync uses; its catch-all ("Lawn Care Program", quarterly) is not a stated plan.
// `service` needs service_id, recurring_pattern, recurring_interval_days, service_type.
async function lawnVisitsPerYear(knex, service) {
  const { resolveLawnCareRecurringPlan } = require('./self-booking-plan-sync');
  const stated = (text) => {
    const plan = text ? resolveLawnCareRecurringPlan(text) : null;
    return plan && plan.planKey !== 'lawn_care' && Number(plan.visitsPerYear) > 0 ? Number(plan.visitsPerYear) : null;
  };
  const catalog = service.service_id
    ? await savepointRead(knex, (k) => k('services').where({ id: service.service_id }).first('service_key', 'name')).catch(() => null)
    : null;
  return stated(catalog && `${catalog.service_key} ${catalog.name}`)
    ?? lawnVisitsFromRecurrence(service.recurring_pattern, service.recurring_interval_days)
    ?? stated(service.service_type);
}

// What a visit's lawn record says about its grass, read once: whether a profile records a grass or
// track, whether anything does (the legacy free text counts when no profile is recorded), and
// whether the record names bahia (the grass type, the track key, or that legacy text), which GATE_LAWN_V13
// has no program for. Bahia in ANY recorded field wins over another field's track.
function recordedGrassFacts(profile, legacyGrass) {
  const profileRecorded = [profile?.track_key, profile?.grass_type].some((value) => String(value || '').trim());
  return {
    profileRecorded,
    recorded: profileRecorded || String(legacyGrass || '').trim(),
    noProgram: lawnV13NoBahiaProgram() && recordedGrassNamesBahia(profile, legacyGrass),
  };
}

function selectProtocolVisit(profile, serviceDate, legacyGrass = null, { month: assignedMonth, requireKnownGrass } = {}) {
  const { profileRecorded, recorded, noProgram } = recordedGrassFacts(profile, legacyGrass);
  const month = MONTH_ABBR[(assignedMonth || etParts(serviceDate).month) - 1];
  // GATE_LAWN_V13: any recorded field that says bahia ends the lookup here, before another
  // recorded value (a conflicting track key or grass type) can pick a track. Only this
  // result carries the flag; every other keeps its old shape.
  if (noProgram) return { trackKey: null, track: null, month, visit: null, v13NoProgram: true };
  const trackKey = resolveTrackKey(profile?.track_key, normalizeGrassType(profile?.grass_type))
    || (!profileRecorded && resolveTrackKey(null, normalizeGrassType(legacyGrass)))
    // GATE_LAWN_V13: a recorded grass with no track of its own (mixed, unknown,
    // free text) runs the one v13 program instead of blocking the visit (bahia never
    // reaches this: it returned above).
    || (recorded ? lawnV13AnyGrassTrack() : null)
    || (recorded || requireKnownGrass ? null : 'st_augustine');
  const track = trackKey ? lawnProtocols()?.[trackKey] : null;
  const visit = track?.visits?.find((v) => v.month === month) || null;
  return { trackKey, track, month, visit };
}

// The ordinance jurisdictions (county + city) one visit is judged under —
// shared by the plan and the completion path (actualProductBlackoutBlocks).
// The STAMPED visit address outranks the turf-profile municipality — the 1:1
// profile describes the primary home, so a visit stamped at a rental in
// another city must evaluate the treated property's ordinances. Customer
// city is the last resort. When the stamped city DIVERGES from the profile's
// context, the profile county is dropped too — the query ORs county and city
// jurisdictions, so keeping the primary home's county would bolt its blackout
// onto the rental's rules.
// A profile with no county (all active profiles today) falls back to the
// county of the ADDRESS being treated — stamped zip+city when a visit is
// stamped, else the customer's own zip+city — through the canonical
// address-county resolver (the table irrigation-restrictions uses). A
// straddling or unknown ZIP resolves to no county (fail closed, no guessing).
function resolveOrdinanceJurisdiction(profile, cities = {}) {
  const stamped = String(cities.stampedCity || '').trim();
  const stampedZip = String(cities.stampedZip || '').trim();
  const profileCity = String(profile?.municipality || '').trim();
  const customerCity = String(cities.customerCity || '').trim();
  const customerZip = String(cities.customerZip || '').trim();
  // The county belongs to the PROFILE, so divergence is measured against the
  // profile's own city context (its municipality, else the customer city as
  // its implied context): a stamped visit in a different city drops the
  // profile county even when the CUSTOMER's city happens to match the stamp
  // (stale-profile case). No known reference city -> keep the county.
  const countyReferenceCity = profileCity || customerCity;
  const stampedDiverges = !!stamped && !!countyReferenceCity &&
    countyReferenceCity.toLowerCase() !== stamped.toLowerCase();
  const profileCounty = stampedDiverges ? '' : String(profile?.county || '').trim();
  const addressCounty = (stamped || stampedZip)
    ? resolveAddressCounty({ zip: stampedZip, city: stamped })
    : resolveAddressCounty({ zip: customerZip, city: customerCity });
  return {
    county: profileCounty || addressCounty || '',
    city: stamped || profileCity || customerCity,
  };
}

async function getApplicableOrdinances(knex, profile, cities = {}) {
  if (!profile) return [];
  const { county, city } = resolveOrdinanceJurisdiction(profile, cities);
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

async function getLatestAssessment(knex, customerId, { strict = false } = {}) {
  const row = await savepointRead(knex, (k) => k('lawn_assessments')
    .where({ customer_id: customerId })
    .orderBy('service_date', 'desc')
    .orderBy('created_at', 'desc')
    .first())
    .catch((err) => { if (strict) throw err; return null; });
  if (!row) return null;
  return {
    ...row,
    stress_flags: parseMaybeJson(row.stress_flags, row.stress_flags || null),
    adjusted_scores: parseMaybeJson(row.adjusted_scores, row.adjusted_scores || null),
  };
}

// strict: a failed calibration read throws instead of reading as "no rig"
// (the job card shows the check as unavailable; the Lawn plan keeps its
// empty-list default).
async function getActiveCalibrations(knex, filters = {}, { strict = false } = {}) {
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

  return savepointRead(knex, () => query).catch((err) => { if (strict) throw err; return []; });
}

// strict: a failed catalog read throws instead of reading as an empty
// catalog (the job card treats that plan as unavailable; the Lawn plan and
// closeout keep the lenient default).
async function getProducts(knex, { strict = false } = {}) {
  const products = await savepointRead(knex, (k) => k('products_catalog')
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
      'label_verified_at', 'application_method', 'formulation',
      'active', 'inventory_on_hand', 'inventory_unit', 'low_stock_threshold',
    ))
    .catch((err) => { if (strict) throw err; return []; });

  if (!products.length) return products;

  const productIds = products.map((product) => product.id).filter(Boolean);
  const aliases = productIds.length
    ? await savepointRead(knex, (k) => k('product_aliases')
      .whereIn('product_id', productIds)
      .select('product_id', 'alias_name'))
      // strict: aliases are how de-branded protocol lines find their
      // product — a failed read would silently drop them, so it throws too.
      .catch((err) => { if (strict) throw err; return []; })
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

async function getAppointmentSubstitutions(knex, serviceId, products, { strict = false } = {}) {
  if (!(await knex.schema.hasTable('lawn_protocol_product_substitutions'))) return new Map();
  const rows = await savepointRead(knex, (k) => k('lawn_protocol_product_substitutions as lpps')
    .leftJoin('products_catalog as op', 'lpps.original_product_id', 'op.id')
    .leftJoin('products_catalog as sp', 'lpps.substitute_product_id', 'sp.id')
    .where('lpps.scheduled_service_id', serviceId)
    .where('lpps.active', true)
    .select(
      'lpps.*',
      'op.name as original_product_name',
      'sp.name as substitute_product_name',
    ))
    .catch((err) => { if (strict) throw err; return []; });
  const productById = new Map((products || []).map((product) => [String(product.id), product]));
  const map = new Map();
  for (const row of rows) {
    const substitute = productById.get(String(row.substitute_product_id));
    if (!substitute) continue;
    map.set(String(row.original_product_id), {
      ...row,
      substitute,
    });
  }
  return map;
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

// strict: a failed ledger / service-product read throws instead of reading
// as "nothing applied this year" (an annual-N block must not vanish).
async function calculateNutrientLedger(knex, customerId, products, lawnSqft, serviceDate = new Date(), { strict = false } = {}) {
  const year = etParts(serviceDate).year;
  const ledgerRows = await savepointRead(knex, (k) => k('property_nutrient_ledger')
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
      'lawn_sqft',
    )
    .orderBy('application_date', 'asc'))
    .catch((err) => { if (strict) throw err; return null; });

  const ledgerSummary = Array.isArray(ledgerRows) && ledgerRows.length
    ? summarizeLedgerRows(ledgerRows, year, { lawnSqft })
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

  const rows = await savepointRead(knex, () => serviceProductQuery).catch((err) => { if (strict) throw err; return []; });
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

function summarizeTurfProfileCompleteness(profile) {
  const required = [
    { key: 'grass_type', label: 'Turf species' },
    { key: 'cultivar', label: 'Cultivar' },
    { key: 'ordinance_zone', label: 'Ordinance zone', fallbackKeys: ['municipality', 'county'] },
    { key: 'lawn_sqft', label: 'Treatable turf sq ft' },
    { key: 'irrigation_status', label: 'Irrigation status', fallbackKeys: ['irrigation_type'] },
    { key: 'soil_test_date', label: 'Soil test date' },
    // soil_k_ppm is deliberately NOT required: the owner retired its capture
    // from the completion sheet (2026-08-07) and no client surface submits
    // it, so requiring it would leave a turf_profile_incomplete warning
    // nobody can clear (codex P2 on #3262). The column stays — a value, if
    // one ever lands via API, still counts as profile data elsewhere.
  ];

  if (!profile) {
    return {
      status: 'blocked',
      missing: required.map(({ key, label }) => ({ key, label })),
      complete: [],
      required,
    };
  }

  const missing = [];
  const complete = [];
  for (const field of required) {
    const keys = [field.key, ...(field.fallbackKeys || [])];
    const hasValue = keys.some((key) => {
      const value = profile[key];
      return value !== null && value !== undefined && value !== '';
    });
    if (hasValue) complete.push({ key: field.key, label: field.label });
    else missing.push({ key: field.key, label: field.label });
  }

  return {
    status: missing.length ? 'incomplete' : 'complete',
    missing,
    complete,
    required,
  };
}

// customers.billing_mode arrived with migration 20260709000010; a database
// predating it must still plan (and complete) a visit, so the column is
// selected only when it exists (Codex #4365 r3 P2). Callers that already
// probed (completeScheduledService, the inventory forecast batch) pass
// their result so one probe serves the whole unit of work; otherwise probe
// here. Only a SUCCESSFUL probe answering false is a legacy schema. A probe
// that cannot run or fails is unknown and fails the plan closed (Codex
// #4365 r4 P2): reading it as absent would drop an explicit per_visit /
// one_time lane and let a lingering tier restore governed defaults.
async function customerBillingModeColumnExists(knex) {
  if (typeof knex?.schema?.hasColumn !== 'function') {
    throw new Error('customers.billing_mode probe unavailable: the database handle has no schema API');
  }
  try {
    return (await knex.schema.hasColumn('customers', 'billing_mode')) === true;
  } catch (err) {
    const wrapped = new Error(`customers.billing_mode probe failed: ${err?.message || err}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

// ── Plan item projection (buildPlanForService) ──────────────────────────────
// The approved substitute carries the visit's own rate over its catalog default.
function substitutedProduct(substitution) {
  return {
    ...substitution.substitute,
    default_rate_per_1000: substitution.rate_per_1000 != null
      ? substitution.rate_per_1000
      : substitution.substitute.default_rate_per_1000,
    rate_unit: substitution.rate_unit || substitution.substitute.rate_unit,
  };
}

// The protocol line's own fields, as the panel shows them.
function planLineFields(item) {
  return {
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
    ...(item.bermudaStep ? { bermudaStep: true } : {}),
    // The spring pre-emergent catch-up line of a new rounds customer's first visit: named for every reader.
    ...roundsCatchUp.catchUpLineFields(item),
  };
}

// The ONE decision about what a v13 line may compute, for the plan and the tank
// sheet alike (gate on, v13 protocol resolved). A line keeps its protocol product
// (a saved substitution is never applied) and reads its own staged row:
//   unavailable: no row is linked to the matched catalog product, so nothing is sized
//                (never the catalog default);
//   held:        a product the city bans for this visit's window (North Port Nutra-TECH, June to
//                September): not selected, no amount;
//   capped:      a hard application limit (annual cap, interval, blackout) is reached;
//   spot:        a spot or label-rate row, no quantity (enter the area and amount used);
//   calculate:   a whole-lawn row that states a rate or a nutrient target.
function v13LineState(product, v13Rows, cappedIds = new Set(), gateContext = {}, item = {}) {
  const row = bermudaRemoval.rowFor(v13Rows, product.id, item.bermudaStep === true);
  if (!row) return { row, state: 'unavailable' };
  if (v13NorthPortHold(row, gateContext.municipality)) return { row, state: 'held' };
  if (gateContext.holdRoundsNitrogen === true && holdsRoundsNitrogen(item, product)) return { row, state: 'held', roundsNitrogen: true };
  if (cappedIds.has(String(product.id))) return { row, state: 'capped' };
  return { row, state: v13RowCalculates(row) ? 'calculate' : 'spot' };
}

const NORTH_PORT_HOLD_REASON = 'north_port_product_window';
const CITY_HOLD_KIND = 'city_hold';

// A staged v13 row the city bans for the visit's window (gates.northPortProductWindow) in North
// Port. The product has no N or P analysis, so the ordinance check cannot see it: the plan holds
// the row back itself, and the completion flags a recording of it like the nitrogen ban.
function v13NorthPortHold(row, municipality) {
  return row?.gates?.northPortProductWindow === true && isNorthPort(municipality);
}

// 9x rounds, round 3 (Mar 15 to Apr 23) is the 24-0-11 feeding. North Port bans nitrogen and phosphorus from Apr 1 to Sep 30, so a
// round-3 visit dated Apr 1 or later holds the nitrogen bag (the visit's base product that carries N). The ordinance check at completion
// already blocks N by the real date; this keeps the plan from offering it. `roundsNitrogenHold` is the one test, for every reader.
const NORTH_PORT_ROUNDS_N_REASON = 'north_port_rounds_nitrogen';
const holdsRoundsNitrogen = (item, product = item?.product) => item?.role === 'base' && Number(product?.analysis_n) > 0;
function roundsNitrogenHold(routing, municipality) {
  return !!routing && routing.round === 3 && northPortNpBanMonth(routing.realMonth) && isNorthPort(municipality);
}

// The rounds routing of a booked visit: its round's step month and variant, and the month its weed and spot rows come from (the real
// date's, with the St. Augustine green-up exception). null for every visit that is not on a lawn_rounds_9 series. `service` needs
// recurring_pattern and scheduled_date; `trackKey` is the visit's grass track.
function roundRouting(service, trackKey = null) {
  const roundStep = roundStepForPlan(service);
  if (!roundStep) return null;
  const realMonth = etParts(toServiceDate(service.scheduled_date)).month;
  return { ...roundStep, realMonth, spotMonth: roundSpotMonth({ round: roundStep.round, realMonth, grassTrack: trackKey }) };
}

// The matched items a North Port visit may not apply: not selected, so no default, no amount. `nitrogen` (a rounds round-3 visit in
// North Port from Apr 1) also holds the visit's nitrogen bag.
function holdNorthPortProducts(items, v13Rows, municipality, { nitrogen = false } = {}) {
  return items.map((item) => {
    if (item.product && v13NorthPortHold(bermudaRemoval.rowFor(v13Rows, item.product.id, item.bermudaStep === true), municipality)) {
      return { ...item, selected: false, selectionReason: NORTH_PORT_HOLD_REASON };
    }
    return nitrogen && item.product && holdsRoundsNitrogen(item) ? { ...item, selected: false, selectionReason: NORTH_PORT_ROUNDS_N_REASON } : item;
  });
}

function v13HoldWarnings(planItems) {
  return planItems.filter((item) => item.product && [NORTH_PORT_HOLD_REASON, NORTH_PORT_ROUNDS_N_REASON].includes(item.selectionReason)).map((item) => (item.selectionReason === NORTH_PORT_ROUNDS_N_REASON ? {
    code: 'lawn_rounds_north_port_nitrogen', severity: 'warning', productId: item.product.id, productName: item.product.name,
    message: `${item.product.name}: North Port bans nitrogen and phosphorus from April 1 to September 30. The plan holds this round-3 feeding back; do not apply it at this visit.`,
  } : {
    code: 'lawn_v13_north_port_product_window', severity: 'warning', productId: item.product.id, productName: item.product.name,
    message: `${item.product.name}: North Port holds this product from June to September until the city confirms. The plan holds it back; do not apply it at this visit.`,
  }));
}

const V13_ROUNDS_N_HELD = 'North Port bans nitrogen and phosphorus from April 1 to September 30, so this round-3 feeding is not selected and no amount is planned.';
const V13_UNAVAILABLE = {
  held: 'North Port holds this product in the summer until the city confirms, so it is not selected and no amount is planned.',
  unavailable: 'No protocol row is linked to this product, so no amount is planned. Enter the actual work.',
  capped: 'An application limit is reached for this product, so no amount is planned.',
};

// The application a v13 line plans, for the limit reader: the row's stated rate, else (a lb_n /
// lb_k nutrition row, the 9x April Dimension step) the rate its nutrient target derives, the
// amount the plan itself will quote. null for a row with neither, which counts nothing.
function v13ProposedApplication(product, row, targets) {
  if (!row) return null;
  if (Number(row.ratePer1000) > 0) return { ratePer1000: Number(row.ratePer1000), unit: row.rateUnit };
  if (!/^lb_[nk]/i.test(String(row.rateUnit || ''))) return null;
  const derived = productRatePer1000(product, { ...targets, ...v13RateOptions(row) });
  const fromTarget = derived.source === 'target_n_analysis' || derived.source === 'target_k_analysis';
  return fromTarget && derived.rate > 0 ? { ratePer1000: derived.rate, unit: derived.unit } : null;
}

// product_limits (annual caps, minimum intervals, blackouts) through the one
// application-limits reader the completion path uses, over the customer's own
// application history, for each SELECTED product: the hard blocks per product id
// (`capped`: no amount) and the warning-level findings (`warnings`: a minimum
// interval, an approaching cap; the dose stays). A failed read fails closed
// (strict throws; otherwise the product reads as capped). The line's own staged
// rate (a lb_n row: the rate its visit's nutrient target derives) is the application
// being planned, so a yearly cap shared across formulations (prodiamine, dithiopyr)
// counts it with the season's earlier applications; the
// visit's own earlier ledger rows are left out so a re-plan never counts it twice.
// The Ronstar rule is for residential lawns: the visit's linked property type, else the customer's (the plan's
// own row carries it; the tank sheet's slimmer row does not, so it is read, and only for a product that matches).
async function lawnProhibitedForVisit(knex, service, product) {
  if (!lawnProhibitedProductBlock(product, {})) return null;
  const propertyType = await treatedPropertyType(knex, { propertyId: service.property_id, customerId: service.customer_id, fallback: service.property_type });
  return lawnProhibitedProductBlock(product, { propertyType });
}

// `place` (GATE_LAWN_TROUBLE_AREAS, lawn-trouble-areas.js) judges the SPOT application of each product at one place of the
// lawn (application-limits checkLimits opts.place); absent, every product is judged on the whole lawn, as always.
async function v13Limits(knex, service, serviceDate, items, { strict = false, rows = new Map(), targets = {}, place = null } = {}) {
  const limits = require('./application-limits');
  const capped = new Map();
  const warnings = [];
  const checked = new Set();
  for (const item of items.filter((candidate) => candidate.selected && candidate.product)) {
    const id = String(item.product.id);
    if (checked.has(id)) continue;
    checked.add(id);
    // Not for home lawns (oxadiazon / Ronstar): a hard block like any other limit, so no amount is planned.
    const prohibited = await lawnProhibitedForVisit(knex, service, item.product);
    if (prohibited) {
      capped.set(id, [{ ...prohibited }]);
      continue;
    }
    // Every product here is selected, i.e. about to be applied: a proposal. A product with no row in this visit's window (Arena in
    // October, a search-added product) has no stated dose here; the limit reader then counts the product's staged v13 dose.
    const row = bermudaRemoval.rowFor(rows, id, item.bermudaStep === true);
    const proposed = v13ProposedApplication(item.product, row, targets);
    // A step line is judged for the property the step was proven for (the visit's own, or a
    // one-property customer's sole one), the same as the completion check.
    // GATE_LAWN_TROUBLE_AREAS: a per-place read judges the property the places work on (the visit's link, else the resolved one).
    const propertyId = item.bermudaStep
      ? await bermudaRemoval.effectivePropertyId(knex, service)
      : ((place && await require('./lawn-trouble-areas').propertyOf(knex, service)) || service.property_id || null);
    const result = await savepointRead(knex, (k) => limits.checkLimits(service.customer_id, item.product.id, serviceDate, k, { proposed, proposal: true, excludeScheduledServiceId: service.id, propertyId, ...(place ? { place } : {}), ...(item.bermudaStep ? { program: 'bermuda_removal' } : {}) }))
      .catch((err) => {
        if (strict) throw err;
        return { blocks: [{ message: `${item.product.name}: application limits could not be read.` }], warnings: [] };
      });
    // GATE_LAWN_TROUBLE_AREAS: a place's read keeps only what /complete would refuse there (and a read that failed); a lawn-wide limit (the
    // shared active-ingredient cap) is advisory after the fact, so it closes no place (lawn-trouble-areas blocksAtPlace).
    const blocks = place ? require('./lawn-trouble-areas').blocksAtPlace(result.blocks) : result.blocks;
    if (blocks.length) capped.set(id, blocks.map((block) => ({ ...block, productName: item.product.name })));
    warnings.push(...result.warnings.map((warning) => ({
      code: 'lawn_v13_limit_warning', severity: 'warning', limitType: warning.type || null, productId: id, productName: item.product.name, message: warning.message,
    })));
  }
  return { capped, warnings };
}

// The spring pre-emergent catch-up (lawn-rounds-catchup.js), settled once the limits were read: a line that cannot be applied (a yearly cap
// reached, an unlinked or inactive product, a v13 protocol that is not resolved) leaves with a WARNING and never blocks the plan or the
// visit's own lines. The dropped line also leaves the limit read (its cap block and warnings) and the protocol's products (the March row that
// came in with it), so the output and the completion read one list. Returns { items, protocol, warnings }; no catch-up line: the inputs.
function settleCatchUpLines({ items, v13Active, v13Rows, v13Limit, structuredProtocol }) {
  if (!items.some(roundsCatchUp.isCatchUpItem)) return { items, protocol: structuredProtocol, warnings: [] };
  const settled = v13Active
    ? roundsCatchUp.settleCatchUp(items, { rowOf: (item) => bermudaRemoval.rowFor(v13Rows, item.product.id, false), calculates: v13RowCalculates, cappedIds: new Set(v13Limit.capped.keys()) })
    : { items: items.filter((item) => !roundsCatchUp.isCatchUpItem(item)), warnings: [], dropped: items.filter(roundsCatchUp.isCatchUpItem) };
  const droppedIds = new Set(settled.dropped.map((item) => String(item.product?.id)));
  for (const id of droppedIds) v13Limit.capped.delete(id);
  v13Limit.warnings = v13Limit.warnings.filter((warning) => !droppedIds.has(String(warning.productId)));
  const products = (structuredProtocol?.products || []).filter((row) => !(droppedIds.has(String(row.productId)) && row.role === 'pre_emergent'));
  return { items: settled.items, protocol: droppedIds.size && structuredProtocol ? { ...structuredProtocol, products } : structuredProtocol, warnings: settled.warnings };
}

// The lawn-visit step for a recipe visit and the visit's plan: `override` (applications a
// year, when the caller states it) else the plan the booked visit resolves to. One path
// for the plan, the tank sheet and everything else that reads a cadence-dependent step.
//
// A visit on a lawn_rounds_9 series takes the step of its ROUND instead (roundRouting): the recipe visit passed in is already that
// round's step, and this applies its rounds-only variant (round 2: April's 9x bag; round 3: February's 1.0 lb N bag) and, when the
// track is given, swaps in the weed and spot lines of the real date's step (the spot rules follow the date the visit is on). It never
// reads the plan count: the pattern says 9. Every other visit goes through the cadence path below, unchanged.
async function visitForPlan(knex, recipeVisit, service, override = null, { track = null, trackKey = null } = {}) {
  const routing = roundRouting(service, trackKey);
  if (routing) {
    const stepped = visitForRound(recipeVisit, routing);
    const spotRecipe = track && routing.spotMonth !== routing.month ? track.visits?.find((v) => v.month === MONTH_ABBR[routing.spotMonth - 1]) : null;
    return { visit: visitWithSpotLines(stepped.visit, spotRecipe), branch: stepped.branch, unknownCadence: null, warnings: [] };
  }
  const stated = Number(override) > 0 ? Number(override) : null;
  const perYear = stated ?? (recipeVisit?.cadenceVariants && service ? await lawnVisitsPerYear(knex, service) : null);
  const found = visitForCadence(recipeVisit, perYear);
  return { ...found, warnings: found.unknownCadence ? [unknownCadenceWarning(found.unknownCadence)] : [] };
}

// Is this booked visit on the v13 protocol, decided the way the planner decides it: the same getProtocolWindowContext call with the
// visit's own pin (protocolKey is what makes it a pin there), then the resolved version. Returns `{ onV13, windowMonth }`: a pinned
// visit whose protocol is another version, or cannot be resolved or read, is not on v13 (the plan blocks it with
// lawn_v13_protocol_missing); `windowMonth` is the month (1-12) of the window the visit is pinned to, which is the month the plan
// reads the recipe for, and null for an unpinned visit (it takes the current v13 protocol for the month asked, as the tank sheet's
// staged rows already do). For the tank sheet, which has no plan to ask.
async function visitOnV13Protocol(knex, visit, { trackKey }) {
  if (!visit?.lawn_protocol_key) return { onV13: true, windowMonth: null };
  const context = await getProtocolWindowContext(knex, {
    serviceDate: toServiceDate(visit.scheduled_date), grassTrack: trackKey, region: 'swfl', planning: true,
    windowKey: visit.lawn_protocol_window_key, protocolKey: visit.lawn_protocol_key, protocolVersion: visit.lawn_protocol_version,
  }).catch(() => null);
  const summary = summarizeProtocolContext(context);
  const windowMonth = Number(summary?.window?.month) || null;
  // A pinned visit whose window month is unknown cannot be matched to a requested month, so it is not cut (fail closed).
  return { onV13: summary?.version === LAWN_V13_VERSION && windowMonth != null, windowMonth };
}

// The tank sheet's v13 flag for the nitrogen cut: gate first (no protocol lookup at all with the cut off), then the planner's own
// version and window for the visit. The sheet shows the recipe of the REQUESTED month; the plan reads the month of the window the
// visit is pinned to (under the completion defaults, as selectProtocolVisit does) or else the month of the service date, so the cut
// applies only to a visit that is on v13 and either unpinned or asked for in the month the plan reads.
// Is any rule that rewrites a visit's step from the lawn's own data live (the November cut, the reclaimed-water half, the May Tetrino raise,
// the December swap)? With none live nothing is read, so a reader that projects a visit through visitNutrientTargets can skip it with no query
// at all. v13 eligibility is decided here and nowhere else, independently of WHICH rule asks: each rule checks its own gate inside
// visitNutrientTargets, so the answer never depends on another rule's gate.
function visitProjectionLive() {
  return featureGates.lawnV13Live?.() === true && !!(featureGates.lawnNovLargePatchNLive() || featureGates.lawnReclaimedHalfNLive?.()
    || featureGates.lawnChinchTetrinoRateLive() || featureGates.lawnDecLargePatchKLive?.());
}

async function sheetReadsPlansStep(knex, visit, { trackKey, month }) {
  if (!visitProjectionLive()) return false;
  const { onV13, windowMonth } = await visitOnV13Protocol(knex, visit, { trackKey });
  if (!onV13) return false;
  if (windowMonth == null) return true;
  const planMonth = lawnCompletionDefaultsEnabled() ? windowMonth : (roundStepForPlan(visit)?.month ?? etParts(toServiceDate(visit.scheduled_date)).month);
  return planMonth === MONTH_ABBR.indexOf(month) + 1;
}

// The booked visit a reader is opened from, by id (null for no id, a malformed id or an
// unknown visit): the columns the cadence and the application limits read.
// scope narrows the read to what the caller may see (a technician's current or recent
// assignments); a visit outside it reads as no visit, so nothing of it is used.
async function loadVisitForPlan(knex, id, scope = (q) => q) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''))) return null;
  return (await scope(knex('scheduled_services').where({ 'scheduled_services.id': id }))
    .first('id', 'customer_id', 'property_id', 'scheduled_date', 'service_id', 'service_type', 'recurring_pattern', 'recurring_interval_days', 'lawn_protocol_version', 'lawn_protocol_key', 'lawn_protocol_window_key',
      // The stamped address: the property resolver's evidence for a visit with no property_id (the November nitrogen rule).
      'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip')) || null;
}

// The city a booked visit is judged under, resolved the way the plan resolves it (the stamped visit
// address, then the turf profile's municipality, then the customer's city); null for no visit or no
// city on file. The tank sheet reads it for the city holds.
async function loadVisitCity(knex, visit) {
  if (!visit?.id) return null;
  const stamped = await knex('scheduled_services').where({ id: visit.id }).first('service_address_city');
  const profile = visit.customer_id ? await knex('customer_turf_profiles').where({ customer_id: visit.customer_id, active: true }).first('municipality') : null;
  const customer = visit.customer_id ? await knex('customers').where({ id: visit.customer_id }).first('city') : null;
  return String(stamped?.service_address_city || profile?.municipality || customer?.city || '').trim() || null;
}

// A reader with no resolved city (the reference tab, or a visit with no city on file) cannot tell
// North Port from anywhere else: every row carrying the product window says so and keeps its amount.
function v13NorthPortReferenceWarnings(items) {
  return items.filter((item) => item.product && item.gates?.northPortProductWindow === true).map((item) => ({
    code: 'lawn_v13_north_port_product_window', severity: 'warning', productId: item.product.id, productName: item.product.name,
    message: `${item.product.name}: North Port: not applied June to September (until the city confirms). Skip this product there.`,
  }));
}

// v13Limits for a reader that has a booked visit (the tank sheet), plus the plan's own
// block notices for what it capped. Gate off or no visit (no customer): nothing is checked.
async function v13VisitLimits(knex, service, items, rows, targets = {}, { place = null, strict = false } = {}) {
  if (!service || featureGates.lawnV13Live?.() !== true) return { capped: new Map(), warnings: [], blocks: [] };
  const found = await v13Limits(knex, service, toServiceDate(service.scheduled_date), items, { rows, targets, place, strict });
  return { ...found, blocks: v13LineNotices([], found.capped, new Set()).blocks };
}

// The catch-up's settlement for a reader that has a booked visit but not the plan (the tank sheet, the pre-visit brief): the SAME decision the
// plan makes (lawn-rounds-catchup.js settleCatchUp, fed by the same v13Limits read), so every surface keeps or drops the line together.
// Returns { items, warnings, dropped }; no catch-up line in `items`: the inputs. `strict` throws a failed limit read (the brief).
async function settleCatchUpForVisit(knex, service, items, rows, targets = {}, { strict = false } = {}) {
  const lines = items.filter(roundsCatchUp.isCatchUpItem);
  if (!lines.length) return { items, warnings: [], dropped: [] };
  const found = await v13VisitLimits(knex, service, lines, rows, targets, { strict });
  return roundsCatchUp.settleCatchUp(items, { rowOf: (item) => bermudaRemoval.rowFor(rows, item.product.id, false), calculates: v13RowCalculates, cappedIds: new Set(found.capped.keys()) });
}

// Plan notices for the v13 lines: a hard limit is a block per limit (the existing
// message), an unlinked line and an ignored substitution are warnings.
function v13LineNotices(planItems, capped, ignoredSubstitutionIds) {
  const blocks = [...capped].flatMap(([productId, found]) => found.map((block) => ({
    code: 'lawn_v13_annual_limit', severity: 'block', productId, productName: block.productName, message: block.message,
  })));
  // A product the city holds back has its own warning (v13HoldWarnings); it is not an unlinked line.
  const warnings = planItems.filter((item) => item.unavailable && item.unavailable.kind !== CITY_HOLD_KIND && item.product).map((item) => ({
    code: 'lawn_v13_line_unlinked', severity: 'warning', productId: item.product.id, productName: item.product.name,
    message: `${item.product.name}: no protocol row is linked to this product, so no amount is planned.`,
  }));
  const substitutions = planItems.filter((item) => item.product && ignoredSubstitutionIds.has(String(item.product.id))).map((item) => ({
    code: 'lawn_v13_substitution_ignored', severity: 'warning', productId: item.product.id, productName: item.product.name,
    message: 'Substitution not applied: v13 line keeps its protocol product.',
  }));
  return { blocks, warnings: [...warnings, ...substitutions] };
}

// The staged v13 row's gates and what they mean in the field (null and empty for
// every other plan), carried so the panel and job card can show them.
function v13ItemFields(line, gateContext, product, extraNotes = []) {
  const row = line?.row;
  return {
    gates: row?.gates && Object.keys(row.gates).length ? row.gates : null,
    gateNotes: [...(row ? v13GateNotes(row.gates, gateContext) : []), ...extraNotes],
    // A row with no calculated quantity: selectable, label rate as reference, never an amount.
    spot: line?.state === 'spot'
      ? {
        note: 'Spot: enter the area treated and the amount used.',
        reference: v13SpotReference(row, product),
        // The row's own stated rate, for a reader that sizes a tank dose (the job card's product search): the program's
        // rate, never the catalog default (Arena: 0.147 oz here, the main label's 0.29 oz in the catalog).
        ratePer1000: Number(row?.ratePer1000) > 0 ? Number(row.ratePer1000) : null,
        rateUnit: Number(row?.ratePer1000) > 0 ? row.rateUnit || null : null,
        // ... and the row's own carrier (Arena: 4 gal per 1,000 sq ft into the thatch), which the rate is stated over:
        // the window's carrier (1 gal in May and June) would show a 4-gallon fill covering 4,000 sq ft.
        carrierGalPer1000: Number(row?.carrierGalPer1000) > 0 ? Number(row.carrierGalPer1000) : null,
      }
      : null,
    // A line the plan cannot size at all: say why; the tech enters the actual work.
    unavailable: V13_UNAVAILABLE[line?.state] ? { reason: line.roundsNitrogen ? V13_ROUNDS_N_HELD : V13_UNAVAILABLE[line.state], ...(line.state === 'held' ? { kind: CITY_HOLD_KIND } : {}) } : null,
  };
}

const nullableNumber = (value) => (value != null ? Number(value) : null);

function planProductSnapshot(product, mix) {
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    activeIngredient: product.active_ingredient,
    active: product.active !== false,
    groups: getProductGroups(product),
    labelVerifiedAt: product.label_verified_at,
    applicationMethod: product.application_method,
    formulation: product.formulation,
    analysis_n: product.analysis_n,
    analysis_p: product.analysis_p,
    analysis_k: product.analysis_k,
    bestPrice: nullableNumber(product.best_price),
    costPerUnit: nullableNumber(product.cost_per_unit),
    costUnit: product.cost_unit || null,
    containerSize: product.container_size || null,
    unitSizeOz: nullableNumber(product.unit_size_oz),
    needsPricing: product.needs_pricing === true,
    mixing_order_category: product.mixing_order_category,
    mixing_instructions: product.mixing_instructions,
    inventory: buildProductInventorySnapshot(product, mix),
  };
}

function planSubstitutionSnapshot(substitution) {
  if (!substitution) return null;
  return {
    id: substitution.id,
    originalProductId: substitution.original_product_id,
    originalProductName: substitution.original_product_name,
    substituteProductId: substitution.substitute_product_id,
    substituteProductName: substitution.substitute_product_name,
    reason: substitution.reason || null,
    approvedByName: substitution.approved_by_name || null,
    approvedAt: substitution.approved_at || null,
    ratePer1000: nullableNumber(substitution.rate_per_1000),
    rateUnit: substitution.rate_unit || null,
  };
}

async function buildPlanForService(serviceId, options = {}) {
  const knex = options.db || db;
  const now = options.now || new Date();
  const completionDefaultsEnabled = options.completionDefaultsEnabled ?? lawnCompletionDefaultsEnabled();
  const lawnV13On = featureGates.lawnV13Live?.() === true;
  const billingModeColumnExists = typeof options.billingModeColumnExists === 'boolean'
    ? options.billingModeColumnExists
    : await customerBillingModeColumnExists(knex);

  const service = await knex('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .leftJoin('technicians as t', 'ss.technician_id', 't.id')
    .where('ss.id', serviceId)
    .select(
      'ss.*',
      'c.first_name', 'c.last_name', 'c.address_line1', 'c.address_line2', 'c.city', 'c.state', 'c.zip',
      'c.waveguard_tier', 'c.lawn_type', 'c.property_type',
      ...(billingModeColumnExists ? ['c.billing_mode'] : []),
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
  // strict (job card): every safety read below throws on failure instead of
  // reading as "nothing on file" — turf profile, catalog, substitutions,
  // latest assessment, ordinance context, manager approvals. The Lawn plan
  // and closeout keep the lenient default.
  const strict = options.strict === true || completionDefaultsEnabled;
  const completionContext = completionDefaultsEnabled ? await loadLawnCompletionContext(service, knex) : null;
  const profile = await knex('customer_turf_profiles')
    .where({ customer_id: service.customer_id, active: true })
    .first();
  const profileCompleteness = summarizeTurfProfileCompleteness(profile);
  const products = await getProducts(knex, { strict });
  const substitutions = await getAppointmentSubstitutions(knex, service.id, products, { strict });
  const latestAssessment = completionContext ? completionContext.latestAssessment : await getLatestAssessment(knex, service.customer_id, { strict });
  const stressFlags = latestAssessment?.stress_flags || {};
  // One resolved city for BOTH the ordinance query and the property gate the
  // panel displays — the restriction must be labeled with the city it was
  // actually evaluated against (stamped visit address first).
  const resolvedOrdinanceCity = String(
    service.service_address_city || profile?.municipality || service.city || '',
  ).trim() || null;
  const ordinances = await getApplicableOrdinances(knex, profile, {
    stampedCity: service.service_address_city,
    stampedZip: service.service_address_zip,
    customerCity: service.city,
    customerZip: service.zip,
  });
  const activeCalibrations = await getActiveCalibrations(knex, {
    equipmentSystemId: options.equipmentSystemId || service.assigned_equipment_system_id,
    calibrationId: options.calibrationId || service.assigned_calibration_id,
  }, { strict });
  const nutrientLedger = await calculateNutrientLedger(knex, service.customer_id, products, profile?.lawn_sqft, serviceDate, { strict });

  // A visit on a lawn_rounds_9 series takes the program step of its round (roundRouting), not of its calendar month; null for every other
  // visit, which plans exactly as it always did. The step month drives the recipe step, the month-keyed program rules and the window the
  // protocol rows come from; the weed and spot rows and every real-date rule (ordinance, heat, chinch season) keep the real date.
  const roundStep = roundStepForPlan(service);
  const calendarProtocol = selectProtocolVisit(profile, serviceDate, service.lawn_type, { requireKnownGrass: completionDefaultsEnabled, ...(roundStep ? { month: roundStep.month } : {}) });
  const rounds = roundRouting(service, calendarProtocol.trackKey);
  // A new customer's first rounds visit in round 3 with no pre-emergent on the ledger this year: the spring pre-emergent catch-up joins it
  // (lawn-rounds-catchup.js, the whole decision). false for every other visit, which reads nothing.
  const catchUpWanted = await roundsCatchUp.catchUpWanted(knex, service, { strict });
  // GATE_LAWN_BERMUDA_REMOVAL: every bermuda removal decision (who wants the step, the extra
  // staged rows, the month, the cultivar, the projection, the output) lives in
  // lawn-bermuda-removal.js openPlanStep; the planner only passes what it knows. Gate off or any
  // other lawn: every call below is a no-op and the plan is the old one.
  const bermuda = await bermudaRemoval.openPlanStep(knex, { enabled: lawnV13On, service, profile, calendarTrackKey: calendarProtocol.trackKey, strict });
  // GATE_LAWN_V13 resolves the visit's pinned assignment whatever the completion-
  // default gates say: a pinned older visit must be seen as pinned, never as
  // unpinned (which would resolve the staged v13 version for it).
  // GATE_LAWN_V13: a bahia lawn has no program, so no protocol window (a pinned assignment included)
  // is read for it; the plan blocks on lawn_v13_bahia_no_program instead.
  const structuredProtocolContext = !calendarProtocol.v13NoProgram && (calendarProtocol.trackKey || !completionDefaultsEnabled) ? await getProtocolWindowContext(knex, {
    serviceDate,
    grassTrack: calendarProtocol.trackKey || TRACK_BY_GRASS[profile?.grass_type] || 'st_augustine',
    region: 'swfl',
    planning: true,
    ...(rounds ? { roundStep: roundsCatchUp.roundStepFields({ round: rounds.round, month: rounds.month, spotMonth: rounds.spotMonth }, catchUpWanted) } : {}),
    ...bermuda.protocolOptions,
    ...(completionDefaultsEnabled ? {
      strict: true, windowKey: service.lawn_protocol_window_key,
      protocolKey: service.lawn_protocol_key, protocolVersion: service.lawn_protocol_version,
    } : lawnV13On ? {
      windowKey: service.lawn_protocol_window_key,
      protocolKey: service.lawn_protocol_key, protocolVersion: service.lawn_protocol_version,
    } : {}),
  }).catch((err) => { if (strict) throw err; return null; }) : null;
  // Select the assigned window's field-reference recipe, while weather,
  // ordinance and nutrient-ledger checks keep the actual appointment date.
  const selection = completionDefaultsEnabled
    ? selectProtocolVisit(profile, serviceDate, service.lawn_type, {
      requireKnownGrass: true, month: structuredProtocolContext?.window?.month ?? rounds?.month,
    }) : calendarProtocol;
  const { trackKey, track, month } = selection;
  const recipeVisit = completionDefaultsEnabled && service.lawn_protocol_window_key && !structuredProtocolContext?.window
    ? null : selection.visit;
  // A visit whose step depends on the plan's cadence (v13 April: the 9x plan takes
  // Dimension 18-0-10 where every other plan takes the 44-0-0 polymer bag) reads the cadence
  // from the booked service; unknown keeps the 12x step and warns.
  const { visit: recipeStep, unknownCadence } = await visitForPlan(knex, recipeVisit, service, null, { track, trackKey });
  const assignedProtocol = summarizeProtocolContext(structuredProtocolContext);
  const exactName = track?.exact_catalog_names === true;
  // The April and June bermuda removal step: its three spot lines join the visit's secondary
  // list (opt-in lines, like every other spot product).
  const step = await bermuda.resolve({ structuredProtocol: assignedProtocol, trackKey, parseLines: (text) => parseProtocolLines(text, 'conditional', { exactName }) });
  // The protocol products this appointment reads: the assigned window's, with the appointment month's step rows when
  // the visit moved across months. The rows, the completion defaults and the ledger all read this one list.
  let structuredProtocol = step.protocol(assignedProtocol);
  // GATE_LAWN_V13 with the staged v13 protocol resolved: every matched line goes
  // through v13LineState (one decision per line) and keeps its protocol product.
  const v13Active = featureGates.lawnV13Live?.() === true && structuredProtocol?.version === LAWN_V13_VERSION;
  // The visit the lines are parsed from: the recipe step, or its copy with the cut nitrogen stated (GATE_LAWN_NOV_LARGE_PATCH_N,
  // GATE_LAWN_RECLAIMED_HALF_N), the Tetrino rate raised (GATE_LAWN_CHINCH_TETRINO_RATE) or the whole-lawn bag swapped (GATE_LAWN_DEC_LARGE_PATCH_K).
  const nitrogen = await visitNutrientTargets(knex, service, { visit: recipeStep, month, v13Active, strict });
  const { visit, targets: nutrientTargets, nitrogenCut, chinchRate, productSwap } = nitrogen;
  const baseLines = parseProtocolLines(visit?.primary, 'base', { exactName });
  const conditionalLines = [
    ...parseProtocolLines(visit?.secondary, 'conditional', { exactName }),
    ...step.lines,
    ...roundsCatchUp.catchUpLines(track, (text, role) => parseProtocolLines(text, role, { exactName }), catchUpWanted),
  ];
  // GATE_LAWN_V13 with the staged v13 protocol resolved: each matched product's
  // own protocol row supplies its rate, its sunny-turf limit and its gates.
  // GATE_LAWN_CHINCH_TETRINO_RATE: the May Tetrino row states the raised rate for a chinch-mapped lawn (same Map back otherwise).
  const v13Rows = chinchRateRows(v13ProtocolRows(structuredProtocol), chinchRate ?? null);
  const resolvedItems = resolveProtocolItems([...baseLines, ...conditionalLines], products, options, {
    profile,
    service,
    stressFlags,
  });
  // A product the city bans for this visit's window is held back before anything is sized; the
  // bermuda step lines are then one selection: any selected selects all.
  const holdRoundsNitrogen = roundsNitrogenHold(rounds, resolvedOrdinanceCity);
  let candidateItems = roundsCatchUp.selectCatchUp(step.select(holdNorthPortProducts(resolvedItems, v13Rows, resolvedOrdinanceCity, { nitrogen: holdRoundsNitrogen })));
  let plannedCandidateItems = candidateItems.filter((item) => item.selected);

  // A rig the visit names (assignment or explicit request) is the visit's;
  // anything else the summary picks is inferred.
  const assignedRig = Boolean(options.equipmentSystemId || options.calibrationId || service.assigned_equipment_system_id || service.assigned_calibration_id);
  const calibrationSummary = summarizeCalibration({
    calibration: assignedRig && activeCalibrations.length === 1 ? activeCalibrations[0] : null,
    calibrations: activeCalibrations,
    assigned: assignedRig,
    date: serviceDate,
  });
  const calibration = calibrationSummary.selected;
  // Rig carrier when one resolved, else the protocol window's default (the
  // same fallback the completed-service report already reads).
  const rigCarrier = Number(calibration?.carrier_gal_per_1000 || 0);
  const carrier = rigCarrier > 0 ? rigCarrier : Number(structuredProtocol?.window?.defaultCarrierGalPer1000 || 0);
  const carrierSource = rigCarrier > 0 ? 'rig' : (carrier > 0 ? 'protocol_default' : null);
  const lawnSqft = completionContext
    ? Number(options.lawnSqft !== undefined ? options.lawnSqft : (completionContext.propertyMatchesProfile ? profile?.lawn_sqft : 0)) || 0
    : Number(profile?.lawn_sqft || 0);
  // What every line's area factor and gate text share, built once.
  const areaContext = {
    sunExposure: profile?.sun_exposure,
    plan: options.plan || service.waveguard_tier,
    weedPressure: options.weedPressure,
    conditionFlags: options.conditionFlags,
    propertyFlags: options.propertyFlags,
    stressFlags,
    isFirstYear: options.isFirstYear,
  };
  const gateContext = {
    monthNumber: MONTH_ABBR.indexOf(month) + 1 || null,
    // A rounds visit: the weed and spot rules (Dismiss, November to March) are judged by the real date, not the step month.
    ...(rounds ? { spotMonthNumber: rounds.spotMonth, realMonthNumber: rounds.realMonth } : {}),
    ...(holdRoundsNitrogen ? { holdRoundsNitrogen: true } : {}),
    municipality: resolvedOrdinanceCity,
    productionMode: structuredProtocol?.window?.productionMode,
  };
  const v13Limit = v13Active ? await v13Limits(knex, service, serviceDate, candidateItems, { strict, rows: v13Rows, targets: nutrientTargets }) : { capped: new Map(), warnings: [] };
  // The catch-up is settled before anything reads the lines again (settleCatchUpLines).
  const catchUp = settleCatchUpLines({ items: candidateItems, v13Active, v13Rows, v13Limit, structuredProtocol });
  candidateItems = catchUp.items;
  plannedCandidateItems = candidateItems.filter((item) => item.selected);
  structuredProtocol = catchUp.protocol;
  const catchUpKept = candidateItems.some(roundsCatchUp.isCatchUpItem);
  const cappedProducts = v13Limit.capped;
  const v13LineOf = (item) => (v13Active && item.product ? v13LineState(item.product, v13Rows, cappedProducts, gateContext, item) : null);
  // An apply-alone product selected beside any other product holds the mix: the plan
  // blocks and withholds the selection's quantities (as the tank sheet does).
  const applyAloneBlocks = v13SelectionBlocks(candidateItems, (item) => v13LineOf(item)?.row, gateContext);
  let planItems = candidateItems.map((item) => {
    const line = v13LineOf(item);
    // One product per line: the approved substitute when one is on the visit, else the
    // matched catalog row. A v13 line never takes a substitute (it keeps its protocol
    // product, rate scope and gates; the plan warns).
    const substitution = !v13Active && item.product ? substitutions.get(String(item.product.id)) : null;
    const plannedProduct = substitution ? substitutedProduct(substitution) : item.product;
    const mix = plannedProduct && (!line || line.state === 'calculate') && !(applyAloneBlocks.length && item.selected) ? calculateProductAmount({
      product: plannedProduct,
      lawnSqft,
      // The catch-up is a hose pass at its own row's carrier (1 gal per 1,000 sq ft), whatever rig the round's spreader visit names.
      carrierGalPer1000: roundsCatchUp.carrierFor(item, line?.row, carrier),
      areaFactor: effectiveAreaFactor(line?.row?.gates?.sunnyTurfOnly ? { ...item, sunnyTurfOnly: true } : item, areaContext),
      ...nutrientTargets,
      ...v13RateOptions(line?.row),
    }) : null;
    return {
      ...planLineFields(item),
      // Gate off: no v13 field at all, the payload is the old one.
      ...(v13Active ? v13ItemFields(line, gateContext, plannedProduct, [...nitrogenCutNotes(mix, plannedProduct, nitrogen), ...chinchTetrinoNotes(line?.row, mix, chinchRate), ...productSwapNotes(plannedProduct, productSwap, v13Rows), ...roundsCatchUp.catchUpNotes(item)]) : {}),
      // GATE_LAWN_DEC_LARGE_PATCH_K: the swapped-in bag is the visit's default whole-lawn product though its staged row is not a default.
      ...(isSwapProduct(plannedProduct, productSwap, v13Rows) ? { productSwapIn: true } : {}),
      matched: !!plannedProduct,
      product: planProductSnapshot(plannedProduct, mix),
      substitution: planSubstitutionSnapshot(substitution),
      mix,
    };
  });
  // An archived assignment cannot silently borrow a later field recipe or
  // catalog rate. Keep its stored protocol visible, but offer no calculated
  // products when the old recipe cannot be reproduced from the current inputs.
  // The step is whole or absent, decided by the ONE projection the tank sheet and the
  // completion actions share (lawn-bermuda-removal.js projectBermudaStep): staged rows
  // linked, products active, no limit capped, then settled (warning or product-scoped
  // blocks) with the cultivar's test-patch note.
  const bermudaProjection = await step.project(planItems, {
    enabled: v13Active, rows: v13Rows, probeLimits: (probe, stagedRows) => v13Limits(knex, service, serviceDate, probe, { strict, rows: stagedRows }),
    productOf: (id) => products.find((product) => String(product.id) === String(id)) || null,
  });
  planItems = bermudaProjection.items;
  const archivedRecipeUnavailable = completionDefaultsEnabled && !archivedLawnRecipeMatches(structuredProtocol, planItems, nitrogenCut == null ? null : { from: parseVisitNutrientTargets(recipeStep?.notes).targetNPer1000, to: nitrogenCut }, chinchRate == null ? null : { from: V13_CHINCH_TETRINO.normalRate, to: chinchRate, productName: V13_CHINCH_TETRINO.productName }, productSwap || null);
  // GATE_LAWN_V13 with no staged v13 protocol for this visit: no calculated products
  // either (the block below says why), never amounts from catalog defaults.
  const v13PlanBlock = lawnV13PlanBlock({ trackKey, service, structuredProtocol });
  if (archivedRecipeUnavailable || v13PlanBlock) planItems.length = 0;
  const plannedItems = planItems.filter((item) => item.selected);
  const materialCostSummary = summarizeMaterialCost(plannedItems);

  const ordinanceSummary = summarizeOrdinanceStatus({ date: serviceDate, ordinances, candidateItems: plannedItems });
  const nutrientProjection = calculateNutrients(plannedItems, lawnSqft, { propertyLawnSqft: profile?.lawn_sqft });
  const inventorySummary = summarizeInventoryStatus(plannedItems);
  const warnings = [
    ...ordinanceSummary.warnings,
    ...calibrationSummary.warnings,
    ...inventorySummary.warnings,
  ];
  const blocks = [
    ...ordinanceSummary.blocks,
    ...calibrationSummary.blocks,
    ...inventorySummary.blocks,
  ];
  if (archivedRecipeUnavailable) {
    blocks.push({ code: 'lawn_archived_recipe_unavailable', severity: 'block', message: 'The assigned archived recipe cannot be reproduced with the current products and rates. Review the assigned protocol and enter the actual work.' });
  }
  if (completionContext && !completionContext.propertyMatchesProfile) {
    blocks.push({ code: 'lawn_property_unresolved', severity: 'block', message: 'The saved turf profile does not prove this service property; suggested amounts are unavailable.' });
  }
  if (v13PlanBlock) blocks.push(v13PlanBlock);
  // Restored v13 product gates on the selected items: a condition the plan cannot
  // clear is a visible warning; an apply-alone product selected beside any other
  // product holds the mix.
  warnings.push(...v13SelectedGateWarnings(plannedItems), ...v13HoldWarnings(planItems));
  if (unknownCadence && v13Active) warnings.push(unknownCadenceWarning(unknownCadence));
  warnings.push(...bermudaProjection.warnings, ...catchUp.warnings);
  blocks.push(...applyAloneBlocks);
  blocks.push(...bermudaProjection.blocks);
  if (v13Active) {
    const notices = v13LineNotices(planItems, cappedProducts, new Set(substitutions.keys()));
    blocks.push(...notices.blocks);
    warnings.push(...notices.warnings, ...v13Limit.warnings);
    const inactiveNotices = await lawnV13InactiveProductNotices(knex, candidateItems, { strict });
    blocks.push(...inactiveNotices.blocks);
    warnings.push(...inactiveNotices.warnings);
  }
  if (completionDefaultsEnabled && !matchesLawnCompletionProtocol(structuredProtocol, {
    protocolKey: service.lawn_protocol_key, protocolVersion: service.lawn_protocol_version, windowKey: service.lawn_protocol_window_key,
  }, trackKey)) {
    blocks.push({ code: 'lawn_protocol_unresolved', severity: 'block', message: 'The appointment has no matching lawn protocol; suggested amounts are unavailable.' });
  }

  if (!profile) {
    blocks.push({
      code: 'missing_turf_profile',
      severity: 'block',
      message: 'Customer has no active turf profile. Create the profile before planning a WaveGuard treatment.',
    });
  }
  if (profileCompleteness.missing.length) {
    warnings.push({
      code: 'turf_profile_incomplete',
      severity: 'warning',
      message: `Turf profile is missing: ${profileCompleteness.missing.map((item) => item.label).join(', ')}.`,
    });
  }
  if (profile && !(completionContext ? lawnSqft : profile.lawn_sqft)) {
    blocks.push({
      code: 'missing_lawn_area',
      severity: 'block',
      message: 'Turf profile is missing lawn square footage, so mix amounts cannot be calculated.',
    });
  }
  if (selection.v13NoProgram) {
    blocks.push({
      code: 'lawn_v13_bahia_no_program',
      severity: 'block',
      message: 'Bahiagrass has no v13 lawn program: Celsius and Blindside are not labeled for bahiagrass, so no suggested amounts are planned. Enter the actual work.',
    });
  }
  if (!track || !visit) {
    blocks.push({
      code: 'missing_protocol_visit',
      severity: 'block',
      message: `No WaveGuard protocol visit found for ${trackKey || 'unmapped track'} in ${month}.`,
    });
  }
  if (!structuredProtocol?.window) {
    warnings.push({
      code: 'missing_structured_lawn_protocol_window',
      severity: 'warning',
      message: 'No structured 10/10 lawn protocol window was found for this date; legacy protocol text is still being used.',
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
      protocol: { base: planItems.filter((item) => item.role === 'base'), conditional: planItems.filter((item) => item.role === 'conditional'), structured: structuredProtocol },
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
    strict,
  });
  for (const block of managerApprovals.blocks) blocks.push(block);
  for (const warning of managerApprovals.warnings) warnings.push(warning);

  const status = blocks.length ? 'blocked' : warnings.length ? 'warning' : 'approved';

  const plan = {
    status,
    serviceId: service.id,
    generatedAt: now.toISOString(),
    propertyGate: {
      customerId: service.customer_id,
      customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),
      service: service.service_type,
      serviceTier: service.waveguard_tier || null,
      // The explicit billing lane (customers.billing_mode): an explicit
      // one_time lane defeats a lingering legacy tier for protocol
      // attribution (Codex #4113 batch 12, follow-up); per_visit with a tier
      // is a program (owner 2026-10-26). null = unset / inferred.
      billingMode: service.billing_mode || null,
      trackKey,
      trackName: track?.name || null,
      month,
      visit: visit?.visit || null,
      lawnSqft: completionContext ? lawnSqft || null : profile?.lawn_sqft || null,
      // true = the saved turf profile proves THIS service property; false =
      // it does not; null = not evaluated (completion-defaults gates off).
      propertyMatchesProfile: completionContext ? completionContext.propertyMatchesProfile === true : null,
      // The address inputs that proof compared (property key + visit key):
      // the completion transaction rebuilds both from locked rows and aborts
      // on drift (Codex #4113 P2). null = not evaluated.
      addressProof: completionContext ? completionContext.addressProof : null,
      // The saved whole-property area, untouched by a visit-only override: the
      // denominator every annual per-1,000 nutrient figure shares.
      profileLawnSqft: profile?.lawn_sqft || null,
      // The profile version this plan was built from: the completion
      // transaction re-reads it under the customer lock and aborts when a
      // turf-profile edit committed in between (Codex #4113 P2).
      turfProfile: { id: profile?.id || null, updatedAt: profile?.updated_at ? new Date(profile.updated_at).toISOString() : null },
      municipality: resolvedOrdinanceCity,
      county: profile?.county || null,
      ordinanceStatus: ordinanceSummary.activeWindows.length ? 'restricted_window_active' : 'no_active_blackout',
      // Restriction windows ACTIVE on this service date, so the closeout can
      // warn about tech-added N/P products the planned-item gate never saw —
      // evaluated here against the property's real ordinances (no client-side
      // month heuristics).
      activeOrdinanceWindows: ordinanceSummary.activeWindows.map((rule) => ({
        jurisdictionName: rule.jurisdiction_name || null,
        restrictedNitrogen: !!rule.restricted_nitrogen,
        restrictedPhosphorus: !!rule.restricted_phosphorus,
      })),
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
      profileCompleteness,
      warnings,
      blocks,
      managerApprovals,
    },
    protocol: {
      structured: structuredProtocol,
      objective: visit?.notes || null,
      base: planItems.filter((item) => item.role === 'base'),
      conditional: planItems.filter((item) => item.role === 'conditional'),
      blocked: blocks,
    },
    mixCalculator: {
      equipmentSystemId: calibration?.equipment_system_id || null,
      carrierGalPer1000: carrier > 0 ? carrier : null,
      carrierSource,
      tankCapacityGal: calibration?.tank_capacity_gal ? Number(calibration.tank_capacity_gal) : null,
      lawnSqft: completionContext ? lawnSqft || null : profile?.lawn_sqft || null,
      nutrientProjection,
      materialCostSummary,
      items: plannedItems,
      conditionalOptions: planItems.filter((item) => item.role === 'conditional' && !item.selected),
    },
    equipmentCalibration: calibrationSummary,
    inventory: inventorySummary,
    // Gate off, or not a bermuda removal visit: no field, the payload is the old one.
    ...step.field,
    // A rounds visit: the step the plan read, so the completion attributes to the same row set (lawn-protocol-completion loadProtocolRows).
    ...(rounds ? { roundStep: roundsCatchUp.roundStepFields({ round: rounds.round, month: rounds.month, spotMonth: rounds.spotMonth }, catchUpKept) } : {}),
    // The spring pre-emergent catch-up this visit carries (named for the panel, the sheet, the brief and the report), only while it is planned.
    ...roundsCatchUp.planField(catchUpKept),
    appointmentAssignment: {
      protocolKey: service.lawn_protocol_key || null,
      protocolVersion: service.lawn_protocol_version || null,
      windowKey: service.lawn_protocol_window_key || null,
      windowTitle: service.lawn_protocol_window_title || null,
      equipmentSystemId: service.assigned_equipment_system_id || null,
      calibrationId: service.assigned_calibration_id || null,
      source: service.lawn_protocol_assignment_source || null,
      assignedAt: service.lawn_protocol_assigned_at || null,
    },
    // An apply-alone conflict holds the mix: no combined order is offered.
    mixingOrder: applyAloneBlocks.length ? [] : buildMixOrder(plannedItems.filter(bermudaRemoval.inMixingOrder), cappedProducts),
    // The backpack step's own order (water, Recognition, Fusilade II, surfactant last), when it is selected.
    ...step.mixOrderField(plannedItems, applyAloneBlocks.length > 0),
    closeout: {
      requiredPhotos: ['before', 'after'],
      captureActualProductAmounts: true,
      requiredProtocolTasks: structuredProtocol?.window?.requiredTasks || [],
      protocolWindowKey: structuredProtocol?.window?.key || null,
      protocolWindowTitle: structuredProtocol?.window?.title || null,
      customerRecapPreview: visit
        ? `${rounds ? `Round ${rounds.round}` : month} WaveGuard visit planned for ${track?.name || 'selected turf track'}.`
        : null,
    },
  };
  if (options.includeCompletionDefaults) {
    plan.completionDefaults = completionContext
      ? buildLawnCompletionDefaults(plan, completionContext) : { enabled: false };
  }
  return plan;
}

module.exports = {
  buildProductInventorySnapshot,
  buildPlanForService,
  customerBillingModeColumnExists,
  selectProtocolVisit,
  calculateProductAmount,
  parseVisitNutrientTargets,
  visitNutrientTargets,
  fungusNitrogenCut,
  sheetReadsPlansStep,
  visitOnV13Protocol,
  visitProjectionLive,
  fungusNitrogenNotes,
  nitrogenCutNotes,
  nitrogenCutWhy,
  CUT_WHY_NOTE,
  nitrogenDecision,
  chinchTetrinoRate,
  chinchRateRows,
  chinchTetrinoNotes,
  troubleProductSwap,
  productSwapNotes,
  isSwapProduct,
  summarizeMaterialCost,
  effectiveAreaFactor,
  v13ProtocolRows,
  v13RateOptions,
  loadV13RowsForMonth,
  lawnV13PlanBlock,
  v13GateNotes,
  v13ItemFields,
  v13RowCalculates,
  planLineFields,
  v13SelectedGateWarnings,
  v13ApplyAloneBlocks,
  v13SelectionBlocks,
  v13LineState,
  holdNorthPortProducts,
  roundRouting,
  roundsNitrogenHold,
  northPortNpBanMonth,
  lawnV13InactiveProductNotices,
  v13NorthPortHold,
  loadVisitCity,
  v13NorthPortReferenceWarnings,
  v13HoldWarnings,
  lawnVisitsPerYear,
  visitForPlan,
  loadVisitForPlan,
  v13VisitLimits,
  settleCatchUpForVisit,
  calculateNutrientLedgerFromRows,
  calculateNutrients,
  summarizeAnnualN,
  buildMixOrder,
  MIX_ORDER,
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
  getActiveCalibrations,
  itemHasNitrogen,
  itemHasPhosphorus,
  itemIsPgr,
  summarizeOrdinanceStatus,
  summarizeTurfProfileCompleteness,
  resolveOrdinanceJurisdiction,
  getApplicableOrdinances,
};
