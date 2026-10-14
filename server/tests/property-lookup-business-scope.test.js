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

const ASK = (suggestion) => ({ decision: SCOPE.UNRESOLVED, question: OCCUPANCY_QUESTION, suggestion });

describe('resolveBusinessScope: Places suggests, staff decide', () => {
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
  ])('with no staff answer, %s only SUGGESTS a suite: the scope stays the open question', (_label, signals, identityOver) => {
    expect(resolveBusinessScope({ identity: matched(identityOver), ...signals })).toEqual(ASK('suite'));
  });

  test('a multi-tenant address with no single match suggests a suite and still asks', () => {
    const ambiguous = { matched: null, matchedCount: 3, ambiguous: true, tenantsAtNumber: 3, neighbors: 0 };
    expect(resolveBusinessScope({ identity: ambiguous })).toEqual(ASK('suite'));
  });

  test('a county record with no part-building evidence and no neighbors suggests the building and still asks', () => {
    expect(resolveBusinessScope({ identity: matched({ neighbors: 0 }), countyRecordPresent: true })).toEqual(ASK('building'));
  });

  test('NEIGHBORS ALONE NEVER SUGGEST A SUITE: a county record with neighbors and no evidence suggests nothing', () => {
    expect(resolveBusinessScope({ identity: matched({ neighbors: 7 }), countyRecordPresent: true })).toEqual(ASK(null));
  });

  test('the trigger case: own street number, no subpremise, no county record → the question, no suggestion', () => {
    expect(resolveBusinessScope({ identity: matched({ neighbors: 5 }) })).toEqual(ASK(null));
    expect(OCCUPANCY_QUESTION).toBe('Are we treating just your space or the whole building?');
  });

  test('county part-building evidence outranks the stand-alone-building suggestion', () => {
    expect(resolveBusinessScope({
      identity: matched({ neighbors: 0 }), countyRecordPresent: true, countyPartBuildingEvidence: true,
    })).toEqual(ASK('suite'));
  });

  test('staff answering decides, over every signal', () => {
    const everySuiteSignal = { identity: matched({ tenantsAtNumber: 4 }), typedSubpremise: true, countyPartBuildingEvidence: true };
    expect(resolveBusinessScope({ identity: matched(), occupancyAnswer: 'suite' }))
      .toEqual({ decision: SCOPE.SUITE, question: null, suggestion: null });
    expect(resolveBusinessScope({ ...everySuiteSignal, occupancyAnswer: 'building' }))
      .toEqual({ decision: SCOPE.BUILDING, question: null, suggestion: null });
    expect(resolveBusinessScope({ identity: matched({ neighbors: 0 }), countyRecordPresent: true, occupancyAnswer: 'suite' }).decision)
      .toBe(SCOPE.SUITE);
  });

  test('staff answering "none" (not this business) closes the question with no decision', () => {
    expect(resolveBusinessScope({ identity: matched(), typedSubpremise: true, occupancyAnswer: 'none' }))
      .toEqual({ decision: null, question: null, suggestion: null });
  });

  test('an unrecognized occupancy answer is ignored', () => {
    expect(resolveBusinessScope({ identity: matched(), occupancyAnswer: 'maybe' }).decision).toBe(SCOPE.UNRESOLVED);
    expect(normalizeOccupancyAnswer(' Suite ')).toBe('suite');
    expect(normalizeOccupancyAnswer('BUILDING')).toBe('building');
    expect(normalizeOccupancyAnswer('None')).toBe('none');
    expect(normalizeOccupancyAnswer('x')).toBeNull();
    expect(normalizeOccupancyAnswer(null)).toBeNull();
  });
});

