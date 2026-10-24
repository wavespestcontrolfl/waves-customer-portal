const crypto = require('crypto');
const {
  bahiaHasNoProgram,
  isBahiaGrass,
  lawnProtocols,
  lawnV13AnyGrassTrack,
} = require('./lawn-program');
const { PROGRAM_DETAIL_V13, PROGRAM_LINES_V13 } = require('./service-report/lawn-program-line');
const { estimateHasBahiaLawn, estimateLawnGrassValues } = require('./estimate-bahia-review');
const featureGates = require('../config/feature-gates');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TEMPLATE_VERSION = 'mvp-1';
const CONTENT_LIBRARY_VERSION = 'seed-v1';
const V13_CONTENT_LIBRARY_VERSION = 'lawn-v13-copy-1';
const PRODUCT_REGISTRY_VERSION = 'public-facts-v1';
const PROTOCOL_VERSION = 'lawn-v4';
const V13_PROTOCOL_VERSION = 'lawn-v13';
const LAWN_SERVICE_TIME_ZONE = 'America/New_York';

const BANNED_PHRASES = [
  'safe for pets',
  'safe for kids',
  'safe for children',
  'guaranteed green lawn',
  'kills all bugs',
  'eliminates weeds permanently',
  'always applied',
  'non-toxic',
  'nontoxic',
  'chemical-free',
  'harmless',
  'no risk',
  'epa approved',
  'organic',
  'pesticide-free',
  'will be applied',
  'guaranteed results',
  'permanent solution',
  'one-time fix',
  'no need to water',
  'no follow-up needed',
];

const TURF_LABELS = {
  st_augustine: 'St. Augustine',
  bermuda: 'Bermuda',
  zoysia: 'Zoysia',
  bahia: 'Bahia',
  mixed: 'Mixed turf',
  unknown: 'Unknown turf',
};

const TURF_MODULE_KEYS = {
  st_augustine: 'st_augustine_protocol_summary',
  bermuda: 'bermuda_protocol_summary',
  zoysia: 'zoysia_protocol_summary',
  bahia: 'bahia_protocol_summary',
  mixed: 'mixed_turf_summary',
  unknown: 'unknown_turf_summary',
};

const SEASON_MODULE_KEYS = {
  jan_mar: 'season_jan_mar',
  apr_may: 'season_apr_may',
  jun_sep: 'season_jun_sep',
  oct_dec: 'season_oct_dec',
};

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function normalizeTurfType(value) {
  const raw = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!raw) return 'unknown';
  if (raw.includes('mixed') || raw.includes('multiple')) return 'mixed';
  if (raw.includes('augustine') || raw.includes('st aug') || raw.includes('staug')) return 'st_augustine';
  if (raw.includes('bermuda')) return 'bermuda';
  if (raw.includes('zoysia') || raw.includes('zoysiagrass')) return 'zoysia';
  if (raw.includes('bahia')) return 'bahia';
  return 'unknown';
}

function detectTurfFromObject(data) {
  if (!data || typeof data !== 'object') return '';
  const direct = firstNonEmpty(
    data.turfType,
    data.turf_type,
    data.grassType,
    data.grass_type,
    data.lawnTurfType,
    data.lawn?.turfType,
    data.lawn?.grassType,
    data.property?.turfType,
    data.property?.grassType,
  );
  if (direct) return direct;

  const haystack = JSON.stringify(data).toLowerCase();
  if (haystack.includes('st. augustine') || haystack.includes('st augustine')) return 'St. Augustine';
  if (haystack.includes('bermuda')) return 'Bermuda';
  if (haystack.includes('zoysia')) return 'Zoysia';
  if (haystack.includes('bahia')) return 'Bahia';
  return '';
}

function resolveSeasonBand(month) {
  const m = Number(month);
  if ([1, 2, 3].includes(m)) return 'jan_mar';
  if ([4, 5].includes(m)) return 'apr_may';
  if ([6, 7, 8, 9].includes(m)) return 'jun_sep';
  return 'oct_dec';
}

function currentMonthNumber(date = new Date(), timeZone = LAWN_SERVICE_TIME_ZONE) {
  const value = date instanceof Date ? date : new Date(date);
  const resolvedDate = Number.isNaN(value.getTime()) ? new Date() : value;
  try {
    const month = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: 'numeric',
    }).format(resolvedDate);
    const numericMonth = Number(month);
    if (Number.isInteger(numericMonth) && numericMonth >= 1 && numericMonth <= 12) return numericMonth;
  } catch {
    // Fall through to the runtime local month if Intl time-zone resolution fails.
  }
  return resolvedDate.getMonth() + 1;
}

function estimateHasLawnService(estimate = {}, estimateData = {}) {
  const fields = [
    estimate.service_interest,
    estimate.serviceInterest,
    estimate.notes,
    estimate.description,
    estimateData.serviceInterest,
    estimateData.service_interest,
    estimateData.serviceLine,
    estimateData.service_line,
    estimateData.serviceType,
  ];
  const serviceLines = [
    ...(Array.isArray(estimate.serviceLines) ? estimate.serviceLines : []),
    ...(Array.isArray(estimate.service_lines) ? estimate.service_lines : []),
    ...(Array.isArray(estimateData.serviceLines) ? estimateData.serviceLines : []),
    ...(Array.isArray(estimateData.service_lines) ? estimateData.service_lines : []),
  ];
  return [...fields, ...serviceLines].some((value) => {
    const s = String(value || '').toLowerCase();
    return s.includes('lawn') || s.includes('turf');
  });
}

