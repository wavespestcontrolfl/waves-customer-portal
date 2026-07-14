jest.mock('../middleware/auth', () => ({ authenticate: (_req, _res, next) => next() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technician = {
      id: 'admin-1', active: true, role: 'admin', auth_token_version: 6, must_change_password: false,
    };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/bouncie-token-store', () => ({
  loadTokens: jest.fn(),
  saveTokens: jest.fn(),
}));
jest.mock('../services/bouncie', () => ({ updateTokens: jest.fn() }));
jest.mock('../services/staff-oauth-state', () => ({
  createStaffOAuthState: jest.fn(),
  withClaimedStaffOAuthState: jest.fn(),
}));
jest.mock('../config', () => ({
  bouncie: {
    apiBase: 'https://api.example.test',
    authBase: 'https://auth.example.test',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://portal.example.test/api/bouncie/callback',
  },
}));

const http = require('http');
const express = require('express');
const tokenStore = require('../services/bouncie-token-store');
const {
  createStaffOAuthState,
  withClaimedStaffOAuthState,
} = require('../services/staff-oauth-state');
const router = require('../routes/bouncie');

const STATE = 'A'.repeat(43);

function request(server, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function withServer(callback) {
  const app = express();
  app.use('/bouncie', router);
  app.use((_error, _req, res, _next) => res.status(500).send('failed'));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }
    return await callback(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('Bouncie OAuth staff-session state wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterAll(() => { delete global.fetch; });

  test('OAuth start creates an opaque state bound to the authenticated admin', async () => {
    createStaffOAuthState.mockResolvedValue(STATE);
    await withServer(async (server) => {
      const response = await request(server, '/bouncie/auth');
      expect(response.status).toBe(302);
      expect(new URL(response.headers.location).searchParams.get('state')).toBe(STATE);
    });
    expect(createStaffOAuthState).toHaveBeenCalledWith(expect.objectContaining({
      prefix: 'bouncie.oauth_state:',
      technician: expect.objectContaining({ id: 'admin-1', auth_token_version: 6 }),
    }));
  });

  test('callback claims the state before exchanging and never renders token material', async () => {
    withClaimedStaffOAuthState.mockImplementation(async ({ callback }) => callback());
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn(async () => ({
        access_token: 'secret-access-token',
        refresh_token: 'secret-refresh-token',
        expires_in: 3600,
      })),
    });
    tokenStore.saveTokens.mockResolvedValue(undefined);

    await withServer(async (server) => {
      const response = await request(server, `/bouncie/callback?code=provider-code&state=${STATE}`);
      expect(response.status).toBe(200);
      expect(response.body).not.toContain('secret-access-token');
      expect(response.body).not.toContain('secret-refresh-token');
    });
    expect(withClaimedStaffOAuthState).toHaveBeenCalledWith(expect.objectContaining({
      prefix: 'bouncie.oauth_state:',
      rawState: STATE,
      callback: expect.any(Function),
    }));
    expect(tokenStore.saveTokens).toHaveBeenCalled();
  });

  test('a revoked or replayed state is rejected before provider exchange', async () => {
    withClaimedStaffOAuthState.mockRejectedValue(Object.assign(
      new Error('Invalid or expired OAuth state'),
      { code: 'STAFF_OAUTH_STATE_INVALID' },
    ));

    await withServer(async (server) => {
      const response = await request(server, `/bouncie/callback?code=provider-code&state=${STATE}`);
      expect(response.status).toBe(400);
      expect(response.body).toMatch(/Invalid or expired OAuth state/);
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
