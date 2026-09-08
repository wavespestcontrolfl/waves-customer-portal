jest.mock('../models/db', () => jest.fn(() => {
  const query = {};
  for (const method of ['where', 'whereIn', 'orderBy', 'whereRaw']) query[method] = () => query;
  query.first = (...args) => mockFirst(...args);
  return query;
}));
jest.mock('../services/invoice', () => ({ getByToken: jest.fn() }));
jest.mock('../services/payer', () => ({ attachToInvoice: jest.fn(async () => {}) }));
jest.mock('../services/invoice-email', () => ({ inspectionCreditMemoForInvoice: jest.fn(async () => null) }));
jest.mock('../services/pdf/invoice-pdf', () => ({ generateReceiptPDF: jest.fn() }));
jest.mock('../services/logger', () => ({ warn: jest.fn() }));

const mockFirst = jest.fn();
const { loadPaymentForInvoice } = require('../services/receipt-payment');
const InvoiceService = require('../services/invoice');
const { generateReceiptPDF } = require('../services/pdf/invoice-pdf');
const router = require('../routes/receipt-v2');
const invoice = { id: 'invoice-1', customer_id: 'customer-1', status: 'paid', total: 85, invoice_number: 'QA-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockFirst.mockRejectedValue(new Error('Payment lookup unavailable'));
  InvoiceService.getByToken.mockResolvedValue({ ...invoice });
});

test('payment resolution distinguishes a database failure from a confirmed missing record', async () => {
  await expect(loadPaymentForInvoice(invoice.id, invoice.customer_id)).rejects.toThrow('Payment lookup unavailable');
  mockFirst.mockResolvedValue(undefined);
  await expect(loadPaymentForInvoice(invoice.id, invoice.customer_id)).resolves.toBeNull();
});

test.each([
  ['/:token', 'paid', 200],
  ['/:token/pdf', 'paid', 200],
  ['/:token/pdf', 'refunded', 409],
])('permanent receipt %s preserves its %s behavior on a payment lookup failure', async (path, status, expectedStatus) => {
  const data = { ...invoice, status };
  InvoiceService.getByToken.mockResolvedValue(data);
  const res = { statusCode: 200, json: jest.fn() };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  const next = jest.fn();
  const handler = router.stack.find((layer) => layer.route?.path === path).route.stack[0].handle;
  await handler({ params: { token: 'a'.repeat(64) } }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(expectedStatus);
  if (path === '/:token') {
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ invoice: expect.objectContaining({ total: 85 }), payment: null }));
  } else if (status === 'paid') {
    expect(generateReceiptPDF).toHaveBeenCalledWith(data, null, res);
  } else {
    expect(generateReceiptPDF).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ error: 'Receipt not available — refund record could not be resolved' });
  }
});
