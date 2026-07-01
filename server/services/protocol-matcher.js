const MATCH_RULES = [
  {
    programKey: 'bed_bug',
    visit: 2,
    reason: 'bed_bug_treatment',
    terms: [
      'chemical bed bug',
      'heat bed bug',
      'hybrid bed bug',
      'bed bug chemical',
      'bed bug heat',
      'bed bug heat treatment',
      'bed bug hybrid',
      'bed bug treatment',
    ],
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
    terms: [
      'american roach',
      'large roach',
      'large roach knockdown',
      'palmetto bug',
      'palmetto roach',
      'palmetto roach knockdown',
      'smokybrown roach',
      'smoky brown roach',
      'sewer roach',
    ],
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
    visit: 4,
    reason: 'rodent_followup',
    terms: [
      'rodent exclusion follow up',
      'rodent exclusion followup',
      'rodent trapping follow up',
      'rodent trapping followup',
      'rodent follow up',
      'rodent followup',
      'exclusion follow up',
      'exclusion followup',
    ],
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
    terms: ['rodent bait', 'rat bait', 'mouse bait', 'bait station', 'rodent station', 'rodent trap', 'rat trap', 'mouse trap', 'rodent monitoring'],
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
    terms: ['event mosquito', 'mosquito event', 'mosquito event spray', 'event spray', 'party mosquito', 'one-time mosquito', 'one time mosquito'],
  },
  {
    programKey: 'mosquito',
    visit: 2,
    reason: 'mosquito_source_reduction',
    terms: [
      'larvicide',
      'bti',
      'dunk',
      'standing water',
      'breeding',
      'igr',
      'mosquito station',
      'mosquito stations',
      'mosquito treatment station',
      'mosquito treatment stations',
    ],
  },
  {
    programKey: 'mosquito',
    visit: 1,
    reason: 'mosquito_barrier',
    terms: ['mosquito', 'misting', 'barrier', 'no-see-um', 'no see um'],
  },
  {
    programKey: 'palm_injection',
    visit: 3,
    reason: 'palm_followup',
    terms: ['palm injection follow', 'palm injection follow up', 'palm injection recheck', 'palm follow', 'palm recheck', 'injection follow'],
  },
  {
    programKey: 'palm_injection',
    visit: 1,
    reason: 'palm_diagnosis',
    terms: ['palm injection assessment', 'palm injection diagnosis', 'manganese injection', 'magnesium injection'],
  },
  {
    programKey: 'palm_injection',
    visit: 2,
    reason: 'palm_injection_application',
    terms: ['palm injection', 'palm tree injection', 'palm tree injections', 'palm-jet', 'palm jet', 'mn-jet', 'mn jet', 'ima-jet', 'ima jet'],
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
    terms: ['liquid', 'trench', 'trenching', 'rod', 'rodding', 'termidor', 'perimeter', 'pre-slab', 'preslab'],
  },
  {
    programKey: 'termite',
    visit: 2,
    reason: 'bait_monitoring',
    terms: ['bait', 'baiting', 'bait station', 'bait stations', 'station', 'stations', 'monitoring', 'monitor', 'monitors'],
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
    terms: ['ant', 'ants', 'ghost ant', 'ghost ants', 'fire ant', 'fire ants', 'carpenter ant', 'carpenter ants'],
  },
  {
    programKey: 'pest',
    visit: 4,
    reason: 'flea_tick',
    terms: ['flea', 'fleas', 'tick', 'ticks'],
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

function hasToken(normalized, token) {
  return normalized.split(/\s+/).includes(token);
}

function matchesTerm(normalized, term) {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  if (normalizedTerm.includes(' ')) return normalized.includes(normalizedTerm);
  return hasToken(normalized, normalizedTerm);
}

function isPestPrimaryCompanion(normalized) {
  return /\bpest\b.*\brodent\b/.test(normalized) && !/\b(lawn|turf|grass|weed|fertil|mosquito)\b/.test(normalized);
}

function programKeyForService(serviceType) {
  const normalized = normalize(serviceType);
  // 'turf' is the commercial turf-treatment synonym for the lawn program
  // ("Commercial Turf Treatment Program") — must route to the lawn protocol,
  // not fall through to pest.
  if (normalized.includes('lawn') || normalized.includes('turf')) return 'lawn';
  if (normalized.includes('bed bug') || normalized.includes('bedbug')) return 'bed_bug';
  if (normalized.includes('cockroach') || normalized.includes('roach') || normalized.includes('palmetto bug')) return 'cockroach';
  if (isPestPrimaryCompanion(normalized)) return 'pest';
  if (
    hasToken(normalized, 'rodent') ||
    hasToken(normalized, 'rat') ||
    hasToken(normalized, 'rats') ||
    hasToken(normalized, 'mouse') ||
    hasToken(normalized, 'mice') ||
    hasToken(normalized, 'exclusion') ||
    normalized.includes('seal up') ||
    normalized.includes('entry point')
  ) return 'rodent';
  if (normalized.includes('mosquito') || normalized.includes('misting') || normalized.includes('no see um')) return 'mosquito';
  if (
    normalized.includes('palm injection') ||
    normalized.includes('palm tree injection') ||
    normalized.includes('palm jet') ||
    normalized.includes('mn jet') ||
    normalized.includes('ima jet') ||
    normalized.includes('propizol') ||
    normalized.includes('manganese injection') ||
    normalized.includes('magnesium injection') ||
    normalized.includes('injection follow') ||
    normalized.includes('palm follow') ||
    normalized.includes('palm recheck')
  ) return 'palm_injection';
  if (
    normalized.includes('termite') ||
    normalized.includes('termiticide') ||
    normalized.includes('wdo') ||
    normalized.includes('wood destroying') ||
    normalized.includes('bora') ||
    normalized.includes('borate') ||
    normalized.includes('termidor') ||
    normalized.includes('pre slab') ||
    normalized.includes('preslab') ||
    normalized.includes('foam drill') ||
    normalized.includes('wood treatment') ||
    normalized.includes('liquid perimeter') ||
    normalized.includes('trench')
  ) return 'termite';
  if (normalized.includes('tree') || normalized.includes('shrub') || normalized.includes('palm') || normalized.includes('ornamental')) return 'tree_shrub';
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
    return rule.programKey === fallbackProgramKey;
  });
  const matchedRule = rules.find((rule) => rule.terms.some((term) => matchesTerm(normalized, term)));
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