describe('applyBusinessClassification', () => {
  const confirmed = true;

  test('WITHOUT staff confirmation a listed business changes nothing', () => {
    expect(applyBusinessClassification({ identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null }))
      .toEqual({ category: 'RESIDENTIAL', subtype: null, flipped: false, refined: false });
    expect(applyBusinessClassification({ identity: matched(), baseCategory: 'COMMERCIAL', baseSubtype: 'office_retail' }))
      .toEqual({ category: 'COMMERCIAL', subtype: 'office_retail', flipped: false, refined: false });
  });

  test('confirmed: a non-commercial lookup becomes COMMERCIAL with the business\'s table subtype', () => {
    expect(applyBusinessClassification({ identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, confirmed }))
      .toEqual({ category: 'COMMERCIAL', subtype: 'salon_spa', flipped: true, refined: false });
  });

  test('a residential record type blocks the flip even when confirmed (a house with a pinned home business is still a house)', () => {
    expect(applyBusinessClassification({
      identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, recordPricingType: 'single_family', confirmed,
    })).toMatchObject({ category: 'RESIDENTIAL', flipped: false });
    expect(applyBusinessClassification({
      identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, recordPricingType: 'unknown', confirmed,
    })).toMatchObject({ category: 'COMMERCIAL', flipped: true });
  });

  test('every residential whole structure the lookup recognizes blocks the flip, whatever the pricing normalizer calls it', () => {
    for (const recordPricingType of ['mobile_home', 'manufactured_home', 'villa', 'triplex', 'quadplex', 'townhouse', 'Mobile Home']) {
      expect(applyBusinessClassification({
        identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, recordPricingType, confirmed,
      })).toMatchObject({ category: 'RESIDENTIAL', flipped: false });
    }
  });

  test('confirmed: an already-commercial lookup keeps its category; only a generic subtype is refined', () => {
    expect(applyBusinessClassification({ identity: matched(), baseCategory: 'COMMERCIAL', baseSubtype: 'office_retail', confirmed }))
      .toEqual({ category: 'COMMERCIAL', subtype: 'salon_spa', flipped: false, refined: true });
    expect(applyBusinessClassification({ identity: matched(), baseCategory: 'COMMERCIAL', baseSubtype: 'warehouse_light', confirmed }))
      .toMatchObject({ subtype: 'warehouse_light', refined: false });
    expect(applyBusinessClassification({
      identity: matched({ matched: { ...matched().matched, type: 'office_retail' } }), baseCategory: 'COMMERCIAL', baseSubtype: 'other', confirmed,
    })).toMatchObject({ subtype: 'other', refined: false });
  });

  test('no business → no change', () => {
    expect(applyBusinessClassification({ identity: null, baseCategory: 'RESIDENTIAL', baseSubtype: null, confirmed }))
      .toEqual({ category: 'RESIDENTIAL', subtype: null, flipped: false, refined: false });
  });
});

