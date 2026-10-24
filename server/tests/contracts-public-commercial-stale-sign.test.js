/**
 * POST /api/contracts/:token/sign for a commercial proposal agreement (GATE_COMMERCIAL_PROPOSAL_SIGN): the
 * signature is only good for the quote the contract shows. The agreement is issued by the real service, the proposal
 * is then edited, and the customer signs with the original link: 409, the stale contract is cancelled, nothing is
 * signed, no signed-copy email, no office alert. The control (unedited quote) signs and rings the office once.
 * The comms fence, then the customer row, then the estimate row: the order the agreement issuer holds.
 * Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'stale-sign-test-secret';

function normalizeTable(table) {
  return String(table).replace(/ as \w+$/i, '');
}

let mockRows = {};
const mockWrites = [];
const mockTableOrder = [];

function mockBuilder(rawTable) {
  const table = normalizeTable(rawTable);
  const b = { table, filters: [] };
  const chain = () => b;
  for (const m of ['leftJoin', 'select', 'whereIn', 'whereNull', 'whereNotNull', 'forUpdate', 'orderBy', 'limit']) {
    b[m] = jest.fn(chain);
  }
  b.where = jest.fn((...args) => { b.filters.push(args); return b; });
  b.first = jest.fn(async () => {
    const value = table in mockRows ? mockRows[table] : null;
    const resolved = typeof value === 'function' ? value(b) : value;
    return resolved ?? null;
  });
  b.update = jest.fn(async (payload) => {
    mockWrites.push({ table, op: 'update', payload, filters: b.filters.slice() });
    return 1;
  });
  b.insert = jest.fn(async (payload) => { mockWrites.push({ table, op: 'insert', payload }); return [1]; });
  return b;
}

jest.mock('../models/db', () => {
  const fn = jest.fn((table) => { mockTableOrder.push(String(table)); return mockBuilder(table); });
  fn.transaction = jest.fn(async (cb) => cb(fn));
  fn.raw = jest.fn((s) => s);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({ sendAutopayEnabled: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/contract-signed-email', () => ({ sendSignedContractCopy: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/termite-annual-activation', () => ({
  ANNUAL_TEMPLATE_KEY: 'service_agreement.termite_annual_protection',
  activateTermiteAnnualPlanForSignedContract: jest.fn().mockResolvedValue({ activated: true }),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n1' }) }));
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn().mockResolvedValue(undefined) }));
// The estimate-open check is the route's own (estimate-public.test); here the estimate stays open.
jest.mock('../routes/estimate-public', () => ({ commercialAgreementBlockedFor: jest.fn().mockResolvedValue(false) }));

const express = require('express');
const contractsPublic = require('../routes/contracts-public');
const { ensureAgreement } = require('../services/commercial-proposal-agreement');
const { sendSignedContractCopy } = require('../services/contract-signed-email');
const NotificationService = require('../services/notification-service');
const { estimateRow, makeDb } = require('./helpers/commercial-agreement-fake-db');

const MESSAGE = 'This proposal was updated. Please open the latest proposal to sign.';
const req = { ip: '203.0.113.9', get: () => 'jest-agent' };
const signBody = { signedName: 'Pat Sample', initials: 'PS', agreeElectronic: true, agreeDocumentTerms: true };

async function sign(token) {
  const app = express();
  app.use(express.json());
  app.use('/api/contracts', contractsPublic);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/contracts/${token}/sign`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signBody),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// Issue through the real service, then wire the sign route's database with that contract and the current estimate.
async function issueAndWire() {
  const made = makeDb();
  const issued = await ensureAgreement({ estimate: estimateRow(), req, database: made.database });
  const token = issued.signingUrl.split('/contract/')[1];
  const row = made.state.contracts[0];
  let call = 0;
  const responses = [row, row, row, { ...row, status: 'signed', signed_at: new Date(), signed_name: 'Pat Sample' }];
  mockRows.customer_contracts = () => responses[Math.min(call++, responses.length - 1)];
  mockRows.estimates = () => made.state.estimate;
  return { made, token, row };
}

const ORIGINAL_GATE = process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
beforeEach(() => {
  process.env.GATE_COMMERCIAL_PROPOSAL_SIGN = 'true';
  mockWrites.length = 0;
  mockTableOrder.length = 0;
  mockRows = { customers: { id: 'cust-1', active: true, deleted_at: null } };
  sendSignedContractCopy.mockClear();
  NotificationService.notifyAdmin.mockClear();
});
afterAll(() => {
  if (ORIGINAL_GATE === undefined) delete process.env.GATE_COMMERCIAL_PROPOSAL_SIGN;
  else process.env.GATE_COMMERCIAL_PROPOSAL_SIGN = ORIGINAL_GATE;
});

const writesTo = (table, op) => mockWrites.filter((w) => w.table === table && w.op === op);
const settle = () => new Promise((r) => setTimeout(r, 25));

test('issue, edit the proposal, sign with the original link: 409, contract cancelled, nothing signed, no alert', async () => {
  const { made, token } = await issueAndWire();
  made.state.estimate = estimateRow({}, { buildings: [{ name: 'Main building', lineItems: [
    { description: 'Quarterly pest service', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true },
    { description: 'Cleanout', quantity: 1, unitPrice: 250, frequency: 'one_time' },
  ] }] });

  const res = await sign(token);
  await settle();

  expect(res.status).toBe(409);
  expect(res.body).toEqual({ error: MESSAGE, code: 'proposal_changed' });
  const contractUpdates = writesTo('customer_contracts', 'update');
  expect(contractUpdates).toHaveLength(1);
  expect(contractUpdates[0].payload).toMatchObject({ status: 'cancelled', share_token_hash: null, share_token_expires_at: null });
  expect(contractUpdates.some((w) => w.payload.status === 'signed')).toBe(false);
  expect(writesTo('customer_contract_events', 'insert').map((w) => w.payload.event_type)).toEqual(['cancelled']);
  expect(sendSignedContractCopy).not.toHaveBeenCalled();
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(writesTo('activity_log', 'insert')).toEqual([]);
  expect(writesTo('estimates', 'update')).toEqual([]);
});

test('payment terms changed to Net-15 after issue: the same refusal', async () => {
  const { made, token } = await issueAndWire();
  made.state.estimate = estimateRow({}, { commercialTerms: { paymentTerms: 'net15' } });
  const res = await sign(token);
  expect(res).toMatchObject({ status: 409, body: { error: MESSAGE } });
  expect(writesTo('customer_contracts', 'update').some((w) => w.payload.status === 'signed')).toBe(false);
});

test.each([
  ['initial term', { paymentTerms: 'net30', initialTermMonths: 6 }],
  ['renewal', { paymentTerms: 'net30', renewal: 'Month-to-month.' }],
  ['cancellation', { paymentTerms: 'net30', cancellation: 'Cancel any time.' }],
  ['price adjustment', { paymentTerms: 'net30', priceAdjustment: 'Annual 5% increase.' }],
])('%s changed to something the agreement does not say, after issue: the same refusal', async (_label, commercialTerms) => {
  const { made, token } = await issueAndWire();
  made.state.estimate = estimateRow({}, { commercialTerms });
  const res = await sign(token);
  expect(res).toMatchObject({ status: 409, body: { error: MESSAGE } });
  expect(writesTo('customer_contracts', 'update').some((w) => w.payload.status === 'signed')).toBe(false);
  expect(writesTo('customer_contracts', 'update')[0].payload.status).toBe('cancelled');
});

test('the customer row is locked before the estimate row, and the estimate before the contract row (the issuer\'s order: customer first, so none can deadlock with a customer contact update)', async () => {
  const { token } = await issueAndWire();
  await sign(token);
  const order = mockTableOrder;
  expect(order.indexOf('customers')).toBeGreaterThan(-1);
  expect(order.indexOf('estimates')).toBeGreaterThan(-1);
  expect(order.indexOf('customers')).toBeLessThan(order.indexOf('estimates'));
  // The contract row's own lock (the second customer_contracts read) comes after the estimate lock.
  const contractLocks = order.map((t, i) => (t === 'customer_contracts' ? i : -1)).filter((i) => i >= 0);
  expect(contractLocks[1]).toBeGreaterThan(order.indexOf('estimates'));
});

test('the customer-comms fence is taken before the customer row (the fence the manual commercial win holds), so signing and marking won serialize', async () => {
  const { token } = await issueAndWire();
  const { lockCustomerComms } = require('../utils/customer-comms-lock');
  lockCustomerComms.mockClear();
  lockCustomerComms.mockImplementation(async () => { mockTableOrder.push('comms'); });
  mockTableOrder.length = 0;
  await sign(token);
  expect(lockCustomerComms).toHaveBeenCalledWith(expect.anything(), 'cust-1');
  expect(mockTableOrder.indexOf('comms')).toBeGreaterThan(-1);
  expect(mockTableOrder.indexOf('comms')).toBeLessThan(mockTableOrder.indexOf('customers'));
  lockCustomerComms.mockImplementation(async () => undefined);
});

test('the estimate moved to another customer before the lock: the signature is refused, the contract cancelled, nothing signed', async () => {
  const { made, token } = await issueAndWire();
  made.state.estimate = estimateRow({ customer_id: 'cust-2' });
  const res = await sign(token);
  expect(res).toMatchObject({ status: 409, body: { error: MESSAGE, code: 'proposal_changed' } });
  expect(writesTo('customer_contracts', 'update').some((w) => w.payload.status === 'signed')).toBe(false);
  expect(writesTo('customer_contracts', 'update')[0].payload.status).toBe('cancelled');
  expect(writesTo('customer_contract_events', 'insert').map((w) => JSON.parse(w.payload.metadata).cause)).toEqual(['customer_changed']);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('control: the quote is unchanged, so the contract signs, the copy sends and the office is alerted once', async () => {
  const { token } = await issueAndWire();
  const res = await sign(token);
  await settle();
  expect(res.status).toBe(200);
  expect(res.body.signed).toBe(true);
  expect(writesTo('customer_contracts', 'update').some((w) => w.payload.status === 'signed')).toBe(true);
  expect(writesTo('customer_contracts', 'update').some((w) => w.payload.status === 'cancelled')).toBe(false);
  expect(sendSignedContractCopy).toHaveBeenCalledTimes(1);
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(writesTo('activity_log', 'insert')).toHaveLength(1);
});
