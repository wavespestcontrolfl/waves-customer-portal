/**
 * Centralized trace eligibility (GATE_TRACE_ELIGIBILITY, dark — owner-ruled
 * build 2026-08-04). One registry decides whether a service may carry a
 * spray trace; the contract blocks the historical failure mode where a new
 * lane was eligible by accident because nobody wrote an exclusion.
 */
const {
  resolveTraceEligibility,
  traceCaptureBlockPayload,
  _test: { FINDINGS_TYPE_RULES, SERVICE_KEY_RULES },
} = require('../services/service-report/trace-eligibility');
const { PROJECT_TYPES } = require('../services/project-types');
const registry = require('../config/completion-lane-registry');

describe('registry contract — nothing is eligible by accident', () => {
  test('EVERY typed findings schema has an explicit trace decision', () => {
    // A new typed lane added to project-types without a decision here would
    // silently fall to name-matching — the accident this module ends.
    for (const findingsType of Object.keys(PROJECT_TYPES)) {
      expect(FINDINGS_TYPE_RULES[findingsType]).toBeDefined();
    }
  });

  test('every rule resolves to a complete verdict', () => {
    for (const [findingsType, rule] of Object.entries(FINDINGS_TYPE_RULES)) {
      const v = resolveTraceEligibility({ findingsType });
      expect(typeof v.eligible).toBe('boolean');
      expect(v.reason).toBeTruthy();
      if (rule.eligible) {
        expect(['spray', 'outline']).toContain(v.variant);
        expect(v.captionKey).toBeTruthy();
      } else {
        expect(v.variant).toBeNull();
      }
    }
    for (const serviceKey of Object.keys(SERVICE_KEY_RULES)) {
      const v = resolveTraceEligibility({ serviceKey });
      expect(typeof v.eligible).toBe('boolean');
      expect(v.reason).not.toBe('unclassified_service');
    }
  });

  test('every catalog key the completion-lane registry names classifies explicitly', () => {
    // The completion-lane registry is the catalog's decided universe for
    // generic lanes — a key it names must never read as unclassified here.
    const lists = registry.ALL_LISTS;
    const listedKeys = [
      ...lists.owner_excluded,
      ...lists.billing_rider,
      ...lists.recurring_generic_by_design,
      ...lists.one_time_generic_by_design,
      ...lists.compliance_project,
    ];
    expect(listedKeys.length).toBeGreaterThan(15);
    for (const serviceKey of listedKeys) {
      expect(resolveTraceEligibility({ serviceKey }).reason)
        .not.toBe('unclassified_service');
    }
  });

  test('an unknown service is INELIGIBLE until classified', () => {
    expect(resolveTraceEligibility({ serviceKey: 'brand_new_admin_key', displayName: 'Attic Encapsulation' }))
      .toMatchObject({ eligible: false, reason: 'unclassified_service' });
  });
});

