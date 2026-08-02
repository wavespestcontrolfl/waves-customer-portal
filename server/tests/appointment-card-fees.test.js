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
    chain.forUpdate = record('forUpdate');
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
let mockCompletionGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => {
    if (name === 'apptCardNoShowFee') return mockGateOn;
    if (name === 'apptCardCompletionCharge') return mockCompletionGateOn;
    return false;
  }),
  gates: {},
}));

const mockAttach = jest.fn(async () => {});
const mockSendFeeReceipt = jest.fn(async () => {});
const mockResolveOrMintInvoice = jest.fn(async () => 'inv-r1');
jest.mock('../services/estimate-card-holds', () => ({
  CARD_HOLD_POST_START_GRACE_MS: 2 * 3600000,
  NO_SHOW_FEE_MAX_AGE_MS: 48 * 3600000,
  cardHoldNoShowFee: jest.fn(() => 49),
  cardHoldCancelWindowHours: jest.fn(() => 24),
  attachCardHoldPaymentMethod: (...a) => mockAttach(...a),
  sendNoShowFeeReceipt: (...a) => mockSendFeeReceipt(...a),
  resolveOrMintRecapCompletionInvoice: (...a) => mockResolveOrMintInvoice(...a),
}));
jest.mock('../services/billing-lane', () => ({
  resolveBillingLane: jest.fn(() => ({ mode: 'one_time' })),
}));
const mockLogAutopay = jest.fn();
jest.mock('../services/autopay-log', () => ({
  logAutopay: (...a) => mockLogAutopay(...a),
}));

let mockApptTime = null;
jest.mock('../services/appointment-reminders', () => ({
  scheduledServiceApptTime: jest.fn(async () => mockApptTime),
}));

const mockChargeOffSession = jest.fn();
const mockRetrievePaymentIntent = jest.fn();
const mockChargeSavedCard = jest.fn(async () => ({ id: 'pi_recap_1' }));
jest.mock('../services/stripe', () => ({
  chargeSavedPaymentMethodOffSession: (...a) => mockChargeOffSession(...a),
  retrievePaymentIntent: (...a) => mockRetrievePaymentIntent(...a),
  chargeInvoiceWithSavedCard: (...a) => mockChargeSavedCard(...a),
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
const mockCustomerOnAutopay = jest.fn(async () => false);
const mockGetAutopayPm = jest.fn(async () => null);
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: (...a) => mockCustomerOnAutopay(...a),
  getChargeableAutopayMethod: (...a) => mockGetAutopayPm(...a),
  isChargeableAutopayMethod: (m) => !!m && !!m.stripe_payment_method_id,
}));
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
  chargeAppointmentCardForRecapCompletion,
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

