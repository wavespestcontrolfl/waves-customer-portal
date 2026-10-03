/**
 * resolveBusinessScope truth table + the classification half (address-match
 * PR 5). Pure functions; synthetic identities only.
 */

const {
  SCOPE,
  OCCUPANCY_QUESTION,
  resolveBusinessScope,
  applyBusinessClassification,
  buildBusinessScopeContext,
  businessUnitKey,
  effectiveSuiteUnitKey,
  normalizeOccupancyAnswer,
} = require('../services/property-lookup/business-scope');

const matched = (over = {}) => ({
  source: 'google_places',
  matched: { placeId: 'places/EXAMPLE1', name: 'Example Nail Bar', primaryType: 'nail_salon', type: 'salon_spa', subpremise: null },
  matchedCount: 1, ambiguous: false, tenantsAtNumber: 1, neighbors: 0,
  ...over,
});

describe('resolveBusinessScope truth table', () => {
  test('no identity, no business, or an unmatched single place → null (no change)', () => {
    expect(resolveBusinessScope({})).toBeNull();
    expect(resolveBusinessScope({ identity: null })).toBeNull();
    expect(resolveBusinessScope({ identity: { matched: null, tenantsAtNumber: 0, neighbors: 4 } })).toBeNull();
    expect(resolveBusinessScope({ identity: { matched: null, tenantsAtNumber: 1, neighbors: 4 } })).toBeNull();
  });

  test('association jobs and own-unit folios are never decided here', () => {
    expect(resolveBusinessScope({ identity: matched(), association: true, typedSubpremise: true })).toBeNull();
    expect(resolveBusinessScope({ identity: matched(), ownUnitFolio: true, typedSubpremise: true })).toBeNull();
    expect(resolveBusinessScope({ identity: matched(), association: true, occupancyAnswer: 'suite' })).toBeNull();
  });

  test.each([
    ['a typed subpremise', { typedSubpremise: true }, {}],
    ['the matched place\'s own subpremise', {}, { matched: { ...matched().matched, subpremise: '103' } }],
    ['two or more tenants at the number', {}, { tenantsAtNumber: 2 }],
    ['county part-building evidence', { countyPartBuildingEvidence: true }, {}],
    ['the CSR answering "suite"', { occupancyAnswer: 'suite' }, {}],
  ])('matched business + %s → commercial_suite', (_label, signals, identityOver) => {
    expect(resolveBusinessScope({ identity: matched(identityOver), ...signals }))
      .toEqual({ decision: SCOPE.SUITE, question: null });
  });

  test('a multi-tenant address with no single match still reads as a suite (tenants at the number)', () => {
    const ambiguous = { matched: null, matchedCount: 3, ambiguous: true, tenantsAtNumber: 3, neighbors: 0 };
    expect(resolveBusinessScope({ identity: ambiguous })).toEqual({ decision: SCOPE.SUITE, question: null });
  });

  test('the CSR answering "building" → entire_commercial_building, even over every derived suite signal', () => {
    expect(resolveBusinessScope({ identity: matched(), occupancyAnswer: 'building' }))
      .toEqual({ decision: SCOPE.BUILDING, question: null });
    expect(resolveBusinessScope({
      identity: matched({ tenantsAtNumber: 4 }), typedSubpremise: true, countyPartBuildingEvidence: true, occupancyAnswer: 'building',
    })).toEqual({ decision: SCOPE.BUILDING, question: null });
  });

  test('a county record with no part-building evidence and no neighbors → entire_commercial_building', () => {
    expect(resolveBusinessScope({ identity: matched({ neighbors: 0 }), countyRecordPresent: true }))
      .toEqual({ decision: SCOPE.BUILDING, question: null });
  });

  test('NEIGHBORS ALONE NEVER DECIDE A SUITE: a county record with neighbors and no evidence is unresolved, not a suite', () => {
    const verdict = resolveBusinessScope({ identity: matched({ neighbors: 7 }), countyRecordPresent: true });
    expect(verdict.decision).toBe(SCOPE.UNRESOLVED);
    expect(verdict.decision).not.toBe(SCOPE.SUITE);
  });

  test('the trigger case: own street number, no subpremise, no county record → scope_unresolved with the question', () => {
    expect(resolveBusinessScope({ identity: matched({ neighbors: 5 }) }))
      .toEqual({ decision: SCOPE.UNRESOLVED, question: 'Are we treating just your space or the whole building?' });
    expect(OCCUPANCY_QUESTION).toBe('Are we treating just your space or the whole building?');
  });

  test('county part-building evidence outranks the stand-alone-building rule', () => {
    expect(resolveBusinessScope({
      identity: matched({ neighbors: 0 }), countyRecordPresent: true, countyPartBuildingEvidence: true,
    }).decision).toBe(SCOPE.SUITE);
  });

  test('an unrecognized occupancy answer is ignored', () => {
    expect(resolveBusinessScope({ identity: matched(), occupancyAnswer: 'maybe' }).decision).toBe(SCOPE.UNRESOLVED);
    expect(normalizeOccupancyAnswer(' Suite ')).toBe('suite');
    expect(normalizeOccupancyAnswer('BUILDING')).toBe('building');
    expect(normalizeOccupancyAnswer('x')).toBeNull();
    expect(normalizeOccupancyAnswer(null)).toBeNull();
  });
});

