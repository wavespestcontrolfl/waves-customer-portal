/**
 * The dark surface of the on-site prepay switch. feature-gates snapshots
 * process.env at require time, so "both gates off" needs its own module
 * registry — hence a file of its own rather than a resetModules inside the
 * lit-gate suite.
 *
 * With GATE_ONSITE_PREPAY_SWITCH and GATE_PREPAY_ON_BOOK both unset the
 * preview must be UNOBSERVABLE (404, not a blockReason) and the availability
 * probe must answer false on both lanes, so the appointment sheet renders no
 * prepay action at all.
 */
jest.mock('../models/db', () => {
  const dbFn = jest.fn();
  dbFn.transaction = jest.fn();
  dbFn.fn = { now: () => 'NOW' };
  return dbFn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

delete process.env.GATE_ONSITE_PREPAY_SWITCH;
delete process.env.GATE_PREPAY_ON_BOOK;

const express = require('express');
const router = require('../routes/admin-schedule');

jest.setTimeout(30000);

async function get(path) {
  const app = express();
  app.use('/admin/schedule', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('on-site prepay switch — both gates dark', () => {
  test('the committed preview 404s instead of answering', async () => {
    const { status } = await get('/admin/schedule/annual-prepay-preview?scheduledServiceId=svc-1');
    expect(status).toBe(404);
  });

  test('the atomic switch and undo endpoints are unobservable too', async () => {
    const post = async (path) => {
      const app = express();
      app.use(express.json());
      app.use('/admin/schedule', router);
      const server = app.listen(0);
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        return res.status;
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    };
    expect(await post('/admin/schedule/svc-1/prepay-switch')).toBe(404);
    expect(await post('/admin/schedule/svc-1/prepay-switch/undo')).toBe(404);
  });

  test('availability answers false on both lanes', async () => {
    const { body } = await get('/admin/schedule/annual-prepay-availability');
    expect(body).toEqual({ enabled: false, switchEnabled: false });
  });
});
