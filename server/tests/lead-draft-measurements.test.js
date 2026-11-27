/**
 * Real home and lot size for website lead drafts (owner 2026-10-24, option A
 * of the lead draft page; GATE_LEAD_DRAFT_PROPERTY_LOOKUP). The website forms
 * carry no size, so a lead draft priced on 2,000 / 8,000 sq ft defaults. These
 * cover which county figures count, the free cache read the builder makes, and
 * what a county-sized draft carries. The background re-price against a real
 * estimates row is lead-draft-measurements-db.test.js.
 */
jest.mock('../routes/property-lookup-v2', () => ({ performPropertyLookup: jest.fn() }));

const { performPropertyLookup } = require('../routes/property-lookup-v2');
const {
  cachedLeadMeasurements,
  _private: { countyMeasurements, wholeHomeAddress, untouchedDefaultedDraft },
} = require('../services/lead-draft-measurements');
const {
  buildAutomatedLeadDraftEstimate,
  evaluateLeadEstimateAutomationReadiness,
} = require('../services/lead-estimate-automation');

const ADDRESS = '4521 Synthetic Palm Dr, Venice, FL 34285';

// A county-matched single-family record (synthetic; the shape the lookup
// cache stores: parcel-backed, county field evidence for the living area).
function countyRecord(over = {}) {
  return {
    propertyType: 'Single Family',
    squareFootage: 1850,
    yearBuilt: 1998,
    _source: 'county',
    _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 9200, landUseDescription: 'SINGLE FAMILY DETACHED' },
    _fieldEvidence: { squareFootage: { sourceType: 'county' } },
    ...over,
  };
}
const lookupOf = (record, enriched = {}) => ({ propertyRecord: record, enriched });

function readyLead({ customer = {}, body = {} } = {}) {
  const intake = {
    serviceInterest: 'Quarterly Pest Control',
    email: 'lead@example.com',
    fullAddress: ADDRESS,
    normalizedAddress: { line1: '4521 Synthetic Palm Dr', city: 'Venice', state: 'FL', zip: '34285', fullAddress: ADDRESS },
  };
  const readiness = evaluateLeadEstimateAutomationReadiness({ intake, customer, body, phone: '+19415550142' });
  return { intake, customer, body, readiness };
}

afterEach(() => {
  delete process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP;
  performPropertyLookup.mockReset();
});

