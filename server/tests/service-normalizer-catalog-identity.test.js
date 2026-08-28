/**
 * Catalog services must display under their real name. The regex family map
 * collapsed 58 of 92 catalog rows — "Seasonal Mosquito Control Service"
 * rendered as "Mosquito Barrier Treatment" on the customer schedule and
 * admin views (owner report 2026-08-28), the same class as the 2026-07-30
 * "Waves Assessment" report.
 */

const { normalizeServiceType } = require('../utils/service-normalizer');
const { __setCatalogNamesForTest, refreshCatalogNames } = require('../services/service-catalog-names');

const CATALOG = [
  'Seasonal Mosquito Control Service',
  'Mosquito Control Service (Monthly)',
  'Termite Bond Service (10-Year Term)',
  'Rodent Trapping + Exclusion Service',
  'Lawn Care Program — Every 6 Weeks',
  'Quarterly Pest + Termite Bait Station Service',
  'Core Aeration Service',
];

describe('normalizeServiceType keeps catalog identities', () => {
  beforeEach(() => __setCatalogNamesForTest(CATALOG));
  afterAll(() => __setCatalogNamesForTest([]));

  test.each(CATALOG)('%s passes through verbatim', (name) => {
    expect(normalizeServiceType(name)).toBe(name);
  });

  test('case and price/duration suffixes do not break the match', () => {
    expect(normalizeServiceType('seasonal mosquito control service - 45 min - $45'))
      .toBe('Seasonal Mosquito Control Service');
  });

  test('non-catalog raw labels still normalize through the family map', () => {
    expect(normalizeServiceType('Pest Control Service - 1 hour - $117')).toBe('Pest Control Service');
    expect(normalizeServiceType('Property Assessment')).toBe('Waves Assessment');
  });
});

describe('family map ordering (unprimed cache)', () => {
  beforeAll(() => __setCatalogNamesForTest([]));

  test('mosquito cadence survives even without the catalog cache', () => {
    expect(normalizeServiceType('Seasonal Mosquito Control')).toBe('Seasonal Mosquito Control Service');
    expect(normalizeServiceType('Monthly Mosquito Control')).toBe('Mosquito Control Service (Monthly)');
    expect(normalizeServiceType('Mosquito Control')).toBe('Mosquito Barrier Treatment');
  });

  test('bare /rat/ no longer turns aeration into rodent control', () => {
    expect(normalizeServiceType('Core Aeration Service')).toBe('Lawn Aeration');
    expect(normalizeServiceType('Rat Control')).toBe('Rodent Control');
  });

  test('german roach is reachable ahead of the generic roach pattern', () => {
    expect(normalizeServiceType('German Roach Cleanout')).toBe('German Roach Treatment');
    expect(normalizeServiceType('Palmetto Roach Service')).toBe('Cockroach Treatment Service');
  });
});

describe('refreshCatalogNames aliasing', () => {
  afterAll(() => __setCatalogNamesForTest([]));

  test('short_name aliases only when one row owns it; full names always win', async () => {
    const rows = [
      { name: 'Lawn Care Program — Monthly', short_name: 'Lawn Care' },
      { name: 'Lawn Care Program — Quarterly', short_name: 'Lawn Care' },
      { name: 'Seasonal Mosquito Control Service', short_name: 'Seasonal Mosquito' },
      { name: 'Lawn Care', short_name: null },
    ];
    const conn = () => ({ select: async () => rows });
    await refreshCatalogNames(conn);
    // Ambiguous alias must not pick an arbitrary program.
    expect(normalizeServiceType('lawn care')).toBe('Lawn Care');
    expect(normalizeServiceType('Seasonal Mosquito')).toBe('Seasonal Mosquito Control Service');
  });
});
