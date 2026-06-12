process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'test-maps-key';
delete process.env.PROPERTY_LOOKUP_PARCEL_OVERLAY;

// "Show your work" trust block (estimateShowYourWork gate):
//   - gate OFF → no section markup, no /data key, page HTML byte-identical
//   - gate ON + estimate_data.enriched → facts with friendly source labels,
//     parcel match line (never the parcel id), low-quality confirm note
//   - no enriched profile (admin/tech estimates) → builder returns null
//   - property_lookups polygon cache hit → parcel-outline satellite overlay
//     becomes the AI card image; any cache failure falls back to the stored
//     satellite_url with no caption.
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getCachedLookup: jest.fn(),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn().mockResolvedValue({
    enforced: false,
    required: false,
    slotRequired: false,
  }),
  computeDepositAmount: jest.fn(() => 0),
  pendingDepositCredit: jest.fn(),
  consumeDepositCredit: jest.fn(),
  refundUnconsumedDeposits: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { getCachedLookup } = require('../services/property-lookup/lookup-cache');
const { renderPage, buildShowYourWork } = require('../routes/estimate-public');
const estimatePublicRouter = require('../routes/estimate-public');

// ── db chain mock ────────────────────────────────────────────────
let dbRows = {};

function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}

db.mockImplementation((table) => chainFor(dbRows[table]));

// ── fixtures ─────────────────────────────────────────────────────
const PARCEL_ID = '7654321098';

function enrichedFixture(overrides = {}) {
  return {
    homeSqFt: 2150,
    lotSqFt: 9800,
    stories: 2,
    yearBuilt: 1998,
    pool: 'YES',
    poolSource: 'county',
    poolCageSqft: 640,
    hasSpa: false,
    estimatedTurfSf: 6800,
    turfCappedToParcel: true,
    parcel: { parcelId: PARCEL_ID, county: 'Manatee', areaSqft: 10019, source: 'fdor_cadastral' },
    propertyDataQuality: { level: 'low', score: 42, fieldVerifyCount: 3 },
    fieldEvidence: {
      squareFootage: { sourceType: 'county' },
      lotSize: { sourceType: 'cadastral' },
      stories: { sourceType: 'verified' },
      yearBuilt: { sourceType: 'permit' },
      hasPool: { sourceType: 'county' },
    },
    ...overrides,
  };
}

function renderEstimate(overrides = {}) {
  return {
    id: 'estimate-syw',
    status: 'sent',
    customerName: 'Pat Tester',
    address: '123 Trust Ln, Bradenton, FL 34203',
    monthlyTotal: 0,
    annualTotal: 0,
    onetimeTotal: 0,
    tier: 'Bronze',
    satelliteUrl: 'https://maps.googleapis.com/maps/api/staticmap?center=stored-image',
    ...overrides,
  };
}

function renderEstimateData(extra = {}) {
  return {
    result: {
      recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] },
      oneTime: { items: [], membershipFee: 99 },
    },
    ...extra,
  };
}

function estimateRow(overrides = {}) {
  return {
    id: 'est-syw-1',
    token: 'showyourworktoken',
    status: 'sent',
    sent_at: null, // shouldCountView short-circuits — no view-tracking writes
    viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester',
    customer_phone: null,
    customer_email: null,
    address: '123 Trust Ln, Bradenton, FL 34203',
    satellite_url: 'https://maps.googleapis.com/maps/api/staticmap?center=stored-image',
    waveguard_tier: 'Bronze',
    show_one_time_option: false,
    bill_by_invoice: false,
    estimate_data: {
      sendSnapshot: {
        pricingBundle: {
          frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }],
          waveGuardTier: 'Bronze',
          anchorOneTimePrice: 0,
          source: 'send_snapshot_fixture',
        },
      },
      result: {
        recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] },
        oneTime: { items: [], membershipFee: 99 },
      },
      enriched: enrichedFixture(),
    },
    ...overrides,
  };
}

// Closed square ring in [lng, lat] order, the GIS shape buildParcelOverlayParam expects.
function polygonFixture() {
  return [[
    [-82.5001, 27.3001],
    [-82.5001, 27.2999],
    [-82.4999, 27.2999],
    [-82.4999, 27.3001],
    [-82.5001, 27.3001],
  ]];
}

function cacheRowFixture(overrides = {}) {
  return {
    parcel: { parcelId: PARCEL_ID, county: 'Manatee', polygon: polygonFixture(), polygonAreaSqft: 10019 },
    lat: 27.3,
    lng: -82.5,
    ...overrides,
  };
}

