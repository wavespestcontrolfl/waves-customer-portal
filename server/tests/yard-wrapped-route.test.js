/**
 * GET /api/yard-wrapped: authentication, the logged-in customer only, and the
 * { enabled: false } shape for gate off, a household-contact login, outside the
 * window or not a member (year null), and any failure, with no scope or data
 * read before the cheap checks pass.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/yard-wrapped', () => ({ yardWrappedYearFor: jest.fn(), buildYardWrapped: jest.fn() }));
jest.mock('../services/contact-session-projection', () => ({ sessionRecordScope: jest.fn(async () => global.__SCOPE__) }));

const express = require('express');
const { yardWrappedYearFor, buildYardWrapped } = require('../services/yard-wrapped');
const { sessionRecordScope } = require('../services/contact-session-projection');

const SCOPE = { customerId: 'cust-1', enabled: false, multi: false, scoped: false, closed: false, property: null };
const PAYLOAD = { enabled: true, year: 2026, visits: { total: 9, byLine: [{ line: 'pest', count: 9 }] }, treatedFor: [], businessName: 'Waves Pest Control, LLC' };

let server; let base; let router; let realRouter; let realServer; let realBase;
describe('GET /api/yard-wrapped', () => {
  beforeAll((done) => {
    // Stubbed login for the data cases; the real middleware (loaded first, below)
    // answers the unauthenticated case.
    realRouter = require('../routes/yard-wrapped');
    jest.isolateModules(() => {
      jest.doMock('../middleware/auth', () => ({
        authenticate: (req, res, next) => {
          if (!req.headers.authorization) return res.status(401).json({ error: 'Authentication required' });
          req.customerId = 'cust-1';
          req.customer = { id: 'cust-1', active: true, waveguard_tier: 'Gold' };
          if (req.headers['x-contact']) req.contactSession = { contactId: 'contact-1' };
          return next();
        },
      }));
      router = require('../routes/yard-wrapped');
    });
    const app = express();
    app.use('/yard-wrapped', router);
    const realApp = express();
    realApp.use('/yard-wrapped', realRouter);
    realServer = realApp.listen(0, '127.0.0.1', () => { realBase = `http://127.0.0.1:${realServer.address().port}`; });
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => { realServer.close(() => server.close(done)); });
  beforeEach(() => {
    jest.clearAllMocks();
    global.__SCOPE__ = SCOPE;
    yardWrappedYearFor.mockReturnValue(2026);
    buildYardWrapped.mockResolvedValue(PAYLOAD);
  });
  const get = (headers = { authorization: 'Bearer t' }) => fetch(`${base}/yard-wrapped?customerId=someone-else`, { headers });

  test('requires a login (the real authenticate middleware)', async () => {
    const res = await fetch(`${realBase}/yard-wrapped`);
    expect(res.status).toBe(401);
    expect(yardWrappedYearFor).not.toHaveBeenCalled();
    expect(buildYardWrapped).not.toHaveBeenCalled();
  });

  test('gate off, outside the window or not a member (no year): { enabled: false } and nothing is read', async () => {
    yardWrappedYearFor.mockReturnValue(null);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
    expect(sessionRecordScope).not.toHaveBeenCalled();
    expect(buildYardWrapped).not.toHaveBeenCalled();
  });

  test('a household-contact login: { enabled: false } and nothing is read', async () => {
    const res = await get({ authorization: 'Bearer t', 'x-contact': '1' });
    expect(await res.json()).toEqual({ enabled: false });
    expect(yardWrappedYearFor).not.toHaveBeenCalled();
    expect(sessionRecordScope).not.toHaveBeenCalled();
    expect(buildYardWrapped).not.toHaveBeenCalled();
  });

  test('an eligible member: the card for the logged-in customer, read under the resolved scope, with its scope echo', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    // The echo Home's scopeEchoMismatch reads, like /api/misting-system (resolvedScopePayload of the read's scope).
    expect(await res.json()).toEqual({ ...PAYLOAD, propertyScope: { enabled: false, propertyId: null, closed: false } });
    expect(yardWrappedYearFor).toHaveBeenCalledWith({ customer: { id: 'cust-1', active: true, waveguard_tier: 'Gold' } });
    expect(buildYardWrapped).toHaveBeenCalledWith({ customerId: 'cust-1', year: 2026, scope: SCOPE });
  });

  test('a house-scoped card echoes the house it was read for; no card carries no echo', async () => {
    global.__SCOPE__ = { ...SCOPE, enabled: true, scoped: true, property: { id: 'prop-2' } };
    try {
      expect((await (await get()).json()).propertyScope).toEqual({ enabled: true, propertyId: 'prop-2', closed: false });
      buildYardWrapped.mockResolvedValue({ enabled: false });
      expect(await (await get()).json()).toEqual({ enabled: false });
    } finally { global.__SCOPE__ = SCOPE; }
  });

  test('a builder failure answers { enabled: false }, never a 500', async () => {
    buildYardWrapped.mockRejectedValue(new Error('boom'));
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});
