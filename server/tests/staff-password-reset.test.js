jest.mock('../models/db', () => jest.fn());
jest.mock('bcryptjs', () => ({ compare: jest.fn(), hash: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ deactivateStaffUser: jest.fn() }));
jest.mock('../sockets', () => ({ disconnectStaffSockets: jest.fn() }));
jest.mock('../services/staff-password-reset-email', () => ({
  RESET_LINK_TTL_MINUTES: 30,
  sendStaffPasswordResetEmail: jest.fn(),
}));
jest.mock('../config', () => ({ jwt: { secret: 'test-secret' } }));

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../models/db');
const logger = require('../services/logger');
const PushService = require('../services/push-notifications');
const { disconnectStaffSockets } = require('../sockets');
const { sendStaffPasswordResetEmail } = require('../services/staff-password-reset-email');
const router = require('../routes/admin-auth');
const {
  forgotPassword,
  issuePasswordReset,
  resetPassword,
} = router._handlers;

function builder({ first, returning, select } = {}) {
  const qb = {
    where: jest.fn(() => qb),
    whereIn: jest.fn(() => qb),
    whereNotNull: jest.fn(() => qb),
    whereRaw: jest.fn(() => qb),
    whereNull: jest.fn(() => qb),
    orWhere: jest.fn(() => qb),
    select: jest.fn(async () => select || []),
    update: jest.fn(() => qb),
    returning: jest.fn(async () => returning || []),
    first: jest.fn(async () => first),
  };
  return qb;
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

async function invoke(handler, req) {
  const res = response();
  const next = jest.fn((error) => { throw error; });
  await handler(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

const rawToken = 'A'.repeat(43);
const tech = {
  id: 'tech-1',
  email: 'admin@example.test',
  name: 'Admin',
  role: 'admin',
  active: true,
  password_hash: 'old-hash',
  auth_token_version: 7,
  must_change_password: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  db.fn = { now: jest.fn(() => 'NOW') };
  db.raw = jest.fn(async () => undefined);
  db.transaction = jest.fn(async (callback) => callback(db));
});

describe('staff password reset request', () => {
  test('stores only a token hash and emails the one-time raw token', async () => {
    const lookup = builder({ select: [{ id: tech.id, email: ` ${tech.email.toUpperCase()} ` }] });
    const issue = builder({ returning: [{ id: tech.id }] });
    db.mockReturnValueOnce(lookup).mockReturnValueOnce(issue);
    sendStaffPasswordResetEmail.mockResolvedValue({ messageId: 'msg-1' });

    await expect(issuePasswordReset(` ${tech.email.toUpperCase()} `)).resolves.toEqual({ issued: true });

    const write = issue.update.mock.calls[0][0];
    expect(write.password_reset_token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(write.password_reset_token_hash).not.toBe(
      sendStaffPasswordResetEmail.mock.calls[0][0].token,
    );
    expect(sendStaffPasswordResetEmail).toHaveBeenCalledWith(expect.objectContaining({
      technicianId: tech.id,
      email: tech.email,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    }));
  });

  test('does not send for an unknown, inactive, or throttled account', async () => {
    db.mockReturnValueOnce(builder({ select: [] }));
    await expect(issuePasswordReset('nobody@example.test')).resolves.toEqual({ issued: false });
    expect(sendStaffPasswordResetEmail).not.toHaveBeenCalled();
  });

  test('fails closed when a canonical staff email resolves to multiple rows', async () => {
    db.mockReturnValueOnce(builder({ select: [
      { id: tech.id, email: tech.email },
      { id: 'tech-2', email: ` ${tech.email.toUpperCase()} ` },
    ] }));

    await expect(issuePasswordReset(tech.email)).resolves.toEqual({ issued: false });
    expect(sendStaffPasswordResetEmail).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('canonical email collision'));
  });

  test('retains the short-lived token after an ambiguous provider failure', async () => {
    const lookup = builder({ select: [{ id: tech.id, email: tech.email }] });
    const issue = builder({ returning: [{ id: tech.id }] });
    db.mockReturnValueOnce(lookup).mockReturnValueOnce(issue);
    sendStaffPasswordResetEmail.mockRejectedValue(Object.assign(new Error('provider failed'), { status: 503 }));

    await expect(issuePasswordReset(tech.email)).rejects.toThrow('provider failed');
    expect(db).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ambiguous delivery failure'));
  });

  test('clears the persisted token after a definite provider rejection', async () => {
    const lookup = builder({ select: [{ id: tech.id, email: tech.email }] });
    const issue = builder({ returning: [{ id: tech.id }] });
    const cleanup = builder();
    db.mockReturnValueOnce(lookup).mockReturnValueOnce(issue).mockReturnValueOnce(cleanup);
    sendStaffPasswordResetEmail.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));

    await expect(issuePasswordReset(tech.email)).rejects.toThrow('bad request');
    expect(cleanup.where).toHaveBeenCalledWith(expect.objectContaining({
      id: tech.id,
      password_reset_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(cleanup.update).toHaveBeenCalledWith(expect.objectContaining({
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
    }));
  });

  test('returns the same generic response without waiting on account lookup', async () => {
    const invalid = response();
    forgotPassword({ body: { email: 'not-an-email' } }, invalid);

    db.mockReturnValueOnce(builder({ select: [] }));
    const valid = response();
    forgotPassword({ body: { email: 'Somebody@Example.test' } }, valid);
    await new Promise(setImmediate);

    expect(invalid.statusCode).toBe(200);
    expect(valid.statusCode).toBe(200);
    expect(valid.body).toEqual(invalid.body);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('staff password reset consumption', () => {
  test('atomically burns the token, rotates the session version, and signs in', async () => {
    const lookup = builder({ first: tech });
    const updatedTech = {
      ...tech,
      password_hash: 'new-hash',
      auth_token_version: 8,
      must_change_password: false,
    };
    const update = builder({ returning: [updatedTech] });
    db.mockReturnValueOnce(lookup).mockReturnValueOnce(update);
    bcrypt.compare.mockResolvedValue(false);
    bcrypt.hash.mockResolvedValue('new-hash');

    const res = await invoke(resetPassword, {
      body: { token: rawToken, newPassword: 'Ocean-waves-are-7-feet' },
    });

    expect(res.statusCode).toBe(200);
    expect(jwt.verify(res.body.token, 'test-secret')).toMatchObject({
      technicianId: tech.id,
      tokenVersion: 8,
      type: 'access',
    });
    expect(update.where).toHaveBeenCalledWith(expect.objectContaining({
      id: tech.id,
      auth_token_version: 7,
      password_reset_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({
      password_hash: 'new-hash',
      auth_token_version: 8,
      must_change_password: false,
      password_reset_token_hash: null,
      password_reset_expires_at: null,
      password_reset_requested_at: null,
    }));
    expect(PushService.deactivateStaffUser).toHaveBeenCalledWith(tech.id, db);
    expect(disconnectStaffSockets).toHaveBeenCalledWith(tech.id, 'password_reset');
    expect(res.cookie).toHaveBeenCalled();
  });

  test('rejects malformed, expired, and already-consumed tokens generically', async () => {
    const malformed = await invoke(resetPassword, {
      body: { token: 'short', newPassword: 'Ocean-waves-are-7-feet' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body.error).toMatch(/invalid or expired/i);
    expect(db).not.toHaveBeenCalled();

    db.mockReturnValueOnce(builder({ first: undefined }));
    const expired = await invoke(resetPassword, {
      body: { token: rawToken, newPassword: 'Ocean-waves-are-7-feet' },
    });
    expect(expired.statusCode).toBe(400);
    expect(expired.body).toEqual(malformed.body);
  });

  test('losing the conditional update race makes the token single-use', async () => {
    db.mockReturnValueOnce(builder({ first: tech })).mockReturnValueOnce(builder({ returning: [] }));
    bcrypt.compare.mockResolvedValue(false);
    bcrypt.hash.mockResolvedValue('new-hash');

    const res = await invoke(resetPassword, {
      body: { token: rawToken, newPassword: 'Ocean-waves-are-7-feet' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });
});
