jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (req.headers['x-admin'] !== 'yes') return res.status(401).json({ error: 'admin auth required' });
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'admin required' })
  ),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/bouncie-token-store', () => ({
  loadTokens: jest.fn().mockResolvedValue({ accessToken: 'staff-provider-token' }),
  saveTokens: jest.fn(),
}));
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
  },
}));

const express = require('express');
const http = require('http');
const router = require('../routes/bouncie');

function request(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({
      hostname: '127.0.0.1',
      port: server.address().port,
      path,
      headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

async function withServer(callback) {
  const app = express();
  app.use('/bouncie', router);
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'failed' }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    return await callback(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('raw Bouncie fleet authorization', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue([]),
    });
  });

  afterEach(() => { delete global.fetch; });

  test.each(['/vehicles', '/location?imei=vehicle-1'])(
    'rejects customer/anonymous access to %s before contacting Bouncie',
    async (path) => {
      await withServer(async (server) => {
        const response = await request(server, `/bouncie${path}`);
        expect(response.status).toBe(401);
      });
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  test('allows an admin to list the raw fleet', async () => {
    await withServer(async (server) => {
      const response = await request(server, '/bouncie/vehicles', { 'x-admin': 'yes' });
      expect(response.status).toBe(200);
    });
    expect(global.fetch.mock.calls.some(([url]) => String(url) === 'https://api.example.test/vehicles')).toBe(true);
  });
});
