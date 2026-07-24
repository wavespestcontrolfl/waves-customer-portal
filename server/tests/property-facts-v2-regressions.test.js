/**
 * Property Facts V2 — regression tests for the measurement-semantics defects
 * (2026-07-24 audit). Written test-first: each block names the dangerous
 * behavior it pins down.
 *
 *  1. Condo lot-N/A treated as incomplete → AI told to keep searching → the
 *     development master parcel becomes the unit's "lot".
 *  2. One generic squareFootage conflates unit/suite/building/gross areas.
 *  3. Factual values capped at 200k before storage (commercial sqft, lots,
 *     verified overrides).
 *  4. Story fallback discards provenance; any positive count reads 'lookup'.
 *  5. Commercial parsers keep only the largest/primary building row.
 *  6. Model confidence (+30) lets a listing tie a county record.
 *  7. Three models reading one MLS page count as three sources.
 *  8. 2,154 vs 2,155 sqft flagged as disagreement (no tolerance).
 *  9. "Retail" normalized to "Office"; substring host matching reads
 *     marondahomes.com as homes.com.
 */

const { _private } = require('../services/property-lookup/ai-property-lookup');
const factsV2 = require('../services/property-lookup/property-facts-v2');
const shadow = require('../services/estimator-engine/property-facts-shadow');
const { buildEngineInput } = require('../services/estimator-engine/draft-builder');

// ── Shared fixtures ─────────────────────────────────────────────

function evidence(overrides = {}) {
  return {
    id: overrides.id || `ev-${Math.abs(JSON.stringify(overrides).split('').reduce((a, c) => a + c.charCodeAt(0), 0))}`,
    field: 'residential_living_area_sqft',
    value: 2000,
    units: 'sqft',
    scope: 'building',
    directness: 'direct',
    sourceName: 'Manatee PAO',
    sourceType: 'county',
    sourceUrl: 'https://www.manateepao.gov/parcel/?parid=647302459',
    exactAddressMatch: true,
    exactSubpremiseMatch: true,
    addressMatchScore: 1,
    extractionConfidence: 'high',
    warnings: [],
    ...overrides,
  };
}

// ── 1+2. Scallop Loop condo: unit area selected, master parcel never the lot ──

describe('selectPropertyFactsV2 — condominium unit (Scallop Loop class)', () => {
  const condoEvidence = [
    evidence({
      id: 'unit-area', field: 'residential_unit_area_sqft', value: 1154, scope: 'unit',
      sourceType: 'county', sourceName: 'Sarasota PAO',
      sourceUrl: 'https://www.sc-pa.com/propertysearch/parcel/details/0000001',
    }),
    evidence({
      id: 'master-parcel', field: 'parcel_area_sqft', value: 1800000, scope: 'association',
      sourceType: 'county', sourceName: 'Sarasota GIS',
      sourceUrl: 'https://ags3.scgov.net/server/rest/services/Hosted/Parcels/FeatureServer/0/query?x=1',
    }),
  ];

  const selected = () => factsV2.selectPropertyFactsV2({
    normalizedAddress: '19116 Scallop Loop Unit 102, Venice, FL',
    propertySubtype: 'condominium',
    ownershipType: 'residential_condominium',
    serviceScope: 'residential_unit',
    evidence: condoEvidence,
  });

  test('selects the exact unit living area as the structure area', () => {
    const facts = selected();
    expect(facts.structureArea.value).toBe(1154);
    expect(facts.structureArea.kind).toBe('residential_unit_area_sqft');
    expect(facts.structureArea.scope).toBe('unit');
  });

  test('private lot resolves to null with common_master_parcel applicability — a resolved fact, not a missing one', () => {
    const facts = selected();
    expect(facts.lot.privateLotSqft).toBeNull();
    expect(facts.lot.applicability).toBe('common_master_parcel');
    // The development's parcel is retained as context, never selected as the lot.
    expect(facts.lot.masterParcelAreaSqft).toBe(1800000);
  });

  test('condo unit without a private lot is COMPLETE — lot is not a required measurement', () => {
    const required = factsV2.requiredMeasurements({
      propertySubtype: 'condominium',
      ownershipType: 'residential_condominium',
      serviceScope: 'residential_unit',
    });
    expect(required).not.toContain('private_lot_area_sqft');
    expect(required).toContain('residential_unit_area_sqft');
    expect(selected().requiresConfirmation).toBe(false);
  });

  test('legacy derivation never leaks the master parcel into lotSize', () => {
    const legacy = factsV2.deriveLegacyFields(selected());
    expect(legacy.squareFootage).toBe(1154);
    expect(legacy.lotSize).toBeNull();
  });
});

