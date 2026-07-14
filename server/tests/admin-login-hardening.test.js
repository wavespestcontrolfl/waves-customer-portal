jest.mock('../models/db', () => jest.fn());
jest.mock('bcryptjs', () => ({ compare: jest.fn(), hash: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn() }));
jest.mock('../services/staff-password-reset-email', () => ({
  RESET_LINK_TTL_MINUTES: 30,
  sendStaffPasswordResetEmail: jest.fn(),
}));
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));

const bcrypt = require('bcryptjs');
const db = require('../models/db');
const logger = require('../services/logger');
const { MAX_STAFF_PASSWORD_BYTES } = require('../utils/staff-password-policy');
const { _handlers: { login } } = require('../routes/admin-auth');

function loginQuery(rows) {
  const query = {};
  query.whereRaw = jest.fn(() => query);
  query.whereIn = jest.fn(() => query);
  query.where = jest.fn(() => query);
  query.select = jest.fn(async () => rows);
  return query;
}

function response() {
  return {
    statusCode: 200,
    body: null,
    cookie: jest.fn(),
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(body) {
  const res = response();
  const next = jest.fn();
  await login({ body }, res, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  expect(next).not.toHaveBeenCalled();
  return res;
}

describe('Staff login hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
  });

  test('returns a validation error for a missing body without touching auth dependencies', async () => {
    const res = await invoke(undefined);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Email and password required' });
    expect(db).not.toHaveBeenCalled();
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  test.each([
    ['ASCII', 'x'.repeat(MAX_STAFF_PASSWORD_BYTES + 1)],
    ['multi-byte UTF-8', '\u00e9'.repeat((MAX_STAFF_PASSWORD_BYTES / 2) + 1)],
  ])('rejects an over-72-byte %s password before database or bcrypt work', async (_label, password) => {
    const res = await invoke({ email: 'admin@example.test', password });

    expect(Buffer.byteLength(password, 'utf8')).toBeGreaterThan(MAX_STAFF_PASSWORD_BYTES);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(db).not.toHaveBeenCalled();
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  test('performs the fixed dummy bcrypt comparison for an unknown account', async () => {
    const query = loginQuery([]);
    db.mockReturnValueOnce(query);
    bcrypt.compare.mockResolvedValue(false);
    const password = '\u00e9'.repeat(MAX_STAFF_PASSWORD_BYTES / 2);

    const res = await invoke({ email: 'unknown@example.test', password });

    expect(Buffer.byteLength(password, 'utf8')).toBe(MAX_STAFF_PASSWORD_BYTES);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    expect(bcrypt.compare.mock.calls[0][1]).toMatch(/^\$2a\$12\$/);
  });

  test('treats a canonical-email collision like invalid credentials after dummy bcrypt work', async () => {
    const query = loginQuery([
      { id: 'tech-1', password_hash: 'hash-1' },
      { id: 'tech-2', password_hash: 'hash-2' },
    ]);
    db.mockReturnValueOnce(query);
    bcrypt.compare.mockResolvedValue(false);

    const res = await invoke({ email: 'duplicate@example.test', password: 'not-the-password' });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
    expect(bcrypt.compare.mock.calls[0][1]).toMatch(/^\$2a\$12\$/);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('canonical email collision'));
  });
});
