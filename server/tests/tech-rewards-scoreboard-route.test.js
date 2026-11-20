// /api/tech/rewards-scoreboard and /api/admin/tech-rewards-scoreboard (Tech Rewards Plan D5-4), with the service
// stubbed. Own numbers only, the gate, and the admin preview that works with the gate off.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate(req, res, next) {
    const role = req.headers.authorization?.replace('Bearer ', '');
    if (!role) return res.status(401).end();
    req.techRole = role;
    req.technicianId = '00000000-0000-4000-8000-000000000001';
    return next();
  },
  requireTechOrAdmin(req, res, next) { return ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).end(); },
  requireAdmin(req, res, next) { return req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }); },
}));
jest.mock('../services/tech-rewards-scoreboard', () => ({
  ...jest.requireActual('../services/tech-rewards-scoreboard'),
  getScoreboard: jest.fn(),
  listTechnicians: jest.fn(),
}));

const express = require('express');
const logger = require('../services/logger');
const scoreboard = require('../services/tech-rewards-scoreboard');
const techRouter = require('../routes/tech-rewards-scoreboard');
const adminRouter = require('../routes/admin-tech-rewards-scoreboard');

const OWN = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
let server;
let techBase;
let adminBase;
const get = (base, path = '', role = 'technician') => fetch(`${base}${path}`, { headers: role ? { Authorization: `Bearer ${role}` } : {} });

beforeAll(async () => {
  const app = express();
  app.use('/api/tech/rewards-scoreboard', techRouter);
  app.use('/api/admin/tech-rewards-scoreboard', adminRouter);
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  techBase = `http://127.0.0.1:${server.address().port}/api/tech/rewards-scoreboard`;
  adminBase = `http://127.0.0.1:${server.address().port}/api/admin/tech-rewards-scoreboard`;
});
afterAll(async () => { delete process.env.GATE_TECH_REWARDS_SCOREBOARD; await new Promise((resolve) => server.close(resolve)); });
beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_TECH_REWARDS_SCOREBOARD = 'true';
  scoreboard.getScoreboard.mockResolvedValue({ technician: { id: OWN, name: 'Sample Alpha' } });
  scoreboard.listTechnicians.mockResolvedValue([{ id: OWN, name: 'Sample Alpha' }]);
});

describe('tech route (gated, own numbers only)', () => {
  test('gate off answers 404 { enabled: false } after the login check and before any read', async () => {
    for (const off of [undefined, '1', 'TRUE', 'on', 'false']) {
      if (off === undefined) delete process.env.GATE_TECH_REWARDS_SCOREBOARD; else process.env.GATE_TECH_REWARDS_SCOREBOARD = off;
      const response = await get(techBase);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ enabled: false });
    }
    expect(scoreboard.getScoreboard).not.toHaveBeenCalled();
  });

  test('no route here is public, gate on or off', async () => {
    expect((await get(techBase, '', null)).status).toBe(401);
    expect((await get(techBase, '', 'customer')).status).toBe(403);
    delete process.env.GATE_TECH_REWARDS_SCOREBOARD;
    expect((await get(techBase, '', null)).status).toBe(401);
    expect(scoreboard.getScoreboard).not.toHaveBeenCalled();
  });

  test('reads the authenticated technician and sets no-store', async () => {
    const response = await get(techBase);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ scoreboard: { technician: { id: OWN, name: 'Sample Alpha' } } });
    expect(scoreboard.getScoreboard).toHaveBeenCalledWith(OWN);
  });

  test('another technician id is 403 before any read; the caller own id is fine', async () => {
    const other = await get(techBase, `?technicianId=${OTHER}`);
    expect(other.status).toBe(403);
    expect(scoreboard.getScoreboard).not.toHaveBeenCalled();
    expect((await get(techBase, `?technicianId=${OWN.toUpperCase()}`)).status).toBe(200);
    expect(scoreboard.getScoreboard).toHaveBeenCalledWith(OWN);
  });

  test('an admin login also reads only its own board here, even when it asks for another id', async () => {
    expect((await get(techBase, '', 'admin')).status).toBe(200);
    expect(scoreboard.getScoreboard).toHaveBeenCalledWith(OWN);
    expect((await get(techBase, `?technicianId=${OTHER}`, 'admin')).status).toBe(403);
  });

  test('a failure answers 500 and logs a code, never the error text', async () => {
    const err = Object.assign(new Error('select * from customers where name = Pat'), { code: '42P01' });
    scoreboard.getScoreboard.mockRejectedValue(err);
    const response = await get(techBase);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toMatch(/customers/);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('42P01'));
    expect(logger.error.mock.calls[0][0]).not.toMatch(/customers/);
  });
});

describe('admin preview (not gated)', () => {
  test('works with the gate off: lists technicians and opens any one board', async () => {
    delete process.env.GATE_TECH_REWARDS_SCOREBOARD;
    const list = await get(adminBase, '', 'admin');
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(await list.json()).toEqual({ technicians: [{ id: OWN, name: 'Sample Alpha' }] });
    const one = await get(adminBase, `/${OTHER}`, 'admin');
    expect(one.status).toBe(200);
    expect(scoreboard.getScoreboard).toHaveBeenCalledWith(OTHER);
  });

  test('a technician or anonymous login is refused before any read', async () => {
    expect((await get(adminBase, `/${OTHER}`, 'technician')).status).toBe(403);
    expect((await get(adminBase, '', 'technician')).status).toBe(403);
    expect((await get(adminBase, `/${OTHER}`, null)).status).toBe(401);
    expect(scoreboard.getScoreboard).not.toHaveBeenCalled();
    expect(scoreboard.listTechnicians).not.toHaveBeenCalled();
  });

  test('maps the service errors: unknown 404, bad id 400, other 500', async () => {
    scoreboard.getScoreboard.mockRejectedValueOnce(new scoreboard.ScoreboardError(404, 'NOT_FOUND', 'Technician not found.'));
    expect((await get(adminBase, `/${OTHER}`, 'admin')).status).toBe(404);
    scoreboard.getScoreboard.mockRejectedValueOnce(new scoreboard.ScoreboardError(400, 'INVALID_TECHNICIAN', 'Technician id is not valid.'));
    expect((await get(adminBase, '/nope', 'admin')).status).toBe(400);
    scoreboard.getScoreboard.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'XX' }));
    expect((await get(adminBase, `/${OTHER}`, 'admin')).status).toBe(500);
  });
});
