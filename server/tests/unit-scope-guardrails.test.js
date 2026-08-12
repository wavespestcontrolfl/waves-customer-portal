/**
 * Unit-scope guardrails (GATE_UNIT_SCOPE_GUARDRAILS) — owner ruling
 * 2026-08-11, PR1 of the apartment/condo estimator lane.
 *
 * Pins the two live failures the lane closes:
 *  - The apartment-tenant shape (tenant, 1BR unit in a rental complex): classification must
 *    stay first-class (residential_unit / multifamily_rental / tenant) and
 *    the absent lot must resolve NOT APPLICABLE, never "missing".
 *  - The flex-suite shape (commercial suite, address with no street number): the
 *    address must red-lane and the commercial prose must block a
 *    residential auto-price.
 */

const {
  unitScopeGuardrailsEnabled,
  hasPrimaryStreetNumber,
  commercialTextSignal,
  commercialCategoryConflict,
  resolveUnitScopeModel,
  applyUnitScopeToPropertyFacts,
} = require('../services/estimator-engine/unit-scope-model');

const withGate = (value, fn) => {
  const prev = process.env.GATE_UNIT_SCOPE_GUARDRAILS;
  if (value === undefined) delete process.env.GATE_UNIT_SCOPE_GUARDRAILS;
  else process.env.GATE_UNIT_SCOPE_GUARDRAILS = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GATE_UNIT_SCOPE_GUARDRAILS;
    else process.env.GATE_UNIT_SCOPE_GUARDRAILS = prev;
  }
};

describe('gate semantics', () => {
  test('defaults OFF; accepts 1/true/on', () => {
    withGate(undefined, () => expect(unitScopeGuardrailsEnabled()).toBe(false));
    withGate('false', () => expect(unitScopeGuardrailsEnabled()).toBe(false));
    withGate('true', () => expect(unitScopeGuardrailsEnabled()).toBe(true));
    withGate('1', () => expect(unitScopeGuardrailsEnabled()).toBe(true));
    withGate('on', () => expect(unitScopeGuardrailsEnabled()).toBe(true));
  });
});

describe('hasPrimaryStreetNumber', () => {
  test('real street numbers pass', () => {
    expect(hasPrimaryStreetNumber('900 Bayview Ter, Venice, FL 34285')).toBe(true);
    expect(hasPrimaryStreetNumber('123A Main St')).toBe(true);
    expect(hasPrimaryStreetNumber('123-125 Main St')).toBe(true);
    expect(hasPrimaryStreetNumber('7 Palm Ave')).toBe(true);
    expect(hasPrimaryStreetNumber('728 132nd Street Circle NE')).toBe(true);
  });
  test('ordinal street NAMES without a house number fail (the number-less ordinal-street class)', () => {
    expect(hasPrimaryStreetNumber('62nd Avenue East, Unit 7, FL 34221')).toBe(false);
    expect(hasPrimaryStreetNumber('Palm Ave')).toBe(false);
    expect(hasPrimaryStreetNumber('')).toBe(false);
    expect(hasPrimaryStreetNumber(null)).toBe(false);
  });
});

describe('commercialTextSignal', () => {
  test("fires on the caller's own commercial premises", () => {
    expect(commercialTextSignal(
      'Brand-new industrial building near I-75 and US 301. Service is only for '
      + "the caller's unit, which includes office and warehouse space.",
    )).toBe(true);
    expect(commercialTextSignal('ants in our restaurant kitchen')).toBe(true);
    expect(commercialTextSignal('we lease suite 240 at the plaza')).toBe(true);
  });
  test('stays quiet on residential prose that mentions work', () => {
    expect(commercialTextSignal('ants in my home office and the kitchen')).toBe(false);
    expect(commercialTextSignal('I work at an office downtown but the ants are at my house')).toBe(false);
    expect(commercialTextSignal('quarterly pest control for my apartment')).toBe(false);
    expect(commercialTextSignal('')).toBe(false);
  });
});

