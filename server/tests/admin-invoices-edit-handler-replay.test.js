/**
 * The Intelligence Bar's invoice edit cards (owner ruling 2026-10-12, Stage 3 cards) replay the Invoices page's own
 * handlers (admin-invoices.js editInvoiceFromBar, unvoidInvoiceFromBar, archiveInvoiceFromBar, unarchiveInvoiceFromBar).
 * The page route and the shim reach the same service call; the page's call is unchanged (no `expected`); the bar adds only
 * the invoice version the card showed, and a changed invoice is a 409 PREVIEW_CHANGED. Synthetic data only.
 * The apply-credit handler is replayed in admin-invoices-apply-credit-bar-replay.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'staff-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice', () => ({
  update: jest.fn(), unvoidInvoice: jest.fn(), voidInvoice: jest.fn(),
  sendViaSMSAndEmail: jest.fn(), sendViaSMS: jest.fn(), sendReceipt: jest.fn(),
}));
const mockReconcile = jest.fn(async () => undefined);
jest.mock('../services/setup-fee-alert-reconcile', () => ({ reconcileSetupFeeAlertForInvoice: (...a) => mockReconcile(...a) }));

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const router = require('../routes/admin-invoices');

const INV = '00000000-0000-4000-8000-0000000000a1';
const UPDATED = new Date('2099-01-01T12:00:00.123Z');
const EXPECTED_EDIT = { status: 'sent', updatedAt: UPDATED.getTime(), total: 129, creditApplied: 0, paymentIntentId: null, newTotal: 149 };
const BODY = { due_date: '2099-02-01' };

async function viaPage(path, { method = 'POST', body } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices/${INV}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// A recorder for the invoices table: every where* call is kept; first() answers the current row; update().returning() the result.
let invoiceRow;
let updateResult;
let calls;
function recorder() {
  const q = {};
  for (const name of ['where', 'whereRaw', 'whereNull', 'whereNotNull']) {
    q[name] = jest.fn((...args) => { calls.push([name, ...args]); return q; });
  }
  q.first = jest.fn(async () => invoiceRow);
  q.update = jest.fn((...args) => { calls.push(['update', ...args]); return q; });
  q.returning = jest.fn(async () => updateResult);
  return q;
}

const driftError = (what) => Object.assign(new Error(`Invoice changed while ${what} — re-check and retry`), { statusCode: 409, status: 409, isOperational: true, code: 'PREVIEW_CHANGED' });

beforeEach(() => {
  jest.clearAllMocks();
  calls = [];
  invoiceRow = { id: INV, status: 'void', updated_at: UPDATED, archived_at: null, total: '129.00' };
  updateResult = [{ ...invoiceRow, archived_at: '2099-01-02T00:00:00Z' }];
  db.mockReset();
  db.mockImplementation(() => recorder());
  db.fn = { now: jest.fn(() => 'NOW()') };
});

describe('PUT /:id — editInvoiceFromBar', () => {
  test('the page calls update(id, body) with no options; the bar adds only the card’s version; both answer alike', async () => {
    InvoiceService.update.mockResolvedValue({ id: INV, status: 'sent', total: '129.00' });
    const page = await viaPage('', { method: 'PUT', body: BODY });
    const bar = await router.editInvoiceFromBar({ invoiceId: INV, body: BODY, actor: { technicianId: 'staff-1' }, expected: EXPECTED_EDIT });
    expect(page).toEqual({ status: 200, json: { id: INV, status: 'sent', total: '129.00' } });
    expect(bar).toEqual(page);
    expect(InvoiceService.update.mock.calls[0]).toEqual([INV, BODY]);
    expect(InvoiceService.update.mock.calls[1]).toEqual([INV, BODY, { expected: EXPECTED_EDIT }]);
    // The setup-fee reconcile runs on the saved row for the bar exactly as for the page.
    expect(mockReconcile).toHaveBeenCalledTimes(4);
  });

  test('the HTTP route never takes the version from the request', async () => {
    InvoiceService.update.mockResolvedValue({ id: INV, status: 'sent' });
    await viaPage('', { method: 'PUT', body: { ...BODY, ibExpectedEdit: EXPECTED_EDIT, expected: EXPECTED_EDIT } });
    expect(InvoiceService.update.mock.calls[0][2]).toBeUndefined();
    expect(InvoiceService.update.mock.calls[0]).toHaveLength(2);
  });

  test('the service’s refusals reach the shim unchanged: not found, drift (409 + code), the page’s 409 and 400 texts; an unexpected error rejects', async () => {
    InvoiceService.update.mockResolvedValueOnce(null);
    await expect(router.editInvoiceFromBar({ invoiceId: INV, body: BODY, expected: EXPECTED_EDIT })).resolves.toEqual({ status: 404, json: { error: 'Not found' } });
    InvoiceService.update.mockRejectedValueOnce(driftError('editing'));
    await expect(router.editInvoiceFromBar({ invoiceId: INV, body: BODY, expected: EXPECTED_EDIT })).resolves
      .toEqual({ status: 409, json: { error: 'Invoice changed while editing — re-check and retry', code: 'PREVIEW_CHANGED' } });
    InvoiceService.update.mockRejectedValueOnce(new Error('Cannot edit amounts on an invoice with payment already applied (payment p1)'));
    await expect(router.editInvoiceFromBar({ invoiceId: INV, body: BODY, expected: EXPECTED_EDIT })).resolves.toMatchObject({ status: 409 });
    InvoiceService.update.mockRejectedValueOnce(new Error('Invalid line-item discount'));
    await expect(router.editInvoiceFromBar({ invoiceId: INV, body: BODY, expected: EXPECTED_EDIT })).resolves.toMatchObject({ status: 400 });
    InvoiceService.update.mockRejectedValueOnce(new Error('database down'));
    await expect(router.editInvoiceFromBar({ invoiceId: INV, body: BODY, expected: EXPECTED_EDIT })).rejects.toThrow('database down');
  });

  test('an edit sends nothing: no sender in the invoice service runs', async () => {
    InvoiceService.update.mockResolvedValue({ id: INV, status: 'sent' });
    await router.editInvoiceFromBar({ invoiceId: INV, body: BODY, expected: EXPECTED_EDIT });
    for (const sender of ['sendViaSMSAndEmail', 'sendViaSMS', 'sendReceipt']) expect(InvoiceService[sender]).not.toHaveBeenCalled();
  });
});

describe('POST /:id/unvoid — unvoidInvoiceFromBar', () => {
  const EXPECTED = { status: 'void', updatedAt: UPDATED.getTime() };

  test('the page calls unvoidInvoice(id) with no options; the bar adds only the card’s version; both answer alike', async () => {
    InvoiceService.unvoidInvoice.mockResolvedValue({ id: INV, status: 'draft' });
    const page = await viaPage('/unvoid');
    const bar = await router.unvoidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED });
    expect(page).toEqual({ status: 200, json: { id: INV, status: 'draft' } });
    expect(bar).toEqual(page);
    expect(InvoiceService.unvoidInvoice.mock.calls[0]).toEqual([INV]);
    expect(InvoiceService.unvoidInvoice.mock.calls[1]).toEqual([INV, { expected: EXPECTED }]);
  });

  test('the HTTP route never takes the version from the request', async () => {
    InvoiceService.unvoidInvoice.mockResolvedValue({ id: INV, status: 'draft' });
    await viaPage('/unvoid', { body: { ibExpectedUnvoid: EXPECTED, expected: EXPECTED } });
    expect(InvoiceService.unvoidInvoice.mock.calls[0]).toEqual([INV]);
  });

  test('the page’s own refusals reach the shim unchanged; drift is a 409 with its code; an unexpected error rejects', async () => {
    InvoiceService.unvoidInvoice.mockRejectedValueOnce(new Error('Invoice not found'));
    await expect(router.unvoidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED })).resolves.toEqual({ status: 404, json: { error: 'Invoice not found' } });
    InvoiceService.unvoidInvoice.mockRejectedValueOnce(driftError('unvoiding'));
    await expect(router.unvoidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED })).resolves
      .toEqual({ status: 409, json: { error: 'Invoice changed while unvoiding — re-check and retry', code: 'PREVIEW_CHANGED' } });
    InvoiceService.unvoidInvoice.mockRejectedValueOnce(new Error('Cannot unvoid — this invoice belongs to an annual prepay term; manage it from Annual prepay instead'));
    await expect(router.unvoidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED })).resolves.toMatchObject({ status: 409 });
    InvoiceService.unvoidInvoice.mockRejectedValueOnce(new Error('database down'));
    await expect(router.unvoidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED })).rejects.toThrow('database down');
  });
});

describe.each([
  ['archive', 'archiveInvoiceFromBar', '/archive', { status: 'void', archived: false }, { archived_at: null }, /Only voided|archived_at/],
  ['unarchive', 'unarchiveInvoiceFromBar', '/unarchive', { status: 'void', archived: true }, { archived_at: new Date('2099-01-02T00:00:00Z') }, null],
])('POST /:id/%s — %s', (name, shim, path, versionKeys, rowChange) => {
  const expected = () => ({ ...versionKeys, updatedAt: UPDATED.getTime() });
  const writes = () => calls.filter(([n]) => n === 'update');
  const predicates = () => calls.filter(([n]) => ['whereRaw', 'whereNull', 'whereNotNull'].includes(n));
  const updateBody = name === 'archive' ? { archived_at: 'NOW()', updated_at: 'NOW()' } : { archived_at: null, updated_at: 'NOW()' };

  beforeEach(() => {
    invoiceRow = { id: INV, status: 'void', updated_at: UPDATED, total: '129.00', archived_at: null, ...rowChange };
    updateResult = [{ ...invoiceRow, archived_at: name === 'archive' ? '2099-01-02T00:00:00Z' : null }];
  });

  test('the page’s write carries no version predicates; the bar’s carries the edit time and archive state', async () => {
    const page = await viaPage(path);
    expect(page.status).toBe(200);
    expect(writes()).toEqual([['update', updateBody]]);
    expect(predicates()).toEqual([]);
    calls = [];
    const bar = await router[shim]({ invoiceId: INV, expected: expected() });
    expect(bar.status).toBe(200);
    expect(writes()).toEqual([['update', updateBody]]);
    const sql = predicates().map((c) => c[1]).join(' | ');
    expect(sql).toMatch(/date_trunc\('milliseconds', updated_at\) = \?::timestamptz/);
    expect(predicates().find((c) => /date_trunc/.test(c[1]))[2]).toEqual([UPDATED.toISOString()]);
    expect(predicates().map((c) => c[0])).toEqual(expect.arrayContaining([versionKeys.archived ? 'whereNotNull' : 'whereNull']));
    expect(calls.filter(([n, col, value]) => n === 'where' && col === 'status' && value === 'void').length).toBe(1);
  });

  test('a changed invoice (edit time, status or archive state) is a 409 PREVIEW_CHANGED and nothing is written', async () => {
    for (const change of [{ updated_at: new Date('2099-01-02T00:00:00Z') }, { status: 'draft' }, { archived_at: versionKeys.archived ? null : new Date() }]) {
      calls = [];
      invoiceRow = { ...invoiceRow, ...change };
      const answer = await router[shim]({ invoiceId: INV, expected: expected() });
      expect(answer).toMatchObject({ status: 409, json: { code: 'PREVIEW_CHANGED' } });
      expect(writes()).toEqual([]);
      invoiceRow = { id: INV, status: 'void', updated_at: UPDATED, total: '129.00', archived_at: null, ...rowChange };
    }
  });

  test('a write that matches no row (the invoice changed after the read) is a 409 PREVIEW_CHANGED for the bar', async () => {
    updateResult = [];
    await expect(router[shim]({ invoiceId: INV, expected: expected() })).resolves.toMatchObject({ status: 409, json: { code: 'PREVIEW_CHANGED' } });
  });

  test('the HTTP route never takes the version from the request', async () => {
    await viaPage(path, { body: { ibExpectedArchive: expected(), ibExpectedUnarchive: expected(), expected: expected() } });
    expect(predicates()).toEqual([]);
  });

  test('not found is a 404; the idempotent case answers the row without a write', async () => {
    invoiceRow = undefined;
    await expect(router[shim]({ invoiceId: INV, expected: expected() })).resolves.toEqual({ status: 404, json: { error: 'Invoice not found' } });
    invoiceRow = { id: INV, status: 'void', updated_at: UPDATED, total: '129.00', archived_at: name === 'archive' ? new Date('2099-01-02T00:00:00Z') : null };
    calls = [];
    // Already in the wanted state AND the version differs only in the archive flag: the bar’s pin sees the change first.
    const answer = await router[shim]({ invoiceId: INV, expected: { status: 'void', updatedAt: UPDATED.getTime() } });
    expect(answer.status).toBe(200);
    expect(writes()).toEqual([]);
  });
});

test('archive keeps the page’s own refusal for an invoice that is not void, through the shim', async () => {
  invoiceRow = { id: INV, status: 'sent', updated_at: UPDATED, archived_at: null };
  await expect(router.archiveInvoiceFromBar({ invoiceId: INV, expected: { status: 'sent', updatedAt: UPDATED.getTime(), archived: false } })).resolves
    .toEqual({ status: 400, json: { error: 'Only voided invoices can be archived (current status: sent)' } });
  expect(calls.filter(([n]) => n === 'update')).toEqual([]);
});
