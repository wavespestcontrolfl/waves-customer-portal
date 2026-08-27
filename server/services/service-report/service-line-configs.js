const SERVICE_LINE_IDS = [
  'pest',
  'lawn',
  'mosquito',
  'termite',
  'rodent',
  'tree_shrub',
  'palm',
];

let normalizeServiceType = null;
let detectExistingServiceCategory = null;
try {
  ({ normalizeServiceType, detectServiceCategory: detectExistingServiceCategory } = require('../../utils/service-normalizer'));
} catch {
  normalizeServiceType = null;
  detectExistingServiceCategory = null;
}

const SERVICE_LINE_CONFIGS = {
  pest: {
    id: 'pest',
    displayName: 'WaveGuard pest control',
    swapModule: 'pest',
    metrics: [
      { key: 'on_site_min', label: 'On-site', unit: 'min', format: 'integer', source: 'computed' },
      { key: 'zones', label: 'Zones', format: 'ratio', source: 'aggregate', aggregate: 'count_zones' },
      { key: 'linear_ft', label: 'Linear ft', format: 'integer', source: 'aggregate', aggregate: 'sum_area' },
      { key: 'pressure_index', label: 'Pressure index', format: 'decimal_1', source: 'aggregate', aggregate: 'pressure_index' },
    ],
    allowedMethods: ['perimeter_spray', 'pin_stream', 'spot_treatment', 'bait_placement'],
    requiredOnComplete: ['applications', 'findings', 'advisory'],
    requiredPhotoCount: 4,
    advisoryDefaults: {
      exterior_reentry_min: 30,
      // Owner rule 2026-08-11: interior re-entry defaults to 2 hours
      // (supersedes 2026-08-03's 30-min default). The tech adjusts per
      // visit at completion via the CompletionPanel re-entry steppers;
      // after-the-fact corrections stay on the admin re-entry edit
      // (PATCH /admin/dispatch/:serviceId/reentry).
      interior_reentry_min: 120,
      irrigation_hold_hr: 24,
      pet_advisory: 'Keep pets off treated zones until dry.',
    },
  },
  lawn: {
    id: 'lawn',
    displayName: 'WaveGuard lawn care',
    swapModule: 'lawn',
    metrics: [
      { key: 'on_site_min', label: 'On-site', unit: 'min', format: 'integer', source: 'computed' },
      { key: 'zones', label: 'Zones', format: 'ratio', source: 'aggregate', aggregate: 'count_zones' },
      { key: 'area_sqft', label: 'Sq ft', format: 'integer', source: 'aggregate', aggregate: 'sum_area' },
      { key: 'pressure_index', label: 'Pressure index', format: 'decimal_1', source: 'aggregate', aggregate: 'pressure_index' },
    ],
    allowedMethods: ['broadcast_spray', 'spot_treatment', 'granular_broadcast'],
    requiredOnComplete: ['applications', 'findings', 'advisory'],
    requiredPhotoCount: 4,
    advisoryDefaults: {
      exterior_reentry_min: 30,
      interior_reentry_min: 0,
      irrigation_hold_hr: 24,
      pet_advisory: 'Keep pets off treated turf until dry.',
    },
  },
  mosquito: {
    id: 'mosquito',
    displayName: 'Mosquito control',
    swapModule: 'mosquito',
    metrics: [
      { key: 'on_site_min', label: 'On-site', unit: 'min', format: 'integer', source: 'computed' },
      { key: 'zones', label: 'Zones', format: 'ratio', source: 'aggregate', aggregate: 'count_zones' },
      { key: 'applications', label: 'Applications', format: 'integer', source: 'aggregate', aggregate: 'count_applications' },
      { key: 'pressure_index', label: 'Pressure index', format: 'decimal_1', source: 'aggregate', aggregate: 'pressure_index' },
    ],
    allowedMethods: ['fog_ulv', 'foliar_spray', 'spot_treatment'],
    requiredOnComplete: ['applications', 'findings', 'advisory'],
    requiredPhotoCount: 3,
    advisoryDefaults: {
      exterior_reentry_min: 30,
      interior_reentry_min: 0,
      irrigation_hold_hr: 12,
      pet_advisory: 'Keep pets away from treated landscape areas until dry.',
    },
  },
  termite: {
    id: 'termite',
    displayName: 'Termite service',
    swapModule: 'termite_rodent',
    metrics: [
      { key: 'on_site_min', label: 'On-site', unit: 'min', format: 'integer', source: 'computed' },
      { key: 'zones', label: 'Zones', format: 'ratio', source: 'aggregate', aggregate: 'count_zones' },
      { key: 'findings', label: 'Findings', format: 'integer', source: 'aggregate', aggregate: 'count_findings' },
      { key: 'pressure_index', label: 'Pressure index', format: 'decimal_1', source: 'aggregate', aggregate: 'pressure_index' },
    ],
    allowedMethods: ['station_check', 'spot_treatment', 'bait_placement'],
    requiredOnComplete: ['findings', 'advisory'],
    requiredPhotoCount: 4,
    advisoryDefaults: {
      exterior_reentry_min: 30,
      interior_reentry_min: 120,
      irrigation_hold_hr: 0,
      pet_advisory: 'Keep pets away from any open station work until closed.',
    },
  },
  rodent: {
    id: 'rodent',
    displayName: 'Rodent control',
    swapModule: 'termite_rodent',
    metrics: [
      { key: 'on_site_min', label: 'On-site', unit: 'min', format: 'integer', source: 'computed' },
      { key: 'zones', label: 'Zones', format: 'ratio', source: 'aggregate', aggregate: 'count_zones' },
      { key: 'findings', label: 'Findings', format: 'integer', source: 'aggregate', aggregate: 'count_findings' },
      { key: 'pressure_index', label: 'Pressure index', format: 'decimal_1', source: 'aggregate', aggregate: 'pressure_index' },
    ],
    allowedMethods: ['station_check', 'bait_placement', 'spot_treatment'],
    requiredOnComplete: ['findings', 'advisory'],
    requiredPhotoCount: 4,
    advisoryDefaults: {
      exterior_reentry_min: 0,
      interior_reentry_min: 0,
      irrigation_hold_hr: 0,
      pet_advisory: 'Keep pets away from bait stations and exclusion work areas.',
    },
  },
  tree_shrub: {
    id: 'tree_shrub',
    displayName: 'Tree and shrub care',
    swapModule: 'tree_shrub_palm',
    metrics: [
      { key: 'on_site_min', label: 'On-site', unit: 'min', format: 'integer', source: 'computed' },
      { key: 'zones', label: 'Zones', format: 'ratio', source: 'aggregate', aggregate: 'count_zones' },
      { key: 'applications', label: 'Applications', format: 'integer', source: 'aggregate', aggregate: 'count_applications' },
      { key: 'pressure_index', label: 'Pressure index', format: 'decimal_1', source: 'aggregate', aggregate: 'pressure_index' },
    ],
    allowedMethods: ['foliar_spray', 'spot_treatment', 'granular_broadcast'],
    requiredOnComplete: ['applications', 'findings', 'advisory'],
    requiredPhotoCount: 4,
    advisoryDefaults: {
      exterior_reentry_min: 30,
      interior_reentry_min: 0,
      irrigation_hold_hr: 24,
      pet_advisory: 'Keep pets off treated beds and foliage until dry.',
    },
  },
  palm: {
    id: 'palm',
    displayName: 'Palm care',
    swapModule: 'tree_shrub_palm',
    metrics: [
      { key: 'on_site_min', label: 'On-site', unit: 'min', format: 'integer', source: 'computed' },
      { key: 'zones', label: 'Zones', format: 'ratio', source: 'aggregate', aggregate: 'count_zones' },
      { key: 'applications', label: 'Applications', format: 'integer', source: 'aggregate', aggregate: 'count_applications' },
      { key: 'pressure_index', label: 'Pressure index', format: 'decimal_1', source: 'aggregate', aggregate: 'pressure_index' },
    ],
    allowedMethods: ['trunk_injection', 'foliar_spray', 'granular_broadcast'],
    requiredOnComplete: ['applications', 'findings', 'advisory'],
    requiredPhotoCount: 4,
    advisoryDefaults: {
      exterior_reentry_min: 30,
      interior_reentry_min: 0,
      irrigation_hold_hr: 24,
      pet_advisory: 'Keep pets away from treated palms and surrounding beds until dry.',
    },
  },
};

