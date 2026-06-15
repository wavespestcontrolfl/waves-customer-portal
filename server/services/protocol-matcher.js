const MATCH_RULES = [
  {
    programKey: 'bed_bug',
    visit: 2,
    reason: 'bed_bug_treatment',
    terms: ['chemical bed bug', 'heat bed bug', 'hybrid bed bug', 'bed bug treatment'],
  },
  {
    programKey: 'bed_bug',
    visit: 3,
    reason: 'bed_bug_followup',
    terms: ['bed bug follow', 'bed bug recheck', 'post treatment inspection'],
  },
  {
    programKey: 'bed_bug',
    visit: 1,
    reason: 'bed_bug_inspection',
    terms: ['bed bug', 'bedbug', 'bed bugs', 'mattress', 'box spring', 'fecal spotting'],
  },
  {
    programKey: 'cockroach',
    visit: 1,
    reason: 'german_roach_cleanout',
    terms: ['german roach', 'german cockroach', 'roach cleanout'],
  },
  {
    programKey: 'cockroach',
    visit: 2,
    reason: 'american_roach_exterior',
    terms: ['american roach', 'palmetto bug', 'smokybrown roach', 'sewer roach'],
  },
  {
    programKey: 'cockroach',
    visit: 3,
    reason: 'cockroach_followup',
    terms: ['roach follow', 'cockroach follow', 'roach recheck', 'cockroach recheck'],
  },
  {
    programKey: 'cockroach',
    visit: 1,
    reason: 'cockroach_control',
    terms: ['cockroach', 'roach'],
  },
  {
    programKey: 'rodent',
    visit: 3,
    reason: 'rodent_exclusion',
    terms: ['exclusion', 'seal up', 'seal-up', 'entry point', 'entry points'],
  },
  {
    programKey: 'rodent',
    visit: 2,
    reason: 'rodent_trapping_baiting',
    terms: ['bait', 'station', 'trap', 'trapping', 'monitoring', 'monitor'],
  },
  {
    programKey: 'rodent',
    visit: 1,
    reason: 'rodent_inspection',
    terms: ['rodent', 'rat', 'mouse', 'mice', 'droppings'],
  },
  {
    programKey: 'mosquito',
    visit: 3,
    reason: 'mosquito_event_service',
    terms: ['event mosquito', 'party mosquito', 'one-time mosquito', 'one time mosquito'],
  },
  {
    programKey: 'mosquito',
    visit: 2,
    reason: 'mosquito_source_reduction',
    terms: ['larvicide', 'bti', 'dunk', 'standing water', 'breeding'],
  },
  {
    programKey: 'mosquito',
    visit: 1,
    reason: 'mosquito_barrier',
    terms: ['mosquito', 'misting', 'barrier', 'no-see-um', 'no see um'],
  },
  {
    programKey: 'palm_injection',
    visit: 2,
    reason: 'palm_injection_application',
    terms: ['palm injection', 'palm-jet', 'palm jet', 'mn-jet', 'mn jet', 'ima-jet', 'ima jet', 'injection'],
  },
  {
    programKey: 'palm_injection',
    visit: 3,
    reason: 'palm_followup',
    terms: ['palm follow', 'palm recheck', 'injection follow'],
  },
  {
    programKey: 'palm_injection',
    visit: 1,
    reason: 'palm_diagnosis',
    terms: ['palm', 'palm tree', 'palm decline', 'manganese', 'magnesium'],
  },
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
  if (normalized.includes('bed bug') || normalized.includes('bedbug')) return 'bed_bug';
  if (normalized.includes('cockroach') || normalized.includes('roach')) return 'cockroach';
  if (normalized.includes('rodent') || normalized.includes('rat') || normalized.includes('mouse') || normalized.includes('mice')) return 'rodent';
  if (normalized.includes('mosquito') || normalized.includes('misting') || normalized.includes('no see um')) return 'mosquito';
  if (normalized.includes('palm')) return 'palm_injection';
  if (normalized.includes('termite') || normalized.includes('wdo') || normalized.includes('bora') || normalized.includes('termidor')) return 'termite';
  if (normalized.includes('tree') || normalized.includes('shrub') || normalized.includes('ornamental')) return 'tree_shrub';
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
