// Receipt add-a-service + referral cards (GATE_DOC_CROSS_SELL, owner
// 2026-11-21). Each card is a link into the Waves app (owner 2026-11-22):
// the receipt link is the pay link, so nothing on the receipt acts and the
// app's sign-in decides who may. What this suite pins is the RECEIPT's own
// decisions: when a paid receipt shows the cards (7 days after its payment,
// owner "week"; never for a payer, a service contact, a billing contact or a
// callback visit), that the offer is the one the app shows that customer,
// that the payload carries only what the page prints, and that the receipt
// router has no write route at all.
jest.mock('../models/db', () => Object.assign(jest.fn(() => {
  const query = {};
  for (const method of ['where', 'whereIn', 'orderBy', 'whereRaw', 'leftJoin']) query[method] = () => query;
  query.first = (...args) => mockFirst(...args);
  return query;
}), { raw: (sql) => sql }));
jest.mock('../services/invoice', () => ({ getByToken: jest.fn() }));
jest.mock('../services/payer', () => ({ attachToInvoice: jest.fn(async () => {}) }));
jest.mock('../services/invoice-email', () => ({ inspectionCreditMemoForInvoice: jest.fn(async () => null) }));
jest.mock('../services/pdf/invoice-pdf', () => ({ generateReceiptPDF: jest.fn() }));
jest.mock('../services/logger', () => ({ warn: jest.fn() }));
jest.mock('../services/receipt-payment', () => ({ loadPaymentForInvoice: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn() }));
// The app's own answer to "which offer does this customer see"; its gate and
// composer are pinned in app-link-cards.test.js.
jest.mock('../services/property-recommendations', () => ({ appOfferForCustomer: jest.fn() }));
jest.mock('../services/referral-share', () => ({ composeReferralCard: jest.fn() }));

const mockFirst = jest.fn();
const db = require('../models/db');
const logger = require('../services/logger');
const InvoiceService = require('../services/invoice');
const { isEnabled } = require('../config/feature-gates');
const { appOfferForCustomer } = require('../services/property-recommendations');
const referralShare = require('../services/referral-share');
const router = require('../routes/receipt-v2');
const { receiptCardsForInvoiceId } = require('../services/receipt-cards');

// The app's offer, as its composer returns it.
const APP_OFFER = {
  serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', relationship: 'add',
  option: { id: 'lawn-enhanced', perVisit: 62 }, fingerprint: 'fp',
};
// What the receipt page gets of it.
const CARD = { label: 'Lawn Care', relationship: 'add', perApplication: 62 };
const REFERRAL = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };
const DAY_MS = 24 * 60 * 60 * 1000;
const paidAgo = (ms) => new Date(Date.now() - ms).toISOString();
const INVOICE = {
  id: 'inv-1', customer_id: 'cust-1', status: 'paid', paid_at: paidAgo(60 * 1000), payer_id: null, total: 85, invoice_number: 'QA-1',
};

async function getReceipt() {
  const layer = router.stack.find((l) => l.route?.path === '/:token' && l.route.methods.get);
  const stack = layer.route.stack;
  const res = { statusCode: 200, json: jest.fn() };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  const next = jest.fn();
  await stack[stack.length - 1].handle({ params: { token: 'a'.repeat(64) } }, res, next);
  return res.json.mock.calls[0][0];
}

afterEach(() => { delete process.env.GATE_RESERVICE_REPORT_COPY; });

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((key) => key === 'docCrossSell');
  InvoiceService.getByToken.mockResolvedValue({ ...INVOICE });
  mockFirst.mockResolvedValue({ ...INVOICE });
  appOfferForCustomer.mockResolvedValue(APP_OFFER);
  referralShare.composeReferralCard.mockResolvedValue(REFERRAL);
});

