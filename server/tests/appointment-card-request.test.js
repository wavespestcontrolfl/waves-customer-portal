// Appointment card-request funnel (card-on-file spec §3 Phase 5.1).
// Pins the ordered checks — exemption → saved-method auto-secure →
// existing-request dedup → one-text-ever claim — and the release-on-failed-
// send discipline. db + every collaborator mocked; the decision logic runs
// for real.

let mockTableHandlers = {};
let mockDbTouches = [];
jest.mock('../models/db', () => {
  const makeChain = (handlers, touch) => {
    const chain = { calls: [] };
    const record = (op) => (...args) => { chain.calls.push([op, ...args]); return chain; };
    chain.where = record('where');
    chain.whereNull = record('whereNull');
    chain.insert = record('insert');
    chain.onConflict = record('onConflict');
    chain.ignore = record('ignore');
    chain.first = (...args) => Promise.resolve(handlers.first ? handlers.first(chain, ...args) : null);
    chain.update = (patch) => {
      chain.calls.push(['update', patch]);
      return Promise.resolve(handlers.update ? handlers.update(chain, patch) : 1);
    };
    chain.returning = (...args) => Promise.resolve(handlers.returning ? handlers.returning(chain, ...args) : [{ id: 'new-row' }]);
    chain.del = () => { chain.calls.push(['del']); return Promise.resolve(handlers.del ? handlers.del(chain) : 1); };
    touch.chain = chain;
    return chain;
  };
  return jest.fn((table) => {
    const touch = { table };
    mockDbTouches.push(touch);
    return makeChain(mockTableHandlers[table] || {}, touch);
  });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockResolveForInvoice = jest.fn(async () => null);
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...a) => mockResolveForInvoice(...a),
}));
const mockCustomerOnAutopay = jest.fn(async () => false);
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: (...a) => mockCustomerOnAutopay(...a),
}));
const mockFindConsentedChargeableCard = jest.fn(async () => null);
const mockHasEnrollmentScopedConsent = jest.fn(async () => false);
const mockRecordConsent = jest.fn(async () => ({ id: 'consent-1' }));
const mockLinkPaymentMethodId = jest.fn(async () => {});
jest.mock('../services/payment-method-consents', () => ({
  findConsentedChargeableCard: (...a) => mockFindConsentedChargeableCard(...a),
  hasEnrollmentScopedConsent: (...a) => mockHasEnrollmentScopedConsent(...a),
  recordConsent: (...a) => mockRecordConsent(...a),
  linkPaymentMethodId: (...a) => mockLinkPaymentMethodId(...a),
}));
const mockRetrieveSetupIntent = jest.fn();
const mockCreateAppointmentCardSetupIntent = jest.fn();
const mockSavePaymentMethod = jest.fn(async () => ({ id: 'pm-row-9', method_type: 'card' }));
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
  createAppointmentCardSetupIntent: (...a) => mockCreateAppointmentCardSetupIntent(...a),
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
}));
const mockNotifyAdmin = jest.fn(async () => {});
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...a) => mockNotifyAdmin(...a),
}));
const mockEnrollConsentedMethod = jest.fn(async () => ({ enrolled: true }));
jest.mock('../services/autopay-enrollment', () => ({
  enrollConsentedMethod: (...a) => mockEnrollConsentedMethod(...a),
}));
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: (...a) => mockSendCustomerMessage(...a),
}));
const mockShorten = jest.fn(async () => 'https://wvs.link/sec1');
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: (...a) => mockShorten(...a),
}));
const mockGetTemplate = jest.fn(async () => 'Hi Pat! Secure your visit: https://wvs.link/sec1');
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: (...a) => mockGetTemplate(...a),
}));

const {
  requestCardForAppointment,
  completeSecureCardCapture,
  loadSecureCardPageData,
  _test,
} = require('../services/appointment-card-request');

