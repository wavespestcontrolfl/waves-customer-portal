/**
 * GET /api/admin/discounts/stacking — the one read every discount picker
 * uses to decide whether to offer the stacking controls and which math to
 * preview. Dark by default; a technician may read it (the dispatch checkout
 * sheet is tech-reachable), but nothing unauthenticated can.
 */
process.env.GATE_DISCOUNT_STACKING = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../config', () => ({ jwt: { secret: 'test-only' } }));
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../middleware/staff-call-recording-privacy', () => ({ installStaffCallRecordingPrivacy: jest.fn() }));
jest.mock('../services/discount-engine', () => ({}));
jest.mock('../services/logger', () => ({}));
jest.mock('../services/audit-log', () => ({}));

const db = require('../models/db');
const jwt = require('jsonwebtoken');
const router = require('../routes/admin-discounts');

function readStacking({ role = 'admin', authenticated = true } = {}) {
  db.mockImplementation(() => ({
    where: () => ({ first: async () => ({ id: 'staff-1', role, employment_status: 'active', auth_token_version: 1 }) }),
  }));
  if (authenticated) {
    jwt.verify.mockReturnValue({ type: 'access', technicianId: 'staff-1', tokenVersion: 1 });
  } else {
    jwt.verify.mockImplementation(() => { throw new Error('bad token'); });
  }
  return new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      url: '/stacking',
      headers: { authorization: 'Bearer test-token' },
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    router.handle(req, res, reject);
  });
}

beforeEach(() => jest.clearAllMocks());

test('reports the live gate to an admin', async () => {
  expect(await readStacking()).toEqual({ status: 200, body: { enabled: true } });
});

test('a technician can read it — the dispatch checkout sheet needs it too', async () => {
  expect(await readStacking({ role: 'technician' })).toEqual({ status: 200, body: { enabled: true } });
});

test('an unauthenticated caller gets nothing', async () => {
  const result = await readStacking({ authenticated: false });
  expect(result.status).toBe(401);
  expect(result.body.enabled).toBeUndefined();
});

test('the route is declared before the catalog list, so /stacking is never read as a discount id', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-discounts.js'), 'utf8');
  expect(src.indexOf("router.get('/stacking'")).toBeLessThan(src.indexOf("router.get('/',"));
  expect(src).toMatch(/enabled: isEnabled\('discountStacking'\)/);
});
