const {
  REMAINING_SERVICE_PROMPT_VERSION,
  REMAINING_SERVICE_SHARED_CORE,
  REMAINING_SERVICE_MODULES,
  REMAINING_SERVICE_MODIFIERS,
  REMAINING_SERVICE_ADAPTERS,
  SERVICE_KEY_MODULES,
  FINDINGS_TYPE_MODULES,
  selectRemainingServicePrompt,
} = require('../services/service-report/remaining-service-copy-prompts');

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

describe('remaining service copy prompt registry', () => {
  test('exports the complete pack as one shared core, 21 service modules, and two adapters', () => {
    expect(REMAINING_SERVICE_PROMPT_VERSION).toBe('remaining_service_copy_v1');
    expect(Object.keys(REMAINING_SERVICE_MODULES)).toHaveLength(21);
    expect(Object.keys(REMAINING_SERVICE_MODIFIERS)).toEqual([
      'callback', 'commercial', 'program_stage', 'bundled', 'inspection_only',
    ]);
    expect(Object.keys(REMAINING_SERVICE_ADAPTERS)).toEqual(['main', 'typed']);
    expect(REMAINING_SERVICE_SHARED_CORE).toContain('EVIDENCE RULES');
    expect(REMAINING_SERVICE_SHARED_CORE).toContain('visit by Waves Pest Control.');
    expect(REMAINING_SERVICE_SHARED_CORE).not.toContain('Waves Pest Control & Lawn Care');
    expect(REMAINING_SERVICE_ADAPTERS.main).toContain('WHAT WE DID');
    expect(REMAINING_SERVICE_ADAPTERS.typed).toContain('{"summary":"<customer-facing summary>"}');
  });

  test('main selection includes only the shared core, exact service module, and main adapter', () => {
    const prompt = selectRemainingServicePrompt({ serviceKey: 'fire_ant' }, 'main');

    expect(prompt).toContain('SERVICE MODULE — TARGETED ANT / FIRE ANT');
    expect(prompt).toContain('OUTPUT ADAPTER — MAIN TWO-SECTION REPORT');
    expect(prompt).not.toContain('SERVICE MODULE — MOSQUITO');
    expect(prompt).not.toContain('SERVICE MODULE — COCKROACH');
    expect(prompt).not.toContain('OUTPUT ADAPTER — EXISTING TYPED SPECIALTY VISIT SUMMARY');
    expect(occurrences(prompt, 'WAVES SERVICE REPORTS — EVIDENCE, EXPLANATION, AND CUSTOMER CONFIDENCE')).toBe(1);
  });

  test('typed selection can use an exact findings type and keeps the typed schema isolated', () => {
    const prompt = selectRemainingServicePrompt({ findingsType: 'rodent_trapping' }, 'typed');

    expect(prompt).toContain('SERVICE MODULE — RODENT TRAPPING');
    expect(prompt).toContain('OUTPUT ADAPTER — EXISTING TYPED SPECIALTY VISIT SUMMARY');
    expect(prompt).toContain('Return JSON containing exactly one key');
    expect(prompt).not.toContain('OUTPUT ADAPTER — MAIN TWO-SECTION REPORT');
    expect(prompt).not.toContain('SERVICE MODULE — RODENT BAIT STATIONS');
  });

  test('adds only requested modifiers and deduplicates explicit and inferred selection', () => {
    const prompt = selectRemainingServicePrompt({
      serviceKey: 'mosquito_one_time',
      modifiers: ['callback', 'callback'],
      isReservice: true,
      stage: 'initial',
      isCommercial: true,
    }, 'main');

    expect(occurrences(prompt, 'CROSS-SERVICE MODIFIER — CALLBACK / RESERVICE')).toBe(1);
    expect(occurrences(prompt, 'CROSS-SERVICE MODIFIER — COMMERCIAL / MULTIFAMILY')).toBe(1);
    expect(occurrences(prompt, 'CROSS-SERVICE MODIFIER — ONE-TIME, RECURRING, / PROGRAM STAGE')).toBe(1);
    expect(prompt).not.toContain('CROSS-SERVICE MODIFIER — BUNDLED / COMPANION SERVICES');
    expect(prompt).not.toContain('CROSS-SERVICE MODIFIER — INSPECTION-ONLY / NO-APPLICATION');
  });

  test('fails closed for conflicting identities and noncanonical aliases', () => {
    expect(selectRemainingServicePrompt({ serviceKey: 'fire_ant', findingsType: 'flea' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'Fire Ant' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'FIRE_ANT' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'fumigation' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'unknown', findingsType: 'flea' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'wdo_inspection', findingsType: 'flea' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: '__proto__' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'wildlife_removal' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'wdo_inspection' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'termite_slab_pretreat' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ findingsType: 'one_time_pest_treatment' }, 'main')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'fire_ant' }, 'project')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'fire_ant' }, 'constructor')).toBeNull();
    expect(selectRemainingServicePrompt({ serviceKey: 'fire_ant' }, '__proto__')).toBeNull();
  });

  test('binds only code-verified exact keys and omits retired sanitation variants', () => {
    expect(SERVICE_KEY_MODULES).toMatchObject({
      mosquito_monthly: 'mosquito',
      rodent_bait_quarterly: 'rodent_bait',
      termite_active_annual: 'termite_stations',
      flea_tick: 'flea',
      palm_injection_semiannual: 'palm_care',
    });
    expect(FINDINGS_TYPE_MODULES).toMatchObject({
      rodent_bait_station: 'rodent_bait',
      termite_bait_station: 'termite_stations',
      german_roach_knockdown: 'cockroach',
      palm_injection: 'palm_care',
    });
    expect(SERVICE_KEY_MODULES).not.toHaveProperty('rodent_sanitation_medium');
    expect(SERVICE_KEY_MODULES).not.toHaveProperty('rodent_trapping_followup_3pack');
    expect(Object.values(SERVICE_KEY_MODULES)).not.toContain('wildlife_conditional');
    expect(Object.values(SERVICE_KEY_MODULES)).not.toContain('termite_preconstruction');
    expect(Object.values(SERVICE_KEY_MODULES)).not.toContain('wdo_companion');
  });
});