describe('classification behavior', () => {
  test('spray, lawn, and never lanes resolve as ruled', () => {
    expect(resolveTraceEligibility({ serviceKey: 'pest_general_quarterly' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({ serviceKey: 'lawn_care_monthly' }))
      .toMatchObject({ eligible: true, variant: 'outline' });
    expect(resolveTraceEligibility({ serviceKey: 'termite_liquid' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    // pest-PRIMARY bundle (codex P1 r1): the combined visit sprays; the
    // bait work is a companion — a pure bait stop routes through the
    // termite_bait_station typed pointer instead
    expect(resolveTraceEligibility({ serviceKey: 'pest_termite_bait_quarterly' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({ findingsType: 'termite_bait_station' }))
      .toMatchObject({ eligible: false, reason: 'bait_station_lane' });
    expect(resolveTraceEligibility({ findingsType: 'rodent_trapping' }))
      .toMatchObject({ eligible: false, reason: 'trap_lane' });
    expect(resolveTraceEligibility({ findingsType: 'termite_inspection' }))
      .toMatchObject({ eligible: false, reason: 'inspection_lane' });
    expect(resolveTraceEligibility({ findingsType: 'bed_bug' }))
      .toMatchObject({ eligible: false, reason: 'interior_only_lane' });
  });

  test('the typed pointer outranks the catalog key', () => {
    // A combined profile can resolve a spray-ish key while the frozen
    // snapshot is a trapping report — the snapshot's findingsType wins
    // (the trap-lane snapshot-is-authority rule).
    expect(resolveTraceEligibility({
      serviceKey: 'pest_general_quarterly',
      findingsType: 'rodent_trapping',
    })).toMatchObject({ eligible: false, reason: 'trap_lane' });
  });

  test('display names are the last resort, in both directions', () => {
    expect(resolveTraceEligibility({ displayName: 'Bed Bug Treatment — Master Suite' }))
      .toMatchObject({ eligible: false, reason: 'interior_only_lane' });
    expect(resolveTraceEligibility({ displayName: 'Rodent Trapping Follow-Up' }))
      .toMatchObject({ eligible: false, reason: 'trap_lane' });
    expect(resolveTraceEligibility({ displayName: 'Quarterly Pest Control' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({ displayName: 'Lawn Fertilization Round 3' }))
      .toMatchObject({ eligible: true, variant: 'outline' });
    // combined pest+bait names are pest-primary bundles; pure bait is not
    expect(resolveTraceEligibility({ displayName: 'Quarterly Pest + Termite Bait Station' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({ displayName: 'Termite Bait Quarterly' }))
      .toMatchObject({ eligible: false, reason: 'bait_station_lane' });
  });

  test('a SUPPLIED stable key that missed the registry fails closed — labels cannot rescue it', () => {
    // codex P1 r1: an admin-added key whose editable label says "Pest"
    // must not become eligible by name — fallback is for rows with no
    // stable identity at all.
    expect(resolveTraceEligibility({ serviceKey: 'pest_consultation', displayName: 'Pest Consultation' }))
      .toMatchObject({ eligible: false, reason: 'unclassified_service' });
    expect(resolveTraceEligibility({ findingsType: 'future_new_schema', displayName: 'Lawn Something' }))
      .toMatchObject({ eligible: false, reason: 'unclassified_service' });
  });
});

describe('capture-side block payload (tech write routes)', () => {
  const prevGate = process.env.GATE_TRACE_ELIGIBILITY;
  afterEach(() => {
    if (prevGate === undefined) delete process.env.GATE_TRACE_ELIGIBILITY;
    else process.env.GATE_TRACE_ELIGIBILITY = prevGate;
    jest.resetModules();
  });

  test('gate off: never blocks (current behavior preserved)', async () => {
    delete process.env.GATE_TRACE_ELIGIBILITY;
    expect(await traceCaptureBlockPayload({ service_type: 'Rodent Trapping' }, null)).toBeNull();
  });

  test('gate on: an ineligible service 403s with the reason', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    jest.isolateModules(() => {});
    jest.doMock('../services/service-completion-profiles', () => ({
      resolveCompletionProfileForScheduledService: jest.fn(async () => ({
        serviceKey: null, findingsType: 'termite_bait_station',
      })),
    }));
    let block;
    await jest.isolateModulesAsync(async () => {
      const mod = require('../services/service-report/trace-eligibility');
      block = await mod.traceCaptureBlockPayload({ service_type: 'Termite Bait Station Check' }, null);
    });
    expect(block).toMatchObject({
      status: 403,
      payload: { code: 'trace_ineligible_service', reason: 'bait_station_lane' },
    });
    jest.dontMock('../services/service-completion-profiles');
  });

  test('gate on: an eligible service passes, and a resolver error fails OPEN', async () => {
    process.env.GATE_TRACE_ELIGIBILITY = 'true';
    jest.doMock('../services/service-completion-profiles', () => ({
      resolveCompletionProfileForScheduledService: jest.fn(async () => ({
        serviceKey: 'pest_general_quarterly', findingsType: null,
      })),
    }));
    await jest.isolateModulesAsync(async () => {
      const mod = require('../services/service-report/trace-eligibility');
      expect(await mod.traceCaptureBlockPayload({ service_type: 'Quarterly Pest Control' }, null)).toBeNull();
    });
    jest.dontMock('../services/service-completion-profiles');
    jest.doMock('../services/service-completion-profiles', () => ({
      resolveCompletionProfileForScheduledService: jest.fn(async () => { throw new Error('db down'); }),
    }));
    await jest.isolateModulesAsync(async () => {
      const mod = require('../services/service-report/trace-eligibility');
      expect(await mod.traceCaptureBlockPayload({ service_type: 'Rodent Trapping' }, null)).toBeNull();
    });
    jest.dontMock('../services/service-completion-profiles');
  });
});
