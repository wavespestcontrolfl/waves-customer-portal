// Receipt add-a-service + referral cards (GATE_DOC_CROSS_SELL, owner
// 2026-11-21). The receipt reuses the service report's composer and tap;
// what this suite pins is the RECEIPT's own decisions: only a PAID receipt
// whose link reaches the account holder alone carries the cards (no
// third-party payer, no service contact), for 7 days after its payment
// (owner 2026-11-22, "week"), the offer needs the visit the invoice is for,
// the gate hides the routes entirely, and a tap is not counted as a receipt
// view. Each tap reads that decision twice: once before the tap, and again
// inside the write with the customer row locked (AGENTS.md: the commit path
// re-checks the preflight read).
jest.mock('../models/db', () => {
  // first: what a read of the invoice answers on this handle. Only the
  // customers chain can be row-locked: a lock on an invoice or a visit row
  // fails a payment (settlement takes the visit FOR UPDATE NOWAIT), so a
  // route that asks for one throws here.
  const handle = (first) => jest.fn((table) => {
    const query = {};
    for (const method of ['where', 'whereIn', 'orderBy', 'whereRaw', 'leftJoin']) query[method] = () => query;
    if (String(table) === 'customers') {
      query.forUpdate = () => query;
      query.first = async () => ({ id: 'cust-1' });
      return query;
    }
    query.first = (...args) => first(...args);
    return query;
  });
  const db = handle((...args) => mockFirst(...args));
  // The tap's transaction: its own handle, answering from mockLaterFirst.
  db.mockTrx = handle((...args) => mockLaterFirst(...args));
  db.transaction = jest.fn(async (work) => work(db.mockTrx));
  return db;
});
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
  reportSuppressedForCustomer: jest.requireActual('../services/service-report/cross-sell-tap').reportSuppressedForCustomer,
  // The real referral tap wrapper: the customer lock, then the second read.
  referralShareIfStillEligible: jest.requireActual('../services/service-report/cross-sell-tap').referralShareIfStillEligible,
  buildCrossSellForServiceRecord: jest.fn(),
  handleCrossSellTap: jest.fn(),
}));
jest.mock('../services/referral-share', () => ({
  composeReferralCard: jest.fn(),
  buildReferralShareForCustomer: jest.fn(),
}));

const mockFirst = jest.fn();
// What the same read answers INSIDE the tap's write. Default: the same row.
const mockLaterFirst = jest.fn();
const db = require('../models/db');
const InvoiceService = require('../services/invoice');
const { isEnabled } = require('../config/feature-gates');
const tap = require('../services/service-report/cross-sell-tap');
const referralShare = require('../services/referral-share');
const router = require('../routes/receipt-v2');

const OFFER = { serviceKey: 'lawn_care', label: 'Lawn Care', mode: 'priced', option: { id: 'lawn-enhanced', perVisit: 62 }, fingerprint: 'fp' };
const REFERRAL = { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' };
const DAY_MS = 24 * 60 * 60 * 1000;
const paidAgo = (ms) => new Date(Date.now() - ms).toISOString();
const INVOICE = {
  id: 'inv-1', customer_id: 'cust-1', status: 'paid', paid_at: paidAgo(60 * 1000), payer_id: null, service_record_id: 'sr-1', record_customer_id: 'cust-1', total: 85, invoice_number: 'QA-1',
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

afterEach(() => { delete process.env.GATE_RESERVICE_REPORT_COPY; });

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((key) => key === 'docCrossSell');
  InvoiceService.getByToken.mockResolvedValue({ ...INVOICE });
  mockFirst.mockResolvedValue({ ...INVOICE });
  mockLaterFirst.mockReset();
  mockLaterFirst.mockImplementation((...args) => mockFirst(...args));
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
    // Pre-push audit P1 (2026-11-22): the flag also sits on the job, and an
    // invoice can reach its job with no service record.
    ['a callback flagged on the invoice\'s own job, with no service record', () => {
      process.env.GATE_RESERVICE_REPORT_COPY = 'true';
      mockFirst.mockResolvedValue({ ...INVOICE, service_record_id: null, record_customer_id: null, invoice_job_is_callback: true });
    }],
    ['a callback flagged on the service record\'s job', () => {
      process.env.GATE_RESERVICE_REPORT_COPY = 'true';
      mockFirst.mockResolvedValue({ ...INVOICE, record_job_is_callback: true });
    }],
  ])('%s → no cards', async (_label, arrange) => {
    arrange();
    const { res } = await call('get', '/:token');
    const payload = res.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty('crossSell');
    expect(payload).not.toHaveProperty('referral');
    expect(tap.buildCrossSellForServiceRecord).not.toHaveBeenCalled();
  });

  test('a receipt paid almost 7 days ago still carries both cards', async () => {
    mockFirst.mockResolvedValue({ ...INVOICE, paid_at: paidAgo(7 * DAY_MS - 60 * 1000) });
    const { res } = await call('get', '/:token');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ crossSell: OFFER, referral: REFERRAL }));
  });

  test.each([
    ['an invoice with no visit', { service_record_id: null, record_customer_id: null }],
    // The tap files its request for the visit's customer.
    ['a visit that belongs to another customer', { record_customer_id: 'cust-other' }],
  ])('%s carries the referral card alone', async (_label, change) => {
    mockFirst.mockResolvedValue({ ...INVOICE, ...change });
    const { res } = await call('get', '/:token');
    const payload = res.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty('crossSell');
    expect(payload.referral).toEqual(REFERRAL);
  });

  // Pre-push audit P1 (2026-11-22): with GATE_REFERRAL_STEP2 on, the
  // composer builds the customer's own offer line (and applies its yearly
  // limit) only when it knows the customer.
  test('the referral card is built for the receipt\'s own customer', async () => {
    await call('get', '/:token');
    expect(referralShare.composeReferralCard).toHaveBeenCalledWith({ customerId: 'cust-1' });
  });
});