describe('requiredMeasurements — property-type awareness', () => {
  test('single-family requires living area AND private lot', () => {
    const required = factsV2.requiredMeasurements({
      propertySubtype: 'single_family',
      ownershipType: 'fee_simple',
      serviceScope: 'entire_residential_structure',
    });
    expect(required).toEqual(expect.arrayContaining(['residential_living_area_sqft', 'private_lot_area_sqft']));
  });

  test('commercial suite requires only the suite area', () => {
    const required = factsV2.requiredMeasurements({
      propertySubtype: 'retail',
      ownershipType: 'leased_suite',
      serviceScope: 'commercial_suite',
    });
    expect(required).toContain('commercial_suite_area_sqft');
    expect(required).not.toContain('private_lot_area_sqft');
    expect(required).not.toContain('building_area_sqft');
  });
});

describe('selectPropertyFactsV2 — fee-simple vs condominium townhouse lots', () => {
  const townhouseEvidence = (ownershipType) => [
    evidence({ id: 'th-area', field: 'residential_living_area_sqft', value: 1600, scope: 'unit' }),
    evidence({ id: 'th-parcel', field: 'parcel_area_sqft', value: 2200, scope: 'parcel' }),
  ];

  test('fee-simple townhouse receives its individual parcel as the private lot', () => {
    const facts = factsV2.selectPropertyFactsV2({
      normalizedAddress: '100 Test Row, Bradenton, FL',
      propertySubtype: 'townhouse',
      ownershipType: 'fee_simple',
      serviceScope: 'entire_residential_structure',
      evidence: townhouseEvidence('fee_simple'),
    });
    expect(facts.lot.privateLotSqft).toBe(2200);
    expect(facts.lot.applicability).toBe('private_parcel');
  });

  test('condominium-owned townhouse keeps privateLotSqft null', () => {
    const facts = factsV2.selectPropertyFactsV2({
      normalizedAddress: '100 Test Row, Bradenton, FL',
      propertySubtype: 'townhouse',
      ownershipType: 'residential_condominium',
      serviceScope: 'residential_unit',
      evidence: townhouseEvidence('residential_condominium'),
    });
    expect(facts.lot.privateLotSqft).toBeNull();
    expect(facts.lot.applicability).toBe('common_master_parcel');
  });
});

// ── 2+5. Commercial scope: suite vs entire building vs multi-building parcel ──

