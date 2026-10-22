/**
 * The Intelligence Bar's create_invoice (owner ruling 2026-10-12, Stage 3 cards) replays the Invoices page's own create
 * handlers (admin-invoices.js createInvoiceFromBar for POST /, createInvoiceFromServiceFromBar for POST /from-service).
 * The page route and the shim reach the same service call. The page's call is unchanged (no transaction of its own for an
 * unlinked create, no refuseDepositCredit); the bar adds only the card's total, enforced in one transaction that rolls back
 * on a difference. The bar field is never read from the HTTP body. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockTrx = { isTransaction: true, raw: jest.fn() };
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn(async (callback) => callback(mockTrx));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'staff-1'; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/invoice', () => ({
  create: jest.fn(), createFromService: jest.fn(), sendViaSMSAndEmail: jest.fn(), sendViaSMS: jest.fn(), sendReceipt: jest.fn(),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
jest.mock('../services/scheduled-invoice-mint', () => ({ acquireScheduledInvoiceMintLock: jest.fn(async () => {}) }));
jest.mock('../services/setup-fee-alert-reconcile', () => ({
  acceptedEstimateIdFromNotes: jest.fn((notes) => (/accepted estimate #(\d+)/.exec(String(notes || '')) || [])[1] || null),
  reconcileSetupFeeAlert: jest.fn(async () => {}),
  reconcileSetupFeeAlertForInvoice: jest.fn(async () => {}),
}));

jest.mock('../services/intelligence-bar/create-invoice-tools', () => ({ recheckApprovedScope: jest.fn(async () => {}) }));

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { acquireScheduledInvoiceMintLock } = require('../services/scheduled-invoice-mint');
const setupFee = require('../services/setup-fee-alert-reconcile');
const { recheckApprovedScope } = require('../services/intelligence-bar/create-invoice-tools');
const router = require('../routes/admin-invoices');

const CUST = '00000000-0000-4000-8000-0000000000c1';
const REC = '00000000-0000-4000-8000-0000000000e1';
const VISIT = '00000000-0000-4000-8000-0000000000d1';
const INV = '00000000-0000-4000-8000-0000000000a1';
const BODY = {
  customerId: CUST, title: 'Extra work', notes: null, dueDate: '2099-02-01',
  lineItems: [{ description: 'Extra visit', quantity: 1, unit_price: 85, amount: 85 }],
};
const APPROVED = { expectedTotalCents: 8500, customerId: CUST, customerPin: 'Robin Sample|Sampleton', mode: 'lines', serviceRecordId: null, scheduledServiceId: null, visitInvoices: [] };
const created = (over = {}) => ({ id: INV, customer_id: CUST, token: 'tok', status: 'draft', invoice_number: 'WPC-2099-0042', total: '85.00', ...over });

async function viaPage(path, body) {
  const app = express();
  app.use(express.json());
  app.use('/admin/invoices', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/invoices${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  db.transaction.mockImplementation(async (callback) => callback(mockTrx));
  db.mockImplementation(() => ({ where: () => ({ first: async () => ({ scheduled_service_id: VISIT }) }) }));
});

describe('createInvoiceFromBar runs the create handler', () => {
  test('the page creates with no transaction of its own; the bar creates in one transaction; both answer 201 with the pay link', async () => {
    InvoiceService.create.mockResolvedValue(created());
    const page = await viaPage('/', BODY);
    const bar = await router.createInvoiceFromBar({ body: BODY, approved: APPROVED });
    expect(page.status).toBe(201);
    expect(page.json).toMatchObject({ id: INV, status: 'draft', invoice_number: 'WPC-2099-0042' });
    expect(bar.status).toBe(201);
    expect(bar.json).toMatchObject({ id: INV, status: 'draft', invoice_number: 'WPC-2099-0042' });
    expect(bar.json.payUrl).toEqual(page.json.payUrl);
    // Page path: one call, no `database`, no transaction.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(InvoiceService.create.mock.calls[0][0]).not.toHaveProperty('database');
    expect(InvoiceService.create.mock.calls[0][0]).toMatchObject({ customerId: CUST, title: 'Extra work', dueDate: '2099-02-01' });
    // Bar path: the same arguments, riding the transaction.
    expect(InvoiceService.create.mock.calls[1][0]).toMatchObject({ customerId: CUST, title: 'Extra work', dueDate: '2099-02-01', database: mockTrx });
  });

  test('a total that differs from the card rolls the create back as a 409 IB_TOTAL_MISMATCH; the page has no such check', async () => {
    InvoiceService.create.mockResolvedValue(created({ total: '91.00' }));
    const bar = await router.createInvoiceFromBar({ body: BODY, approved: APPROVED });
    expect(bar).toEqual({ status: 409, json: { error: expect.stringMatching(/total differs from the one the card showed/), code: 'IB_TOTAL_MISMATCH' } });
    const page = await viaPage('/', BODY);
    expect(page.status).toBe(201);
  });

  test('the bar re-checks the approved scope inside the transaction before it mints; the page never does; a changed scope is a 409 and nothing is created', async () => {
    InvoiceService.create.mockResolvedValue(created());
    await viaPage('/', BODY);
    expect(recheckApprovedScope).not.toHaveBeenCalled();
    const order = [];
    recheckApprovedScope.mockImplementationOnce(async () => { order.push('recheck'); });
    InvoiceService.create.mockImplementationOnce(async () => { order.push('create'); return created(); });
    await router.createInvoiceFromBar({ body: BODY, approved: APPROVED });
    expect(order).toEqual(['recheck', 'create']);
    expect(recheckApprovedScope).toHaveBeenCalledWith(mockTrx, APPROVED);
    InvoiceService.create.mockClear();
    recheckApprovedScope.mockRejectedValueOnce(Object.assign(new Error('A payer was assigned, so nothing was created.'), { isOperational: true, statusCode: 409, code: 'IB_SCOPE_CHANGED' }));
    await expect(router.createInvoiceFromBar({ body: BODY, approved: APPROVED }))
      .resolves.toEqual({ status: 409, json: { error: 'A payer was assigned, so nothing was created.', code: 'IB_SCOPE_CHANGED' } });
    expect(InvoiceService.create).not.toHaveBeenCalled();
  });

  test('the HTTP route never takes the card’s total from the request', async () => {
    InvoiceService.create.mockResolvedValue(created({ total: '91.00' }));
    const page = await viaPage('/', { ...BODY, ibApprovedCreate: APPROVED, expectedTotalCents: 8500 });
    expect(page.status).toBe(201);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(InvoiceService.create.mock.calls[0][0]).not.toHaveProperty('database');
  });

  test('a linked visit keeps the mint lock on both paths, and an accepted-estimate stamp keeps the setup-fee reconcile', async () => {
    InvoiceService.create.mockResolvedValue(created());
    const linked = { ...BODY, serviceRecordId: REC, notes: 'accepted estimate #77' };
    await viaPage('/', linked);
    await router.createInvoiceFromBar({ body: linked, approved: APPROVED });
    expect(acquireScheduledInvoiceMintLock).toHaveBeenCalledTimes(2);
    expect(acquireScheduledInvoiceMintLock).toHaveBeenCalledWith(mockTrx, VISIT);
    expect(mockTrx.raw).toHaveBeenCalledTimes(2);
    expect(mockTrx.raw.mock.calls[0][1]).toEqual(['unminted_setup_fee_manual_billing:77']);
    expect(InvoiceService.create.mock.calls.map((c) => c[0].database)).toEqual([mockTrx, mockTrx]);
    expect(InvoiceService.create.mock.calls[1][0]).toMatchObject({ scheduledServiceId: VISIT, serviceRecordId: REC });
    expect(setupFee.reconcileSetupFeeAlert).toHaveBeenCalledTimes(2);
    expect(setupFee.reconcileSetupFeeAlert).toHaveBeenCalledWith(expect.objectContaining({ customerId: CUST, sourceEstimateId: '77' }));
  });

  test('the page’s own refusals reach the shim unchanged; an unexpected error rejects', async () => {
    InvoiceService.create.mockRejectedValueOnce(Object.assign(new Error('Estimate billing is being updated. Retry in a moment.'), { isOperational: true, statusCode: 409, code: 'VISIT_PACKET_OWNS_BILLING' }));
    await expect(router.createInvoiceFromBar({ body: BODY, approved: APPROVED })).resolves.toEqual({ status: 409, json: { error: 'Estimate billing is being updated. Retry in a moment.', code: 'VISIT_PACKET_OWNS_BILLING' } });
    InvoiceService.create.mockRejectedValueOnce(new Error('database down'));
    await expect(router.createInvoiceFromBar({ body: BODY, approved: APPROVED })).rejects.toThrow('database down');
  });

  test('a create sends nothing: no sender in the invoice service runs', async () => {
    InvoiceService.create.mockResolvedValue(created());
    InvoiceService.createFromService.mockResolvedValue(created());
    await router.createInvoiceFromBar({ body: BODY, approved: APPROVED });
    await router.createInvoiceFromServiceFromBar({ body: { serviceRecordId: REC, amount: 85 }, approved: APPROVED });
    for (const sender of ['sendViaSMSAndEmail', 'sendViaSMS', 'sendReceipt']) expect(InvoiceService[sender]).not.toHaveBeenCalled();
  });
});

describe('createInvoiceFromServiceFromBar runs the visit route handler', () => {
  const VISIT_BODY = { serviceRecordId: REC, amount: 85, description: 'Extra visit' };

  test('the page calls createFromService(id, { amount, description, taxRate }) alone; the bar adds refuseDepositCredit and the transaction', async () => {
    InvoiceService.createFromService.mockResolvedValue(created());
    const page = await viaPage('/from-service', VISIT_BODY);
    const bar = await router.createInvoiceFromServiceFromBar({ body: VISIT_BODY, approved: APPROVED });
    expect(page.status).toBe(201);
    expect(bar.status).toBe(201);
    expect(bar.json).toMatchObject({ id: INV, status: 'draft' });
    expect(InvoiceService.createFromService.mock.calls[0]).toEqual([REC, { amount: 85, description: 'Extra visit', taxRate: undefined }]);
    expect(InvoiceService.createFromService.mock.calls[1]).toEqual([REC, { amount: 85, description: 'Extra visit', taxRate: undefined, refuseDepositCredit: true, database: mockTrx }]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(setupFee.reconcileSetupFeeAlertForInvoice).toHaveBeenCalledTimes(2);
  });

  test('a total that differs from the card is a 409 IB_TOTAL_MISMATCH; a service 409 (a deposit would apply) rejects with its status', async () => {
    InvoiceService.createFromService.mockResolvedValueOnce(created({ total: '99.00' }));
    await expect(router.createInvoiceFromServiceFromBar({ body: VISIT_BODY, approved: APPROVED }))
      .resolves.toMatchObject({ status: 409, json: { code: 'IB_TOTAL_MISMATCH' } });
    InvoiceService.createFromService.mockRejectedValueOnce(Object.assign(new Error('An estimate deposit credit would apply to this invoice — bill it from Billing Recovery.'), { status: 409 }));
    await expect(router.createInvoiceFromServiceFromBar({ body: VISIT_BODY, approved: APPROVED })).rejects.toMatchObject({ status: 409 });
    expect(setupFee.reconcileSetupFeeAlertForInvoice).not.toHaveBeenCalled();
  });

  test('the visit route re-checks the approved scope in the transaction before it mints, and a changed scope is a 409', async () => {
    InvoiceService.createFromService.mockResolvedValue(created());
    const order = [];
    recheckApprovedScope.mockImplementationOnce(async () => { order.push('recheck'); });
    InvoiceService.createFromService.mockImplementationOnce(async () => { order.push('create'); return created(); });
    await router.createInvoiceFromServiceFromBar({ body: VISIT_BODY, approved: APPROVED });
    expect(order).toEqual(['recheck', 'create']);
    InvoiceService.createFromService.mockClear();
    recheckApprovedScope.mockRejectedValueOnce(Object.assign(new Error('An invoice on this visit changed, so nothing was created.'), { isOperational: true, statusCode: 409, code: 'IB_SCOPE_CHANGED' }));
    await expect(router.createInvoiceFromServiceFromBar({ body: VISIT_BODY, approved: APPROVED }))
      .resolves.toMatchObject({ status: 409, json: { code: 'IB_SCOPE_CHANGED' } });
    expect(InvoiceService.createFromService).not.toHaveBeenCalled();
    await viaPage('/from-service', VISIT_BODY);
    expect(recheckApprovedScope).toHaveBeenCalledTimes(2);
  });

  test('the HTTP route never takes the bar’s fields from the request', async () => {
    InvoiceService.createFromService.mockResolvedValue(created({ total: '99.00' }));
    const page = await viaPage('/from-service', { ...VISIT_BODY, ibApprovedCreate: APPROVED, refuseDepositCredit: true });
    expect(page.status).toBe(201);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(InvoiceService.createFromService.mock.calls[0][1]).not.toHaveProperty('refuseDepositCredit');
    expect(InvoiceService.createFromService.mock.calls[0][1]).not.toHaveProperty('database');
  });
});
