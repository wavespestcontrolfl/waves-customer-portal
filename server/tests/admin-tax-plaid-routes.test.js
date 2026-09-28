/**
 * /admin/tax/bank-import/plaid/* — gate nesting, input validation, and the
 * error mapping. Storage and sync behavior live in plaid-sync.pg.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockDb = jest.fn(() => {
  const b = {
    select: jest.fn(() => b), count: jest.fn(() => b), groupBy: jest.fn(() => Promise.resolve([])),
    whereRaw: jest.fn(() => b), first: jest.fn(() => Promise.resolve({ n: '0' })),
  };
  return b;
});
mockDb.raw = jest.fn();
mockDb.fn = { now: jest.fn() };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'tech-1'; next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/bank-import', () => ({
  ...jest.requireActual('../services/bank-import'),
  resetDanglingLinks: jest.fn(async () => 0),
  healEditedExpenseLinks: jest.fn(async () => 0),
  healUnreconciledLinks: jest.fn(async () => ({})),
  healOrphanRefunds: jest.fn(async () => 0),
  verifyPendingExpenseClaims: jest.fn(async () => ({})),
  verifyPendingPayoutClaims: jest.fn(async () => ({})),
  retryPendingEchoes: jest.fn(async () => ({})),
}));
jest.mock('../services/plaid-sync', () => ({
  getStatus: jest.fn(async () => ({ configured: true, items: [] })),
  createLinkToken: jest.fn(async () => ({ linkToken: 'link-sandbox-1' })),
  connectItem: jest.fn(async () => 'item-uuid'),
  setupItem: jest.fn(async () => {}),
  markReconnected: jest.fn(async () => true),
  syncItem: jest.fn(async () => ({ inserted: 2 })),
  disconnectItem: jest.fn(async () => {}),
}));

const express = require('express');
const plaidSync = require('../services/plaid-sync');
const { PlaidError } = require('../services/plaid-client');
const taxRouter = require('../routes/admin-tax');

const ITEM = '0b8a4b7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/admin/tax', taxRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

const post = (path, body) => fetch(`${baseUrl}/admin/tax/bank-import/plaid${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_BANK_IMPORT = 'true';
  process.env.GATE_PLAID_SYNC = 'true';
});
afterAll(() => {
  delete process.env.GATE_BANK_IMPORT;
  delete process.env.GATE_PLAID_SYNC;
});

test('dark unless BOTH gates are on; bank-import status reports the nested gate', async () => {
  delete process.env.GATE_PLAID_SYNC;
  expect((await post('/link-token')).status).toBe(404);
  expect((await post('/connect', { publicToken: 'public-sandbox-x' })).status).toBe(404);
  expect((await post(`/items/${ITEM}/setup`, { accounts: [] })).status).toBe(404);
  expect((await post(`/items/${ITEM}/sync`)).status).toBe(404);
  expect(plaidSync.syncItem).not.toHaveBeenCalled();
  // switched off after import: resolving a staged bank change and revoking
  // a connection stay reachable (else those rows stay blocked from claims)
  expect((await post(`/rows/${ITEM}/bank-change`, {})).status).toBe(400); // reached validation
  expect((await post(`/items/${ITEM}/disconnect`)).status).toBe(200);
  expect(plaidSync.disconnectItem).toHaveBeenCalledWith(ITEM, { confirmedRemovedAtPlaid: false });
  expect((await fetch(`${baseUrl}/admin/tax/bank-import/plaid/status`)).status).toBe(200); // to list what's left
  plaidSync.getStatus.mockClear();
  expect(await (await fetch(`${baseUrl}/admin/tax/bank-import/status`)).json()).toMatchObject({ enabled: true, plaidEnabled: false });

  process.env.GATE_PLAID_SYNC = 'true';
  delete process.env.GATE_BANK_IMPORT;
  expect((await fetch(`${baseUrl}/admin/tax/bank-import/plaid/status`)).status).toBe(404);
  expect(plaidSync.getStatus).not.toHaveBeenCalled();

  process.env.GATE_BANK_IMPORT = 'true';
  expect(await (await fetch(`${baseUrl}/admin/tax/bank-import/plaid/status`)).json()).toEqual({ configured: true, items: [] });
  expect(await (await fetch(`${baseUrl}/admin/tax/bank-import/status`)).json()).toMatchObject({ plaidEnabled: true });
});

test('link-token: new connection vs update mode, bad item id refused', async () => {
  expect(await (await post('/link-token')).json()).toEqual({ linkToken: 'link-sandbox-1' });
  expect(plaidSync.createLinkToken).toHaveBeenLastCalledWith({ clientUserId: 'tech-1', itemId: null });
  await post('/link-token', { itemId: ITEM });
  expect(plaidSync.createLinkToken).toHaveBeenLastCalledWith({ clientUserId: 'tech-1', itemId: ITEM });
  expect((await post('/link-token', { itemId: "1' or 1=1" })).status).toBe(400);
});

test('connect requires a public token', async () => {
  expect((await post('/connect', {})).status).toBe(400);
  expect(plaidSync.connectItem).not.toHaveBeenCalled();
  const res = await post('/connect', { publicToken: 'public-sandbox-1', institutionName: 'Capital One' });
  expect(await res.json()).toEqual({ success: true, itemId: 'item-uuid' });
});

test('item routes 404 a non-uuid id before touching the service', async () => {
  for (const action of ['setup', 'sync', 'reconnected', 'disconnect']) {
    expect((await post(`/items/not-a-uuid/${action}`)).status).toBe(404);
  }
  expect(plaidSync.syncItem).not.toHaveBeenCalled();
});

test('setup saves the mapping then syncs; validation errors surface as 400', async () => {
  const res = await post(`/items/${ITEM}/setup`, { accounts: [{ id: 'a' }] });
  expect(await res.json()).toEqual({ success: true, sync: { inserted: 2 } });
  expect(plaidSync.setupItem).toHaveBeenCalledWith(ITEM, [{ id: 'a' }]);

  const e = new Error('two accounts cannot share a label'); e.status = 400;
  plaidSync.setupItem.mockRejectedValueOnce(e);
  const bad = await post(`/items/${ITEM}/setup`, { accounts: [] });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: 'two accounts cannot share a label' });
});

test('a Plaid API failure is a 502 carrying the Plaid error code', async () => {
  plaidSync.createLinkToken.mockRejectedValueOnce(new PlaidError('Plaid /link/token/create: INVALID_API_KEYS — bad keys', { errorCode: 'INVALID_API_KEYS' }));
  const res = await post('/link-token');
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: 'Plaid /link/token/create: INVALID_API_KEYS — bad keys', plaidErrorCode: 'INVALID_API_KEYS' });
});