const VISIT = {
  id: 'svc-1',
  customer_id: 'cust-1',
  status: 'confirmed',
  scheduled_date: '2099-07-20',
  window_display: '9:00 AM',
  service_type: 'Pest Control',
  card_link_sent_at: null,
};
const CUSTOMER = { id: 'cust-1', first_name: 'Pat', phone: '+19415551234' };

function baseHandlers(overrides = {}) {
  return {
    scheduled_services: { first: () => ({ ...VISIT }) },
    customers: { first: () => ({ ...CUSTOMER }) },
    appointment_card_requests: { first: () => null },
    ...overrides,
  };
}

function touches(table) {
  return mockDbTouches.filter((t) => t.table === table);
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APPOINTMENT_CARD_REQUEST = 'true';
  mockTableHandlers = baseHandlers();
  mockDbTouches = [];
});
afterAll(() => { delete process.env.APPOINTMENT_CARD_REQUEST; });

describe('requestCardForAppointment — gate and visit eligibility', () => {
  test('gate off → inert, no queries', async () => {
    delete process.env.APPOINTMENT_CARD_REQUEST;
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res).toEqual({ requested: false, action: 'skipped', reason: 'gate_off' });
    expect(mockDbTouches).toHaveLength(0);
  });

  test('non-live visit (completed/cancelled) never texts', async () => {
    mockTableHandlers.scheduled_services.first = () => ({ ...VISIT, status: 'completed' });
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('visit_not_live:completed');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('past visit never texts', async () => {
    mockTableHandlers.scheduled_services.first = () => ({ ...VISIT, scheduled_date: '2020-01-01' });
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('visit_in_past');
  });
});

describe('check 1 — policy exemption (before any capture machinery)', () => {
  test('payer-billed visit is exempt; saved-method check never runs', async () => {
    mockResolveForInvoice.mockResolvedValueOnce({ payerId: 'payer-9' });
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('payer_billed');
    expect(mockFindConsentedChargeableCard).not.toHaveBeenCalled();
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('payer lookup failure fails toward EXEMPT (never the wrong party)', async () => {
    mockResolveForInvoice.mockRejectedValueOnce(new Error('payer db down'));
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('payer_check_uncertain');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('already on Auto Pay → exempt', async () => {
    mockCustomerOnAutopay.mockResolvedValueOnce(true);
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('autopay_already_active');
  });
});

describe('check 2 — saved method auto-secures instead of texting', () => {
  const SAVED = { id: 'pm-row-1', stripe_payment_method_id: 'pm_stripe_1' };

  test('consented chargeable card → satisfied row + enrollment, no SMS', async () => {
    mockFindConsentedChargeableCard.mockResolvedValueOnce(SAVED);
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1', trigger: 'book_flow' });
    expect(res).toEqual({ requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' });
    const reqTouches = touches('appointment_card_requests');
    expect(reqTouches).toHaveLength(1);
    const insert = reqTouches[0].chain.calls.find(([op]) => op === 'insert');
    expect(insert[1]).toMatchObject({
      scheduled_service_id: 'svc-1',
      status: 'satisfied',
      payment_method_id: 'pm-row-1',
      trigger: 'book_flow',
    });
    expect(mockEnrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      paymentMethodId: 'pm-row-1',
      source: 'save_card_consent',
    }));
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('auto-secure insert lost the race → request_exists, no enrollment', async () => {
    mockFindConsentedChargeableCard.mockResolvedValueOnce(SAVED);
    mockTableHandlers.appointment_card_requests.returning = () => [];
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('request_exists');
    expect(mockEnrollConsentedMethod).not.toHaveBeenCalled();
  });

  test('enrollment failure still skips the text (saved method IS the protection)', async () => {
    mockFindConsentedChargeableCard.mockResolvedValueOnce(SAVED);
    mockEnrollConsentedMethod.mockRejectedValueOnce(new Error('stripe down'));
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.action).toBe('auto_secured');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('checks 3+4 — dedup and the one-text-ever claim', () => {
  test('existing request row (any status) skips', async () => {
    mockTableHandlers.appointment_card_requests.first = () => ({ id: 'req-1', status: 'pending' });
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('request_exists');
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  test('inactive template skips WITHOUT consuming the claim', async () => {
    mockGetTemplate.mockResolvedValueOnce(null);
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('template_inactive');
    const updates = touches('scheduled_services')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'));
    expect(updates).toHaveLength(0);
  });

  test('lost claim race (0 rows) → skip, no row insert, no SMS', async () => {
    mockTableHandlers.scheduled_services.update = () => 0;
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('link_already_sent');
    const inserts = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'insert'));
    expect(inserts).toHaveLength(0);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });
});

describe('the send', () => {
  test('happy path: one SMS through the canonical path, pending row with 64-hex token', async () => {
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1', trigger: 'ai_call_pipeline' });
    expect(res).toEqual({ requested: true, action: 'sent', reason: 'sent' });

    const insert = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'insert'))[0];
    expect(insert[1].status).toBe('pending');
    expect(insert[1].trigger).toBe('ai_call_pipeline');
    expect(insert[1].token).toMatch(/^[a-f0-9]{64}$/);

    expect(mockGetTemplate).toHaveBeenCalledWith('secure_appointment_card', expect.objectContaining({
      first_name: 'Pat',
      service_type: 'Pest Control',
      secure_link: 'https://wvs.link/sec1',
      date_line: expect.stringContaining(' on '),
    }));
    expect(mockSendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415551234',
      channel: 'sms',
      audience: 'customer',
      purpose: 'card_request',
      customerId: 'cust-1',
      identityTrustLevel: 'phone_matches_customer',
    }));
  });

  test('blocked send releases the claim and the pending row', async () => {
    mockSendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'SUPPRESSED' });
    const res = await requestCardForAppointment({ scheduledServiceId: 'svc-1' });
    expect(res.reason).toBe('send_blocked:SUPPRESSED');

    const ssUpdates = touches('scheduled_services')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))
      .map(([, patch]) => patch);
    // Claim taken, then released back to NULL.
    expect(ssUpdates.some((p) => p.card_link_sent_at instanceof Date)).toBe(true);
    expect(ssUpdates.some((p) => p.card_link_sent_at === null)).toBe(true);
    const dels = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'del'));
    expect(dels).toHaveLength(1);
  });
});

