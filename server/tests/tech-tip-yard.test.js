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

// A knex fake answering the property_preferences read (null: no row).
const prefsKnex = (row = null) => () => ({ where: () => ({ first: async () => row }) });
const grass = (overrides) => ({ grassType: 'st_augustine', grassTypeLabel: 'St. Augustine', grassTypeSource: 'staff', irrigationSystem: 'in_ground', ...overrides });

describe('loadTechTipYard', () => {
  test('a staff-set grass, an in-ground system and a whole-county city', async () => {
    loadCustomerGrassContext.mockResolvedValue(grass());
    await expect(loadTechTipYard(prefsKnex(), { customerId: 'c1', city: 'Venice' })).resolves.toEqual({
      grass: 'st_augustine', grassTrusted: true, grassLabel: 'St. Augustine', irrigationSystem: true, county: 'Sarasota', city: 'venice', waterSource: null,
    });
  });

  test('a grass from the estimate, or set before the source column existed, is trusted', async () => {
    loadCustomerGrassContext.mockResolvedValue(grass({ grassTypeSource: 'estimate' }));
    expect((await loadTechTipYard(prefsKnex(), { customerId: 'c1' })).grassTrusted).toBe(true);
    loadCustomerGrassContext.mockResolvedValue(grass({ grassTypeSource: null }));
    expect((await loadTechTipYard(prefsKnex(), { customerId: 'c1' })).grassTrusted).toBe(true);
  });

  test('a photo read, a customer record, or a mixed lawn is not', async () => {
    for (const overrides of [{ grassTypeSource: 'photo_ai' }, { grassTypeSource: 'customer_record' }, { grassType: 'mixed' }, { grassType: null }]) {
      loadCustomerGrassContext.mockResolvedValue(grass(overrides));
      expect((await loadTechTipYard(prefsKnex(), { customerId: 'c1' })).grassTrusted).toBe(false);
    }
  });

  test('irrigation: manual or none is no system; anything unrecorded is unknown', async () => {
    loadCustomerGrassContext.mockResolvedValue(grass({ irrigationSystem: 'manual' }));
    expect((await loadTechTipYard(prefsKnex(), { customerId: 'c1' })).irrigationSystem).toBe(false);
    loadCustomerGrassContext.mockResolvedValue(grass({ irrigationSystem: null }));
    expect((await loadTechTipYard(prefsKnex(), { customerId: 'c1' })).irrigationSystem).toBe(null);
  });

  test('a straddling city has no county (fail closed); a failed read leaves everything unknown', async () => {
    loadCustomerGrassContext.mockRejectedValue(new Error('db down'));
    await expect(loadTechTipYard(() => { throw new Error('db down'); }, { customerId: 'c1', city: 'Lakewood Ranch' })).resolves.toEqual({
      grass: null, grassTrusted: false, grassLabel: null, irrigationSystem: null, county: null, city: 'lakewood ranch', waterSource: null,
    });
  });

  test('the water source counts only as saved for this home: after a move it must be saved again', async () => {
    loadCustomerGrassContext.mockResolvedValue(grass());
    expect((await loadTechTipYard(prefsKnex({ irrigation_water_source: 'reclaimed', irrigation_home_changed_at: null }), { customerId: 'c1' })).waterSource).toBe('reclaimed');
    expect((await loadTechTipYard(prefsKnex({ irrigation_water_source: 'reclaimed', irrigation_home_changed_at: '2026-09-01', irrigation_confirmed_fields: [] }), { customerId: 'c1' })).waterSource).toBeNull();
    expect((await loadTechTipYard(prefsKnex({ irrigation_water_source: 'reclaimed', irrigation_home_changed_at: '2026-09-01', irrigation_confirmed_fields: ['irrigation_water_source'] }), { customerId: 'c1' })).waterSource).toBe('reclaimed');
    expect((await loadTechTipYard(prefsKnex(null), { customerId: 'c1' })).waterSource).toBeNull();
  });
});
