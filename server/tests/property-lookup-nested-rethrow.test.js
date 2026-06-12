/**
 * Nested provider failures vs the canary's rethrowErrors option.
 *
 * The county detail helpers deliberately degrade on partial-surface outages
 * (Manatee features → "no pool signal", Sarasota building detail → grid-only
 * facts, Charlotte ownership GIS → no lotSize) so one flaky sub-fetch never
 * sinks a production lookup. The canary is the exception: those same
 * swallowed errors would surface as parser-regression labels ("pool not
 * found", "lotSize not parsed") instead of "lookup threw". These tests pin
 * BOTH sides: default callers still degrade, rethrowErrors propagates.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  lookupPropertyFromCountyByParcel,
  _private: aiPrivate,
} = require('../services/property-lookup/ai-property-lookup');

const {
  fetchManateeParcelDetails,
  fetchSarasotaParcelDetails,
  fetchCharlotteParcelDetails,
} = aiPrivate;

const TIMEOUT_MS = 8000;

// ── Minimal healthy fixtures (one core fact each, so a degraded parse still
// clears hasAnyPropertyFact and the record survives) ──

const MANATEE_BUILDINGS = {
  cols: [{ title: 'LivBus' }, { title: 'YrBlt' }],
  rows: [['2000', '2005']],
};

// Buildings grid carries both the primary-building link (so the building
// detail fetch actually fires) and a Living Area fact.
const SARASOTA_DETAIL_HTML = `
<table id="Buildings"><thead><tr><th>Building</th><th>Living Area</th></tr></thead>
<tbody><tr><td><a href="/propertysearch/bldgdetail?id=1">Building 1</a></td><td>1800</td></tr></tbody></table>`;

const CHARLOTTE_DETAIL_HTML = `
<table><caption>Building Information</caption>
<thead><tr><th>Building</th><th>A/C Area</th><th>Year Built</th></tr></thead>
<tbody><tr><td>1</td><td>1500</td><td>1990</td></tr></tbody></table>`;

const MANATEE_SEARCH = { parcelId: '579642409', situsAddress: '12071 FOREST PARK CIR', city: 'BRADENTON' };
const SARASOTA_SEARCH = {
  parcelId: '0069140016',
  situsAddress: '4740 MEADOWVIEW CIR',
  city: 'SARASOTA',
  detailUrl: 'https://www.sc-pa.com/propertysearch/parcel/details/0069140016',
  html: SARASOTA_DETAIL_HTML,
};
const CHARLOTTE_SEARCH = { parcelId: '402217351013', situsAddress: '2965 ROCK CREEK DR', city: 'PORT CHARLOTTE', zipCode: '33948' };

function okJson(body) {
  return { ok: true, status: 200, url: '', json: async () => body, text: async () => JSON.stringify(body) };
}
function okHtml(text) {
  return { ok: true, status: 200, url: '', text: async () => text };
}
function http503() {
  return { ok: false, status: 503, url: '', text: async () => '', json: async () => ({}) };
}

// Per-test outage switches — every other surface stays healthy so the ONLY
// failure is the nested fetch under test.
let failManateeFeatures;
let failSarasotaBuildingDetail;
let failCharlotteOwnership;

const originalFetch = global.fetch;

beforeEach(() => {
  failManateeFeatures = false;
  failSarasotaBuildingDetail = false;
  failCharlotteOwnership = false;
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('pao-model-land.php')) return okJson({ cols: [], rows: [] });
    if (u.includes('pao-model-buildings.php')) return okJson(MANATEE_BUILDINGS);
    if (u.includes('pao-model-features.php')) return failManateeFeatures ? http503() : okJson({ cols: [], rows: [] });
    if (u.includes('bldgdetail')) return failSarasotaBuildingDetail ? http503() : okHtml('<ul><li>Year Built: 2005</li></ul>');
    if (u.includes('agis3.charlottecountyfl.gov')) return failCharlotteOwnership ? http503() : okJson({ features: [] });
    if (u.includes('ccappraiser.com')) return okHtml(CHARLOTTE_DETAIL_HTML);
    throw new Error(`unexpected fetch in test: ${u}`);
  });
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('Manatee features fetch outage', () => {
  it('degrades to a pool-unknown record for default callers', async () => {
    failManateeFeatures = true;
    const record = await fetchManateeParcelDetails(MANATEE_SEARCH, MANATEE_SEARCH.situsAddress, TIMEOUT_MS);
    expect(record).toBeTruthy();
    expect(record.squareFootage).toBe(2000);
    // The degraded record is exactly what would trip the canary's
    // "pool not found on extra-features roll" parser-regression label.
    expect(record.hasPool).not.toBe(true);
  });

  it('rethrows for the canary instead of masquerading as a parse miss', async () => {
    failManateeFeatures = true;
    await expect(
      fetchManateeParcelDetails(MANATEE_SEARCH, MANATEE_SEARCH.situsAddress, TIMEOUT_MS, Date.now(), { rethrowErrors: true }),
    ).rejects.toThrow('Manatee PAO 503');
  });
});

describe('Sarasota building-detail fetch outage', () => {
  it('degrades to grid-only facts for default callers', async () => {
    failSarasotaBuildingDetail = true;
    const record = await fetchSarasotaParcelDetails(SARASOTA_SEARCH, SARASOTA_SEARCH.situsAddress, TIMEOUT_MS);
    expect(record).toBeTruthy();
    expect(record.squareFootage).toBe(1800);
  });

  it('rethrows for the canary instead of masquerading as a parse miss', async () => {
    failSarasotaBuildingDetail = true;
    await expect(
      fetchSarasotaParcelDetails(SARASOTA_SEARCH, SARASOTA_SEARCH.situsAddress, TIMEOUT_MS, Date.now(), { rethrowErrors: true }),
    ).rejects.toThrow('County lookup HTTP 503');
  });
});

describe('Charlotte ownership GIS outage', () => {
  it('degrades to a lotSize-less record for default callers', async () => {
    failCharlotteOwnership = true;
    const record = await fetchCharlotteParcelDetails(CHARLOTTE_SEARCH, CHARLOTTE_SEARCH.situsAddress, TIMEOUT_MS);
    expect(record).toBeTruthy();
    expect(record.squareFootage).toBe(1500);
    // Ownership GIS is Charlotte's only lotSize source — this is what would
    // trip the canary's "lotSize not parsed" label.
    expect(record.lotSize > 0).toBe(false);
  });

  it('rethrows for the canary instead of masquerading as a parse miss', async () => {
    failCharlotteOwnership = true;
    await expect(
      fetchCharlotteParcelDetails(CHARLOTTE_SEARCH, CHARLOTTE_SEARCH.situsAddress, TIMEOUT_MS, Date.now(), { rethrowErrors: true }),
    ).rejects.toThrow('County lookup HTTP 503');
  });
});

describe('lookupPropertyFromCountyByParcel threads rethrowErrors into the nested fetches', () => {
  const parcel = { county: 'Manatee', paoParcelId: '579642409', situsAddress: '12071 FOREST PARK CIR', situsCity: 'BRADENTON' };

  it('without the option a nested outage still resolves to a degraded record', async () => {
    failManateeFeatures = true;
    const record = await lookupPropertyFromCountyByParcel(parcel, parcel.situsAddress, { timeoutMs: TIMEOUT_MS });
    expect(record).toBeTruthy();
    expect(record.hasPool).not.toBe(true);
  });

  it('with the option a nested outage rejects so the canary labels it a throw', async () => {
    failManateeFeatures = true;
    await expect(
      lookupPropertyFromCountyByParcel(parcel, parcel.situsAddress, { timeoutMs: TIMEOUT_MS, rethrowErrors: true }),
    ).rejects.toThrow('Manatee PAO 503');
  });
});
