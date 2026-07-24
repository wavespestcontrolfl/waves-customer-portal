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

// ── Codex round-1 regressions (reviewed b086d51ee) ──

describe('codex r1: single-building commercial is not falsely ambiguous', () => {
  test('record-level evidence plus one building row resolves instead of unresolved', () => {
    const facts = factsV2.selectPropertyFactsV2({
      normalizedAddress: '500 Commerce Blvd, Sarasota, FL',
      propertySubtype: 'warehouse',
      ownershipType: 'fee_simple',
      serviceScope: 'entire_commercial_building',
      evidence: [
        // Merged record-level squareFootage (no sourceRecordId)…
        evidence({ id: 'record-level', field: 'building_area_sqft', value: 42000, scope: 'building' }),
        // …plus the same building's parsed row and an uncapped actual —
        // ONE building, three views of it.
        evidence({ id: 'row', field: 'building_area_sqft', value: 42000, scope: 'building', sourceRecordId: 'building-1' }),
        evidence({ id: 'actual', field: 'building_area_sqft', value: 42000, scope: 'building', sourceUrl: 'https://www.manateepao.gov/parcel/?parid=X' }),
      ],
    });
    expect(facts.structureArea.value).toBe(42000);
    expect(facts.warnings).not.toContain('multiple distinct buildings on the parcel — confirm which building(s) the service covers');
  });

  test('two genuinely distinct building rows still go unresolved', () => {
    const facts = factsV2.selectPropertyFactsV2({
      normalizedAddress: '500 Commerce Blvd, Sarasota, FL',
      propertySubtype: 'warehouse',
      ownershipType: 'fee_simple',
      serviceScope: 'entire_commercial_building',
      evidence: [
        evidence({ id: 'b1', field: 'building_area_sqft', value: 12000, scope: 'building', sourceRecordId: 'building-1' }),
        evidence({ id: 'b2', field: 'building_area_sqft', value: 9000, scope: 'building', sourceRecordId: 'building-2' }),
      ],
    });
    expect(facts.structureArea.value).toBeNull();
    expect(facts.requiresConfirmation).toBe(true);
  });
});

describe('codex r1: merge tolerance follows the property TYPE', () => {
  test('a 5,000 sqft retail suite uses commercial tolerance (75 sqft apart = agreement)', () => {
    const county = {
      squareFootage: 5000,
      propertyType: 'Retail',
      _provider: 'county',
      _source: 'county',
      _aiSourceUrl: 'https://www.manateepao.gov/parcel/?parid=2',
      _aiSourceQuality: 100,
      _aiSourceType: 'county',
      _aiConfidence: 'medium',
    };
    const listing = {
      squareFootage: 5075,
      propertyType: 'Retail',
      _provider: 'claude',
      _source: 'ai',
      _aiSourceUrl: 'https://www.loopnet.com/Listing/500-commerce-blvd/1/',
      _aiSourceQuality: 75,
      _aiSourceType: 'listing',
      _aiConfidence: 'high',
    };
    const merged = _private.mergePropertyRecords([county, listing], '500 Commerce Blvd');
    expect(merged._fieldEvidence.squareFootage.disagreement).toBe(false);
    // Same 75 sqft gap on a residential record IS a dispute (max(25, 1%) = 50).
    const resCounty = { ...county, squareFootage: 5000, propertyType: 'Single Family' };
    const resListing = { ...listing, squareFootage: 5075, propertyType: 'Single Family' };
    const resMerged = _private.mergePropertyRecords([resCounty, resListing], '500 Commerce Blvd');
    expect(resMerged._fieldEvidence.squareFootage.disagreement).toBe(true);
  });
});