function resolveTurf({ estimate = {}, estimateData = {}, input = {} }) {
  const source = firstNonEmpty(
    input.turfType,
    input.turf_type,
    estimate.turf_type,
    estimate.turfType,
    detectTurfFromObject(estimateData),
    estimate.notes,
    estimate.description,
  );
  const turfType = normalizeTurfType(source);
  return {
    turfType,
    label: TURF_LABELS[turfType] || TURF_LABELS.unknown,
    confidence: turfType === 'unknown' ? 'unknown' : source ? 'inferred' : 'unknown',
    mixed: turfType === 'mixed',
  };
}

const squashGrass = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Bahia by the one lawn-program check (D, Argentine, Pensacola), then the pricing engine's grass
// codes and names (A, B, C1, C2), then the free-text match.
function normalizeTurfTypeV13(value) {
  if (isBahiaGrass(value)) return 'bahia';
  const { GRASS_TYPE_ALIASES } = require('./pricing-engine/constants');
  const squashed = squashGrass(value);
  const coded = squashed && Object.keys(GRASS_TYPE_ALIASES)
    .find((grass) => (GRASS_TYPE_ALIASES[grass] || []).some((alias) => squashGrass(alias) === squashed));
  return coded || normalizeTurfType(value);
}

// GATE_LAWN_OUTLINE_V13: the composer's pick, else the grass the estimate records for its lawn plan,
// read from the stored shapes the send path's bahia review reads (estimate-bahia-review.js). Never a
// guess from the rest of the estimate: a scan of the whole estimate read the bermudaSuppression
// add-on flag as Bermuda on most St. Augustine estimates, and a note can name a grass the lawn does
// not have. A pest-only estimate's default grassType is not a lawn plan and is not read.
function resolveTurfV13({ estimateData = {}, input = {} }) {
  const picked = firstNonEmpty(input.turfType, input.turf_type);
  const source = picked || firstNonEmpty(...estimateLawnGrassValues(estimateData));
  // With no composer pick, any bahia record is the bahia lawn the send path parks for review.
  const recordedBahia = !picked && estimateHasBahiaLawn(estimateData);
  const turfType = recordedBahia ? 'bahia' : (source ? normalizeTurfTypeV13(source) : 'unknown');
  return {
    turfType,
    label: TURF_LABELS[turfType] || TURF_LABELS.unknown,
    confidence: turfType === 'unknown' ? 'unknown' : 'inferred',
    mixed: turfType === 'mixed',
  };
}

// v13 files its one program under the three grass keys. A mixed or unknown lawn plans from
// the shared key, as the plan engine does; bahiagrass has no v13 program and gets none.
function v13TrackKey(turfType) {
  return lawnProtocols()?.[turfType] ? turfType : lawnV13AnyGrassTrack(turfType);
}

function resolveJurisdictionId(address) {
  const a = String(address || '').toLowerCase();
  if (/(sarasota|venice|north port|nokomis|osprey|englewood)/.test(a)) return 'sarasota_county_fl';
  if (/(manatee|bradenton|palmetto|parrish|lakewood ranch|ellenton|anna maria)/.test(a)) return 'manatee_county_fl';
  if (/(charlotte|port charlotte|punta gorda|rotunda)/.test(a)) return 'charlotte_county_fl';
  return 'generic_swfl';
}

function isRestrictedSeason(rule, month) {
  if (!rule?.restricted_start_month || !rule?.restricted_end_month) return false;
  const start = Number(rule.restricted_start_month);
  const end = Number(rule.restricted_end_month);
  const m = Number(month);
  if (start <= end) return m >= start && m <= end;
  return m >= start || m <= end;
}

