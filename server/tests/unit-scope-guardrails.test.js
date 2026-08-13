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
  test('UNIT-FIRST addresses are complete (r41 P2)', () => {
    expect(hasPrimaryStreetNumber('Unit 7, 123 Main St, Bradenton, FL 34201')).toBe(true);
    expect(hasPrimaryStreetNumber('Apt 4 at 123 Main Street')).toBe(true);
    expect(hasPrimaryStreetNumber('#12 900 Bayview Ter')).toBe(true);
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
    // Suite identifiers are alphabetic as often as numeric (codex r21 P1).
    expect(commercialTextSignal('Need pest control for Suite A')).toBe(true);
    expect(commercialTextSignal('roaches in suite B-2')).toBe(true);
    // Service-qualified premises incl. offices (codex r23 P1).
    expect(commercialTextSignal('Need pest control for an office')).toBe(true);
    expect(commercialTextSignal('pest control for a warehouse')).toBe(true);
    // …but a residential HOME office is still not a commercial premises.
    expect(commercialTextSignal('need pest control for the home office')).toBe(false);
    // "suite" as a ROOM word is residential (codex r24 P2).
    expect(commercialTextSignal('ants in the master suite bathroom')).toBe(false);
    expect(commercialTextSignal('our en-suite bathroom has ants')).toBe(false);
    expect(commercialTextSignal('Suite A, Bradenton — roaches')).toBe(true);
    // hotel_resort / healthcare_childcare risk types (codex r33 P1).
    expect(commercialTextSignal('need pest control for our hotel')).toBe(true);
    expect(commercialTextSignal('service our daycare please')).toBe(true);
    expect(commercialTextSignal('roaches at our motel')).toBe(true);
    // Schools/churches type commercial in the lookup too (codex r34 P1).
    expect(commercialTextSignal('need pest control for our school')).toBe(true);
    expect(commercialTextSignal('pest control for a school')).toBe(true);
    // "the hotel" needs service context — working at one is residential
    // prose (codex r34 P2).
    expect(commercialTextSignal('I work at the hotel, but I need quarterly pest control at home')).toBe(false);
    expect(commercialTextSignal('pest control at the hotel')).toBe(true);
    // Retail needs ownership/service context (codex r33 P2).
    expect(commercialTextSignal('ants in our retail store')).toBe(true);
    expect(commercialTextSignal('we lease retail space downtown')).toBe(true);
    expect(commercialTextSignal('I bought spray at a retail store, but the ants are at my house')).toBe(false);
    // Whole-property multifamily/association requests (codex r25 P1).
    expect(commercialTextSignal('I manage an apartment complex')).toBe(true);
    expect(commercialTextSignal('pest control for our HOA common areas')).toBe(true);
    expect(commercialTextSignal('we need the common areas of the association treated')).toBe(true);
    // …but a RESIDENT of an HOA community is a residential customer.
    expect(commercialTextSignal('my HOA requires quarterly pest control')).toBe(false);
    expect(commercialTextSignal('we live in an HOA community with strict rules')).toBe(false);
    expect(commercialTextSignal('we own our home and the HOA handles the street')).toBe(false);
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
  test('a property manager on a CONDO conflicts too (r5 — matched neither HOA nor commercial families)', () => {
    expect(commercialCategoryConflict({
      extraction: {
        caller: { relationship_to_property: 'property manager' },
        property: { property_type: 'condo' },
      },
      intent: { is_commercial: false },
    })).toBe('property_manager:condo');
    expect(commercialCategoryConflict({
      extraction: {
        caller: { relationship_to_property: 'tenant' },
        property: { property_type: 'condo' },
      },
      intent: { is_commercial: false },
    })).toBeNull();
  });
  test('a whole-complex OWNER conflicts; an owner of one unit does not (r36)', () => {
    // Adam's ruling: commercial applies when the client is the association,
    // complex owner, or property manager.
    expect(commercialCategoryConflict({
      extraction: {
        caller: { relationship_to_property: 'owner' },
        property: { property_type: 'multi_family' },
      },
      intent: { is_commercial: false, address: '900 Bayview Ter, Venice, FL 34285' },
    })).toBe('owner:multi_family');
    // …but an owner WITH unit-occupancy evidence is a unit customer.
    expect(commercialCategoryConflict({
      extraction: {
        caller: { relationship_to_property: 'owner' },
        property: { property_type: 'multi_family' },
      },
      intent: { is_commercial: false, address: '900 Bayview Ter, Unit 12, Venice, FL 34285' },
    })).toBeNull();
  });

  test('a property manager on a multifamily property conflicts; a tenant does not', () => {
    // The module's own contract: commercial applies when the client is the
    // association, complex owner, or property manager — the residential
    // exemption is for unit OCCUPANTS (codex r2 P1).
    expect(commercialCategoryConflict({
      extraction: {
        caller: { relationship_to_property: 'property manager' },
        property: { property_type: 'multi_family' },
      },
      intent: { is_commercial: false },
    })).toBe('property_manager:multi_family');
    expect(commercialCategoryConflict({
      extraction: {
        caller: { relationship_to_property: 'tenant' },
        property: { property_type: 'multi_family' },
      },
      intent: { is_commercial: false },
    })).toBeNull();
  });
  test('direct business-service wording fires; incidental business mentions stay quiet', () => {
    expect(commercialTextSignal('need pest control at my business')).toBe(true);
    expect(commercialTextSignal('commercial pest control quote please')).toBe(true);
    expect(commercialTextSignal('can you service our business monthly')).toBe(true);
    expect(commercialTextSignal('ants at the house, my business is slow lately')).toBe(false);
  });
  test('a populated commercial_subtype conflicts regardless of the type text (r7)', () => {
    // Owner quoting their whole multi-unit building: 'multi_family' text +
    // subtype 'multi_unit_residential' slipped every text family.
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'multi_family', commercial_subtype: 'multi_unit_residential' } },
      intent: { is_commercial: false },
    })).toBe('commercial_subtype:multi_unit_residential');
    // A null subtype carries no signal; 'other' DOES — the field is only
    // populated when the extraction classified the job commercial.
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'apartment', commercial_subtype: null } },
      intent: { is_commercial: false },
    })).toBeNull();
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'apartment', commercial_subtype: 'other' } },
      intent: { is_commercial: false },
    })).toBe('commercial_subtype:other');
  });
  test('"the office" without a possessive stays quiet; possessives still fire (r7)', () => {
    expect(commercialTextSignal('I work at the office downtown, but the ants are at my house')).toBe(false);
    expect(commercialTextSignal('ants in my office at the shop')).toBe(true);
    expect(commercialTextSignal('roaches at the restaurant')).toBe(true);
  });
  test('the structured hoa_common_area_service boolean outranks a residential type text', () => {
    // A condo ASSOCIATION's common-area job reads property_type 'condo' —
    // the boolean is the schema's commercial routing signal (codex r2 P1).
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'condo', hoa_common_area_service: true } },
      intent: { is_commercial: false },
    })).toBe('hoa_common_area_service');
    expect(commercialCategoryConflict({
      extraction: { property: { property_type: 'condo', hoa_common_area_service: false } },
      intent: { is_commercial: false },
    })).toBeNull();
  });
});

