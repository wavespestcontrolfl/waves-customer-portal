const crypto = require('crypto');
const {
  bahiaHasNoProgram,
  isBahiaGrass,
  lawnProtocols,
  lawnV13AnyGrassTrack,
} = require('./lawn-program');
const { PROGRAM_DETAIL_V13 } = require('./service-report/lawn-program-line');
const { estimateHasBahiaLawn, estimateLawnGrassValues } = require('./estimate-bahia-review');
const featureGates = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const WATERING_COPY = require('../../shared/watering-copy.json');
const RAIN_COPY = require('../../shared/lawn-water-rain-copy.json');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TEMPLATE_VERSION = 'mvp-1';
const CONTENT_LIBRARY_VERSION = 'seed-v1';
const V13_CONTENT_LIBRARY_VERSION = 'lawn-v13-copy-2';
const V13_DETAIL_CONTENT_LIBRARY_VERSION = 'lawn-v13-detail-2';
const V13_VISUAL_CONTENT_LIBRARY_VERSION = 'lawn-v13-visual-2';
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

// GATE_LAWN_OUTLINE_DETAIL (live only with GATE_LAWN_OUTLINE_V13): the v13 outline with the detail sections.
// Off = the v13 outline exactly.
function outlineDetailLive() {
  return featureGates.lawnOutlineDetailLive?.() === true;
}

// GATE_LAWN_OUTLINE_VISUAL (live only with GATE_LAWN_OUTLINE_DETAIL): the new layout in lawn-outline-visual.js, for every lawn
// outline. Off = the detailed v13 outline exactly.
function outlineVisualLive() {
  return featureGates.lawnOutlineVisualLive?.() === true;
}

// The same categories, for every line of the month's step: the 12x step and each plan-size
// variant (the 9x April bag), so a category one plan size uses is never missing. A fertilizer
// analysis may have one-digit parts (44-0-0); Headway, Advion and the Topchoice add-on are v13 lines too.
// Each category also names the steps the page draws for it (V13_STEP_LABELS): the pre-emergent
// with fertilizer bag is a feeding and a weed barrier.
const V13_FULL_OUTLINE_CATEGORIES = [
  [/scout visit|inspect/i, 'Lawn inspection', ['inspection']],
  [/stonewall 0\.43%|dimension 0\.21%/i, 'Pre-emergent weed control with fertilizer', ['feeding', 'barrier']],
  [/stonewall|dimension/i, 'Pre-emergent weed control', ['barrier']],
  [/nutra-tech/i, 'Micronutrients', ['micros']],
  [/(?:^|[^\d.])\d{1,2}-\d{1,2}-\d{1,2}(?!\d)/, 'Fertilizer and nutrition', ['feeding']],
  [/tetrino|arena|talak|acelepryn|dylox|advion|topchoice/i, 'Insect control', ['insects']],
  [/artavia|velista|gravex|headway/i, 'Disease control', ['disease']],
  [/celsius|certainty|blindside|dismiss/i, 'Weed spot treatment', ['weeds']],
  [/dispatch|surfactant/i, 'Wetting agent', ['dry_spots']],
];

// The short names the year chart, the month chips and the treatment cards share, one per step: the
// trade's own names (owner 2026-10-24: "more broad, yet technical").
const V13_STEP_LABELS = Object.freeze({
  inspection: 'Inspection',
  feeding: 'Fertilizer',
  barrier: 'Pre-emergent',
  micros: 'Micronutrients',
  weeds: 'Weed control',
  insects: 'Insect control',
  disease: 'Disease control',
  dry_spots: 'Wetting agent',
});

function v13StepLines(visit) {
  const steps = [visit, ...Object.values(visit.cadenceVariants || {})];
  return steps.flatMap((step) => [...protocolLines(step?.primary), ...protocolLines(step?.secondary)]);
}

function v13OutlineCategory(line) {
  return V13_FULL_OUTLINE_CATEGORIES.find(([pattern]) => pattern.test(line)) || null;
}

function v13FullOutlineBullets(visit) {
  const labels = v13StepLines(visit).map((line) => v13OutlineCategory(line)?.[1]).filter(Boolean);
  return [...new Set(labels)]
    .map((label) => `${label} may be relevant when turf condition, weather, label directions, and local rules allow.`);
}