describe('GET /:token — the cards ride the receipt payload', () => {
  test('a paid receipt carries both cards: the offer the app shows this customer, and the referral', async () => {
    const payload = await getReceipt();
    expect(appOfferForCustomer).toHaveBeenCalledWith('cust-1', expect.anything());
    expect(referralShare.composeReferralCard).toHaveBeenCalledWith({ customerId: 'cust-1' });
    expect(payload.referral).toEqual(REFERRAL);
    // Only what the page prints: the page has nothing to send back, so no
    // option id, fingerprint or service key leaves the server.
    expect(payload.crossSell).toEqual(CARD);
  });

  test.each([
    ['gate off', () => isEnabled.mockReturnValue(false)],
    ['payer-billed (the link goes to a third party)', () => mockFirst.mockResolvedValue({ ...INVOICE, payer_id: 'payer-1' })],
    ['account billed to a third-party payer', () => mockFirst.mockResolvedValue({ ...INVOICE, customer_payer_id: 3 })],
    // A job can bill a third party by itself; the invoice reaches its job by
    // its own link or by the service record's.
    ['the job bills a third party (the invoice\'s own job link)', () => mockFirst.mockResolvedValue({ ...INVOICE, invoice_job_payer_id: 4 })],
    ['the job bills a third party (the service record\'s job link)', () => mockFirst.mockResolvedValue({ ...INVOICE, record_job_payer_id: 4 })],
    ['a service contact can also get this link', () => mockFirst.mockResolvedValue({ ...INVOICE, service_contact_name: 'Tenant Tina', service_contact_email: 't@example.com' })],
    ['not paid', () => mockFirst.mockResolvedValue({ ...INVOICE, status: 'refunded' })],
    ['paid more than 7 days ago', () => mockFirst.mockResolvedValue({ ...INVOICE, paid_at: paidAgo(7 * DAY_MS + 60 * 1000) })],
    ['no payment time on record', () => mockFirst.mockResolvedValue({ ...INVOICE, paid_at: null })],
    ['a distinct billing email gets this receipt', () => mockFirst.mockResolvedValue({ ...INVOICE, customer_email: 'pat@example.com', billing_email: 'books@example.com' })],
    ['a callback visit (the report\'s rule)', () => {
      process.env.GATE_RESERVICE_REPORT_COPY = 'true';
      mockFirst.mockResolvedValue({ ...INVOICE, visit_is_callback: true });
    }],
    // The flag also sits on the job, and an invoice can reach its job with
    // no service record.
    ['a callback flagged on the invoice\'s own job', () => {
      process.env.GATE_RESERVICE_REPORT_COPY = 'true';
      mockFirst.mockResolvedValue({ ...INVOICE, invoice_job_is_callback: true });
    }],
    ['a callback flagged on the service record\'s job', () => {
      process.env.GATE_RESERVICE_REPORT_COPY = 'true';
      mockFirst.mockResolvedValue({ ...INVOICE, record_job_is_callback: true });
    }],
    ['a callback flagged on another service record of the job', () => {
      process.env.GATE_RESERVICE_REPORT_COPY = 'true';
      mockFirst.mockResolvedValue({ ...INVOICE, job_record_is_callback: true });
    }],
    ['no invoice for the token', () => mockFirst.mockResolvedValue(undefined)],
  ])('%s → no cards, and the offer is never built', async (_label, arrange) => {
    arrange();
    const payload = await getReceipt();
    expect(payload).not.toHaveProperty('crossSell');
    expect(payload).not.toHaveProperty('referral');
    expect(appOfferForCustomer).not.toHaveBeenCalled();
    expect(referralShare.composeReferralCard).not.toHaveBeenCalled();
  });

  test('a receipt paid almost 7 days ago still carries both cards', async () => {
    mockFirst.mockResolvedValue({ ...INVOICE, paid_at: paidAgo(7 * DAY_MS - 60 * 1000) });
    const payload = await getReceipt();
    expect(payload).toEqual(expect.objectContaining({ crossSell: CARD, referral: REFERRAL }));
  });

  test('a callback flag does nothing while the re-service gate is off', async () => {
    mockFirst.mockResolvedValue({ ...INVOICE, visit_is_callback: true });
    expect(await getReceipt()).toEqual(expect.objectContaining({ crossSell: CARD }));
  });

  test('a quote-only offer carries no price', async () => {
    appOfferForCustomer.mockResolvedValue({ ...APP_OFFER, mode: 'quote_cta', option: null });
    expect((await getReceipt()).crossSell).toEqual({ label: 'Lawn Care', relationship: 'add' });
  });

  test('the app shows this customer no offer → the referral card alone', async () => {
    appOfferForCustomer.mockResolvedValue(null);
    const payload = await getReceipt();
    expect(payload).not.toHaveProperty('crossSell');
    expect(payload.referral).toEqual(REFERRAL);
  });

  test('the referral program is off → the offer card alone', async () => {
    referralShare.composeReferralCard.mockResolvedValue(null);
    const payload = await getReceipt();
    expect(payload.crossSell).toEqual(CARD);
    expect(payload).not.toHaveProperty('referral');
  });

  // Best-effort: a card failure never fails the receipt, and the log never
  // carries the error text (Knex puts the bound receipt token in it).
  test.each([
    ['the row read', () => mockFirst.mockRejectedValue(Object.assign(new Error(`select ... where token = ${'a'.repeat(64)}`), { code: '57014' }))],
    ['the offer', () => appOfferForCustomer.mockRejectedValue(Object.assign(new Error('boom'), { code: 'E_OFFER' }))],
    ['the referral card', () => referralShare.composeReferralCard.mockRejectedValue(new Error('boom'))],
  ])('%s fails → the receipt renders with no cards and a code-only log', async (_label, arrange) => {
    arrange();
    const payload = await getReceipt();
    expect(payload.invoice.invoiceNumber).toBe('QA-1');
    expect(payload).not.toHaveProperty('crossSell');
    expect(payload).not.toHaveProperty('referral');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).not.toMatch(/a{20}|boom/);
  });

  // The page's own read records the view; the cards' read must not record a
  // second one (the receipt email builds its line from the same loader).
  test('the cards read the invoice through their own loader, never InvoiceService.getByToken', async () => {
    await getReceipt();
    expect(InvoiceService.getByToken).toHaveBeenCalledTimes(1);
  });
});

describe('the receipt has nothing that acts', () => {
  // Owner 2026-11-22: a receipt link reaches payers, bookkeepers and anyone
  // it is forwarded to, so a card must never file a request, mint an estimate
  // or enroll a promoter from it. Every route on this router is a read.
  test('the receipt router has no write route', () => {
    const writes = router.stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route.methods).filter((m) => m !== 'get').map((m) => `${m.toUpperCase()} ${l.route.path}`));
    expect(writes).toEqual([]);
  });

  test('building the cards opens no transaction', async () => {
    db.transaction = jest.fn();
    await getReceipt();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('receiptCardsForInvoiceId — the receipt email names what the receipt shows', () => {
  test('the same cards, read by invoice id', async () => {
    expect(await receiptCardsForInvoiceId('inv-1')).toEqual({ crossSell: CARD, referral: REFERRAL });
  });

  test.each([
    ['gate off', () => isEnabled.mockReturnValue(false)],
    ['paid more than 7 days ago (a re-sent receipt)', () => mockFirst.mockResolvedValue({ ...INVOICE, paid_at: paidAgo(8 * DAY_MS) })],
    ['a payer-billed invoice', () => mockFirst.mockResolvedValue({ ...INVOICE, payer_id: 'payer-1' })],
  ])('%s → no cards, so no email line', async (_label, arrange) => {
    arrange();
    expect(await receiptCardsForInvoiceId('inv-1')).toEqual({});
  });
});
