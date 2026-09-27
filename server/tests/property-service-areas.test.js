const areas = require('../services/property-service-areas');
const { addressKey } = require('../services/customer-properties');

test.each([null, [], {}, { other: { sqft: 100, source: 'field' } },
  { beds: { sqft: '100', source: 'field' } }, { beds: { sqft: -1, source: 'field' } },
  { beds: { sqft: 0.5, source: 'field' } }, { beds: { sqft: 1000001, source: 'field' } },
  { beds: { sqft: 100, source: 'unknown' } }])('rejects invalid review payload %j', input => {
  expect(() => areas.validateAreaChanges(input)).toThrow();
});
test('the review writer accepts zero and rejects client review stamps', () => {
  expect(areas.validateAreaChanges({ beds: { sqft: 0, source: 'imagery', reviewedAt: 'fake', reviewedBy: 'fake' } }))
    .toEqual({ beds: { sqft: 0, source: 'imagery' } });
});
test('missing/unknown or unobservable turf is not an observed zero', () => {
  expect(areas.lookupSuggestions({ estimatedTurfSf: 0, turfSource: 'none' })).toEqual({});
  expect(areas.lookupSuggestions({ estimatedTurfSf: 1000, turfSource: 'vision', turfObservation: 'unobservable' })).toEqual({});
  expect(areas.lookupSuggestions({ estimatedTurfSf: 0, turfSource: 'vision' }).lawn.sqft).toBe(0);
});
test('a changed legacy bed measurement withdraws the review instead of attaching it to the new value', () => {
  const property = { id: 'property', address_line1: '100 Fixture St', city: 'Fixture', zip: '34201', bed_sqft: 600 };
  property.service_area_measurements = { addressKey: addressKey(property), areas: { beds: { sqft: 500, source: 'field', reviewedBy: 'staff', reviewedAt: '2026-09-27' } } };
  expect(areas.reviewedAreas(property)).toEqual({});
});
test('the gate is opt-in, including tests and development', async () => {
  delete process.env.GATE_PROPERTY_SERVICE_AREAS;
  expect(areas.propertyServiceAreasEnabled()).toBe(false);
  await expect(areas.snapshotVisitArea({ malformed: true })).resolves.toBeNull();
});
