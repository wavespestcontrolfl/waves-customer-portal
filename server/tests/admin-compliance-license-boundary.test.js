process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/compliance', () => ({
  getApplications: jest.fn(),
  getDacsReport: jest.fn(),
  exportDacsCSV: jest.fn(),
  getProductLimits: jest.fn(),
  getNitrogenStatus: jest.fn(),
  getDashboard: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole)
      ? next()
      : res.status(403).json({ error: 'Staff access required' })
  ),
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin'
      ? next()
      : res.status(403).json({ error: 'Admin access required' })
  ),
}));

const db = require('../models/db');
const router = require('../routes/admin-compliance-v2');
const { requireAdmin } = require('../middleware/admin-auth');
const { updateLicense } = router._handlers;

const TECH_ID = '11111111-1111-4111-8111-111111111111';

function updateBuilder(rows) {
  const qb = {};
  qb.where = jest.fn(() => qb);
  qb.update = jest.fn(() => qb);
  qb.returning = jest.fn(async () => rows);
  return qb;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function put(id, body) {
  const res = response();
  const next = jest.fn((err) => { throw err; });
  await updateLicense({ params: { techId: id }, body }, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

describe('compliance license mutation boundary', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the license mutation route includes the admin-only gate', () => {
    const layer = router.stack.find(item => item.route?.path === '/licenses/:techId');
    expect(layer.route.methods.put).toBe(true);
    expect(layer.route.stack.map(item => item.handle)).toContain(requireAdmin);
  });

  test.each([
    ['invalid target id', 'not-a-uuid', { fl_applicator_license: 'JE362022' }],
    ['unknown body field', TECH_ID, { pay_rate: 99 }],
    ['empty body', TECH_ID, {}],
    ['invalid calendar date', TECH_ID, { license_expiry: '2026-02-30' }],
    ['non-array categories', TECH_ID, { license_categories: 'core' }],
    ['empty category', TECH_ID, { license_categories: ['core', '  '] }],
  ])('rejects %s before querying the database', async (_label, id, body) => {
    const res = await put(id, body);
    expect(res.statusCode).toBe(400);
    expect(db).not.toHaveBeenCalled();
  });

  test('normalizes allowed fields and returns only the license allowlist', async () => {
    const returnedRow = {
      id: TECH_ID,
      fl_applicator_license: 'JE362022',
      license_expiry: '2027-06-30',
      license_categories: ['core', 'ornamental'],
      password_hash: 'must-not-leak',
      ssn_last4: '1234',
      address: '123 Private Way',
      dob: '1990-01-01',
      emergency_contact_name: 'Private Person',
      emergency_contact_phone: '+15555550100',
      email: 'private@example.com',
      phone: '+15555550101',
      pay_rate: '50.00',
    };
    const qb = updateBuilder([returnedRow]);
    db.mockReturnValue(qb);

    const res = await put(TECH_ID, {
      fl_applicator_license: '  JE362022  ',
      license_expiry: '2027-06-30',
      license_categories: ['core', 'ornamental', 'core'],
    });
    const body = res.body;

    expect(res.statusCode).toBe(200);
    expect(qb.where).toHaveBeenCalledWith({ id: TECH_ID });
    expect(qb.update).toHaveBeenCalledWith({
      fl_applicator_license: 'JE362022',
      license_expiry: '2027-06-30',
      license_categories: JSON.stringify(['core', 'ornamental']),
    });
    expect(qb.returning).toHaveBeenCalledWith([
      'id',
      'fl_applicator_license',
      'license_expiry',
      'license_categories',
    ]);
    expect(body).toEqual({
      success: true,
      technician: {
        id: TECH_ID,
        license: 'JE362022',
        licenseExpiry: '2027-06-30',
        licenseCategories: ['core', 'ornamental'],
      },
    });

    for (const field of [
      'password_hash', 'ssn_last4', 'address', 'dob',
      'emergency_contact_name', 'emergency_contact_phone',
      'email', 'phone', 'pay_rate',
    ]) {
      expect(body.technician).not.toHaveProperty(field);
    }
  });
});
