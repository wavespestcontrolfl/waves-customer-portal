const { isMistingDesignConsultation, isMistingSystemServiceUnconfigured } = require('../utils/mosquito-misting-system');

// A rule's `serviceKeys` are the catalog service keys it claims: a booking
// that carries one (service_key_snapshot) resolves to that rule's visit
// regardless of its display name — "Termite Spot Treatment Service" names no
// foam term but IS the foam / drill visit, and the bait-station services
// ("Termite Installation Setup", "… Cartridge Replacement") are station work,
// not the inspection their names fall to.
const MATCH_RULES = [
  // Bed bug cards (2026-11-25): 1 inspection, 2 treatment 1, 3 the follow-up card for every later visit (treatment 2
  // at day 14, each clearance check, the third treatment on a heavy job). The stage of a later visit is never read
  // from its name: one card covers them all. Waves does not sell heat, so a booking that says heat or hybrid anywhere
  // gets the inspection / scope card (no product prefilled) and the office reviews the scope first.
  // `explicitStage`: the name states the stage, so the rule outranks the booking's catalog service key.
  {
    programKey: 'bed_bug',
    visit: 1,
    reason: 'bed_bug_heat_scope_review',
    explicitStage: true,
    terms: ['heat', 'hybrid'],
  },
  {
    programKey: 'bed_bug',
    visit: 3,
    reason: 'bed_bug_followup',
    explicitStage: true,
    followupOf: ['bed_bug_treatment'],
    terms: [
      'bed bug follow', 'bed bug recheck', 'bed bug clearance', 'post treatment inspection',
      'bed bug treatment 2', 'bed bug second treatment', 'second bed bug',
      'bed bug treatment 3', 'bed bug third treatment', 'third bed bug',
    ],
  },
  {
    programKey: 'bed_bug',
    visit: 2,
    reason: 'bed_bug_treatment',
    terms: ['chemical bed bug', 'bed bug chemical', 'bed bug treatment'],
  },
  {
    programKey: 'bed_bug',
    visit: 1,
    reason: 'bed_bug_inspection',
    terms: ['bed bug', 'bedbug', 'bed bugs', 'mattress', 'box spring', 'fecal spotting'],
  },
  // Flea: treatment 1, then treatment 2 at day 14 (no third, owner 2026-11-23). A booked follow-up of a flea
  // visit resolves to treatment 2 through the `_followup` rule, so the growth regulator is never prefilled twice.
  {
    programKey: 'flea',
    visit: 2,
    reason: 'flea_followup',
    explicitStage: true,
    followupOf: ['flea_service'],
    terms: ['flea follow', 'flea recheck', 'flea treatment 2', 'flea second treatment', 'second flea'],
  },
  {
    programKey: 'flea',
    visit: 1,
    reason: 'flea_service',
    serviceKeys: ['flea_tick'],
    terms: ['flea', 'fleas'],
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
    // The catalog names the exterior-species knockdown "Initial Native Roach
    // Knockdown Service" (pest_initial_palmetto_knockdown); without these it
    // fell through to the generic cockroach rule and the German interior
    // cleanout visit (Codex/pre-push audit on #5049).
    serviceKeys: ['pest_initial_palmetto_knockdown'],
    terms: [
      'native roach',
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
  // A trap check (owner 2026-11-23: only on the customer's report of a sound or a smell): every follow-up, an added check, and each
  // trap-only retainer visit (the numbered 8-trap check with the catch map). The catalog key routes a retainer whose name says no rodent.
  {
    programKey: 'rodent',
    visit: 4,
    reason: 'rodent_followup',
    serviceKeys: [
      'rodent_trapping_followup', 'rodent_trapping_followup_3pack', 'rodent_trap_check_additional',
      'trap_only_retainer_standard', 'trap_only_retainer_plus', 'trap_only_retainer_monthly',
    ],
    terms: [
      'trap check',
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
  // Outdoor bait stations: their own card (Tomcat Bromethalin at homes, Contrac at commercial sites; owner 2026-11-25, D15b), never the
  // attic trapping card and its Victor trap default.
  {
    programKey: 'rodent',
    visit: 5,
    reason: 'rodent_bait_station',
    serviceKeys: ['rodent_bait_quarterly', 'rodent_bait_setup'],
    terms: ['rodent bait', 'rat bait', 'mouse bait', 'bait station', 'rodent station', 'rodent monitoring'],
  },
  {
    programKey: 'rodent',
    visit: 2,
    reason: 'rodent_trapping_baiting',
    terms: ['rodent trap', 'rat trap', 'mouse trap'],
  },
  {
    programKey: 'rodent',
    visit: 1,
    reason: 'rodent_inspection',
    terms: ['rodent', 'rat', 'mouse', 'mice', 'droppings'],
  },
  // A mosquito callback (a re-service booked from a finished visit, or named so): inspection and larvicide; the only spray is
  // low-rate CrossCheck Plus, picked by the tech, so the card prefills nothing (owner 2026-11-25, D7). Only mosquito rules are read for a
  // mosquito name, so the bare callback words anywhere in it ("Mosquito Control Re-Service") are enough.
  {
    programKey: 'mosquito',
    visit: 4,
    reason: 'mosquito_followup',
    explicitStage: true,
    followupOf: ['mosquito_barrier', 'mosquito_event_service', 'mosquito_source_reduction'],
    terms: ['callback', 'call back', 'follow up', 'followup', 'recheck', 're service', 'reservice'],
  },
  // A booked In2Care station service: its own card and default, never the larvicide visit's Bti dunk.
  {
    programKey: 'mosquito',
    visit: 5,
    reason: 'mosquito_stations',
    terms: ['mosquito station', 'mosquito stations', 'mosquito treatment station', 'mosquito treatment stations'],
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
      'dunks',
      'standing water',
      'breeding',
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
    serviceKeys: ['termite_spot_treatment'],
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
    serviceKeys: ['termite_liquid', 'termite_trenching', 'termite_pretreatment', 'termite_slab_pretreat'],
    terms: ['liquid', 'trench', 'trenching', 'rod', 'rodding', 'termidor', 'perimeter', 'pre-slab', 'preslab'],
  },
  {
    programKey: 'termite',
    visit: 2,
    reason: 'bait_monitoring',
    serviceKeys: ['termite_bait', 'termite_monitoring', 'termite_installation_setup', 'termite_active_annual', 'termite_active_bait_quarterly', 'termite_cartridge_replacement', 'pest_termite_bait_quarterly'],
    terms: ['bait', 'baiting', 'bait station', 'bait stations', 'station', 'stations', 'monitoring', 'monitor', 'monitors'],
  },
  {
    programKey: 'termite',
    visit: 6,
    reason: 'renewal_inspection',
    serviceKeys: ['termite_renewal', 'termite_bond_1yr', 'termite_bond_5yr', 'termite_bond_10yr'],
    terms: ['renewal', 'warranty', 'annual'],
  },
  {
    programKey: 'termite',
    visit: 1,
    reason: 'termite_inspection',
    serviceKeys: ['termite_inspection'],
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
    visit: 3,
    reason: 'ant_service',
    terms: ['ant', 'ants', 'ghost ant', 'ghost ants', 'fire ant', 'fire ants', 'carpenter ant', 'carpenter ants'],
  },
  // Ticks keep the pest visit-4 card. Flea has its own program (below, 2026-11-25); flea_tick is the
  // flea-only "Flea Control Service" since the 2026-07 rebrand and ticks are tick_control, so their match
  // reasons stay split and downstream labeling never calls a tick request a flea service.
  {
    programKey: 'pest',
    visit: 4,
    reason: 'tick_service',
    terms: ['tick', 'ticks'],
  },
  {
    programKey: 'pest',
    visit: 1,
    reason: 'general_pest',
    // The general-pest catalog rows: "Initial Pest Cleanout" is a general
    // active-infestation treatment, not the German-roach cleanout its name
    // would otherwise match.
    serviceKeys: ['pest_general_quarterly', 'pest_general_monthly', 'pest_initial_cleanout'],
    terms: ['pest', 'quarterly', 'bimonthly', 'bi-monthly', 'monthly', 'perimeter'],
  },
  {
    programKey: 'tree_shrub',
    visit: 1,
    reason: 'tree_shrub',
    terms: ['tree', 'shrub', 'palm', 'ornamental'],
  },
  // Area add-on treatments (GATE_AREA_ADDONS, migration 20261008200000): one-time
  // treatments sold on an estimate, routed by catalog service key ONLY. No terms:
  // their display names ("Fire Ant Yard Treatment", "Yearly Lawn Insect Preventive")
  // read as pest or lawn jobs, and a name must never send them to those programs'
  // visits (nor another service to these). The web sweep applies no product and has
  // no visit.
  { programKey: 'area_addon', visit: 1, reason: 'area_addon_bed_pre_emergent', serviceKeys: ['area_addon_bed_pre_emergent'], terms: [] },
  { programKey: 'area_addon', visit: 2, reason: 'area_addon_lawn_insect_spot', serviceKeys: ['area_addon_lawn_insect_spot'], terms: [] },
  { programKey: 'area_addon', visit: 3, reason: 'area_addon_fire_ant_yard', serviceKeys: ['area_addon_fire_ant_yard'], terms: [] },
  { programKey: 'area_addon', visit: 4, reason: 'area_addon_lawn_insect_preventive', serviceKeys: ['area_addon_lawn_insect_preventive'], terms: [] },
  { programKey: 'area_addon', visit: 5, reason: 'area_addon_hardscape_weed', serviceKeys: ['area_addon_hardscape_weed'], terms: [] },
  // The converted mosquito misting system (misting PR 2a): routed by catalog service key, and by the system's own plan phrase
  // for a keyless row. Bare "misting" (the barrier program's 21-day cycle wording) never reaches these.
  { programKey: 'mosquito_misting', visit: 1, reason: 'misting_system_service', serviceKeys: ['mosquito_misting_service'], terms: ['misting service plan'] },
  { programKey: 'mosquito_misting', visit: 2, reason: 'misting_system_install', serviceKeys: ['mosquito_misting_install'], terms: [] },
  { programKey: 'mosquito_misting', visit: 3, reason: 'misting_system_refill', serviceKeys: ['mosquito_misting_refill'], terms: [] },
];

// The automatic mosquito misting SYSTEM's DESIGN-VISIT identity
// (mosquito_misting_system — see wiki/protocols/mosquito-misting-
// systems.md) is a consultation/equipment service with no chemical
// application protocol of its own, but its name and catalog category both
// share "mosquito"/"misting" with the barrier PROGRAM's mosquito_barrier
// rule (visit 1, terms include 'misting' for the barrier program's own
// "21-day misting" cycle-length copy) — left alone, a scheduled
// misting-system visit would resolve the barrier program's
// foliage/backpack spray steps. isMistingDesignConsultation (server/utils)
// is the shared, KEY-FIRST predicate every caller of this identity check
// uses — bare "misting" and the plain word "mosquito" keep routing to the
// barrier program exactly as before, and a future distinct catalog key
// (install/maintenance) is never swept in by name matching.
//
// A KEYLESS row whose name reads as a different, not-yet-built phase of the
// product (install/maintenance/refill — isMistingSystemServiceUnconfigured)
// is neither this consultation nor a barrier match: there is no live
// protocols.json program for it, so it gets its own explicit "no match"
// reason below instead of falling through to the barrier program.
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

// NOTE: deliberately rodent-only. A pest + TERMITE bait combination keeps the
// termite-bait PROTOCOL (the tech needs the station steps — codified in
// protocol-matcher.test.js "keeps pest and termite bait station combinations
// on termite bait protocol") even though the service LINE classifies pest for
// reporting. Protocol follows the work; line follows the report.
function isPestPrimaryCompanion(normalized) {
  return /\bpest\b.*\brodent\b/.test(normalized) && !/\b(lawn|turf|grass|weed|fertil|mosquito)\b/.test(normalized);
}

// Names decided before the rodent, mosquito, palm and termite words are read: a pest visit that names a companion service stays pest, and
// a flea job has its own card. "Flea & Tick" names a tick request too, and ticks stay on the pest tick card. Null: no decision here.
function pestOrFleaProgram(normalized) {
  if (isPestPrimaryCompanion(normalized)) return 'pest';
  const names = (token) => hasToken(normalized, token);
  return (names('flea') || names('fleas')) && !names('tick') && !names('ticks') ? 'flea' : null;
}

function programKeyForService(serviceType) {
  const normalized = normalize(serviceType);
  // The misting SYSTEM's plan phrase is its own program (a keyless row); bare "misting" below stays the barrier program.
  if (normalized.includes('misting service plan')) return 'mosquito_misting';
  // 'turf' is the commercial turf-treatment synonym for the lawn program
  // ("Commercial Turf Treatment Program") — must route to the lawn protocol,
  // not fall through to pest.
  if (normalized.includes('lawn') || normalized.includes('turf')) return 'lawn';
  if (normalized.includes('bed bug') || normalized.includes('bedbug')) return 'bed_bug';
  if (normalized.includes('cockroach') || normalized.includes('roach') || normalized.includes('palmetto bug')) return 'cockroach';
  const named = pestOrFleaProgram(normalized);
  if (named) return named;
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
    // Termite-bait product aliases the normalizer maps to termite labels —
    // the matcher must agree ("Trelona Installation", "Advance Monitoring").
    normalized.includes('trelona') ||
    hasToken(normalized, 'advance') ||
    normalized.includes('pre slab') ||
    normalized.includes('preslab') ||
    normalized.includes('foam drill') ||
    normalized.includes('wood treatment') ||
    normalized.includes('liquid perimeter') ||
    normalized.includes('trench')
  ) return 'termite';
  if (normalized.includes('tree') || normalized.includes('shrub') || normalized.includes('palm') || normalized.includes('ornamental') || normalized.includes('arborjet')) return 'tree_shrub';
  return 'pest';
}

function findVisit(program, visitNumber) {
  return (program?.visits || []).find((visit) => Number(visit.visit) === Number(visitNumber)) || null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Month-keyed programs (tree & shrub: one visit per calendar month) resolve
// by the appointment's month, not the matcher rule's fixed visit — the
// tree_shrub rule's `visit: 1` is only the no-month fallback, so without a
// month every T&S appointment would show the January protocol. Programs
// whose visits are 'Any' (pest, termite, …) return null and keep their
// rule-picked visit.
// Shared with job-card.js seasonalVisit so every protocol surface agrees.
// `month` is "Apr"/"april"/4; anything else resolves no month (null).
function monthVisit(program, month) {
  const n = /^\d{1,2}$/.test(String(month ?? '').trim()) ? Number(month) : NaN;
  const abbr = String(month || '').slice(0, 3).toLowerCase();
  const key = n >= 1 && n <= 12 ? MONTHS[n - 1] : MONTHS.find((m) => m.toLowerCase() === abbr);
  if (!key) return null;
  return (program?.visits || []).find((visit) => visit?.month === key) || null;
}

// Consultation/equipment service, not a treatment — no program, no visit,
// by design. Every caller already treats a null program as "no protocol"
// (admin-protocols.js's /match and /completion-actions 404; job-card.js's
// resolveProtocolLines only when it does not itself force a programKey). A
// keyless row that names a different, not-yet-built phase of the product
// (install/maintenance/refill) is neither this consultation nor a barrier
// match — no live program exists for it (pricing and the install product
// set are owner-pending), so it gets its own explicit "no match" reason
// instead of falling through to the barrier program. Returns null when
// neither applies, so the caller proceeds with ordinary matching.
function mistingSystemMatchOverride(serviceType, serviceKey) {
  if (isMistingDesignConsultation({ serviceKey, name: serviceType })) {
    return {
      programKey: null,
      program: null,
      matchedVisit: null,
      matched: false,
      reason: 'misting_system_consultation',
    };
  }
  if (isMistingSystemServiceUnconfigured({ serviceKey, name: serviceType })) {
    return {
      programKey: null,
      program: null,
      matchedVisit: null,
      matched: false,
      reason: 'misting_system_service_unconfigured',
    };
  }
  return null;
}

// The rule for a booking: the first rule of its program whose terms the name carries, or the rule that claims its catalog
// service key. The key wins, except over a rule marked `explicitStage` (the name itself says "treatment 2" or "heat").
function ruleFor(keyRule, rules, normalized) {
  const named = rules.find((rule) => rule.terms.some((term) => matchesTerm(normalized, term)));
  return named?.explicitStage ? named : keyRule || named;
}

function matchServiceProtocol(protocols, serviceType, { serviceKey = null, month = null } = {}) {
  const override = mistingSystemMatchOverride(serviceType, serviceKey);
  if (override) return override;
  const normalized = normalize(serviceType);
  // The catalog service key outranks the name: a rule that claims the key
  // is the match, and the program is that rule's.
  const keyRule = serviceKey ? MATCH_RULES.find((rule) => rule.serviceKeys?.includes(serviceKey)) || null : null;
  const fallbackProgramKey = keyRule?.programKey || programKeyForService(serviceType);
  const rules = MATCH_RULES.filter((rule) => {
    if (fallbackProgramKey === 'lawn') return false;
    return rule.programKey === fallbackProgramKey;
  });
  const matchedRule = ruleFor(keyRule, rules, normalized);
  const programKey = matchedRule?.programKey || fallbackProgramKey;
  const program = protocols?.[programKey] || null;
  if (!program) return { programKey, program: null, matchedVisit: null, matched: false, reason: 'program_missing' };

  const fallbackVisit = program.visits?.[0] || null;
  const ruleVisit = matchedRule ? findVisit(program, matchedRule.visit) || fallbackVisit : fallbackVisit;
  const seasonal = monthVisit(program, month);
  const matchedVisit = seasonal || ruleVisit;

  return {
    programKey,
    program,
    matchedVisit,
    matched: !!matchedRule,
    reason: matchedRule?.reason || 'category_default',
  };
}

// A follow-up booked from a finished visit copies that visit's name and service key, and is marked only by
// scheduled_services.followup_source_service_id. Its name therefore matches the SOURCE visit's card. When the
// program has a follow-up card (its one rule whose reason ends `_followup`), a follow-up booking gets that card.
// Every surface that shows a visit's card or products applies this to its match: the job card, the schedule
// panel, the completion actions and the completion product defaults. A program with no follow-up rule keeps
// its match. A follow-up rule with `followupOf` replaces only the cards it lists (the first treatment): a visit
// whose own name already says its stage (a clearance check, a third treatment, a scope review) keeps that card.
function followupVisitMatch(match, isFollowup) {
  if (!isFollowup || !match?.program) return match;
  const rule = MATCH_RULES.find((entry) => entry.programKey === match.programKey && /_followup$/.test(entry.reason || ''));
  if (!rule || (rule.followupOf && !rule.followupOf.includes(match.reason))) return match;
  const visit = findVisit(match.program, rule.visit);
  return visit ? { ...match, matchedVisit: visit, matched: true, reason: rule.reason } : match;
}

module.exports = {
  MATCH_RULES,
  followupVisitMatch,
  matchServiceProtocol,
  monthVisit,
  programKeyForService,
};
