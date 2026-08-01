// Appointment-card fee rail (owner-approved 2026-08-01): the no-show /
// late-cancel fee + settlement for visits secured via /secure
// (appointment_card_requests), mirroring the estimate-card-holds rail's
// postures. db + every collaborator mocked; the decision logic runs for real.

let mockTableHandlers = {};
let mockDbTouches = [];
let mockTrxTouches = [];

jest.mock('../models/db', () => {
  const makeChain = (handlers, touch, sink) => {
    const chain = { calls: [] };
    const record = (op) => (...args) => { chain.calls.push([op, ...args]); return chain; };
    chain.where = record('where');
    chain.whereNull = record('whereNull');
    chain.whereIn = record('whereIn');
    chain.whereNot = record('whereNot');
    chain.orderBy = record('orderBy');
    chain.insert = (row) => {
      chain.calls.push(['insert', row]);
      return Promise.resolve(handlers.insert ? handlers.insert(chain, row) : [1]);
    };
    chain.first = (...args) => Promise.resolve(handlers.first ? handlers.first(chain, ...args) : null);
    chain.update = (patch) => {
      chain.calls.push(['update', patch]);
      return Promise.resolve(handlers.update ? handlers.update(chain, patch) : 1);
    };
    chain.catch = (fn) => Promise.resolve(chain).catch(fn);
    touch.chain = chain;
    sink.push(touch);
    return chain;
  };
  const db = jest.fn((table) => makeChain(mockTableHandlers[table] || {}, { table }, mockDbTouches));
  db.fn = { now: jest.fn(() => 'NOW') };
  db.raw = jest.fn(async () => ({}));
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => makeChain((mockTableHandlers.trx || {})[table] || {}, { table }, mockTrxTouches);
    trx.raw = jest.fn(async (...args) => { mockTrxTouches.push({ table: '__raw', args }); return {}; });
    trx.fn = { now: jest.fn(() => 'NOW') };
    return fn(trx);
  });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => (name === 'apptCardNoShowFee' ? mockGateOn : false)),
  gates: {},
}));

const mockAttach = jest.fn(async () => {});
const mockSendFeeReceipt = jest.fn(async () => {});
jest.mock('../services/estimate-card-holds', () => ({
  CARD_HOLD_POST_START_GRACE_MS: 2 * 3600000,
  NO_SHOW_FEE_MAX_AGE_MS: 48 * 3600000,
  cardHoldNoShowFee: jest.fn(() => 49),
  cardHoldCancelWindowHours: jest.fn(() => 24),
  attachCardHoldPaymentMethod: (...a) => mockAttach(...a),
  sendNoShowFeeReceipt: (...a) => mockSendFeeReceipt(...a),
}));

let mockApptTime = null;
jest.mock('../services/appointment-reminders', () => ({
  scheduledServiceApptTime: jest.fn(async () => mockApptTime),
}));

const mockChargeOffSession = jest.fn();
const mockRetrievePaymentIntent = jest.fn();
jest.mock('../services/stripe', () => ({
  chargeSavedPaymentMethodOffSession: (...a) => mockChargeOffSession(...a),
  retrievePaymentIntent: (...a) => mockRetrievePaymentIntent(...a),
  savePaymentMethod: jest.fn(async () => ({ id: 'pm-row-9', method_type: 'card' })),
  retrieveSetupIntent: jest.fn(),
  createAppointmentCardSetupIntent: jest.fn(),
}));

const mockNotifyAdmin = jest.fn(async () => {});
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...a) => mockNotifyAdmin(...a),
}));
const mockInvoiceCreate = jest.fn(async () => ({ id: 'inv-77', token: 'tok-77' }));
jest.mock('../services/invoice', () => ({
  create: (...a) => mockInvoiceCreate(...a),
}));
// Collaborators of the module's OTHER paths — mocked so requiring the module
// never pulls live integrations into this suite.
jest.mock('../services/payer', () => ({ resolveForInvoice: jest.fn(async () => null) }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn(async () => false) }));
jest.mock('../services/payment-method-consents', () => ({
  findConsentedChargeableCard: jest.fn(async () => null),
  hasEnrollmentScopedConsent: jest.fn(async () => false),
  recordConsent: jest.fn(async () => ({ id: 'consent-1' })),
  linkPaymentMethodId: jest.fn(async () => {}),
}));
jest.mock('../services/autopay-enrollment', () => ({ enrollConsentedMethod: jest.fn(async () => ({ enrolled: true })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async () => 'https://wvs.link/x') }));
jest.mock('../services/card-enrollment-email', () => ({ sendAutopaySetupInvitation: jest.fn(async () => ({ sent: true })) }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async () => 'body') }));
jest.mock('../services/secure-appointment-plans', () => ({
  buildSecurePlanContext: jest.fn(async () => null),
  prepaySelectionState: jest.fn(async () => null),
  applyPerApplicationLaneStamp: jest.fn(async () => true),
}));

