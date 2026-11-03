/** County-roll fallback inside the reviewed geocode (GATE_GEOCODE_COUNTY_FALLBACK). In-memory tables, no database. */
let mockTables;
jest.mock('../models/db', () => {
  const rowsOf = table => mockTables[table];
  const make = (table) => {
    const filters = [];
    const matching = () => rowsOf(table).filter(row => filters.every(test => test(row)));
    const chain = {
      where(cond) { if (cond && typeof cond === 'object') filters.push(row => Object.entries(cond).every(([k, v]) => row[k] === v)); return chain; },
      whereNull(col) { filters.push(row => row[col] == null); return chain; },
      forUpdate: () => chain,
      forShare: () => chain,
      select: () => chain,
      first: async () => { const row = matching()[0]; return row && { ...row }; },
      update: async (patch) => { matching().forEach(row => Object.assign(row, patch)); return matching().length; },
      insert: (row) => ({ onConflict: () => ({ merge: () => ({ returning: async () => {
        const existing = rowsOf(table).find(r => r.customer_id === row.customer_id);
        if (existing) Object.assign(existing, row); else rowsOf(table).push({ ...row });
        return [rowsOf(table).find(r => r.customer_id === row.customer_id)];
      } }) }) }),
    };
    return chain;
  };
  const conn = jest.fn(make);
  conn.transaction = async fn => fn(conn);
  conn.fn = { now: () => new Date('2026-11-02T12:00:00Z') };
  return conn;
});
jest.mock('../services/geocoder', () => ({
  buildAddress: c => [c.address_line1, c.city, c.state, c.zip].join(', '),
  geocodeAddressWithStatus: jest.fn(),
}));
jest.mock('../services/property-lookup/county-lot-pin', () => ({ countyLotPinForAddress: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { geocodeAddressWithStatus } = require('../services/geocoder');
const { countyLotPinForAddress } = require('../services/property-lookup/county-lot-pin');
const { attemptReviewedGeocode, retryCountyNeedsPin } = require('../services/customer-geocode-review');

const CUSTOMER = 'c1';
const LOT = { lat: 27.58, lng: -82.42, parcelId: '1000', county: 'Manatee' };
const PARTIAL = { location: null, permanent: true, reason: 'partial_match' };
const NOW = new Date('2026-11-02T12:00:00Z');
const address = () => ({ address_line1: '104 Sample Way', address_line2: null, city: 'Parrish', state: 'FL', zip: '34219' });
const snapshot = () => JSON.stringify([address().address_line1, null, 'Parrish', 'FL', '34219']);

function seed({ review = null } = {}) {
  mockTables = {
    customers: [{ id: CUSTOMER, ...address(), latitude: null, longitude: null, deleted_at: null }],
    customer_properties: [{ id: 'p1', customer_id: CUSTOMER, is_primary: true, active: true, ...address(), latitude: null, longitude: null }],
    customer_geocode_reviews: review ? [{ customer_id: CUSTOMER, address_snapshot: JSON.parse(snapshot()), updated_at: '2026-11-01T00:00:00Z', ...review }] : [],
  };
}
const savedReview = () => mockTables.customer_geocode_reviews[0];

beforeEach(() => {
  process.env.GATE_GEOCODE_REVIEW = 'true';
  process.env.GATE_GEOCODE_COUNTY_FALLBACK = 'true';
  geocodeAddressWithStatus.mockReset().mockResolvedValue(PARTIAL);
  countyLotPinForAddress.mockReset().mockResolvedValue(LOT);
  seed();
});
afterAll(() => { delete process.env.GATE_GEOCODE_REVIEW; delete process.env.GATE_GEOCODE_COUNTY_FALLBACK; });

describe('attemptReviewedGeocode with the county fallback', () => {
  test.each(['partial_match', 'no_result', 'coarse_result:route'])('Google %s plus a county lot saves a county_parcel pin', async (reason) => {
    geocodeAddressWithStatus.mockResolvedValue({ location: null, permanent: true, reason });
    const onCoordinatesCommitted = jest.fn();
    await expect(attemptReviewedGeocode(CUSTOMER, undefined, { onCoordinatesCommitted })).resolves.toEqual({ lat: 27.58, lng: -82.42 });
    expect(mockTables.customers[0]).toMatchObject({ latitude: 27.58, longitude: -82.42 });
    expect(mockTables.customer_properties[0]).toMatchObject({ latitude: 27.58, longitude: -82.42 });
    expect(savedReview()).toMatchObject({ status: 'geocoded', reason: 'county_parcel', source: 'county_parcel', latitude: 27.58, longitude: -82.42 });
    expect(JSON.parse(savedReview().evidence)).toEqual({ county: 'Manatee', parcel_id: '1000', checked_at: expect.any(String) });
    expect(onCoordinatesCommitted).toHaveBeenCalledTimes(1);
  });

  test('no lot keeps needs_pin and records when the county was checked', async () => {
    countyLotPinForAddress.mockResolvedValue(null);
    await expect(attemptReviewedGeocode(CUSTOMER)).resolves.toBeNull();
    expect(savedReview()).toMatchObject({ status: 'needs_pin', reason: 'partial_match', source: 'google' });
    expect(JSON.parse(savedReview().evidence)).toEqual({ county_checked_at: expect.any(String) });
    expect(mockTables.customers[0].latitude).toBeNull();
  });

  test('a county outage leaves today\'s outcome: needs_pin with no county evidence', async () => {
    countyLotPinForAddress.mockRejectedValue(new Error('county down'));
    await expect(attemptReviewedGeocode(CUSTOMER)).resolves.toBeNull();
    expect(savedReview()).toMatchObject({ status: 'needs_pin', reason: 'partial_match', evidence: null });
    expect(mockTables.customers[0].latitude).toBeNull();
  });

  test('gate off: no county call, today\'s needs_pin outcome', async () => {
    delete process.env.GATE_GEOCODE_COUNTY_FALLBACK;
    await expect(attemptReviewedGeocode(CUSTOMER)).resolves.toBeNull();
    expect(countyLotPinForAddress).not.toHaveBeenCalled();
    expect(savedReview()).toMatchObject({ status: 'needs_pin', reason: 'partial_match', source: 'google', evidence: null });
  });

  test.each([
    ['a transient provider failure', { location: null, permanent: false, reason: 'provider_unavailable' }],
    ['outside the service area', { location: null, permanent: true, reason: 'outside_service_area' }],
  ])('%s never asks the county', async (_name, result) => {
    geocodeAddressWithStatus.mockResolvedValue(result);
    await attemptReviewedGeocode(CUSTOMER);
    expect(countyLotPinForAddress).not.toHaveBeenCalled();
  });

  test('an incomplete address never asks the county', async () => {
    mockTables.customers[0].city = '';
    await attemptReviewedGeocode(CUSTOMER);
    expect(countyLotPinForAddress).not.toHaveBeenCalled();
    expect(savedReview().status).toBe('needs_details');
  });

  test('a Google pin is untouched by the fallback', async () => {
    geocodeAddressWithStatus.mockResolvedValue({ location: { lat: 27.5, lng: -82.5 }, permanent: false });
    await expect(attemptReviewedGeocode(CUSTOMER)).resolves.toEqual({ lat: 27.5, lng: -82.5 });
    expect(countyLotPinForAddress).not.toHaveBeenCalled();
    expect(savedReview()).toMatchObject({ status: 'geocoded', reason: 'provider_match', source: 'google', evidence: null });
  });

  test('an address edited during the county call writes nothing', async () => {
    countyLotPinForAddress.mockImplementation(async () => { mockTables.customers[0].address_line1 = '1 Other Way'; return LOT; });
    await expect(attemptReviewedGeocode(CUSTOMER)).resolves.toBeNull();
    expect(mockTables.customers[0].latitude).toBeNull();
    expect(savedReview()).toBeUndefined();
  });
});

describe('retryCountyNeedsPin', () => {
  // The candidate query is SQL; these tests feed it rows and check what the pass does with them.
  // `rows`, or `{ pages }` served by the query's offset (10 rows a page).
  function withCandidates(rows) {
    const db = require('../models/db');
    const real = db.getMockImplementation();
    const bindings = [];
    const offsets = [];
    db.mockImplementation((table) => {
      if (!String(table).includes(' as r')) return real(table);
      let offset = 0;
      const chain = new Proxy({}, { get: (_t, op) => op === 'then' ? (resolve) => resolve(rows.pages ? rows.pages[offset / 10] || [] : rows)
        : (...args) => {
          if (op === 'whereRaw') bindings.push(args[1]);
          if (op === 'offset') { offset = args[0]; offsets.push(offset); }
          return chain;
        } });
      return chain;
    });
    return { bindings, offsets, restore: () => db.mockImplementation(real) };
  }
  const needsPin = (evidence = null) => ({ status: 'needs_pin', reason: 'partial_match', source: 'google', evidence, updated_at: '2026-11-01T00:00:00Z' });

  test('a lot pins the customer exactly like the first attempt', async () => {
    seed({ review: needsPin() });
    const queue = withCandidates([{ customer_id: CUSTOMER }]);
    const result = await retryCountyNeedsPin({ now: NOW });
    queue.restore();
    expect(result).toEqual({ checked: 1, pinned: 1, customerIds: [CUSTOMER] });
    expect(mockTables.customers[0]).toMatchObject({ latitude: 27.58, longitude: -82.42 });
    expect(mockTables.customer_properties[0]).toMatchObject({ latitude: 27.58, longitude: -82.42 });
    expect(savedReview()).toMatchObject({ status: 'geocoded', reason: 'county_parcel', source: 'county_parcel' });
    expect(geocodeAddressWithStatus).not.toHaveBeenCalled();
  });

  test('a miss only records the check and keeps the review as it was', async () => {
    seed({ review: needsPin() });
    countyLotPinForAddress.mockResolvedValue(null);
    const queue = withCandidates([{ customer_id: CUSTOMER }]);
    const result = await retryCountyNeedsPin({ now: NOW });
    queue.restore();
    expect(result).toEqual({ checked: 1, pinned: 0, customerIds: [] });
    expect(savedReview()).toMatchObject({ status: 'needs_pin', reason: 'partial_match', source: 'google' });
    expect(JSON.parse(savedReview().evidence)).toEqual({ county_checked_at: expect.any(String) });
    expect(mockTables.customers[0].latitude).toBeNull();
  });

  test('an outage writes nothing', async () => {
    seed({ review: needsPin() });
    countyLotPinForAddress.mockRejectedValue(new Error('county down'));
    const queue = withCandidates([{ customer_id: CUSTOMER }]);
    const result = await retryCountyNeedsPin({ now: NOW });
    queue.restore();
    expect(result.checked).toBe(0);
    expect(savedReview().evidence).toBeNull();
  });

  test('a county check inside the last 7 days is skipped; an older one is retried', async () => {
    const recent = JSON.stringify({ county_checked_at: '2026-10-30T12:00:00.000Z' });
    seed({ review: needsPin(recent) });
    let queue = withCandidates([{ customer_id: CUSTOMER }]);
    expect((await retryCountyNeedsPin({ now: NOW })).checked).toBe(0);
    expect(queue.bindings.flat()).toContain('2026-10-26T12:00:00.000Z'); // the SQL cutoff is now minus 7 days
    queue.restore();
    expect(countyLotPinForAddress).not.toHaveBeenCalled();

    seed({ review: needsPin(JSON.stringify({ county_checked_at: '2026-10-20T12:00:00.000Z' })) });
    countyLotPinForAddress.mockResolvedValue(null);
    queue = withCandidates([{ customer_id: CUSTOMER }]);
    expect((await retryCountyNeedsPin({ now: NOW })).checked).toBe(1);
    queue.restore();
  });

  test.each([
    ['the address changed since the review', () => { mockTables.customers[0].address_line1 = '1 Other Way'; }],
    ['staff reviewed it', () => { savedReview().reviewed_by = 'staff-1'; }],
    ['the customer already has a pin', () => { mockTables.customers[0].latitude = 27.5; mockTables.customers[0].longitude = -82.5; }],
  ])('%s: skipped', async (_name, change) => {
    seed({ review: needsPin() });
    change();
    const queue = withCandidates([{ customer_id: CUSTOMER }]);
    expect((await retryCountyNeedsPin({ now: NOW })).checked).toBe(0);
    queue.restore();
    expect(countyLotPinForAddress).not.toHaveBeenCalled();
  });

  test('rows that no longer qualify do not hold back later ones', async () => {
    seed({ review: needsPin() });
    const gone = [...new Array(10)].map((_, i) => ({ customer_id: `gone-${i}` })); // deleted customers: skipped
    const queue = withCandidates({ pages: [gone, [{ customer_id: CUSTOMER }]] });
    const result = await retryCountyNeedsPin({ now: NOW });
    queue.restore();
    expect(queue.offsets).toEqual([0, 10]);
    expect(result).toEqual({ checked: 1, pinned: 1, customerIds: [CUSTOMER] });
    expect(countyLotPinForAddress).toHaveBeenCalledTimes(1);
  });

  test('a county outage ends the run after the first failed lookup', async () => {
    seed({ review: needsPin() });
    countyLotPinForAddress.mockRejectedValue(new Error('county down'));
    const queue = withCandidates([{ customer_id: CUSTOMER }, { customer_id: CUSTOMER }]);
    expect((await retryCountyNeedsPin({ now: NOW })).checked).toBe(0);
    queue.restore();
    expect(countyLotPinForAddress).toHaveBeenCalledTimes(1);
  });

  test('gate off: the query never runs', async () => {
    delete process.env.GATE_GEOCODE_COUNTY_FALLBACK;
    const db = require('../models/db');
    db.mockClear();
    expect(await retryCountyNeedsPin({ now: NOW })).toEqual({ checked: 0, pinned: 0, customerIds: [] });
    expect(db).not.toHaveBeenCalled();
  });
});
