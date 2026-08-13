/**
 * openBalanceExists — the split-tier existence probe (voice relay, AGENTS.md).
 *
 * The rule: for a caller who may not hear the FIGURE, the figure must not even
 * be FETCHED. The probe answers "is there an open self-pay balance" with the
 * same eligibility rules as the full read — same status set, payer-null SQL,
 * cents-positive remainder (in SQL, integer arithmetic), live payer
 * re-resolution failing toward DROP — while its projection carries no amount
 * column at all and it short-circuits at the first qualifying row.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn() }));

const PayerService = require('../services/payer');
const { openBalanceExists } = require('../services/open-balance');

function makeDb(rows) {
  const captured = { select: null, whereRaw: [] };
  const b = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'orderBy', 'limit']) b[m] = jest.fn(() => b);
  b.whereRaw = jest.fn((sql) => { captured.whereRaw.push(String(sql)); return b; });
  b.select = jest.fn((...cols) => { captured.select = cols; return b; });
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  const database = jest.fn(() => b);
  return { database, captured };
}

beforeEach(() => {
  jest.clearAllMocks();
  PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
});

test('the projection carries NO amount columns — the figure never leaves the database', async () => {
  const { database, captured } = makeDb([{ id: 'i1', invoice_number: 'WPC-1', scheduled_service_id: null }]);
  await openBalanceExists('c-1', { database });
  expect(captured.select).toEqual(['id', 'invoice_number', 'scheduled_service_id']);
  for (const col of ['total', 'subtotal', 'credit_applied', 'discount_amount']) {
    expect(captured.select).not.toContain(col);
  }
  // The cents test happens IN SQL, with the same integer arithmetic
  // invoiceAmountDue uses — not the broad-phase float GREATEST.
  expect(captured.whereRaw.some((sql) => sql.includes('ROUND(total * 100)'))).toBe(true);
});

test('a qualifying self-pay row → true; a payer-billed row is DROPPED', async () => {
  const { database } = makeDb([{ id: 'i1', invoice_number: 'WPC-1', scheduled_service_id: 'ss-1' }]);
  PayerService.resolveForInvoice.mockResolvedValue({ payerId: 'payer-9' }); // third party's debt
  expect(await openBalanceExists('c-1', { database })).toBe(false);
  PayerService.resolveForInvoice.mockResolvedValue({ payerId: null });
  expect(await openBalanceExists('c-1', { database })).toBe(true);
});

// ⭐ A DROPPED ROW IS NOT A "NO". This boolean gets SPOKEN as "no open balance"
// — a candidate lost to a transient resolve failure makes the answer
// INDETERMINATE, which the voice layer speaks as "couldn't check".
// ⭐ A FULL PAGE OF NON-QUALIFIERS IS NOT A "NO". With the candidate cap hit
// and every fetched row payer-billed, a self-pay invoice can still exist
// beyond the cap — the probe must degrade to indeterminate, not say "no open
// balance" to a customer who owes money.
test('a FULL candidate page of payer-billed rows is INDETERMINATE (null), never false', async () => {
  const fullPage = Array.from({ length: 200 }, (_, i) => (
    { id: `i${i}`, invoice_number: `WPC-${i}`, scheduled_service_id: null }
  ));
  const { database } = makeDb(fullPage);
  PayerService.resolveForInvoice.mockResolvedValue({ payerId: 'payer-9' }); // all third-party
  expect(await openBalanceExists('c-1', { database })).toBe(null);
});

test('a payer-resolve OUTAGE returns INDETERMINATE (null), never a confident false', async () => {
  const { database } = makeDb([{ id: 'i1', invoice_number: 'WPC-1', scheduled_service_id: null }]);
  PayerService.resolveForInvoice.mockRejectedValue(new Error('payer service down'));
  expect(await openBalanceExists('c-1', { database })).toBe(null);
});

test('no customer / no rows → false', async () => {
  expect(await openBalanceExists(null)).toBe(false);
  const { database } = makeDb([]);
  expect(await openBalanceExists('c-1', { database })).toBe(false);
});
