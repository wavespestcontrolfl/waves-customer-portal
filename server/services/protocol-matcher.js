const MATCH_RULES = [
  {
    programKey: 'termite',
    visit: 4,
    reason: 'foam_drill',
    terms: ['foam', 'drill', 'void', 'localized'],
  },
  {
    programKey: 'termite',
    visit: 5,
    reason: 'wood_treatment',
    terms: ['bora', 'boracare', 'bora-care', 'wood treatment', 'borate'],
  },
  {
    programKey: 'termite',
    visit: 3,
    reason: 'liquid_perimeter',
    terms: ['liquid', 'trench', 'rod', 'termidor', 'perimeter', 'pre-slab', 'preslab'],
  },
  {
    programKey: 'termite',
    visit: 2,
    reason: 'bait_monitoring',
    terms: ['bait', 'station', 'monitoring', 'monitor'],
  },
  {
    programKey: 'termite',
    visit: 6,
    reason: 'renewal_inspection',
    terms: ['renewal', 'warranty', 'annual'],
  },
  {
    programKey: 'termite',
    visit: 1,
    reason: 'termite_inspection',
    terms: ['termite', 'wdo', 'wood destroying', 'swarmer', 'swarm'],
  },
  {
    programKey: 'pest',
    visit: 6,
    reason: 'mosquito_barrier',
    terms: ['mosquito', 'misting', 'barrier'],
  },
  {
    programKey: 'pest',
    visit: 5,
    reason: 'rodent_monitoring',
    terms: ['rodent', 'rat', 'mouse', 'mice', 'exclusion', 'trapping'],
  },
  {
    programKey: 'pest',
    visit: 2,
    reason: 'german_roach',
    terms: ['german roach', 'german cockroach', 'roach cleanout', 'cockroach', 'cleanout'],
  },
  {
    programKey: 'pest',
    visit: 3,
    reason: 'ant_service',
    terms: ['ant', 'ghost ant', 'fire ant', 'carpenter ant'],
  },
  {
    programKey: 'pest',
    visit: 4,
    reason: 'flea_tick',
    terms: ['flea', 'tick'],
  },
  {
    programKey: 'pest',
    visit: 1,
    reason: 'general_pest',
    terms: ['pest', 'quarterly', 'bimonthly', 'bi-monthly', 'monthly', 'perimeter'],
  },
  {
    programKey: 'tree_shrub',
    visit: 1,
    reason: 'tree_shrub',
    terms: ['tree', 'shrub', 'palm', 'ornamental'],
  },
];

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function programKeyForService(serviceType) {
  const normalized = normalize(serviceType);
  if (normalized.includes('lawn')) return 'lawn';
  if (normalized.includes('tree') || normalized.includes('shrub') || normalized.includes('palm')) return 'tree_shrub';
  if (normalized.includes('termite') || normalized.includes('wdo') || normalized.includes('bora') || normalized.includes('termidor')) return 'termite';
  return 'pest';
}

function findVisit(program, visitNumber) {
  return (program?.visits || []).find((visit) => Number(visit.visit) === Number(visitNumber)) || null;
}

function matchServiceProtocol(protocols, serviceType) {
  const normalized = normalize(serviceType);
  const fallbackProgramKey = programKeyForService(serviceType);
  const rules = MATCH_RULES.filter((rule) => {
    if (fallbackProgramKey === 'lawn') return false;
    return rule.programKey === fallbackProgramKey || fallbackProgramKey === 'pest';
  });
  const matchedRule = rules.find((rule) => rule.terms.some((term) => normalized.includes(normalize(term))));
  const programKey = matchedRule?.programKey || fallbackProgramKey;
  const program = protocols?.[programKey] || null;
  if (!program) return { programKey, program: null, matchedVisit: null, matched: false, reason: 'program_missing' };

  const fallbackVisit = program.visits?.[0] || null;
  const matchedVisit = matchedRule ? findVisit(program, matchedRule.visit) || fallbackVisit : fallbackVisit;

  return {
    programKey,
    program,
    matchedVisit,
    matched: !!matchedRule,
    reason: matchedRule?.reason || 'category_default',
  };
}

module.exports = {
  MATCH_RULES,
  matchServiceProtocol,
  programKeyForService,
};