describe('codex r1: Sarasota detail-page area keeps its uncapped actual', () => {
  test('a 270,000 sqft Finished Area survives to _actuals with the pricing clamp on squareFootage', () => {
    const detailHtml = `
      <li><strong>Land Area:</strong> 120,000 Sq.Ft.</li>
      <li><strong>Property Use:</strong> 4800 - Warehouse Distribution</li>
      <table id="Buildings" class="grid">
        <thead><tr><th>Situs</th><th>Bldg #</th><th>Beds</th><th>Baths</th><th>Half Baths</th><th>Year Built</th><th>Eff Yr Built</th><th>Gross Area</th><th>Living Area</th><th>Stories</th></tr></thead>
        <tbody><tr><td><a href="/propertysearch/Building/Show?strap=1&num=1">500 COMMERCE BLVD</a></td><td>1</td><td></td><td></td><td></td><td>2005</td><td>2005</td><td></td><td></td><td>1</td></tr></tbody>
      </table>
    `;
    const buildingDetailHtml = `
      <ul class="bullet">
        <li>Building Type: Warehouse Distribution</li>
        <li>Finished Area S.F: 270,000</li>
        <li>Year Built: 2005</li>
        <li>Number of Stories:<span>1 <br /></span></li>
      </ul>
    `;
    const parsed = _private.parseSarasotaPaoRecord({
      address: '500 Commerce Blvd, Sarasota, FL',
      search: { parcelId: '0000002', situsAddress: '500 COMMERCE BLVD', city: 'SARASOTA' },
      detailHtml,
      buildingDetailHtml,
    });
    expect(parsed.squareFootage).toBe(200000);
    expect(parsed._actuals.buildingAreaSqft).toBe(270000);
    expect(parsed._actuals.pricingAdjustment).toBe('commercial_area_cap');
  });
});

// ── Codex round-2 regressions (reviewed 1a40d3a8ed) ──

describe('codex r2: AI lookup preserves uncapped actuals', () => {
  test('a 270k warehouse + oversized lot from the AI trio keep their actuals', () => {
    const parsed = _private.parsePropertyJSON(JSON.stringify({
      squareFootage: 270000,
      lotSize: 500000,
      yearBuilt: 2005,
      stories: 1,
      propertyType: 'Warehouse',
      source: 'https://www.loopnet.com/Listing/500-commerce-blvd/1/',
      confidence: 'high',
    }));
    expect(parsed.squareFootage).toBe(200000);
    expect(parsed._actuals.buildingAreaSqft).toBe(270000);
    expect(parsed._actuals.lotSqft).toBe(500000);
  });

  test('acre-labeled oversized lots convert and survive; normal lots add no actuals', () => {
    const big = _private.parsePropertyJSON(JSON.stringify({
      squareFootage: 2400, lotSize: '20 acres', propertyType: 'Single Family',
      source: 'https://www.zillow.com/x', confidence: 'medium',
    }));
    expect(big._actuals.lotSqft).toBe(871200);
    const normal = _private.parsePropertyJSON(JSON.stringify({
      squareFootage: 2400, lotSize: 8400, propertyType: 'Single Family',
      source: 'https://www.zillow.com/x', confidence: 'medium',
    }));
    expect(normal.lotSize).toBe(8400);
    expect(normal._actuals).toBeUndefined();
  });
});

describe('codex r2: story provenance fails closed', () => {
  const facts = (storiesEvidence) => ({
    home: { value: 2400, source: 'county_assessed' },
    lot: { value: 8400, source: 'county_assessed' },
    stories: 2,
    storiesEvidence,
  });
  const intent = { services: { pest: { selected: true } }, is_commercial: false };

  test('missing basis (legacy-format response) is estimated, not lookup', () => {
    const input = buildEngineInput({
      intent,
      propertyFacts: facts({ value: 2, confidence: 'medium', basis: null, sourceUrl: 'https://www.zillow.com/x' }),
      context: {},
    });
    expect(input.storiesSource).toBe('estimated');
  });

  test('direct basis without an attributable source URL is estimated', () => {
    const input = buildEngineInput({
      intent,
      propertyFacts: facts({ value: 2, confidence: 'high', basis: 'direct', sourceUrl: null }),
      context: {},
    });
    expect(input.storiesSource).toBe('estimated');
  });
});

