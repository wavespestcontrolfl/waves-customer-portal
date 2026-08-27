/**
 * POST /api/admin/auth/register — provisioning hardening.
 *
 * A registered account's password is chosen by the OWNER and handed over
 * out-of-band, so register must arm must_change_password (the middleware
 * enforces the rotation; register arming it is what these tests pin).
 * Licensing fields are captured at provisioning because nothing else in the
 * product populates them for a new account, and the daily license-expiry
 * watch reads technicians.license_expiry.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(async () => 'hashed-password'),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn() }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));

const db = require('../models/db');
const router = require('../routes/admin-auth');
const { register } = router._handlers;

const VALID_PASSWORD = 'Correct-Horse-77!';

function response() {
  return {
    statusCode: 200,
    body: null,
    cookie: jest.fn(),
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(req) {
  const res = response();
  const next = jest.fn((err) => { throw err; });
  await register(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

// Register's DB usage: lockStaffAccountMutations (trx.raw), the canonical
// email duplicate probe (builder chain ending in .first), and the insert.
function installDb({ existing = null } = {}) {
  const inserts = [];
  db.fn = { now: jest.fn(() => 'NOW') };
  db.mockImplementation(() => {
    const builder = {
      where: jest.fn(() => builder),
      whereNotNull: jest.fn(() => builder),
      whereRaw: jest.fn(() => builder),
      whereIn: jest.fn(() => builder),
      first: jest.fn(async () => existing),
      insert: jest.fn((values) => {
        inserts.push(values);
        return {
          returning: jest.fn(async () => [{
            id: 'tech-new',
            name: values.name,
            email: values.email,
            role: values.role,
            must_change_password: values.must_change_password,
            fl_applicator_license: values.fl_applicator_license,
            license_expiry: values.license_expiry,
          }]),
        };
      }),
    };
    return builder;
  });
  const trx = (...args) => db(...args);
  trx.raw = jest.fn(async () => undefined);
  trx.fn = db.fn;
  db.transaction = jest.fn(async (callback) => callback(trx));
  db.raw = jest.fn(async () => undefined);
  return inserts;
}

function baseBody(extra = {}) {
  return {
    name: 'New Technician',
    email: 'newtech@example.test',
    password: VALID_PASSWORD,
    role: 'technician',
    ...extra,
  };
}

describe('register provisioning hardening', () => {
  beforeEach(() => jest.clearAllMocks());

  test('arms must_change_password on the inserted account and reports it', async () => {
    const inserts = installDb();
    const res = await invoke({ body: baseBody() });
    expect(res.statusCode).toBe(201);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].must_change_password).toBe(true);
    // Rotation pairing (matches rotate-legacy-staff-passwords): the
    // timestamp stays NULL until the hire actually rotates the credential.
    expect(inserts[0].password_changed_at).toBeNull();
    expect(res.body.mustChangePassword).toBe(true);
  });

  test('stores licensing fields provided at provisioning', async () => {
    const inserts = installDb();
    const res = await invoke({
      body: baseBody({ fl_applicator_license: ' JF123456 ', license_expiry: '2027-06-30' }),
    });
    expect(res.statusCode).toBe(201);
    expect(inserts[0].fl_applicator_license).toBe('JF123456');
    expect(inserts[0].license_expiry).toBe('2027-06-30');
    expect(res.body.flApplicatorLicense).toBe('JF123456');
    expect(res.body.licenseExpiry).toBe('2027-06-30');
  });

  test('licensing fields default to null when omitted or empty', async () => {
    const inserts = installDb();
    const res = await invoke({ body: baseBody({ fl_applicator_license: '', license_expiry: '' }) });
    expect(res.statusCode).toBe(201);
    expect(inserts[0].fl_applicator_license).toBeNull();
    expect(inserts[0].license_expiry).toBeNull();
  });

  test.each([
    ['not-a-date'],
    ['2027-13-01'],
    ['2027-02-30'],
    ['06/30/2027'],
    ['0000-01-01'],
    [20270630],
  ])('rejects malformed license_expiry %p with 400 and inserts nothing', async (bad) => {
    const inserts = installDb();
    const res = await invoke({ body: baseBody({ license_expiry: bad }) });
    expect(res.statusCode).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  test('rejects an over-length applicator license with 400', async () => {
    const inserts = installDb();
    const res = await invoke({ body: baseBody({ fl_applicator_license: 'X'.repeat(51) }) });
    expect(res.statusCode).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  test('duplicate canonical email still conflicts before any insert', async () => {
    const inserts = installDb({ existing: { id: 'tech-existing' } });
    const res = await invoke({ body: baseBody() });
    expect(res.statusCode).toBe(409);
    expect(inserts).toHaveLength(0);
  });

  test('rejects roles outside admin/technician', async () => {
    const inserts = installDb();
    const res = await invoke({ body: baseBody({ role: 'csr' }) });
    expect(res.statusCode).toBe(400);
    expect(inserts).toHaveLength(0);
  });
});