const {
  chargeAppointmentNoShowFee,
  handleAppointmentCardCancellation,
  appointmentCardCancelPreview,
  settleAppointmentNoShowFee,
  isWithinApptCancelWindow,
} = require('../services/appointment-card-request');

const HOUR = 3600000;
// A fresh missed visit: started an hour ago, agreed to days before.
const FRESH_START = () => new Date(Date.now() - HOUR);
const REQUEST = () => ({
  id: 'req-1',
  scheduled_service_id: 'svc-1',
  customer_id: 'cust-1',
  status: 'completed',
  stripe_payment_method_id: 'pm_live_1',
  no_show_fee_amount: '49.00',
  cancel_window_hours: 24,
  fee_agreed_at: new Date(Date.now() - 72 * HOUR),
  fee_status: null,
});

function handlersWith({ request = REQUEST(), hold = null, trx = {} } = {}) {
  return {
    appointment_card_requests: { first: () => request },
    estimate_card_holds: { first: () => hold },
    trx,
  };
}

function touches(table) {
  return mockDbTouches.filter((t) => t.table === table);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGateOn = true;
  mockApptTime = FRESH_START();
  mockTableHandlers = handlersWith();
  mockDbTouches = [];
  mockTrxTouches = [];
  mockChargeOffSession.mockResolvedValue({ id: 'pi_fee_1' });
});

describe('chargeAppointmentNoShowFee — gate and eligibility', () => {
  test('gate off → feature_disabled, no db touches', async () => {
    mockGateOn = false;
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ charged: false, reason: 'feature_disabled' });
    expect(mockDbTouches).toHaveLength(0);
  });

  test('no request row → no_card_request', async () => {
    mockTableHandlers = handlersWith({ request: null });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('no_card_request');
  });

  test('satisfied row (auto-secured, never saw the disclosure) → never charged', async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), status: 'satisfied' } });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ charged: false, reason: 'not_completed' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('completed row without frozen fee terms (pre-migration) → no_agreed_fee', async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), no_show_fee_amount: null } });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('no_agreed_fee');
  });

  test('fee already handled → fee_<status>, no second charge', async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), fee_status: 'charged' } });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('fee_charged');
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('estimate card hold exists (any status) → card_hold_lane, the hold rail owns the visit', async () => {
    mockTableHandlers = handlersWith({ hold: { id: 'hold-1' } });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('card_hold_lane');
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });
});

describe('chargeAppointmentNoShowFee — staleness guard', () => {
  test('unresolvable start → refuse + office alert, no charge', async () => {
    mockApptTime = null;
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ charged: false, reason: 'no_show_start_unresolved' });
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('start older than 48h → refuse (cleanup never bills ancient history)', async () => {
    mockApptTime = new Date(Date.now() - 49 * HOUR);
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('no_show_stale_start');
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('caller-supplied fresh start skips re-resolution and charges', async () => {
    mockApptTime = null; // resolver would fail — the supplied start must win
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1', serviceStart: FRESH_START() });
    expect(res.charged).toBe(true);
  });
});

describe('chargeAppointmentNoShowFee — charge outcomes', () => {
  test('success: frozen $49 charged face value with lane metadata, row → charged with PI pointer', async () => {
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1', reason: 'no_show' });
    expect(res).toEqual({ charged: true, amount: 49 });
    expect(mockAttach).toHaveBeenCalledWith({ customerId: 'cust-1', paymentMethodId: 'pm_live_1' });
    const chargeArgs = mockChargeOffSession.mock.calls[0][0];
    expect(chargeArgs.amountDollars).toBe(49);
    expect(chargeArgs.metadata.purpose).toBe('appointment_card_no_show_fee');
    expect(chargeArgs.metadata.request_id).toBe('req-1');
    expect(chargeArgs.idempotencyKey).toBe('appt_card_no_show_req-1');
    const updates = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter((c) => c[0] === 'update').map((c) => c[1]));
    expect(updates.some((u) => u.fee_status === 'charging')).toBe(true);
    const final = updates.find((u) => u.fee_status === 'charged');
    expect(final.no_show_payment_intent_id).toBe('pi_fee_1');
    expect(final.fee_charged_amount).toBe(49);
  });

  test('claim race lost (0 rows) → fee_claim_lost, nothing charged', async () => {
    mockTableHandlers = handlersWith({
      request: REQUEST(),
    });
    mockTableHandlers.appointment_card_requests.update = (chain, patch) => (patch.fee_status === 'charging' ? 0 : 1);
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('fee_claim_lost');
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('definite decline → claim reverted (fee_status back to NULL), charge_failed', async () => {
    mockChargeOffSession.mockRejectedValue(Object.assign(new Error('card_declined'), { type: 'StripeCardError' }));
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('charge_failed');
    const updates = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter((c) => c[0] === 'update').map((c) => c[1]));
    expect(updates.some((u) => u.fee_status === null)).toBe(true);
  });

  test('ambiguous connection error → parked charge_review (a retry could double-charge)', async () => {
    mockChargeOffSession.mockRejectedValue(Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }));
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('charge_review');
    const updates = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter((c) => c[0] === 'update').map((c) => c[1]));
    expect(updates.some((u) => u.fee_status === 'charge_review')).toBe(true);
  });

  test('charged but DB write failed → parked charge_review keeping the PI pointer, NOT retryable', async () => {
    let updateCall = 0;
    mockTableHandlers.appointment_card_requests.update = (chain, patch) => {
      updateCall += 1;
      if (patch.fee_status === 'charged') throw new Error('db down');
      return 1;
    };
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ charged: true, amount: 49, reason: 'charge_review_write_failed' });
    const updates = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter((c) => c[0] === 'update').map((c) => c[1]));
    const parked = updates.find((u) => u.fee_status === 'charge_review');
    expect(parked.no_show_payment_intent_id).toBe('pi_fee_1');
    expect(updateCall).toBeGreaterThanOrEqual(2);
  });
});