describe('codex r2: V2 unresolved clears the V1 area under the gate', () => {
  test('an ambiguous multi-building scope must not retain V1 sqft', () => {
    const propertyFacts = {
      home: { value: 12000, source: 'county_assessed', rejected: [] },
      lot: { value: 108900, source: 'county_assessed', rejected: [] },
      stories: 1,
    };
    shadow.applyV2ToPropertyFacts(propertyFacts, {
      legacyDerived: { squareFootage: null, lotSize: 108900, stories: null },
      facts: {
        requiresConfirmation: true,
        confidenceLevel: 'low',
        warnings: ['multiple distinct buildings on the parcel — confirm which building(s) the service covers'],
        lot: { applicability: 'private_parcel' },
      },
    });
    expect(propertyFacts.home.value).toBeNull();
    expect(propertyFacts.home.source).toBe('unresolved');
    // The discarded V1 value stays visible in the rejected trail.
    expect(propertyFacts.home.rejected.some((r) => r.value === 12000)).toBe(true);
  });
});

describe('codex r2: apartment customers are residential UNITS', () => {
  test('inferServiceScope treats a non-commercial apartment like a condo', () => {
    expect(shadow._private.inferServiceScope({ propertyType: 'Apartment', isCommercial: false, tenant: false, aggregated: false }))
      .toBe('residential_unit');
  });

  test('complex-wide record sqft never prices the unit; caller-stated does', () => {
    const apartmentRecord = {
      propertyType: 'Apartment',
      squareFootage: 85000,
      stories: 3,
      formattedAddress: '700 Complex Way Unit 12, Bradenton, FL',
      _parcel: { parcelId: '777', county: 'Manatee', lotSqft: 300000, aggregated: false },
      _fieldEvidence: {
        squareFootage: {
          value: 85000,
          sourceType: 'county',
          evidence: [{ value: 85000, sourceType: 'county', provider: 'manatee_pao', url: 'https://www.manateepao.gov/parcel/?parid=777' }],
        },
      },
    };
    const withoutCaller = shadow.computePropertyFactsV2Shadow({
      propertyRecord: apartmentRecord,
      extraction: null,
      intent: { is_commercial: false },
      propertyFacts: { home: { value: 85000 }, lot: { value: 300000 }, stories: 3, tenant: false },
      address: '700 Complex Way Unit 12, Bradenton, FL',
    });
    expect(withoutCaller.facts.serviceScope).toBe('residential_unit');
    expect(withoutCaller.facts.structureArea.value).toBeNull();
    expect(withoutCaller.facts.requiresConfirmation).toBe(true);

    const withCaller = shadow.computePropertyFactsV2Shadow({
      propertyRecord: apartmentRecord,
      extraction: { property: { approximate_living_sqft: 900 } },
      intent: { is_commercial: false },
      propertyFacts: { home: { value: 85000 }, lot: { value: 300000 }, stories: 3, tenant: false },
      address: '700 Complex Way Unit 12, Bradenton, FL',
    });
    expect(withCaller.facts.structureArea.value).toBe(900);
    expect(withCaller.facts.structureArea.kind).toBe('residential_unit_area_sqft');
  });
});

// ── Codex round-3 regressions (reviewed c001ffa668) ──

describe('codex r3: normalized Multifamily apartments are units', () => {
  test('non-commercial Multifamily infers residential_unit scope', () => {
    expect(shadow._private.inferServiceScope({ propertyType: 'Multifamily', isCommercial: false, tenant: false, aggregated: false }))
      .toBe('residential_unit');
    expect(shadow._private.inferServiceScope({ propertyType: 'Multi-Family', isCommercial: false, tenant: false, aggregated: false }))
      .toBe('residential_unit');
  });
});

