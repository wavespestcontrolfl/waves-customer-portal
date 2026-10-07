// Centipede is a recordable grass (owner 2026-10-06): the turf-profile API accepts it, the editor lists it,
// and the label and the free-text reader know it. Atrazine's label allows St. Augustine and centipede only,
// so a lawn that cannot be recorded as centipede could never be given the atrazine option.
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => () => ({ where: () => ({ first: async () => ({ id: 'cust-1' }) }) }));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (r, s, n) => n(), requireTechOrAdmin: (r, s, n) => n() }));
jest.mock('../services/technician-visit-scope', () => ({ technicianServicesCustomer: async () => true }));
const mockWrites = [];
const mockTrx = () => {
  const q = {
    where: () => q, whereRaw: () => q, update: async () => 1, first: async () => null,
    insert: (row) => { mockWrites.push({ insert: row }); return q; },
    onConflict: () => q,
    merge: (row) => { mockWrites.push({ merge: row }); return q; },
    returning: async () => [{ customer_id: 'cust-1', grass_type: 'centipede' }],
  };
  return q;
};
mockTrx.raw = (sql) => sql;
mockTrx.fn = { now: () => new Date() };
mockTrx.schema = { hasColumn: async () => false };
jest.mock('../services/customer-pricing-ai', () => ({ withTurfProfileFence: async (_db, _id, fn) => fn(mockTrx) }));
jest.mock('../services/irrigation-schedule-confirmation', () => ({ COUNTY_CONFIRMED_FIELD: 'county', GRASS_CONFIRMED_FIELD: 'turf_grass', confirmIrrigationFields: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const router = require('../routes/admin-customer-turf-profile');
const { normalizeGrassType, grassTypeLabel } = require('../services/lawn-grass-context');

const put = router.stack.find((layer) => layer.route?.methods.put).route.stack.at(-1).handle;
async function save(body) {
  const res = { statusCode: 200, body: null, json(payload) { this.body = payload; return this; }, status(code) { this.statusCode = code; return this; } };
  await put({ params: { customerId: 'cust-1' }, body, technicianId: 't1' }, res, (err) => { throw err; });
  return res;
}

beforeEach(() => { mockWrites.length = 0; });

test('the turf-profile PUT accepts centipede and writes it', async () => {
  const res = await save({ grass_type: 'centipede' });
  expect(res.statusCode).toBe(200);
  expect(mockWrites.find((w) => w.insert).insert.grass_type).toBe('centipede');
});

test('the PUT still rejects a grass outside the closed set, and the error lists centipede', async () => {
  const res = await save({ grass_type: 'bamboo' });
  expect(res.statusCode).toBe(400);
  expect(res.body.details[0]).toMatch(/st_augustine, bermuda, zoysia, bahia, centipede, mixed, unknown/);
});

test('the label and the free-text reader know centipede', () => {
  expect(grassTypeLabel('centipede')).toBe('Centipede');
  for (const text of ['centipede', 'Centipedegrass', 'Common centipede lawn']) expect(normalizeGrassType(text)).toBe('centipede');
});

test('the admin editor lists the same grass values as the API', () => {
  const panel = fs.readFileSync(path.join(__dirname, '../../client/src/pages/admin/LawnAssessmentPanel.jsx'), 'utf8');
  const listed = /grass_type: \[([^\]]*)\]/.exec(panel)[1].match(/"([a-z_]+)"/g).map((value) => value.replace(/"/g, ''));
  expect(listed).toEqual(['st_augustine', 'bermuda', 'zoysia', 'bahia', 'centipede', 'mixed', 'unknown']);
});