describe('isWithinApptCancelWindow — fee window math', () => {
  const NOW = new Date('2026-08-01T12:00:00Z');
  test('cancel outside the frozen window → free', () => {
    const req = { cancel_window_hours: 24, fee_agreed_at: new Date(NOW.getTime() - 100 * HOUR) };
    expect(isWithinApptCancelWindow({ request: req, serviceStart: new Date(NOW.getTime() + 30 * HOUR), now: NOW })).toBe(false);
  });
  test('cancel inside the window → fee applies', () => {
    const req = { cancel_window_hours: 24, fee_agreed_at: new Date(NOW.getTime() - 100 * HOUR) };
    expect(isWithinApptCancelWindow({ request: req, serviceStart: new Date(NOW.getTime() + 3 * HOUR), now: NOW })).toBe(true);
  });
  test('booking-age anchor: freshly agreed → free-cancel grace even inside 24h', () => {
    const req = { cancel_window_hours: 24, fee_agreed_at: new Date(NOW.getTime() - 10 * 60000) };
    expect(isWithinApptCancelWindow({ request: req, serviceStart: new Date(NOW.getTime() + 3 * HOUR), now: NOW })).toBe(false);
  });
  test('post-start grace: within 2h after start still a late cancel; past it free', () => {
    const req = { cancel_window_hours: 24, fee_agreed_at: new Date(NOW.getTime() - 100 * HOUR) };
    expect(isWithinApptCancelWindow({ request: req, serviceStart: new Date(NOW.getTime() - 1 * HOUR), now: NOW })).toBe(true);
    expect(isWithinApptCancelWindow({ request: req, serviceStart: new Date(NOW.getTime() - 3 * HOUR), now: NOW })).toBe(false);
  });
});

