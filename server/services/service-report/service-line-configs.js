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

  if (/\b(lawn|turf|grass|weed|fertil|dethatch|top\s*dress|aerat|sod)\b/.test(text)) return 'lawn';
  if (text.includes('mosquito')) return 'mosquito';
  if (/\b(termite|wdo|bora|trelona)\b/.test(text)) return 'termite';
  if (/\b(rodent|rat|rats|mouse|mice|mole)\b/.test(text)) return 'rodent';
  if (/\b(tree|shrub|arborjet)\b/.test(text)) return 'tree_shrub';
  return 'pest';
}

function getServiceLineConfig(serviceLineOrType) {
  const key = SERVICE_LINE_CONFIGS[serviceLineOrType]
    ? serviceLineOrType
    : detectServiceLine(serviceLineOrType);
  return SERVICE_LINE_CONFIGS[key] || SERVICE_LINE_CONFIGS.pest;
}

module.exports = {
  SERVICE_LINE_IDS,
  SERVICE_LINE_CONFIGS,
  detectServiceLine,
  getServiceLineConfig,
};
