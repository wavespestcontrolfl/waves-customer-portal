/**
 * /api/admin/ads/negatives routes (owner plan A, 2026-11-02, PR 2): 404 while GATE_ADS_NEGATIVES is off, the response
 * shapes the Ads page reads, the refusal mapping (409 / 422 / 502) and the admin-only guard. The service is a stub; its
 * rules are in ads-negative-keyword-actions.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

let mockRole = 'admin';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => { req.technician = { id: 'staff-1', role: mockRole }; req.technicianId = 'staff-1'; req.techRole = mockRole; next(); },
  };
});
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ adsNegativesLive: jest.fn(() => true) }));
jest.mock('../services/ads/negative-keyword-actions', () => ({
  listNegatives: jest.fn(),
  addOwnerWord: jest.fn(),
  removeOwnerWord: jest.fn(),
  decideSuggestion: jest.fn(),
  undoNegative: jest.fn(),
  MESSAGES: { invalid: 'Type one to four words, using letters and numbers only.' },
}));

const express = require('express');
const gates = require('../config/feature-gates');
const actions = require('../services/ads/negative-keyword-actions');
const adsRouter = require('../routes/admin-ads');

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/ads', adsRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'server_error', detail: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}/api/admin/ads${path}`, {
    method: method.toUpperCase(), headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ROUTES = [
  ['get', '/negatives', undefined],
  ['post', '/negatives/words', { text: 'squirrel' }],
  ['post', `/negatives/words/${ID}/remove`, {}],
  ['post', `/negatives/${ID}/decide`, { decision: 'add' }],
  ['post', `/negatives/${ID}/undo`, {}],
];

beforeEach(() => {
  jest.clearAllMocks();
  mockRole = 'admin';
  gates.adsNegativesLive.mockReturnValue(true);
});

describe('gate and role', () => {
  test.each(ROUTES)('gate off: %s %s answers 404 not_found and runs nothing', async (method, path, body) => {
    gates.adsNegativesLive.mockReturnValue(false);
    expect(await call(method, path, body)).toEqual({ status: 404, body: { error: 'not_found' } });
    for (const fn of Object.values(actions)) if (typeof fn === 'function') expect(fn).not.toHaveBeenCalled();
  });

  test.each(ROUTES)('a technician login gets 403 on %s %s', async (method, path, body) => {
    mockRole = 'technician';
    expect((await call(method, path, body)).status).toBe(403);
    for (const fn of Object.values(actions)) if (typeof fn === 'function') expect(fn).not.toHaveBeenCalled();
  });

  test('a gate flipped off between the route and the step answers 404 too', async () => {
    actions.decideSuggestion.mockResolvedValue({ ok: false, code: 'off', message: 'Negative keywords are turned off.' });
    expect(await call('post', `/negatives/${ID}/decide`, { decision: 'add' })).toEqual({ status: 404, body: { error: 'not_found' } });
  });
});

describe('GET /negatives', () => {
  test('returns words, pending and log exactly as the service lists them', async () => {
    const lists = {
      words: [{ id: 'w1', text: 'snake', addedAt: '2026-11-02T10:00:00.000Z', campaigns: [{ campaignId: 'c1', campaignName: 'Search', state: 'active', lastError: null }] }],
      pending: [{ id: 'n1', text: 'bat', campaignId: 'c1', campaignName: 'Search', reason: 'r', metrics: { term: 'bat house', clicks: 6, cost: 9.5, conversions: 0 }, createdAt: '2026-11-02T10:00:00.000Z', notifiedAt: null }],
      log: [{ id: 'n2', text: 'wasp nest', campaignId: 'c1', campaignName: 'Search', source: 'advisor', state: 'active', decidedAt: '2026-11-02T10:00:00.000Z', pushedAt: '2026-11-02T10:00:00.000Z', removedAt: null, lastError: null, canUndo: true }],
    };
    actions.listNegatives.mockResolvedValue(lists);
    expect(await call('get', '/negatives')).toEqual({ status: 200, body: lists });
  });

  test('an unexpected failure is a 500 through the error handler', async () => {
    actions.listNegatives.mockRejectedValue(new Error('db down'));
    expect((await call('get', '/negatives')).status).toBe(500);
  });
});

describe('POST /negatives/words', () => {
  const word = { id: 'w1', text: 'squirrel', addedAt: '2026-11-02T10:00:00.000Z', campaigns: [] };

  test('200 { word } and the signed-in admin is passed as by', async () => {
    actions.addOwnerWord.mockResolvedValue({ ok: true, word });
    expect(await call('post', '/negatives/words', { text: 'Squirrel' })).toEqual({ status: 200, body: { word } });
    expect(actions.addOwnerWord).toHaveBeenCalledWith('Squirrel', { by: 'staff-1' });
  });

  test.each([[{}], [{ text: 42 }], [{ text: null }], [undefined]])('422 invalid when text is missing or not a string (%j)', async (body) => {
    const out = await call('post', '/negatives/words', body);
    expect(out.status).toBe(422);
    expect(out.body).toEqual({ error: 'invalid', message: 'Type one to four words, using letters and numbers only.' });
    expect(actions.addOwnerWord).not.toHaveBeenCalled();
  });

  test('422 invalid and 422 protected from the service, with its message', async () => {
    actions.addOwnerWord.mockResolvedValueOnce({ ok: false, code: 'invalid', message: 'Type one to four words.' });
    expect(await call('post', '/negatives/words', { text: '???' })).toEqual({ status: 422, body: { error: 'invalid', message: 'Type one to four words.' } });
    actions.addOwnerWord.mockResolvedValueOnce({ ok: false, code: 'protected', message: '"pest" is a service word.' });
    expect(await call('post', '/negatives/words', { text: 'pest' })).toEqual({ status: 422, body: { error: 'protected', message: '"pest" is a service word.' } });
  });
});

describe('POST /negatives/words/:id/remove', () => {
  test('200 { word: { id, text, removedAt }, failed }', async () => {
    const result = { ok: true, word: { id: 'w1', text: 'snake', removedAt: '2026-11-02T10:00:00.000Z' }, failed: 1 };
    actions.removeOwnerWord.mockResolvedValue(result);
    expect(await call('post', `/negatives/words/${ID}/remove`)).toEqual({ status: 200, body: { word: result.word, failed: 1 } });
    expect(actions.removeOwnerWord).toHaveBeenCalledWith(ID, { by: 'staff-1' });
  });

  test('a word that is not there is a 409 gone', async () => {
    actions.removeOwnerWord.mockResolvedValue({ ok: false, code: 'gone', message: 'That word is no longer there.' });
    expect(await call('post', `/negatives/words/${ID}/remove`)).toEqual({ status: 409, body: { error: 'gone', message: 'That word is no longer there.' } });
  });
});

describe('POST /negatives/:id/decide', () => {
  test('200 { state, message } for add and decline', async () => {
    actions.decideSuggestion.mockResolvedValueOnce({ ok: true, state: 'active', message: 'Blocked "squirrel" in Google Ads.' });
    expect(await call('post', `/negatives/${ID}/decide`, { decision: 'add' })).toEqual({ status: 200, body: { state: 'active', message: 'Blocked "squirrel" in Google Ads.' } });
    expect(actions.decideSuggestion).toHaveBeenLastCalledWith(ID, 'add', { by: 'staff-1' });
    actions.decideSuggestion.mockResolvedValueOnce({ ok: true, state: 'declined', message: 'Declined "squirrel".' });
    expect(await call('post', `/negatives/${ID}/decide`, { decision: 'decline' })).toEqual({ status: 200, body: { state: 'declined', message: 'Declined "squirrel".' } });
  });

  test.each([[{}], [{ decision: 'maybe' }], [{ decision: 1 }], [undefined]])('422 invalid for a bad decision (%j)', async (body) => {
    const out = await call('post', `/negatives/${ID}/decide`, body);
    expect(out.status).toBe(422);
    expect(out.body.error).toBe('invalid');
    expect(actions.decideSuggestion).not.toHaveBeenCalled();
  });

  test.each(['gone', 'decided', 'not_linked', 'converted', 'protected'])('refusal %s maps to 409 (protected on a decide is a 409: the word was declined, not bad input)', async (code) => {
    actions.decideSuggestion.mockResolvedValue({ ok: false, code, message: 'plain words' });
    const out = await call('post', `/negatives/${ID}/decide`, { decision: 'add' });
    expect(out.body).toEqual({ error: code, message: 'plain words' });
    expect(out.status).toBe(409);
  });

  test.each(['google_error', 'google_unavailable'])('%s is a 502', async (code) => {
    actions.decideSuggestion.mockResolvedValue({ ok: false, code, message: 'Google Ads did not answer. Try again later.' });
    expect(await call('post', `/negatives/${ID}/decide`, { decision: 'add' })).toEqual({
      status: 502, body: { error: code, message: 'Google Ads did not answer. Try again later.' },
    });
  });
});

describe('POST /negatives/:id/undo', () => {
  test('200 { state: "removed", message }', async () => {
    actions.undoNegative.mockResolvedValue({ ok: true, state: 'removed', message: 'Undone: "squirrel" is no longer blocked in Google Ads.' });
    expect(await call('post', `/negatives/${ID}/undo`)).toEqual({ status: 200, body: { state: 'removed', message: 'Undone: "squirrel" is no longer blocked in Google Ads.' } });
    expect(actions.undoNegative).toHaveBeenCalledWith(ID, { by: 'staff-1' });
  });

  test.each([['gone', 409], ['not_active', 409], ['owner_list', 409], ['google_error', 502]])('%s maps to %i', async (code, status) => {
    actions.undoNegative.mockResolvedValue({ ok: false, code, message: 'plain words' });
    expect(await call('post', `/negatives/${ID}/undo`)).toEqual({ status, body: { error: code, message: 'plain words' } });
  });
});