function sanitizeProtocolLine(line) {
  return String(line || '')
    .replace(/\([^)]*\$[^)]*\)/g, '')
    .replace(/[★⚠]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function protocolLines(text) {
  return String(text || '')
    .split('\n')
    .map(sanitizeProtocolLine)
    .filter(Boolean);
}

// The v13 program names exact products and rates on every line, which a customer
// outline must never carry: each line becomes its treatment category, first match
// wins, and a line no category covers is left out rather than quoted.
const V13_OUTLINE_CATEGORIES = [
  [/scout visit|inspect/i, 'Lawn inspection'],
  [/stonewall 0\.43%|dimension 0\.21%/i, 'Pre-emergent weed control with fertilizer'],
  [/stonewall|dimension/i, 'Pre-emergent weed control'],
  [/nutra-tech/i, 'Micronutrients'],
  [/\d{2}-\d-\d{2}/, 'Fertilizer and nutrition'],
  [/tetrino|arena|talak|acelepryn|dylox/i, 'Insect control'],
  [/artavia|velista|gravex/i, 'Disease control'],
  [/celsius|certainty|blindside|dismiss/i, 'Weed spot treatment'],
  [/dispatch|surfactant/i, 'Wetting agent'],
];

function v13OutlineBullets(visit) {
  const lines = [...protocolLines(visit.primary), ...protocolLines(visit.secondary)];
  const labels = lines.map((line) => V13_OUTLINE_CATEGORIES.find(([pattern]) => pattern.test(line))?.[1]).filter(Boolean);
  return [...new Set(labels)].slice(0, 8)
    .map((label) => `${label} may be relevant when turf condition, weather, label directions, and local rules allow.`);
}

// GATE_LAWN_OUTLINE_V13 (live only with GATE_LAWN_V13): every section of the outline
// describes the v13 program. Off = the outline exactly as before.
function outlineV13Live() {
  return featureGates.lawnOutlineV13Live?.() === true;
}

// The same categories, for every line of the month's step: the 12x step and each plan-size
// variant (the 9x April bag), so a category one plan size uses is never missing. A fertilizer
// analysis may have one-digit parts (44-0-0); Headway, Advion and the Topchoice add-on are v13 lines too.
const V13_FULL_OUTLINE_CATEGORIES = [
  [/scout visit|inspect/i, 'Lawn inspection'],
  [/stonewall 0\.43%|dimension 0\.21%/i, 'Pre-emergent weed control with fertilizer'],
  [/stonewall|dimension/i, 'Pre-emergent weed control'],
  [/nutra-tech/i, 'Micronutrients'],
  [/(?:^|[^\d.])\d{1,2}-\d{1,2}-\d{1,2}(?!\d)/, 'Fertilizer and nutrition'],
  [/tetrino|arena|talak|acelepryn|dylox|advion|topchoice/i, 'Insect control'],
  [/artavia|velista|gravex|headway/i, 'Disease control'],
  [/celsius|certainty|blindside|dismiss/i, 'Weed spot treatment'],
  [/dispatch|surfactant/i, 'Wetting agent'],
];

function v13StepLines(visit) {
  const steps = [visit, ...Object.values(visit.cadenceVariants || {})];
  return steps.flatMap((step) => [...protocolLines(step?.primary), ...protocolLines(step?.secondary)]);
}

function v13OutlineCategory(line) {
  return V13_FULL_OUTLINE_CATEGORIES.find(([pattern]) => pattern.test(line))?.[1] || null;
}

function v13FullOutlineBullets(visit) {
  const labels = v13StepLines(visit).map(v13OutlineCategory).filter(Boolean);
  return [...new Set(labels)]
    .map((label) => `${label} may be relevant when turf condition, weather, label directions, and local rules allow.`);
}

function customerProtocolBullets(visit) {
  if (!visit) return [];
  if (outlineV13Live()) return v13FullOutlineBullets(visit);
  if (featureGates.lawnV13Live?.() === true) return v13OutlineBullets(visit);
  const lines = [...protocolLines(visit.primary), ...protocolLines(visit.secondary)];
  return lines
    .filter((line) => !/material|labor|cost/i.test(line))
    .slice(0, 8)
    .map((line) => `${line} may be relevant when turf condition, weather, label directions, and local rules allow.`);
}

// The stamp on an outline and the staleness check against it: the v13 program
// (GATE_LAWN_V13) writes its own, so a flip shows older outlines as updated.
function protocolVersion() {
  return featureGates.lawnV13Live?.() === true ? V13_PROTOCOL_VERSION : PROTOCOL_VERSION;
}

// The same for the outline's own words: the v13 outline (GATE_LAWN_OUTLINE_V13) stamps
// its own content version, so a flip shows outlines built before it as updated.
function contentLibraryVersion() {
  return outlineVariant().contentLibraryVersion;
}

function protocolVisitForMonth(turfType, month) {
  const track = lawnProtocols()?.[turfType];
  if (!track) return null;
  const monthName = MONTHS[Number(month) - 1];
  return (track.visits || []).find((visit) => String(visit.month || '').toLowerCase() === monthName.toLowerCase()) || null;
}

function protocolTrack(turfType) {
  return lawnProtocols()?.[turfType] || null;
}

async function loadApprovedModules(db) {
  const rows = await db('lawn_service_content_modules')
    .where({ status: 'approved' })
    .where(function () {
      this.whereNull('valid_to').orWhere('valid_to', '>', db.fn.now());
    })
    .orderBy('version', 'desc');
  const modules = {};
  for (const row of rows) {
    if (!modules[row.key]) modules[row.key] = row;
  }
  return modules;
}

async function loadFertilizerRule(db, jurisdictionId) {
  if (jurisdictionId === 'generic_swfl') {
    return {
      jurisdiction_id: 'generic_swfl',
      jurisdiction_name: 'Southwest Florida service area',
      version: 'generic-2026-05-30',
      public_summary: 'Local fertilizer rules may affect nitrogen or phosphorus applications during certain months.',
      nitrogen_restricted: true,
      phosphorus_restricted: true,
      phosphorus_soil_test_required: true,
      restricted_start_month: 6,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
    };
  }
  return db('jurisdiction_fertilizer_rules')
    .where({ jurisdiction_id: jurisdictionId, status: 'approved' })
    .orderBy('version', 'desc')
    .first();
}

function approvedModuleText(modules, key, fallback = '') {
  return modules[key]?.plain_text || fallback;
}

function estimateSnapshot(estimate = {}, estimateData = {}) {
  return {
    id: estimate.id || null,
    customerName: estimate.customer_name || estimate.customerName || null,
    customerId: estimate.customer_id || estimate.customerId || null,
    leadId: estimate.lead_id || estimate.leadId || null,
    address: estimate.address || null,
    customerPhone: estimate.customer_phone || estimate.customerPhone || null,
    customerEmail: estimate.customer_email || estimate.customerEmail || null,
    monthlyTotal: estimate.monthly_total || estimate.monthlyTotal || null,
    oneTimeTotal: estimate.onetime_total || estimate.onetimeTotal || null,
    tier: estimate.waveguard_tier || estimate.tier || estimateData.tier || null,
    serviceInterest: estimate.service_interest || estimate.serviceInterest || estimateData.serviceInterest || null,
    token: estimate.token || null,
  };
}

function addressSummary(address) {
  const parts = String(address || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(0, 2).join(', ');
  return parts[0] || 'Service property';
}

function estimateViewPath(estimate) {
  if (!estimate?.token) return null;
  return `/estimate/${encodeURIComponent(estimate.token)}`;
}

function makeSection(key, title, body, bullets = []) {
  return {
    key,
    title,
    body,
    bullets: bullets.filter(Boolean),
  };
}

function turfPriorities(turfType) {
  if (turfType === 'st_augustine') {
    return [
      'Density and color support',
      'Chinch bug scouting',
      'Weed and sedge pressure monitoring',
      'Disease, irrigation, heat, shade, and thatch observations',
      'Soil-test-gated fertility decisions',
    ];
  }
  if (turfType === 'bermuda') {
    return [
      'Active growth and density management',
      'Seasonal nitrogen planning',
      'Armyworm and mole cricket scouting',
      'Disease risk review and winter dormancy expectations',
      'Growth-regulator documentation where used',
    ];
  }
  if (turfType === 'zoysia') {
    return [
      'Conservative fertility and growth stimulation',
      'Large patch monitoring and prevention',
      'Irrigation control and overwatering observations',
      'Thatch monitoring',
      'Weed control without over-stressing turf',
    ];
  }
  if (turfType === 'bahia') {
    return [
      'Realistic improvement for low-input turf',
      'Irrigated versus non-irrigated classification',
      'Mole cricket monitoring',
      'Weed reduction',
      'Seed head and dormancy expectations',
    ];
  }
  if (turfType === 'mixed') {
    return [
      'Confirm turf zones before product-specific decisions',
      'Avoid product assumptions that fit one turf but not another',
      'Document shaded, non-irrigated, high-traffic, or new-sod areas',
    ];
  }
  return [
    'Confirm grass type during the first lawn assessment',
    'Document irrigation, weed pressure, pest pressure, disease indicators, and stress',
    'Hold turf-specific product details until the lawn type is confirmed',
  ];
}

function buildTreatmentCategories({ turfType, visit, seasonBand }) {
  const base = [
    { label: 'Lawn assessment', reason: 'Technician observations decide what the lawn actually needs.' },
    { label: 'Weed and sedge management', reason: 'Used when turf type, weed pressure, temperature, and label directions allow.' },
    { label: 'Pest scouting', reason: 'The target pest changes by turf type, season, and symptoms.' },
    { label: 'Iron, micronutrients, and stress support', reason: 'Supports color and turf health without always pushing growth.' },
    { label: 'Post-service reporting', reason: 'The report shows what was actually done and any customer action items.' },
  ];
  if (['jan_mar', 'apr_may'].includes(seasonBand)) {
    base.splice(1, 0, { label: 'Prevention and spring preparation', reason: 'Seasonal timing helps reduce preventable weed and pest problems.' });
  }
  if (seasonBand === 'jun_sep') {
    base.splice(1, 0, { label: 'Summer stress strategy', reason: 'Summer visits often avoid unnecessary growth pushing and focus on stress and pest pressure.' });
  }
  if (seasonBand === 'oct_dec') {
    base.splice(1, 0, { label: 'Recovery and winter preparation', reason: 'Fall and winter visits may focus on recovery, disease risk, potassium, magnesium, and dormancy expectations.' });
  }
  if (turfType === 'st_augustine') base.push({ label: 'Chinch bug and large patch checks', reason: 'St. Augustine can be vulnerable to insect and disease pressure in Southwest Florida.' });
  if (turfType === 'bermuda') base.push({ label: 'Growth response and armyworm checks', reason: 'Bermuda is a higher-input turf that benefits from active monitoring.' });
  if (turfType === 'zoysia') base.push({ label: 'Large patch and thatch monitoring', reason: 'Zoysia is managed conservatively to avoid creating disease and thatch pressure.' });
  if (turfType === 'bahia') base.push({ label: 'Mole cricket and expectation management', reason: 'Bahia is low-input turf; pest monitoring and realistic expectations matter.' });
  if (visit) {
    base.push({ label: `${visit.month} protocol context`, reason: 'The current visit window shapes what may be inspected, held, or applied.' });
  }
  return base;
}

// GATE_LAWN_OUTLINE_V13 words. The month sentences and the "why now" text are the lawn
// report's own (service-report/lawn-program-line.js, proven against the v13 recipe there);
// these are the rest. No product name, rate, tier, visit count, or date.
const V13_COPY = Object.freeze({
  title: 'Your Waves Lawn Care Program Overview',
  programTitle: 'One Program For Your Lawn',
  programBody: 'Waves runs one lawn program for every grass type we treat. Each visit starts with a check of the whole lawn, then weeds, insects, and disease are treated as spot treatments where the lawn shows them. Every product is used within its label for your grass type.',
  programBullets: Object.freeze([
    'One whole-lawn application at most visits, by hose or spreader, plus spot treatments where needed',
    'Fertilizer on a set calendar that follows local fertilizer rules',
    'Chinch bugs counted before any chinch bug treatment',
    'Disease prevention on areas with a known history, such as large patch',
  ]),
  programYearTitle: 'Your Lawn Program Through The Year',
  programYearBody: 'Each visit follows the step for the month it falls in. Spot treatments are made only where the lawn needs them.',
  gpsTracking: 'GPS on the service vehicle records when the technician arrives, which supports accountability and helps answer service questions.',
  unknownTurfBullet: 'The program is the same for every grass type we treat.',
  mixedTurfBullet: 'Spot treatments follow the product label for the grass in each area.',
});

const V13_TREATMENT_CATEGORIES = Object.freeze([
  { label: 'Lawn inspection', reason: 'Every visit starts with a check of the whole lawn, and July visits are inspections with spot treatments only.' },
  { label: 'Fertilizer and nutrition', reason: 'Granular fertilizer on a set calendar, outside the local summer fertilizer limits.' },
  { label: 'Pre-emergent weed control', reason: 'A weed barrier that stops weeds before they sprout, applied a few times a year where it fits the lawn, never on new sod or thin turf. It needs about 1/2 inch of rain or irrigation within 14 days, and your regular watering counts.' },
  { label: 'Micronutrients', reason: 'Iron and other micronutrients that support color without pushing growth, including in summer when nitrogen is not allowed.' },
  { label: 'Weed spot treatment', reason: 'Weeds are treated where they grow, not across the whole lawn.' },
  { label: 'Insect control', reason: 'Chinch bugs are counted before treatment, and most insect treatments go only where insects are found.' },
  { label: 'Disease control', reason: 'Treatment for active disease, plus prevention on areas mapped for large patch or take-all root rot.' },
  { label: 'Wetting agent', reason: 'Helps water soak into dry spots.' },
  { label: 'Post-service reporting', reason: 'The report shows what was actually done and any customer action items.' },
].map((item) => Object.freeze(item)));

const V13_NO_BAHIA_PROGRAM_ERROR = 'Bahiagrass has no lawn program (Celsius and Blindside are not labeled for bahiagrass); the office reviews each bahia lawn before quoting. Pick the grass the lawn has to send an outline.';

function productNeedlesFromVisit(visit) {
  const text = `${visit?.primary || ''}\n${visit?.secondary || ''}`;
  const names = new Set();
  for (const line of protocolLines(text)) {
    const cleaned = line
      .replace(/^if\s+/i, '')
      .replace(/^or\s+/i, '')
      .replace(/^blackout\s*[-:]\s*/i, '')
      .replace(/^premium:\s*/i, '')
      .trim();
    const candidate = cleaned.split(/ if | — | - |:| broadleaf| preventive| fert| fertilizer| foliar| liquid| scout| check| audit/i)[0].trim();
    if (candidate && candidate.length >= 4 && !/^(soil sample|all tiers|customer|pre-position|dormancy|no atrazine|speedzone safe)$/i.test(candidate)) {
      names.add(candidate);
    }
  }
  return [...names];
}

async function loadEligibleProductCards(db, { turfType, visit, includeProductCards, productCardReason }) {
  if (!includeProductCards || !visit || ['unknown', 'mixed'].includes(turfType)) return [];
  const needles = productNeedlesFromVisit(visit);
  if (!needles.length) return [];

  const rows = await db('products_catalog')
    .where('approved_for_estimate_packet', true)
    .whereIn('customer_visibility', ['public', 'portal_only'])
    .whereIn('content_status', ['approved_for_public', 'approved_for_portal', 'approved'])
    .select(
      'id',
      'name',
      'category',
      'product_type',
      'active_ingredient',
      'epa_reg_number',
      'fertilizer_analysis',
      'public_summary',
      'portal_summary',
      'customer_safety_summary',
      'customer_precaution_summary',
      'pet_kid_guidance_text',
      'reentry_text',
      'reentry_summary',
      'label_verified_at',
      'label_version',
      'review_due_at',
      'content_status',
      'approved_for_estimate_packet',
    )
    .limit(250);

  const cards = [];
  for (const row of rows) {
    const rowName = String(row.name || '').toLowerCase();
    const match = needles.find((needle) => {
      const n = String(needle || '').toLowerCase();
      return n.length >= 4 && (rowName.includes(n) || n.includes(rowName));
    });
    if (!match) continue;
    const category = String(row.category || '').toLowerCase();
    const productType = row.product_type
      || (/(herbicide|insecticide|fungicide|pgr|growth)/.test(category) ? 'pesticide' : category || 'other');
    const epaNumber = String(row.epa_reg_number || '').trim();
    if (productType === 'pesticide' && (!epaNumber || /^(n\/a|not epa|none)$/i.test(epaNumber))) continue;
    cards.push({
      id: row.id,
      name: row.name,
      category: row.category || 'Lawn care product',
      productType,
      activeIngredient: row.active_ingredient || null,
      epaRegistrationNumber: productType === 'pesticide' ? epaNumber : null,
      fertilizerAnalysis: row.fertilizer_analysis || null,
      summary: row.public_summary || row.portal_summary || 'This product may be used when site conditions, turf type, season, label directions, and local rules allow.',
      precaution: row.customer_precaution_summary || row.customer_safety_summary || row.pet_kid_guidance_text || null,
      reentry: row.reentry_summary || row.reentry_text || null,
      labelVerifiedAt: row.label_verified_at || null,
      labelVersion: row.label_version || null,
      relevanceReason: productCardReason(row.name, visit, turfType),
    });
    if (cards.length >= 8) break;
  }
  return cards;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderOutlineHtml(content) {
  const sections = (content.sections || []).map((section) => `
    <section>
      <h2>${escapeHtml(section.title)}</h2>
      <p>${escapeHtml(section.body)}</p>
      ${(section.bullets || []).length ? `<ul>${section.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>` : ''}
    </section>
  `).join('');
  return `
    <article class="service-outline-packet">
      <h1>${escapeHtml(content.title)}</h1>
      <p>${escapeHtml(content.intro)}</p>
      ${sections}
    </article>
  `;
}

function validateContent(content, { turfType, includeProductCards, jurisdictionRule, noProgram = false }) {
  const text = JSON.stringify(content).toLowerCase();
  const errors = [];
  const warnings = [];
  for (const phrase of BANNED_PHRASES) {
    if (text.includes(phrase)) errors.push(`Banned phrase detected: ${phrase}`);
  }
  if (noProgram) errors.push(V13_NO_BAHIA_PROGRAM_ERROR);
  if (includeProductCards && ['unknown', 'mixed'].includes(turfType)) {
    errors.push('Product cards cannot be sent until turf type is confirmed for unknown or mixed turf.');
  }
  if (!jurisdictionRule?.jurisdiction_id) {
    errors.push('Local fertilizer rule could not be resolved.');
  }
  for (const card of content.productCards || []) {
    if (card.productType === 'pesticide' && !card.epaRegistrationNumber) {
      errors.push(`${card.name} is missing an EPA registration number.`);
    }
    if (!card.summary) errors.push(`${card.name} is missing approved customer summary copy.`);
    if (!card.labelVerifiedAt && card.productType === 'pesticide') {
      warnings.push(`${card.name} has no label verification date.`);
    }
  }
  if (!(content.sections || []).length) errors.push('Packet has no content sections.');
  return {
    status: errors.length ? 'blocked' : warnings.length ? 'warning' : 'passed',
    errors,
    warnings,
  };
}

function createPublicToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hashNullable(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// The sections both outlines share, word for word.
function sharedSections({ modules, customerName, jurisdictionRule }) {
  return {
    propertySummaryBody: `This outline is based on the current lawn estimate for ${customerName}. Treatment decisions are finalized by turf condition, weather, product labels, and local rules at the time of service.`,
    ruleAreaBullet: jurisdictionRule?.jurisdiction_name ? `Rule area: ${jurisdictionRule.jurisdiction_name}` : 'Rule area: to be confirmed',
    ruleSummaryBullet: jurisdictionRule?.public_summary || 'Local fertilizer rules may affect what nutrient products can be used.',
    typicalVisit: makeSection(
      'typical_visit',
      'What A Typical Visit Includes',
      approvedModuleText(modules, 'assessment_protocol'),
      [
        'Lawn condition assessment before application decisions',
        'Weed, sedge, insect, disease, irrigation, mowing, shade, heat, and drought observations',
        'Treatment decisions adjusted to turf type and current conditions',
        'Customer notes and follow-up items when the lawn needs action outside the treatment itself',
      ],
    ),
    safety: makeSection(
      'safety',
      'Safety And Product Transparency',
      approvedModuleText(modules, 'safety_and_label_compliance'),
      [
        'After a treatment, follow the technician service report and any product-specific instructions.',
        'As a general precaution, people and pets should stay off treated areas until the application has dried, unless the label or technician instructions require longer.',
        'Fertilizers, soil amendments, wetting agents, and biostimulants may not have EPA registration numbers because they are not pesticide products.',
      ],
    ),
    postServiceReports: makeSection(
      'post_service_reports',
      'Post-Service Reports',
      approvedModuleText(modules, 'post_service_reports'),
      [
        'Service date, technician, service type, and areas serviced',
        'Products actually applied, including EPA registration numbers where applicable',
        'Photos, lawn observations, technician notes, what to expect, and customer action items',
      ],
    ),
    portalTracking: (gpsText) => makeSection(
      'portal_tracking',
      'Portal, Reminders, And GPS-Tracked Service History',
      [
        gpsText,
        approvedModuleText(modules, 'service_reminders'),
        approvedModuleText(modules, 'customer_portal'),
      ].join(' '),
      [
        'Upcoming-visit and completed-service reminders',
        'Customer portal history for reports, photos, invoices, recommendations, and communication',
        'GPS-tracked service history for accountability and service review',
      ],
    ),
    notIncluded: makeSection('not_included', 'What This Does Not Include', approvedModuleText(modules, 'what_this_does_not_include')),
  };
}

function legacySections({ modules, shared, snapshot, tier, turf, turfText, month, seasonText, seasonBand, visit, restrictedSeasonActive }) {
  const sections = [
    makeSection(
      'property_summary',
      'Property Summary',
      shared.propertySummaryBody,
      [
        `Service area: ${addressSummary(snapshot.address)}`,
        `Service tier: ${tier}`,
        `Turf type: ${turf.label}`,
      ],
    ),
    makeSection('your_turf_type', `Your Turf Type: ${turf.label}`, turfText, turfPriorities(turf.turfType)),
    makeSection('season_focus', `${MONTHS[month - 1]} Service Focus`, seasonText, visit ? customerProtocolBullets(visit) : []),
    shared.typicalVisit,
    makeSection(
      'treatment_categories',
      'Products Or Treatment Categories That May Be Relevant',
      approvedModuleText(modules, 'product_transparency'),
      buildTreatmentCategories({ turfType: turf.turfType, visit, seasonBand }).map((item) => `${item.label}: ${item.reason}`),
    ),
    makeSection(
      'local_rules',
      'Local Fertilizer-Rule Note',
      approvedModuleText(modules, 'local_fertilizer_rules'),
      [
        shared.ruleAreaBullet,
        restrictedSeasonActive ? 'Restricted-season logic is active for this month.' : 'Restricted-season logic is not active for this month.',
        shared.ruleSummaryBullet,
      ],
    ),
    shared.safety,
    shared.postServiceReports,
    shared.portalTracking(approvedModuleText(modules, 'gps_tracking')),
    shared.notIncluded,
  ];

  if (turf.turfType === 'unknown') {
    sections.splice(3, 0, makeSection(
      'limited_outline',
      'Limited Outline Until Turf Is Confirmed',
      approvedModuleText(modules, 'unknown_turf_summary'),
      ['Product-specific recommendations are intentionally hidden until the first lawn assessment confirms the turf type.'],
    ));
  }

  if (turf.turfType === 'mixed') {
    sections.splice(3, 0, makeSection(
      'mixed_turf_caution',
      'Mixed Turf Requires Confirmation',
      approvedModuleText(modules, 'mixed_turf_summary'),
      ['Admin confirmation is required before product-specific details are shown.'],
    ));
  }
  return sections;
}

// GATE_LAWN_OUTLINE_V13: the one v13 program. The month's "why now" text and the twelve month
// sentences are the lawn report's own; the grass is a fact here, not a program of its own.
function v13Sections({ modules, shared, snapshot, turf, month, visit }) {
  const sections = [
    makeSection(
      'property_summary',
      'Property Summary',
      shared.propertySummaryBody,
      [
        `Service area: ${addressSummary(snapshot.address)}`,
        turf.turfType === 'unknown' ? 'Turf type: To be confirmed at the first visit' : `Turf type: ${turf.label}`,
      ],
    ),
    makeSection('lawn_program', V13_COPY.programTitle, V13_COPY.programBody, V13_COPY.programBullets),
    makeSection('season_focus', `${MONTHS[month - 1]} Service Focus`, PROGRAM_DETAIL_V13[month]?.whyNow || '', visit ? v13FullOutlineBullets(visit) : []),
    makeSection('program_year', V13_COPY.programYearTitle, V13_COPY.programYearBody, MONTHS.map((_, index) => PROGRAM_LINES_V13[index + 1].line)),
    shared.typicalVisit,
    makeSection(
      'treatment_categories',
      'Products Or Treatment Categories That May Be Relevant',
      approvedModuleText(modules, 'product_transparency'),
      V13_TREATMENT_CATEGORIES.map((item) => `${item.label}: ${item.reason}`),
    ),
    makeSection('local_rules', 'Local Fertilizer-Rule Note', approvedModuleText(modules, 'local_fertilizer_rules'), [shared.ruleAreaBullet, shared.ruleSummaryBullet]),
    shared.safety,
    shared.postServiceReports,
    shared.portalTracking(V13_COPY.gpsTracking),
    shared.notIncluded,
  ];

  if (turf.turfType === 'unknown') {
    sections.splice(2, 0, makeSection(
      'grass_to_confirm',
      'Grass Type To Be Confirmed',
      approvedModuleText(modules, 'unknown_turf_summary'),
      [V13_COPY.unknownTurfBullet],
    ));
  }

  if (turf.turfType === 'mixed') {
    sections.splice(2, 0, makeSection(
      'mixed_turf_caution',
      'Mixed Turf Requires Confirmation',
      approvedModuleText(modules, 'mixed_turf_summary'),
      [V13_COPY.mixedTurfBullet],
    ));
  }
  return sections;
}

// The two outlines, chosen once per build: the gate-off outline exactly as before, and the v13
// one (GATE_LAWN_OUTLINE_V13).
const OUTLINES = Object.freeze({
  legacy: Object.freeze({
    contentLibraryVersion: CONTENT_LIBRARY_VERSION,
    resolveTurf,
    trackKey: (turfType) => turfType,
    sections: legacySections,
    title: (turf) => `Your Waves Lawn Care Program Overview for ${turf.label}`,
    propertyTurfType: (turf) => turf.label,
    treatmentCategories: ({ turf, visit, seasonBand }) => buildTreatmentCategories({ turfType: turf.turfType, visit, seasonBand }),
    productCardReason: (name, visit, turfType) => `${name} appears in the ${visit.month} ${TURF_LABELS[turfType]} protocol as a conditional or seasonal option.`,
    noProgram: () => false,
  }),
  v13: Object.freeze({
    contentLibraryVersion: V13_CONTENT_LIBRARY_VERSION,
    resolveTurf: resolveTurfV13,
    trackKey: v13TrackKey,
    sections: v13Sections,
    title: () => V13_COPY.title,
    propertyTurfType: (turf) => (turf.turfType === 'unknown' ? null : turf.label),
    treatmentCategories: () => V13_TREATMENT_CATEGORIES.map((item) => ({ ...item })),
    productCardReason: (name, visit) => `${name} appears in the ${visit.month} lawn program as a conditional or seasonal option.`,
    noProgram: (turf) => bahiaHasNoProgram(turf.turfType),
  }),
});

function outlineVariant() {
  return outlineV13Live() ? OUTLINES.v13 : OUTLINES.legacy;
}

async function buildOutline({ db, estimate, input = {}, now = new Date() }) {
  const variant = outlineVariant();
  const estimateData = parseJsonMaybe(estimate.estimate_data || estimate.estimateData) || {};
  const month = Number(input.month || currentMonthNumber(now));
  const seasonBand = resolveSeasonBand(month);
  const modules = await loadApprovedModules(db);
  const turf = variant.resolveTurf({ estimate, estimateData, input });
  const jurisdictionId = input.jurisdictionId || resolveJurisdictionId(estimate.address);
  const jurisdictionRule = await loadFertilizerRule(db, jurisdictionId);
  const restrictedSeasonActive = isRestrictedSeason(jurisdictionRule, month);
  const ruleJurisdictionId = jurisdictionRule?.jurisdiction_id || jurisdictionId;
  const trackKey = variant.trackKey(turf.turfType);
  const track = protocolTrack(trackKey);
  const visit = protocolVisitForMonth(trackKey, month);
  const includeProductCards = input.includeProductCards === true;
  const productCards = await loadEligibleProductCards(db, { turfType: turf.turfType, visit, includeProductCards, productCardReason: variant.productCardReason });
  const seasonText = approvedModuleText(modules, SEASON_MODULE_KEYS[seasonBand]);
  const turfText = approvedModuleText(modules, TURF_MODULE_KEYS[turf.turfType], approvedModuleText(modules, 'unknown_turf_summary'));
  const snapshot = estimateSnapshot(estimate, estimateData);
  const customerName = firstNonEmpty(snapshot.customerName, 'your property');
  const tier = firstNonEmpty(input.serviceTier, snapshot.tier, estimateData.serviceTier, 'lawn care');

  const sections = variant.sections({
    modules,
    shared: sharedSections({ modules, customerName, jurisdictionRule }),
    snapshot,
    tier,
    turf,
    turfText,
    month,
    seasonText,
    seasonBand,
    visit,
    restrictedSeasonActive,
  });

  const content = {
    title: variant.title(turf),
    intro: 'Based on your estimate, this outline explains how Waves approaches your lawn care program, what we assess each visit, why treatments change by season, and how your service is documented.',
    generatedAt: now.toISOString(),
    detailLevel: input.detailLevel || 'standard',
    property: {
      customerName: snapshot.customerName,
      addressSummary: addressSummary(snapshot.address),
      turfType: variant.propertyTurfType(turf),
      serviceTier: tier,
    },
    turf: {
      type: turf.turfType,
      label: turf.label,
      confidence: turf.confidence,
      mixed: turf.mixed,
      protocolTrackName: track?.name || null,
    },
    season: {
      month,
      monthName: MONTHS[month - 1],
      seasonBand,
      restrictedSeasonActive,
    },
    localRule: {
      jurisdictionId: ruleJurisdictionId,
      jurisdictionName: jurisdictionRule?.jurisdiction_name || null,
      version: jurisdictionRule?.version || null,
      summary: jurisdictionRule?.public_summary || null,
      restrictedSeasonActive,
    },
    sections,
    treatmentCategories: variant.treatmentCategories({ turf, visit, seasonBand }),
    productCards,
    cta: {
      label: snapshot.token ? 'View Estimate' : 'Request Callback',
      estimatePath: estimateViewPath(snapshot),
    },
  };

  const validation = validateContent(content, { turfType: turf.turfType, includeProductCards, jurisdictionRule, noProgram: variant.noProgram(turf) });

  return {
    estimateData,
    estimateSnapshot: snapshot,
    inputSnapshot: {
      ...input,
      month,
      seasonBand,
      jurisdictionId,
      includeProductCards,
      includeProductCategories: input.includeProductCategories !== false,
    },
    summary: {
      title: content.title,
      turfType: turf.turfType,
      turfLabel: turf.label,
      seasonBand,
      month,
      jurisdictionId: ruleJurisdictionId,
      restrictedSeasonActive,
      productCardCount: productCards.length,
      validationStatus: validation.status,
      serviceLineDetected: estimateHasLawnService(estimate, estimateData),
    },
    content,
    contentHtml: renderOutlineHtml(content),
    validation,
    meta: {
      turf,
      track,
      visit,
      jurisdictionRule,
      templateVersion: TEMPLATE_VERSION,
      contentLibraryVersion: variant.contentLibraryVersion,
      productRegistryVersion: PRODUCT_REGISTRY_VERSION,
      protocolVersion: protocolVersion(),
    },
  };
}

module.exports = {
  BANNED_PHRASES,
  CONTENT_LIBRARY_VERSION,
  PRODUCT_REGISTRY_VERSION,
  contentLibraryVersion,
  protocolVersion,
  TEMPLATE_VERSION,
  buildOutline,
  createPublicToken,
  currentMonthNumber,
  customerProtocolBullets,
  estimateHasLawnService,
  hashNullable,
  hashToken,
  normalizeTurfType,
  renderOutlineHtml,
  resolveJurisdictionId,
  resolveSeasonBand,
  validateContent,
};