describe('county sizes a lead draft may use', () => {
  test('a county-assessed single-family home and lot count, carrying county-verified propertyType', () => {
    expect(countyMeasurements(lookupOf(countyRecord()))).toEqual({ homeSqFt: 1850, lotSqFt: 9200, propertyType: 'Single Family', source: 'county_assessed' });
  });

  test('P1-7: satellite/AI/listing/flagged propertyType is never carried to resolve property_type_unresolved', () => {
    const baseExpected = { homeSqFt: 1850, lotSqFt: 9200, source: 'county_assessed' };
    // Satellite override on a county record: sizes still stand, propertyType omitted.
    expect(countyMeasurements(lookupOf(countyRecord({ _propertyTypeSource: 'satellite' })))).toEqual(baseExpected);
    expect(countyMeasurements(lookupOf(countyRecord({ _fieldEvidence: { squareFootage: { sourceType: 'county' }, propertyType: { sourceType: 'satellite' } } })))).toEqual(baseExpected);
    expect(countyMeasurements(lookupOf(countyRecord({ _fieldEvidence: { squareFootage: { sourceType: 'county' }, propertyType: { sourceType: 'listing' } } })))).toEqual(baseExpected);
    expect(countyMeasurements(lookupOf(countyRecord({ _fieldEvidence: { squareFootage: { sourceType: 'county' }, propertyType: { sourceType: 'county', fieldVerify: true } } })))).toEqual(baseExpected);
    expect(countyMeasurements(lookupOf(countyRecord(), { fieldVerifyFlags: [{ field: 'propertyType', priority: 'HIGH' }] }))).toEqual(baseExpected);
    // Explicit county field evidence without fieldVerify carries propertyType.
    expect(countyMeasurements(lookupOf(countyRecord({ _fieldEvidence: { squareFootage: { sourceType: 'county' }, propertyType: { sourceType: 'county', fieldVerify: false } } }))))
      .toEqual({ ...baseExpected, propertyType: 'Single Family' });
  });

  test.each([
    ['the lookup landed on a different premise', lookupOf(countyRecord(), { fieldVerifyFlags: [{ field: 'address' }] })],
    ['the house number snapped to another parcel', lookupOf(countyRecord({ _addressAudit: { snappedRecord: { typed: '4521' } } }))],
    ['the living area came from AI or a listing', lookupOf(countyRecord({ _fieldEvidence: { squareFootage: { sourceType: 'ai' } } }))],
    ['a condo', lookupOf(countyRecord({ propertyType: 'Condo' }))],
    ['a townhome', lookupOf(countyRecord({ propertyType: 'Townhome' }))],
    ['an interior townhome', lookupOf(countyRecord({ propertyType: 'Interior Townhome' }))],
    // The pricing normalizer reads any label with "family" as single_family;
    // the county mapper's 'Multifamily' is a triplex or an apartment building.
    ['a multifamily building', lookupOf(countyRecord({ propertyType: 'Multifamily' }))],
    ['a duplex', lookupOf(countyRecord({ propertyType: 'Duplex' }))],
    ['a mobile home', lookupOf(countyRecord({ propertyType: 'Mobile Home' }))],
    ['no property type', lookupOf(countyRecord({ propertyType: null }))],
    ['an unassessed vacant parcel', lookupOf(countyRecord({ squareFootage: null, yearBuilt: null, _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 9200, landUseDescription: 'VACANT RESIDENTIAL' } }))],
    ['a home over 10,000 sq ft', lookupOf(countyRecord({ squareFootage: 12000 }))],
    ['a lot over 10 acres', lookupOf(countyRecord({ _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 600000 } }))],
    ['no lookup', null],
  ])('%s does not', (_label, lookup) => {
    expect(countyMeasurements(lookup)).toBeNull();
  });

  test('the county record\'s own story count rides with its home size; an estimated count does not', () => {
    // The record search's count with its own field evidence is a looked-up fact (the estimator's grader, storiesSourceForPricing).
    const bigHome = (over = {}) => countyRecord({ squareFootage: 8000, stories: 2, ...over, _fieldEvidence: { squareFootage: { sourceType: 'county' }, ...over._fieldEvidence } });
    const countyStories = { stories: { sourceType: 'county', fieldVerify: false } };
    const sizesOnly = { homeSqFt: 8000, lotSqFt: 9200, propertyType: 'Single Family', source: 'county_assessed' };
    expect(countyMeasurements(lookupOf(bigHome({ _fieldEvidence: countyStories }))))
      .toEqual({ ...sizesOnly, stories: 2 });
    expect(countyMeasurements(lookupOf(bigHome({ _fieldEvidence: { stories: [{ sourceType: 'listing' }] } })))).toEqual({ ...sizesOnly, stories: 2 });
    // A count that names no evidence, an unknown source, or a count the lookup marked for a check is left out; the sizes stand.
    for (const evidence of [undefined, { stories: { sourceType: 'unknown' } }, { stories: { sourceType: 'model_inference' } },
      { stories: { sourceType: 'county', fieldVerify: true } }, { stories: [] }, { stories: null }]) {
      expect(countyMeasurements(lookupOf(bigHome({ _fieldEvidence: evidence })))).toEqual(sizesOnly);
    }
    // The lookup's own verify flag on the count does the same (an 8,000 sq ft home is $122 on two floors and $148 on one).
    expect(countyMeasurements(lookupOf(bigHome({ _fieldEvidence: countyStories }), { fieldVerifyFlags: [{ field: 'stories', priority: 'HIGH' }] })))
      .toEqual(sizesOnly);
    expect(countyMeasurements(lookupOf(bigHome({ _fieldEvidence: countyStories }), { fieldVerifyFlags: [{ field: 'lotSize', priority: 'LOW' }] })))
      .toEqual({ ...sizesOnly, stories: 2 });
    // The AI fallback's estimate (an inference, low confidence, or no source page) is not carried.
    for (const evidence of [
      { basis: 'inferred', confidence: 'high', sourceUrl: 'https://example.com/listing', sourceType: 'listing' },
      { basis: 'direct', confidence: 'low', sourceUrl: 'https://example.com/listing', sourceType: 'listing' },
      { basis: 'direct', confidence: 'high', sourceUrl: 'the county site', sourceType: 'county' },
    ]) {
      expect(countyMeasurements(lookupOf(countyRecord({ squareFootage: 8000, stories: 2, _storiesEvidence: evidence }))))
        .toEqual({ homeSqFt: 8000, lotSqFt: 9200, propertyType: 'Single Family', source: 'county_assessed' });
    }
    // A direct, attributable answer is.
    expect(countyMeasurements(lookupOf(countyRecord({
      squareFootage: 8000, stories: 2, _storiesEvidence: { basis: 'direct', confidence: 'high', sourceUrl: 'https://example.com/parcel', sourceType: 'county' },
    })))).toMatchObject({ stories: 2 });
    // A count outside 1 to 3 is no count (a 12-story "home" is another building's record); a split level is kept. The record's
    // raw value is read: [2] and true are not counts, though Number() turns them into 2 and 1.
    for (const stories of [12, 4, 0.5, [2], true, '2 stories', {}]) {
      expect(countyMeasurements(lookupOf(bigHome({ stories, _fieldEvidence: countyStories })))).toEqual(sizesOnly);
    }
    expect(countyMeasurements(lookupOf(bigHome({ stories: 1.5, _fieldEvidence: countyStories })))).toMatchObject({ stories: 1.5 });
    expect(countyMeasurements(lookupOf(bigHome({ stories: '2', _fieldEvidence: countyStories })))).toMatchObject({ stories: 2 });
  });

  test('a technician\'s verified count stands over the AI fallback\'s older estimate left on the record', () => {
    const { applyVerifiedOverrides } = require('../services/property-lookup/lookup-cache');
    // The cached record after an AI fallback inferred one floor; a technician then verified two. The override writes the count and its
    // own field evidence, and the lookup restamps the source (property-lookup-v2 buildResultFromCachedLookup). The fallback's evidence stays.
    const verifiedRecord = (count = 2) => {
      const record = applyVerifiedOverrides(countyRecord({
        squareFootage: 8000, stories: 1, _storiesSource: 'ai',
        _storiesEvidence: { basis: 'inferred', confidence: 'medium', sourceUrl: 'https://example.com/listing', sourceType: 'listing' },
      }), { stories: { value: count } });
      record._storiesSource = 'verified';
      return record;
    };
    const sizesOnly = { homeSqFt: 8000, lotSqFt: 9200, propertyType: 'Single Family', source: 'county_assessed' };
    expect(verifiedRecord()._storiesEvidence).toBeTruthy();
    expect(countyMeasurements(lookupOf(verifiedRecord()))).toEqual({ ...sizesOnly, stories: 2 });
    // The range and the lookup's own verify flag still apply to a verified count.
    expect(countyMeasurements(lookupOf(verifiedRecord(12)))).toEqual(sizesOnly);
    expect(countyMeasurements(lookupOf(verifiedRecord(), { fieldVerifyFlags: [{ field: 'stories', priority: 'HIGH' }] }))).toEqual(sizesOnly);
    // The same record without the verified stamp is still the fallback's estimate: left out.
    const unstamped = verifiedRecord();
    unstamped._storiesSource = 'ai';
    expect(countyMeasurements(lookupOf(unstamped))).toEqual(sizesOnly);
  });

  test('only an address with no unit, in any position, describes one house', () => {
    expect(wholeHomeAddress(ADDRESS)).toBe(true);
    for (const unit of [
      '4521 Synthetic Palm Dr Apt 4, Venice, FL 34285',
      '4521 Synthetic Palm Dr, Unit B, Venice, FL 34285',
      'Apt 4, 4521 Synthetic Palm Dr, Venice, FL',
      '4521 Synthetic Palm Dr #4, Venice, FL',
      '900 Synthetic Bay Ter Bldg 9, Sarasota, FL',
    ]) expect(wholeHomeAddress(unit)).toBe(false);
    expect(wholeHomeAddress('Synthetic Palm Dr, Venice, FL')).toBe(false);
    expect(wholeHomeAddress(null)).toBe(false);
  });
});