describe('applyBusinessClassification', () => {
  test('a matched business types a non-commercial lookup COMMERCIAL with its table subtype', () => {
    expect(applyBusinessClassification({ identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null }))
      .toEqual({ category: 'COMMERCIAL', subtype: 'salon_spa', flipped: true, refined: false });
  });

  test('a residential record type blocks the flip (a house with a pinned home business is still a house)', () => {
    expect(applyBusinessClassification({
      identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, recordPricingType: 'single_family',
    })).toMatchObject({ category: 'RESIDENTIAL', flipped: false });
    expect(applyBusinessClassification({
      identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, recordPricingType: 'unknown',
    })).toMatchObject({ category: 'COMMERCIAL', flipped: true });
  });

  test('an already-commercial lookup keeps its category; only a generic subtype is refined', () => {
    expect(applyBusinessClassification({ identity: matched(), baseCategory: 'COMMERCIAL', baseSubtype: 'office_retail' }))
      .toEqual({ category: 'COMMERCIAL', subtype: 'salon_spa', flipped: false, refined: true });
    expect(applyBusinessClassification({ identity: matched(), baseCategory: 'COMMERCIAL', baseSubtype: 'warehouse_light' }))
      .toMatchObject({ subtype: 'warehouse_light', refined: false });
    expect(applyBusinessClassification({ identity: matched({ matched: { ...matched().matched, type: 'office_retail' } }), baseCategory: 'COMMERCIAL', baseSubtype: 'other' }))
      .toMatchObject({ subtype: 'other', refined: false });
  });

  test('no business → no change', () => {
    expect(applyBusinessClassification({ identity: null, baseCategory: 'RESIDENTIAL', baseSubtype: null }))
      .toEqual({ category: 'RESIDENTIAL', subtype: null, flipped: false, refined: false });
  });
});

describe('buildBusinessScopeContext', () => {
  test('inert with no identity: base verdicts, no flags, no profile fields', () => {
    const ctx = buildBusinessScopeContext({ identity: null, baseCategory: 'COMMERCIAL', baseSubtype: 'office_retail' });
    expect(ctx).toMatchObject({ active: false, category: 'COMMERCIAL', subtype: 'office_retail', decision: null, unitKey: null, flags: [], profileFields: {} });
    expect(ctx.source('property_record_property_type')).toBe('property_record_property_type');
  });

  test('flipped lookup: google_places_business source, MEDIUM flag without the business name, admin fields', () => {
    const ctx = buildBusinessScopeContext({
      identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, scopeSignals: {},
    });
    expect(ctx.source('commercial_signal')).toBe('google_places_business');
    expect(ctx.decision).toBe(SCOPE.UNRESOLVED);
    const reasons = ctx.flags.map((f) => f.reason).join(' | ');
    expect(reasons).not.toMatch(/Example Nail Bar/);
    const classify = ctx.flags.find((f) => f.field === 'propertyType');
    expect(classify).toEqual({
      field: 'propertyType', reason: 'Commercial: Google lists a salon or spa at this address — confirm', priority: 'MEDIUM',
    });
    const ask = ctx.flags.find((f) => f.priority === 'HIGH');
    expect(ask.reason).toContain('Are we treating just your space or the whole building?');
    expect(ctx.profileFields).toEqual({
      serviceScopeDecision: SCOPE.UNRESOLVED,
      serviceScopeQuestion: OCCUPANCY_QUESTION,
      businessIdentity: {
        name: 'Example Nail Bar', type: 'salon_spa', matchedBy: 'street_number', tenantsAtNumber: 1, unitKey: 'business:places/EXAMPLE1',
      },
    });
  });

  test('a suite decision flags the type-based size as confirm-on-site and keys the unit on the place', () => {
    const ctx = buildBusinessScopeContext({
      identity: matched(), baseCategory: 'COMMERCIAL', baseSubtype: 'office_retail', occupancyAnswer: 'suite',
    });
    expect(ctx.decision).toBe(SCOPE.SUITE);
    expect(ctx.subtype).toBe('salon_spa');
    expect(ctx.flags).toEqual([expect.objectContaining({ field: 'squareFootage', priority: 'MEDIUM' })]);
    expect(ctx.unitKey).toBe('business:places/EXAMPLE1');
  });

  test('a flip blocked by a residential record leaves the lookup residential with no scope decision', () => {
    const ctx = buildBusinessScopeContext({
      identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, recordPricingType: 'single_family',
    });
    expect(ctx.category).toBe('RESIDENTIAL');
    expect(ctx.decision).toBeNull();
    expect(ctx.flags).toEqual([]);
  });
});

describe('unit keys', () => {
  test('matched place → stable key from its id; multi-tenant → key from the tenant set; none → null', () => {
    expect(businessUnitKey(matched())).toBe('business:places/EXAMPLE1');
    expect(businessUnitKey({ matched: null, tenantPlaceKey: 'places/A|places/B' })).toBe('business:tenants:places/A|places/B');
    expect(businessUnitKey({ matched: null })).toBeNull();
  });

  test('a typed unit wins; a business suite keys on the place; a building decision keys on nothing', () => {
    expect(effectiveSuiteUnitKey('102', { decision: SCOPE.SUITE, unitKey: 'business:x' })).toBe('102');
    expect(effectiveSuiteUnitKey(null, { decision: SCOPE.SUITE, unitKey: 'business:x' })).toBe('business:x');
    expect(effectiveSuiteUnitKey(null, { decision: SCOPE.BUILDING, unitKey: 'business:x' })).toBeNull();
    expect(effectiveSuiteUnitKey(null, null)).toBeNull();
  });
});
