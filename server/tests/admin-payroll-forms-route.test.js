// GET /api/admin/payroll/forms (payroll layer 3a): the gate, the period check and
// the admin-only guard, with the service's read stubbed. The real read is
// proved against Postgres in payroll-form-figures-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    if (!req.headers['x-test-auth']) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = req.headers['x-test-role'] || 'admin';
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));
jest.mock('../services/payroll-form-figures', () => ({
  ...jest.requireActual('../services/payroll-form-figures'),
  readFormFigures: jest.fn(),
}));

const express = require('express');
const figures = require('../services/payroll-form-figures');
const router = require('../routes/admin-payroll');

describe('GET /api/admin/payroll/forms', () => {
  let server;
  let baseUrl;
  const OLD = { payroll: process.env.GATE_PAYROLL, forms: process.env.GATE_PAYROLL_FORM_FIGURES };
  const get = (query, headers = { 'x-test-auth': '1' }) => fetch(`${baseUrl}/forms${query}`, { headers });

  beforeAll(async () => {
    const app = express();
    app.use('/api/admin/payroll', router);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/payroll`;
  });
  afterAll(async () => {
    await new Promise((resolve) => { server.close(resolve); });
    for (const [key, value] of [['GATE_PAYROLL', OLD.payroll], ['GATE_PAYROLL_FORM_FIGURES', OLD.forms]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  beforeEach(() => {
    process.env.GATE_PAYROLL = 'true';
    process.env.GATE_PAYROLL_FORM_FIGURES = 'true';
    figures.readFormFigures.mockReset();
    figures.readFormFigures.mockResolvedValue({ year: 2026, quarter: 4, f941: {}, rt6: {}, f940: {}, w2: [], w3: {} });
  });

  test('answers the figures when both gates are on', async () => {
    const res = await get('?year=2026&quarter=4');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ year: 2026, quarter: 4, w2: [] });
    expect(figures.readFormFigures).toHaveBeenCalledWith({ year: 2026, quarter: 4 });
  });

  test('gate off answers 404 before any read', async () => {
    delete process.env.GATE_PAYROLL_FORM_FIGURES;
    const res = await get('?year=2026&quarter=4');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ enabled: false });
    expect(figures.readFormFigures).not.toHaveBeenCalled();
  });

  test('a value other than exactly true is off', async () => {
    process.env.GATE_PAYROLL_FORM_FIGURES = 'TRUE';
    expect((await get('?year=2026&quarter=4')).status).toBe(404);
  });

  test('GATE_PAYROLL off also answers 404', async () => {
    delete process.env.GATE_PAYROLL;
    expect((await get('?year=2026&quarter=4')).status).toBe(404);
    expect(figures.readFormFigures).not.toHaveBeenCalled();
  });

  test.each(['', '?year=2026', '?quarter=2', '?year=26&quarter=1', '?year=2026&quarter=5', '?year=2026&quarter=x', '?year=2026&year=2027&quarter=1'])(
    'a bad period (%s) answers 400 before any read',
    async (query) => {
      const res = await get(query);
      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
      expect(figures.readFormFigures).not.toHaveBeenCalled();
    },
  );

  test('is admin only', async () => {
    expect((await get('?year=2026&quarter=4', {})).status).toBe(401);
    expect((await get('?year=2026&quarter=4', { 'x-test-auth': '1', 'x-test-role': 'technician' })).status).toBe(403);
    expect(figures.readFormFigures).not.toHaveBeenCalled();
  });

  test('a read failure answers 500 without the database message', async () => {
    figures.readFormFigures.mockRejectedValue(Object.assign(new Error('secret detail'), { code: '57P01' }));
    const res = await get('?year=2026&quarter=4');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret detail/);
  });
});