describe('commercialCategoryConflict', () => {
  test('fires when the extraction typed the premises commercial but the intent stayed residential', () => {
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'industrial' } },
      intent: { is_commercial: false },
    })).toBe('industrial');
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'Office' } },
      intent: {},
    })).toBe('office');
  });
  test('no conflict when the intent is commercial, or the type is residential/unit', () => {
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'industrial' } },
      intent: { is_commercial: true },
    })).toBeNull();
    // Apartment/multifamily are NOT commercial signals — a unit tenant is a
    // residential customer (the ≥5-unit whole-property rule lives elsewhere).
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'apartment' } },
      intent: { is_commercial: false },
    })).toBeNull();
    expect(commercialCategoryConflict({ extraction: null, intent: { is_commercial: false } })).toBeNull();
  });
  test('free-form variants and HOA/common-area families still conflict', () => {
    // The extraction field is free-form — family matching, not an
    // exact-string set (codex pre-push P1); HOA/common-area types trigger
    // commercial handling by schema even when their text carries
    // residential words like 'condo' (codex r1 P1).
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'industrial_flex' } },
      intent: { is_commercial: false },
    })).toBe('industrial_flex');
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'commercial property' } },
      intent: { is_commercial: false },
    })).toBe('commercial property');
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'hoa_common_area' } },
      intent: { is_commercial: false },
    })).toBe('hoa_common_area');
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'condo_association' } },
      intent: { is_commercial: false },
    })).toBe('condo_association');
    // Residential families never conflict, including warehouse/downtown traps.
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'townhouse' } },
      intent: { is_commercial: false },
    })).toBeNull();
  });
});

describe('resolveUnitScopeModel — unknown stays unknown in the audit', () => {
  test('a schema-valid unknown (or unrecognized) type never records single_family', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: { caller: {}, property: { property_type: 'unknown' } },
      intent: { is_commercial: false, address: '100 Palm Ave, Venice FL' },
      propertyFacts: { home: { source: 'unresolved' } },
      address: '100 Palm Ave, Venice FL',
    });
    expect(model.propertyUse).toBe('unknown');
  });
});

describe('resolveUnitScopeModel — the apartment-tenant shape', () => {
  const tenantUnit = {
    propertyRecord: null,
    extraction: {
      caller: { relationship_to_property: 'tenant' },
      property: { property_type: 'apartment' },
    },
    intent: { is_commercial: false, address: '900 Bayview Ter, Apartment 4102, Venice, FL 34285' },
    propertyFacts: { tenant: true, home: { value: null, source: 'unresolved' } },
    address: '900 Bayview Ter, Apartment 4102, Venice, FL 34285',
  };

  test('classifies unit / multifamily / tenant with truthful size basis', () => {
    const model = resolveUnitScopeModel(tenantUnit);
    expect(model.serviceScope).toBe('residential_unit');
    expect(model.propertyUse).toBe('multifamily_rental');
    expect(model.customerRelationship).toBe('tenant');
    expect(model.sizeBasis).toBe('unresolved');
  });

  test('marks the absent lot NOT APPLICABLE for a unit scope', () => {
    const model = resolveUnitScopeModel(tenantUnit);
    const facts = { tenant: true, lot: { value: null, source: 'unresolved', confidence: 'none' } };
    applyUnitScopeToPropertyFacts(facts, model);
    expect(facts.lot.value).toBeNull();
    expect(facts.lot.source).toMatch(/^not_applicable:/);
    expect(facts.lot.confidence).toBe('high');
  });

  test('a master-parcel lot that leaked into a unit scope is CLEARED into the rejected trail', () => {
    const model = resolveUnitScopeModel(tenantUnit);
    const withLot = { lot: { value: 98000, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(withLot, model);
    // The only lot a lookup can see for a unit is the development's master
    // parcel — pricing a complex's parcel for one unit is the overquote
    // class the V2 bridge already clears (codex r1 P1).
    expect(withLot.lot.value).toBeNull();
    expect(withLot.lot.source).toMatch(/^not_applicable:/);
    expect(withLot.lot.rejected).toEqual([
      expect.objectContaining({ value: 98000, source: 'county_assessed' }),
    ]);
  });

  test('whole-structure scopes are untouched', () => {
    const owner = resolveUnitScopeModel({
      ...tenantUnit,
      extraction: { caller: { relationship_to_property: 'owner' }, property: { property_type: 'single_family' } },
      propertyFacts: { tenant: false, home: { source: 'county_assessed' } },
      intent: { is_commercial: false, address: '100 Palm Ave, Venice FL' },
      address: '100 Palm Ave, Venice FL',
    });
    expect(owner.serviceScope).toBe('entire_residential_structure');
    const ownerFacts = { lot: { value: null, source: 'unresolved', confidence: 'none' } };
    applyUnitScopeToPropertyFacts(ownerFacts, owner);
    expect(ownerFacts.lot.source).toBe('unresolved');
  });

  test('commercial tenant classifies as a suite', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: {
        caller: { relationship_to_property: 'tenant' },
        property: { property_type: 'industrial' },
      },
      intent: { is_commercial: true, address: '4801 Industrial Way, Unit 7, Parrish FL' },
      propertyFacts: { tenant: true, home: { source: 'unresolved' } },
      address: '4801 Industrial Way, Unit 7, Parrish FL',
    });
    expect(model.serviceScope).toBe('commercial_suite');
    expect(model.propertyUse).toBe('industrial_flex');
  });
});