describe('selectPropertyFactsV2 — commercial scope resolution', () => {
  const plazaEvidence = [
    evidence({
      id: 'suite', field: 'commercial_suite_area_sqft', value: 1500, scope: 'suite',
      sourceType: 'verified', sourceName: 'customer-confirmed suite area', directness: 'direct',
      sourceUrl: null,
    }),
    evidence({
      id: 'building', field: 'building_area_sqft', value: 40000, scope: 'building',
      sourceType: 'county', sourceName: 'Manatee PAO',
    }),
  ];

  test('commercial_suite scope selects the suite area, never the building', () => {
    const facts = factsV2.selectPropertyFactsV2({
      normalizedAddress: '200 Plaza Dr Suite 200, Sarasota, FL',
      propertySubtype: 'retail',
      ownershipType: 'leased_suite',
      serviceScope: 'commercial_suite',
      evidence: plazaEvidence,
    });
    expect(facts.structureArea.value).toBe(1500);
    expect(facts.structureArea.kind).toBe('commercial_suite_area_sqft');
    // The building stays visible as evidence context.
    expect(facts.evidence.some((e) => e.field === 'building_area_sqft' && e.value === 40000)).toBe(true);
  });

  test('entire_commercial_building scope selects the building area', () => {
    const facts = factsV2.selectPropertyFactsV2({
      normalizedAddress: '200 Plaza Dr, Sarasota, FL',
      propertySubtype: 'retail',
      ownershipType: 'fee_simple',
      serviceScope: 'entire_commercial_building',
      evidence: plazaEvidence,
    });
    expect(facts.structureArea.value).toBe(40000);
    expect(facts.structureArea.kind).toBe('building_area_sqft');
  });

  test('unresolvable suite-vs-building scope goes unresolved instead of guessing', () => {
    const facts = factsV2.selectPropertyFactsV2({
      normalizedAddress: '200 Plaza Dr, Sarasota, FL',
      propertySubtype: 'retail',
      ownershipType: 'leased_suite',
      serviceScope: 'commercial_suite',
      evidence: [plazaEvidence[1]], // only the whole-building figure exists
    });
    expect(facts.structureArea.value).toBeNull();
    expect(facts.requiresConfirmation).toBe(true);
  });

  test('multi-building parcel sums only when scope covers every building', () => {
    const multi = [
      evidence({ id: 'b1', field: 'building_area_sqft', value: 12000, scope: 'building', sourceRecordId: 'bldg-1' }),
      evidence({ id: 'b2', field: 'building_area_sqft', value: 9000, scope: 'building', sourceRecordId: 'bldg-2' }),
      evidence({ id: 'b3', field: 'building_area_sqft', value: 7000, scope: 'building', sourceRecordId: 'bldg-3' }),
    ];
    const wholeParcel = factsV2.selectPropertyFactsV2({
      normalizedAddress: '300 Industrial Way, Palmetto, FL',
      propertySubtype: 'warehouse',
      ownershipType: 'fee_simple',
      serviceScope: 'multi_building_commercial_parcel',
      evidence: multi,
    });
    expect(wholeParcel.structureArea.value).toBe(28000);
    expect(wholeParcel.structureArea.scope).toBe('multi_building_parcel');

    const oneBuilding = factsV2.selectPropertyFactsV2({
      normalizedAddress: '300 Industrial Way, Palmetto, FL',
      propertySubtype: 'warehouse',
      ownershipType: 'fee_simple',
      serviceScope: 'entire_commercial_building',
      evidence: multi,
    });
    // Largest building is NOT silently promoted to "the property".
    expect(oneBuilding.structureArea.value).not.toBe(28000);
    expect(oneBuilding.requiresConfirmation).toBe(true);
  });
});

// ── 3. Facts are never capped; pricing bounds live in pricingValue ──

describe('actual values are never truncated', () => {
  test('a 270,000 sqft commercial building keeps its actual value; pricing gets the disposition', () => {
    const facts = factsV2.selectPropertyFactsV2({
      normalizedAddress: '400 Distribution Ct, Punta Gorda, FL',
      propertySubtype: 'warehouse',
      ownershipType: 'fee_simple',
      serviceScope: 'entire_commercial_building',
      evidence: [evidence({ id: 'big', field: 'building_area_sqft', value: 270000, scope: 'building' })],
    });
    expect(facts.structureArea.value).toBe(270000);
    expect(facts.structureArea.pricingValue).toBeNull();
    expect(facts.structureArea.pricingDisposition).toBe('relationship_quote');
  });

  test('coerceBuildingSqftDetailed preserves the actual value alongside the pricing clamp', () => {
    const detailed = _private.coerceBuildingSqftDetailed(270000, true);
    expect(detailed.actualValue).toBe(270000);
    expect(detailed.pricingValue).toBe(200000);
    expect(detailed.pricingAdjustment).toBe('commercial_area_cap');
  });

  test('six-story commercial buildings keep their story count', () => {
    expect(_private.coerceStoriesValue(6, { commercial: true })).toBe(6);
    // Residential garbage guard stays: a "6-story" single-family read is junk.
    expect(_private.coerceStoriesValue(6, { commercial: false })).toBeNull();
    expect(_private.coerceStoriesValue(2, { commercial: false })).toBe(2);
  });
});

