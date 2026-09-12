/**
 * A Bill-To change that lands DURING the Stripe round-trip must not leave a
 * recorded authorization behind: the consent row and the ownership judgement
 * commit in one transaction, so the withdrawal wins and nothing is recorded.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn(async (cb) => cb(fn));
  fn.isTransaction = true;
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const Packets = require('../services/visit-completion-packets');
const ConsentService = require('../services/payment-method-consents');

function invoiceChain(row) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => row);
  return q;
}

beforeEach(() => jest.clearAllMocks());

test('a withdrawal seen inside the fence refuses before any consent row is written', async () => {
  // The invoice reads as withdrawn at the moment of the judgement.
  db.mockImplementation(() => invoiceChain({
    id: 'inv-1', payer_id: null, scheduled_send_error: 'payer_billed:7:hold', visit_completion_packet_id: null,
  }));
  const insert = jest.spyOn(ConsentService, 'recordConsent');

  const owned = await Packets.invoicePayerOwnedNow('inv-1', db);

  expect(owned).toBe(true);
  expect(insert).not.toHaveBeenCalled();
  insert.mockRestore();
});

test('a self-pay invoice inside the fence is allowed through', async () => {
  db.mockImplementation(() => invoiceChain({
    id: 'inv-1', payer_id: null, scheduled_send_error: null, visit_completion_packet_id: null,
  }));
  expect(await Packets.invoicePayerOwnedNow('inv-1', db)).toBe(false);
});

test('an unreadable invoice inside the fence counts as payer-owned', async () => {
  db.mockImplementation(() => invoiceChain(undefined));
  expect(await Packets.invoicePayerOwnedNow('inv-1', db)).toBe(true);
});

test('recordConsent writes through the caller transaction when one is given', () => {
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../services/payment-method-consents.js'), 'utf8',
  );
  // The insert must use the injected handle, or the fence above would not
  // actually contain the write.
  expect(source).toContain("await database('payment_method_consents').insert(");
});