function detectServiceLine(serviceType) {
  const text = String(serviceType || '').toLowerCase();
  if (/\bpalmetto\b/.test(text)) return 'pest';
  if (/\bpalm(s)?\b/.test(text)) return 'palm';

  // Combined services ("Pest & Rodent Control", "Quarterly Pest + Termite
  // Bait Station"): a "pest" mention BEFORE the rodent/termite token marks
  // the pest-primary combined name — the companion token names a section,
  // not the report layout. Order matters: "Rodent Pest Control"
  // (rodent_general_one_time) leads with rodent and stays a rodent
  // report. Lawn/turf and mosquito mentions still win ("Lawn Pest
  // Treatment" stays lawn); names without "pest" are untouched.
  if (/\bpest\b.*\b(rodent|termite)\b/.test(text) && !/\b(lawn|turf|grass|weed|fertil|mosquito)\b/.test(text)) return 'pest';

  const directCategory = detectExistingServiceCategory ? detectExistingServiceCategory(serviceType) : null;
  if (directCategory === 'lawn') return 'lawn';
  if (directCategory === 'mosquito') return 'mosquito';
  if (directCategory === 'termite') return 'termite';
  if (directCategory === 'rodent') return 'rodent';
  if (directCategory === 'tree_shrub') return 'tree_shrub';

  const normalized = normalizeServiceType ? normalizeServiceType(serviceType) : serviceType;
  const category = detectExistingServiceCategory ? detectExistingServiceCategory(normalized || serviceType) : null;
  if (category === 'lawn') return 'lawn';
  if (category === 'mosquito') return 'mosquito';
  if (category === 'termite') return 'termite';
  if (category === 'rodent') return 'rodent';
  if (category === 'tree_shrub') return 'tree_shrub';

  // Tree/shrub tokens outrank fertil/weed here for the same reason as the
  // normalizer's early branch: "Tree & Shrub Fertilization" is a tree &
  // shrub visit, not a lawn one. Lawn-surface tokens still win.
  if (/\b(tree|shrub|ornamental|arborjet)\b/.test(text)
    && !/\b(lawn|turf|grass|sod|dethatch|aerat)\b/.test(text)) return 'tree_shrub';
  if (/\b(lawn|turf|grass|weed|fertil|dethatch|top\s*dress|aerat|sod)\b/.test(text)) return 'lawn';
  if (text.includes('mosquito')) return 'mosquito';
  // Foam matches only the drill-and-foam termite forms — bare 'foam' would
  // steal rodent-exclusion foam-sealing work from the rodent branch below.
  if (/\b(termite|wdo|bora|trelona)\b|foam[\s_-]*drill|drill[\s_&-]*(?:and[\s_-]*)?foam|recurring[\s_-]*foam|foam[\s_-]*recurring/.test(text)) return 'termite';
  if (/\b(rodent|rat|rats|mouse|mice|mole)\b|bird\s*box|roof-entry|trap[\s_-]*only/.test(text)) return 'rodent';
  if (/\b(tree|shrub|arborjet)\b/.test(text)) return 'tree_shrub';
  return 'pest';
}

