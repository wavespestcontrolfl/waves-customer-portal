/**
 * GET /api/misting-system — the Home misting card's read (dark behind
 * GATE_MOSQUITO_MISTING). Gate off and household-contact logins answer
 * { system: null } with no database read; the account holder gets the
 * resolved propertyScope echo plus the system.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ mosquitoMistingLive: jest.fn() }));
jest.mock('../services/misting-portal', () => ({ getPortalMistingSystem: jest.fn() }));
jest.mock('../services/contact-session-projection', () => ({ sessionRecordScope: jest.fn(async () => global.__SCOPE__) }));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', active: true };
    if (global.__CONTACT__) req.contactSession = { contactId: 'contact-1' };
    next();
  },
}));

const express = require('express');
const { mosquitoMistingLive } = require('../config/feature-gates');
const { getPortalMistingSystem } = require('../services/misting-portal');
const { sessionRecordScope } = require('../services/contact-session-projection');
const mistingRouter = require('../routes/misting-system');

const SYSTEM = {
  installedOn: '2026-05-02',
  lastRefillOn: '2026-10-12',
  nextCheckOn: '2026-11-12',
  nextMistAt: '2026-10-30T23:30:00.000Z',
  mistTimes: ['06:30', '19:30'],
};
const PRIMARY = { customerId: 'cust-1', enabled: true, multi: true, scoped: true, closed: false, property: { id: 'prop-a', is_primary: true } };

let server; let base;
beforeAll((done) => {
  const app = express();
  app.use('/misting-system', mistingRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  global.__SCOPE__ = PRIMARY;
  global.__CONTACT__ = false;
  mosquitoMistingLive.mockReturnValue(true);
  getPortalMistingSystem.mockResolvedValue(SYSTEM);
});

describe('GET /api/misting-system', () => {
  test('gate off: { system: null } and nothing is read', async () => {
    mosquitoMistingLive.mockReturnValue(false);
    const res = await fetch(`${base}/misting-system`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ system: null });
    expect(sessionRecordScope).not.toHaveBeenCalled();
    expect(getPortalMistingSystem).not.toHaveBeenCalled();
  });

  test('household-contact login: { system: null } and nothing is read', async () => {
    global.__CONTACT__ = true;
    const res = await fetch(`${base}/misting-system`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ system: null });
    expect(sessionRecordScope).not.toHaveBeenCalled();
    expect(getPortalMistingSystem).not.toHaveBeenCalled();
  });

  test('account holder: the propertyScope echo plus the system, read under the resolved scope', async () => {
    const res = await fetch(`${base}/misting-system`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      propertyScope: { enabled: true, propertyId: 'prop-a', closed: false },
      system: SYSTEM,
    });
    expect(getPortalMistingSystem).toHaveBeenCalledWith({ customerId: 'cust-1', scope: PRIMARY });
  });

  test('account holder with no system: { system: null } still carries the echo', async () => {
    getPortalMistingSystem.mockResolvedValue(null);
    const res = await fetch(`${base}/misting-system`);
    expect(await res.json()).toEqual({ propertyScope: { enabled: true, propertyId: 'prop-a', closed: false }, system: null });
  });

  test('a read error goes to the error handler', async () => {
    getPortalMistingSystem.mockRejectedValue(new Error('db down'));
    const res = await fetch(`${base}/misting-system`);
    expect(res.status).toBe(500);
    expect(require('../services/logger').error).toHaveBeenCalled();
  });
});
