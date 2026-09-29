/**
 * reviewedCustomerLocation's `verified_by_review` flag (Codex P1, PR #5064,
 * inspection-public.js:1773 "Retain coordinates only when backed by a
 * review"). A caller must be able to tell "this pin is backed by a staff-
 * verified review" apart from "this pin is just whatever coordinates the
 * customer/primary row happens to have" — before this flag, both cases
 * returned indistinguishable latitude/longitude fields.
 */
jest.mock('../models/db', () => jest.fn());

const { reviewedCustomerLocation } = require('../services/customer-geocode-review');

function makeConn({ review = null, primary = null } = {}) {
  return (table) => ({
    where() { return this; },
    first: async () => {
      if (table === 'customer_geocode_reviews') return review;
      if (table === 'customer_properties') return primary;
      return null;
    },
  });
}

const CUSTOMER = {
  id: 'c-1',
  address_line1: '1 Main St',
  address_line2: null,
  city: 'Bradenton',
  state: 'FL',
  zip: '34205',
  latitude: 27.5,
  longitude: -82.5,
};

beforeEach(() => {
  process.env.GATE_GEOCODE_REVIEW = 'true';
});

afterEach(() => {
  delete process.env.GATE_GEOCODE_REVIEW;
});

test('a verified review matching the address and pin is flagged verified_by_review', async () => {
  const review = {
    customer_id: 'c-1',
    address_snapshot: ['1 Main St', null, 'Bradenton', 'FL', '34205'],
    status: 'verified',
    latitude: 27.5,
    longitude: -82.5,
    updated_at: new Date(),
  };
  const result = await reviewedCustomerLocation(CUSTOMER, makeConn({ review }));
  expect(result.verified_by_review).toBe(true);
  expect(result.latitude).toBe(27.5);
  expect(result.longitude).toBe(-82.5);
});

test('ordinary stored coordinates with NO review row are not flagged verified_by_review', async () => {
  const result = await reviewedCustomerLocation(CUSTOMER, makeConn({ review: null }));
  expect(result.verified_by_review).toBeUndefined();
  expect(result.latitude).toBe(27.5);
});

test('a "geocoded" (automatic, unreviewed) status pin is not flagged verified_by_review', async () => {
  const review = {
    customer_id: 'c-1',
    address_snapshot: ['1 Main St', null, 'Bradenton', 'FL', '34205'],
    status: 'geocoded',
    latitude: null,
    longitude: null,
    updated_at: new Date(),
  };
  const result = await reviewedCustomerLocation(CUSTOMER, makeConn({ review }));
  expect(result.verified_by_review).toBeUndefined();
  expect(result.latitude).toBe(27.5);
});

test('a blocked (needs_pin) review carries no verified_by_review flag either', async () => {
  const review = {
    customer_id: 'c-1',
    address_snapshot: ['1 Main St', null, 'Bradenton', 'FL', '34205'],
    status: 'needs_pin',
    latitude: null,
    longitude: null,
    updated_at: new Date(),
  };
  const result = await reviewedCustomerLocation(CUSTOMER, makeConn({ review }));
  expect(result.geocode_review_blocked).toBe(true);
  expect(result.verified_by_review).toBeUndefined();
});
