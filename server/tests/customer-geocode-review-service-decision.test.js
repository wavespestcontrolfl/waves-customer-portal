const { serviceReviewDecision } = require('../services/customer-geocode-review');

const review = {
  customer_id: 'customer-1',
  primary_property_id: 'primary-1',
  primary_address_matches_review: true,
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