// An office-only report (a typed completion that is not auto_send) never
// reaches the customer, so the receipt builds no offer from it and its tap
// is closed; the referral card and its tap do not depend on the report.
describe('a visit whose report never reaches the customer', () => {
  beforeEach(() => mockFirst.mockResolvedValue({
    ...INVOICE, visit_structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }),
  }));

  test('the receipt carries the referral card alone', async () => {
    const { res } = await call('get', '/:token');
    const payload = res.json.mock.calls[0][0];
    expect(payload).not.toHaveProperty('crossSell');
    expect(payload.referral).toEqual(REFERRAL);
    expect(tap.buildCrossSellForServiceRecord).not.toHaveBeenCalled();
  });

  test('the offer tap is 404 and records nothing; the referral tap still works', async () => {
    const offerTap = await call('post', '/:token/cross-sell', { body: { metadata: { serviceKey: 'lawn_care', fingerprint: 'fp' } } });
    expect(offerTap.res.statusCode).toBe(404);
    expect(tap.handleCrossSellTap).not.toHaveBeenCalled();
    referralShare.buildReferralShareForCustomer.mockResolvedValue({ code: 'WAVES-1' });
    const referralTap = await call('post', '/:token/referral-link');
    expect(referralTap.res.json).toHaveBeenCalledWith({ code: 'WAVES-1' });
  });

  test('an auto_send typed report keeps the offer', async () => {
    mockFirst.mockResolvedValue({ ...INVOICE, visit_structured_notes: { typedReportDelivery: 'auto_send' } });
    const { res } = await call('get', '/:token');
    expect(res.json.mock.calls[0][0]).toEqual(expect.objectContaining({ crossSell: OFFER, referral: REFERRAL }));
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
    ['the job bills a third party', () => mockFirst.mockResolvedValue({ ...INVOICE, record_job_payer_id: 4 })],
    ['paid more than 7 days ago', () => mockFirst.mockResolvedValue({ ...INVOICE, paid_at: paidAgo(8 * DAY_MS) })],
    ['no visit on the invoice', () => mockFirst.mockResolvedValue({ ...INVOICE, service_record_id: null })],
    ['a visit that belongs to another customer', () => mockFirst.mockResolvedValue({ ...INVOICE, record_customer_id: 'cust-other' })],
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
    expect(referralShare.buildReferralShareForCustomer).toHaveBeenCalledWith('cust-1', { conn: db.mockTrx });
    expect(res.json).toHaveBeenCalledWith(share);
  });

  test.each([
    ['a payer-billed receipt', { payer_id: 'payer-1' }],
    ['a receipt paid more than 7 days ago', { paid_at: paidAgo(8 * DAY_MS) }],
  ])('%s never enrolls anyone', async (_label, change) => {
    mockFirst.mockResolvedValue({ ...INVOICE, ...change });
    const { res } = await call('post', '/:token/referral-link');
    expect(res.statusCode).toBe(404);
    expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
  });
});