// ── route harness (reports-public test idiom) ────────────────────
function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    server.close();
  }
}

beforeEach(() => {
  dbRows = {};
  isEnabled.mockReset();
  isEnabled.mockReturnValue(false);
  getCachedLookup.mockReset();
  getCachedLookup.mockResolvedValue(null);
});

describe('estimate show your work — gate off', () => {
  test('renderPage emits no section markup and stays byte-identical without the payload', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-12T12:00:00Z'));
    try {
      const est = renderEstimate({ expiresAt: '2026-07-01T00:00:00Z' });
      const estData = renderEstimateData({ enriched: enrichedFixture() });
      const html = renderPage('syw-token', est, estData, null);

      expect(html).not.toContain('ai-show-work');
      expect(html).not.toContain('Where these details came from');
      expect(html).not.toContain('ai-satellite-caption');
      expect(html).not.toContain('ai-fact');
      // The plain stored satellite image still renders.
      expect(html).toContain('class="ai-satellite" src="https://maps.googleapis.com/maps/api/staticmap?center=stored-image"');

      // No opts, empty opts, and an explicit null payload all produce the
      // exact same bytes — the gate-off page is unchanged.
      const htmlEmptyOpts = renderPage('syw-token', est, estData, null, {});
      const htmlNullPayload = renderPage('syw-token', est, estData, null, { showYourWork: null });
      expect(htmlEmptyOpts).toBe(html);
      expect(htmlNullPayload).toBe(html);
    } finally {
      jest.useRealTimers();
    }
  });

  test('GET /:token/data has no showYourWork key', async () => {
    dbRows = { estimates: estimateRow() };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/showyourworktoken/data`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect('showYourWork' in body).toBe(false);
      expect(body.estimate.id).toBe('est-syw-1');
    });
  });
});

describe('estimate show your work — gate on', () => {
  beforeEach(() => {
    isEnabled.mockImplementation((gate) => gate === 'estimateShowYourWork');
  });

  test('builder maps enriched facts to friendly source labels', async () => {
    const work = await buildShowYourWork(estimateRow(), { enriched: enrichedFixture() });

    expect(work).not.toBeNull();
    expect(work.facts).toEqual([
      { label: 'Home size', value: '2,150 sq ft', source: 'County records' },
      { label: 'Lot size', value: '9,800 sq ft', source: 'County records' },
      { label: 'Stories', value: '2 stories', source: 'Verified on-site' },
      { label: 'Year built', value: '1998', source: 'Permit records' },
      { label: 'Pool', value: 'Yes', source: 'County records' },
      { label: 'Screen enclosure', value: 'About 640 sq ft', source: 'County records' },
      { label: 'Treatable turf', value: '6,800 sq ft (bounded by your county parcel area)', source: 'Satellite AI analysis' },
    ]);
    expect(work.parcelLine).toBe('Matched to Manatee County parcel records — 10,019 sq ft parcel.');
    expect(work.qualityNote).toBe("A few of these details were hard to confirm remotely — we'll confirm them on-site before treatment.");
    // Raw provenance never leaks: no parcel id, provider names, or scores.
    expect(JSON.stringify(work)).not.toContain(PARCEL_ID);
    expect(JSON.stringify(work)).not.toContain('fdor');
    expect(JSON.stringify(work)).not.toContain('cadastral');
  });

  test('renderPage extends the Waves AI card with the facts block', async () => {
    const showYourWork = await buildShowYourWork(estimateRow(), { enriched: enrichedFixture() });
    const html = renderPage('syw-token', renderEstimate(), renderEstimateData({ enriched: enrichedFixture() }), null, { showYourWork });

    expect(html).toContain('Where these details came from');
    expect(html).toContain('class="ai-show-work"');
    expect(html).toContain('Verified on-site');
    expect(html).toContain('County records');
    expect(html).toContain('Permit records');
    expect(html).toContain('Satellite AI analysis');
    expect(html).toContain('2,150 sq ft');
    expect(html).toContain('bounded by your county parcel area');
    expect(html).toContain('Matched to Manatee County parcel records — 10,019 sq ft parcel.');
    expect(html).toContain('.ai-show-work{');
    expect(html).not.toContain(PARCEL_ID);
    // No polygon cache hit in this test → plain stored image, no caption
    // element (the .ai-satellite-caption CSS rule ships with the section).
    expect(html).toContain('class="ai-satellite" src="https://maps.googleapis.com/maps/api/staticmap?center=stored-image"');
    expect(html).not.toContain('<p class="ai-satellite-caption">');
    expect(html).not.toContain('Red outline');
  });

  test('estimate without enriched (admin/tech estimates) returns null and hides the section', async () => {
    const adminRow = estimateRow();
    delete adminRow.estimate_data.enriched;

    const work = await buildShowYourWork(adminRow, adminRow.estimate_data);
    expect(work).toBeNull();

    const html = renderPage('syw-token', renderEstimate(), renderEstimateData(), null, { showYourWork: work });
    expect(html).not.toContain('ai-show-work');
    expect(html).not.toContain('Where these details came from');

    dbRows = { estimates: adminRow };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/showyourworktoken/data`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect('showYourWork' in body).toBe(true);
      expect(body.showYourWork).toBeNull();
    });
  });

  test('polygon cache hit swaps the parcel-outline overlay into the AI card image', async () => {
    getCachedLookup.mockResolvedValue(cacheRowFixture());

    const work = await buildShowYourWork(estimateRow(), { enriched: enrichedFixture() });
    expect(work.overlaySatelliteUrl).toContain('https://maps.googleapis.com/maps/api/staticmap?center=27.3,-82.5');
    expect(work.overlaySatelliteUrl).toContain('zoom=20');
    expect(work.overlaySatelliteUrl).toContain('size=640x640');
    expect(work.overlaySatelliteUrl).toContain('maptype=satellite');
    expect(work.overlaySatelliteUrl).toContain('path=color%3A0xff0000ff');
    expect(work.overlaySatelliteUrl).toContain('key=test-maps-key');

    const html = renderPage('syw-token', renderEstimate(), renderEstimateData({ enriched: enrichedFixture() }), null, { showYourWork: work });
    expect(html).toContain('&amp;path=color%3A0xff0000ff');
    expect(html).toContain('Red outline: your property boundary from county records.');
    expect(html).not.toContain('class="ai-satellite" src="https://maps.googleapis.com/maps/api/staticmap?center=stored-image"');
  });

  test('cache read failure falls back to the stored satellite_url with no caption', async () => {
    getCachedLookup.mockRejectedValue(new Error('boom'));

    const work = await buildShowYourWork(estimateRow(), { enriched: enrichedFixture() });
    expect(work).not.toBeNull();
    expect(work.overlaySatelliteUrl).toBeNull();
    // The facts section still renders — only the overlay degrades.
    expect(work.facts.length).toBeGreaterThan(0);

    const html = renderPage('syw-token', renderEstimate(), renderEstimateData({ enriched: enrichedFixture() }), null, { showYourWork: work });
    expect(html).toContain('class="ai-satellite" src="https://maps.googleapis.com/maps/api/staticmap?center=stored-image"');
    expect(html).not.toContain('Red outline');
    expect(html).toContain('Where these details came from');
  });

  test('kill switch PROPERTY_LOOKUP_PARCEL_OVERLAY=false skips the overlay lookup entirely', async () => {
    process.env.PROPERTY_LOOKUP_PARCEL_OVERLAY = 'false';
    try {
      getCachedLookup.mockResolvedValue(cacheRowFixture());
      const work = await buildShowYourWork(estimateRow(), { enriched: enrichedFixture() });
      expect(work.overlaySatelliteUrl).toBeNull();
      expect(getCachedLookup).not.toHaveBeenCalled();
    } finally {
      delete process.env.PROPERTY_LOOKUP_PARCEL_OVERLAY;
    }
  });

  test('GET /:token/data includes the showYourWork payload', async () => {
    getCachedLookup.mockResolvedValue(cacheRowFixture());
    dbRows = { estimates: estimateRow() };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/showyourworktoken/data`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.showYourWork).not.toBeNull();
      expect(body.showYourWork.facts).toEqual(
        expect.arrayContaining([
          { label: 'Home size', value: '2,150 sq ft', source: 'County records' },
          { label: 'Stories', value: '2 stories', source: 'Verified on-site' },
        ])
      );
      expect(body.showYourWork.parcelLine).toContain('Manatee County parcel records');
      expect(body.showYourWork.overlaySatelliteUrl).toContain('path=color%3A0xff0000ff');
      expect(JSON.stringify(body.showYourWork)).not.toContain(PARCEL_ID);
    });
  });
});