function handlersWith({
  request = REQUEST(),
  hold = null,
  pmRow = { id: 'pm-row-1' },
  // The fee charge serializes payer state via FOR UPDATE on the customers
  // row then the scheduled_services row inside its transaction (r15/r18).
  trx = {
    customers: { first: () => ({ id: 'cust-1' }) },
    scheduled_services: { first: () => ({ id: 'svc-1', customer_id: 'cust-1' }) },
  },
} = {}) {
  return {
    appointment_card_requests: { first: () => request },
    estimate_card_holds: { first: () => hold },
    // The fee rail's revocation check (Codex #3153 r8): the local
    // payment_methods row must still exist or the charge refuses.
    payment_methods: { first: () => pmRow },
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
  mockCompletionGateOn = true;
  mockResolveOrMintInvoice.mockResolvedValue('inv-r1');
  mockChargeSavedCard.mockResolvedValue({ id: 'pi_recap_1' });
  mockCustomerOnAutopay.mockResolvedValue(false);
  mockGetAutopayPm.mockResolvedValue(null);
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

  test('completed row WITHOUT fee_agreed_at (no durable consent marker) → no_fee_consent, never charged', async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), fee_agreed_at: null } });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('no_fee_consent');
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('completed row without a frozen window → no_agreed_fee (partial stamps never charge)', async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), cancel_window_hours: null } });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('no_agreed_fee');
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('payer assigned after securing → payer_billed skip, the homeowner card is never penalty-charged (Codex #3153 r6)', async () => {
    require('../services/payer').resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-9' });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('payer_billed');
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('payer re-check FAILURE fails closed — cancellation reports NON-released charge_review (Codex #3153 r6)', async () => {
    require('../services/payer').resolveForInvoice.mockRejectedValueOnce(new Error('payer db down'));
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1', waiveFee: true });
    expect(res).toEqual({ handled: false, released: false, reason: 'charge_review' });
  });

  test('in-flight fee + payer assigned → STILL charge_review, never a clean payer release (Codex #3153 r8 — check order)', async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), fee_status: 'charging' } });
    const payerMock = require('../services/payer').resolveForInvoice;
    payerMock.mockClear();
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1', waiveFee: true });
    expect(res).toEqual({ handled: false, released: false, reason: 'charge_review' });
    // The unresolved-state check runs FIRST — the payer exemption is never
    // even consulted, so it can't convert an in-flight fee into a release.
    expect(payerMock).not.toHaveBeenCalled();
  });

  test('payer assigned in the eligibility→claim gap → claim closes released, homeowner never charged (Codex #3153 r8)', async () => {
    const payerMock = require('../services/payer').resolveForInvoice;
    payerMock.mockResolvedValueOnce(null); // eligibility pass
    payerMock.mockResolvedValueOnce({ payerId: 'payer-9' }); // claim boundary
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ charged: false, reason: 'payer_billed' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    const released = mockDbTouches
      .filter((t) => t.table === 'appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))
      .map(([, patch]) => patch)
      .find((p) => p.fee_status === 'released');
    expect(released).toBeTruthy();
  });

  test('customer removed the saved card → payment_method_revoked, fee closes released + office alert, NEVER a resurrection charge (Codex #3153 r8)', async () => {
    mockTableHandlers = handlersWith({ pmRow: null });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ charged: false, reason: 'payment_method_revoked' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    expect(mockAttach).not.toHaveBeenCalled();
    expect(mockNotifyAdmin).toHaveBeenCalled();
    const released = mockDbTouches
      .filter((t) => t.table === 'appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))
      .map(([, patch]) => patch)
      .find((p) => p.fee_status === 'released');
    expect(released).toBeTruthy();
  });

  test('revocation lookup FAILURE reverts the claim and parks review (Codex #3153 r8)', async () => {
    mockTableHandlers = handlersWith();
    mockTableHandlers.payment_methods.first = () => { throw new Error('db blip'); };
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ charged: false, reason: 'charge_review' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test('unverifiable lane on the cancel PREVIEW surfaces fee-may-apply, never a silent no-fee (Codex #3153 r8)', async () => {
    mockTableHandlers = handlersWith();
    mockTableHandlers.estimate_card_holds.first = () => { throw new Error('db blip'); };
    const res = await appointmentCardCancelPreview('svc-1');
    expect(res).toMatchObject({ secured: true, feeApplies: true, unresolved: true });
    expect(Number(res.feeAmount)).toBe(49);
  });

  test('claim-boundary payer lookup FAILURE reverts the claim and parks review (Codex #3153 r8)', async () => {
    const payerMock = require('../services/payer').resolveForInvoice;
    payerMock.mockResolvedValueOnce(null);
    payerMock.mockRejectedValueOnce(new Error('payer db down'));
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ charged: false, reason: 'charge_review' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    const reverted = mockDbTouches
      .filter((t) => t.table === 'appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))
      .map(([, patch]) => patch)
      .find((p) => p.fee_status === null);
    expect(reverted).toBeTruthy();
  });

  test('hold lookup FAILURE fails closed — canonical charge_review, never read as absence (Codex #3153 r1+r16)', async () => {
    mockTableHandlers = handlersWith();
    mockTableHandlers.estimate_card_holds.first = () => { throw new Error('db blip'); };
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    // Canonical review reason (r16 P2): dispatch maps ONLY charge_review to
    // its cautious no-show copy — a raw lookup reason would tell the
    // customer "no charge" while the fee sits retryable.
    expect(res).toEqual({ charged: false, reason: 'charge_review' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });

  test("in-flight fee_status 'charging' → charge_review skip, never a second claim", async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), fee_status: 'charging' } });
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('charge_review');
    expect(mockChargeOffSession).not.toHaveBeenCalled();
  });
});

