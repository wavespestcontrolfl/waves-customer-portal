const { needsCoordinatePairRepair, serviceReviewDecision } = require('../services/customer-geocode-review');

const review = {
  customer_id: 'customer-1',
  primary_property_id: 'primary-1',
  primary_address_matches_review: true,
  primary_pin_matches_review: true,
  address_snapshot: ['100 Primary Way', null, 'Bradenton', 'FL', '34205'],
  status: 'outside_area',
  latitude: null,
  longitude: null,
};

const staleService = {
  customer_id: 'customer-1',
  property_id: 'primary-1',
  service_address_line1: '999 Frozen Snapshot Lane',
  service_address_line2: null,
  service_address_city: 'Bradenton',
  service_address_state: 'FL',
  service_address_zip: '34205',
};

test('an explicit primary-property link owns the review even when its frozen stamp differs', () => {
  expect(serviceReviewDecision(staleService, review)).toEqual({
    location: null, permanent: true, reason: 'address_review_required',
  });
});

test('a different property remains independent of the primary review', () => {
  expect(serviceReviewDecision({ ...staleService, property_id: 'secondary-1' }, review)).toBeNull();
});

test('a primary link does not revive a review for an earlier primary address', () => {
  expect(serviceReviewDecision(staleService, {
    ...review, primary_address_matches_review: false,
  })).toBeNull();
});

test('a verified primary pin is not reused for a divergent frozen appointment stamp', () => {
  expect(serviceReviewDecision(staleService, {
    ...review, status: 'verified', latitude: 27.5, longitude: -82.5,
  })).toBeNull();
});

test('a verified primary pin remains reusable for the reviewed appointment address', () => {
  expect(serviceReviewDecision({
    ...staleService,
    service_address_line1: '100 Primary Way',
  }, {
    ...review, status: 'verified', latitude: 27.5, longitude: -82.5,
  })).toEqual({ location: { lat: 27.5, lng: -82.5 }, permanent: false });
});

test('a verified pin blocks when the matching primary pin changed', () => {
  expect(serviceReviewDecision({
    ...staleService,
    service_address_line1: '100 Primary Way',
  }, {
    ...review, status: 'verified', latitude: 27.5, longitude: -82.5, primary_pin_matches_review: false,
  })).toEqual({ location: null, permanent: true, reason: 'address_review_required' });
});

test.each([
  [{ latitude: null, longitude: null }, true],
  [{ latitude: 27.5, longitude: null }, true],
  [{ latitude: null, longitude: -82.5 }, true],
  [{ latitude: 27.5, longitude: -82.5 }, false],
])('automatic writers repair incomplete coordinate pairs for %p', (location, expected) => {
  expect(needsCoordinatePairRepair(location)).toBe(expected);
});
