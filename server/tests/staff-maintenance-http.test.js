jest.mock('../config', () => ({ jwt: { secret: 'maintenance-http-secret' } }));

const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const {
  isStaffMaintenanceEnabled,
  staffMaintenance,
} = require('../middleware/staff-maintenance');

const SECRET = 'maintenance-http-secret';
const originalMode = process.env.STAFF_MAINTENANCE_MODE;
let server;
let origin;

beforeAll(async () => {
  const app = express();
  app.use(staffMaintenance);
  app.get('/api/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', staffMaintenance: { enabled: isStaffMaintenanceEnabled() } });
  });
  app.get('/api/public/ping', (_req, res) => res.json({ ok: true }));
  app.all('*', (_req, res) => res.json({ reached: true }));

  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (originalMode === undefined) delete process.env.STAFF_MAINTENANCE_MODE;
  else process.env.STAFF_MAINTENANCE_MODE = originalMode;
});

describe('Staff maintenance HTTP behavior', () => {
  test('returns the complete maintenance response for Staff ingress', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const response = await fetch(`${origin}/api/admin/auth/login?next=/api/health`);

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({
      error: 'Staff access is temporarily unavailable',
      code: 'STAFF_MAINTENANCE',
    });
  });

  test('health remains 200 and reports the live gate state', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const staffToken = jwt.sign({ technicianId: 'tech-1' }, SECRET);
    const response = await fetch(`${origin}/api/health`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      staffMaintenance: { enabled: true },
    });
  });

  test('public/customer traffic stays online but a Staff bearer does not', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    const customerToken = jwt.sign({ customerId: 'customer-1' }, SECRET);
    const staffToken = jwt.sign({ technicianId: 'tech-1' }, SECRET);

    const publicResponse = await fetch(`${origin}/api/public/ping`);
    const customerResponse = await fetch(`${origin}/api/public/ping`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    const staffResponse = await fetch(`${origin}/api/public/ping`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });

    expect(publicResponse.status).toBe(200);
    expect(customerResponse.status).toBe(200);
    expect(staffResponse.status).toBe(503);
  });

  test('closes non-bearer Terminal and Bouncie OAuth Staff flows', async () => {
    process.env.STAFF_MAINTENANCE_MODE = 'true';

    const terminalResponse = await fetch(`${origin}/api/stripe/terminal/validate-handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'body-transport-handoff-token' }),
    });
    const bouncieCallbackResponse = await fetch(
      `${origin}/api/bouncie/callback?code=oauth-code&state=signed-oauth-state`,
    );

    expect(terminalResponse.status).toBe(503);
    expect(bouncieCallbackResponse.status).toBe(503);
  });
});
