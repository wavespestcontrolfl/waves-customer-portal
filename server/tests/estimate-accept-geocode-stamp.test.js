/**
 * stampAcceptedVisitCoordinates (Codex P1, PR #5064, estimate-public.js:12606
 * "Stamp accepted visits with the authoritative reviewed pin") — extracted
 * from the accept route's post-commit, fire-and-forget geocode stamp so it
 * can be driven directly without the whole accept transaction.
 *
 * The bug: when GATE_GEOCODE_REVIEW is on and the customer has a verified
 * review (or a matching pinned primary property), excludeCustomerAutomaticGeocodeForId
 * fenced the scheduled_services UPDATE itself, making it affect ZERO rows
 * for exactly the customers this lane exists to serve — their accepted
 * visits stayed coordless and invisible to route scoring. The fix drops
 * that fence from the visit write (it already stamps the AUTHORITATIVE
 * reviewed pin, proven same-place as the estimate address, never an
 * automatic overwrite) while keeping it on the customers-table repair
 * write.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'estimate-geocode-stamp-test-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockGeocodeAddress = jest.fn();
jest.mock('../services/geocoder', () => ({
  geocodeAddress: (...args) => mockGeocodeAddress(...args),
  buildAddress: (c) => [c.address_line1, c.city, c.state, c.zip].filter(Boolean).join(', '),
}));

const mockHaversine = jest.fn();
jest.mock('../services/route-optimizer', () => ({
  haversine: (...args) => mockHaversine(...args),
}));

const { stampAcceptedVisitCoordinates } = require('../routes/estimate-public');

const ESTIMATE = { id: 'est-1', address: '1 Main St, Bradenton, FL 34205' };
const CUSTOMER_ID = 'cust-1';

// A tiny fake knex: records every update, answers `first()` from a fixed
// customer row, and runs `transaction`/withCustomerReviewWriteFence's
// callback against itself (same "no separate connection" convention the
// bigger fixtures in this suite use).
// `customerRow` / `reviewRow` / `primaryRow` may each be a plain value OR a
// function returning one — a function lets a test simulate a race by
// answering differently once the fence's OWN re-read runs than it did for
// the initial pre-lock read (same order stampAcceptedVisitCoordinates
// actually issues its queries in: db('customers') first, then
// conn('customers') again inside the fence).
function makeFakeDb({ customerRow, reviewRow = null, primaryRow = null } = {}) {
  const updateCalls = [];
  const resolve = (v) => (typeof v === 'function' ? v() : v);
  // Projects onto exactly the fields the production code asks `.first(...)`
  // for — a real knex `.first('a', 'b')` never returns a column that
  // wasn't selected, so a test that fixed a row with every field present
  // regardless of the select list could never catch a production SELECT
  // that quietly dropped one (Codex P1: address_line2 omitted from this
  // route's own customer reads).
  const project = (row, fields) => {
    if (!row || !fields.length) return row;
    const out = {};
    fields.forEach((f) => { out[f] = row[f]; });
    return out;
  };
  const chain = (table) => {
    const q = { table, conds: {} };
    q.where = (cond) => { if (cond && typeof cond === 'object') Object.assign(q.conds, cond); return q; };
    q.whereNull = () => q;
    q.orderBy = () => q;
    q.forUpdate = () => q;
    q.forShare = () => q;
    q.noWait = () => q;
    q.select = () => q;
    q.whereNotExists = () => q;
    q.first = async (...fields) => {
      if (table === 'customers') return project(resolve(customerRow), fields);
      if (table === 'customer_geocode_reviews') return resolve(reviewRow);
      if (table === 'customer_properties') return resolve(primaryRow);
      return null;
    };
    q.update = async (payload) => { updateCalls.push({ table, conds: { ...q.conds }, payload }); return 1; };
    return q;
  };
  const dbFn = (table) => chain(table);
  dbFn.updateCalls = updateCalls;
  dbFn.transaction = async (fn) => fn(dbFn);
  return dbFn;
}

beforeEach(() => {
  process.env.GATE_GEOCODE_REVIEW = 'true';
  mockGeocodeAddress.mockReset();
  mockHaversine.mockReset();
  mockHaversine.mockReturnValue(0); // "same place" by default
});

afterEach(() => {
  delete process.env.GATE_GEOCODE_REVIEW;
});

test('a customer whose PRIMARY property mirrors an authoritative pin (different from the raw stored one) gets their accepted visit stamped with THAT pin, not fenced to zero rows', async () => {
  // No customer_geocode_reviews row — the "authoritative" pin here comes
  // from the mirrored primary property (effectiveCustomer), same as
  // reviewedCustomerLocation's other non-review-backed callers. This is
  // exactly the shape excludeCustomerAutomaticGeocodeForId's SECOND clause
  // (the "matching primary pin" exclusion) fences — before the fix, the
  // scheduled_services UPDATE below would have matched ZERO rows.
  const customerRow = {
    address_line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205',
    latitude: 27.40, longitude: -82.40, // stale raw pin
  };
  const primaryRow = {
    customer_id: CUSTOMER_ID, active: true, is_primary: true,
    address_line1: '1 Main St', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205',
    latitude: 27.51, longitude: -82.52, // authoritative mirrored pin
  };
  const db = makeFakeDb({ customerRow, primaryRow });
  mockGeocodeAddress.mockResolvedValueOnce({ lat: 27.4, lng: -82.5 }); // the estimate address

  await stampAcceptedVisitCoordinates({ estimate: ESTIMATE, customerId: CUSTOMER_ID, db });

  const visitUpdate = db.updateCalls.find((c) => c.table === 'scheduled_services');
  expect(visitUpdate).toBeTruthy();
  expect(visitUpdate.conds).toEqual({ source_estimate_id: ESTIMATE.id });
  // The AUTHORITATIVE reviewed pin (27.51/-82.52), never the estimate's own
  // freshly geocoded coordinates (27.4/-82.5) — Codex's "use the pin
  // returned by reviewedCustomerLocation for the visit stamp".
  expect(visitUpdate.payload).toEqual({ lat: 27.51, lng: -82.52 });
});

test('reviewedCustomerLocation blocked (e.g. needs_pin) → no visit write at all, fail-soft', async () => {
  const customerRow = {
    address_line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205',
    latitude: null, longitude: null,
  };
  const reviewRow = {
    customer_id: CUSTOMER_ID, status: 'needs_pin',
    address_snapshot: ['1 Main St', null, 'Bradenton', 'FL', '34205'],
    latitude: null, longitude: null, updated_at: new Date(),
  };
  const db = makeFakeDb({ customerRow, reviewRow });
  mockGeocodeAddress.mockResolvedValueOnce({ lat: 27.4, lng: -82.5 });

  await stampAcceptedVisitCoordinates({ estimate: ESTIMATE, customerId: CUSTOMER_ID, db });

  expect(db.updateCalls).toEqual([]);
});

// Codex P1 round 2 (fallback auditor, 2026-09-28): custCoords is read
// BEFORE any lock. This proves a staff outside_area/needs_pin decision that
// lands between that read and the fence's own row-lock acquisition — the
// exact window this async, fire-and-forget stamp can be blocked inside —
// is never overwritten: the write re-derives the reviewed pin under the
// SAME locked connection and skips the write once it sees the fresh block.
test('TOCTOU: a review that turns blocking AFTER the pre-lock read is never overwritten', async () => {
  const customerRow = {
    address_line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205',
    latitude: null, longitude: null,
  };
  let reviewCalls = 0;
  const reviewRow = () => {
    reviewCalls += 1;
    // Call 1 = the pre-lock read inside reviewedCustomerLocation (no review
    // yet). Call 2 = stampAcceptedVisitCoordinates's fresh re-read INSIDE
    // the fence, after a staff outside_area decision has since landed.
    if (reviewCalls === 1) return null;
    return {
      customer_id: CUSTOMER_ID, status: 'outside_area',
      address_snapshot: ['1 Main St', null, 'Bradenton', 'FL', '34205'],
      latitude: null, longitude: null, updated_at: new Date(),
    };
  };
  const db = makeFakeDb({ customerRow, reviewRow });
  mockGeocodeAddress
    .mockResolvedValueOnce({ lat: 27.4, lng: -82.5 }) // the estimate address
    .mockResolvedValueOnce({ lat: 27.41, lng: -82.51 }); // pre-lock: no review, no stored pin — geocoded directly

  await stampAcceptedVisitCoordinates({ estimate: ESTIMATE, customerId: CUSTOMER_ID, db });

  // Nothing is written — NOT the stale pre-lock coordinates (27.41/-82.51),
  // which is exactly what a staff outside_area decision just rejected.
  expect(db.updateCalls).toEqual([]);
});

test('an ordinary customer (no review at all) still gets stamped — GATE_GEOCODE_REVIEW off is unaffected', async () => {
  process.env.GATE_GEOCODE_REVIEW = 'false';
  const customerRow = {
    address_line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205',
    latitude: 27.4, longitude: -82.5,
  };
  const db = makeFakeDb({ customerRow });
  mockGeocodeAddress.mockResolvedValueOnce({ lat: 27.4, lng: -82.5 });

  await stampAcceptedVisitCoordinates({ estimate: ESTIMATE, customerId: CUSTOMER_ID, db });

  const visitUpdate = db.updateCalls.find((c) => c.table === 'scheduled_services');
  expect(visitUpdate.payload).toEqual({ lat: 27.4, lng: -82.5 });
});

// Codex P1, PR #5064 round 3: "Load the unit field before rechecking the
// quarantine". Both customer reads this function issues must select
// address_line2 — a reviewed address with a nonempty unit whose read omits
// that field makes reviewedCustomerLocation's sameAddress() compare the
// review's real snapshot against an undefined address_line2 and treat it
// as a DIFFERENT (never-reviewed) address, silently clearing a
// needs_pin/needs_details/outside_area quarantine on exactly the
// customers it exists to protect.
test('a quarantined unit (nonempty address_line2) stays blocked — the customer read must select address_line2', async () => {
  const customerRow = {
    address_line1: '1 Main St', address_line2: 'Unit 5',
    city: 'Bradenton', state: 'FL', zip: '34205',
    latitude: null, longitude: null,
  };
  const reviewRow = {
    customer_id: CUSTOMER_ID, status: 'needs_pin',
    address_snapshot: ['1 Main St', 'Unit 5', 'Bradenton', 'FL', '34205'],
    latitude: null, longitude: null, updated_at: new Date(),
  };
  const db = makeFakeDb({ customerRow, reviewRow });
  mockGeocodeAddress
    .mockResolvedValueOnce({ lat: 27.4, lng: -82.5 }) // the estimate address
    // Only reached if a dropped address_line2 wrongly clears the
    // quarantine and this function falls through to geocode the
    // customer's own (still-blocked) address — proves the test actually
    // discriminates the bug rather than passing via an early return for
    // an unrelated reason.
    .mockResolvedValueOnce({ lat: 27.9, lng: -82.9 });

  await stampAcceptedVisitCoordinates({ estimate: ESTIMATE, customerId: CUSTOMER_ID, db });

  // Blocked before ever reaching the visit write — a dropped address_line2
  // would make sameAddress() see a mismatch and fall through to
  // "effective" (not blocked), letting the unconditional update below
  // restore coordinates staff quarantined.
  expect(db.updateCalls).toEqual([]);
});

// Codex P1, PR #5064 round 3: "Revalidate the address before reusing
// pre-lock coordinates". custCoords is geocoded for the address on the
// PRE-LOCK read; if the customer's address is edited before the fenced
// re-read runs, that pin describes a property this customer no longer
// has — the fallback below must never carry it across the edit onto the
// NEW address's visits/customer row.
test('an address edited between the pre-lock read and the fence aborts instead of reusing the stale pre-lock coordinates', async () => {
  let customerReads = 0;
  const customerRow = () => {
    customerReads += 1;
    // Read 1: the pre-lock read custCoords is computed against.
    if (customerReads === 1) {
      return {
        address_line1: '1 Main St', address_line2: null,
        city: 'Bradenton', state: 'FL', zip: '34205',
        latitude: null, longitude: null,
      };
    }
    // Read 2: the fenced re-read, AFTER the customer edited their address —
    // still no stored coordinates for the new address.
    return {
      address_line1: '99 Oak Ave', address_line2: null,
      city: 'Bradenton', state: 'FL', zip: '34205',
      latitude: null, longitude: null,
    };
  };
  const db = makeFakeDb({ customerRow }); // no review row: not blocked either time
  mockGeocodeAddress
    .mockResolvedValueOnce({ lat: 27.4, lng: -82.5 }) // the estimate address
    .mockResolvedValueOnce({ lat: 27.41, lng: -82.51 }); // pre-lock geocode of "1 Main St" (custCoords)

  await stampAcceptedVisitCoordinates({ estimate: ESTIMATE, customerId: CUSTOMER_ID, db });

  // Nothing is written — NOT custCoords (27.41/-82.51), which describes the
  // OLD "1 Main St" address, not the customer's current "99 Oak Ave".
  expect(db.updateCalls).toEqual([]);
});