describe('codex r3: dedup keeps the uncapped actual, not the capped twin', () => {
  test('county evidence upgraded in place — 270k survives selection', () => {
    const cappedRecord = {
      propertyType: 'Warehouse',
      squareFootage: 200000,
      _actuals: { buildingAreaSqft: 270000, pricingAdjustment: 'commercial_area_cap' },
      formattedAddress: '400 Distribution Ct, Punta Gorda, FL',
      _parcel: { parcelId: '888', county: 'Charlotte', lotSqft: 400000, aggregated: false },
      _fieldEvidence: {
        squareFootage: {
          value: 200000,
          sourceType: 'county',
          evidence: [{ value: 200000, sourceType: 'county', provider: 'charlotte_pao', url: 'https://www.ccappraiser.com/Show_Parcel.asp?p=888' }],
        },
      },
    };
    const result = shadow.computePropertyFactsV2Shadow({
      propertyRecord: cappedRecord,
      extraction: null,
      intent: { is_commercial: true },
      propertyFacts: { home: { value: 200000 }, lot: { value: 400000 }, stories: 1, tenant: false },
      address: '400 Distribution Ct, Punta Gorda, FL',
    });
    expect(result.facts.structureArea.value).toBe(270000);
    expect(result.facts.structureArea.pricingDisposition).toBe('relationship_quote');
  });
});

describe('codex r3: dispute flags survive the V2 replacement', () => {
  test('a >35% caller-vs-county conflict stays disputed under the gate', () => {
    const propertyFacts = {
      home: { value: 2400, source: 'county_assessed', disputed: true, rejected: [{ value: 4000, source: 'caller_stated', reason: 'disagrees >35%' }] },
      lot: { value: 8400, source: 'county_assessed', disputed: true, rejected: [] },
      stories: 1,
    };
    shadow.applyV2ToPropertyFacts(propertyFacts, {
      legacyDerived: { squareFootage: 2400, lotSize: 8400, stories: 1 },
      facts: {
        requiresConfirmation: false,
        confidenceLevel: 'high',
        warnings: [],
        lot: { applicability: 'private_parcel' },
      },
    });
    expect(propertyFacts.home.disputed).toBe(true);
    expect(propertyFacts.lot.disputed).toBe(true);
    expect(propertyFacts.home.rejected).toHaveLength(1);
  });
});

// ── Codex round-4 regressions (reviewed 74ec0d66) ──

describe('codex r4: owned multifamily still requires a lot fact', () => {
  test('a triplex/quadplex (normalized Multifamily) without lotSize is INCOMPLETE', () => {
    expect(_private.hasCountyPricingCore({
      squareFootage: 3600, lotSize: null, propertyType: 'Multifamily',
    })).toBe(false);
    expect(_private.hasCountyPricingCore({
      squareFootage: 3600, lotSize: 12000, propertyType: 'Multifamily',
    })).toBe(true);
    // Unit-context types keep the no-lot completeness.
    expect(_private.hasCountyPricingCore({
      squareFootage: 1154, lotSize: null, propertyType: 'Condo',
    })).toBe(true);
  });
});

