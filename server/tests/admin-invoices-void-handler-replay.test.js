/**
 * The Intelligence Bar's void_invoice (owner ruling 2026-10-12, Stage 3 cards) replays the Invoices page's own Void
 * handler (admin-invoices.js voidInvoiceFromBar). The page route and the shim reach the same service call; the page's call
 * is unchanged (one argument, no `expected`); the bar adds only the invoice version the card showed. Synthetic data only.
 * The second half runs InvoiceService.voidInvoice itself against a recorder to pin the extra predicates.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'staff-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice', () => ({ voidInvoice: jest.fn(), sendViaSMSAndEmail: jest.fn(), sendViaSMS: jest.fn(), sendReceipt: jest.fn() }));

const express = require('express');
const InvoiceService = require('../services/invoice');
const router = require('../routes/admin-invoices');

const INV = '00000000-0000-4000-8000-0000000000a1';
const EXPECTED = { status: 'sent', updatedAt: 4070908800000, total: 129, creditApplied: 0, paymentIntentId: null };

async function viaPage() {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices/${INV}/void`, { method: 'POST' });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => jest.clearAllMocks());

describe('voidInvoiceFromBar runs the Void handler', () => {
  test('the page calls voidInvoice(id) with no options; the bar adds only the card’s version; both answer alike', async () => {
    InvoiceService.voidInvoice.mockResolvedValue({ id: INV, status: 'void' });
    const page = await viaPage();
    const bar = await router.voidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED });
    expect(page).toEqual({ status: 200, json: { id: INV, status: 'void' } });
    expect(bar).toEqual(page);
    // Page path byte-identical: exactly one argument.
    expect(InvoiceService.voidInvoice.mock.calls[0]).toEqual([INV]);
    expect(InvoiceService.voidInvoice.mock.calls[1]).toEqual([INV, { expected: EXPECTED }]);
  });

  test('the HTTP route never takes the version from the request', async () => {
    InvoiceService.voidInvoice.mockResolvedValue({ id: INV, status: 'void' });
    const app = express();
    app.use(express.json());
    app.use('/admin/invoices', router);
    const server = app.listen(0);
    try {
      await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices/${INV}/void`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ibExpectedVoid: EXPECTED, expected: EXPECTED }),
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(InvoiceService.voidInvoice.mock.calls[0]).toEqual([INV]);
  });

  test('the page’s own refusals reach the shim unchanged, as 404 / 409; an unexpected error rejects', async () => {
    InvoiceService.voidInvoice.mockRejectedValueOnce(new Error('Invoice not found'));
    await expect(router.voidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED })).resolves.toEqual({ status: 404, json: { error: 'Invoice not found' } });
    InvoiceService.voidInvoice.mockRejectedValueOnce(new Error('Cannot void a paid invoice — issue a refund instead'));
    await expect(router.voidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED })).resolves.toMatchObject({ status: 409 });
    InvoiceService.voidInvoice.mockRejectedValueOnce(new Error('Invoice status changed while voiding — re-check and retry'));
    await expect(router.voidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED })).resolves.toMatchObject({ status: 409 });
    InvoiceService.voidInvoice.mockRejectedValueOnce(new Error('database down'));
    await expect(router.voidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED })).rejects.toThrow('database down');
  });

  test('a void sends nothing: no sender in the invoice service runs', async () => {
    InvoiceService.voidInvoice.mockResolvedValue({ id: INV, status: 'void' });
    await router.voidInvoiceFromBar({ invoiceId: INV, expected: EXPECTED });
    for (const sender of ['sendViaSMSAndEmail', 'sendViaSMS', 'sendReceipt']) expect(InvoiceService[sender]).not.toHaveBeenCalled();
  });
});
