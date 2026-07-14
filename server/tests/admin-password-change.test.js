jest.mock('../models/db', () => jest.fn());
jest.mock('bcryptjs', () => ({
  compare: jest.fn(),
  hash: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = global.__passwordChangeTech;
    req.technicianId = req.technician?.id;
    req.techRole = req.technician?.role;
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn() }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../models/db');
const router = require('../routes/admin-auth');
const { changePassword, login } = router._handlers;

function response() {
  return {
    statusCode: 200,
    body: null,
    cookie: jest.fn(),
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(handler, req) {
  const res = response();
  const next = jest.fn((err) => { throw err; });
  await handler(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

function installDb({ lookupTech, loginMatches, updatedTech }) {
  const writes = [];
  db.fn = { now: jest.fn(() => 'NOW') };
  db.mockImplementation(() => {
    const builder = {
      where: jest.fn(() => builder),
      whereRaw: jest.fn(() => builder),
      whereIn: jest.fn(() => builder),
      first: jest.fn(async () => lookupTech),
      select: jest.fn(async () => loginMatches || (lookupTech ? [lookupTech] : [])),
      update: jest.fn((values) => {
        writes.push(values);
        const pending = Promise.resolve(1);
        pending.returning = jest.fn(async () => updatedTech ? [updatedTech] : []);
        return pending;
      }),
    };
    return builder;
  });
  db.transaction = jest.fn(async (callback) => callback(db));
  db.raw = jest.fn(async () => undefined);
  return writes;
}

const forcedTech = {
  id: 'tech-1',
  name: 'Admin User',
  email: 'admin@example.test',
  role: 'admin',
  active: true,
  password_hash: 'old-hash',
  auth_token_version: 5,
  must_change_password: true,
  password_reset_token_hash: 'pending-reset-hash',
  password_reset_expires_at: '2026-07-10T20:00:00Z',
  password_reset_requested_at: '2026-07-10T19:00:00Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  global.__passwordChangeTech = forcedTech;
});

afterAll(() => {
  delete global.__passwordChangeTech;
});

describe('staff password rotation', () => {
  test('login mints a versioned access token and exposes the forced-change state', async () => {
    installDb({ lookupTech: forcedTech });
    bcrypt.compare.mockResolvedValue(true);

    const response = await invoke(login, {
      body: { email: forcedTech.email, password: 'current-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.user.mustChangePassword).toBe(true);
    expect(jwt.verify(response.body.token, 'test-secret')).toMatchObject({
      technicianId: forcedTech.id,
      type: 'access',
      tokenVersion: 5,
    });
    expect(jwt.verify(response.body.refreshToken, 'test-secret')).toMatchObject({
      technicianId: forcedTech.id,
      type: 'refresh',
      tokenVersion: 5,
    });
  });

  test('rotates the hash and token version after verifying the current password', async () => {
    const rotated = {
      ...forcedTech,
      password_hash: 'new-hash',
      auth_token_version: 6,
      must_change_password: false,
    };
    const writes = installDb({ lookupTech: forcedTech, updatedTech: rotated });
    bcrypt.compare
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    bcrypt.hash.mockResolvedValue('new-hash');

    const response = await invoke(changePassword, {
      technician: forcedTech,
      body: { currentPassword: 'current-password', newPassword: 'A-unique-password-2026' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.user.mustChangePassword).toBe(false);
    expect(jwt.verify(response.body.token, 'test-secret').tokenVersion).toBe(6);
    expect(writes).toContainEqual(expect.objectContaining({
      password_hash: 'new-hash',
      auth_token_version: 6,
      must_change_password: false,
      password_changed_at: 'NOW',
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
    }));
  });

  test('rejects the retired shared password and duplicate canonical identities', async () => {
    installDb({ lookupTech: forcedTech, loginMatches: [forcedTech, { ...forcedTech, id: 'tech-2' }] });

    const retired = await invoke(login, {
      body: { email: forcedTech.email, password: 'waves2026' },
    });
    expect(retired.statusCode).toBe(401);
    expect(retired.body.code).toBe('PASSWORD_RESET_REQUIRED');
    expect(db).not.toHaveBeenCalled();

    const duplicate = await invoke(login, {
      body: { email: forcedTech.email, password: 'different-password' },
    });
    expect(duplicate.statusCode).toBe(401);
    expect(duplicate.body).toEqual({ error: 'Invalid credentials' });
    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    expect(bcrypt.compare).toHaveBeenCalledWith(
      'different-password',
      expect.stringMatching(/^\$2a\$12\$/),
    );
  });

  test('rejects weak, incorrect, and reused passwords without updating the account', async () => {
    const writes = installDb({ lookupTech: forcedTech, updatedTech: forcedTech });

    const weak = await invoke(changePassword, {
      technician: forcedTech,
      body: { currentPassword: 'current-password', newPassword: 'short' },
    });
    expect(weak.statusCode).toBe(400);

    bcrypt.compare.mockResolvedValueOnce(false);
    const incorrect = await invoke(changePassword, {
      technician: forcedTech,
      body: { currentPassword: 'wrong-password', newPassword: 'A-unique-password-2026' },
    });
    expect(incorrect.statusCode).toBe(400);

    bcrypt.compare
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const reused = await invoke(changePassword, {
      technician: forcedTech,
      body: { currentPassword: 'current-password', newPassword: 'A-unique-password-2026' },
    });
    expect(reused.statusCode).toBe(400);
    expect(writes).toHaveLength(0);
  });
});
