/**
 * admin-company-facts.js: who may do what. Technicians are refused everywhere, approve is the owner account only (403
 * before the service is called), any admin may draft, edit, discard and retire, every service refusal is answered as
 * { error, code, ...detail }, and an unexpected failure logs a code only. The service is mocked; its rules are tested in
 * company-facts-bank.test.js and company-facts-bank-postgres.test.js.
 */

jest.mock('../models/db', () => jest.fn(() => { throw new Error('the routes must not touch the database here'); }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockRole = 'admin';
let mockEmail = 'contact@wavespestcontrol.com';
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'bbbbbbbb-0000-4000-8000-000000000001';
    req.techRole = mockRole;
    req.technician = { id: req.technicianId, name: 'Test Staff', email: mockEmail, role: mockRole };
    next();
  },
}));

const mockBank = {
  listFacts: jest.fn(async () => ({ facts: [], nextCursor: null })),
  refreshBankFacts: jest.fn(async () => [{ id: 'f1', text: 'We service Parrish.' }, { id: 'f2', text: 'We offer a plan.' }]),
  renderBankFactsLines: jest.fn((facts) => facts.map((f) => `- ${f.text}`).join('\n')),
  bankVersionHash: jest.fn(() => 'v1'),
  createDraft: jest.fn(async () => ({ id: 'f1', status: 'draft', check_result: { blocks: ['banned_copy'], warnings: [] } })),
  getFact: jest.fn(async () => ({ id: 'f1', status: 'draft', check_result: null })),
  factHistory: jest.fn(async () => [{ action: 'drafted' }]),
  editFact: jest.fn(async () => ({ id: 'f2', status: 'draft', check_result: null })),
  discardDraft: jest.fn(async () => ({ id: 'f1', discarded: true })),
  approveFact: jest.fn(async () => ({ id: 'f1', status: 'approved', check_result: { blocks: [], warnings: [] } })),
  retireFact: jest.fn(async () => ({ id: 'f1', status: 'retired', check_result: null })),
  restoreAsDraft: jest.fn(async () => ({ id: 'f3', status: 'draft', check_result: null })),
};
jest.mock('../services/company-facts-bank', () => {
  const actual = jest.requireActual('../services/company-facts-bank');
  return { FactError: actual.FactError, ...Object.fromEntries(Object.keys(mockBank).map((k) => [k, (...a) => mockBank[k](...a)])) };
});

const express = require('express');
const { FactError } = jest.requireActual('../services/company-facts-bank');
const logger = require('../services/logger');
const router = require('../routes/admin-company-facts');

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const url = (path = '') => `${baseUrl}/api/admin/company-facts${path}`;
let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/company-facts', router);
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  mockRole = 'admin';
  mockEmail = 'contact@wavespestcontrol.com';
});