// A month's steps for the page: the whole-lawn step (the 12x primary lines), then what may be
// added as needed (spot lines and a plan-size variant's step), each step once. No visit, none.
function v13MonthSteps(visit) {
  const stepsOf = (lines) => [...new Set(lines.flatMap((line) => v13OutlineCategory(line)?.[2] || []))];
  if (!visit) return { main: [], asNeeded: [] };
  const main = stepsOf(protocolLines(visit.primary));
  return { main, asNeeded: stepsOf(v13StepLines(visit)).filter((step) => !main.includes(step)) };
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

// The same for the outline's own words: the v13 outline (GATE_LAWN_OUTLINE_V13), its detailed
// version (GATE_LAWN_OUTLINE_DETAIL) and the new layout (GATE_LAWN_OUTLINE_VISUAL) each stamp their own
// content version, so a flip shows outlines built before it as updated. The Estimates list's stale check reads it, so it reads the gates and
// the constants only.
function contentLibraryVersion() {
  if (!outlineV13Live()) return CONTENT_LIBRARY_VERSION;
  if (outlineVisualLive()) return V13_VISUAL_CONTENT_LIBRARY_VERSION;
  return outlineDetailLive() ? V13_DETAIL_CONTENT_LIBRARY_VERSION : V13_CONTENT_LIBRARY_VERSION;
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

function makeSection(key, title, body, bullets = [], visual = null) {
  return {
    key,
    title,
    body,
    bullets: bullets.filter(Boolean),
    ...(visual ? { visual } : {}),
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

// GATE_LAWN_OUTLINE_V13 words. The month's "why now" text is the lawn report's own
// (service-report/lawn-program-line.js, proven against the v13 recipe there); the year chart and
// the month chips are drawn from the recipe lines (V13_FULL_OUTLINE_CATEGORIES); these are the rest.
// Owner 2026-10-24: short and boxed ("pretty wordy ... have visuals"), one outline for every lawn,
// broad yet technical ("i dont think we make this for specific lawn types"; "85 or 90 percent of lawns
// we treat are st augustine"). No product name, rate, tier, visit count, date, or grass-specific line.
const V13_COPY = Object.freeze({
  title: 'Your Waves Lawn Care Program Overview',
  intro: (customerName) => `Based on your estimate for ${customerName}. The program follows the time of year. What each visit applies is set on site: your grass, your county's fertilizer rules, sun and shade, new sod, the weather, and the spots we map for insects, disease or bermudagrass.`,
  programLabel: 'Year-round, set to your lawn',
  programTitle: 'How Your Program Works',
  programBody: 'Most of the lawns we treat are St. Augustine, so the program is built around it. Each visit adjusts to the lawn in front of us, and every product is applied within its label.',
  programTiles: Object.freeze([
    { icon: 'whole_lawn', title: 'One whole-lawn pass per visit', text: 'A hose spray or a spreader pass at most visits; everything else is spot work' },
    { icon: 'spots', title: 'Spot work, not blanket spraying', text: "Weed, insect, and disease products go only where they are needed, apart from the month's whole-lawn pass" },
    { icon: 'count', title: 'Threshold counts first', text: 'Chinch bugs are counted with a bottomless can before any curative treatment' },
    { icon: 'rotate', title: 'Resistance management', text: 'Chemical groups are rotated to slow resistance in weeds, insects, and disease' },
  ].map((tile) => Object.freeze(tile))),
  focusNote: 'Each step depends on turf condition, weather, label directions, and local rules.',
  yearTitle: 'Your Year At A Glance',
  yearBody: 'Each visit follows the step for the month it falls in.',
  limitLabel: 'Local summer limits on nitrogen and phosphorus',
  treatmentsTitle: 'Treatments That May Be Used',
  treatmentsBody: 'Which ones a visit uses depends on the season, the weather, the label, local rules, and what the lawn shows.',
  visitSteps: Object.freeze([
    { icon: 'inspection', title: 'Check', text: 'Full inspection: color, density, weeds, insects, disease, irrigation coverage, and thatch' },
    { icon: 'decide', title: 'Decide', text: 'What to apply, set by what the lawn shows, the weather, the label, and local rules' },
    { icon: 'treat', title: 'Treat', text: "The month's whole-lawn pass, then spot treatments only where needed" },
    { icon: 'report', title: 'Report', text: 'Products with EPA numbers, findings, photos, and next steps for you' },
  ].map((step) => Object.freeze(step))),
  rulesTitle: 'Local Fertilizer Rules',
  rulesInstead: 'Micronutrients for color, inspection, and spot treatments, with no nitrogen or phosphorus',
  safetyTitle: 'Safety And Labels',
  safetyTiles: Object.freeze([
    { icon: 'label', title: 'Label directions', text: 'Every pesticide is applied according to its label' },
    { icon: 'reentry', title: 'Stay off until dry', text: 'People and pets stay off treated areas until the application has dried, unless the label says longer' },
    { icon: 'report', title: 'Follow your report', text: 'Your service report lists any product-specific instructions' },
    { icon: 'epa', title: 'EPA numbers', text: 'Registered pesticides carry one, listed on your report. Fertilizers, wetting agents, and soil amendments are not pesticides and have none' },
  ].map((tile) => Object.freeze(tile))),
  afterVisitTitle: 'After Each Visit',
  afterVisitTiles: Object.freeze([
    { icon: 'report', title: 'A service report', text: 'What was done, the products used with EPA numbers where they apply, photos, and any next steps' },
    { icon: 'reminders', title: 'Reminders', text: 'Before and after each visit, including when your report is ready' },
    { icon: 'portal', title: 'Your customer portal', text: 'Reports, invoices, photos, and messages in one place' },
    { icon: 'arrival', title: 'Arrival record', text: 'GPS on the service vehicle records when the technician arrives' },
  ].map((tile) => Object.freeze(tile))),
  notIncludedTitle: 'Not Included Unless Quoted',
  notIncludedTags: Object.freeze(['Irrigation repairs', 'Mowing', 'Sod', 'Seed', 'Topdressing', 'Cultural repairs', 'Heavy shade corrections']),
  notIncludedNote: 'Some lawn problems need separate work, or a change at home such as watering or mowing height.',
});

// The treatment cards: the steps the year chart draws, in its order, plus the report.
const V13_TREATMENT_CATEGORIES = Object.freeze([
  { key: 'inspection', reason: 'A full walk at every visit: color, density, weeds, insects, disease, irrigation coverage, and thatch. July visits are inspection and spot treatment only.' },
  { key: 'feeding', reason: 'Granular, polymer-coated slow-release nitrogen, usually with potassium. Never during the local summer limits on nitrogen and phosphorus.' },
  { key: 'barrier', reason: 'A herbicide barrier at the soil surface that stops weed seeds as they sprout. It needs about 1/2 inch of rain or irrigation within 14 days to activate; your regular watering counts. Never on new sod or thin turf.' },
  { key: 'micros', reason: 'Iron and other micronutrients for color without forcing growth. They carry the lawn through the summer limits on nitrogen.' },
  { key: 'weeds', reason: 'Post-emergent herbicide on existing weeds only, by backpack sprayer, never across the whole lawn.' },
  { key: 'insects', reason: 'Applied where insects are found, after a count for chinch bugs. The one whole-lawn insecticide goes on sunny turf in May, peak chinch bug season.' },
  { key: 'disease', reason: 'Fungicide on active disease, plus preventive passes on areas mapped for large patch (as the soil cools through 80\u00b0F in fall) and take-all root rot (spring and fall).' },
  { key: 'dry_spots', reason: 'A soil surfactant that helps water soak into dry, water-repellent spots.' },
  { key: 'report', label: 'Service report', reason: 'Lists each product applied with its EPA number where it has one, what was found, photos, and any action items.' },
].map((item) => Object.freeze({ ...item, label: item.label || V13_STEP_LABELS[item.key] })));

// The local-rule tiles: the rule area and its summary come from the jurisdiction rule the outline
// resolved; no dates (North Port differs from its county, owner "forget north port" 2026-10-09).
function v13RuleTiles(jurisdictionRule) {
  return [
    { icon: 'area', title: 'Your rule area', text: jurisdictionRule?.jurisdiction_name || 'To be confirmed' },
    { icon: 'calendar', title: 'What it limits', text: jurisdictionRule?.public_summary || 'Local fertilizer rules may affect what nutrient products can be used.' },
    { icon: 'micros', title: 'What we do instead', text: V13_COPY.rulesInstead },
  ];
}

const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const stepNames = (steps) => steps.map((step) => V13_STEP_LABELS[step]).join(', ');

// The year chart: every month's steps from the recipe, and the months the local rule limits.
function v13YearVisual(trackKey, jurisdictionRule) {
  const months = MONTHS.map((label, index) => ({
    month: index + 1,
    label,
    ...v13MonthSteps(protocolVisitForMonth(trackKey, index + 1)),
    limited: isRestrictedSeason(jurisdictionRule, index + 1),
  }));
  return { type: 'year', months, labels: V13_STEP_LABELS, limitLabel: months.some((m) => m.limited) ? V13_COPY.limitLabel : null };
}

// Text for a page or reader that does not draw the chart (the composer preview, the stored HTML).
function v13YearLines(visual) {
  return visual.months.map((m) => `${FULL_MONTHS[m.month - 1]}: ${stepNames(m.main)}${m.asNeeded.length ? `; as needed: ${stepNames(m.asNeeded)}` : ''}`);
}

function v13FocusVisual(visit) {
  const { main, asNeeded } = v13MonthSteps(visit);
  return {
    type: 'chips',
    items: [
      ...main.map((step) => ({ key: step, label: V13_STEP_LABELS[step], tier: 'main' })),
      ...asNeeded.map((step) => ({ key: step, label: V13_STEP_LABELS[step], tier: 'as_needed' })),
    ],
    note: V13_COPY.focusNote,
  };
}

const titledLines = (items) => items.map((item) => `${item.title}: ${item.text}`);

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

function legacySections({ modules, snapshot, tier, turf, turfText, month, seasonText, seasonBand, visit, restrictedSeasonActive, jurisdictionRule, customerName }) {
  const sections = [
    makeSection(
      'property_summary',
      'Property Summary',
      `This outline is based on the current lawn estimate for ${customerName}. Treatment decisions are finalized by turf condition, weather, product labels, and local rules at the time of service.`,
      [
        `Service area: ${addressSummary(snapshot.address)}`,
        `Service tier: ${tier}`,
        `Turf type: ${turf.label}`,
      ],
    ),
    makeSection('your_turf_type', `Your Turf Type: ${turf.label}`, turfText, turfPriorities(turf.turfType)),
    makeSection('season_focus', `${MONTHS[month - 1]} Service Focus`, seasonText, visit ? customerProtocolBullets(visit) : []),
    makeSection(
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
        jurisdictionRule?.jurisdiction_name ? `Rule area: ${jurisdictionRule.jurisdiction_name}` : 'Rule area: to be confirmed',
        restrictedSeasonActive ? 'Restricted-season logic is active for this month.' : 'Restricted-season logic is not active for this month.',
        jurisdictionRule?.public_summary || 'Local fertilizer rules may affect what nutrient products can be used.',
      ],
    ),
    makeSection(
      'safety',
      'Safety And Product Transparency',
      approvedModuleText(modules, 'safety_and_label_compliance'),
      [
        'After a treatment, follow the technician service report and any product-specific instructions.',
        'As a general precaution, people and pets should stay off treated areas until the application has dried, unless the label or technician instructions require longer.',
        'Fertilizers, soil amendments, wetting agents, and biostimulants may not have EPA registration numbers because they are not pesticide products.',
      ],
    ),
    makeSection(
      'post_service_reports',
      'Post-Service Reports',
      approvedModuleText(modules, 'post_service_reports'),
      [
        'Service date, technician, service type, and areas serviced',
        'Products actually applied, including EPA registration numbers where applicable',
        'Photos, lawn observations, technician notes, what to expect, and customer action items',
      ],
    ),
    makeSection(
      'portal_tracking',
      'Portal, Reminders, And GPS-Tracked Service History',
      [
        approvedModuleText(modules, 'gps_tracking'),
        approvedModuleText(modules, 'service_reminders'),
        approvedModuleText(modules, 'customer_portal'),
      ].join(' '),
      [
        'Upcoming-visit and completed-service reminders',
        'Customer portal history for reports, photos, invoices, recommendations, and communication',
        'GPS-tracked service history for accountability and service review',
      ],
    ),
    makeSection('not_included', 'What This Does Not Include', approvedModuleText(modules, 'what_this_does_not_include')),
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

const tilesSection = (key, title, body, tiles) => makeSection(key, title, body, titledLines(tiles), { type: 'tiles', items: tiles });

// GATE_LAWN_OUTLINE_DETAIL words (owner 2026-10-26: "this needs to be more detailed, and we should be using the
// protocols, and youtube transcripts to further develop it"; the decision page's choices, "do whatever you
// recommend"). Each fact is a v13 rule (server/config/lawn-protocol-v13.json notes and safety_rules), an approved
// report sentence (shared/watering-copy.json, shared/lawn-water-rain-copy.json) or a UF/IFAS fact; the month text
// stays the report's own (PROGRAM_DETAIL_V13). Still no rate, tier, visit count or visit date; product names come
// only from the product list below (decision D1-B).
const V13_DETAIL_COPY = Object.freeze({
  // v13 confirms chinch bugs at the edge of the damage (the float test only if unsure). "Spot", not "any": May's one
  // whole-lawn insect pass goes on sunny turf with no count first.
  confirmedTile: Object.freeze({ icon: 'count', title: 'Confirmed before treating', text: 'Chinch bugs and other insects are confirmed where the damage starts before any spot treatment' }),
  // A 9-visit plan skips some months, so the list says each visit follows its month (the v13 outline's own sentence).
  yearBody: 'Each visit follows the step for the month it falls in. This month and the next two are open. Tap any month to see what a visit then does and one thing to do at home.',
  // One thing to do at home each month, from the v13 visit rules (barrier water-in, holds, storm holds).
  atHome: Object.freeze({
    1: 'Run your normal watering day: that waters in the weed barrier.',
    2: 'Keep your normal mowing height; a low mow now sets back grass that is waking up.',
    3: 'Leave sprayed weeds alone while they brown out.',
    4: 'On your watering day, check that the sprinklers reach the strips by the driveway and sidewalk.',
    5: 'Text us a photo the day a dry-looking patch shows on a watered lawn.',
    6: 'When the daily rains start, turn the sprinklers off or down; the rain also waters in the weed barrier.',
    7: 'Moths flying up at dusk or chewed blades are worth a text.',
    8: 'Bag the clippings while caterpillars or leaf spot are active.',
    9: 'After a storm or flooding, text us a photo before the next visit.',
    10: 'When the rains stop, set the sprinklers back to your dry-season run and check every head.',
    11: 'Water in your early-morning window only; this is large patch season.',
    12: 'After a frost, stay off the white grass. A purple-red tint in the cold is a color change, not a disease.',
  }),
  problemsTitle: 'Problems We Watch For',
  problemsBody: 'How to spot the common Southwest Florida lawn problems, and what we do.',
  problemTiles: Object.freeze([
    { icon: 'insects', title: 'Chinch bugs', text: 'Yellow, then dry brown patches in hot, sunny spots, often beside pavement, spring through fall. A patch that stays dry on a watered lawn is a common sign: text us a photo. We confirm live bugs at the edge of the damage before treating, and rotate products because Florida chinch bugs resist some.' },
    { icon: 'insects', title: 'Caterpillars (sod webworm, armyworm)', text: 'Chewed, ragged blades, green droppings, or small moths flying up at dusk, June through fall; new sod is a magnet. We spot treat and recheck on the next visit, or sooner if you text us. Established St. Augustine usually grows back from the roots.' },
    { icon: 'insects', title: 'Mole crickets and grubs', text: 'Raised tunnels, turf that lifts like a loose carpet, or birds and armadillos digging in one area. In early summer we bait mole cricket tunnels: keep the sprinklers off that area for three days. Grubs and larger mole crickets get a granule on a spreader visit, watered in the same day.' },
    { icon: 'disease', title: 'Large patch', text: 'Tan or orange rings, October through May as the soil cools; extra water and scalping make it worse. It returns to the same damp spots, so we map them and treat them each fall. Do not put weed killer on a patch.' },
    { icon: 'disease', title: 'Take-all root rot', text: 'Thin, yellow patches with short, black roots. Overwatering and stress feed it, and it works on the roots for weeks before you see it. Once the roots are black, no spray brings that spot back, so mapped areas get a treatment in spring and fall.' },
    { icon: 'disease', title: 'Gray leaf spot', text: 'Tan-gray spots with dark edges on the blades in hot, humid weather. Some leaf spot is normal in a wet summer, even on treated lawns; it thins the grass but rarely kills it. We spot treat it.' },
    { icon: 'disease', title: 'Yellow streaks on Floratam or ProVista', text: 'Yellow streaks between the leaf veins, mostly September to January, with healthy roots and no chinch bugs, can be lethal viral necrosis. No spray fixes it. Call us before you re-sod: we send a sample to the UF plant lab at our cost, and new sod should be Palmetto or CitraBlue.' },
    { icon: 'area', title: 'A spot by a shrub, downspout, or low area', text: 'Often water, not a pest: a blocked sprinkler head, a downspout, a low spot that stays wet, or soil that sheds water. On your watering day, run each zone and look before adding minutes for one spot. Straight brown lines point to the mower or a sprinkler, not insects or disease.' },
    { icon: 'weeds', title: 'Weeds are clues', text: 'Dollarweed, doveweed and sedge mean soil that stays too wet; goosegrass means packed soil; annual bluegrass often follows a low mow. We spot treat them; fixing the cause helps keep them from coming back.' },
  ].map((tile) => Object.freeze(tile))),
  productsTitle: 'Products We May Use',
  productsBody: 'Each visit uses only what the lawn needs. Your service report names every product applied, with its EPA number.',
  afterTreatmentTitle: 'After A Treatment',
  afterTreatmentBody: 'Your service report lists any instructions for that visit. These are the common ones.',
  afterTreatmentTiles: Object.freeze([
    { icon: 'barrier', title: 'Water in the weed barrier', text: 'A weed barrier needs about 1/2 inch of rain or irrigation within 14 days to activate. Your regular watering day counts.' },
    { icon: 'reentry', title: 'Hold, or water in: your report says which', text: 'Weed sprays and some insect sprays need 24 hours with no sprinklers, and the mole cricket bait needs three days: turn the timer off for that long. If a hold falls on your watering day, skip that run. Some granular fertilizers and insect granules need the opposite: one sprinkler cycle within the time on your report.' },
    { icon: 'calendar', title: 'Mowing around a treatment', text: 'No mowing two days before or after a weed spray, or for 24 hours after a caterpillar spray.' },
    { icon: 'weeds', title: 'Leave sprayed weeds in place', text: 'They yellow and curl over one to three weeks; sedge is the slowest. Pulling them early interrupts the treatment.' },
  ].map((tile) => Object.freeze(tile))),
  wateringTitle: 'Your Part: Watering',
  wateringBody: 'Watering is the biggest part of lawn care you control.',
  wateringTiles: Object.freeze([
    { icon: 'dry_spots', title: 'When to water', text: `${WATERING_COPY.deficitAdvice} A full cycle puts down about 1/2 to 3/4 inch.` },
    { icon: 'rotate', title: 'Reset the timer by season', text: 'Down when the summer rains start, up when they stop, lower in winter. After a soaking rain, skip a run rather than shortening your runs: longer runs reach the roots better than short ones.' },
    { icon: 'inspection', title: 'Check your coverage', text: 'On your watering day, set a few straight-sided cans in a line, run the zone 15 minutes and measure. Uneven cans mean uneven coverage.' },
    { icon: 'label', title: 'Rain shutoff device', text: `${RAIN_COPY.sensorLine.split('. ')[0]}. They wear out in about two years: if the sprinklers run in the rain, replace it.` },
  ].map((tile) => Object.freeze(tile))),
  // Decision D2-A: only where the District's one-day order applies, and never after it ends. Source: the portal fact
  // register's SWFWMD Modified Phase III entry (fact sheet revised Oct. 12, 2026, verified 2026-10-24).
  wateringOrderTile: Object.freeze({ icon: 'calendar', title: 'Your watering day', text: 'Manatee and Sarasota are under a one-day-a-week order through March 31, 2027. Your city or county sets your day by address; check its schedule. Use the 12:01 to 4 a.m. window, not the evening one: blades that stay wet all night help large patch and leaf spot spread. Lots under an acre may use one window only. Reclaimed (purple-pipe) water follows your utility’s rules.' }),
  mowingTitle: 'Your Part: Mowing',
  mowingBody: 'We do not mow. If a crew mows for you, pass these along.',
  mowingTiles: Object.freeze([
    { icon: 'count', title: 'Mow high', text: 'St. Augustine: 3.5 to 4 inches. Other grasses and dwarf St. Augustine are cut lower: ask us for your lawn’s height.' },
    { icon: 'rotate', title: 'A third at a time, sharp blade', text: 'Never cut more than a third of the blade at once; if it got tall, step it down over a few mows. Keep the blade sharp: ragged brown tips mean it is dull.' },
    { icon: 'micros', title: 'Leave the clippings', text: 'They feed the lawn and do not add much thatch. Bag them only while caterpillars or leaf spot are active.' },
    { icon: 'disease', title: 'Dry grass, sick spot last', text: 'Mow when the grass is dry; mow a sick spot last and rinse the mower.' },
  ].map((tile) => Object.freeze(tile))),
  expectTitle: 'What To Expect',
  expectBody: 'A lawn changes over seasons, not days.',
  expectTiles: Object.freeze([
    { icon: 'barrier', title: 'A barrier stops seeds, not weeds already up', text: 'It does not stop sedge or dollarweed either; those get spot treatments. Weeds break through first along drives and walks, and heavy rain can wear a barrier down sooner; we spot treat the breakthrough.' },
    { icon: 'weeds', title: 'Some weeds wait for cooler months', text: 'Weed sprays have yearly label limits. If your lawn reaches them, weed sprays pause from April through October. Sedge and kyllinga are managed, not cured; thick grass is the long-term fix.' },
    { icon: 'calendar', title: 'Quiet visits are normal', text: 'A winter weed barrier visit can look like nothing happened; that is the point. While the lawn greens up we spot treat lightly, because heavy spraying delays green-up.' },
    { icon: 'feeding', title: 'Brown grass takes weeks to regrow', text: 'Once insects or disease are controlled, St. Augustine fills in by runners: a basketball-size patch can take about six weeks in the rainy season. Large thin spots usually do not fill in from November to February.' },
    { icon: 'barrier', title: 'New sod is handled differently', text: 'No weed barrier goes on sod in its first season, and new sod is where caterpillars show first. Planning sod or plugs? Tell us first.' },
    { icon: 'area', title: 'Some spots need a different fix', text: 'Deep shade, packed new-build soil, buried debris or a blocked sprinkler head limit any lawn program. Grass that never grew under a tree will not start now; trimming limbs or a planting bed works better.' },
  ].map((tile) => Object.freeze(tile))),
  questionsTitle: 'Common Questions',
  questionsBody: 'The questions we hear most, answered straight.',
  questionTiles: Object.freeze([
    { icon: 'micros', title: 'My lawn is yellow. Does it need more fertilizer?', text: 'Often not. On our alkaline soil, yellow St. Augustine is often short on iron, not nitrogen, and extra quick-release nitrogen can feed insects and disease.' },
    { icon: 'insects', title: 'Why not spray the whole lawn for bugs every visit?', text: 'Blanket sprays breed resistant chinch bugs and kill helpful insects, so we treat where we find them. The one exception is May, peak chinch bug season: one pass on hot, sunny turf, where they start.' },
    { icon: 'weeds', title: 'Should I put down weed-and-feed between visits?', text: 'Please skip it. The weed killer in it can reach shrub and tree roots, and extra products make it hard to tell what is working.' },
    { icon: 'area', title: 'Can you get rid of torpedograss?', text: 'Not without killing the St. Augustine around it. The fix is removing the patch and re-sodding, which is not part of the lawn program.' },
  ].map((tile) => Object.freeze(tile))),
});

// Decision D2-A: the order tile shows only for these rule areas, and only while the order runs. A stored outline keeps
// the tile, so the tile carries `until` and the page hides it after that day.
const WATERING_ORDER = Object.freeze({ jurisdictions: Object.freeze(['manatee_county_fl', 'sarasota_county_fl']), until: '2027-03-31' });

function v13WateringTiles(jurisdictionId, now) {
  const [whenToWater, ...rest] = V13_DETAIL_COPY.wateringTiles;
  const orderLive = WATERING_ORDER.jurisdictions.includes(jurisdictionId) && etDateString(now) <= WATERING_ORDER.until;
  return [whenToWater, ...(orderLive ? [{ ...V13_DETAIL_COPY.wateringOrderTile, until: WATERING_ORDER.until }] : []), ...rest];
}

// The month list: the year chart's steps per month, plus the report's "why now" line and the month's thing to do at
// home. The build month and the next two open; the rest open on a tap.
function v13MonthsVisual(trackKey, jurisdictionRule, month) {
  const year = v13YearVisual(trackKey, jurisdictionRule);
  const open = new Set([0, 1, 2].map((ahead) => ((Number(month) - 1 + ahead) % 12) + 1));
  return {
    ...year,
    type: 'months',
    months: year.months.map((m) => ({
      ...m,
      name: FULL_MONTHS[m.month - 1],
      visit: PROGRAM_DETAIL_V13[m.month]?.whyNow || '',
      atHome: V13_DETAIL_COPY.atHome[m.month],
      open: open.has(m.month),
    })),
  };
}

function v13MonthLines(visual) {
  return v13YearLines(visual).map((line, index) => `${line}. ${visual.months[index].visit} At home: ${visual.months[index].atHome}`);
}

// Decision D1-B: the products the outline's v13 track names (each recipe line names its catalog product before " — ";
// every month and plan size), under the step each serves, with the catalog's active ingredient, never a rate. A
// product that is also a fertilizer sits under its weed-barrier step. The optional add-on (its line says so) and the
// weed-mix surfactant are not program products.
const NOT_PROGRAM_LINE_RE = /optional add-on/i;
const NOT_PROGRAM_NAME_RE = /nonionic surfactant/i;

function v13TrackProducts(trackKey) {
  const byName = new Map();
  for (const visit of lawnProtocols()?.[trackKey]?.visits || []) {
    for (const line of v13StepLines(visit)) {
      const cut = line.indexOf(' — ');
      const steps = v13OutlineCategory(line)?.[2] || [];
      if (cut <= 0 || !steps.length || NOT_PROGRAM_LINE_RE.test(line)) continue;
      const name = line.slice(0, cut).trim();
      if (!NOT_PROGRAM_NAME_RE.test(name) && !byName.has(name)) byName.set(name, steps.includes('barrier') ? 'barrier' : steps[0]);
    }
  }
  return [...byName].map(([name, step]) => ({ name, step }));
}

// The catalog's active ingredient without strengths or an N-P-K analysis ("Clothianidin 50%" -> "clothianidin"). A
// fertilizer has none to show: its name carries its analysis.
function activeIngredientText(row) {
  if (!row || /fertilizer/i.test(`${row.product_type || ''} ${row.category || ''}`)) return null;
  const text = String(row.active_ingredient || '')
    .replace(/\d+(?:\.\d+)?\s*%/g, '')
    .replace(/\b\d{1,2}-\d{1,2}-\d{1,2}\b/g, '')
    .replace(/\(\s*\)/g, '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' + ');
  return text ? text.toLowerCase() : null;
}

// The catalog rows the Pest Control and Mosquito outlines read: one query by exact name, active rows only (a retired
// product never prints), the first row per name (a duplicate row with a stale formula never wins). A failed read is [],
// so the product section leaves out rather than showing names without their ingredients.
async function loadActiveCatalogRows(db, names) {
  let rows;
  try {
    rows = await db('products_catalog')
      .whereIn('name', names)
      .where('active', true)
      .select('name', 'display_name', 'active_ingredient', 'category', 'product_type');
  } catch {
    return [];
  }
  const seen = new Set();
  const first = [];
  for (const row of rows || []) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    first.push(row);
  }
  return first;
}

// The catalog read is one query by exact name (the v13 recipe uses catalog names). A failed read leaves the section
// out rather than showing names without their ingredients.
async function loadV13ProductList(db, trackKey) {
  const products = v13TrackProducts(trackKey);
  if (!products.length) return [];
  let rows;
  try {
    rows = await db('products_catalog')
      .whereIn('name', products.map((product) => product.name))
      .select('name', 'display_name', 'active_ingredient', 'category', 'product_type');
  } catch {
    return [];
  }
  const byName = new Map((rows || []).map((row) => [row.name, row]));
  return products
    .filter((product) => byName.get(product.name)?.category !== 'adjuvant')
    .map((product) => {
      const row = byName.get(product.name);
      const ingredient = activeIngredientText(row);
      // A name's own trailing bracket ("Artavia 2 SC (Azoxy)") gives way to the ingredient's.
      const name = row?.display_name || product.name;
      const label = ingredient ? name.replace(/\s*\([^)]*\)$/, '') : name;
      return { step: product.step, text: ingredient ? `${label} (${ingredient})` : label };
    });
}

function v13ProductsSection(productList) {
  const items = V13_TREATMENT_CATEGORIES
    .map((category) => ({ key: category.key, label: category.label, text: productList.filter((product) => product.step === category.key).map((product) => product.text).join('; ') }))
    .filter((item) => item.text);
  if (!items.length) return null;
  return makeSection('products', V13_DETAIL_COPY.productsTitle, V13_DETAIL_COPY.productsBody, items.map((item) => `${item.label}: ${item.text}`), { type: 'categories', items });
}

// GATE_LAWN_OUTLINE_V13: the one v13 program for every lawn, every section boxed (owner 2026-10-24):
// program tiles, month chips, a year chart, treatment cards that key its icons, the visit as four
// steps, rule, safety and after-visit tiles, and the exclusions as tags. Nothing in it depends on the
// grass: the grass only blocks a bahia lawn, which has no v13 program. Each drawn section keeps text
// bullets for readers that draw none (the composer preview, the stored HTML).
function v13Sections({ month, visit, trackKey, jurisdictionRule, productList = [], now = new Date(), visualPlan = null }) {
  const treatments = makeSection(
    'treatment_categories',
    V13_COPY.treatmentsTitle,
    V13_COPY.treatmentsBody,
    V13_TREATMENT_CATEGORIES.map((item) => `${item.label}: ${item.reason}`),
    { type: 'categories', items: V13_TREATMENT_CATEGORIES.map((item) => ({ key: item.key, label: item.label, text: item.reason })) },
  );
  const typicalVisit = makeSection('typical_visit', 'What A Typical Visit Includes', '', titledLines(V13_COPY.visitSteps), { type: 'steps', items: V13_COPY.visitSteps });
  const closing = [
    tilesSection('local_rules', V13_COPY.rulesTitle, '', v13RuleTiles(jurisdictionRule)),
    tilesSection('safety', V13_COPY.safetyTitle, '', V13_COPY.safetyTiles),
    tilesSection('after_visit', V13_COPY.afterVisitTitle, '', V13_COPY.afterVisitTiles),
    makeSection('not_included', V13_COPY.notIncludedTitle, '', V13_COPY.notIncludedTags, { type: 'tags', items: V13_COPY.notIncludedTags, note: V13_COPY.notIncludedNote }),
  ];
  if (!outlineDetailLive()) {
    const year = v13YearVisual(trackKey, jurisdictionRule);
    return [
      tilesSection('lawn_program', V13_COPY.programTitle, V13_COPY.programBody, V13_COPY.programTiles),
      makeSection('season_focus', `${MONTHS[month - 1]} Service Focus`, PROGRAM_DETAIL_V13[month]?.whyNow || '', visit ? v13FullOutlineBullets(visit) : [], v13FocusVisual(visit)),
      makeSection('program_year', V13_COPY.yearTitle, V13_COPY.yearBody, v13YearLines(year), year),
      treatments,
      typicalVisit,
      ...closing,
    ];
  }
  // GATE_LAWN_OUTLINE_DETAIL: the open month in the month list replaces the Service Focus box.
  const months = v13MonthsVisual(trackKey, jurisdictionRule, month);
  // GATE_LAWN_OUTLINE_VISUAL: the new layout (lawn-outline-visual.js) from the same pieces; it folds the rest into its own sections.
  if (visualPlan) {
    const monthList = () => makeSection('program_year', V13_COPY.yearTitle, V13_DETAIL_COPY.yearBody, v13MonthLines(months), months);
    return lawnOutlineVisual().visualSections({
      plan: visualPlan, trackKey, jurisdictionRule, productList, now, kit: visualKit(), parts: { typicalVisit, notIncluded: closing[3], monthList },
    });
  }
  const programTiles = V13_COPY.programTiles.map((tile) => (tile.icon === 'count' ? V13_DETAIL_COPY.confirmedTile : tile));
  return [
    tilesSection('lawn_program', V13_COPY.programTitle, V13_COPY.programBody, programTiles),
    makeSection('program_year', V13_COPY.yearTitle, V13_DETAIL_COPY.yearBody, v13MonthLines(months), months),
    tilesSection('problems', V13_DETAIL_COPY.problemsTitle, V13_DETAIL_COPY.problemsBody, V13_DETAIL_COPY.problemTiles),
    treatments,
    v13ProductsSection(productList),
    typicalVisit,
    tilesSection('after_treatment', V13_DETAIL_COPY.afterTreatmentTitle, V13_DETAIL_COPY.afterTreatmentBody, V13_DETAIL_COPY.afterTreatmentTiles),
    tilesSection('your_watering', V13_DETAIL_COPY.wateringTitle, V13_DETAIL_COPY.wateringBody, v13WateringTiles(jurisdictionRule?.jurisdiction_id, now)),
    tilesSection('your_mowing', V13_DETAIL_COPY.mowingTitle, V13_DETAIL_COPY.mowingBody, V13_DETAIL_COPY.mowingTiles),
    tilesSection('what_to_expect', V13_DETAIL_COPY.expectTitle, V13_DETAIL_COPY.expectBody, V13_DETAIL_COPY.expectTiles),
    tilesSection('common_questions', V13_DETAIL_COPY.questionsTitle, V13_DETAIL_COPY.questionsBody, V13_DETAIL_COPY.questionTiles),
    ...closing,
  ].filter(Boolean);
}

// The new layout lives in its own module, loaded only while GATE_LAWN_OUTLINE_VISUAL is live (it needs the converter and the
// seeder, which must never load with the gate off). It takes the outline's helpers in `kit` instead of requiring this file back.
const lawnOutlineVisual = () => require('./lawn-outline-visual');

function visualKit() {
  return {
    makeSection,
    protocolLines,
    protocolVisitForMonth,
    monthSteps: v13MonthSteps,
    outlineCategory: v13OutlineCategory,
    stepLabels: V13_STEP_LABELS,
    notProgramLine: NOT_PROGRAM_LINE_RE,
    productsSection: v13ProductsSection,
    wateringTiles: v13WateringTiles,
    detailCopy: V13_DETAIL_COPY,
  };
}

// The estimate's lawn plan ('rounds', 'months12' or 'unknown') while the new layout is live; null = the layout is off.
function visualPlanFor(estimateData) {
  return outlineVisualLive() ? lawnOutlineVisual().resolveLawnPlan(estimateData) : null;
}

// The words outside the sections (plan line, rounds intro); a null plan changes nothing.
function applyVisualContent(content, visualPlan) {
  return visualPlan ? lawnOutlineVisual().applyVisualContent(content, visualPlan) : content;
}

// The two outlines, chosen once per build: the gate-off outline exactly as before, and the v13
// one (GATE_LAWN_OUTLINE_V13).
const OUTLINES = Object.freeze({
  legacy: Object.freeze({
    resolveTurf,
    trackKey: (turfType) => turfType,
    sections: legacySections,
    title: (turf) => `Your Waves Lawn Care Program Overview for ${turf.label}`,
    intro: () => 'Based on your estimate, this outline explains how Waves approaches your lawn care program, what we assess each visit, why treatments change by season, and how your service is documented.',
    property: (turf) => ({ turfType: turf.label }),
    treatmentCategories: ({ turf, visit, seasonBand }) => buildTreatmentCategories({ turfType: turf.turfType, visit, seasonBand }),
    productCardReason: (name, visit, turfType) => `${name} appears in the ${visit.month} ${TURF_LABELS[turfType]} protocol as a conditional or seasonal option.`,
    noProgram: () => false,
    regenerationTurfType: (packet, snapshot) => packet?.turf_type || snapshot.turfType || null,
  }),
  v13: Object.freeze({
    resolveTurf: resolveTurfV13,
    trackKey: v13TrackKey,
    sections: v13Sections,
    title: () => V13_COPY.title,
    intro: (customerName) => V13_COPY.intro(customerName),
    // No grass on the customer page: the program line takes the turf type's place.
    property: () => ({ turfType: null, programLabel: V13_COPY.programLabel }),
    treatmentCategories: () => V13_TREATMENT_CATEGORIES.map((item) => ({ ...item })),
    productCardReason: (name, visit) => `${name} appears in the ${visit.month} lawn program as a conditional or seasonal option.`,
    noProgram: (turf) => bahiaHasNoProgram(turf.turfType),
    // Only the staff's own pick: the packet's turf_type may be a grass the old outline guessed.
    regenerationTurfType: (_packet, snapshot) => snapshot.turfType || null,
  }),
});

function outlineVariant() {
  return outlineV13Live() ? OUTLINES.v13 : OUTLINES.legacy;
}

// The grass a regenerated outline starts from. The v13 outline keeps only a grass staff picked (the
// packet's input snapshot) and otherwise re-reads the estimate, so a grass an older outline guessed
// (the bermudaSuppression flag read as Bermuda) is never carried forward as a pick.
function regenerationTurfType(packet) {
  return outlineVariant().regenerationTurfType(packet, packet?.input_snapshot_json || {});
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
  const productList = outlineDetailLive() ? await loadV13ProductList(db, trackKey) : [];
  const visualPlan = visualPlanFor(estimateData);
  const seasonText = approvedModuleText(modules, SEASON_MODULE_KEYS[seasonBand]);
  const turfText = approvedModuleText(modules, TURF_MODULE_KEYS[turf.turfType], approvedModuleText(modules, 'unknown_turf_summary'));
  const snapshot = estimateSnapshot(estimate, estimateData);
  const customerName = firstNonEmpty(snapshot.customerName, 'your property');
  const tier = firstNonEmpty(input.serviceTier, snapshot.tier, estimateData.serviceTier, 'lawn care');

  const sections = variant.sections({
    modules,
    customerName,
    snapshot,
    tier,
    turf,
    turfText,
    month,
    seasonText,
    seasonBand,
    visit,
    restrictedSeasonActive,
    trackKey,
    jurisdictionRule,
    productList,
    now,
    visualPlan,
  });

  const content = {
    title: variant.title(turf),
    intro: variant.intro(customerName),
    generatedAt: now.toISOString(),
    detailLevel: input.detailLevel || 'standard',
    property: {
      customerName: snapshot.customerName,
      addressSummary: addressSummary(snapshot.address),
      ...variant.property(turf),
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

  applyVisualContent(content, visualPlan);

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
      contentLibraryVersion: contentLibraryVersion(),
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
  regenerationTurfType,
  renderOutlineHtml,
  resolveJurisdictionId,
  resolveSeasonBand,
  validateContent,
  // Shared with the Tree & Shrub, Pest Control and Mosquito outlines (tree-shrub-, pest- and mosquito-service-outline.js).
  V13_COPY,
  WATERING_ORDER,
  activeIngredientText,
  loadActiveCatalogRows,
  addressSummary,
  estimateSnapshot,
  estimateViewPath,
  firstNonEmpty,
  isRestrictedSeason,
  loadFertilizerRule,
  makeSection,
  parseJsonMaybe,
};
