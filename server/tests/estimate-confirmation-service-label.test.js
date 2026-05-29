const { confirmationServiceLabel, bookingServiceFor } = require('../routes/estimate-public');

describe('post-booking confirmation SMS service label', () => {
  test('names the specific one-time service the customer scheduled', () => {
    // bookingServiceFor collapses roach/specialty into the generic bucket
    // for /book link routing — the confirmation copy must NOT use that.
    expect(bookingServiceFor('German Roach Cleanout — 3 Visit Program').label).toBe('Pest Control');

    const oneTimeList = [{ service: 'german_roach', name: 'German Roach Cleanout', price: 450 }];
    expect(confirmationServiceLabel(oneTimeList, { service_interest: 'German Roach Cleanout' }, 'Pest Control'))
      .toBe('German Roach Cleanout');
  });

  test('falls back to estimate service_interest when the one-time row has no name', () => {
    expect(confirmationServiceLabel([{ service: 'pest_initial_roach' }], { service_interest: 'Standalone Cockroach Treatment' }, 'Pest Control'))
      .toBe('Standalone Cockroach Treatment');
  });

  test('falls back to the bucket label when nothing specific is available', () => {
    expect(confirmationServiceLabel([], {}, 'Pest Control')).toBe('Pest Control');
    expect(confirmationServiceLabel(undefined, null, 'Lawn Care')).toBe('Lawn Care');
  });

  test('normalizes whitespace in the chosen label', () => {
    expect(confirmationServiceLabel([{ name: '  German   Roach\tCleanout ' }], {}, 'Pest Control'))
      .toBe('German Roach Cleanout');
  });
});
