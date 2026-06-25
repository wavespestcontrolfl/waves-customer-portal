const { plannedCity } = require('../scripts/backfill-blank-city-from-zip');

describe('backfill plannedCity', () => {
  test('fills a blank city from an in-service-area ZIP', () => {
    expect(plannedCity({ city: null, zip: '34219' })).toBe('Parrish');
    expect(plannedCity({ city: '', zip: '33950' })).toBe('Punta Gorda');
    expect(plannedCity({ city: '   ', zip: '34221' })).toBe('Palmetto'); // whitespace-only counts as blank
  });

  test('never overwrites an existing city', () => {
    expect(plannedCity({ city: 'Sarasota', zip: '34219' })).toBe('');
  });

  test('leaves out-of-area or missing ZIPs blank — no guessing', () => {
    expect(plannedCity({ city: '', zip: '90210' })).toBe('');
    expect(plannedCity({ city: null, zip: '' })).toBe('');
    expect(plannedCity({ city: null, zip: null })).toBe('');
  });
});