async function call(target, method = 'GET', body) {
  const res = await fetch(target, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
}

const EVERY_ROUTE = [
  ['GET', ''], ['GET', '/preview'], ['POST', ''], ['GET', `/${ID}`], ['GET', `/${ID}/history`], ['PATCH', `/${ID}`], ['DELETE', `/${ID}`],
  ['POST', `/${ID}/approve`], ['POST', `/${ID}/retire`], ['POST', `/${ID}/restore`],
];

describe('technicians', () => {
  test.each(EVERY_ROUTE)('%s %s is refused 403 and never reaches the service', async (method, path) => {
    mockRole = 'technician';
    const res = await call(url(path), method, method === 'GET' || method === 'DELETE' ? undefined : { reason: 'x' });
    expect(res.status).toBe(403);
    for (const fn of Object.values(mockBank)) expect(fn).not.toHaveBeenCalled();
  });
});

describe('approve is the owner account only', () => {
  test('another admin is refused 403 before the service is called', async () => {
    mockEmail = 'someone.else@example.test';
    const res = await call(url(`/${ID}/approve`), 'POST', { acknowledgeWarnings: true });
    expect(res.status).toBe(403);
    expect(mockBank.approveFact).not.toHaveBeenCalled();
  });

  test('the owner account approves, and the service is told who is the owner', async () => {
    const res = await call(url(`/${ID}/approve`), 'POST', { ownerWords: 'ok 11-25', acknowledgeWarnings: true });
    expect(res.status).toBe(200);
    expect(res.body.fact.status).toBe('approved');
    expect(mockBank.approveFact).toHaveBeenCalledWith(ID, { ownerWords: 'ok 11-25', acknowledgeWarnings: true }, { id: 'bbbbbbbb-0000-4000-8000-000000000001', isOwner: true });
  });

  test('the list tells the page whether to show Approve: true for the owner account only', async () => {
    expect((await call(url())).body.viewer).toEqual({ ownerActions: true });
    mockEmail = 'someone.else@example.test';
    expect((await call(url())).body.viewer).toEqual({ ownerActions: false });
  });

  test('a blocked approve answers 422 with the codes', async () => {
    mockBank.approveFact.mockRejectedValueOnce(new FactError('BLOCKED', 422, { blocks: ['banned_copy'], warnings: [] }));
    const res = await call(url(`/${ID}/approve`), 'POST', {});
    expect(res).toEqual({ status: 422, body: { error: 'BLOCKED', code: 'BLOCKED', blocks: ['banned_copy'], warnings: [] } });
  });
});

describe('any admin may draft, edit, discard, retire and restore', () => {
  beforeEach(() => { mockEmail = 'someone.else@example.test'; });

  test('create answers 201 with the recorded check', async () => {
    const res = await call(url(), 'POST', { topic: 'Areas', factText: 'We service Parrish.' });
    expect(res.status).toBe(201);
    expect(res.body.check.blocks).toEqual(['banned_copy']);
    expect(mockBank.createDraft).toHaveBeenCalledWith({ topic: 'Areas', factText: 'We service Parrish.' }, { id: 'bbbbbbbb-0000-4000-8000-000000000001', isOwner: false });
  });

  test('list passes the status filter, edit and discard and retire and restore reach the service', async () => {
    expect((await call(url('?status=draft'))).status).toBe(200);
    expect(mockBank.listFacts).toHaveBeenCalledWith({ status: 'draft' });
    const paged = await call(url('?status=all&limit=50&cursor=abc'));
    expect(paged.body).toEqual({ facts: [], nextCursor: null, viewer: { ownerActions: false } });
    expect(mockBank.listFacts).toHaveBeenLastCalledWith({ status: 'all', limit: '50', cursor: 'abc' });
    expect((await call(url(`/${ID}`), 'PATCH', { factText: 'x' })).body.fact.id).toBe('f2');
    expect((await call(url(`/${ID}`), 'DELETE')).body).toEqual({ id: 'f1', discarded: true });
    expect((await call(url(`/${ID}/retire`), 'POST', { reason: 'wrong' })).status).toBe(200);
    expect(mockBank.retireFact).toHaveBeenCalledWith(ID, { reason: 'wrong' }, expect.objectContaining({ isOwner: false }));
    expect((await call(url(`/${ID}/restore`), 'POST')).status).toBe(201);
    expect((await call(url(`/${ID}/history`))).body.events).toEqual([{ action: 'drafted' }]);
  });
});

describe('preview', () => {
  test('any admin gets the lines the agents snapshot serves, from a fresh read, and the route is not taken for an id', async () => {
    mockEmail = 'someone.else@example.test';
    const res = await call(url('/preview'));
    expect(res).toEqual({ status: 200, body: { lines: '- We service Parrish.\n- We offer a plan.', count: 2, version: 'v1', ids: ['f1', 'f2'] } });
    expect(mockBank.refreshBankFacts).toHaveBeenCalledTimes(1);
    expect(mockBank.getFact).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  test('a malformed list cursor is a 400 INVALID_CURSOR, not a 500', async () => {
    mockBank.listFacts.mockRejectedValueOnce(new FactError('INVALID_CURSOR', 400));
    expect(await call(url('?cursor=garbage'))).toEqual({ status: 400, body: { error: 'INVALID_CURSOR', code: 'INVALID_CURSOR' } });
  });

  test('a bad id is a 400 and never reaches the service', async () => {
    expect(await call(url('/nope'))).toMatchObject({ status: 400, body: { code: 'INVALID_ID' } });
    expect(mockBank.getFact).not.toHaveBeenCalled();
  });

  test('an unexpected failure is a 500 and the log carries a code only', async () => {
    mockBank.createDraft.mockRejectedValueOnce(Object.assign(new Error('insert into company_fact_bank values (secret fact words)'), { code: '23502' }));
    const res = await call(url(), 'POST', { topic: 'a', factText: 'secret fact words' });
    expect(res.status).toBe(500);
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('23502');
    expect(logged).not.toContain('secret');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});