describe('lookupCategoryConflict — the lookup verdict vs a residential intent', () => {
  const { lookupCategoryConflict } = require('../services/estimator-engine/unit-scope-model');

  test('a residential apartment/HOA verdict on a unit scope is exempt', () => {
    // detectCategory types every apartment record COMMERCIAL (it answers
    // the whole-property question) — a resident of one unit is residential.
    expect(lookupCategoryConflict({
      isCommercialIntent: false, enrichedCategory: 'COMMERCIAL',
      commercialSubtype: 'multifamily_common_area_residential', serviceScope: 'residential_unit',
      unitOccupantEvidence: true,
    })).toBeNull();
    expect(lookupCategoryConflict({
      isCommercialIntent: false, enrichedCategory: 'COMMERCIAL',
      commercialSubtype: 'hoa_common_area_residential', serviceScope: 'residential_unit',
      unitOccupantEvidence: true,
    })).toBeNull();
    // The ≥5-unit stacked aggregate is a unit count, not a commercial use.
    expect(lookupCategoryConflict({
      isCommercialIntent: false, enrichedCategory: 'COMMERCIAL',
      commercialSubtype: 'other', commercialDetectionSource: 'property_record_unit_count',
      serviceScope: 'residential_unit', unitOccupantEvidence: true,
    })).toBeNull();
  });

  test('a unit-count verdict carrying commercial-use evidence still conflicts (r17)', () => {
    expect(lookupCategoryConflict({
      isCommercialIntent: false, enrichedCategory: 'COMMERCIAL',
      commercialSubtype: 'office_retail', commercialDetectionSource: 'property_record_unit_count',
      serviceScope: 'residential_unit', unitOccupantEvidence: true,
    })).toBe('lookup_category:commercial');
  });

  test('a genuinely commercial verdict conflicts even on a unit scope', () => {
    // An office/retail condo, or a lookup-verified Office at "…, Suite 2"
    // that the subpremise rule promoted to residential_unit (codex r16 P1).
    expect(lookupCategoryConflict({
      isCommercialIntent: false, enrichedCategory: 'COMMERCIAL',
      commercialSubtype: 'office_retail', serviceScope: 'residential_unit',
      unitOccupantEvidence: true,
    })).toBe('lookup_category:commercial');
    expect(lookupCategoryConflict({
      isCommercialIntent: false, enrichedCategory: 'COMMERCIAL',
      commercialSubtype: 'warehouse_light', serviceScope: 'entire_residential_structure',
    })).toBe('lookup_category:commercial');
  });

  test('without unit-OCCUPANCY evidence a multifamily verdict still conflicts (r19)', () => {
    // inferServiceScope labels every condo/apartment-typed job
    // 'residential_unit'; an association or whole-building request must not
    // be exempted and priced as one unit.
    expect(lookupCategoryConflict({
      isCommercialIntent: false, enrichedCategory: 'COMMERCIAL',
      commercialSubtype: 'multifamily_common_area_residential',
      serviceScope: 'residential_unit', unitOccupantEvidence: false,
    })).toBe('lookup_category:commercial');
  });

  test('no conflict when the intent is commercial or the lookup is residential', () => {
    expect(lookupCategoryConflict({
      isCommercialIntent: true, enrichedCategory: 'COMMERCIAL',
      commercialSubtype: 'office_retail', serviceScope: 'commercial_suite',
    })).toBeNull();
    expect(lookupCategoryConflict({
      isCommercialIntent: false, enrichedCategory: 'RESIDENTIAL',
      serviceScope: 'entire_residential_structure',
    })).toBeNull();
    expect(lookupCategoryConflict({ isCommercialIntent: false, enrichedCategory: null })).toBeNull();
  });
});

describe('kill-switch isolation from the V2 gate (r12)', () => {
  const { _private: shadowPrivate } = require('../services/estimator-engine/property-facts-shadow');

  test('the enhanced address parse is opt-in too (r31)', () => {
    // Legacy parse: comma-required locality strip, legacy extraction field
    // names, lot counted — the V2 path keeps exactly this with the
    // unit-scope kill switch off.
    const args = { tenant: false, address: '4801 Industrial Way, Suite 101, Parrish FL 34219', extraction: null };
    expect(shadowPrivate.hasUnitSignal(args)).toBe(false);
    expect(shadowPrivate.hasUnitSignal({ ...args, enhanced: true })).toBe(true);
    // Tenancy is pre-existing and gate-independent.
    expect(shadowPrivate.hasUnitSignal({ ...args, tenant: true })).toBe(true);
  });

  test('owner-unit suites are opt-in per call, so the V2 path cannot inherit them', () => {
    const args = {
      propertyType: 'industrial', isCommercial: true, tenant: false,
      aggregated: false, unitSignal: true,
    };
    // Default (the V2 shadow path with the unit-scope gate off): prior behavior.
    expect(shadowPrivate.inferServiceScope(args)).toBe('entire_commercial_building');
    expect(shadowPrivate.inferOwnershipType(args)).toBe('fee_simple');
    // Opt-in (the unit-scope lane, or V2 with both gates on) — and the suite
    // now requires PART-BUILDING evidence (codex r38/r39 P1).
    expect(shadowPrivate.inferServiceScope({
      ...args, unitScopeSuites: true, partBuilding: true,
    })).toBe('commercial_suite');
    expect(shadowPrivate.inferOwnershipType({ ...args, unitScopeSuites: true })).toBe('commercial_condominium');
    // Lane ON without part-building evidence: a whole-building lease keeps
    // building scope so its county area/lot survive.
    expect(shadowPrivate.inferServiceScope({
      ...args, tenant: true, unitScopeSuites: true, partBuilding: false,
    })).toBe('entire_commercial_building');
    // Lane OFF: the legacy tenancy⇒suite mapping is preserved verbatim.
    expect(shadowPrivate.inferServiceScope({ ...args, tenant: true })).toBe('commercial_suite');
    // OWNERSHIP follows the same rule (codex r40 P1): a whole-building
    // lease keeps a real parcel, so V2's lot selection must not read
    // 'no_individual_lot' and clear it.
    const { lotApplicabilityFor } = require('../services/property-lookup/property-facts-v2');
    const wholeBuildingOwnership = shadowPrivate.inferOwnershipType({
      ...args, tenant: true, unitScopeSuites: true, partBuilding: false,
    });
    expect(wholeBuildingOwnership).toBe('leased_whole_building');
    expect(lotApplicabilityFor({
      propertySubtype: 'restaurant', ownershipType: wholeBuildingOwnership,
    })).toBe('private_parcel');
    // A part-building suite tenant stays leased_suite ⇒ no individual lot.
    expect(shadowPrivate.inferOwnershipType({
      ...args, tenant: true, unitScopeSuites: true, partBuilding: true,
    })).toBe('leased_suite');
    // Lane OFF keeps the legacy leased_suite for every commercial tenant.
    expect(shadowPrivate.inferOwnershipType({ ...args, tenant: true })).toBe('leased_suite');
    // A commercial CONDO is one unit of a larger building even with no
    // Unit/Suite suffix on the address (codex r43 P1).
    expect(shadowPrivate.hasPartBuildingEvidence({
      subpremiseSignal: false, aggregated: false, propertyType: 'Commercial Condo',
    })).toBe(true);
    expect(shadowPrivate.hasPartBuildingEvidence({
      subpremiseSignal: false, aggregated: false, propertyType: 'Restaurant',
    })).toBe(false);
    // County land-use text counts (r44 P1) — but a generic 'office building'
    // does NOT: a tenant can lease the whole thing (r45 P1).
    expect(shadowPrivate.hasPartBuildingEvidence({
      subpremiseSignal: false, aggregated: false, propertyType: 'Commercial',
      landUseDescription: 'Multiple Unit Stores',
    })).toBe(true);
    expect(shadowPrivate.hasPartBuildingEvidence({
      subpremiseSignal: false, aggregated: false, propertyType: 'Commercial',
      landUseDescription: 'Office Building',
    })).toBe(false);
    // An AGGREGATE apartment complex bought whole is an association job, not
    // a suite — unitSignal is true for any apartment-typed record, so the
    // suite branch must not swallow it (codex r42 P1).
    expect(shadowPrivate.inferServiceScope({
      propertyType: 'Apartment', isCommercial: true, tenant: false, aggregated: true,
      unitSignal: true, unitScopeSuites: true, partBuilding: true, subpremise: false,
    })).toBe('association_common_area');
    // …but a TENANT inside that complex is still a suite.
    expect(shadowPrivate.inferServiceScope({
      propertyType: 'Apartment', isCommercial: true, tenant: true, aggregated: true,
      unitSignal: true, unitScopeSuites: true, partBuilding: true, subpremise: false,
    })).toBe('commercial_suite');
  });
});