describe('dateLineFor', () => {
  test('renders a clause for a real date and empty for junk', () => {
    expect(_test.dateLineFor('2099-07-20')).toMatch(/^ on \w{3}, Jul 20$/);
    expect(_test.dateLineFor(null)).toBe('');
    expect(_test.dateLineFor('nonsense')).toBe('');
  });
});

// ── /secure/:token capture lifecycle ──

const REQUEST = {
  id: 'req-1',
  scheduled_service_id: 'svc-1',
  customer_id: 'cust-1',
  status: 'pending',
  token: 'a'.repeat(64),
  stripe_setup_intent_id: null,
};
const GOOD_INTENT = {
  id: 'seti_1',
  status: 'succeeded',
  payment_method: 'pm_stripe_9',
  metadata: { purpose: 'appointment_card_request', request_id: 'req-1' },
};

describe('verifySecureCardIntent — trust re-derived from Stripe, never the client', () => {
  test.each([
    ['not succeeded', { ...GOOD_INTENT, status: 'requires_payment_method' }],
    ['wrong purpose', { ...GOOD_INTENT, metadata: { purpose: 'estimate_recurring_card', request_id: 'req-1' } }],
    ['another request\'s intent', { ...GOOD_INTENT, metadata: { purpose: 'appointment_card_request', request_id: 'req-OTHER' } }],
    ['no payment method', { ...GOOD_INTENT, payment_method: null }],
  ])('rejects a live intent that is %s', async (_label, intent) => {
    mockRetrieveSetupIntent.mockResolvedValueOnce(intent);
    const res = await _test.verifySecureCardIntent({ request: REQUEST, setupIntentId: 'seti_1' });
    expect(res).toEqual({ ok: false, reason: 'intent_mismatch' });
  });

  test('accepts a succeeded intent pinned to this request', async () => {
    mockRetrieveSetupIntent.mockResolvedValueOnce(GOOD_INTENT);
    const res = await _test.verifySecureCardIntent({ request: REQUEST, setupIntentId: 'seti_1' });
    expect(res).toEqual({ ok: true, stripePaymentMethodId: 'pm_stripe_9', setupIntentId: 'seti_1' });
  });

  test('Stripe retrieval failure fails closed', async () => {
    mockRetrieveSetupIntent.mockRejectedValueOnce(new Error('stripe down'));
    const res = await _test.verifySecureCardIntent({ request: REQUEST, setupIntentId: 'seti_1' });
    expect(res).toEqual({ ok: false, reason: 'verification_failed' });
  });
});