describe('the draft builder\'s cache read', () => {
  test('gate off: no lookup is read and the draft prices on the defaults, as before', async () => {
    const lead = readyLead();
    const draft = await buildAutomatedLeadDraftEstimate(lead);
    expect(performPropertyLookup).not.toHaveBeenCalled();
    expect(draft.automation.sizeSource).toBe('default');
    expect(draft.automation.engineInput).toMatchObject({ homeSqFt: 2000, lotSqFt: 8000, lotSizeMeasured: false });
    expect(draft.automation.review).toContain('property_measurements_defaulted');
    expect(draft.estimateData.automation.leadEstimateAutomation.review).toContain('property_measurements_defaulted');
  });

  test('gate on: a cached county record prices the draft on the real size, read cache-only', async () => {
    process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP = 'true';
    performPropertyLookup.mockResolvedValue(lookupOf(countyRecord()));
    const lead = readyLead();
    const draft = await buildAutomatedLeadDraftEstimate(lead);

    expect(performPropertyLookup).toHaveBeenCalledTimes(1);
    expect(performPropertyLookup).toHaveBeenCalledWith(ADDRESS, { cacheOnly: true, persist: false });
    expect(draft.automation.sizeSource).toBe('county_assessed');
    expect(draft.automation.measurements).toEqual({
      source: 'county_assessed',
      homeSqFt: 1850,
      lotSqFt: 9200,
      propertyType: 'Single Family',
    });
    expect(draft.automation.engineInput).toMatchObject({ homeSqFt: 1850, lotSqFt: 9200, lotSizeMeasured: true, treeShrubFootprintTrusted: false });
    // The "default size" reason is gone from both records; the county one
    // takes its place, so auto-send still parks the draft for a person.
    const gate = draft.estimateData.automation.leadEstimateAutomation;
    for (const review of [draft.automation.review, gate.review]) {
      expect(review).toContain('property_measurements_from_county');
      expect(review).not.toContain('property_measurements_defaulted');
    }
    expect(gate.confidence).toBe(lead.readiness.confidence);
    expect(lead.readiness.review).toContain('property_measurements_defaulted'); // the caller's object is not rewritten
  });

  test('gate on: a cache miss, a unit address or a lookup error keeps the defaults', async () => {
    process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP = 'true';
    performPropertyLookup.mockResolvedValueOnce(null);
    expect((await buildAutomatedLeadDraftEstimate(readyLead())).automation.sizeSource).toBe('default');

    performPropertyLookup.mockRejectedValueOnce(Object.assign(new Error('pool exhausted'), { code: 'POOL' }));
    expect((await buildAutomatedLeadDraftEstimate(readyLead())).automation.sizeSource).toBe('default');

    performPropertyLookup.mockClear();
    const unitLead = readyLead();
    unitLead.intake = { ...unitLead.intake, fullAddress: '4521 Synthetic Palm Dr Apt 4, Venice, FL 34285' };
    expect((await buildAutomatedLeadDraftEstimate(unitLead)).automation.sizeSource).toBe('default');
    expect(performPropertyLookup).not.toHaveBeenCalled();
    expect(await cachedLeadMeasurements('')).toBeNull();
  });

  test('a size the lead or the customer row gave is never replaced or mixed with a county one', async () => {
    const county = { homeSqFt: 1850, lotSqFt: 9200, source: 'county_assessed' };
    const homeOnly = await buildAutomatedLeadDraftEstimate({ ...readyLead({ body: { homeSqFt: '2,400' } }), measurements: county });
    expect(homeOnly.automation.sizeSource).toBe('lead');
    expect(homeOnly.automation.engineInput).toMatchObject({ homeSqFt: 2400, lotSqFt: 8000, lotSizeMeasured: false });
    expect(homeOnly.automation.review).toContain('property_measurements_defaulted');
    expect(homeOnly.automation.measurements).toBeUndefined();

    const both = await buildAutomatedLeadDraftEstimate({ ...readyLead({ customer: { lot_sqft: 7000, home_sqft: 1500 } }), measurements: county });
    expect(both.automation.sizeSource).toBe('lead');
    expect(both.automation.engineInput).toMatchObject({ homeSqFt: 1500, lotSqFt: 7000 });
  });

  test('a customer row\'s treated lawn area (property_sqft) is never the home size: pest is priced on the home, not the lawn', async () => {
    // customers.property_sqft is treated lawn area by schema. A house with 20,000 sq ft of lawn is not a 20,000 sq ft building:
    // pest keeps rising with the footprint above 5,500 sq ft (owner 2026-11-26), so that size would more than double the price.
    const pestPerApp = (draft) => draft.estimateData.engineResult.lineItems.find((l) => l.service === 'pest_control').perApp;
    const noSize = await buildAutomatedLeadDraftEstimate(readyLead());
    const lawnOnly = readyLead({ customer: { property_sqft: 20000, lot_sqft: 30000 } });
    const draft = await buildAutomatedLeadDraftEstimate(lawnOnly);
    expect(draft.automation.engineInput).toMatchObject({ homeSqFt: 2000, lotSqFt: 30000 });
    expect(pestPerApp(draft)).toBe(pestPerApp(noSize));
    // The home size is still unknown, so the draft says so (the auto-send lane parks it for a person).
    expect(lawnOnly.readiness.review).toContain('property_measurements_defaulted');
    expect(draft.automation.review).toContain('property_measurements_defaulted');
    // A home size the lead states is used as before, beside the same lawn area.
    const stated = await buildAutomatedLeadDraftEstimate(readyLead({ customer: { property_sqft: 20000, lot_sqft: 30000 }, body: { homeSqFt: 8000 } }));
    expect(stated.automation.engineInput.homeSqFt).toBe(8000);
    expect(pestPerApp(stated)).toBe(148);
  });

  test('a stated home above 20,000 sq ft is never an automatic price: the draft parks for a hand price and saves no total', async () => {
    // The webhook body is unauthenticated and pest has no flat top any more: a junk size would price a premium no column can hold.
    for (const homeSqFt of [20001, 45000, 1e9, 1e12, 1e300, '25,000,000']) {
      const lead = readyLead({ body: { homeSqFt, lotSqFt: 9000 } });
      const draft = await buildAutomatedLeadDraftEstimate(lead);
      expect(draft.automation).toMatchObject({
        status: 'manual_review_required', generated: false, quoteRequired: true, quoteRequiredReason: 'home_size_above_public_limit',
      });
      expect(draft.automation.review).toContain('home_size_above_public_limit');
      expect([draft.monthly, draft.annual, draft.oneTimeTotal]).toEqual([0, 0, 0]);
      expect(draft.estimateData).toMatchObject({ quoteRequired: true, quoteRequiredReason: 'home_size_above_public_limit', annual: 0 });
      // The size staff see is bounded (ten times the limit), so the provisional figure is a number a decimal(10,2) column can hold.
      expect(draft.automation.engineInput.homeSqFt).toBeLessThanOrEqual(200000);
      expect(draft.automation.provisionalTotals.annual).toBeLessThan(100000);
    }
    // At the bound and under it the draft prices as entered (with its story count): 20,000 sq ft on one floor is $128 + $8 x 14.5.
    const atLimit = await buildAutomatedLeadDraftEstimate(readyLead({ body: { homeSqFt: 20000, lotSqFt: 9000, stories: 1 } }));
    expect(atLimit.automation).toMatchObject({ quoteRequired: false, quoteRequiredReason: null });
    expect(atLimit.automation.review).not.toContain('home_size_above_public_limit');
    expect(atLimit.estimateData.engineResult.lineItems.find((l) => l.service === 'pest_control').perApp).toBe(244);
  });

  test('a big home is priced on its footprint: the county count is used, and with no known count the pest price waits for a person', async () => {
    const pest = (draft) => draft.estimateData.engineResult.lineItems.find((l) => l.service === 'pest_control');
    const county = (stories) => ({ homeSqFt: 8000, lotSqFt: 12000, ...(stories ? { stories } : {}), source: 'county_assessed' });
    // County size + county count: 8,000 sq ft on two floors is a 4,000 sq ft footprint, $122, not $148 for an 8,000 sq ft footprint.
    const twoStory = await buildAutomatedLeadDraftEstimate({ ...readyLead(), measurements: county(2) });
    expect(twoStory.automation.engineInput).toMatchObject({ homeSqFt: 8000, stories: 2 });
    expect(twoStory.automation.engineInput).not.toHaveProperty('storiesSource');
    expect(twoStory.automation.measurements).toEqual({ source: 'county_assessed', homeSqFt: 8000, lotSqFt: 12000, stories: 2 });
    expect(pest(twoStory).perApp).toBe(122);
    expect(twoStory.quoteRequired).toBe(false);
    // County size, no count: the footprint is not known, so the engine's own stories_estimated review holds the draft.
    const noCount = await buildAutomatedLeadDraftEstimate({ ...readyLead(), measurements: county() });
    expect(noCount.automation.engineInput).toMatchObject({ homeSqFt: 8000, stories: 1, storiesSource: 'default' });
    expect(noCount.automation).toMatchObject({ status: 'manual_review_required', generated: false, quoteRequired: true, quoteRequiredReason: 'stories_estimated' });
    expect([noCount.monthly, noCount.annual]).toEqual([0, 0]);
    // A size the lead states: its own count is used; with none the same hold applies.
    const stated = await buildAutomatedLeadDraftEstimate(readyLead({ body: { homeSqFt: 8000, lotSqFt: 12000, stories: 2 } }));
    expect(pest(stated).perApp).toBe(122);
    expect(stated.quoteRequired).toBe(false);
    const statedNoCount = await buildAutomatedLeadDraftEstimate(readyLead({ body: { homeSqFt: 8000, lotSqFt: 12000 } }));
    expect(statedNoCount.automation).toMatchObject({ quoteRequired: true, quoteRequiredReason: 'stories_estimated' });
    // A county count is never mixed with a size the lead stated.
    const mixed = await buildAutomatedLeadDraftEstimate({ ...readyLead({ body: { homeSqFt: 8000, lotSqFt: 12000 } }), measurements: county(2) });
    expect(mixed.automation.engineInput).toMatchObject({ stories: 1, storiesSource: 'default' });
    // At or under 5,500 sq ft nothing changes: one floor is assumed with no count and the draft prices as before.
    const small = await buildAutomatedLeadDraftEstimate(readyLead({ body: { homeSqFt: 5500, lotSqFt: 12000 } }));
    expect(small.automation.engineInput).not.toHaveProperty('storiesSource');
    expect(small.quoteRequired).toBe(false);
    expect(pest(small).perApp).toBe(128);
    // A draft with no pest line takes no mark: termite bait reads the same source for a staff note, and any line note parks a
    // lead draft, so a bait-only draft for the same big home would otherwise save zero totals. It prices as before.
    const baitLead = readyLead({ body: { homeSqFt: 8000, lotSqFt: 12000 } });
    baitLead.intake.serviceInterest = 'Termite bait monitoring';
    baitLead.readiness = evaluateLeadEstimateAutomationReadiness({ intake: baitLead.intake, customer: {}, body: baitLead.body, phone: '+19415550142' });
    const baitOnly = await buildAutomatedLeadDraftEstimate(baitLead);
    expect(Object.keys(baitOnly.automation.services)).toEqual(['termite']);
    expect(baitOnly.automation.engineInput).toMatchObject({ homeSqFt: 8000, stories: 1 });
    expect(baitOnly.automation.engineInput).not.toHaveProperty('storiesSource');
    expect(baitOnly.automation).toMatchObject({ status: 'generated', quoteRequired: false });
    expect(baitOnly.annual).toBeGreaterThan(0);
  });

  test('a story count is a number from 1 to 3 or it is no count: junk never clears the big-home hold or shrinks the footprint', async () => {
    const pest = (draft) => draft.estimateData.engineResult.lineItems.find((l) => l.service === 'pest_control');
    const draftFor = (stories, homeSqFt = 12000) => buildAutomatedLeadDraftEstimate(readyLead({ body: { homeSqFt, lotSqFt: 16000, stories } }));
    // The webhook body is unauthenticated. Read as a count, 12 (or [12]) priced a 12,000 sq ft home as a 1,000 sq ft footprint.
    for (const junk of [12, [12], '12', [2], true, 0.5, 0, -2, 4, '2 stories', {}, 'abc', '0x10']) {
      const draft = await draftFor(junk);
      expect(draft.automation.engineInput).toMatchObject({ homeSqFt: 12000, stories: 1, storiesSource: 'default' });
      expect(draft.automation).toMatchObject({ status: 'manual_review_required', quoteRequired: true, quoteRequiredReason: 'stories_estimated' });
      expect([draft.monthly, draft.annual]).toEqual([0, 0]);
    }
    // A real count prices, whole or split level, as a number or as form text: 12,000 sq ft on 1, 1.5, 2 and 3 floors.
    for (const [stories, perApp] of [[1, 180], ['1', 180], [1.5, 148], ['1.5', 148], [2, 132], [' 2 ', 132], [3, 122]]) {
      const draft = await draftFor(stories);
      expect(draft.automation.engineInput).toMatchObject({ stories: Number(stories) });
      expect(draft.automation.engineInput).not.toHaveProperty('storiesSource');
      expect(draft.quoteRequired).toBe(false);
      expect(pest(draft).perApp).toBe(perApp);
    }
    // A county count from the background lookup is held to the same bounds.
    const countyJunk = await buildAutomatedLeadDraftEstimate({
      ...readyLead(), measurements: { homeSqFt: 8000, lotSqFt: 12000, stories: 12, source: 'county_assessed' },
    });
    expect(countyJunk.automation.engineInput).toMatchObject({ stories: 1, storiesSource: 'default' });
    expect(countyJunk.automation).toMatchObject({ quoteRequired: true, quoteRequiredReason: 'stories_estimated' });
    // At or under the table junk is no count either: the draft prices one floor, as it does with no count at all.
    const smallJunk = await draftFor(12, 3000);
    expect(smallJunk.automation.engineInput).toMatchObject({ stories: 1 });
    expect(smallJunk.automation.engineInput).not.toHaveProperty('storiesSource');
    expect(smallJunk.quoteRequired).toBe(false);
    expect(pest(smallJunk).perApp).toBe(pest(await draftFor(undefined, 3000)).perApp);
  });

  test('measurements passed in (the background lookup) skip the cache read', async () => {
    process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP = 'true';
    const draft = await buildAutomatedLeadDraftEstimate({ ...readyLead(), measurements: { homeSqFt: 3100, lotSqFt: 14500, source: 'county_assessed' } });
    expect(performPropertyLookup).not.toHaveBeenCalled();
    expect(draft.automation.engineInput).toMatchObject({ homeSqFt: 3100, lotSqFt: 14500 });
    expect(draft.automation.sizeSource).toBe('county_assessed');
  });
});

