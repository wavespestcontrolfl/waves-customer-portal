jest.mock('../models/db', () => jest.fn());
jest.mock('../services/customer-credit', () => ({}));
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/auth', () => ({
  authenticate: jest.fn(),
  createRefreshSession: jest.fn(),
  generateToken: jest.fn(),
  reissueRefreshSessionForProperty: jest.fn(),
  revokeCustomerRefreshSessions: jest.fn(),
  revokeRefreshSession: jest.fn().mockResolvedValue({ revoked: true }),
  rotateRefreshSession: jest.fn(),
}));

const express = require('express');
const {
  generateToken,
  revokeRefreshSession,
  rotateRefreshSession,
} = require('../middleware/auth');
const router = require('../routes/auth');

async function withServer(callback) {
  const app = express();
  app.use(express.json());
  app.use('/auth', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('POST /auth/logout', () => {
  beforeEach(() => jest.clearAllMocks());

  test('revokes by refresh credential without requiring access-token auth', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'signed-refresh-token' }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
    });

    expect(revokeRefreshSession).toHaveBeenCalledWith('signed-refresh-token', 'logout');
  });

  test('is idempotent and non-enumerating when no credential remains', async () => {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
    });
    expect(revokeRefreshSession).not.toHaveBeenCalled();
  });

  test('does not reveal whether the supplied credential produced a revocation', async () => {
    revokeRefreshSession.mockResolvedValueOnce({ revoked: false });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'stale-or-invalid-refresh-token' }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
    });

    expect(revokeRefreshSession)
      .toHaveBeenCalledWith('stale-or-invalid-refresh-token', 'logout');
  });
});

describe('POST /auth/refresh', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns a rotated token pair bound to the same durable family', async () => {
    rotateRefreshSession.mockResolvedValue({
      ok: true,
      refreshToken: 'rotated-refresh-token',
      familyId: 'family-1',
      accountId: 'account-1',
      customer: { id: 'customer-1' },
    });
    generateToken.mockReturnValue('new-access-token');

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'old-refresh-token' }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        token: 'new-access-token',
        refreshToken: 'rotated-refresh-token',
      });
    });

    expect(rotateRefreshSession).toHaveBeenCalledWith('old-refresh-token');
    expect(generateToken).toHaveBeenCalledWith('customer-1', 'account-1', 'family-1');
  });

  test('reports replay as a rejected session without exposing token details', async () => {
    rotateRefreshSession.mockResolvedValue({ ok: false, code: 'REFRESH_TOKEN_REUSED' });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'replayed-refresh-token' }),
      });
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: 'Invalid refresh token',
        code: 'REFRESH_TOKEN_REUSED',
      });
    });
    expect(generateToken).not.toHaveBeenCalled();
  });

  test('signals same-browser concurrent rotation without returning credentials', async () => {
    rotateRefreshSession.mockResolvedValue({
      ok: false,
      code: 'REFRESH_TOKEN_ALREADY_ROTATED',
      familyId: 'must-not-be-returned',
    });

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: 'simultaneous-refresh-token' }),
      });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toEqual({
        error: 'Refresh token was already rotated by this session',
        code: 'REFRESH_TOKEN_ALREADY_ROTATED',
      });
      expect(JSON.stringify(body)).not.toContain('must-not-be-returned');
    });
    expect(generateToken).not.toHaveBeenCalled();
  });
});
