jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(), gateEnvValue: jest.fn(() => false) }));
jest.mock('../services/estimate-change-request', () => ({
  createEstimateOfficeRequest: jest.fn(), recordEstimateStillDeciding: jest.fn(), isSoftExitEligible: () => true,
}));
const express = require('express');
const db = require('../models/db');
const gates = require('../config/feature-gates');
const office = require('../services/estimate-change-request');
const router = require('../routes/estimate-public');
const token = '0123456789abcdef0123456789abcdef';
const app = express();
app.use(express.json());
app.use('/api/estimates', router);
let server;
beforeAll(async () => { await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); }); });
afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
async function post(path, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
let row;
beforeEach(() => {
  jest.clearAllMocks();
  row = { id: 'estimate-fixture', token, status: 'sent', estimate_data: { websiteSelfService: { publishedAt: new Date().toISOString() } } };
  gates.isEnabled.mockImplementation(gate => gate === 'websiteQuoteBooking');
  db.mockImplementation(() => ({ where: () => ({ first: async () => row }) }));
  office.createEstimateOfficeRequest.mockImplementation(async ({ callSideBlockedFor }) => {
    if (await callSideBlockedFor(db, row)) throw Object.assign(new Error('Estimate not found'), { status: 404 });
    return { success: true, deduped: false };
  });
});

it('uses the website gate and existing office writer for a callback', async () => {
  const response = await post(`/api/estimates/${token}/change-request`, { kind: 'callback' });
  expect(response.status).toBe(201);
  expect(office.createEstimateOfficeRequest).toHaveBeenCalledWith(expect.objectContaining({ kind: 'callback', estimateToken: token }));
});

it('keeps a dark callback at generic 404 before any DB read or rate-limit disclosure', async () => {
  gates.isEnabled.mockReturnValue(false);
  for (let i = 0; i < 7; i += 1) {
    const response = await post(`/api/estimates/${token}/change-request`, { kind: 'callback' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Estimate not found' });
  }
  expect(db).not.toHaveBeenCalled();
});

it('rejects malformed tokens before reading the database', async () => {
  const response = await post('/api/estimates/bad/change-request', { kind: 'callback' });
  expect(response.status).toBe(404);
  expect(db).not.toHaveBeenCalled();
});

it('does not admit an ordinary estimate to the website callback lane', async () => {
  row.estimate_data = {};
  const response = await post(`/api/estimates/${token}/change-request`, { kind: 'callback' });
  expect(response.status).toBe(404);
});

it('rechecks the website publication stamp on the locked row', async () => {
  office.createEstimateOfficeRequest.mockImplementation(async ({ callSideBlockedFor }) => {
    const blocked = await callSideBlockedFor(db, { ...row, estimate_data: {} });
    if (blocked) throw Object.assign(new Error('Estimate not found'), { status: 404 });
    throw new Error('Expected a blocked callback');
  });
  const response = await post(`/api/estimates/${token}/change-request`, { kind: 'callback' });
  expect(response.status).toBe(404);
});