describe('which saved draft the background step may re-price', () => {
  const at = new Date('2026-10-24T15:00:00Z');
  const row = (over = {}, draft = {}) => ({
    source: 'lead_webhook',
    status: 'draft',
    archived_at: null,
    sent_at: null,
    price_locked_at: null,
    created_at: at,
    updated_at: at,
    estimate_data: JSON.stringify({ automation: { draftEstimateAutomation: { source: 'lead_webhook_automation', status: 'manual_review_required', sizeSource: 'default', ...draft } } }),
    ...over,
  });

  test('an untouched lead draft on the default size', () => {
    expect(untouchedDefaultedDraft(row())).toBe(true);
    expect(untouchedDefaultedDraft(row({}, { status: 'generated' }))).toBe(true);
  });

  test.each([
    ['written since it was created', row({ updated_at: new Date(at.getTime() + 1000) })],
    ['sent', row({ sent_at: at })],
    ['archived', row({ archived_at: at })],
    ['price-locked', row({ price_locked_at: at })],
    ['not a draft any more', row({ status: 'sent' })],
    ['not a lead draft', row({ source: 'estimator_engine' })],
    ['already sized by the lead', row({}, { sizeSource: 'lead' })],
    ['already county-sized', row({}, { sizeSource: 'county_assessed' })],
    ['blocked', row({}, { status: 'blocked' })],
    ['a failed build', row({}, { status: 'generation_failed' })],
  ])('not one %s', (_label, candidate) => {
    expect(untouchedDefaultedDraft(candidate)).toBe(false);
  });
});

