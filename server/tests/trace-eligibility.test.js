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
    // codex P1 r3: German knockdown is an interior bait/IGR program — no
    // exterior work in its lane — while palmetto explicitly treats the
    // exterior perimeter.
    expect(resolveTraceEligibility({ findingsType: 'german_roach_knockdown' }))
      .toMatchObject({ eligible: false, reason: 'interior_only_lane' });
    expect(resolveTraceEligibility({ findingsType: 'palmetto_roach_knockdown' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
  });

  test('ineligible verdicts win in BOTH precedence directions', () => {
    // A frozen trapping snapshot widens suppression over a spray key
    // (snapshot-is-authority)…
    expect(resolveTraceEligibility({
      serviceKey: 'pest_general_quarterly',
      findingsType: 'rodent_trapping',
    })).toMatchObject({ eligible: false, reason: 'trap_lane' });
    // …and an explicitly ineligible key overrides a STALE eligible
    // snapshot (codex P1 r4: lawn_inspection completed during that key's
    // brief typed era must not keep a treatment trace).
    expect(resolveTraceEligibility({
      serviceKey: 'lawn_inspection',
      findingsType: 'one_time_lawn_treatment',
    })).toMatchObject({ eligible: false, reason: 'inspection_lane' });
  });

  test('the membership billing row never traces', () => {
    expect(resolveTraceEligibility({ serviceKey: 'waveguard_membership' }))
      .toMatchObject({ eligible: false, reason: 'billing_rider' });
  });

  test('roach-family eligibility is conditional on recorded exterior work at render', () => {
    // capture side (no typedValues): the tech in the field may trace
    expect(resolveTraceEligibility({ findingsType: 'cockroach' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    // render side, exterior chip recorded (array and CSV shapes)
    expect(resolveTraceEligibility({
      findingsType: 'cockroach',
      typedValues: { treatment_completed: ['Bait placement', 'Exterior perimeter treatment'] },
    })).toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({
      findingsType: 'palmetto_roach_knockdown',
      typedValues: { treatment_completed: 'Interior crack & crevice, Exterior perimeter treatment' },
    })).toMatchObject({ eligible: true });
    // render side, interior-only work — the German-species case on the
    // active cockroach_control lane (codex P1 r4)
    expect(resolveTraceEligibility({
      findingsType: 'cockroach',
      typedValues: { treatment_completed: ['Bait placement', 'IGR application'] },
    })).toMatchObject({ eligible: false, reason: 'no_exterior_work_recorded' });
    // render side, no snapshot at all — fails closed
    expect(resolveTraceEligibility({ findingsType: 'cockroach', typedValues: null }))
      .toMatchObject({ eligible: false, reason: 'no_exterior_work_recorded' });
    // codex P1 r5: the ACTIVE cockroach schema records in work_completed,
    // not treatment_completed — both fields are read
    expect(resolveTraceEligibility({
      findingsType: 'cockroach',
      typedValues: { work_completed: ['Bait placement', 'Exterior perimeter treatment'] },
    })).toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({
      findingsType: 'cockroach',
      typedValues: { work_completed: ['Bait placement', 'Dust application'] },
    })).toMatchObject({ eligible: false, reason: 'no_exterior_work_recorded' });
  });

  test('flea is evidence-conditional too, and its lawn chip counts as exterior (round 5)', () => {
    expect(resolveTraceEligibility({ findingsType: 'flea' }))
      .toMatchObject({ eligible: true }); // capture side
    expect(resolveTraceEligibility({
      findingsType: 'flea',
      typedValues: { treatment_completed: ['Exterior flea treatment', 'Growth regulator'] },
    })).toMatchObject({ eligible: true, variant: 'outline' }); // yard geometry (r9)
    expect(resolveTraceEligibility({
      findingsType: 'flea',
      typedValues: { treatment_completed: 'Lawn treatment, Pet resting area treatment' },
    })).toMatchObject({ eligible: true });
    expect(resolveTraceEligibility({
      findingsType: 'flea',
      typedValues: { treatment_completed: ['Interior flea treatment', 'Growth regulator'] },
    })).toMatchObject({ eligible: false, reason: 'no_exterior_work_recorded' });
    expect(resolveTraceEligibility({
      findingsType: 'flea',
      typedValues: { treatment_completed: 'Inspection only' },
    })).toMatchObject({ eligible: false, reason: 'no_exterior_work_recorded' });
  });

  test('termite spot treatment is localized — never a perimeter trace (round 5)', () => {
    expect(resolveTraceEligibility({ serviceKey: 'termite_spot_treatment' }))
      .toMatchObject({ eligible: false, reason: 'localized_treatment_lane' });
    // the ineligible KEY beats the eligible termite_treatment pointer it shares
    expect(resolveTraceEligibility({
      serviceKey: 'termite_spot_treatment',
      findingsType: 'termite_treatment',
    })).toMatchObject({ eligible: false, reason: 'localized_treatment_lane' });
  });

  test('inspection-capable lanes need applied work at render (round 6)', () => {
    // capture side stays permissive
    expect(resolveTraceEligibility({ findingsType: 'tree_shrub' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    // T&S derives treatments_completed='Inspection only' with no products;
    // r11 tightened it to CHIP-MATCHED — fertilizer/soil work is real but
    // a spray trace cannot depict it
    expect(resolveTraceEligibility({
      findingsType: 'tree_shrub',
      typedValues: { treatments_completed: 'Inspection only' },
    })).toMatchObject({ eligible: false, reason: 'no_traceable_treatment_recorded' });
    expect(resolveTraceEligibility({
      findingsType: 'tree_shrub',
      typedValues: { treatments_completed: 'Fertilizer, Micronutrients, Soil drench' },
    })).toMatchObject({ eligible: false, reason: 'no_traceable_treatment_recorded' });
    expect(resolveTraceEligibility({
      findingsType: 'tree_shrub',
      typedValues: { treatments_completed: 'Fertilizer, Foliar treatment' },
    })).toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({
      findingsType: 'tree_shrub',
      typedValues: { treatments_completed: ['Insect treatment', 'Horticultural oil'] },
    })).toMatchObject({ eligible: true });
    expect(resolveTraceEligibility({
      findingsType: 'mosquito_event',
      typedValues: { treatment_completed: ['Inspection only'] },
    })).toMatchObject({ eligible: false, reason: 'no_treatment_recorded' });
    // codex P1 r7: source reduction is real work but not an application —
    // tipping containers cannot honestly render as a sprayed perimeter
    expect(resolveTraceEligibility({
      findingsType: 'mosquito_event',
      typedValues: { treatment_completed: ['Source reduction'] },
    })).toMatchObject({ eligible: false, reason: 'no_treatment_recorded' });
    expect(resolveTraceEligibility({
      findingsType: 'mosquito_event',
      typedValues: { treatment_completed: ['Barrier treatment', 'Source reduction'] },
    })).toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({
      findingsType: 'one_time_lawn_treatment',
      typedValues: { work_completed: 'Inspection completed' },
    })).toMatchObject({ eligible: false, reason: 'no_treatment_recorded' });
    expect(resolveTraceEligibility({
      findingsType: 'one_time_lawn_treatment',
      typedValues: { work_completed: ['Fertilizer application', 'Inspection completed'] },
    })).toMatchObject({ eligible: true, variant: 'outline' });
  });

  test('fire ant traces the LAWN, nest removals never trace, the retired combo keeps its maps (round 6)', () => {
    expect(resolveTraceEligibility({ serviceKey: 'fire_ant' }))
      .toMatchObject({ eligible: true, variant: 'outline' });
    expect(resolveTraceEligibility({ serviceKey: 'bee_wasp_removal' }))
      .toMatchObject({ eligible: false, reason: 'localized_treatment_lane' });
    expect(resolveTraceEligibility({ serviceKey: 'mud_dauber_removal' }))
      .toMatchObject({ eligible: false, reason: 'localized_treatment_lane' });
    // 3 completed historical visits deliberately retained at retirement
    expect(resolveTraceEligibility({ serviceKey: 'pest_rodent_quarterly' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
  });

  test('stale historical snapshots do not defeat key-specific semantics (round 8)', () => {
    // fire_ant completed pre-untype carries a one_time_pest_treatment
    // snapshot — the key's LAWN geometry overrides that retired generic
    // pointer (overridesSnapshot)
    expect(resolveTraceEligibility({
      serviceKey: 'fire_ant',
      findingsType: 'one_time_pest_treatment',
    })).toMatchObject({ eligible: true, variant: 'outline' });
    // …but a key WITHOUT the override never steals conditional semantics
    // from its typed pointer: an inspection-only T&S combo still suppresses
    expect(resolveTraceEligibility({
      serviceKey: 'lawn_tree_shrub_combo',
      findingsType: 'tree_shrub',
      typedValues: { treatments_completed: 'Inspection only' },
    })).toMatchObject({ eligible: false, reason: 'no_traceable_treatment_recorded' });
    // legacy station keys repointed by the bait-station cutover: the
    // explicit ineligible KEY rule overrides the old termite_treatment
    // snapshot
    expect(resolveTraceEligibility({
      serviceKey: 'termite_installation_setup',
      findingsType: 'termite_treatment',
    })).toMatchObject({ eligible: false, reason: 'bait_station_lane' });
    expect(resolveTraceEligibility({
      serviceKey: 'termite_cartridge_replacement',
      findingsType: 'termite_treatment',
    })).toMatchObject({ eligible: false, reason: 'bait_station_lane' });
  });

  test('larvicide-only mosquito visits cannot substantiate a perimeter trace (round 9)', () => {
    expect(resolveTraceEligibility({
      findingsType: 'mosquito_event',
      typedValues: { treatment_completed: ['Larvicide applied'] },
    })).toMatchObject({ eligible: false, reason: 'no_treatment_recorded' });
    expect(resolveTraceEligibility({
      findingsType: 'mosquito_event',
      typedValues: { treatment_completed: ['Larvicide applied', 'Barrier treatment'] },
    })).toMatchObject({ eligible: true, variant: 'spray' });
  });

  test('tick control is yard geometry and survives its stale snapshot (round 10)', () => {
    expect(resolveTraceEligibility({ serviceKey: 'tick_control' }))
      .toMatchObject({ eligible: true, variant: 'outline' });
    expect(resolveTraceEligibility({
      serviceKey: 'tick_control',
      findingsType: 'one_time_pest_treatment',
    })).toMatchObject({ eligible: true, variant: 'outline' });
  });

  test('termite traces require a recorded perimeter method at render (round 10)', () => {
    // capture side stays permissive
    expect(resolveTraceEligibility({ findingsType: 'termite_treatment' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({
      findingsType: 'termite_treatment',
      typedValues: { treatment_method: 'Liquid perimeter' },
    })).toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({
      findingsType: 'termite_treatment',
      typedValues: { treatment_method: 'Trenching' },
    })).toMatchObject({ eligible: true });
    for (const method of ['Wood treatment', 'Spot treatment', 'Bait station setup', 'Cartridge replacement', 'Other']) {
      expect(resolveTraceEligibility({
        findingsType: 'termite_treatment',
        typedValues: { treatment_method: method },
      })).toMatchObject({ eligible: false, reason: 'no_perimeter_method_recorded' });
    }
    // no snapshot at all fails closed at render
    expect(resolveTraceEligibility({ findingsType: 'termite_treatment', typedValues: null }))
      .toMatchObject({ eligible: false, reason: 'no_perimeter_method_recorded' });
  });

  test('an eligible add-on line rescues an ineligible primary (round 11)', () => {
    const { combineLineVerdicts } = require('../services/service-report/trace-eligibility');
    const baitPrimary = resolveTraceEligibility({ findingsType: 'termite_bait_station' });
    const pestAddon = resolveTraceEligibility({ serviceKey: 'pest_general_quarterly' });
    // termite-bait primary + pest add-on → the appointment traces as spray
    expect(combineLineVerdicts(baitPrimary, [pestAddon]))
      .toMatchObject({ eligible: true, variant: 'spray' });
    // an eligible PRIMARY always wins (it carries conditional semantics)
    const lawnPrimary = resolveTraceEligibility({ serviceKey: 'lawn_care_monthly' });
    expect(combineLineVerdicts(lawnPrimary, [pestAddon]))
      .toMatchObject({ eligible: true, variant: 'outline' });
    // no eligible line anywhere → the primary's verdict stands
    const inspectionAddon = resolveTraceEligibility({ findingsType: 'pest_inspection' });
    expect(combineLineVerdicts(baitPrimary, [inspectionAddon]))
      .toMatchObject({ eligible: false, reason: 'bait_station_lane' });
  });

  test('round 13 — evidence at render for callbacks, yard names, conditional add-ons', () => {
    // pest_re_service: capture permissive, render needs exterior areas
    expect(resolveTraceEligibility({ serviceKey: 'pest_re_service' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({
      serviceKey: 'pest_re_service',
      renderAreas: 'Kitchen, Bathrooms',
    })).toMatchObject({ eligible: false, reason: 'no_exterior_area_recorded' });
    expect(resolveTraceEligibility({
      serviceKey: 'pest_re_service',
      renderAreas: 'Kitchen, Exterior perimeter',
    })).toMatchObject({ eligible: true, variant: 'spray' });
    // EMPTY evidence passes (r17): the recap flow records no areas, and
    // the captured trace stands as the tech's exterior record — only a
    // recorded-interior completion contradicts it
    expect(resolveTraceEligibility({ serviceKey: 'pest_re_service', renderAreas: '' }))
      .toMatchObject({ eligible: true, variant: 'spray' });
    // identity-less yard families resolve outline by NAME too
    expect(resolveTraceEligibility({ displayName: 'Fire Ant Treatment' }))
      .toMatchObject({ eligible: true, variant: 'outline' });
    expect(resolveTraceEligibility({ displayName: 'Tick Control — Backyard' }))
      .toMatchObject({ eligible: true, variant: 'outline' });
    expect(resolveTraceEligibility({ displayName: 'Flea & Tick Yard Service' }))
      .toMatchObject({ eligible: true, variant: 'outline' });
    // conditional typed rules fail closed with null evidence — the
    // render-side posture resolveAddonVerdicts uses for add-on lines
    expect(resolveTraceEligibility({ findingsType: 'flea', typedValues: null }))
      .toMatchObject({ eligible: false });
    expect(resolveTraceEligibility({ findingsType: 'mosquito_event', typedValues: null }))
      .toMatchObject({ eligible: false });
  });

  test('round 14 — protocol scopes count as exterior evidence; frozen add-on lines resolve', async () => {
    const { renderAreasFromRecord, addonVerdictsFromLines } = require('../services/service-report/trace-eligibility');
    // an exterior APPLIED protocol action alone is exterior evidence
    expect(renderAreasFromRecord({
      areas_serviced: '[]',
      structured_notes: JSON.stringify({
        protocolActionScopesCompleted: [{ scope: 'exterior', treatmentApplied: true }],
      }),
    })).toMatch(/exterior/i);
    // a not-applied or interior-only action is not
    expect(renderAreasFromRecord({
      areas_serviced: JSON.stringify(['Kitchen']),
      structured_notes: JSON.stringify({
        protocolActionScopesCompleted: [
          { scope: 'exterior', treatmentApplied: false },
          { scope: 'interior', treatmentApplied: true },
        ],
      }),
    })).not.toMatch(/exterior/i);
    // frozen completion lines resolve verdicts by name without a knex
    // catalog hit (null ids)
    const verdicts = await addonVerdictsFromLines(
      [{ serviceId: null, serviceName: 'Quarterly Pest Control' }],
      { /* knex unused for name-only lines */ },
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ eligible: true, variant: 'spray' });
  });

  test('round 18 — a failed or unresolved catalog lookup never broadens add-on eligibility', async () => {
    const { addonVerdictsFromLines } = require('../services/service-report/trace-eligibility');
    const throwingKnex = () => ({
      whereIn: () => { throw new Error('db down'); },
    });
    // supplied id + lookup failure: fails closed, the editable name
    // ("Bee / Wasp Nest Removal" would match the spray regex) cannot rescue
    const failed = await addonVerdictsFromLines(
      [{ serviceId: 'svc-1', serviceName: 'Bee / Wasp Nest Removal' }],
      throwingKnex,
    );
    expect(failed[0]).toMatchObject({ eligible: false, reason: 'unclassified_service' });
    // supplied id that resolves to NO row (deleted catalog row): same
    const emptyKnex = () => ({
      whereIn: () => ({ select: () => Promise.resolve([]) }),
    });
    const unresolved = await addonVerdictsFromLines(
      [{ serviceId: 'svc-gone', serviceName: 'Quarterly Pest Control' }],
      emptyKnex,
    );
    expect(unresolved[0]).toMatchObject({ eligible: false, reason: 'unclassified_service' });
    // genuinely unlinked legacy line (no id): name fallback stands
    const legacy = await addonVerdictsFromLines(
      [{ serviceId: null, serviceName: 'Quarterly Pest Control' }],
      emptyKnex,
    );
    expect(legacy[0]).toMatchObject({ eligible: true, variant: 'spray' });
  });

  test('fallback tokens are word-bounded — embedded substrings never classify (round 5)', () => {
    for (const displayName of ['Warranty Renewal', 'Plant Consultation', 'Care Approach', 'Street Sweeping']) {
      expect(resolveTraceEligibility({ displayName }))
        .toMatchObject({ eligible: false, reason: 'unclassified_service' });
    }
    // real tokens still classify (yard families → outline since r13)
    expect(resolveTraceEligibility({ displayName: 'Fire Ant Treatment' }))
      .toMatchObject({ eligible: true, variant: 'outline' });
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