// ── 4. Story provenance ──

describe('story evidence provenance', () => {
  test('parseStoriesJSON retains confidence, source, and basis instead of a bare integer', () => {
    const parsed = _private.parseStoriesJSON(JSON.stringify({
      stories: 2,
      confidence: 'low',
      source: 'https://www.zillow.com/homedetails/123',
      basis: 'inferred',
    }));
    expect(parsed.stories).toBe(2);
    expect(parsed.confidence).toBe('low');
    expect(parsed.basis).toBe('inferred');
  });
});

// ── 6+7+8. Evidence scoring, independence, tolerance ──

describe('mergePropertyRecords — authority beats model confidence', () => {
  const county = {
    squareFootage: 2154,
    propertyType: 'Single Family',
    _provider: 'county',
    _source: 'county',
    _aiSourceUrl: 'https://www.manateepao.gov/parcel/?parid=1',
    _aiSourceQuality: 100,
    _aiSourceType: 'county',
    _aiConfidence: 'medium',
  };
  const listing = {
    squareFootage: 2600,
    propertyType: 'Single Family',
    _provider: 'claude',
    _source: 'ai',
    _aiSourceUrl: 'https://www.zillow.com/homedetails/8920-49th-ave-e/1_zpid/',
    _aiSourceQuality: 75,
    _aiSourceType: 'listing',
    _aiConfidence: 'high',
  };

  test('a high-confidence listing never outranks or ties a county record', () => {
    const merged = _private.mergePropertyRecords([listing, county], '8920 49th Ave E');
    expect(merged.squareFootage).toBe(2154);
    expect(merged._fieldEvidence.squareFootage.sourceType).toBe('county');
  });

  test('near-identical values are agreement, not disagreement (2,154 vs 2,155)', () => {
    const merged = _private.mergePropertyRecords([
      county,
      { ...listing, squareFootage: 2155 },
    ], '8920 49th Ave E');
    expect(merged._fieldEvidence.squareFootage.disagreement).toBe(false);
  });

  test('materially different values still surface as disagreement', () => {
    const merged = _private.mergePropertyRecords([
      county,
      { ...listing, squareFootage: 3400 },
    ], '8920 49th Ave E');
    expect(merged._fieldEvidence.squareFootage.disagreement).toBe(true);
  });
});

describe('valuesEquivalent — documented tolerances', () => {
  test('residential area: max(25 sqft, 1%)', () => {
    expect(factsV2.valuesEquivalent('residential_living_area_sqft', 2154, 2155)).toBe(true);
    expect(factsV2.valuesEquivalent('residential_living_area_sqft', 2154, 2200)).toBe(false);
  });
  test('commercial area: max(100 sqft, 2%)', () => {
    expect(factsV2.valuesEquivalent('building_area_sqft', 40000, 40700)).toBe(true);
    expect(factsV2.valuesEquivalent('building_area_sqft', 40000, 42000)).toBe(false);
  });
  test('stories: exact only', () => {
    expect(factsV2.valuesEquivalent('building_stories', 2, 2)).toBe(true);
    expect(factsV2.valuesEquivalent('building_stories', 1, 2)).toBe(false);
  });
});

describe('evidence independence', () => {
  test('three models citing the same MLS page dedupe to one independent source', () => {
    const sameListing = (provider) => evidence({
      id: `sqft-${provider}`,
      field: 'residential_living_area_sqft',
      value: 2400,
      scope: 'building',
      sourceType: 'listing',
      sourceName: provider,
      sourceUrl: 'https://www.realtor.com/realestateandhomes-detail/8920-49th-Ave-E_Bradenton_FL?utm=abc#photos',
      mlsNumber: 'A4611111',
    });
    const deduped = factsV2.dedupeEvidence([
      sameListing('claude'), sameListing('openai'), sameListing('gemini'),
    ]);
    expect(deduped).toHaveLength(1);
  });

  test('canonical URL ignores query/hash noise; different records stay distinct', () => {
    const a = evidence({ id: 'a', sourceUrl: 'https://www.realtor.com/detail/x?utm=1#top', mlsNumber: null });
    const b = evidence({ id: 'b', sourceUrl: 'https://realtor.com/detail/x', mlsNumber: null });
    const c = evidence({ id: 'c', sourceUrl: 'https://www.realtor.com/detail/OTHER', mlsNumber: null });
    expect(factsV2.independenceKeyFor(a)).toBe(factsV2.independenceKeyFor(b));
    expect(factsV2.independenceKeyFor(a)).not.toBe(factsV2.independenceKeyFor(c));
  });
});