describe('classifyLane guardrails', () => {
  const { classifyLane } = require('../services/estimator-engine/draft-builder');
  const pricedLine = {
    service: 'pest_control', monthlyAfterDiscount: 37.33, annualAfterDiscount: 448,
  };
  const baseArgs = {
    intent: {
      decision: 'draft',
      is_commercial: false,
      confidence: 'high',
      services: { pest: { frequency: 'quarterly' } },
      address: '900 Bayview Ter, Venice, FL 34285',
      evidence: [{ quote: 'quarterly pest control for my apartment please', speaker: 'caller' }],
    },
    propertyFacts: { home: { value: 1200, source: 'county_assessed' }, lot: { value: 5000, source: 'county_assessed' }, propertyType: 'condo_ground' },
    engineResult: { lineItems: [pricedLine] },
    totals: { monthly: 37.33, annual: 448, oneTime: 0 },
    comps: null,
    calibration: [],
    context: { transcript: 'quarterly pest control for my apartment please', phone: '+19415550140' },
  };

  test('gate ON: an address without a primary street number is RED with a machine-readable cause', () => {
    withGate('true', () => {
      const out = classifyLane({
        ...baseArgs,
        intent: { ...baseArgs.intent, address: '62nd Avenue East, Unit 7, FL 34221' },
      });
      expect(out.lane).toBe('red');
      expect(out.causes).toContain('incomplete_address');
    });
  });

  test('gate OFF: the same address keeps today\'s behavior (no red)', () => {
    withGate(undefined, () => {
      const out = classifyLane({
        ...baseArgs,
        intent: { ...baseArgs.intent, address: '62nd Avenue East, Unit 7, FL 34221' },
      });
      expect(out.lane).not.toBe('red');
    });
  });

  test('gate ON: a commercial extraction type on a residential draft is RED (category_conflict)', () => {
    withGate('true', () => {
      const out = classifyLane({
        ...baseArgs,
        context: {
          ...baseArgs.context,
          extraction: { property: { property_type: 'industrial' } },
        },
      });
      expect(out.lane).toBe('red');
      expect(out.causes).toContain('category_conflict');
    });
  });

  test('unresolved property type parks the draft yellow via the engine-input stamp', () => {
    withGate('true', () => {
      const out = classifyLane({
        ...baseArgs,
        propertyFacts: { ...baseArgs.propertyFacts, propertyType: null, propertyTypeUnresolved: true },
      });
      expect(out.lane).toBe('yellow');
      expect(out.reasons.join(' ')).toMatch(/property type unresolved/);
    });
  });

  test('a not_applicable lot never yellow-lanes a lot-driven check', () => {
    withGate('true', () => {
      const out = classifyLane({
        ...baseArgs,
        propertyFacts: {
          ...baseArgs.propertyFacts,
          lot: { value: null, source: 'not_applicable:leased_land', confidence: 'high' },
        },
      });
      expect(out.reasons.join(' ')).not.toMatch(/lot sqft/);
    });
  });
});

describe('buildEngineInput property-type fallback', () => {
  const { buildEngineInput } = require('../services/estimator-engine/draft-builder');
  const args = {
    intent: { is_commercial: false, services: { pest: {} }, address: '100 Palm Ave' },
    propertyFacts: { home: { value: null, source: 'unresolved' }, lot: { value: null, source: 'unresolved' } },
    context: {},
  };
  test('gate ON: unresolved classification prices as literal unknown, never single_family', () => {
    withGate('true', () => {
      expect(buildEngineInput(args).propertyType).toBe('unknown');
    });
  });
  test('gate OFF: legacy default preserved', () => {
    withGate(undefined, () => {
      expect(buildEngineInput(args).propertyType).toBe('Single Family');
    });
  });
  test('a resolved type is used regardless of the gate', () => {
    withGate('true', () => {
      expect(buildEngineInput({
        ...args,
        propertyFacts: { ...args.propertyFacts, propertyType: 'condo_ground' },
      }).propertyType).toBe('condo_ground');
    });
  });
});

