// The prepaid-receipt send is an AUTHENTICATED operator action (POST
// /api/admin/schedule/:id/prepaid with an explicit receipt request), so its
// SMS leg carries operator provenance for the 8AM-8PM ET send window
// (codex #3259 r21 local audit). Without it an after-hours send is held,
// the email leg still succeeds, and the receipt_sent_at claim stays taken —
// permanently dropping the text the operator asked for. The default stays
// FENCED so any future autonomous caller can't inherit the exemption.

jest.mock('../models/db', () => {
  const chain = () => {
    const q = {};
    ['where', 'whereNull', 'whereIn', 'whereNotNull', 'join', 'leftJoin', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.first = jest.fn(async () => null);
    q.update = jest.fn(async () => 1);
    q.insert = jest.fn(async () => [1]);
    q.returning = jest.fn(async () => []);
    return q;
  };
  const mockDb = jest.fn(() => chain());
  mockDb.raw = jest.fn((sql) => sql);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-email', () => ({
  sendReceiptEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/invoice', () => ({
  sendReceipt: jest.fn(async () => ({ sent: true })),
}));

const InvoiceService = require('../services/invoice');
const { sendPrepaidReceiptForInvoice } = require('../routes/admin-schedule')._test;

const INVOICE = { id: 'inv-1', invoice_number: 'WPC-2026-0001' };

describe('prepaid receipt operator provenance', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an operator-initiated prepaid receipt exempts its SMS leg from the send window', async () => {
    await sendPrepaidReceiptForInvoice(INVOICE, { operatorInitiated: true });
    expect(InvoiceService.sendReceipt).toHaveBeenCalledWith('inv-1', expect.objectContaining({
      operatorInitiated: true,
      hasEmailLeg: true,
    }));
  });

  test('the default is FENCED — an autonomous caller never inherits the exemption', async () => {
    await sendPrepaidReceiptForInvoice(INVOICE);
    expect(InvoiceService.sendReceipt).toHaveBeenCalledWith('inv-1', expect.objectContaining({
      operatorInitiated: false,
    }));
  });
});
