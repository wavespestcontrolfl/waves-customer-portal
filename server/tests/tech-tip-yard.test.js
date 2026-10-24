/**
 * The yard the tip picker matches against (tips with facts, owner
 * 2026-10-24): grass and whether it can be trusted, irrigation, county and
 * city. Every read is soft; an unknown fact stays null.
 */
jest.mock('../services/lawn-grass-context', () => ({
  ...jest.requireActual('../services/lawn-grass-context'),
  loadCustomerGrassContext: jest.fn(),
}));

const { loadCustomerGrassContext } = require('../services/lawn-grass-context');
const { loadTechTipYard } = require('../services/service-report/tech-tip-yard');

const grass = (overrides) => ({ grassType: 'st_augustine', grassTypeLabel: 'St. Augustine', grassTypeSource: 'staff', irrigationSystem: 'in_ground', ...overrides });

describe('loadTechTipYard', () => {
  test('a staff-set grass, an in-ground system and a whole-county city', async () => {
    loadCustomerGrassContext.mockResolvedValue(grass());
    await expect(loadTechTipYard({}, { customerId: 'c1', city: 'Venice' })).resolves.toEqual({
      grass: 'st_augustine', grassTrusted: true, grassLabel: 'St. Augustine', irrigationSystem: true, county: 'Sarasota', city: 'venice',
    });
  });

  test('a grass from the estimate, or set before the source column existed, is trusted', async () => {
    loadCustomerGrassContext.mockResolvedValue(grass({ grassTypeSource: 'estimate' }));
    expect((await loadTechTipYard({}, { customerId: 'c1' })).grassTrusted).toBe(true);
    loadCustomerGrassContext.mockResolvedValue(grass({ grassTypeSource: null }));
    expect((await loadTechTipYard({}, { customerId: 'c1' })).grassTrusted).toBe(true);
  });

  test('a photo read, a customer record, or a mixed lawn is not', async () => {
    for (const overrides of [{ grassTypeSource: 'photo_ai' }, { grassTypeSource: 'customer_record' }, { grassType: 'mixed' }, { grassType: null }]) {
      loadCustomerGrassContext.mockResolvedValue(grass(overrides));
      expect((await loadTechTipYard({}, { customerId: 'c1' })).grassTrusted).toBe(false);
    }
  });

  test('irrigation: manual or none is no system; anything unrecorded is unknown', async () => {
    loadCustomerGrassContext.mockResolvedValue(grass({ irrigationSystem: 'manual' }));
    expect((await loadTechTipYard({}, { customerId: 'c1' })).irrigationSystem).toBe(false);
    loadCustomerGrassContext.mockResolvedValue(grass({ irrigationSystem: null }));
    expect((await loadTechTipYard({}, { customerId: 'c1' })).irrigationSystem).toBe(null);
  });

  test('a straddling city has no county (fail closed); a failed read leaves everything unknown', async () => {
    loadCustomerGrassContext.mockRejectedValue(new Error('db down'));
    await expect(loadTechTipYard({}, { customerId: 'c1', city: 'Lakewood Ranch' })).resolves.toEqual({
      grass: null, grassTrusted: false, grassLabel: null, irrigationSystem: null, county: null, city: 'lakewood ranch',
    });
  });
});
