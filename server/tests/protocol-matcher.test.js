const protocols = require('../config/protocols.json');
const { matchServiceProtocol, followupVisitMatch } = require('../services/protocol-matcher');

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

  test('routes mosquito dunk labels to source reduction, IGR to the barrier (Tekko Pro is in its tank), and station labels to the station visit', () => {
    expect(match('Mosquito Treatment - Dunks')).toEqual({ programKey: 'mosquito', visit: 2, reason: 'mosquito_source_reduction' });
    expect(match('Mosquito Treatment - IGR')).toEqual({ programKey: 'mosquito', visit: 1, reason: 'mosquito_barrier' });
    // A booked In2Care station service gets its own card, never the larvicide visit's Bti dunk default (owner 2026-11-25, D7).
    for (const label of ['Mosquito Stations', 'Mosquito Treatment - Stations']) {
      expect(match(label)).toEqual({ programKey: 'mosquito', visit: 5, reason: 'mosquito_stations' });
    }
    // A callback word anywhere in a mosquito name opens the callback card; a pest callback stays pest.
    for (const label of ['Mosquito Callback', 'Mosquito Misting Callback', 'Mosquito Control Re-Service', 'Mosquito Follow-Up']) {
      expect(match(label)).toEqual({ programKey: 'mosquito', visit: 4, reason: 'mosquito_followup' });
    }
    expect(match('Pest Callback').programKey).toBe('pest');
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
    // The traps came out at exclusion (D15a): an exclusion follow-up re-inspects, never resets traps.
    expect(match('Rodent Exclusion Follow Up')).toEqual({
      programKey: 'rodent',
      visit: 7,
      reason: 'rodent_exclusion_recheck',
    });
  });

  // Owner 2026-11-23 / 2026-11-25 (D9, D15b): bait stations get their own card (Tomcat at homes), never the attic trap card; a trap
  // check, an added check and every trap-only retainer get the check card, by catalog key when the name says no rodent.
  test('routes rodent bait stations, trap checks and retainers to their own cards', () => {
    const byKey = (serviceType, serviceKey) => {
      const result = matchServiceProtocol(protocols, serviceType, { serviceKey });
      return [result.programKey, result.matchedVisit?.visit, result.reason];
    };
    expect(byKey('Quarterly Rodent Bait Station Service', 'rodent_bait_quarterly')).toEqual(['rodent', 5, 'rodent_bait_station']);
    expect(byKey('Rodent Bait Station Setup Fee Service', 'rodent_bait_setup')).toEqual(['rodent', 5, 'rodent_bait_station']);
    expect(match('Rodent Bait Station Install')).toEqual({ programKey: 'rodent', visit: 5, reason: 'rodent_bait_station' });
    expect(byKey('Rodent Trapping Service', 'rodent_trapping')).toEqual(['rodent', 2, 'rodent_trapping_baiting']);
    expect(byKey('Rodent Trap Check - Additional', 'rodent_trap_check_additional')).toEqual(['rodent', 4, 'rodent_followup']);
    for (const key of ['trap_only_retainer_standard', 'trap_only_retainer_plus', 'trap_only_retainer_monthly']) {
      expect(byKey('Standard Retainer Service', key)).toEqual(['rodent', 4, 'rodent_followup']);
    }
    // The combined service places traps too: its own reason, so a follow-up of it is a trap check.
    expect(byKey('Rodent Exclusion & Trapping Service', 'rodent_exclusion')).toEqual(['rodent', 6, 'rodent_exclusion_trapping']);
    // A legacy retainer booking with no catalog key still gets the trap check.
    expect(match('Standard Trap-Only Retainer Service')).toEqual({ programKey: 'rodent', visit: 4, reason: 'rodent_followup' });
    expect(byKey('Rodent Exclusion Only Service', 'rodent_exclusion_only')).toEqual(['rodent', 3, 'rodent_exclusion']);
    const followup = (serviceType, serviceKey) => followupVisitMatch(matchServiceProtocol(protocols, serviceType, { serviceKey }), true).matchedVisit.visit;
    expect(followup('Rodent Exclusion & Trapping Service', 'rodent_exclusion')).toBe(4);
    expect(followup('Rodent Exclusion Only Service', 'rodent_exclusion_only')).toBe(7);
    expect(followup('Rodent Trapping Service', 'rodent_trapping')).toBe(4);
    expect(followup('Quarterly Rodent Bait Station Service', 'rodent_bait_quarterly')).toBe(5);
  });

  test('routes bed bug method labels to treatment protocol', () => {
    expect(match('Bed Bug Chemical/IPM Program')).toEqual({
      programKey: 'bed_bug',
      visit: 2,
      reason: 'bed_bug_treatment',
    });
    // Waves does not sell heat: a heat or hybrid name gets the inspection / scope card (no spray prefill).
    expect(match('Bed Bug Heat Treatment')).toEqual({
      programKey: 'bed_bug',
      visit: 1,
      reason: 'bed_bug_heat_scope_review',
    });
    expect(match('Bed Bug Hybrid Heat + Residual Program')).toEqual({
      programKey: 'bed_bug',
      visit: 1,
      reason: 'bed_bug_heat_scope_review',
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

  test('flea jobs route to the flea card; a booked second visit is treatment 2', () => {
    expect(match('Flea Control Service')).toEqual({ programKey: 'flea', visit: 1, reason: 'flea_service' });
    expect(match('Flea Follow-Up')).toEqual({ programKey: 'flea', visit: 2, reason: 'flea_followup' });
    expect(match('Flea Treatment 2')).toEqual({ programKey: 'flea', visit: 2, reason: 'flea_followup' });
    // The catalog key is flea-only, whatever an old display name says.
    const keyed = matchServiceProtocol(protocols, 'Flea & Tick Control', { serviceKey: 'flea_tick' });
    expect([keyed.programKey, keyed.matchedVisit.visit, keyed.reason]).toEqual(['flea', 1, 'flea_service']);
    // A keyless name that also asks for ticks stays on the pest tick card.
    expect(match('Flea & Tick Control')).toEqual({ programKey: 'pest', visit: 4, reason: 'tick_service' });
    expect(match('Tick Control Service')).toEqual({ programKey: 'pest', visit: 4, reason: 'tick_service' });
  });

  test('bed bug cards: inspection, treatment 1, and one follow-up card for every later visit', () => {
    expect(match('Bed Bug Treatment Service')).toEqual({ programKey: 'bed_bug', visit: 2, reason: 'bed_bug_treatment' });
    expect(match('Bed Bug Inspection')).toEqual({ programKey: 'bed_bug', visit: 1, reason: 'bed_bug_inspection' });
    // The stage of a later visit is not read from its name: every one of them is the follow-up card.
    for (const name of ['Bed Bug Treatment 2', 'Bed Bug Follow-Up', 'Bed Bug Clearance Check', 'Bed Bug Recheck', 'Bed Bug Treatment 3', 'Third Bed Bug Treatment']) {
      expect(match(name)).toEqual({ programKey: 'bed_bug', visit: 3, reason: 'bed_bug_followup' });
    }
    // A heavy grade alone is not a stage: a heavy job still starts with the inspection.
    expect(match('Bed Bug Heavy Inspection')).toEqual({ programKey: 'bed_bug', visit: 1, reason: 'bed_bug_inspection' });
    expect(protocols.bed_bug.visits.map((v) => v.visit)).toEqual([1, 2, 3]);
  });

  test('a bed bug booking that says heat or hybrid anywhere gets the inspection / scope card, never a spray card', () => {
    for (const name of ['Bed Bug Heat Treatment', 'Bed Bug Heat', 'Heat Bed Bug Service', 'Bed Bug Hybrid Treatment', 'Bed Bug Treatment (Heat)', 'Bed Bug Treatment 2 - Heat', 'Bed Bug Follow-Up Hybrid']) {
      expect(match(name)).toEqual({ programKey: 'bed_bug', visit: 1, reason: 'bed_bug_heat_scope_review' });
    }
    expect(protocols.bed_bug.visits.find((v) => v.visit === 1).completionDefaultProducts).toBeUndefined();
  });

  test('an explicit stage in the name outranks the catalog service key', () => {
    const keyed = (name) => {
      const result = matchServiceProtocol(protocols, name, { serviceKey: 'flea_tick' });
      return [result.programKey, result.matchedVisit.visit, result.reason];
    };
    // A second flea visit booked by hand (no follow-up link) must not prefill the growth regulator again.
    expect(keyed('Flea Treatment 2')).toEqual(['flea', 2, 'flea_followup']);
    expect(keyed('Flea Follow-Up')).toEqual(['flea', 2, 'flea_followup']);
    expect(keyed('Flea Control Service')).toEqual(['flea', 1, 'flea_service']);
    expect(keyed('Flea & Tick Yard Treatment')).toEqual(['flea', 1, 'flea_service']);
  });

  test('followupVisitMatch: a booked follow-up gets the program follow-up card', () => {
    const followup = (name) => {
      const result = followupVisitMatch(matchServiceProtocol(protocols, name), true);
      return [result.programKey, result.matchedVisit.visit, result.reason];
    };
    expect(followup('Flea Control Service')).toEqual(['flea', 2, 'flea_followup']);
    expect(followup('Bed Bug Treatment Service')).toEqual(['bed_bug', 3, 'bed_bug_followup']);
    expect(followup('Cockroach Control Service')).toEqual(['cockroach', 3, 'cockroach_followup']);
    // A program with no follow-up card keeps its match, and so does any visit that is not a follow-up.
    expect(followup('Quarterly Pest Control')).toEqual(['pest', 1, 'general_pest']);
    // A linked visit whose own name says something else keeps its card: a later-stage name, a scope review, an inspection.
    expect(followup('Bed Bug Clearance Check')).toEqual(['bed_bug', 3, 'bed_bug_followup']);
    expect(followup('Bed Bug Heat Treatment')).toEqual(['bed_bug', 1, 'bed_bug_heat_scope_review']);
    expect(followup('Bed Bug Inspection')).toEqual(['bed_bug', 1, 'bed_bug_inspection']);
    const first = matchServiceProtocol(protocols, 'Flea Control Service');
    expect(followupVisitMatch(first, false)).toBe(first);
    expect(followupVisitMatch(null, true)).toBeNull();
  });

  test('matches plural pest labels to the specialty pest visits', () => {
    expect(match('Ants')).toEqual({
      programKey: 'pest',
      visit: 3,
      reason: 'ant_service',
    });
    // Flea has its own card since 2026-11-25; ticks keep the pest tick card.
    expect(match('Fleas')).toEqual({
      programKey: 'flea',
      visit: 1,
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
    // The pest program's German-roach copy is retired: a keyless general cleanout is general pest work too.
    expect(match('Initial Pest Cleanout')).toEqual({ programKey: 'pest', visit: 1, reason: 'general_pest' });
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

describe('mosquito misting SYSTEM is a consultation, not the barrier protocol', () => {
  // Codex P1 (PR #4762 follow-up): mosquito_misting_system is the automatic
  // misting SYSTEM (design visit → install → maintenance), not the barrier
  // PROGRAM's foliage/backpack spray — it must never resolve mosquito_barrier
  // (or any other program), by the catalog key OR the display name.
  test('the misting-system catalog key gets no protocol, regardless of the display name', () => {
    const result = matchServiceProtocol(protocols, 'Mosquito Misting System Service', { serviceKey: 'mosquito_misting_system' });
    expect(result).toEqual({
      programKey: null,
      program: null,
      matchedVisit: null,
      matched: false,
      reason: 'misting_system_consultation',
    });
  });

  test.each(['Mosquito Misting-System Service', 'Mosquito misting_system service'])('separator variant %s (no key) is still the consultation, never barrier', (name) => {
    const result = matchServiceProtocol(protocols, name, {});
    expect(result.programKey).toBeNull();
    expect(result.reason).toBe('misting_system_consultation');
  });

  test('a "misting system" name with no catalog key also gets no protocol', () => {
    // The plain design-visit identity (no install/maintenance/refill
    // qualifier) is the free-consultation reason.
    const designVisit = matchServiceProtocol(protocols, 'Automatic Misting System Design Visit');
    expect(designVisit).toEqual({
      programKey: null,
      program: null,
      matchedVisit: null,
      matched: false,
      reason: 'misting_system_consultation',
    });
  });

  test('a keyless name that reads as install/maintenance/refill gets its OWN "unconfigured" reason, not consultation and not barrier (Codex round-3 P1)', () => {
    // There is no live install/maintenance protocols.json program yet —
    // this must be neither the design consultation nor a barrier match.
    for (const name of ['Mosquito Misting System Install', 'Mosquito Misting System Maintenance', 'Mosquito Misting System Refill']) {
      const result = matchServiceProtocol(protocols, name);
      expect([name, result]).toEqual([name, {
        programKey: null,
        program: null,
        matchedVisit: null,
        matched: false,
        reason: 'misting_system_service_unconfigured',
      }]);
    }
  });

  test('a present serviceKey is key-first: only the exact mosquito_misting_system key is the consultation, even with an install/maintenance name; a DIFFERENT future key is not swept in by the name phrase at all (Codex round-3 P1)', () => {
    // The explicit key always wins over an install/maintenance-sounding name.
    expect(matchServiceProtocol(protocols, 'Mosquito Misting System Install', { serviceKey: 'mosquito_misting_system' }).reason)
      .toBe('misting_system_consultation');

    // A DIFFERENT, not-yet-built catalog key must not be silently suppressed
    // by the name phrase — key-first means this predicate does not apply to
    // it at all, so it falls through to the matcher's ordinary name-based
    // resolution. Misting PR 2a built the dedicated program (protocols.json
    // `mosquito_misting`), so the built catalog key now resolves to it by its
    // own key, never to the barrier program and never to the consultation.
    const futureKeyed = matchServiceProtocol(protocols, 'Mosquito Misting System Install', { serviceKey: 'mosquito_misting_install' });
    expect(futureKeyed.reason).not.toBe('misting_system_consultation');
    expect(futureKeyed.reason).not.toBe('misting_system_service_unconfigured');
    expect(futureKeyed.programKey).toBe('mosquito_misting');
    expect(futureKeyed.reason).toBe('misting_system_install');
  });

  test('bare "misting" (the barrier program\'s own cycle-length wording) still routes to the barrier protocol', () => {
    // Legacy barrier copy uses "21-day misting" for cycle length — only the
    // two-word "misting system" phrase or the explicit key suppresses.
    expect(match('21-Day Misting Service')).toEqual({
      programKey: 'mosquito',
      visit: 1,
      reason: 'mosquito_barrier',
    });
  });

  test('the plain barrier mosquito keys and word are unchanged', () => {
    const byKey = (serviceType, serviceKey) => {
      const r = matchServiceProtocol(protocols, serviceType, { serviceKey });
      return [r.programKey, r.matchedVisit?.visit, r.reason];
    };
    expect(match('Mosquito Control')).toEqual({
      programKey: 'mosquito',
      visit: 1,
      reason: 'mosquito_barrier',
    });
    expect(byKey('Mosquito Monthly Service', 'mosquito_monthly')).toEqual(['mosquito', 1, 'mosquito_barrier']);
    expect(byKey('Mosquito Seasonal Service', 'mosquito_seasonal')).toEqual(['mosquito', 1, 'mosquito_barrier']);
    expect(byKey('Mosquito One-Time Service', 'mosquito_one_time')).toEqual(['mosquito', 1, 'mosquito_barrier']);
    expect(byKey('Mosquito Event Service', 'mosquito_event')).toEqual(['mosquito', 3, 'mosquito_event_service']);
  });
});

describe('protocol matcher appointment month', () => {
  const withMonth = (serviceType, month) => {
    const r = matchServiceProtocol(protocols, serviceType, { month });
    return [r.programKey, r.matchedVisit?.visit, r.matchedVisit?.month];
  };

  test('tree & shrub resolves the visit for the appointment month, not always visit 1', () => {
    expect(withMonth('Tree & Shrub Care', 'Apr')).toEqual(['tree_shrub', 4, 'Apr']);
    expect(withMonth('Tree and Shrub 6x', 'oct')).toEqual(['tree_shrub', 10, 'Oct']);
    expect(withMonth('Tree & Shrub Care', 'September')).toEqual(['tree_shrub', 9, 'Sep']);
    expect(withMonth('Tree & Shrub Care', '7')).toEqual(['tree_shrub', 7, 'Jul']);
  });

  test('tree & shrub without a usable month keeps the visit-1 fallback', () => {
    expect(withMonth('Tree & Shrub Care', null)).toEqual(['tree_shrub', 1, 'Jan']);
    expect(withMonth('Tree & Shrub Care', 'xyz')).toEqual(['tree_shrub', 1, 'Jan']);
  });

  test("'Any'-month programs keep their rule-picked visit when a month is passed", () => {
    const roach = match('German Roach Cleanout');
    expect(withMonth('German Roach Cleanout', 'Apr')).toEqual([roach.programKey, roach.visit, 'Any']);
    expect(withMonth('Palm Tree Injections', 'Apr')).toEqual(['palm_injection', 2, 'Any']);
  });
});

// Protocols audit 2026-11-26 (item 8): the follow-up rules need their words side by side ("flea recheck"), so a name that states
// a later stage after the service name fell to the first treatment and its growth regulator.
describe('a later stage named anywhere in a flea, cockroach or bed bug name', () => {
  const stage = (name, serviceKey = null) => {
    const result = matchServiceProtocol(protocols, name, { serviceKey });
    return [result.programKey, Number(result.matchedVisit?.visit), result.reason];
  };

  test.each([
    ['Flea Control Service Recheck', ['flea', 2, 'flea_followup']],
    ['Flea Control Service Follow-up', ['flea', 2, 'flea_followup']],
    ['Flea Control Service - Follow Up', ['flea', 2, 'flea_followup']],
    ['Flea Control Service Visit 2', ['flea', 2, 'flea_followup']],
    ['German Roach Treatment 2', ['cockroach', 3, 'cockroach_followup']],
    ['German Roach Cleanout Recheck', ['cockroach', 3, 'cockroach_followup']],
    ['Cockroach Treatment Service 2nd Visit', ['cockroach', 3, 'cockroach_followup']],
    ['Native Roach Recheck', ['cockroach', 3, 'cockroach_followup']],
    ['Bed Bug Treatment Recheck', ['bed_bug', 3, 'bed_bug_followup']],
    ['Bed Bug Treatment Follow-Up', ['bed_bug', 3, 'bed_bug_followup']],
    ['Bed Bug Treatment Service Visit #2', ['bed_bug', 3, 'bed_bug_followup']],
    ['Bed Bug Treatment Service Third Treatment', ['bed_bug', 3, 'bed_bug_followup']],
    // An explicit stage stands when the name also lists an extra.
    ['Flea Control Service Visit 2 with Recheck', ['flea', 2, 'flea_followup']],
    ['German Roach Treatment 2 + Follow-up', ['cockroach', 3, 'cockroach_followup']],
    ['Flea Treatment 2', ['flea', 2, 'flea_followup']],
    ['Bed Bug Treatment 3', ['bed_bug', 3, 'bed_bug_followup']],
    ['Cockroach Treatment Service Visit 2 of 3', ['cockroach', 3, 'cockroach_followup']],
    ['Flea Control Service (Visit 2)', ['flea', 2, 'flea_followup']],
  ])('%s is the later card', (name, expected) => {
    expect(stage(name)).toEqual(expected);
  });

  test('the stage in the name outranks the catalog key, as "treatment 2" already did', () => {
    expect(stage('Flea Control Service Recheck', 'flea_tick')).toEqual(['flea', 2, 'flea_followup']);
    expect(stage('Flea Control Service', 'flea_tick')).toEqual(['flea', 1, 'flea_service']);
  });

  // A package sold on the first visit names its later visit as an extra, or counts the visits sold.
  test.each([
    ['German Roach Cleanout + 14 Day Follow-up', ['cockroach', 1, 'german_roach_cleanout']],
    ['German Roach Cleanout with Recheck', ['cockroach', 1, 'german_roach_cleanout']],
    ['Flea Control Service & Follow-Up', ['flea', 1, 'flea_service']],
    ['Flea Treatment including a 14-day recheck', ['flea', 1, 'flea_service']],
    ['Flea Control Service with a free follow-up', ['flea', 1, 'flea_service']],
    ['German Roach Treatment (Follow-up included)', ['cockroach', 1, 'german_roach_cleanout']],
    ['Flea Control Service, recheck is included', ['flea', 1, 'flea_service']],
    ['German Roach Treatment 2-Visit Package', ['cockroach', 1, 'german_roach_cleanout']],
    ['Bed Bug Treatment Service 2 Treatments', ['bed_bug', 2, 'bed_bug_treatment']],
    // The older side-by-side terms read the name without its package phrases too.
    ['Flea Treatment (2 Visits)', ['flea', 1, 'flea_service']],
    ['Bed Bug Treatment 2-Visit Package', ['bed_bug', 2, 'bed_bug_treatment']],
    ['Bed Bug Treatment 2 treatments', ['bed_bug', 2, 'bed_bug_treatment']],
    // A number that counts rooms is not a visit number.
    ['German Roach Treatment 2 bedrooms', ['cockroach', 1, 'german_roach_cleanout']],
    ['Flea Treatment 2 rooms', ['flea', 1, 'flea_service']],
    ['Bed Bug Treatment 3 Bedrooms', ['bed_bug', 2, 'bed_bug_treatment']],
    ['Vehicle German Roach Treatment (2 Visits)', ['cockroach', 1, 'german_roach_cleanout']],
    ['German Roach Initial Service (3-Visit)', ['cockroach', 1, 'german_roach_cleanout']],
    ['Bed Bug Treatment Service', ['bed_bug', 2, 'bed_bug_treatment']],
    ['Cockroach Treatment Service', ['cockroach', 1, 'cockroach_control']],
  ])('%s stays the first card', (name, expected) => {
    expect(stage(name)).toEqual(expected);
  });

  test('a long free-text name is read in bounded time', () => {
    const started = Date.now();
    expect(stage(`Flea Control Service with ${'a'.repeat(5000)} ${'b '.repeat(3000)}`)).toEqual(['flea', 1, 'flea_service']);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('a heat name keeps its scope review, and other programs are not read for stage words', () => {
    expect(stage('Bed Bug Heat Treatment Follow-up')).toEqual(['bed_bug', 1, 'bed_bug_heat_scope_review']);
    expect(stage('Quarterly Pest Control Recheck')).toEqual(['pest', 1, 'general_pest']);
  });
});