describe('buildBusinessScopeContext', () => {
  test('inert with no identity: base verdicts, no flags, no profile fields', () => {
    const ctx = buildBusinessScopeContext({ identity: null, baseCategory: 'COMMERCIAL', baseSubtype: 'office_retail' });
    expect(ctx).toMatchObject({ active: false, category: 'COMMERCIAL', subtype: 'office_retail', decision: null, unitKey: null, flags: [], profileFields: {} });
    expect(ctx.source('property_record_property_type')).toBe('property_record_property_type');
  });

  test('unanswered: the base classification stands, the question is open, and the listing rides only as a suggestion', () => {
    const ctx = buildBusinessScopeContext({
      identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, scopeSignals: { typedSubpremise: true },
    });
    expect(ctx).toMatchObject({ active: true, category: 'RESIDENTIAL', subtype: null, flipped: false, decision: SCOPE.UNRESOLVED });
    expect(ctx.source('commercial_signal')).toBe('commercial_signal');
    // One flag: the question, marked as resting on the listing so storage drops it. No name, no type.
    expect(ctx.flags).toEqual([expect.objectContaining({ field: 'squareFootage', priority: 'HIGH', source: 'google_places' })]);
    expect(ctx.flags[0].reason).toContain(OCCUPANCY_QUESTION);
    expect(ctx.flags[0].reason).not.toMatch(/Example Nail Bar|salon/i);
    expect(ctx.profileFields).toEqual({
      serviceScopeDecision: SCOPE.UNRESOLVED,
      serviceScopeQuestion: OCCUPANCY_QUESTION,
      serviceScopeSuggestion: 'suite',
      occupancyAnswer: null,
      businessIdentity: {
        name: 'Example Nail Bar', type: 'salon_spa', matchedBy: 'subpremise', tenantsAtNumber: 1, unitKey: 'business:places/EXAMPLE1',
      },
    });
  });

  test('staff answer "suite": commercial with the business type, source staff_confirmed_business, confirm-on-site flag, unit keyed on the place', () => {
    const ctx = buildBusinessScopeContext({
      identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, occupancyAnswer: 'suite',
    });
    expect(ctx).toMatchObject({ category: 'COMMERCIAL', subtype: 'salon_spa', flipped: true, decision: SCOPE.SUITE, question: null });
    expect(ctx.source('commercial_signal')).toBe('staff_confirmed_business');
    expect(ctx.flags).toEqual([expect.objectContaining({ field: 'squareFootage', priority: 'MEDIUM' })]);
    expect(ctx.flags[0]).not.toHaveProperty('source');
    expect(ctx.unitKey).toBe('business:places/EXAMPLE1');
    expect(ctx.profileFields).toMatchObject({ serviceScopeDecision: SCOPE.SUITE, serviceScopeSuggestion: null, occupancyAnswer: 'suite' });
  });

  test('staff answer "building" on a commercial record refines a generic subtype and keeps the record\'s source', () => {
    const ctx = buildBusinessScopeContext({
      identity: matched(), baseCategory: 'COMMERCIAL', baseSubtype: 'office_retail', occupancyAnswer: 'building',
    });
    expect(ctx).toMatchObject({ category: 'COMMERCIAL', subtype: 'salon_spa', flipped: false, decision: SCOPE.BUILDING });
    expect(ctx.source('property_record_property_type')).toBe('property_record_property_type');
    expect(ctx.flags).toEqual([]);
  });

  test('staff answer "none": the base classification stands, nothing is asked, and the answer is on the profile', () => {
    const ctx = buildBusinessScopeContext({
      identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, occupancyAnswer: 'none',
    });
    expect(ctx).toMatchObject({ active: true, category: 'RESIDENTIAL', subtype: null, flipped: false, decision: null, question: null, flags: [] });
    expect(ctx.profileFields).toMatchObject({ serviceScopeDecision: null, serviceScopeQuestion: null, occupancyAnswer: 'none' });
    expect(ctx.profileFields.businessIdentity).toMatchObject({ name: 'Example Nail Bar' });
  });

  test('a record that says "residence" is never asked about: no question, no fields, whatever is answered', () => {
    for (const occupancyAnswer of [null, 'suite']) {
      const ctx = buildBusinessScopeContext({
        identity: matched(), baseCategory: 'RESIDENTIAL', baseSubtype: null, recordPricingType: 'single_family', occupancyAnswer,
      });
      expect(ctx).toMatchObject({ active: false, category: 'RESIDENTIAL', decision: null, flags: [], profileFields: {} });
    }
  });

  test('an answered re-run that could not confirm the business keeps the question open with no listing', () => {
    const { UNAVAILABLE_IDENTITY } = require('../services/property-lookup/business-scope');
    const ctx = buildBusinessScopeContext({
      identity: UNAVAILABLE_IDENTITY, baseCategory: 'RESIDENTIAL', baseSubtype: null, occupancyAnswer: 'suite',
    });
    expect(ctx).toMatchObject({ category: 'RESIDENTIAL', decision: SCOPE.UNRESOLVED, question: OCCUPANCY_QUESTION });
    expect(ctx.profileFields).toEqual({
      serviceScopeDecision: SCOPE.UNRESOLVED, serviceScopeQuestion: OCCUPANCY_QUESTION, serviceScopeSuggestion: null, occupancyAnswer: null,
    });
    expect(ctx.flags).toEqual([expect.objectContaining({ priority: 'HIGH', source: 'google_places' })]);
  });
});

describe('unresolvedScopeError', () => {
  const { unresolvedScopeError, assertScopeAnswered } = require('../services/property-lookup/business-scope');
  test('only an unanswered scope_unresolved profile is refused; the error is a fail-closed 409 with the question', () => {
    const err = unresolvedScopeError({ serviceScopeDecision: 'scope_unresolved', serviceScopeQuestion: OCCUPANCY_QUESTION });
    expect(err).toMatchObject({ statusCode: 409, code: 'COMMERCIAL_SCOPE_UNRESOLVED', failClosed: true, metadata: { question: OCCUPANCY_QUESTION } });
    expect(() => assertScopeAnswered({ serviceScopeDecision: 'scope_unresolved' })).toThrow(/whole building/);
    for (const profile of [null, {}, { serviceScopeDecision: 'commercial_suite' }, { serviceScopeDecision: null, occupancyAnswer: 'none' }, { serviceScopeDecision: 'scope_unresolved', occupancyAnswer: 'building' }]) {
      expect(unresolvedScopeError(profile)).toBeNull();
      expect(() => assertScopeAnswered(profile)).not.toThrow();
    }
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