function getServiceLineConfig(serviceLineOrType) {
  const key = SERVICE_LINE_CONFIGS[serviceLineOrType]
    ? serviceLineOrType
    : detectServiceLine(serviceLineOrType);
  return SERVICE_LINE_CONFIGS[key] || SERVICE_LINE_CONFIGS.pest;
}

// Owner rule 2026-08-11: cockroach-family visits default to a 2-hour
// INTERIOR re-entry window; the exterior dry-down default stays the pest
// line's 30. (The pest line's own interior default later moved to 120 the
// same day, making this a same-value guard — it stays so cockroach keeps
// its 2-hour floor even if the pest line default moves again.) Covers the
// whole family — cockroach control, German/native roach knockdowns and cleanouts,
// plus legacy "palmetto" service names (palmetto = native roach; the bare
// \bpalmetto\b token already maps to the pest line in detectServiceLine).
// Per-visit corrections still go through the admin re-entry edit
// (PATCH /admin/dispatch/:serviceId/reentry).
const COCKROACH_SERVICE_TYPE_RE = /\b(?:cock)?roach(?:es)?\b|\bpalmetto\b/i;
const COCKROACH_INTERIOR_REENTRY_MIN = 120;

function isCockroachServiceType(serviceType) {
  // Keyed catalog values (german_roach_cleanout) hide the word boundary
  // \broach\b needs — underscores are \w, so normalize _/- separators to
  // spaces before matching. Display names pass through unchanged.
  const text = String(serviceType || '').replace(/[_-]+/g, ' ');
  return COCKROACH_SERVICE_TYPE_RE.test(text);
}

