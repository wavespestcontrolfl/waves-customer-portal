// Turf grass source (owner 2026-10-06): a photo AI read that names one known
// grass replaces Mixed or Unknown, never a grass staff set in the editor.
const { photoAiWritesGrass, GRASS_SOURCE } = require('../services/lawn-grass-context');

describe('photoAiWritesGrass', () => {
  const fresh = true;
  test('a blank grass fills from any read, fresh or not', () => {
    expect(photoAiWritesGrass({ prior: null, read: 'mixed', fresh: false })).toBe(true);
    expect(photoAiWritesGrass({ prior: { grass_type: null }, read: 'bermuda', fresh: false })).toBe(true);
  });
  test('no read writes nothing', () => {
    expect(photoAiWritesGrass({ prior: null, read: null, fresh })).toBe(false);
  });
  test.each(['mixed', 'unknown'])('%s from the AI, an estimate or before the column gives way to a known grass', (vague) => {
    for (const source of [GRASS_SOURCE.PHOTO_AI, GRASS_SOURCE.ESTIMATE, null]) {
      expect(photoAiWritesGrass({ prior: { grass_type: vague, grass_type_source: source }, read: 'st_augustine', fresh })).toBe(true);
    }
  });
  test.each(['mixed', 'unknown'])('%s set by staff is never replaced', (vague) => {
    expect(photoAiWritesGrass({ prior: { grass_type: vague, grass_type_source: GRASS_SOURCE.STAFF }, read: 'bahia', fresh })).toBe(false);
  });
  test('a vague grass stays when the photos may be of another home', () => {
    expect(photoAiWritesGrass({ prior: { grass_type: 'mixed', grass_type_source: GRASS_SOURCE.PHOTO_AI }, read: 'zoysia', fresh: false })).toBe(false);
  });
  test('a vague read never replaces anything already set', () => {
    expect(photoAiWritesGrass({ prior: { grass_type: 'unknown' }, read: 'mixed', fresh })).toBe(false);
    expect(photoAiWritesGrass({ prior: { grass_type: 'mixed' }, read: 'unknown', fresh })).toBe(false);
  });
  test('a known grass is never replaced, whoever set it', () => {
    for (const source of [GRASS_SOURCE.PHOTO_AI, GRASS_SOURCE.ESTIMATE, null]) {
      expect(photoAiWritesGrass({ prior: { grass_type: 'st_augustine', grass_type_source: source }, read: 'bermuda', fresh })).toBe(false);
    }
  });
});

describe('turf-profile editor stamps a staff grass', () => {
  let mockPrior;
  const mockWrites = [];
  const mockTrx = (table) => {
    const q = {
      where: () => q, whereRaw: () => q, update: async () => 1,
      first: async () => (table === 'customer_turf_profiles' ? mockPrior : null),
      insert: (row) => { mockWrites.push({ insert: row }); return q; },
      onConflict: () => q,
      merge: (row) => { mockWrites.push({ merge: row }); return q; },
      returning: async () => [{ customer_id: 'cust-1' }],
    };
    return q;
  };
  mockTrx.raw = (sql) => sql;
  mockTrx.fn = { now: () => new Date() };
  mockTrx.schema = { hasColumn: async () => false };

  jest.mock('../models/db', () => () => ({ where: () => ({ first: async () => ({ id: 'cust-1' }) }) }));
  jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (r, s, n) => n(), requireTechOrAdmin: (r, s, n) => n(), requireAdmin: (r, s, n) => n() }));
  jest.mock('../services/technician-visit-scope', () => ({ technicianServicesCustomer: async () => true }));
  jest.mock('../services/customer-pricing-ai', () => ({ withTurfProfileFence: async (_db, _id, fn) => fn(mockTrx) }));
  jest.mock('../services/irrigation-schedule-confirmation', () => ({ COUNTY_CONFIRMED_FIELD: 'county', GRASS_CONFIRMED_FIELD: 'turf_grass', confirmIrrigationFields: jest.fn() }));
  jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

  const router = require('../routes/admin-customer-turf-profile');
  const put = router.stack.find((layer) => layer.route?.methods.put).route.stack.at(-1).handle;
  const save = (body) => put({ params: { customerId: 'cust-1' }, body, technicianId: 't1' }, { json: jest.fn(), status() { return this; } }, (err) => { throw err; });
  const merged = () => mockWrites.find((w) => w.merge).merge;

  beforeEach(() => { mockWrites.length = 0; });

  test('a changed grass is stamped staff', async () => {
    mockPrior = { grass_type: 'st_augustine', lawn_sqft: 3000 };
    await save({ grass_type: 'mixed' });
    expect(merged().grass_type_source).toBe(GRASS_SOURCE.STAFF);
    expect(mockWrites.find((w) => w.insert).insert.grass_type_source).toBe(GRASS_SOURCE.STAFF);
  });
  test('an unchanged grass the tech reviewed is stamped staff', async () => {
    mockPrior = { grass_type: 'mixed', lawn_sqft: 3000 };
    await save({ grass_type: 'mixed', grass_confirmed: true });
    expect(merged().grass_type_source).toBe(GRASS_SOURCE.STAFF);
  });
  test('a form re-send of an unchanged grass keeps its source', async () => {
    mockPrior = { grass_type: 'mixed', lawn_sqft: 3000 };
    await save({ grass_type: 'mixed', lawn_sqft: 3200 });
    expect(merged()).not.toHaveProperty('grass_type_source');
  });
});