describe('codex r4: lot evidence source follows its true origin', () => {
  test('an AI/listing lot on a parcel-matched record is NOT labeled county', () => {
    const hybridRecord = {
      propertyType: 'Single Family',
      squareFootage: 2400,
      lotSize: 200000,
      _actuals: { lotSqft: 500000 },
      formattedAddress: '900 Ranch Rd, Myakka City, FL',
      // Parcel matched (id present) but the county roll had NO lot figure.
      _parcel: { parcelId: '999', county: 'Manatee', lotSqft: null, aggregated: false },
      _fieldEvidence: {
        squareFootage: {
          value: 2400,
          sourceType: 'county',
          evidence: [{ value: 2400, sourceType: 'county', provider: 'manatee_pao', url: 'https://www.manateepao.gov/parcel/?parid=999' }],
        },
        lotSize: {
          value: 200000,
          sourceType: 'listing',
          evidence: [{ value: 200000, sourceType: 'listing', provider: 'claude', url: 'https://www.zillow.com/homedetails/900-ranch-rd/9_zpid/' }],
        },
      },
    };
    const result = shadow.computePropertyFactsV2Shadow({
      propertyRecord: hybridRecord,
      extraction: null,
      intent: { is_commercial: false },
      propertyFacts: { home: { value: 2400 }, lot: { value: 200000 }, stories: 1, tenant: false },
      address: '900 Ranch Rd, Myakka City, FL',
    });
    const lotEvidence = result.facts.evidence.find((e) => e.field === 'parcel_area_sqft');
    expect(lotEvidence.sourceType).toBe('listing');
    expect(lotEvidence.value).toBe(500000);
    expect(lotEvidence.extractionConfidence).not.toBe('high');
  });

  test('a genuine county lot keeps its county label', () => {
    const countyRecord = {
      propertyType: 'Single Family',
      squareFootage: 2400,
      lotSize: 8400,
      formattedAddress: '8920 49th Ave E, Bradenton, FL',
      _parcel: { parcelId: '647302459', county: 'Manatee', lotSqft: 8400, aggregated: false },
      _fieldEvidence: {},
    };
    const result = shadow.computePropertyFactsV2Shadow({
      propertyRecord: countyRecord,
      extraction: null,
      intent: { is_commercial: false },
      propertyFacts: { home: { value: 2400 }, lot: { value: 8400 }, stories: 1, tenant: false },
      address: '8920 49th Ave E, Bradenton, FL',
    });
    const lotEvidence = result.facts.evidence.find((e) => e.field === 'parcel_area_sqft');
    expect(lotEvidence.sourceType).toBe('county');
    expect(lotEvidence.value).toBe(8400);
  });
});

// ── Codex round-5 regression (reviewed 86a510f8) ──

describe('codex r5: V2 replacement source follows evidence authority', () => {
  const factsWith = (sourceType) => ({
    requiresConfirmation: false,
    confidenceLevel: 'medium',
    warnings: [],
    structureArea: { value: 2400, selectedEvidenceIds: ['sel-1'] },
    lot: { applicability: 'private_parcel', privateLotSqft: 8400, selectedEvidenceIds: ['sel-2'] },
    evidence: [
      { id: 'sel-1', field: 'residential_living_area_sqft', value: 2400, sourceType },
      { id: 'sel-2', field: 'parcel_area_sqft', value: 8400, sourceType },
    ],
  });
  const apply = (sourceType) => {
    const propertyFacts = {
      home: { value: 2000, source: 'property_lookup_estimate', rejected: [] },
      lot: { value: 8000, source: 'property_lookup_estimate', rejected: [] },
      stories: 1,
    };
    shadow.applyV2ToPropertyFacts(propertyFacts, {
      legacyDerived: { squareFootage: 2400, lotSize: 8400, stories: 1 },
      facts: factsWith(sourceType),
    });
    return propertyFacts;
  };

  test('listing-backed selection keeps the fallback source (yellow rails fire)', () => {
    const result = apply('listing');
    expect(result.home.source).toBe('property_lookup_estimate');
    expect(result.lot.source).toBe('property_lookup_estimate');
  });

  test('county-backed selection earns the measured V2 source', () => {
    const result = apply('county');
    expect(result.home.source).toBe('property_facts_v2');
    expect(result.lot.source).toBe('property_facts_v2');
  });

  test('caller-only selection keeps its V1 caller_stated name', () => {
    expect(apply('caller').home.source).toBe('caller_stated');
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
        storiesEvidence: { value: 2, confidence: 'high', basis: 'direct', sourceType: 'listing', sourceUrl: 'https://www.zillow.com/homedetails/x' },
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