describe('lead webhook readiness guardrails', () => {
  const {
    evaluateLeadEstimateAutomationReadiness,
  } = require('../services/lead-estimate-automation');

  const base = {
    intake: {
      normalizedAddress: { line1: '62nd Avenue East', fullAddress: '62nd Avenue East, Unit 7, Parrish FL 34221', city: 'Parrish', zip: '34221' },
      email: 'lead@example.com',
    },
    customer: {},
    phone: '+19415550177',
    serviceInterest: 'Pest Control',
  };

  test('gate ON: a street-number-less line1 blocks automation', () => {
    withGate('true', () => {
      const readiness = evaluateLeadEstimateAutomationReadiness(base);
      expect(readiness.ready).toBe(false);
      expect(readiness.missing).toContain('street_number');
    });
  });

  test('gate OFF: legacy any-digit check passes the same address', () => {
    withGate(undefined, () => {
      const readiness = evaluateLeadEstimateAutomationReadiness(base);
      expect(readiness.missing).not.toContain('street_number');
    });
  });

  test('gate ON: commercial prose on a residential intake blocks with a category conflict', () => {
    withGate('true', () => {
      const readiness = evaluateLeadEstimateAutomationReadiness({
        ...base,
        intake: {
          ...base.intake,
          normalizedAddress: { line1: '4801 Industrial Way', fullAddress: '4801 Industrial Way, Parrish FL', city: 'Parrish', zip: '34221' },
          message: 'Brand-new industrial building near I-75; office and warehouse space, unit 101 only.',
        },
      });
      expect(readiness.ready).toBe(false);
      expect(readiness.missing).toContain('commercial_category_conflict');
      expect(readiness.review).toContain('commercial_signal_on_residential_intake');
    });
  });

  test('gate ON: a normal residential lead is unaffected', () => {
    withGate('true', () => {
      const readiness = evaluateLeadEstimateAutomationReadiness({
        ...base,
        intake: {
          ...base.intake,
          normalizedAddress: { line1: '100 Palm Ave', fullAddress: '100 Palm Ave, Venice FL 34285', city: 'Venice', zip: '34285' },
          message: 'ants in the kitchen, please call',
        },
      });
      expect(readiness.missing).not.toContain('street_number');
      expect(readiness.missing).not.toContain('commercial_category_conflict');
    });
  });
});

describe('lead webhook engine-input property type', () => {
  const { buildAutomatedLeadDraftEstimate } = require('../services/lead-estimate-automation');
  const args = {
    intake: { fullAddress: '100 Palm Ave, Venice FL 34285' },
    customer: {},
    body: {},
    readiness: { ready: true, serviceInterest: 'Pest Control' },
  };
  test('gate ON: defaults to unknown with a review marker AND parks the draft', () => {
    withGate('true', () => {
      const { automation } = buildAutomatedLeadDraftEstimate(args);
      expect(automation.engineInput.propertyType).toBe('unknown');
      expect(automation.review).toContain('property_type_unresolved');
      // The marker must change the status — a review string alone left the
      // draft 'generated' and auto-sendable at default single-family
      // pricing (codex r2 P1).
      expect(automation.status).toBe('manual_review_required');
      expect(automation.generated).toBe(false);
    });
  });
  test('gate ON: a supplied type the pricer silently defaults also parks', () => {
    withGate('true', () => {
      const { automation } = buildAutomatedLeadDraftEstimate({
        ...args,
        body: { propertyType: 'Apartment' },
      });
      expect(automation.review).toContain('property_type_unresolved');
      expect(automation.status).toBe('manual_review_required');
    });
  });
  test('gate ON: a pricer-recognized type generates normally', () => {
    withGate('true', () => {
      const { automation } = buildAutomatedLeadDraftEstimate({
        ...args,
        body: { propertyType: 'condo_ground' },
      });
      expect(automation.review).not.toContain('property_type_unresolved');
      expect(automation.status).toBe('generated');
    });
  });
  test('gate OFF: legacy Single Family default preserved', () => {
    withGate(undefined, () => {
      const { automation } = buildAutomatedLeadDraftEstimate(args);
      expect(automation.engineInput.propertyType).toBe('Single Family');
      expect(automation.review).not.toContain('property_type_unresolved');
    });
  });
});