// Termite visits with no liquid/foam application — station checks, bait
// monitoring, cartridge/installation work, inspections, warranty/bond
// renewals — have no re-entry concept: nothing is sprayed, so a dry-down
// countdown on the report is wrong (owner rule 2026-08-27). Liquid,
// pre-treat, trenching, spot and drill-and-foam termite forms keep the
// line's 30/120 defaults. Same normalize-then-match approach as the
// cockroach override above so keyed catalog values match too.
const TERMITE_NO_REENTRY_SERVICE_TYPE_RE =
  /\b(bait|station|monitor\w*|cartridge|installation|inspection|renewal|warranty|bond)\b/i;

function isTermiteNoReentryServiceType(serviceType) {
  const text = String(serviceType || '').replace(/[_-]+/g, ' ');
  return TERMITE_NO_REENTRY_SERVICE_TYPE_RE.test(text);
}

// Advisory defaults for a visit, keyed by the raw service TYPE (not the
// line id) so the cockroach and termite-station overrides can fire. Other
// types return their line's defaults unchanged.
function getAdvisoryDefaults(serviceType) {
  const config = getServiceLineConfig(serviceType);
  if (config.id === 'pest' && isCockroachServiceType(serviceType)) {
    return {
      ...config.advisoryDefaults,
      interior_reentry_min: COCKROACH_INTERIOR_REENTRY_MIN,
    };
  }
  if (config.id === 'termite' && isTermiteNoReentryServiceType(serviceType)) {
    return {
      ...config.advisoryDefaults,
      exterior_reentry_min: 0,
      interior_reentry_min: 0,
    };
  }
  return config.advisoryDefaults;
}

// Rodent-program companion services whose names carry no rodent token, so
// detectServiceLine alone can't claim them ("Exclusion Service",
// "Sanitation & Cleanup"). Used by the rodent report's next-visit pick —
// a rodent report may disclose these as the customer's next rodent-related
// visit. \w* covers the variants (trapping/traps, proofing). The negative
// guard keeps non-rodent trapping work out ("Wildlife Trapping", "Fly Trap
// Service" also fall to the pest default line) — owner rule is if and only
// if rodent-related.
const RODENT_ADJACENT_SERVICE_RE = /\b(exclusion|sanitation|proof|trap)\w*/i;
const NON_RODENT_TRAP_RE = /\b(wildlife|raccoon|squirrel|opossum|possum|armadillo|iguana|snake|bird|bat|hog|coyote|fly|flies|insect|pantry|moth|glue\s*board)\b/i;

function isRodentAdjacentServiceType(serviceType) {
  const text = String(serviceType || '');
  return RODENT_ADJACENT_SERVICE_RE.test(text) && !NON_RODENT_TRAP_RE.test(text);
}

module.exports = {
  SERVICE_LINE_IDS,
  SERVICE_LINE_CONFIGS,
  isRodentAdjacentServiceType,
  isCockroachServiceType,
  getAdvisoryDefaults,
  detectServiceLine,
  getServiceLineConfig,
};