// The webhook's POST handler is not unit-tested directly (see
// lead-webhook-new-lead-enroll.test.js); this pins its two call sites. The
// cache read takes its own pool connection, so it runs before the phone
// lock, never while the lock's transaction holds one. Inside that
// transaction the row is not committed yet, so a step started there reads no
// row and silently does nothing; and a rebuild with any other readiness (the
// keyed-service verdict rides on it) could price a different service than
// the draft it replaces.
describe('the lead webhook reads the cache before its lock and schedules the step after the row commits', () => {
  test('cache read before the phone lock; one schedule after it, rebuilding with the insert\'s own readiness and address', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/lead-webhook.js'), 'utf8');
    expect(src.split('scheduleLeadDraftPropertyLookup({').length - 1).toBe(1);
    const lock = src.indexOf('await withAutomatedEstimatePhoneLock(phoneFormatted, async (trx) => {');
    const lockEnd = src.indexOf('\n        });\n', lock);
    const schedule = src.indexOf('scheduleLeadDraftPropertyLookup({');
    const caught = src.indexOf('} catch (estErr) {', lock);
    expect(lock).toBeGreaterThan(-1);
    expect(lockEnd).toBeGreaterThan(lock);
    expect(schedule).toBeGreaterThan(lockEnd);
    expect(caught).toBeGreaterThan(schedule);
    expect(src.slice(lock, lockEnd)).toContain('readiness: draftReadiness,');
    expect(src.slice(lock, lockEnd)).toContain('measurements: draftMeasurements,');
    expect(src.split('cachedLeadMeasurements(').length - 1).toBe(1);
    const read = src.indexOf('const draftMeasurements = draftReadiness.ready ? await cachedLeadMeasurements(fullAddress) : null;');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(lock);
    const call = src.slice(schedule, caught);
    expect(call).toContain('estimateId: createdEstimateId,');
    expect(call).toContain('address: fullAddress,');
    expect(call).toContain('rebuild: (measurements) => buildAutomatedLeadDraftEstimate({ intake, customer, body, readiness: draftReadiness, measurements }),');
    expect(src.slice(lockEnd, schedule)).toContain("automatedDraftEstimate?.automation?.sizeSource === 'default'");
    // The triage rebuild of the same draft carries the in-flight lookup's sizes.
    const triage = src.indexOf('const triageDraftEstimate = await buildAutomatedLeadDraftEstimate({');
    expect(triage).toBeGreaterThan(caught);
    expect(src.slice(triage, src.indexOf('});', triage))).toContain('measurements: await pendingLeadMeasurements(createdEstimateId),');
    // The webhook links the lead row to its draft estimate on creation.
    expect(src).toContain('estimate_id: createdEstimateId,');
  });
});

