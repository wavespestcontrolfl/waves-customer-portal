// Receipt add-a-service + referral cards (GATE_DOC_CROSS_SELL, owner
// 2026-11-21). The receipt reuses the service report's composer and tap;
// what this suite pins is the RECEIPT's own decisions: only a PAID receipt
// whose link reaches the account holder alone carries the cards (no
// third-party payer, no service contact), the offer needs the visit the
// invoice is for, the gate hides the routes entirely, and a tap is not
// counted as a receipt view.
jest.mock('../models/db', () => jest.fn(() => {
  const query = {};
  for (const method of ['where', 'whereIn', 'orderBy', 'whereRaw', 'leftJoin']) query[method] = () => query;
  query.first = (...args) => mockFirst(...args);
  return query;
}));
jest.mock('../services/invoice', () => ({ getByToken: jest.fn() }));
jest.mock('../services/payer', () => ({ attachToInvoice: jest.fn(async () => {}) }));
jest.mock('../services/invoice-email', () => ({ inspectionCreditMemoForInvoice: jest.fn(async () => null) }));
jest.mock('../services/pdf/invoice-pdf', () => ({ generateReceiptPDF: jest.fn() }));
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/receipt-payment', () => ({ loadPaymentForInvoice: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
jest.mock('../services/service-report/cross-sell-tap', () => ({
  // The real who-may-see-it rule; only the offer and the tap are stubbed.
  linkReachesOnlyAccountHolder: jest.requireActual('../services/service-report/cross-sell-tap').linkReachesOnlyAccountHolder,
  buildCrossSellForServiceRecord: jest.fn(),
  handleCrossSellTap: jest.fn(),
}));
jest.mock('../services/referral-share', () => ({
  composeReferralCard: jest.fn(),
  buildReferralShareForCustomer: jest.fn(),
}));

const mockFirst = jest.fn();
const InvoiceService = require('../services/invoice');
const { isEnabled } = require('../config/feature-gates');
const tap = require('../services/service-report/cross-sell-tap');
const referralShare = require('../services/referral-share');
const router = require('../routes/receipt-v2');

const OFFER = { serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', option: { id: 'lawn-enhanced', perVisit: 62 }, fingerprint: 'fp' };
const REFERRAL = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };
const INVOICE = {
  id: 'inv-1', customer_id: 'cust-1', status: 'paid', payer_id: null, service_record_id: 'sr-1', total: 85, invoice_number: 'QA-1',
};

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle; // the limiter runs ahead of it as real middleware
}

async function call(method, path, { body } = {}) {
  const res = { statusCode: 200, json: jest.fn() };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  const next = jest.fn();
  await handlerFor(method, path)({ params: { token: 'a'.repeat(64) }, body }, res, next);
  return { res, next };
}

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((key) => key === 'docCrossSell');
  InvoiceService.getByToken.mockResolvedValue({ ...INVOICE });
  mockFirst.mockResolvedValue({ ...INVOICE });
  tap.buildCrossSellForServiceRecord.mockResolvedValue(OFFER);
  referralShare.composeReferralCard.mockResolvedValue(REFERRAL);
});

describe('GET /:token — the cards ride the receipt payload', () => {
  test('a paid receipt for a visit carries both cards, priced from that visit', async () => {
    const { res } = await call('get', '/:token');
    expect(tap.buildCrossSellForServiceRecord).toHaveBeenCalledWith(expect.anything(), 'sr-1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ crossSell: OFFER, referral: REFERRAL }));
  });

  test.each([
    ['gate off', () => isEnabled.mockReturnValue(false)],
    ['payer-billed (the link goes to a third party)', () => mockFirst.mockResolvedValue({ ...INVOICE, payer_id: 'payer-1' })],
    ['account billed to a third-party payer', () => mockFirst.mockResolvedValue({ ...INVOICE, customer_payer_id: 3 })],
    ['a service contact can also get this link', () => mockFirst.mockResolvedValue({ ...INVOICE, service_contact_name: 'Tenant Tina', service_contact_email: 't@example.com' })],
    ['not paid', () => mockFirst.mockResolvedValue({ ...INVOICE, status: 'refunded' })],
  ])('%s → no cards', async (_label, arrange) => {
    arrange();
    const { res } = await call('get', '/:token');
    const payload = res.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty('crossSell');
    expect(payload).not.toHaveProperty('referral');
    expect(tap.buildCrossSellForServiceRecord).not.toHaveBeenCalled();
  });

  test('an invoice with no visit carries the referral card alone', async () => {
    mockFirst.mockResolvedValue({ ...INVOICE, service_record_id: null });
    const { res } = await call('get', '/:token');
    const payload = res.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty('crossSell');
    expect(payload.referral).toEqual(REFERRAL);
  });
});

describe('POST /:token/cross-sell — the report tap, on the receipt', () => {
  test('hands the visit and what was shown to the shared tap and relays its answer', async () => {
    tap.handleCrossSellTap.mockResolvedValue({ status: 200, body: { ok: true, estimateUrl: '/estimate/x' } });
    const metadata = { serviceKey: 'lawn_care', fingerprint: 'fp' };
    const { res } = await call('post', '/:token/cross-sell', { body: { metadata } });
    expect(tap.handleCrossSellTap).toHaveBeenCalledWith(expect.objectContaining({
      serviceRecordId: 'sr-1',
      metadata,
      surface: expect.objectContaining({ source: 'invoice_receipt' }),
    }));
    expect(res.statusCode).toBe(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, estimateUrl: '/estimate/x' });
    // A tap is not a view: the view-recording loader is never used.
    expect(InvoiceService.getByToken).not.toHaveBeenCalled();
  });

  test.each([
    ['gate off', () => isEnabled.mockReturnValue(false)],
    ['payer-billed', () => mockFirst.mockResolvedValue({ ...INVOICE, payer_id: 'payer-1' })],
    ['no visit on the invoice', () => mockFirst.mockResolvedValue({ ...INVOICE, service_record_id: null })],
    ['unknown token', () => mockFirst.mockResolvedValue(undefined)],
  ])('%s → 404, nothing recorded', async (_label, arrange) => {
    arrange();
    const { res } = await call('post', '/:token/cross-sell', { body: { metadata: {} } });
    expect(res.statusCode).toBe(404);
    expect(tap.handleCrossSellTap).not.toHaveBeenCalled();
  });
});

describe('POST /:token/referral-link — enrolls on the tap only', () => {
  test('returns the share for the receipt\'s own customer', async () => {
    const share = { code: 'WAVES-1', link: 'l' };
    referralShare.buildReferralShareForCustomer.mockResolvedValue(share);
    const { res } = await call('post', '/:token/referral-link');
    expect(referralShare.buildReferralShareForCustomer).toHaveBeenCalledWith('cust-1');
    expect(res.json).toHaveBeenCalledWith(share);
  });

  test('a payer-billed receipt never enrolls anyone', async () => {
    mockFirst.mockResolvedValue({ ...INVOICE, payer_id: 'payer-1' });
    const { res } = await call('post', '/:token/referral-link');
    expect(res.statusCode).toBe(404);
    expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
  });
});
