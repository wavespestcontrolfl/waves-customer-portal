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
  test('a county-assessed single-family home and lot count', () => {
    expect(countyMeasurements(lookupOf(countyRecord()))).toEqual({ homeSqFt: 1850, lotSqFt: 9200, source: 'county_assessed' });
  });

  test.each([
    ['the lookup landed on a different premise', lookupOf(countyRecord(), { fieldVerifyFlags: [{ field: 'address' }] })],
    ['the house number snapped to another parcel', lookupOf(countyRecord({ _addressAudit: { snappedRecord: { typed: '4521' } } }))],
    ['the living area came from AI or a listing', lookupOf(countyRecord({ _fieldEvidence: { squareFootage: { sourceType: 'ai' } } }))],
    ['a condo', lookupOf(countyRecord({ propertyType: 'Condo' }))],
    ['a townhome', lookupOf(countyRecord({ propertyType: 'Townhouse' }))],
    ['no property type', lookupOf(countyRecord({ propertyType: null }))],
    ['an unassessed vacant parcel', lookupOf(countyRecord({ squareFootage: null, yearBuilt: null, _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 9200, landUseDescription: 'VACANT RESIDENTIAL' } }))],
    ['a home over 10,000 sq ft', lookupOf(countyRecord({ squareFootage: 12000 }))],
    ['a lot over 10 acres', lookupOf(countyRecord({ _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 600000 } }))],
    ['no lookup', null],
  ])('%s does not', (_label, lookup) => {
    expect(countyMeasurements(lookup)).toBeNull();
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
    expect(draft.automation.measurements).toEqual({ source: 'county_assessed', homeSqFt: 1850, lotSqFt: 9200 });
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
    const lockEnd = src.indexOf('\n      });\n', lock);
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
  });
});
