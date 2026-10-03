// B18: a contradicted accept keeps the DISPUTED number (another customer's) on estimates.customer_phone and
// saves the accepter without it, marked in internal_notes. Every estimate-based sender of "text the
// estimate's phone" must honor that marker: a manual admin send refuses with an operator message, the
// automated ones skip. The marker predicate itself is shared (services/estimate-phone-quarantine.js).

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/estimate-lead-linkage', () => ({ leadIdForEstimate: jest.fn(async () => null) }));
jest.mock('../services/estimate-delivery-options', () => ({
  estimateDataHasQuoteRequirement: jest.fn(() => false),
  estimateDataHasUnresolvedManagerApproval: jest.fn(() => false),
  commercialRiskTypeReviewNeeded: jest.fn(() => false),
  validateEstimateDeliveryOptions: jest.fn(),
}));
jest.mock('../services/estimate-pricing-audit', () => ({
  buildEstimatePricingAudit: jest.fn(), buildEstimatePricingRiskBatch: jest.fn(),
  getLatestEstimatePricingAuditSnapshot: jest.fn(), saveEstimatePricingAuditSnapshot: jest.fn(),
}));
jest.mock('../services/lead-estimate-link', () => ({ markLinkedLeadEstimateSent: jest.fn() }));
jest.mock('../services/estimate-manual-acceptance', () => ({ markEstimateManuallyAccepted: jest.fn() }));
jest.mock('../services/admin-estimate-persistence', () => ({ createOrReuseAdminEstimate: jest.fn(), estimateViewUrl: jest.fn() }));
jest.mock('../routes/estimate-public', () => ({
  acceptanceServiceLists: jest.fn(() => ({ oneTimeList: [{ name: 'One-Time Pest Control' }], recurringList: [] })),
  bookingServiceFor: jest.fn(() => ({ id: 'pest_control', label: 'Pest Control' })),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn(), renderTemplate: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(), isDefiniteRejection: jest.fn(() => false) }));

const router = require('../routes/admin-estimates');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const {
  estimatePhoneQuarantined, customerHasContradictedPhoneMarker, customerIsContradictedPhoneQuarantine,
  CONTRADICTED_PHONE_NOTE_MARK, ESTIMATE_PHONE_QUARANTINED_MESSAGE,
} = require('../services/estimate-phone-quarantine');

const ESTIMATE_ID = '11111111-1111-4111-8111-111111111111';
const MARKED_NOTE = `Phone on the estimate ((941) 555-0123) ${CONTRADICTED_PHONE_NOTE_MARK} and this customer is not texted. Estimate ${ESTIMATE_ID}. Other customer id: cust-other.`;

function routeHandler(path, method = 'post') {
  const layer = router.stack.find((e) => e.route?.path === path && e.route?.methods?.[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

let customerRow;
let customerReadFails;
let estimateRow;
beforeEach(() => {
  jest.clearAllMocks();
  customerReadFails = false;
  customerRow = { id: 'cust-1', phone: '', internal_notes: MARKED_NOTE };
  estimateRow = {
    id: ESTIMATE_ID, customer_id: 'cust-1', customer_name: 'Pat Doe', customer_phone: '(941) 555-0123',
    status: 'accepted', accepted_at: '2026-09-20T12:00:00.000Z', archived_at: null, bill_by_invoice: false,
    monthly_total: 0, onetime_total: 250,
    estimate_data: { result: { oneTime: { items: [{ service: 'pest_control', name: 'One-Time Pest Control', price: 250 }] } } },
  };
  db.mockImplementation((table) => {
    const q = {
      where: jest.fn(() => q),
      first: jest.fn(async () => {
        if (table === 'customers') {
          if (customerReadFails) throw new Error('db down');
          return customerRow;
        }
        if (table === 'estimates') return estimateRow;
        return undefined;
      }),
    };
    return q;
  });
  db.raw = jest.fn((s) => s);
  db.fn = { now: jest.fn(() => 'now()') };
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

describe('the shared marker predicates', () => {
  test('marked = the note carries the marker; quarantined = marked AND phone-less', () => {
    expect(customerHasContradictedPhoneMarker({ internal_notes: MARKED_NOTE, phone: '(941) 555-0188' })).toBe(true);
    expect(customerIsContradictedPhoneQuarantine({ internal_notes: MARKED_NOTE, phone: '(941) 555-0188' })).toBe(false);
    expect(customerIsContradictedPhoneQuarantine({ internal_notes: MARKED_NOTE, phone: '  ' })).toBe(true);
    expect(customerHasContradictedPhoneMarker({ internal_notes: 'a note', phone: '' })).toBe(false);
    expect(customerHasContradictedPhoneMarker(null)).toBe(false);
  });
});

describe('estimatePhoneQuarantined', () => {
  test('a marked customer: the estimate phone is quarantined, whether the profile is still phone-less or the office added the real number', async () => {
    expect(await estimatePhoneQuarantined(estimateRow)).toBe(true);
    customerRow = { id: 'cust-1', phone: '(941) 555-0188', internal_notes: MARKED_NOTE };
    expect(await estimatePhoneQuarantined(estimateRow)).toBe(true);
  });

  test('the estimate phone equal to the customer\'s OWN number is not quarantined (formatting-insensitive)', async () => {
    customerRow = { id: 'cust-1', phone: '+19415550123', internal_notes: MARKED_NOTE };
    expect(await estimatePhoneQuarantined(estimateRow)).toBe(false);
  });

  test('no marker, no customer or no phone: never quarantined', async () => {
    customerRow = { id: 'cust-1', phone: '', internal_notes: 'ordinary note' };
    expect(await estimatePhoneQuarantined(estimateRow)).toBe(false);
    expect(await estimatePhoneQuarantined({ ...estimateRow, customer_id: null })).toBe(false);
    expect(await estimatePhoneQuarantined({ ...estimateRow, customer_phone: '' })).toBe(false);
  });

  test('an unreadable customer row FAILS CLOSED', async () => {
    customerReadFails = true;
    expect(await estimatePhoneQuarantined(estimateRow)).toBe(true);
  });
});

describe('manual admin sends refuse for a quarantined estimate phone', () => {
  const run = async (path, body = {}) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await routeHandler(path)({ params: { id: ESTIMATE_ID }, body }, res, next);
    return { res, next };
  };

  test('POST /:id/send-booking-link on the accepted estimate: 409 with the operator message, nothing sent', async () => {
    const { res, next } = await run('/:id/send-booking-link', { message: 'Book here' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: ESTIMATE_PHONE_QUARANTINED_MESSAGE, code: 'ESTIMATE_PHONE_QUARANTINED' });
    expect(ESTIMATE_PHONE_QUARANTINED_MESSAGE).toMatch(/Add this customer.s real number/);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('POST /:id/follow-up: same refusal for a linked, still-open estimate', async () => {
    estimateRow.status = 'sent';
    const { res } = await run('/:id/follow-up');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: ESTIMATE_PHONE_QUARANTINED_MESSAGE, code: 'ESTIMATE_PHONE_QUARANTINED' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('control: an unmarked customer is not refused by the quarantine (the booking-link route moves on to its other checks)', async () => {
    customerRow = { id: 'cust-1', phone: '', internal_notes: null };
    const { res } = await run('/:id/send-booking-link', { message: 'Book here' });
    const refused = res.json.mock.calls.some(([body]) => body?.code === 'ESTIMATE_PHONE_QUARANTINED');
    expect(refused).toBe(false);
  });
});
