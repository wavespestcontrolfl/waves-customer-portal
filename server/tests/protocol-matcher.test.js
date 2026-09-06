const protocols = require('../config/protocols.json');
const { matchServiceProtocol } = require('../services/protocol-matcher');

function match(serviceType) {
  const result = matchServiceProtocol(protocols, serviceType);
  return {
    programKey: result.programKey,
    visit: result.matchedVisit?.visit,
    reason: result.reason,
  };
}

describe('protocol matcher specialty routing', () => {
  test('routes palm tree injection labels to the palm injection application protocol', () => {
    expect(match('Palm Tree Injections')).toEqual({
      programKey: 'palm_injection',
      visit: 2,
      reason: 'palm_injection_application',
    });
  });

  test('routes palm diagnosis aliases to the palm injection diagnosis protocol', () => {
    expect(match('Manganese Injection')).toEqual({
      programKey: 'palm_injection',
      visit: 1,
      reason: 'palm_diagnosis',
    });
    expect(match('Magnesium Injection')).toEqual({
      programKey: 'palm_injection',
      visit: 1,
      reason: 'palm_diagnosis',
    });
  });

  test('does not classify aeration as rodent because of the rat substring', () => {
    expect(match('Core Aeration').programKey).not.toBe('rodent');
    expect(match('Aeration').programKey).not.toBe('rodent');
  });

  test('routes the commercial TURF treatment label to the lawn program (not pest)', () => {
    // "Commercial Turf Treatment Program" has no 'lawn' token — without turf
    // awareness it would fall through to the pest protocol, loading the wrong
    // completion actions for a turf visit.
    expect(match('Commercial Turf Treatment Program').programKey).toBe('lawn');
    // The residential/legacy "Commercial Lawn Treatment" label still routes to lawn.
    expect(match('Commercial Lawn Treatment').programKey).toBe('lawn');
  });

  test('routes mosquito IGR and station service labels to source reduction', () => {
    expect(match('Mosquito Treatment - IGR')).toEqual({
      programKey: 'mosquito',
      visit: 2,
      reason: 'mosquito_source_reduction',
    });
    expect(match('Mosquito Stations')).toEqual({
      programKey: 'mosquito',
      visit: 2,
      reason: 'mosquito_source_reduction',
    });
    expect(match('Mosquito Treatment - Stations')).toEqual({
      programKey: 'mosquito',
      visit: 2,
      reason: 'mosquito_source_reduction',
    });
  });

  test('routes mosquito event service labels to the event protocol', () => {
    expect(match('Mosquito Event Spray')).toEqual({
      programKey: 'mosquito',
      visit: 3,
      reason: 'mosquito_event_service',
    });
  });

  test('routes palmetto bug labels to the cockroach exterior protocol', () => {
    expect(match('Palmetto Bug Control')).toEqual({
      programKey: 'cockroach',
      visit: 2,
      reason: 'american_roach_exterior',
    });
    expect(match('Palmetto Roach Knockdown')).toEqual({
      programKey: 'cockroach',
      visit: 2,
      reason: 'american_roach_exterior',
    });
  });

  test('routes full WDO labels to the termite inspection protocol', () => {
    expect(match('Wood Destroying Organism Inspection')).toEqual({
      programKey: 'termite',
      visit: 1,
      reason: 'termite_inspection',
    });
  });

  test('routes rodent follow-up labels after setup labels', () => {
    expect(match('Rodent Trapping Follow-Up Visit')).toEqual({
      programKey: 'rodent',
      visit: 4,
      reason: 'rodent_followup',
    });
    expect(match('Rodent Exclusion Follow Up')).toEqual({
      programKey: 'rodent',
      visit: 4,
      reason: 'rodent_followup',
    });
  });

  test('routes bed bug method labels to treatment protocol', () => {
    expect(match('Bed Bug Chemical/IPM Program')).toEqual({
      programKey: 'bed_bug',
      visit: 2,
      reason: 'bed_bug_treatment',
    });
    expect(match('Bed Bug Heat Treatment')).toEqual({
      programKey: 'bed_bug',
      visit: 2,
      reason: 'bed_bug_treatment',
    });
    expect(match('Bed Bug Hybrid Heat + Residual Program')).toEqual({
      programKey: 'bed_bug',
      visit: 2,
      reason: 'bed_bug_treatment',
    });
  });

  test('preserves pest-primary combined services on the pest protocol', () => {
    expect(match('Pest & Rodent Control')).toEqual({
      programKey: 'pest',
      visit: 5,
      reason: 'rodent_monitoring',
    });
  });

  test('keeps pest and termite bait station combinations on termite bait protocol', () => {
    expect(match('Quarterly Pest + Termite Bait Station')).toEqual({
      programKey: 'termite',
      visit: 2,
      reason: 'bait_monitoring',
    });
    expect(match('Termite Baiting')).toEqual({
      programKey: 'termite',
      visit: 2,
      reason: 'bait_monitoring',
    });
    expect(match('Termite Stations')).toEqual({
      programKey: 'termite',
      visit: 2,
      reason: 'bait_monitoring',
    });
    expect(match('Termite Station Service')).toEqual({
      programKey: 'termite',
      visit: 2,
      reason: 'bait_monitoring',
    });
  });

  test('routes termite trenching and rodding labels to liquid perimeter protocol', () => {
    expect(match('Termite Trenching Service')).toEqual({
      programKey: 'termite',
      visit: 3,
      reason: 'liquid_perimeter',
    });
    expect(match('Termite Rodding Service')).toEqual({
      programKey: 'termite',
      visit: 3,
      reason: 'liquid_perimeter',
    });
  });

  test('matches plural pest labels to the specialty pest visits', () => {
    expect(match('Ants')).toEqual({
      programKey: 'pest',
      visit: 3,
      reason: 'ant_service',
    });
    expect(match('Fleas')).toEqual({
      programKey: 'pest',
      visit: 4,
      reason: 'flea_service',
    });
    expect(match('Ticks')).toEqual({
      programKey: 'pest',
      visit: 4,
      reason: 'tick_service',
    });
  });
});

