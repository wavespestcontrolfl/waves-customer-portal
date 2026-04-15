// ============================================================
// Estimate Presets — maps to form checkbox keys in EstimatePage.jsx
// To add a preset: add an entry with the svc* keys to enable.
// These are NOT database records — just UI shortcuts.
// ============================================================

const ESTIMATE_PRESETS = [
  // ── Popular ────────────────────────────────────────────────
  {
    id: 'bundle_pest_lawn',
    name: 'Pest + Lawn',
    icon: '\u{1F4E6}',
    description: 'Most popular combo — Silver tier (10% off)',
    popular: true,
    category: 'bundle',
    services: { svcPest: true, svcLawn: true },
    defaults: { pestFreq: '4', grassType: 'st_augustine' },
  },
  {
    id: 'pest_quarterly',
    name: 'Pest Control',
    icon: '\u{1F41B}',
    description: 'Interior & exterior quarterly treatment',
    popular: true,
    category: 'single',
    services: { svcPest: true },
    defaults: { pestFreq: '4' },
  },
  {
    id: 'lawn_program',
    name: 'Lawn Care',
    icon: '\u{1F33F}',
    description: 'Year-round fertilization & weed control',
    popular: true,
    category: 'single',
    services: { svcLawn: true },
    defaults: { grassType: 'st_augustine' },
  },

  // ── All Templates ──────────────────────────────────────────
  {
    id: 'mosquito',
    name: 'Mosquito',
    icon: '\u{1F99F}',
    description: 'Monthly mosquito barrier treatment',
    category: 'single',
    services: { svcMosquito: true },
  },
  {
    id: 'tree_shrub',
    name: 'Tree & Shrub',
    icon: '\u{1F333}',
    description: 'Quarterly ornamental care program',
    category: 'single',
    services: { svcTs: true },
  },
  {
    id: 'bundle_gold',
    name: 'Gold Bundle',
    icon: '\u{1F947}',
    description: 'Pest + lawn + mosquito — 15% off',
    category: 'bundle',
    services: { svcPest: true, svcLawn: true, svcMosquito: true },
    defaults: { pestFreq: '4', grassType: 'st_augustine' },
    tier: 'Gold',
  },
  {
    id: 'bundle_platinum',
    name: 'The Works',
    icon: '\u{1F451}',
    description: 'All 4 services — Platinum 18% off',
    category: 'bundle',
    services: { svcPest: true, svcLawn: true, svcMosquito: true, svcTs: true },
    defaults: { pestFreq: '4', grassType: 'st_augustine' },
    tier: 'Platinum',
  },
  {
    id: 'termite_bait',
    name: 'Termite Bait',
    icon: '\u{1F41C}',
    description: 'Bait station monitoring program',
    category: 'single',
    services: { svcTermiteBait: true },
  },
];

// All service checkbox keys — used to reset form before applying preset
export const ALL_SVC_KEYS = [
  'svcLawn', 'svcPest', 'svcTs', 'svcInjection', 'svcMosquito',
  'svcTermiteBait', 'svcRodentBait',
  'svcOnetimePest', 'svcOnetimeLawn', 'svcOnetimeMosquito',
  'svcPlugging', 'svcTopdress', 'svcDethatch', 'svcOverseed',
  'svcTrenching', 'svcBoracare', 'svcPreslab', 'svcFoam',
  'svcRodentTrap', 'svcRodentSanitation', 'svcFlea', 'svcWasp',
  'svcRoach', 'svcBedbug', 'svcExclusion',
];

export default ESTIMATE_PRESETS;