describe('completeSecureCardCapture — save → consent → enroll → complete', () => {
  beforeEach(() => {
    mockTableHandlers = {
      appointment_card_requests: { first: () => ({ ...REQUEST }) },
      payment_methods: { first: () => null },
      customers: { first: () => ({ ...CUSTOMER }) },
    };
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_INTENT);
  });

  test('happy path: saves, records consent, enrolls, marks the row completed', async () => {
    const res = await completeSecureCardCapture({ token: REQUEST.token, setupIntentId: 'seti_1', ip: '1.2.3.4', userAgent: 'jest' });
    expect(res).toEqual({ ok: true });
    expect(mockSavePaymentMethod).toHaveBeenCalledWith('cust-1', 'pm_stripe_9', expect.objectContaining({ enableAutopay: false, makeDefault: false }));
    expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      stripePaymentMethodId: 'pm_stripe_9',
      source: 'appointment_card_request',
      ip: '1.2.3.4',
    }));
    expect(mockEnrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      paymentMethodId: 'pm-row-9',
      source: 'save_card_consent',
    }));
    const update = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))[0];
    expect(update[1]).toMatchObject({ status: 'completed', stripe_payment_method_id: 'pm_stripe_9', payment_method_id: 'pm-row-9' });
  });

  test('already completed → idempotent ok, nothing re-runs', async () => {
    mockTableHandlers.appointment_card_requests.first = () => ({ ...REQUEST, status: 'completed' });
    const res = await completeSecureCardCapture({ token: REQUEST.token, setupIntentId: 'seti_1' });
    expect(res).toEqual({ ok: true, alreadyCompleted: true });
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnrollConsentedMethod).not.toHaveBeenCalled();
  });

  test('a card belonging to ANOTHER customer is refused and surfaced', async () => {
    mockTableHandlers.payment_methods.first = () => ({ id: 'pm-row-X', customer_id: 'cust-OTHER' });
    const res = await completeSecureCardCapture({ token: REQUEST.token, setupIntentId: 'seti_1' });
    expect(res).toEqual({ ok: false, code: 'pm_ownership_mismatch' });
    expect(mockNotifyAdmin).toHaveBeenCalled();
    expect(mockRecordConsent).not.toHaveBeenCalled();
  });

  test('existing enrollment-scoped consent is not re-recorded', async () => {
    mockHasEnrollmentScopedConsent.mockResolvedValueOnce(true);
    const res = await completeSecureCardCapture({ token: REQUEST.token, setupIntentId: 'seti_1' });
    expect(res).toEqual({ ok: true });
    expect(mockRecordConsent).not.toHaveBeenCalled();
    expect(mockEnrollConsentedMethod).toHaveBeenCalled();
  });

  test('enrollment refusal still completes the capture but alerts the office', async () => {
    mockEnrollConsentedMethod.mockResolvedValueOnce({ enrolled: false, reason: 'ach_blocked' });
    const res = await completeSecureCardCapture({ token: REQUEST.token, setupIntentId: 'seti_1' });
    expect(res).toEqual({ ok: true });
    expect(mockNotifyAdmin).toHaveBeenCalled();
    const update = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))[0];
    expect(update[1].status).toBe('completed');
  });

  test('unverifiable intent never writes anything', async () => {
    mockRetrieveSetupIntent.mockResolvedValueOnce({ ...GOOD_INTENT, status: 'requires_action' });
    const res = await completeSecureCardCapture({ token: REQUEST.token, setupIntentId: 'seti_1' });
    expect(res).toEqual({ ok: false, code: 'intent_mismatch' });
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockRecordConsent).not.toHaveBeenCalled();
    expect(touches('appointment_card_requests').flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))).toHaveLength(0);
  });
});