describe('unresolved fee states on the cancellation path (Codex #3153 r1)', () => {
  test.each(['charging', 'charge_review'])('fee_status %s → NON-released canonical charge_review (offboarding must not refund)', async (feeStatus) => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), fee_status: feeStatus } });
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1', waiveFee: true });
    expect(res).toEqual({ handled: false, released: false, reason: 'charge_review' });
  });

  test('hold lookup failure on cancel → NON-released charge_review (lane exclusivity unverifiable)', async () => {
    mockTableHandlers = handlersWith();
    mockTableHandlers.estimate_card_holds.first = () => { throw new Error('db blip'); };
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: false, released: false, reason: 'charge_review' });
  });

  test('payer-exempt cancellation persists a TERMINAL stamp — payer removal + retry can never re-arm the fee (Codex #3153 r13)', async () => {
    mockTableHandlers = handlersWith();
    require('../services/payer').resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-9' });
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: false, released: true, reason: 'payer_billed' });
    const released = mockDbTouches
      .filter((t) => t.table === 'appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))
      .map(([, patch]) => patch)
      .find((p) => p.fee_status === 'released');
    expect(released).toBeTruthy();
  });

  test('cancelling with a capture still MID-FLIGHT stamps the row terminally — a later completion can never fee this cancel (Codex #3153 r20)', async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), status: 'pending' } });
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: false, released: true, reason: 'not_completed' });
    const released = mockDbTouches
      .filter((t) => t.table === 'appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))
      .map(([, patch]) => patch)
      .find((p) => p.fee_status === 'released');
    expect(released).toBeTruthy();
  });

  test('payer-exempt stamp lost to a concurrent claim → NON-released charge_review, never a clean release (Codex #3153 r14)', async () => {
    mockTableHandlers = handlersWith();
    mockTableHandlers.appointment_card_requests.update = (chain, patch) => (patch.fee_status === 'released' ? 0 : 1);
    require('../services/payer').resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-9' });
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: false, released: false, reason: 'charge_review' });
  });

  test('appointment-time resolution FAILURE on the preview → fee-may-apply unresolved, never a silent no-fee (Codex #3153 r13)', async () => {
    mockTableHandlers = handlersWith();
    require('../services/appointment-reminders').scheduledServiceApptTime.mockRejectedValueOnce(new Error('db blip'));
    const res = await appointmentCardCancelPreview('svc-1');
    expect(res).toMatchObject({ secured: true, feeApplies: true, unresolved: true });
    expect(Number(res.feeAmount)).toBe(49);
  });

  test("resolved fee_status 'charged' stays a clean release — the fee event is closed", async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), fee_status: 'charged' } });
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: false, released: true, reason: 'fee_charged' });
  });

  test("resolved fee_status 'waived' stays a clean release", async () => {
    mockTableHandlers = handlersWith({ request: { ...REQUEST(), fee_status: 'waived' } });
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: false, released: true, reason: 'fee_waived' });
  });
});