describe('county propertyType, pool cage, photo facts, and aerial turf wiring (2026-11-27)', () => {
  const { mapServiceInterestToEstimateServices } = require('../services/lead-estimate-automation');
  const savedUnitGuard = process.env.GATE_UNIT_SCOPE_GUARDRAILS;
  const savedCageTwo = process.env.GATE_CAGE_TWO_SIZES;
  const savedPhotoFacts = process.env.GATE_PEST_PRICE_PHOTO_FACTS;

  afterEach(() => {
    if (savedUnitGuard === undefined) delete process.env.GATE_UNIT_SCOPE_GUARDRAILS;
    else process.env.GATE_UNIT_SCOPE_GUARDRAILS = savedUnitGuard;
    if (savedCageTwo === undefined) delete process.env.GATE_CAGE_TWO_SIZES;
    else process.env.GATE_CAGE_TWO_SIZES = savedCageTwo;
    if (savedPhotoFacts === undefined) delete process.env.GATE_PEST_PRICE_PHOTO_FACTS;
    else process.env.GATE_PEST_PRICE_PHOTO_FACTS = savedPhotoFacts;
  });

  test('trusted county Single Family clears property_type_unresolved under GATE_UNIT_SCOPE_GUARDRAILS', async () => {
    process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true';
    process.env.GATE_LEAD_DRAFT_PROPERTY_LOOKUP = 'true';
    performPropertyLookup.mockResolvedValue(lookupOf(countyRecord()));

    const draft = await buildAutomatedLeadDraftEstimate(readyLead());
    expect(draft.automation.status).toBe('generated');
    expect(draft.automation.generated).toBe(true);
    expect(draft.automation.review).not.toContain('property_type_unresolved');
    expect(draft.automation.review).toContain('property_measurements_from_county');
    expect(draft.automation.engineInput.propertyType).toBe('Single Family');
    expect(draft.monthly).toBeGreaterThan(0);
  });

  test('flagged or satellite-only propertyType stays unresolved and parks the draft', async () => {
    process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true';
    const flagged = countyMeasurements(lookupOf(countyRecord(), { fieldVerifyFlags: [{ field: 'propertyType', priority: 'HIGH' }] }));
    expect(flagged.propertyType).toBeUndefined();
    const draftFlagged = await buildAutomatedLeadDraftEstimate({ ...readyLead(), measurements: flagged });
    expect(draftFlagged.automation.status).toBe('manual_review_required');
    expect(draftFlagged.automation.review).toContain('property_type_unresolved');

    const sat = countyMeasurements(lookupOf(countyRecord({ _propertyTypeSource: 'satellite' })));
    expect(sat.propertyType).toBeUndefined();
  });

  test('record-backed pool cages price Medium (<600 sf) and hold Large/Oversized (>=601 sf) under GATE_CAGE_TWO_SIZES', async () => {
    process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true';
    process.env.GATE_CAGE_TWO_SIZES = 'true';

    // 500 sq ft cage -> Medium -> priced, adds pool cage modifier above bare home.
    const bareDraft = await buildAutomatedLeadDraftEstimate({
      ...readyLead(),
      measurements: countyMeasurements(lookupOf(countyRecord())),
    });
    const medMeasured = countyMeasurements(lookupOf(countyRecord(), {
      pool: 'YES', poolSource: 'county', poolCage: 'YES', poolCageSqft: 500, poolCageSize: 'MEDIUM', poolCageLegacySize: 'MEDIUM',
    }));
    expect(medMeasured.features).toMatchObject({ pool: true, poolCage: true, poolCageSize: 'medium', poolCageSqft: 500 });
    expect(medMeasured.features.poolCageReview).toBeUndefined();
    const medDraft = await buildAutomatedLeadDraftEstimate({ ...readyLead(), measurements: medMeasured });
    expect(medDraft.automation.status).toBe('generated');
    expect(medDraft.annual).toBeGreaterThan(bareDraft.annual);

    // 1,200 sq ft cage -> Oversized (held four-size) -> sets poolCageReview -> parks under large_pool_cage.
    const bigMeasured = countyMeasurements(lookupOf(countyRecord(), {
      pool: 'YES', poolSource: 'county', poolCage: 'YES', poolCageSqft: 1200, poolCageSize: 'LARGE', poolCageLegacySize: 'OVERSIZED',
    }));
    expect(bigMeasured.features).toMatchObject({ poolCage: true, poolCageSize: 'large', poolCageReview: true, poolCageSqft: 1200 });
    const bigDraft = await buildAutomatedLeadDraftEstimate({ ...readyLead(), measurements: bigMeasured });
    expect(bigDraft.automation.status).toBe('manual_review_required');
    expect(bigDraft.automation.quoteRequired).toBe(true);
    expect(bigDraft.automation.quoteRequiredReason).toBe('large_pool_cage');
    expect(bigDraft.monthly).toBe(0);
  });

  test('form micro-taps override county cage (explicit no clears cage; explicit large cage holds)', async () => {
    process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true';
    process.env.GATE_CAGE_TWO_SIZES = 'true';
    const countyWithCage = countyMeasurements(lookupOf(countyRecord(), {
      pool: 'YES', poolSource: 'county', poolCage: 'YES', poolCageSqft: 1200, poolCageSize: 'LARGE', poolCageLegacySize: 'OVERSIZED',
    }));
    const noCageDraft = await buildAutomatedLeadDraftEstimate({
      ...readyLead({ body: { poolCage: 'no' } }),
      measurements: countyWithCage,
    });
    expect(noCageDraft.automation.engineInput.features.poolCage).toBe(false);
    expect(noCageDraft.automation.status).toBe('generated');

    // A visitor tapping "medium" must NOT clear a record-backed 1,200 sf large-cage hold.
    const formMediumBeatsNothing = await buildAutomatedLeadDraftEstimate({
      ...readyLead({ body: { poolCage: 'yes', poolCageSize: 'medium' } }),
      measurements: countyWithCage,
    });
    expect(formMediumBeatsNothing.automation.engineInput.features).toMatchObject({
      poolCage: true, poolCageSize: 'large', poolCageReview: true,
    });
    expect(formMediumBeatsNothing.automation.status).toBe('manual_review_required');
    expect(formMediumBeatsNothing.automation.quoteRequiredReason).toBe('large_pool_cage');

    const formLargeCage = await buildAutomatedLeadDraftEstimate({
      ...readyLead({ body: { poolCage: 'yes', poolCageSize: 'large' } }),
      measurements: countyMeasurements(lookupOf(countyRecord())),
    });
    expect(formLargeCage.automation.status).toBe('manual_review_required');
    expect(formLargeCage.automation.quoteRequiredReason).toBe('large_pool_cage');
  });

  test('photo facts and aerial turf respect lookup confidence, _observed provenance, zero turf, and scope lawn-doubt facts to pest only', async () => {
    process.env.GATE_PEST_PRICE_PHOTO_FACTS = 'true';
    const lookup = {
      propertyRecord: countyRecord(),
      enriched: {
        aiConfidence: 82,
        turfSource: 'vision',
        estimatedTurfSf: 4200,
        hasAttachedGarage: true,
        shrubDensity: 'HEAVY',
        landscapeComplexity: 'COMPLEX',
        nearWater: 'YES',
        _observed: { shrubDensity: true, landscapeComplexity: false, nearWater: true },
        fieldVerifyFlags: [{ field: 'estimatedTurfSf', priority: 'MEDIUM' }],
      },
      aiAnalysis: { aiDivergences: [{ field: 'nearWater' }] },
    };
    const measured = countyMeasurements(lookup);
    // Lawn area flagged -> turf omitted; photo facts stay OUT of shared features (so mosquito
    // is unaffected) and ride strictly in pestPhotoFacts for observed, non-disputed fields.
    expect(measured.turf).toBeUndefined();
    expect(measured.features).toEqual({ attachedGarage: true });
    expect(measured.pestPhotoFacts).toEqual({ shrubs: 'heavy' });

    // Missing aiAnalysis -> no pestPhotoFacts under lawn-doubt exception.
    const noAnalysis = { propertyRecord: countyRecord(), enriched: lookup.enriched };
    expect(countyMeasurements(noAnalysis).pestPhotoFacts).toBeUndefined();

    // Trusted zero turf is preserved and carried through as lawnSqFt: 0 (never inferred from lot).
    const zeroTurf = countyMeasurements(lookupOf(countyRecord(), {
      aiConfidence: 90, turfSource: 'vision', estimatedTurfSf: 0, turfObservation: 'none_present',
    }));
    expect(zeroTurf.turf).toMatchObject({ estimatedTurfSf: 0, turfKnownZero: true });
    const zeroDraft = await buildAutomatedLeadDraftEstimate({ ...readyLead(), measurements: zeroTurf });
    expect(zeroDraft.automation.engineInput.lawnSqFt).toBe(0);
    expect(zeroDraft.automation.engineInput.estimatedTurfSf).toBe(0);

    // Unflagged high-confidence turf flows through cleanly.
    const cleanTurf = countyMeasurements(lookupOf(countyRecord(), {
      aiConfidence: 85, turfSource: 'vision', estimatedTurfSf: 4200, turfCappedToParcel: false,
    }));
    expect(cleanTurf.turf).toEqual({ estimatedTurfSf: 4200, turfSource: 'vision', turfCappedToParcel: false });
  });

  test('plural service-interest keywords map cleanly and negated weeds keep recurring lawn care', () => {
    expect(mapServiceInterestToEstimateServices('Ants and roaches in kitchen').services).toHaveProperty('pest');
    expect(mapServiceInterestToEstimateServices('Mosquitoes in backyard').services).toHaveProperty('mosquito');
    expect(mapServiceInterestToEstimateServices('Fleas and ticks').services).toHaveProperty('flea');
    expect(mapServiceInterestToEstimateServices('Wasps on patio').services).toHaveProperty('stinging');
    expect(mapServiceInterestToEstimateServices('Weeds in lawn').services).toHaveProperty('oneTimeLawn');
    const recurringNoWeeds = mapServiceInterestToEstimateServices('Quarterly lawn care, no weeds');
    expect(recurringNoWeeds.services).toHaveProperty('lawn');
    expect(recurringNoWeeds.services).not.toHaveProperty('oneTimeLawn');
  });

  test('admin-leads withEstimatePreview marks county-verified SERVER drafts sendReady only when share link exists', () => {
    const { withEstimatePreview } = require('../routes/admin-leads')._estimatePreview;
    const readyRow = {
      id: 'lead-1',
      estimate_id: 'est-1',
      estimate_status: 'draft',
      _est_source: 'lead_webhook',
      _est_monthly: '42.00',
      _est_annual: '504.00',
      _est_onetime: null,
      _est_authority: 'SERVER',
      _est_has_link: true,
      _est_archived_at: null,
      _est_sent_at: null,
      _est_scheduled_at: null,
      _est_created_at: new Date(),
      _est_data: JSON.stringify({
        automation: {
          leadEstimateAutomation: { status: 'ready', review: ['property_measurements_from_county'] },
          draftEstimateAutomation: {
            status: 'generated',
            generated: true,
            sizeSource: 'county_assessed',
            measurements: { source: 'county_assessed', homeSqFt: 1850, lotSqFt: 9200, propertyType: 'Single Family' },
          },
        },
      }),
    };
    const noLinkRow = { ...readyRow, id: 'lead-nolink', estimate_id: 'est-nolink', _est_has_link: false };
    const heldRow = {
      ...readyRow,
      id: 'lead-2',
      estimate_id: 'est-2',
      _est_authority: null,
      _est_monthly: null,
      _est_data: JSON.stringify({
        quoteRequired: true,
        quoteRequiredReason: 'large_pool_cage',
        automation: {
          draftEstimateAutomation: {
            status: 'manual_review_required',
            generated: false,
            quoteRequired: true,
            quoteRequiredReason: 'large_pool_cage',
            provisionalTotals: { monthly: 48, annual: 576, oneTimeTotal: 0 },
          },
        },
      }),
    };
    const [outReady, outNoLink, outHeld] = withEstimatePreview([readyRow, noLinkRow, heldRow]);
    expect(outReady).not.toHaveProperty('_est_data');
    expect(outReady).not.toHaveProperty('_est_authority');
    expect(outReady).not.toHaveProperty('_est_has_link');
    expect(outReady.estimate_preview).toMatchObject({
      status: 'draft',
      monthly: 42,
      provisional: false,
      sendReady: true,
      sizeSource: 'county_assessed',
    });
    expect(outNoLink.estimate_preview.sendReady).toBe(false);
    expect(outHeld.estimate_preview).toMatchObject({
      status: 'draft',
      monthly: 48,
      provisional: true,
      sendReady: false,
      quoteRequiredReason: 'large_pool_cage',
    });
  });
});
