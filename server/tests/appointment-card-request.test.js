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
jest.mock('../services/payment-method-consents', () => ({
  findConsentedChargeableCard: (...a) => mockFindConsentedChargeableCard(...a),
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

const { requestCardForAppointment, _test } = require('../services/appointment-card-request');

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