describe('resolveUnitScopeModel — subpremise on a type-less residential job', () => {
  test('a Unit suffix with a missing/generic type reads as a unit and clears the master parcel', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: { caller: { relationship_to_property: 'owner' }, property: {} },
      intent: { is_commercial: false, address: '900 Bayview Ter, Unit 12, Venice, FL 34285' },
      propertyFacts: { tenant: false, home: { source: 'unresolved' } },
      address: '900 Bayview Ter, Unit 12, Venice, FL 34285',
    });
    expect(model.serviceScope).toBe('residential_unit');
    // The applicability follows the FINAL scope — never the contradictory
    // 'private_parcel' that fee_simple ownership would imply (codex r36 P1).
    expect(model.lotApplicability).toBe('no_individual_lot');
    const facts = { lot: { value: 120000, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(facts, model);
    expect(facts.lot.value).toBeNull();
    expect(facts.lot.source).toBe('not_applicable:no_individual_lot');
  });
  test('a street NAMED Florida keeps its suite suffix (r30)', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: { caller: { relationship_to_property: 'owner' }, property: {} },
      intent: { is_commercial: true, address: '4801 Florida Ave, Suite 7, Sarasota, FL' },
      propertyFacts: { tenant: false, home: { source: 'unresolved' } },
      address: '4801 Florida Ave, Suite 7, Sarasota, FL',
    });
    expect(model.subpremiseSignal).toBe(true);
    expect(model.serviceScope).toBe('commercial_suite');
  });

  test('a mobile-home LOT number is a whole structure, not a unit (r30)', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Mobile Home' },
      extraction: { caller: { relationship_to_property: 'tenant' }, property: {} },
      intent: { is_commercial: false, address: '100 Park Rd, Lot 5, Venice, FL 34285' },
      propertyFacts: { tenant: true, home: { value: 1100, source: 'county_assessed' } },
      address: '100 Park Rd, Lot 5, Venice, FL 34285',
    });
    expect(model.subpremiseSignal).toBe(false);
    expect(model.serviceScope).toBe('entire_residential_structure');
    // Its county area is the home's own — never cleared.
    const facts = { home: { value: 1100, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(facts, model);
    expect(facts.home.value).toBe(1100);
  });

  test('a no-comma city/state address keeps its unit scope (r27)', () => {
    // "…, Parrish FL 34219" is as common as "…, Venice, FL 34285"; the
    // comma-required locality strip left the ZIP at the end and the suite
    // suffix went unseen.
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: { caller: { relationship_to_property: 'owner' }, property: {} },
      intent: { is_commercial: true, address: '4801 Industrial Way, Suite 101, Parrish FL 34219' },
      propertyFacts: { tenant: false, home: { source: 'unresolved' } },
      address: '4801 Industrial Way, Suite 101, Parrish FL 34219',
    });
    expect(model.subpremiseSignal).toBe(true);
    expect(model.serviceScope).toBe('commercial_suite');
  });
  test('a tenant whose extraction says apartment is a unit even on a flattened record with no unit line (r37)', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Single Family' },
      extraction: {
        caller: { relationship_to_property: 'tenant' },
        property: { property_type: 'apartment' },
      },
      intent: { is_commercial: false, address: '900 Bayview Ter, Venice, FL 34285' },
      propertyFacts: { tenant: true, home: { value: 3400, source: 'county_assessed' } },
      address: '900 Bayview Ter, Venice, FL 34285',
    });
    expect(model.serviceScope).toBe('residential_unit');
    const facts = {
      home: { value: 3400, source: 'county_assessed', confidence: 'high' },
      lot: { value: 9000, source: 'county_assessed', confidence: 'high' },
    };
    applyUnitScopeToPropertyFacts(facts, model);
    expect(facts.home.value).toBeNull();
    expect(facts.lot.value).toBeNull();
  });

  test('the schema street_line_2 unit field signals even when the composed address dropped it (r6)', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: {
        caller: { relationship_to_property: 'owner' },
        property: { service_address: { raw_text: null, street_line_1: '900 Bayview Ter', street_line_2: 'Unit 12' } },
      },
      intent: { is_commercial: false, address: '900 Bayview Ter, Venice, FL 34285' },
      propertyFacts: { tenant: false, home: { source: 'unresolved' } },
      address: '900 Bayview Ter, Venice, FL 34285',
    });
    expect(model.serviceScope).toBe('residential_unit');
  });
  test('a TENANT of an explicit subpremise is a unit even on a single_family record (r20)', () => {
    // A subdivided house, or a multifamily record the provider flattened:
    // a whole-house renter's address rarely carries a unit line.
    const model = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Single Family' },
      extraction: { caller: { relationship_to_property: 'tenant' }, property: {} },
      intent: { is_commercial: false, address: '900 Bayview Ter, Apt B, Venice, FL 34285' },
      propertyFacts: { tenant: true, home: { source: 'county_assessed' } },
      address: '900 Bayview Ter, Apt B, Venice, FL 34285',
    });
    expect(model.serviceScope).toBe('residential_unit');
  });
  test('an OWNER at an explicit unit address is a unit occupant on a flattened record (r46)', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Single Family' },
      extraction: { caller: { relationship_to_property: 'owner' }, property: { property_type: 'condo' } },
      intent: { is_commercial: false, address: '900 Bayview Ter, Unit 12, Venice, FL 34285' },
      propertyFacts: { tenant: false, home: { value: 3400, source: 'county_assessed' } },
      address: '900 Bayview Ter, Unit 12, Venice, FL 34285',
    });
    expect(model.serviceScope).toBe('residential_unit');
  });
  test('a property MANAGER at a unit address is not a unit occupant (r46)', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Single Family' },
      extraction: { caller: { relationship_to_property: 'property manager' }, property: {} },
      intent: { is_commercial: false, address: '900 Bayview Ter, Unit 12, Venice, FL 34285' },
      propertyFacts: { tenant: false, home: { value: 3400, source: 'county_assessed' } },
      address: '900 Bayview Ter, Unit 12, Venice, FL 34285',
    });
    expect(model.serviceScope).toBe('entire_residential_structure');
  });
  test('a positively whole-structure type is respected over the address token', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: { caller: { relationship_to_property: 'owner' }, property: { property_type: 'townhouse' } },
      intent: { is_commercial: false, address: '900 Bayview Ter, Unit A, Venice, FL 34285' },
      propertyFacts: { tenant: false, home: { source: 'county_assessed' } },
      address: '900 Bayview Ter, Unit A, Venice, FL 34285',
    });
    expect(model.serviceScope).toBe('entire_residential_structure');
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

  test('an OWNER-occupied commercial unit still classifies as a suite with a master-parcel lot (r8)', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: {
        caller: { relationship_to_property: 'owner' },
        property: { property_type: 'industrial' },
      },
      intent: { is_commercial: true, address: '4801 Industrial Way, Unit 7, Parrish, FL 34219' },
      propertyFacts: { tenant: false, home: { source: 'unresolved' } },
      address: '4801 Industrial Way, Unit 7, Parrish, FL 34219',
    });
    expect(model.serviceScope).toBe('commercial_suite');
    // Owner of one unit ≠ owner of the parcel: lot-driven services must not
    // price the whole complex.
    const facts = { lot: { value: 87000, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(facts, model);
    expect(facts.lot.value).toBeNull();
    expect(facts.lot.source).toMatch(/^not_applicable:/);
  });

  test('a suite scope clears a building-sourced area but keeps caller-stated (r28)', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: { caller: { relationship_to_property: 'owner' }, property: {} },
      intent: { is_commercial: true, address: '4801 Industrial Way, Suite 7, Parrish FL 34219' },
      propertyFacts: { tenant: false, home: { source: 'unresolved' } },
      address: '4801 Industrial Way, Suite 7, Parrish FL 34219',
    });
    expect(model.serviceScope).toBe('commercial_suite');
    // County building area → cleared (it prices the whole building).
    const countyFacts = { home: { value: 14250, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(countyFacts, model);
    expect(countyFacts.home.value).toBeNull();
    expect(countyFacts.home.source).toBe('unresolved');
    expect(countyFacts.home.rejected[0]).toEqual(
      expect.objectContaining({ value: 14250, source: 'county_assessed' }),
    );
    // Caller-stated area IS suite-scoped and survives.
    const statedFacts = { home: { value: 1590, source: 'caller_stated', confidence: 'medium' } };
    applyUnitScopeToPropertyFacts(statedFacts, model);
    expect(statedFacts.home.value).toBe(1590);
  });

  test('a residential unit clears whole-structure area, but a CONDO folio survives (r29)', () => {
    // Tenant at Apt B on a flattened single-family record: the county area
    // covers the whole subdivided structure.
    const flattened = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Single Family' },
      extraction: { caller: { relationship_to_property: 'tenant' }, property: {} },
      intent: { is_commercial: false, address: '900 Bayview Ter, Apt B, Venice, FL 34285' },
      propertyFacts: { tenant: true, home: { source: 'county_assessed' } },
      address: '900 Bayview Ter, Apt B, Venice, FL 34285',
    });
    expect(flattened.serviceScope).toBe('residential_unit');
    const flatFacts = { home: { value: 3400, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(flatFacts, flattened);
    expect(flatFacts.home.value).toBeNull();
    // The V2-rewritten source is building-scoped too (codex r41 P1).
    const v2Facts = { home: { value: 3400, source: 'property_facts_v2', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(v2Facts, flattened);
    expect(v2Facts.home.value).toBeNull();
    // …and the audit's size basis follows the mutation (r29 P2).
    expect(flattened.sizeBasis).toBe('unresolved');

    // A CONDO's county record is a per-unit parcel with its own folio —
    // that area IS unit-scoped and must be kept.
    const condo = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Residential Condo' },
      extraction: { caller: { relationship_to_property: 'owner' }, property: {} },
      intent: { is_commercial: false, address: '900 Bayview Ter, Unit 12, Venice, FL 34285' },
      propertyFacts: { tenant: false, home: { source: 'county_assessed' } },
      address: '900 Bayview Ter, Unit 12, Venice, FL 34285',
    });
    expect(condo.propertyUse).toBe('condominium');
    const condoFacts = { home: { value: 1240, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(condoFacts, condo);
    expect(condoFacts.home.value).toBe(1240);
  });

  test('a whole-building commercial TENANT keeps its area and lot (r38)', () => {
    // A restaurant/warehouse tenant can lease an entire freestanding
    // property — tenancy alone is not part-building evidence.
    const model = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Restaurant' },
      extraction: { caller: { relationship_to_property: 'tenant' }, property: {} },
      intent: { is_commercial: true, address: '4801 Cortez Rd W, Bradenton, FL 34210' },
      propertyFacts: { tenant: true, home: { value: 4200, source: 'county_assessed' } },
      address: '4801 Cortez Rd W, Bradenton, FL 34210',
    });
    expect(model.partBuildingEvidence).toBe(false);
    const facts = {
      home: { value: 4200, source: 'county_assessed', confidence: 'high' },
      lot: { value: 22000, source: 'county_assessed', confidence: 'high' },
    };
    applyUnitScopeToPropertyFacts(facts, model);
    expect(facts.home.value).toBe(4200);
    expect(facts.lot.value).toBe(22000);
  });

  test('commercial tenant classifies as a suite', () => {
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: {
        caller: { relationship_to_property: 'tenant' },
        property: { property_type: 'industrial' },
      },
      intent: { is_commercial: true, address: '4801 Industrial Way, Unit 7, Parrish, FL 34219' },
      propertyFacts: { tenant: true, home: { source: 'unresolved' } },
      address: '4801 Industrial Way, Unit 7, Parrish, FL 34219',
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

  test('gate ON: a stamped category conflict is RED (category_conflict)', () => {
    withGate('true', () => {
      // The stamp is resolved in index.js with the re-gather in view (a
      // primary-property extraction must not judge a re-gathered secondary
      // property) — classifyLane consumes it off propertyFacts.
      const out = classifyLane({
        ...baseArgs,
        propertyFacts: { ...baseArgs.propertyFacts, categoryConflict: 'industrial' },
      });
      expect(out.lane).toBe('red');
      expect(out.causes).toContain('category_conflict');
    });
  });

  test('gate ON: a null stamp (re-gathered address) never red-lanes on the primary extraction', () => {
    withGate('true', () => {
      const out = classifyLane({
        ...baseArgs,
        propertyFacts: { ...baseArgs.propertyFacts, categoryConflict: null },
        context: {
          ...baseArgs.context,
          extraction: { property: { property_type: 'industrial' } },
        },
      });
      expect(out.lane).not.toBe('red');
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

  test('a not_applicable lot is quiet for non-lot-driven services (pest)', () => {
    withGate('true', () => {
      const out = classifyLane({
        ...baseArgs,
        propertyFacts: {
          ...baseArgs.propertyFacts,
          lot: { value: null, source: 'not_applicable:leased_land', confidence: 'high' },
        },
      });
      expect(out.reasons.join(' ')).not.toMatch(/lot sqft|lot-driven/);
    });
  });

  test('a unit quote with a MEASURED treated area is not parked for a missing lot (r18)', () => {
    withGate('true', () => {
      const out = classifyLane({
        ...baseArgs,
        intent: { ...baseArgs.intent, services: { lawn: { track: 'st_augustine' } } },
        engineResult: {
          lineItems: [{
            service: 'lawn_care', monthlyAfterDiscount: 60, annualAfterDiscount: 720,
            turfBasis: 'measuredTurfSf', turfConfidence: 'high', turfSf: 1800,
          }],
        },
        totals: { monthly: 60, annual: 720, oneTime: 0 },
        propertyFacts: {
          ...baseArgs.propertyFacts,
          lot: { value: null, source: 'not_applicable:common_master_parcel', confidence: 'high' },
        },
      });
      expect(out.reasons.join(' ')).not.toMatch(/lot-driven service on a unit\/suite scope/);
    });
  });

  test('a measured ONE-TIME lawn unit quote is not parked (r35)', () => {
    withGate('true', () => {
      // priceOneTimeLawn omits turfBasis/turfSf from its line, so the
      // engine INPUT is what proves the area was measured.
      const out = classifyLane({
        ...baseArgs,
        intent: { ...baseArgs.intent, services: { oneTimeLawn: { track: 'st_augustine' } } },
        engineResult: { lineItems: [{ service: 'one_time_lawn', priceAfterDiscount: 120 }] },
        engineInput: { measuredTurfSf: 1800 },
        totals: { monthly: 0, annual: 0, oneTime: 120 },
        propertyFacts: {
          ...baseArgs.propertyFacts,
          lot: { value: null, source: 'not_applicable:common_master_parcel', confidence: 'high' },
        },
      });
      expect(out.reasons.join(' ')).not.toMatch(/lot-driven service on a unit\/suite scope/);
    });
  });

  test('a lot-driven service on a unit scope parks — no lot means nothing to price turf from', () => {
    withGate('true', () => {
      // codex r5 P1: after the master-parcel lot clears, the lawn pricer's
      // zero-area fallback returns a minimum-priced line that would
      // otherwise green-lane.
      const out = classifyLane({
        ...baseArgs,
        intent: { ...baseArgs.intent, services: { lawn: { track: 'st_augustine' } } },
        engineResult: { lineItems: [{ service: 'lawn_care', monthlyAfterDiscount: 40, annualAfterDiscount: 480 }] },
        totals: { monthly: 40, annual: 480, oneTime: 0 },
        propertyFacts: {
          ...baseArgs.propertyFacts,
          lot: { value: null, source: 'not_applicable:common_master_parcel', confidence: 'high' },
        },
      });
      expect(out.lane).toBe('yellow');
      expect(out.reasons.join(' ')).toMatch(/lot-driven service on a unit\/suite scope/);
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

  test('gate ON: a street-number-less line1 blocks automation AS an askable street_address', () => {
    withGate('true', () => {
      const readiness = evaluateLeadEstimateAutomationReadiness(base);
      expect(readiness.ready).toBe(false);
      // 'street_address' is the clarify-ask vocabulary (ASKABLE_MISSING) —
      // a bespoke item would block pricing but never ask for the address
      // (codex r2 P1); the review marker keeps the failure segmentable.
      expect(readiness.missing).toContain('street_address');
      expect(readiness.review).toContain('street_number_missing');
    });
  });

  test('gate OFF: legacy any-digit check passes the same address', () => {
    withGate(undefined, () => {
      const readiness = evaluateLeadEstimateAutomationReadiness(base);
      expect(readiness.missing).not.toContain('street_address');
      expect(readiness.review).not.toContain('street_number_missing');
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

  test('gate ON: an explicit commercial service interest parks regardless of prose', () => {
    withGate('true', () => {
      const readiness = evaluateLeadEstimateAutomationReadiness({
        ...base,
        intake: {
          ...base.intake,
          normalizedAddress: { line1: '4801 Industrial Way', fullAddress: '4801 Industrial Way, Parrish FL', city: 'Parrish', zip: '34221' },
        },
        serviceInterest: 'Commercial Pest Control',
      });
      expect(readiness.ready).toBe(false);
      expect(readiness.missing).toContain('commercial_category_conflict');
    });
  });

  test('gate ON: structured commercial form flags block automation (r44)', () => {
    withGate('true', () => {
      const base2 = {
        ...base,
        intake: {
          ...base.intake,
          normalizedAddress: { line1: '4801 Industrial Way', fullAddress: '4801 Industrial Way, Parrish FL', city: 'Parrish', zip: '34221' },
        },
      };
      // A form that says so outright, with a generic label and no prose.
      // Every truthy form spelling counts, not just boolean/`yes` (r45 P1).
      for (const flag of [
        { isCommercial: true }, { isCommercial: 'true' }, { isCommercial: '1' },
        { isCommercial: 'on' }, { is_commercial: 'yes' },
        { category: 'COMMERCIAL' }, { commercialSubtype: 'warehouse_light' },
      ]) {
        const readiness = evaluateLeadEstimateAutomationReadiness({ ...base2, body: flag });
        expect(readiness.missing).toContain('commercial_category_conflict');
      }
      // A residential body with none of those stays clean.
      expect(evaluateLeadEstimateAutomationReadiness({
        ...base2, body: { isCommercial: false, category: 'RESIDENTIAL', commercialSubtype: '' },
      }).missing).not.toContain('commercial_category_conflict');
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

describe('lookup propertyType trust — an unresolved label is not a classification (r47)', () => {
  const { lookupPropertyTypeIsTrustworthy } = require('../services/lookup-confidence');

  test("the guard's own 'Unknown' label never overrides a saved type", () => {
    // Gate ON, no record and no confident vision read: property-lookup-v2
    // surfaces 'Unknown' instead of a plausible-but-wrong 'Single Family'.
    // That string is TRUTHY, and customer-pricing-ai adopts a trusted lookup
    // type over the customer's stored one — so trusting it would replace a
    // saved Condo with 'Unknown' and price the unit as single-family.
    expect(lookupPropertyTypeIsTrustworthy({ propertyType: 'Unknown' })).toBe(false);
    // Property records normalize a missing type to the literal 'UNKNOWN'.
    expect(lookupPropertyTypeIsTrustworthy({ propertyType: 'UNKNOWN' })).toBe(false);
    expect(lookupPropertyTypeIsTrustworthy({ propertyType: '  unknown  ' })).toBe(false);
    expect(lookupPropertyTypeIsTrustworthy({ propertyType: '' })).toBe(false);
    expect(lookupPropertyTypeIsTrustworthy({})).toBe(false);
  });

  test('a real resolved type still prices, and a flagged one still does not', () => {
    expect(lookupPropertyTypeIsTrustworthy({ propertyType: 'Condo' })).toBe(true);
    expect(lookupPropertyTypeIsTrustworthy({ propertyType: 'Townhome' })).toBe(true);
    // Unchanged pre-existing rule: a satellite reclassification ships a
    // propertyType verify flag and must not move a price.
    expect(lookupPropertyTypeIsTrustworthy({
      propertyType: 'Townhome',
      fieldVerifyFlags: [{ field: 'propertyType', priority: 'HIGH' }],
    })).toBe(false);
  });
});

describe('a profile measurement cannot silence the unit no-lot review (r19)', () => {
  const { classifyLane, buildEngineInput } = require('../services/estimator-engine/draft-builder');
  // A unit/suite scope resolves NO individual lot by design, so a lot-driven
  // service on it parks for review unless the treatable area was actually
  // measured for THIS unit.
  const unitLawnArgs = {
    intent: {
      decision: 'draft',
      is_commercial: false,
      confidence: 'high',
      services: { lawn: { frequency: 'monthly' } },
      address: '1400 Lakefront Dr Apt 5202, Sarasota, FL 34236',
      evidence: [{ quote: 'lawn service for my place', speaker: 'caller' }],
    },
    propertyFacts: {
      home: { value: 900, source: 'county_assessed' },
      lot: { value: null, source: 'not_applicable:residential_unit' },
      propertyType: 'condo_ground',
    },
    engineResult: { lineItems: [{ service: 'lawn', monthlyAfterDiscount: 60, annualAfterDiscount: 720, turfSf: 4000 }] },
    totals: { monthly: 60, annual: 720, oneTime: 0 },
    comps: null,
    calibration: [],
    context: { transcript: 'lawn service for my place', phone: '+19415550140' },
  };
  const noLotReason = (out) => (out.reasons || []).some((r) => r.includes('no individual lot exists'));

  test('an unverified-unit profile area still parks the draft', () => {
    withGate('true', () => {
      const out = classifyLane({
        ...unitLawnArgs,
        engineInput: { measuredTurfSf: 4000, measuredTurfUnitVerified: false },
      });
      expect(noLotReason(out)).toBe(true);
    });
  });

  test('a unit-verified profile area still suppresses it — no false review', () => {
    withGate('true', () => {
      const out = classifyLane({
        ...unitLawnArgs,
        engineInput: { measuredTurfSf: 4000, measuredTurfUnitVerified: true },
      });
      expect(noLotReason(out)).toBe(false);
    });
  });

  test('a measured area from any other source carries no flag and still suppresses it', () => {
    withGate('true', () => {
      const out = classifyLane({ ...unitLawnArgs, engineInput: { measuredTurfSf: 4000 } });
      expect(noLotReason(out)).toBe(false);
    });
  });

  test('measured turf never validates a mosquito request — it prices from the lot (r54)', () => {
    // Mosquito's treatable area derives from the LOT, which a unit scope
    // does not have; the measured LAWN turf says nothing about it, so the
    // no-lot review must stand even with a verified turf measurement.
    withGate('true', () => {
      const out = classifyLane({
        ...unitLawnArgs,
        intent: {
          ...unitLawnArgs.intent,
          services: { lawn: { frequency: 'monthly' }, mosquito: {} },
        },
        engineInput: { measuredTurfSf: 4000, measuredTurfUnitVerified: true },
      });
      expect(noLotReason(out)).toBe(true);
    });
  });

  test('buildEngineInput stamps the profile area as unverified unless the unit matched exactly', () => {
    const args = {
      intent: { is_commercial: false, services: {} },
      propertyFacts: { propertyType: 'condo_ground' },
      context: { customer: { property_sqft: 4000, property_type: 'Condo' } },
      profileDescribesQuotedProperty: true,
    };
    expect(buildEngineInput(args).measuredTurfSf).toBe(4000);
    expect(buildEngineInput(args).measuredTurfUnitVerified).toBe(false);
    expect(buildEngineInput({ ...args, profileMeasurementUnitExact: true }).measuredTurfUnitVerified).toBe(true);
    // No profile match ⇒ no profile area at all, and nothing to qualify.
    const unmatched = buildEngineInput({ ...args, profileDescribesQuotedProperty: false });
    expect(unmatched.measuredTurfSf).toBeUndefined();
    expect(unmatched.measuredTurfUnitVerified).toBeUndefined();
  });
});

describe('requireNamedUnit — authenticating a unit needs an actual unit (r20)', () => {
  const { sameStreetAddress } = require('../services/estimator-engine/address-compare');
  const saved = (l1, l2) => [[l1, l2].filter(Boolean).join(' '), 'Sarasota', '34236'].filter(Boolean).join(', ');

  test('two unit-less addresses authenticate nothing', () => {
    // The saved profile is building-level (or its unit was never captured)
    // and the quote never stated a unit — 'exactly equal' here would let a
    // building measurement stand in for the priced apartment.
    expect(sameStreetAddress(
      saved('1400 Lakefront Dr'), '1400 Lakefront Dr, Sarasota, FL 34236',
      { requireNamedUnit: true },
    )).toBe(false);
    // The weaker mode still answers its own question (same parcel, no unit
    // to separate them) — duplicate detection and re-gather are unchanged.
    expect(sameStreetAddress(
      saved('1400 Lakefront Dr'), '1400 Lakefront Dr, Sarasota, FL 34236',
      { requireExactUnit: true },
    )).toBe(true);
  });

  test('one-sided and mismatched units never authenticate', () => {
    expect(sameStreetAddress(
      saved('1400 Lakefront Dr', 'Apt 7109'), '1400 Lakefront Dr, Sarasota, FL 34236',
      { requireNamedUnit: true },
    )).toBe(false);
    expect(sameStreetAddress(
      saved('1400 Lakefront Dr'), '1400 Lakefront Dr Apt 7109, Sarasota, FL 34236',
      { requireNamedUnit: true },
    )).toBe(false);
    expect(sameStreetAddress(
      saved('1400 Lakefront Dr', 'Apt 7109'), '1400 Lakefront Dr Apt 5202, Sarasota, FL 34236',
      { requireNamedUnit: true },
    )).toBe(false);
  });

  test('the same named unit on both sides authenticates — including a unit saved in line2', () => {
    expect(sameStreetAddress(
      saved('1400 Lakefront Dr', 'Apt 7109'), '1400 Lakefront Dr Apt 7109, Sarasota, FL 34236',
      { requireNamedUnit: true },
    )).toBe(true);
  });

  test('a different street is still a different property', () => {
    expect(sameStreetAddress(
      saved('1400 Lakefront Dr', 'Apt 7109'), '1400 Bayshore Dr Apt 7109, Sarasota, FL 34236',
      { requireNamedUnit: true },
    )).toBe(false);
  });
});

describe('a whole-building-classified tenant keeps their own stated area (r48)', () => {
  const factsV2 = require('../services/property-lookup/property-facts-v2');
  const ev = (overrides) => ({
    units: 'sqft',
    directness: 'direct',
    exactAddressMatch: true,
    exactSubpremiseMatch: false,
    extractionConfidence: 'high',
    warnings: [],
    ...overrides,
  });
  // The suite-tenant regression shape: a suite tenant whose address carries no
  // Suite/Unit suffix and whose county record reads a generic 'Commercial'
  // has NO part-building evidence, so the lane classifies the job
  // entire_commercial_building / leased_whole_building to protect their
  // parcel (r38/r39/r40). Their stated area must still price the job.
  const tenantEvidence = [
    ev({
      id: 'stated', field: 'commercial_suite_area_sqft', value: 1800, scope: 'suite',
      sourceType: 'caller', sourceName: 'caller-stated', extractionConfidence: 'medium',
      exactSubpremiseMatch: true,
    }),
    ev({
      id: 'county', field: 'building_area_sqft', value: 8400, scope: 'building',
      sourceType: 'county', sourceName: 'Manatee PAO',
      sourceUrl: 'https://www.manateepao.gov/parcel/?parid=1',
    }),
  ];
  const select = (input) => factsV2.selectPropertyFactsV2({
    normalizedAddress: '48th Avenue East, Bradenton, FL',
    propertySubtype: 'commercial',
    serviceScope: 'entire_commercial_building',
    evidence: tenantEvidence,
    ...input,
  });

  test('the tenant-stated area outranks the county building figure', () => {
    const facts = select({ ownershipType: 'leased_whole_building' });
    expect(facts.structureArea.value).toBe(1800);
    expect(facts.structureArea.kind).toBe('commercial_suite_area_sqft');
    // The whole-building number stays visible as evidence, never priced.
    expect(facts.evidence.some((e) => e.value === 8400)).toBe(true);
  });

  test('the stated area satisfies the scope — no spurious confirmation demand', () => {
    const facts = select({ ownershipType: 'leased_whole_building' });
    expect(facts.requiresConfirmation).toBe(false);
    // ...and the legacy bridge carries the tenant-safe number, so
    // applyV2ToPropertyFacts cannot overwrite V1's arbitration with the
    // building figure.
    expect(factsV2.deriveLegacyFields(facts).squareFootage).toBe(1800);
  });

  test('a tenant who stated nothing still keeps the building measurement (r38)', () => {
    const facts = select({
      ownershipType: 'leased_whole_building',
      evidence: [tenantEvidence[1]],
    });
    expect(facts.structureArea.value).toBe(8400);
    expect(facts.structureArea.kind).toBe('building_area_sqft');
    // The lot survives too — that was r40's whole point.
    expect(factsV2.lotApplicabilityFor({
      propertySubtype: 'warehouse', ownershipType: 'leased_whole_building',
    })).toBe('private_parcel');
  });

  test('an OWNER of a whole commercial building still prices the building', () => {
    // leased_whole_building exists only under the unit-scope gate, so every
    // other ownership — including the gate-off path — is untouched.
    const facts = select({ ownershipType: 'fee_simple' });
    expect(facts.structureArea.value).toBe(8400);
    expect(facts.structureArea.kind).toBe('building_area_sqft');
  });
});

describe('an owner-occupied commercial condo is a unit without any address suffix (r49)', () => {
  const { _private: shadowPrivate } = require('../services/estimator-engine/property-facts-shadow');

  // The r8 case, end to end: a commercial CONDOMINIUM owner has no tenancy
  // and — with no Unit/Suite line on the address — no subpremise, so the
  // suite branch's `(tenant || unitSignal)` conjunct dropped them into
  // entire_commercial_building and the county BUILDING area priced their
  // unit. The condo RECORD is the unit-occupancy evidence.
  const condoOwner = (overrides = {}) => resolveUnitScopeModel({
    propertyRecord: { propertyType: 'Commercial Condo' },
    extraction: { caller: { relationship_to_property: 'owner' }, property: {} },
    intent: { is_commercial: true, address: '3400 Cattlemen Rd, Sarasota, FL 34232' },
    propertyFacts: { tenant: false, home: { value: 24000, source: 'county_assessed' } },
    address: '3400 Cattlemen Rd, Sarasota, FL 34232',
    ...overrides,
  });

  test('the scope is a suite and the ownership is a commercial condominium', () => {
    const model = condoOwner();
    expect(model.serviceScope).toBe('commercial_suite');
    // The ownership behind it is a commercial condominium, so the lot is
    // the development's master parcel — never a private one.
    expect(model.lotApplicability).toBe('common_master_parcel');
  });

  test('the whole-building county area never prices the unit', () => {
    const facts = { home: { value: 24000, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(facts, condoOwner());
    expect(facts.home.value).toBeNull();
    expect((facts.home.rejected || []).some((r) => r.value === 24000)).toBe(true);
  });

  test('county land-use text carries the same evidence as the type', () => {
    expect(shadowPrivate.isCondoRecord({
      aggregated: false, propertyType: 'Commercial', landUseDescription: 'Office Condominium',
    })).toBe(true);
  });

  test('an AGGREGATED stacked complex stays an association job (r17/r42)', () => {
    // A condo complex bought whole is not one unit — the aggregate must
    // keep its association scope and its own measurements.
    expect(shadowPrivate.isCondoRecord({ aggregated: true, propertyType: 'Commercial Condo' })).toBe(false);
    const model = condoOwner({
      propertyRecord: { propertyType: 'Commercial Condo', _parcel: { aggregated: true } },
    });
    expect(model.serviceScope).not.toBe('commercial_suite');
  });

  test('the kill switch still restores prior behavior', () => {
    // The V2 shadow path opts out per call, so a condo record cannot make
    // it a suite with GATE_UNIT_SCOPE_GUARDRAILS off.
    const args = {
      propertyType: 'Commercial Condo', isCommercial: true, tenant: false,
      aggregated: false, unitSignal: false, partBuilding: true, condoRecord: true,
    };
    expect(shadowPrivate.inferServiceScope(args)).toBe('entire_commercial_building');
    expect(shadowPrivate.inferServiceScope({ ...args, unitScopeSuites: true })).toBe('commercial_suite');
    expect(shadowPrivate.inferOwnershipType(args)).toBe('residential_condominium');
    expect(shadowPrivate.inferOwnershipType({ ...args, unitScopeSuites: true })).toBe('commercial_condominium');
  });
});

describe('a unit-first address is a subpremise for scope too (r51)', () => {
  const { _private: shadowPrivate } = require('../services/estimator-engine/property-facts-shadow');

  test('the enhanced signal recognizes a leading designator ahead of the street number', () => {
    expect(shadowPrivate.hasSubpremiseSignal({
      address: 'Unit 7, 123 Main St, Bradenton, FL 34201', extraction: null,
    })).toBe(true);
    expect(shadowPrivate.hasSubpremiseSignal({
      address: 'Apt 4 at 123 Main Street, Venice, FL 34285', extraction: null,
    })).toBe(true);
    // No street number after the designator: not a serviceable unit-first
    // address ("62nd Avenue East, Unit 7" keeps failing elsewhere too).
    expect(shadowPrivate.hasSubpremiseSignal({
      address: 'Unit 7, Bayview Terrace, Venice, FL', extraction: null,
    })).toBe(false);
  });

  test('the legacy signal is unchanged — the kill switch keeps prior V2 behavior', () => {
    expect(shadowPrivate.hasUnitSignal({
      tenant: false, address: 'Unit 7, 123 Main St, Bradenton, FL 34201', extraction: null,
    })).toBe(false);
    expect(shadowPrivate.hasUnitSignal({
      tenant: false, address: 'Unit 7, 123 Main St, Bradenton, FL 34201', extraction: null, enhanced: true,
    })).toBe(true);
  });

  test('a tenant at a unit-first address on a flattened record is a residential unit', () => {
    // The r51 shape: provider flattened the record to Single Family, the
    // unit designator LEADS the address, and the whole-structure veto must
    // not keep the county area/master lot pricing the whole property.
    const model = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Single Family' },
      extraction: { caller: { relationship_to_property: 'tenant' }, property: {} },
      intent: { is_commercial: false, address: 'Unit 7, 123 Main St, Bradenton, FL 34201' },
      propertyFacts: { tenant: true, home: { value: 2400, source: 'county_assessed' } },
      address: 'Unit 7, 123 Main St, Bradenton, FL 34201',
    });
    expect(model.subpremiseSignal).toBe(true);
    expect(model.serviceScope).toBe('residential_unit');
    const facts = { home: { value: 2400, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(facts, model);
    expect(facts.home.value).toBeNull();
  });
});

describe('association callers keep association scope on condo records (r51)', () => {
  const { _private: shadowPrivate } = require('../services/estimator-engine/property-facts-shadow');

  const managerModel = (extraction, intent = {}) => resolveUnitScopeModel({
    propertyRecord: { propertyType: 'Commercial Condo' },
    extraction,
    intent: { is_commercial: true, address: '3400 Cattlemen Rd, Sarasota, FL 34232', ...intent },
    propertyFacts: { tenant: false, home: { value: 24000, source: 'county_assessed' } },
    address: '3400 Cattlemen Rd, Sarasota, FL 34232',
  });

  test('an association manager on a condo record is never a suite', () => {
    const model = managerModel({
      caller: { relationship_to_property: 'property manager' }, property: {},
    });
    expect(model.serviceScope).not.toBe('commercial_suite');
    // The building measurement survives for common-area pricing.
    const facts = { home: { value: 24000, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(facts, model);
    expect(facts.home.value).toBe(24000);
  });

  test('a manager whose contact address carries a Suite line is still not a suite (r52)', () => {
    // The unitSignal door: the manager's own office address has a
    // subpremise, which independently satisfied the suite branch even with
    // the condo-record gate in place. The association signal must outrank
    // every unit signal.
    const model = resolveUnitScopeModel({
      propertyRecord: { propertyType: 'Commercial Condo' },
      extraction: { caller: { relationship_to_property: 'property manager' }, property: {} },
      intent: { is_commercial: true, address: '3400 Cattlemen Rd Suite 100, Sarasota, FL 34232' },
      propertyFacts: { tenant: false, home: { value: 24000, source: 'county_assessed' } },
      address: '3400 Cattlemen Rd Suite 100, Sarasota, FL 34232',
    });
    expect(model.serviceScope).toBe('association_common_area');
    expect(model.serviceScope).not.toBe('commercial_suite');
    // The association's building measurement survives.
    const facts = { home: { value: 24000, source: 'county_assessed', confidence: 'high' } };
    applyUnitScopeToPropertyFacts(facts, model);
    expect(facts.home.value).toBe(24000);
  });

  test('the structured hoa_common_area_service boolean carries the same rule', () => {
    const model = managerModel({
      caller: { relationship_to_property: 'owner' },
      property: { hoa_common_area_service: true },
    });
    expect(model.serviceScope).not.toBe('commercial_suite');
  });

  test('the underscored hoa_common_area property type is an association job (r55)', () => {
    // Schema-valid extraction type, null risk: the space-form-only
    // ASSOCIATION_TYPES regex missed it and the job read as a whole
    // building on a private parcel.
    const model = resolveUnitScopeModel({
      propertyRecord: null,
      extraction: {
        caller: { relationship_to_property: 'owner' },
        property: { property_type: 'hoa_common_area' },
      },
      intent: { is_commercial: true, address: '3400 Cattlemen Rd, Sarasota, FL 34232' },
      propertyFacts: { tenant: false, home: { source: 'unresolved' } },
      address: '3400 Cattlemen Rd, Sarasota, FL 34232',
    });
    expect(model.serviceScope).toBe('association_common_area');
    expect(model.lotApplicability).not.toBe('private_parcel');
  });

  test('an hoa/common-area risk type carries the same rule', () => {
    expect(shadowPrivate.condoRecordOccupancy({
      condoRecord: true,
      extraction: { caller: { relationship_to_property: 'owner' }, property: {} },
      intent: { commercial_risk_type: 'hoa_common_area' },
    })).toBe(false);
  });

  test('an owner without association signals keeps the r49 suite behavior', () => {
    expect(shadowPrivate.condoRecordOccupancy({
      condoRecord: true,
      extraction: { caller: { relationship_to_property: 'owner' }, property: {} },
      intent: {},
    })).toBe(true);
  });
});
