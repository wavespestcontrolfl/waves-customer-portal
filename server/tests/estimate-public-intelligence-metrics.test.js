// "How your price was built" facts (owner 2026-10-20): every service on the
// estimate keeps its own tile. A pest + lawn + tree & shrub + mosquito estimate
// lost Treatable lawn behind the property facts under the old six-tile cap; one-
// and two-service estimates must stay exactly as they were.
const { buildWaveGuardIntelligencePayload } = require('../routes/estimate-public');

const labels = (payload) => payload.metrics.map((metric) => metric.label);

const inputs = {
  homeSqFt: 2400,
  lotSqFt: 9000,
  lawnSqFt: 5200,
  landscapeComplexity: 'MODERATE',
  pool: 'YES',
  poolCage: 'YES',
  poolCageSize: 'MEDIUM',
  bedArea: 1800,
  treeCount: 6,
  features: { nearWater: 'YES' },
  termitePerimeterFt: 190,
};
const build = (...names) => buildWaveGuardIntelligencePayload(
  { satelliteUrl: 'https://maps.example/satellite.png' },
  { inputs, result: { recurring: { services: names.map((name) => ({ name })) } } },
);

describe('Waves AI facts keep one tile per service', () => {
  test('pest + lawn + tree & shrub + mosquito: the lawn and pool/lanai tiles survive, in today\'s order', () => {
    const payload = build('Pest Control', 'Lawn Care', 'Tree & Shrub', 'Mosquito Control');
    expect(labels(payload)).toEqual(expect.arrayContaining(['Pool/Lanai', 'Treatable lawn', 'Ornamental beds', 'Near water']));
    expect(labels(payload)).toEqual(['Home', 'Lot', 'Near water', 'Pool/Lanai', 'Ornamental beds', 'Trees/Shrubs', 'Treatable lawn']);
    expect(payload.metrics.length).toBeLessThanOrEqual(8);
  });

  test('the old cap dropped Treatable lawn for this mix (the regression this guards)', () => {
    const payload = build('Pest Control', 'Lawn Care', 'Tree & Shrub', 'Mosquito Control');
    expect(payload.metrics.find((metric) => metric.label === 'Treatable lawn')).toEqual({ label: 'Treatable lawn', value: '5,200 sq ft' });
    expect(payload.metrics.length).toBeGreaterThan(6);
  });

  test('pest + lawn + mosquito keeps Pool/Lanai and Treatable lawn', () => {
    expect(labels(build('Pest Control', 'Lawn Care', 'Mosquito Control'))).toEqual(
      ['Home', 'Lot', 'Near water', 'Pool/Lanai', 'Treatable lawn'],
    );
  });

  test('five services show every fact the card can carry (eight)', () => {
    const payload = build('Pest Control', 'Tree & Shrub', 'Mosquito Control', 'Termite Bait Stations', 'Rodent Control');
    expect(payload.metrics.length).toBeLessThanOrEqual(8);
    expect(labels(payload)).toEqual(expect.arrayContaining(['Pool/Lanai', 'Ornamental beds', 'Near water', 'Termite perimeter']));
  });

  test('one- and two-service estimates are unchanged (six-tile cap, same order)', () => {
    expect(labels(build('Pest Control'))).toEqual(['Home', 'Lot', 'Pool/Lanai', 'Complexity']);
    expect(labels(build('Pest Control', 'Lawn Care'))).toEqual(['Home', 'Lot', 'Pool/Lanai', 'Treatable lawn']);
    expect(labels(build('Pest Control', 'Tree & Shrub'))).toEqual(['Home', 'Lot', 'Pool/Lanai', 'Ornamental beds', 'Trees/Shrubs', 'Complexity']);
    expect(labels(build('Tree & Shrub', 'Mosquito Control'))).toEqual(['Home', 'Lot', 'Near water', 'Ornamental beds', 'Trees/Shrubs', 'Complexity']);
    expect(labels(build('Lawn Care'))).toEqual(['Home', 'Lot', 'Treatable lawn']);
  });
});