describe('loadSecureCardPageData — page state machine', () => {
  beforeEach(() => {
    mockTableHandlers = {
      appointment_card_requests: { first: () => ({ ...REQUEST }) },
      scheduled_services: { first: () => ({ ...VISIT }) },
      customers: { first: () => ({ ...CUSTOMER }) },
    };
    mockCreateAppointmentCardSetupIntent.mockResolvedValue({ id: 'seti_1', status: 'requires_payment_method', client_secret: 'cs_1' });
  });

  test('unknown token → null (route 404s, no existence oracle)', async () => {
    mockTableHandlers.appointment_card_requests.first = () => null;
    await expect(loadSecureCardPageData('f'.repeat(64))).resolves.toBeNull();
  });

  test('pending + live visit → ready with a minted intent persisted on the row', async () => {
    const res = await loadSecureCardPageData(REQUEST.token);
    expect(res).toMatchObject({
      state: 'ready',
      clientSecret: 'cs_1',
      setupIntentId: 'seti_1',
      firstName: 'Pat',
      serviceType: 'Pest Control',
    });
    const update = touches('appointment_card_requests')
      .flatMap((t) => t.chain.calls.filter(([op]) => op === 'update'))[0];
    expect(update[1]).toMatchObject({ stripe_setup_intent_id: 'seti_1' });
  });

  test('completed request → secured (no new intent minted)', async () => {
    mockTableHandlers.appointment_card_requests.first = () => ({ ...REQUEST, status: 'completed' });
    const res = await loadSecureCardPageData(REQUEST.token);
    expect(res.state).toBe('secured');
    expect(mockCreateAppointmentCardSetupIntent).not.toHaveBeenCalled();
  });

  test('cancelled or past visit → closed (no intent minted)', async () => {
    mockTableHandlers.scheduled_services.first = () => ({ ...VISIT, status: 'cancelled' });
    const res = await loadSecureCardPageData(REQUEST.token);
    expect(res.state).toBe('closed');
    expect(mockCreateAppointmentCardSetupIntent).not.toHaveBeenCalled();
  });

  test('canceled intent replays walk the generation salt forward', async () => {
    mockCreateAppointmentCardSetupIntent
      .mockResolvedValueOnce({ id: 'seti_dead', status: 'canceled', client_secret: 'cs_dead' })
      .mockResolvedValueOnce({ id: 'seti_2', status: 'requires_payment_method', client_secret: 'cs_2' });
    const res = await loadSecureCardPageData(REQUEST.token);
    expect(res.state).toBe('ready');
    expect(res.setupIntentId).toBe('seti_2');
    expect(mockCreateAppointmentCardSetupIntent).toHaveBeenCalledTimes(2);
    expect(mockCreateAppointmentCardSetupIntent.mock.calls[1][0]).toMatchObject({ generation: 1 });
  });

  test('Stripe unconfigured → unavailable, not a crash', async () => {
    mockCreateAppointmentCardSetupIntent.mockResolvedValueOnce(null);
    const res = await loadSecureCardPageData(REQUEST.token);
    expect(res.state).toBe('unavailable');
  });
});