describe('chargeAppointmentCardForRecapCompletion — recap closeout lane (Codex #3153 r1)', () => {
  const LANE_ROW = () => ({ id: 'req-1', customer_id: 'cust-1', accepted_amount: '250.00' });
  const RECAP_SVC = () => ({ id: 'svc-1', customer_id: 'cust-1', service_type: 'Rodent Trapping', is_recurring: false, prepaid_amount: null });
  const RECAP_CUSTOMER = () => ({ id: 'cust-1', billing_mode: null, monthly_rate: null, waveguard_tier: null });
  const RECAP_INVOICE = () => ({ id: 'inv-r1', status: 'sent', payer_id: null, subtotal: '250.00', total: '266.25', discount_amount: null });

  function recapHandlers(overrides = {}) {
    mockTableHandlers = {
      appointment_card_requests: { first: () => LANE_ROW() },
      estimate_card_holds: { first: () => null },
      scheduled_services: { first: () => RECAP_SVC() },
      customers: { first: () => RECAP_CUSTOMER() },
      invoices: { first: () => RECAP_INVOICE() },
      ...overrides,
    };
    mockCustomerOnAutopay.mockResolvedValue(true);
    mockGetAutopayPm.mockResolvedValue({ id: 'pm-row-1', stripe_payment_method_id: 'pm_x', method_type: 'card' });
  }

  test('gate off → feature_disabled, nothing touched', async () => {
    recapHandlers();
    mockCompletionGateOn = false;
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res).toEqual({ charged: false, reason: 'feature_disabled' });
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('happy path: invoice minted through the SHARED lock helper, charged with the saved autopay method, autopay-logged', async () => {
    recapHandlers();
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res).toEqual({ charged: true, invoiceId: 'inv-r1' });
    expect(mockResolveOrMintInvoice).toHaveBeenCalledWith(expect.objectContaining({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' }));
    // The frozen cap rides INTO the charge service (Codex #3153 r7 P0) so
    // it is re-enforced against the locked invoice, and Auto Pay is
    // serialized inside the charge transaction (r13).
    expect(mockChargeSavedCard).toHaveBeenCalledWith('inv-r1', 'pm-row-1', {
      maxAuthorizedSubtotal: 250,
      requireAutopayForCustomerId: 'cust-1',
      requireSelfPayScheduledServiceId: 'svc-1',
    });
    expect(mockLogAutopay).toHaveBeenCalledWith('cust-1', 'charge_success', expect.objectContaining({
      details: expect.objectContaining({ source: 'appointment_card_recap_completion' }),
    }));
  });

  test('no lane row → no_lane_row, silent skip (normal recaps stay no-bill)', async () => {
    recapHandlers({ appointment_card_requests: { first: () => null } });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('no_lane_row');
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('hold row present → card_hold_lane (that rail already ran on this recap)', async () => {
    recapHandlers({ estimate_card_holds: { first: () => ({ id: 'hold-1' }) } });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('card_hold_lane');
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('hold lookup failure fails closed with an office alert', async () => {
    recapHandlers({ estimate_card_holds: { first: () => { throw new Error('db blip'); } } });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('hold_lookup_failed');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('prior non-performed re-completion → review alert, never an auto-charge', async () => {
    recapHandlers();
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1', priorNonPerformed: true });
    expect(res.reason).toBe('prior_non_performed');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('field-prepaid visit → manual review (never charge on top of a prepayment)', async () => {
    recapHandlers({ scheduled_services: { first: () => ({ ...RECAP_SVC(), prepaid_amount: '100.00' }) } });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('prepaid_visit_manual');
    expect(mockNotifyAdmin).toHaveBeenCalled();
  });

  test('NULL accepted_amount (pre-migration row) → review, never a live-price fallback', async () => {
    recapHandlers({ appointment_card_requests: { first: () => ({ ...LANE_ROW(), accepted_amount: null }) } });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('no_accepted_amount');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('invoice above the FROZEN accepted amount → above_accepted_amount review, no charge', async () => {
    recapHandlers({ invoices: { first: () => ({ ...RECAP_INVOICE(), subtotal: '300.00' }) } });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('above_accepted_amount');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('an unexpected dependency crash AFTER the lane check still alerts the office (Codex #3153 r2 — recap has no fallback)', async () => {
    recapHandlers({ customers: { first: () => { throw new Error('db down'); } } });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('error');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('payer-linked invoice → payer_billed WITH office alert (recap has no delivery path — Codex #3153 r6)', async () => {
    recapHandlers({ invoices: { first: () => ({ ...RECAP_INVOICE(), payer_id: 'payer-9' }) } });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('payer_billed');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('VOIDED recap invoice → office alert, never a silent unbilled visit (Codex #3153 r10)', async () => {
    recapHandlers({ invoices: { first: () => ({ ...RECAP_INVOICE(), status: 'void' }) } });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('invoice_void');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('declined charge → charge_failed with office alert + autopay failure log', async () => {
    recapHandlers();
    mockChargeSavedCard.mockRejectedValueOnce(new Error('card_declined'));
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('charge_failed');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockLogAutopay).toHaveBeenCalledWith('cust-1', 'charge_failed', expect.anything());
  });

  test('payer assigned AFTER the invoice was pre-minted → payer_billed at the charge boundary, office alerted (Codex #3153 r13)', async () => {
    recapHandlers();
    require('../services/payer').resolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-9' });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('payer_billed');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('boundary payer lookup FAILURE fails closed with an office alert (Codex #3153 r13)', async () => {
    recapHandlers();
    require('../services/payer').resolveForInvoice.mockRejectedValueOnce(new Error('payer db down'));
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('payer_check_failed');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('Auto Pay pause landing AFTER eligibility but before the charge → no charge (Codex #3153 r12 — boundary re-check)', async () => {
    recapHandlers();
    mockCustomerOnAutopay.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('no_chargeable_method');
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });

  test('no chargeable autopay method → review alert (recap has no pay-link fallback)', async () => {
    recapHandlers();
    mockGetAutopayPm.mockResolvedValue(null);
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('no_chargeable_method');
    expect(mockNotifyAdmin).toHaveBeenCalled();
  });

  test('explicit billing lane (monthly membership) → other_billing_lane, that rail owns billing', async () => {
    recapHandlers();
    require('../services/billing-lane').resolveBillingLane.mockReturnValueOnce({ mode: 'monthly_membership' });
    const res = await chargeAppointmentCardForRecapCompletion({ scheduledServiceId: 'svc-1', serviceRecordId: 'sr-1' });
    expect(res.reason).toBe('other_billing_lane');
    expect(mockChargeSavedCard).not.toHaveBeenCalled();
  });
});

describe('pest-recap wiring (source contract)', () => {
  const src = require('fs').readFileSync(require.resolve('../services/pest-recap.js'), 'utf8');

  test('the recap closeout runs the appointment-card fallback ONLY when the hold rail positively owns nothing', () => {
    expect(src).toContain("['no_hold', 'feature_disabled'].includes(holdResult?.reason)");
    expect(src).toContain('chargeAppointmentCardForRecapCompletion({');
  });

  test('the shared recap mint delegates to the CANONICAL scheduled-invoice-mint helper (Codex #3153 r4+r5)', () => {
    const holds = require('fs').readFileSync(require.resolve('../services/estimate-card-holds.js'), 'utf8');
    const fn = holds.slice(
      holds.indexOf('async function resolveOrMintRecapCompletionInvoice'),
      holds.indexOf('async function chargeCardHoldForRecapCompletion'),
    );
    // Canonical lock + create() ON the lock transaction's connection both
    // live in scheduled-invoice-mint.js — a recap-private lock key or a
    // second-connection mint here re-opens the double-invoice/pool races.
    expect(fn).toContain('mintScheduledServiceInvoiceWithDeposit');
    expect(fn).not.toContain('card_hold_recap_invoice');
    expect(fn).not.toContain('createFromService');
    const mint = require('fs').readFileSync(require.resolve('../services/scheduled-invoice-mint.js'), 'utf8');
    expect(mint).toContain("'schedule.invoice.mint'");
    expect(mint).toContain('database: trx');
  });

  test('the fallback runs AFTER the hold rail and forwards the prior-non-performed guard', () => {
    const holdIdx = src.indexOf('chargeCardHoldForRecapCompletion({');
    const apptIdx = src.indexOf('chargeAppointmentCardForRecapCompletion({');
    expect(holdIdx).toBeGreaterThan(-1);
    expect(apptIdx).toBeGreaterThan(holdIdx);
    const apptCall = src.slice(apptIdx, src.indexOf('});', apptIdx));
    expect(apptCall).toContain('priorNonPerformed: recapPriorNonPerformed');
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
    // NO attach self-heal on the fee path (Codex #3153 r9 P1): re-attaching
    // would resurrect a method a racing removal just revoked — a detached
    // method must fail the charge instead.
    expect(mockAttach).not.toHaveBeenCalled();
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

  test('claim race lost (0 rows) → canonical charge_review, nothing charged (Codex #3153 r2 — the winner may still charge)', async () => {
    mockTableHandlers = handlersWith({
      request: REQUEST(),
    });
    mockTableHandlers.appointment_card_requests.update = (chain, patch) => (patch.fee_status === 'charging' ? 0 : 1);
    const res = await chargeAppointmentNoShowFee({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('charge_review');
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
  test('cancel at EXACTLY the disclosed boundary is FREE — "less than N hours" means strict (Codex #3153 r10)', () => {
    const req = { cancel_window_hours: 24, fee_agreed_at: new Date(NOW.getTime() - 100 * HOUR) };
    expect(isWithinApptCancelWindow({ request: req, serviceStart: new Date(NOW.getTime() + 24 * HOUR), now: NOW })).toBe(false);
    expect(isWithinApptCancelWindow({ request: req, serviceStart: new Date(NOW.getTime() + 24 * HOUR - 1000), now: NOW })).toBe(true);
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

  test('in-window cancel whose charge DECLINES reports released:false — the route alert must fire (Codex #3153 r17)', async () => {
    mockApptTime = new Date(Date.now() + 3 * HOUR);
    mockChargeOffSession.mockRejectedValueOnce(Object.assign(new Error('card_declined'), { type: 'StripeCardError' }));
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res.charged).toBe(false);
    expect(res.released).toBe(false);
    expect(res.reason).toBe('charge_failed');
  });

  test('outside-window cancel → free, nothing charged, and the release is PERSISTED terminal (Codex #3153 r2)', async () => {
    mockApptTime = new Date(Date.now() + 100 * HOUR);
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: true, released: true, reason: 'cancel_outside_window' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    // A cancellation retry that lands inside the window (or after a gate
    // flip) must find a resolved fee event, never a chargeable row.
    const released = mockDbTouches
      .filter((t) => t.table === 'appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))
      .map(([, patch]) => patch)
      .find((p) => p.fee_status === 'released');
    expect(released).toBeTruthy();
  });

  test('free-release stamp lost to a concurrent charge claim → NON-released charge_review (Codex #3153 r2)', async () => {
    mockApptTime = new Date(Date.now() + 100 * HOUR);
    mockTableHandlers.appointment_card_requests.update = (chain, patch) => (patch.fee_status === 'released' ? 0 : 1);
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: false, released: false, reason: 'charge_review' });
  });

  test('no fee lane on the visit → handled:false but released (never blocks a cancel)', async () => {
    mockTableHandlers = handlersWith({ request: null });
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res.handled).toBe(false);
    expect(res.released).toBe(true);
  });

  test('gate off → in-window cancel short-circuits released, NO lookups, NO charge (dark = byte-identical behavior — Codex #3153 r11)', async () => {
    mockGateOn = false;
    mockApptTime = new Date(Date.now() + 3 * HOUR);
    const payerMock = require('../services/payer').resolveForInvoice;
    payerMock.mockClear();
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ handled: false, released: true, reason: 'feature_disabled' });
    expect(mockChargeOffSession).not.toHaveBeenCalled();
    // The fail-closed payer/hold lookups never run while dark — their
    // error outcomes must not block refunds for a fee that cannot charge.
    expect(payerMock).not.toHaveBeenCalled();
    // Flip protection survives: the row is terminally stamped released.
    const released = mockDbTouches
      .filter((t) => t.table === 'appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))
      .map(([, patch]) => patch)
      .find((p) => p.fee_status === 'released');
    expect(released).toBeTruthy();
  });

  test('gate off + FAILING hold lookup → still a clean release (dark rail never parks review — Codex #3153 r11)', async () => {
    mockGateOn = false;
    mockTableHandlers.estimate_card_holds.first = () => { throw new Error('db blip'); };
    const res = await handleAppointmentCardCancellation({ scheduledServiceId: 'svc-1', waiveFee: true });
    expect(res).toEqual({ handled: false, released: true, reason: 'feature_disabled' });
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
    // Dark rail presents as ABSENT — no lookups, no fee-may-apply
    // previews (Codex #3153 r11).
    expect(res).toEqual({ secured: false, feeApplies: false });
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