// ── 9. Classification fixes ──

describe('classification fixes', () => {
  test('Retail stays Retail — never normalized to Office', () => {
    expect(_private.normalizeLookupPropertyType('Retail')).toBe('Retail');
    expect(_private.normalizeLookupPropertyType('Retail Store')).toBe('Retail');
    expect(_private.normalizeLookupPropertyType('Storefront Retail')).toBe('Retail');
    // Office inputs keep working.
    expect(_private.normalizeLookupPropertyType('Office')).toBe('Office');
    expect(_private.normalizeLookupPropertyType('Commercial Office')).toBe('Office');
  });

  test('source hosts match by exact domain/subdomain, never substring', () => {
    // marondahomes.com must not read as homes.com (listing).
    const maronda = _private.classifyPropertySource('https://www.marondahomes.com/florida/1820-magnolia-plan');
    expect(maronda.type).not.toBe('listing');
    // Real subdomains still match.
    const zillow = _private.classifyPropertySource('https://www.zillow.com/homedetails/8920-49th-Ave-E/1_zpid/');
    expect(zillow.type).toBe('listing');
  });

  test('hasCountyPricingCore is property-type aware — a condo unit with no lot is complete', () => {
    expect(_private.hasCountyPricingCore({
      squareFootage: 1154, lotSize: null, propertyType: 'Condo',
    })).toBe(true);
    // Single-family still needs its lot.
    expect(_private.hasCountyPricingCore({
      squareFootage: 2400, lotSize: null, propertyType: 'Single Family',
    })).toBe(false);
    expect(_private.hasCountyPricingCore({
      squareFootage: 2400, lotSize: 8400, propertyType: 'Single Family',
    })).toBe(true);
  });
});

// ── 5. County parsers preserve every building row ──

describe('Manatee parser preserves all building rows', () => {
  const manateeSearch = { parcelId: '647302459', situsAddress: '300 INDUSTRIAL WAY', city: 'PALMETTO' };
  const manateeLand = {
    cols: [
      { title: 'Area' }, { title: 'Type' }, { title: 'ActFrontage' }, { title: 'EffFrontage' },
      { title: 'Depth' }, { title: 'Acreage' }, { title: 'SqFootage' }, { title: 'Units' }, { title: 'Influences' },
    ],
    rows: [['1', 'UNIT', '70', '70', '120', '2.5', '108,900', '1.00', '']],
  };
  const multiBuildings = {
    cols: [
      { title: 'Type' }, { title: 'Bldg' }, { title: 'Classification' }, { title: 'Yrblt' },
      { title: 'Effyr' }, { title: 'Stories' }, { title: 'UnRoof' }, { title: 'LivBus' },
      { title: 'Rooms' }, { title: 'Const/ExtWall' }, { title: 'RoofMaterial' }, { title: 'RoofType' },
    ],
    rows: [
      ['COM', '1', 'WAREHOUSE', '2005', '2005', 1, '14000', '12000', '', 'METAL', 'METAL', 'METAL'],
      ['COM', '2', 'WAREHOUSE', '2008', '2008', 1, '10500', '9000', '', 'METAL', 'METAL', 'METAL'],
      ['COM', '3', 'OFFICE', '2010', '2010', 2, '7600', '7000', '', 'MASONRY/STUCCO', 'METAL', 'FLAT'],
    ],
  };

  test('every building row survives with raw-labeled areas, not just the largest', () => {
    const parsed = _private.parseManateePaoRecord({
      address: '300 Industrial Way, Palmetto, FL 34221',
      search: manateeSearch,
      land: manateeLand,
      buildings: multiBuildings,
    });
    expect(parsed._buildings).toHaveLength(3);
    expect(parsed._buildings.map((b) => b.livingAreaSqft)).toEqual([12000, 9000, 7000]);
    expect(parsed._buildings.map((b) => b.underRoofSqft)).toEqual([14000, 10500, 7600]);
    expect(parsed._buildings[2].stories).toBe(2);
    expect(parsed._buildings[2].description).toBe('OFFICE');
    // Legacy primary-building selection is unchanged.
    expect(parsed.squareFootage).toBe(12000);
  });
});

