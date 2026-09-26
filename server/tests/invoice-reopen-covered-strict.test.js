/**
 * reopenAnnualPrepayCoveredInvoicesForTerm({ strict }) — ADMIN-BUG-R17
 * finding 2. The admin remove-flag cancel runs it strict: a per-invoice
 * reopen failure must throw so the operator action rolls back whole, rather
 * than being logged while the term cancel commits with an invoice still
 * covered by the dead term. Every other caller keeps the best-effort reopen.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({
  resumeSequenceIfSystemResumable: jest.fn(async () => null),
  scheduleForInvoice: jest.fn(async () => null),
}));

const logger = require('../services/logger');
const InvoiceService = require('../services/invoice');

// Two covered invoices; the UPDATE for the first one fails.
function fakeConn({ failId }) {
  const updates = [];
  const conn = jest.fn((table) => {
    const q = { filters: {} };
    q.where = jest.fn((filter) => { Object.assign(q.filters, filter); return q; });
    q.whereIn = jest.fn(() => q);
    q.whereRaw = jest.fn(() => q);
    q.first = jest.fn(async () => null); // no cash payment on either invoice
    q.update = jest.fn(async () => {
      if (q.filters.id === failId) throw new Error('synthetic reopen failure');
      updates.push(q.filters.id);
      return 1;
    });
    q.then = (resolve, reject) => {
      const rows = table === 'invoices' && q.filters.annual_prepay_covered_term_id
        ? [{ id: 'inv-a', invoice_number: 'A' }, { id: 'inv-b', invoice_number: 'B' }]
        : [];
      return Promise.resolve(rows).then(resolve, reject);
    };
    return q;
  });
  conn.fn = { now: () => 'now' };
  conn.isTransaction = true;
  return { conn, updates };
}

beforeEach(() => jest.clearAllMocks());

test('strict: a per-invoice reopen failure throws', async () => {
  const { conn, updates } = fakeConn({ failId: 'inv-a' });
  await expect(InvoiceService.reopenAnnualPrepayCoveredInvoicesForTerm('term-1', conn, { strict: true }))
    .rejects.toThrow('synthetic reopen failure');
  expect(updates).toEqual([]);
});

test('default (best-effort): the failure is logged and the next invoice still reopens', async () => {
  const { conn, updates } = fakeConn({ failId: 'inv-a' });
  await expect(InvoiceService.reopenAnnualPrepayCoveredInvoicesForTerm('term-1', conn)).resolves.toBe(1);
  expect(updates).toEqual(['inv-b']);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('annual-prepay coverage reopen skipped for A'));
});