describe('catalog service keys', () => {
  const byKey = (serviceType, serviceKey) => {
    const r = matchServiceProtocol(protocols, serviceType, { serviceKey });
    return [r.programKey, r.matchedVisit?.visit, r.reason];
  };

  test('a booking\'s termite service key fixes the visit; the display name is not consulted (job card r5 P1)', () => {
    expect(byKey('Termite Spot Treatment Service', 'termite_spot_treatment')).toEqual(['termite', 4, 'foam_drill']);
    expect(byKey('Termite Pretreatment Service', 'termite_pretreatment')).toEqual(['termite', 3, 'liquid_perimeter']);
    expect(byKey('Slab Pre-Treat Termite Service', 'termite_slab_pretreat')).toEqual(['termite', 3, 'liquid_perimeter']);
    expect(byKey('Termite Installation Setup', 'termite_installation_setup')).toEqual(['termite', 2, 'bait_monitoring']);
    expect(byKey('Termite Bait Station Cartridge Replacement', 'termite_cartridge_replacement')).toEqual(['termite', 2, 'bait_monitoring']);
    expect(byKey('Quarterly Pest + Termite Bait Station', 'pest_termite_bait_quarterly')).toEqual(['termite', 2, 'bait_monitoring']);
    expect(byKey('Termite Bond (5-Year Term)', 'termite_bond_5yr')).toEqual(['termite', 6, 'renewal_inspection']);
    expect(byKey('Termite Inspection Service', 'termite_inspection')).toEqual(['termite', 1, 'termite_inspection']);
    // A short name that classifies as pest by itself still follows its key.
    expect(byKey('Spot Treat', 'termite_spot_treatment')).toEqual(['termite', 4, 'foam_drill']);
    // The general-pest keys: "Initial Pest Cleanout" is general active-infestation work, not the German-roach cleanout its name matches (job card r7 P1).
    expect(byKey('Initial Pest Cleanout', 'pest_initial_cleanout')).toEqual(['pest', 1, 'general_pest']);
    expect(match('Initial Pest Cleanout')).toEqual({ programKey: 'pest', visit: 2, reason: 'german_roach' });
    expect(byKey('General Pest Control (Monthly)', 'pest_general_monthly')).toEqual(['pest', 1, 'general_pest']);
  });

  test('without a claimed key the name path is unchanged', () => {
    // These names carry no foam / station term and fall to the inspection visit by name.
    expect(match('Termite Spot Treatment Service')).toEqual({ programKey: 'termite', visit: 1, reason: 'termite_inspection' });
    expect(match('Termite Installation Setup')).toEqual({ programKey: 'termite', visit: 1, reason: 'termite_inspection' });
    // An unclaimed key changes nothing.
    expect(matchServiceProtocol(protocols, 'Quarterly Pest Control', { serviceKey: 'pest_quarterly' })).toEqual(matchServiceProtocol(protocols, 'Quarterly Pest Control'));
  });
});
