// /book offer location (Codex #4992 P1). createSelfBooking commits an existing
// customer's booking at its stored pin, else a staff-verified pin or the
// canonical geocode, and refuses an offer signed on any other grid cell — so
// /availability and /find-slots must build that customer's offers on the same
// pin (resolveOfferCoords → customerBookingLocation), or every retry of a
// customer whose verified pin the address geocoder never returns is refused.
// Table-keyed db mock: `.first()` answers firstResults[table], an awaited
// chain answers listResults[table].
const firstResults = {};
const listResults = {};
jest.mock('../models/db', () => {
  const mkChain = (table) => {
    const q = {};
    for (const m of ['where', 'andWhere', 'whereIn', 'whereNull', 'whereRaw', 'andWhereRaw', 'orWhere', 'orWhereRaw', 'select', 'limit']) {
      q[m] = (arg) => {
        if (typeof arg === 'function') arg.call(q, q);
        return q;
      };
    }
    q.first = async () => (firstResults[table] !== undefined ? firstResults[table] : null);
    q.then = (onOk, onErr) => Promise.resolve(listResults[table] || []).then(onOk, onErr);
    return q;
  };
  const dbFn = jest.fn((table) => mkChain(table));
  dbFn.raw = (sql) => sql;
  return dbFn;
});

const db = require('../models/db');
const geocoder = require('../services/geocoder');
const { resolveOfferCoords } = require('../routes/booking')._internals;

const CUSTOMER_ID = '5b8d1c9e-4a2f-4b6e-9c3d-8e7f6a5b4c3d';
const ESTIMATE_ID = '6c9e2d0f-5b3a-4c7f-8d4e-9f0a7b6c5d4e';
const ADDRESS = { address_line1: '123 Test Ave', address_line2: null, city: 'Sarasota', state: 'FL', zip: '34236' };
const TYPED = '123 Test Ave, Sarasota, FL 34236';
const CALLER = { lat: '27.3', lng: '-82.5' };
const customerRow = (pin = {}) => ({
  id: CUSTOMER_ID, latitude: null, longitude: null, ...ADDRESS, ...pin,
});

let savedReviewGate;
beforeEach(() => {
  savedReviewGate = process.env.GATE_GEOCODE_REVIEW;
  process.env.GATE_GEOCODE_REVIEW = 'true';
  db.mockClear();
});
afterEach(() => {
  for (const key of Object.keys(firstResults)) delete firstResults[key];
  for (const key of Object.keys(listResults)) delete listResults[key];
  if (savedReviewGate === undefined) delete process.env.GATE_GEOCODE_REVIEW;
  else process.env.GATE_GEOCODE_REVIEW = savedReviewGate;
  jest.restoreAllMocks();
});

test('an estimate\'s coordinate-less customer is offered at its staff-verified pin — over caller coordinates, never echoed exactly', async () => {
  const verifiedPin = { lat: 27.40123, lng: -82.50123 };
  firstResults.estimates = { customer_id: CUSTOMER_ID };
  firstResults.customers = customerRow();
  listResults.customer_geocode_reviews = [{
    customer_id: CUSTOMER_ID, status: 'verified', latitude: verifiedPin.lat, longitude: verifiedPin.lng,
    address_snapshot: [ADDRESS.address_line1, ADDRESS.address_line2, ADDRESS.city, ADDRESS.state, ADDRESS.zip],
  }];
  const geocode = jest.spyOn(geocoder, 'geocodeAddress');

  await expect(resolveOfferCoords({ ...CALLER, address: TYPED, estimate_id: ESTIMATE_ID }))
    .resolves.toEqual({ ...verifiedPin, disclosable: false });
  expect(geocode).not.toHaveBeenCalled();
});

test('a typed address that uniquely matches a returning customer is offered at that customer\'s stored pin', async () => {
  const storedPin = { lat: 27.35, lng: -82.52 };
  listResults.customers = [{ id: CUSTOMER_ID, ...ADDRESS }];
  firstResults.customers = customerRow({ latitude: storedPin.lat, longitude: storedPin.lng });

  await expect(resolveOfferCoords({ ...CALLER, address: TYPED }))
    .resolves.toEqual({ ...storedPin, disclosable: false });
});

test('a new visitor (no estimate, no matching customer) keeps the caller\'s own coordinates, disclosable', async () => {
  listResults.customers = [];

  await expect(resolveOfferCoords({ ...CALLER, address: TYPED }))
    .resolves.toEqual({ lat: 27.3, lng: -82.5, disclosable: true });
});

test('a malformed estimate_id is never queried', async () => {
  listResults.customers = [];

  await expect(resolveOfferCoords({ ...CALLER, address: TYPED, estimate_id: 'not-a-uuid' }))
    .resolves.toEqual({ lat: 27.3, lng: -82.5, disclosable: true });
  expect(db.mock.calls.map(([table]) => table)).not.toContain('estimates');
});