// Pre-push audit P0 (2026-11-22): eligibility was read before the write
// only. Each tap now reads it again inside its write, on the transaction.
describe('the tap reads its eligibility again inside the write', () => {
  const CHANGES = [
    ['the invoice was refunded', { status: 'refunded' }],
    ['day 7 passed', { paid_at: paidAgo(7 * DAY_MS + 60 * 1000) }],
    ['the invoice now bills a third party', { payer_id: 'payer-1' }],
    ['a service contact was added to the account', { service_contact_name: 'Tenant Tina', service_contact_email: 't@example.com' }],
    ['a distinct billing email was added', { customer_email: 'pat@example.com', billing_email: 'books@example.com' }],
  ];

  async function stillEligibleOf() {
    tap.handleCrossSellTap.mockResolvedValue({ status: 200, body: { ok: true } });
    await call('post', '/:token/cross-sell', { body: { metadata: {} } });
    return tap.handleCrossSellTap.mock.calls[0][0];
  }

  test('offer tap: nothing changed → still eligible, read on the tap\'s own transaction', async () => {
    const { stillEligible, surface } = await stillEligibleOf();
    const readsBefore = db.mock.calls.length;
    expect(await stillEligible(db.mockTrx)).toBe(true);
    expect(db.mockTrx).toHaveBeenCalledWith('invoices as i');
    expect(db.mock.calls).toHaveLength(readsBefore);
    // What the shared tap answers when the second read says no.
    expect(surface.notFoundBody).toEqual({ error: 'Receipt not found' });
  });

  test.each([
    ...CHANGES,
    ['the invoice now points at another visit', { service_record_id: 'sr-2' }],
    ['the report stopped reaching the customer', { visit_structured_notes: { typedReportDelivery: 'internal_only' } }],
    ['the token no longer finds an invoice', null],
  ])('offer tap: %s → no longer eligible', async (_label, change) => {
    const { stillEligible } = await stillEligibleOf();
    mockLaterFirst.mockResolvedValue(change ? { ...INVOICE, ...change } : undefined);
    expect(await stillEligible(db.mockTrx)).toBe(false);
  });

  test('offer tap: the gate went off → no longer eligible', async () => {
    const { stillEligible } = await stillEligibleOf();
    isEnabled.mockReturnValue(false);
    expect(await stillEligible(db.mockTrx)).toBe(false);
  });

  test('referral tap: the customer row is locked before the second read', async () => {
    referralShare.buildReferralShareForCustomer.mockResolvedValue({ code: 'WAVES-1' });
    await call('post', '/:token/referral-link');
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.mockTrx.mock.calls.map(([table]) => table)).toEqual(['customers', 'invoices as i']);
  });

  test.each([
    ...CHANGES,
    ['the invoice moved to another customer', { customer_id: 'cust-2' }],
    ['the token no longer finds an invoice', null],
  ])('referral tap: %s → 404, nobody enrolled', async (_label, change) => {
    mockLaterFirst.mockResolvedValue(change ? { ...INVOICE, ...change } : undefined);
    const { res } = await call('post', '/:token/referral-link');
    expect(res.statusCode).toBe(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Receipt not found' });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(referralShare.buildReferralShareForCustomer).not.toHaveBeenCalled();
  });

  // The report's office-only state closes the offer, never the referral.
  test('referral tap: the report stopped reaching the customer → still enrolls', async () => {
    referralShare.buildReferralShareForCustomer.mockResolvedValue({ code: 'WAVES-1' });
    mockLaterFirst.mockResolvedValue({ ...INVOICE, visit_structured_notes: { typedReportDelivery: 'internal_only' } });
    const { res } = await call('post', '/:token/referral-link');
    expect(res.json).toHaveBeenCalledWith({ code: 'WAVES-1' });
  });
});

describe('the taps answer the generic 404 ahead of the limiter (a dark route never 429s)', () => {
  test.each([
    ['/:token/cross-sell', 'gate off', 'a'.repeat(64), false],
    ['/:token/referral-link', 'gate off', 'a'.repeat(64), false],
    ['/:token/cross-sell', 'malformed token', 'bad token!', true],
  ])('%s, %s', async (path, _label, token, gateOn) => {
    isEnabled.mockReturnValue(gateOn);
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods.post);
    const res = { statusCode: 200, json: jest.fn() };
    res.status = jest.fn((code) => { res.statusCode = code; return res; });
    const next = jest.fn();
    layer.route.stack[0].handle({ params: { token } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(mockFirst).not.toHaveBeenCalled();
  });
});

// invoice-email.js names in its closing line only the cards this reader
// returns, so a receipt re-sent after day 7 gets no card line.
test('the receipt email\'s reader follows the same 7 days', async () => {
  const { receiptCardsForInvoiceId } = require('../services/receipt-cards');
  expect(await receiptCardsForInvoiceId('inv-1')).toEqual({ crossSell: OFFER, referral: REFERRAL });
  mockFirst.mockResolvedValue({ ...INVOICE, paid_at: paidAgo(8 * DAY_MS) });
  expect(await receiptCardsForInvoiceId('inv-1')).toEqual({});
});

test('a billing email that is the holder\'s own address keeps the cards', async () => {
  mockFirst.mockResolvedValue({ ...INVOICE, customer_email: 'pat@example.com', billing_email: 'PAT@example.com' });
  const { res } = await call('get', '/:token');
  expect(res.json.mock.calls[0][0]).toEqual(expect.objectContaining({ crossSell: OFFER, referral: REFERRAL }));
});