describe('handleAppointmentCardCancellation', () => {
  test('waiveFee → fee_status waived, released', async () => {
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1', waiveFee: true });
    expect(res).toEqual({ handled: true, released: true, reason: 'admin_waive' });
    const updates = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter((c) => c[0] === 'update').map((c) => c[1]));
    expect(updates.some((u) => u.fee_status === 'waived')).toBe(true);
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('waive race lost → released:false (offboarding gates its refund on this)', async () => {
    mockTableHandlers.appointment_card_requests.update = () => 0;
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1', waiveFee: true });
    expect(res).toEqual({ handled: false, released: false, reason: 'waive_race_lost' });
  });

  test('in-window customer cancel → charges the late_cancel fee', async () => {
    mockApptTime = new Date(Date.now() + 3 * HOUR);
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res.charged).toBe(true);
    expect(mockChargeOffSession.mock.calls[0][0].metadata.reason).toBe('late_cancel');
  });

  test('outside-window cancel → free, nothing charged', async () => {
    mockApptTime = new Date(Date.now() + 100 * HOUR);
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: true, released: true, reason: 'cancel_outside_window' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('no fee lane on the visit → handled:false but released (never blocks a cancel)', async () => {
    mockTableHandlers = handlersWith({ request: null });
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res.handled).toBe(false);
    expect(res.released).toBe(true);
  });

  test('gate off → in-window cancel does NOT charge (dark = byte-identical behavior)', async () => {
    mockGateOn = false;
    mockApptTime = new Date(Date.now() + 3 * HOUR);
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('cancel_outside_window');
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });
});

describe('appointmentCardCancelPreview', () => {
  test('no eligible row → {secured:false, feeApplies:false}', async () => {
    mockTableHandlers = handlersWith({ request: null });
    expect(await appointmentCardCancelPreview('svc-1')).toEqual({ secured: false, feeApplies: false });
  });
  test('eligible + in-window + gate on → fee preview with the frozen amount', async () => {
    mockApptTime = new Date(Date.now() + 3 * HOUR);
    expect(await appointmentCardCancelPreview('svc-1')).toEqual({ secured: true, feeApplies: true, feeAmount: 49 });
  });
  test('gate off → feeApplies false (charge would no-op anyway)', async () => {
    mockGateOn = false;
    mockApptTime = new Date(Date.now() + 3 * HOUR);
    const res = await appointmentCardCancelPreview('svc-1');
    expect(res.secured).toBe(true);
    expect(res.feeApplies).toBe(false);
  });
});

describe('settleAppointmentNoShowFee — paid refundable fee invoice', () => {
  const PI = () => ({
    id: 'pi_fee_1',
    amount: 4900,
    amount_received: 4900,
    latest_charge: 'ch_1',
    metadata: {
      waves_customer_id: 'cust-1',
      purpose: 'appointment_card_no_show_fee',
      request_id: 'req-1',
      scheduled_service_id: 'svc-1',
      reason: 'no_show',
    },
  });

  beforeEach(() => {
    mockRetrievePaymentIntent.mockResolvedValue({ latest_charge: { amount: 4900, amount_refunded: 0, refunded: false } });
    mockTableHandlers.trx = { payments: { first: () => null } };
    mockTableHandlers.invoices = { first: () => null };
    mockTableHandlers.customers = { first: () => ({ first_name: 'Pat' }) };
  });

  test('missing customer pointer → missing_pi_or_customer', async () => {
    const pi = PI();
    delete pi.metadata.waves_customer_id;
    expect(await settleAppointmentNoShowFee(pi)).toEqual({ settled: false, reason: 'missing_pi_or_customer' });
  });

  test('fully refunded before settlement → skipped', async () => {
    mockRetrievePaymentIntent.mockResolvedValue({ latest_charge: { amount: 4900, amount_refunded: 4900, refunded: true } });
    expect(await settleAppointmentNoShowFee(PI())).toEqual({ settled: false, reason: 'refunded_pre_settlement' });
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  test('refund-state lookup failure → throws (fail closed, Stripe retries)', async () => {
    mockRetrievePaymentIntent.mockRejectedValue(new Error('stripe down'));
    await expect(settleAppointmentNoShowFee(PI())).rejects.toThrow('stripe down');
  });

  test('replay (payments row exists) → no second invoice; receipt recovery attempted', async () => {
    mockTableHandlers.trx = { payments: { first: () => ({ id: 'pay-1' }) } };
    mockTableHandlers.invoices = { first: () => ({ id: 'inv-77', token: 't', receipt_sent_at: null }) };
    const res = await settleAppointmentNoShowFee(PI());
    expect(res).toEqual({ settled: false, replay: true });
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
    expect(mockSendFeeReceipt).toHaveBeenCalled();
  });

  test('settles at face value: taxRate 0, invoice paid self-pay, payments row carries lane metadata, receipt sent', async () => {
    const res = await settleAppointmentNoShowFee(PI());
    expect(res).toEqual({ settled: true, invoiceId: 'inv-77' });
    const createArgs = mockInvoiceCreate.mock.calls[0][0];
    expect(createArgs.taxRate).toBe(0);
    expect(createArgs.skipAccrual).toBe(true);
    expect(createArgs.lineItems[0].amount).toBe(49);
    const invoiceUpdates = mockTrxTouches.filter((t) => t.table === 'invoices')
      .flatMap((t) => t.chain.calls.filter((c) => c[0] === 'update').map((c) => c[1]));
    expect(invoiceUpdates[0].status).toBe('paid');
    expect(invoiceUpdates[0].payer_id).toBe(null);
    const paymentInserts = mockTrxTouches.filter((t) => t.table === 'payments')
      .flatMap((t) => t.chain.calls.filter((c) => c[0] === 'insert').map((c) => c[1]));
    expect(paymentInserts[0].amount).toBe(49);
    const meta = JSON.parse(paymentInserts[0].metadata);
    expect(meta.purpose).toBe('appointment_card_no_show_fee');
    expect(meta.request_id).toBe('req-1');
    expect(mockSendFeeReceipt).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', amount: 49, feeLabel: 'No-show fee' }));
  });

  test('receipt failure is non-fatal — money + invoice stay settled', async () => {
    mockSendFeeReceipt.mockRejectedValue(new Error('twilio down'));
    const res = await settleAppointmentNoShowFee(PI());
    expect(res.settled).toBe(true);
  });
});