// ── Estimator integration: story provenance + shadow diff ──

describe('buildEngineInput story provenance', () => {
  const baseIntent = { services: { pest: { selected: true } }, is_commercial: false };

  test('a low-confidence inferred story count prices as estimated, not lookup', () => {
    const input = buildEngineInput({
      intent: baseIntent,
      propertyFacts: {
        home: { value: 2400, source: 'county_assessed' },
        lot: { value: 8400, source: 'county_assessed' },
        stories: 2,
        storiesEvidence: { value: 2, confidence: 'low', basis: 'inferred', sourceType: 'model_inference' },
      },
      context: {},
    });
    expect(input.storiesSource).toBe('estimated');
  });

  test('a direct-source fallback story count stays a lookup; no stories stays default', () => {
    const direct = buildEngineInput({
      intent: baseIntent,
      propertyFacts: {
        home: { value: 2400, source: 'county_assessed' },
        lot: { value: 8400, source: 'county_assessed' },
        stories: 2,
        storiesEvidence: { value: 2, confidence: 'high', basis: 'direct', sourceType: 'listing' },
      },
      context: {},
    });
    expect(direct.storiesSource).toBe('lookup');

    const none = buildEngineInput({
      intent: baseIntent,
      propertyFacts: {
        home: { value: 2400, source: 'county_assessed' },
        lot: { value: 8400, source: 'county_assessed' },
        stories: null,
      },
      context: {},
    });
    expect(none.storiesSource).toBe('default');
    expect(none.stories).toBe(1);
  });
});

describe('property-facts V2 shadow (estimator bridge)', () => {
  const condoRecord = {
    propertyType: 'Condo',
    squareFootage: 1154,
    lotSize: 180000, // V1 leaked the development's master parcel as the lot
    stories: 1,
    formattedAddress: '19116 Scallop Loop Unit 102, Venice, FL',
    _parcel: { parcelId: '0000001', county: 'Sarasota', lotSqft: 180000, aggregated: false },
    _fieldEvidence: {
      squareFootage: {
        value: 1154,
        sourceType: 'county',
        evidence: [{ value: 1154, sourceType: 'county', provider: 'sarasota_pao', url: 'https://www.sc-pa.com/x' }],
      },
    },
  };

  test('condo shadow flags the V1 master-parcel lot and derives lotSize null', () => {
    const result = shadow.computePropertyFactsV2Shadow({
      propertyRecord: condoRecord,
      extraction: null,
      intent: { is_commercial: false },
      propertyFacts: { home: { value: 1154 }, lot: { value: 180000 }, stories: 1, tenant: false },
      address: '19116 Scallop Loop Unit 102, Venice, FL',
    });
    expect(result).not.toBeNull();
    expect(result.shadow).toBe(true); // gate off by default
    expect(result.facts.serviceScope).toBe('residential_unit');
    expect(result.facts.lot.applicability).toBe('common_master_parcel');
    expect(result.legacyDerived.lotSize).toBeNull();
    expect(result.differences).toContain('v1_lot_on_no_lot_property');
  });

  test('shadow never throws on a hostile record', () => {
    expect(shadow.computePropertyFactsV2Shadow({
      propertyRecord: { _fieldEvidence: { squareFootage: 'garbage' } },
      extraction: undefined,
      intent: null,
      propertyFacts: null,
      address: null,
    })).toBeNull();
  });
});
