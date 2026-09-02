// Standalone "set up Auto Pay" link (GATE_AUTOPAY_SETUP_LINK) — the
// customer-scoped mode of appointment_card_requests. Pins the ordered
// checks (gate → customer → payer → already-on-Auto-Pay → saved-method
// auto-secure → dedup/expiry → mint), the two deliveries (inline hands the
// link back and sends nothing; sms rides the card_request purpose,
// operator-initiated), the page state machine, and the completion tail.

let mockTableHandlers = {};
let mockDbTouches = [];
jest.mock('../models/db', () => {
  const makeChain = (handlers, touch) => {
    const chain = { calls: [] };
    const record = (op) => (...args) => { chain.calls.push([op, ...args]); return chain; };
    chain.where = record('where');
    chain.whereNull = record('whereNull');
    chain.whereIn = record('whereIn');
    chain.orderBy = record('orderBy');
    chain.forUpdate = record('forUpdate');
    chain.insert = record('insert');
    chain.first = (...args) => Promise.resolve(handlers.first ? handlers.first(chain, ...args) : null);
    chain.update = (patch) => {
      chain.calls.push(['update', patch]);
      return Promise.resolve(handlers.update ? handlers.update(chain, patch) : 1);
    };
    chain.returning = (...args) => {
      chain.calls.push(['returning', ...args]);
      if (handlers.returning) return Promise.resolve(handlers.returning(chain, ...args));
      const inserted = chain.calls.find((c) => c[0] === 'insert')?.[1] || {};
      return Promise.resolve([{ id: 'req-new', token: inserted.token, expires_at: inserted.expires_at }]);
    };
    touch.chain = chain;
    return chain;
  };
  const db = jest.fn((table) => {
    const touch = { table };
    mockDbTouches.push(touch);
    return makeChain(mockTableHandlers[table] || {}, touch);
  });
  db.transaction = async (cb) => cb(db);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockResolveForInvoice = jest.fn(async () => null);
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolveForInvoice(...a) }));
const mockCustomerOnAutopay = jest.fn(async () => false);
jest.mock('../services/autopay-eligibility', () => ({
  customerOnAutopay: (...a) => mockCustomerOnAutopay(...a),
  isPaused: (c) => !!c?.autopay_paused_until,
}));
const mockFindConsentedChargeableCard = jest.fn(async () => null);
const mockHasConsentSnapshotForVariant = jest.fn(async () => false);
const mockRecordConsent = jest.fn(async () => ({ id: 'consent-1' }));
const mockLinkPaymentMethodId = jest.fn(async () => {});
jest.mock('../services/payment-method-consents', () => ({
  findConsentedChargeableCard: (...a) => mockFindConsentedChargeableCard(...a),
  hasConsentSnapshotForVariant: (...a) => mockHasConsentSnapshotForVariant(...a),
  recordConsent: (...a) => mockRecordConsent(...a),
  linkPaymentMethodId: (...a) => mockLinkPaymentMethodId(...a),
}));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (name) => (name === 'autopayCustomerSms' ? actual.gates.autopayCustomerSms === true : actual.isEnabled(name)) };
});
const mockEnrollConsentedMethod = jest.fn(async () => ({ enrolled: true }));
jest.mock('../services/autopay-enrollment', () => ({ enrollConsentedMethod: (...a) => mockEnrollConsentedMethod(...a) }));
const mockRetrieveSetupIntent = jest.fn();
const mockRetrievePaymentMethod = jest.fn(async () => ({ id: 'pm_new', type: 'card' }));
const mockCreateSetupIntent = jest.fn(async () => ({ clientSecret: 'cs_new', setupIntentId: 'seti_new', paymentMethodTypes: ['card', 'us_bank_account'], status: 'requires_payment_method' }));
const mockSavePaymentMethod = jest.fn(async () => ({ id: 'pm-row-1', method_type: 'card' }));
jest.mock('../services/stripe', () => ({
  retrieveSetupIntent: (...a) => mockRetrieveSetupIntent(...a),
  retrievePaymentMethod: (...a) => mockRetrievePaymentMethod(...a),
  createSetupIntent: (...a) => mockCreateSetupIntent(...a),
  savePaymentMethod: (...a) => mockSavePaymentMethod(...a),
}));
const mockNotifyAdmin = jest.fn(async () => {});
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotifyAdmin(...a) }));
const mockSendCustomerMessage = jest.fn(async () => ({ sent: true }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSendCustomerMessage(...a) }));
const mockRenderTemplate = jest.fn(async () => 'Hi Pat! Set up Auto Pay: https://x/secure/tok');
jest.mock('../services/appointment-card-request', () => ({ renderTemplate: (...a) => mockRenderTemplate(...a) }));
jest.mock('../utils/portal-url', () => ({ portalUrl: (p) => `https://portal.test${p}` }));

const gates = require('../config/feature-gates').gates;
const {
  requestAutopaySetupLink,
  loadAutopaySetupPageData,
  completeAutopaySetupCapture,
  completeAutopaySetupCaptureFromWebhook,
  _test,
} = require('../services/autopay-setup-link');

const CUSTOMER = { id: 'cust-1', first_name: 'Pat', phone: '+19415551234', ach_status: null, autopay_enabled: false };
const FUTURE = new Date(Date.now() + 10 * 24 * 3600 * 1000);
const PAST = new Date(Date.now() - 3600 * 1000);
const PENDING = { id: 'req-1', kind: 'customer', customer_id: 'cust-1', status: 'pending', token: 'tok1', expires_at: FUTURE, stripe_setup_intent_id: null };

function touches(table) {
  return mockDbTouches.filter((t) => t.table === table).map((t) => t.chain);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbTouches = [];
  mockTableHandlers = { customers: { first: () => ({ ...CUSTOMER }) }, appointment_card_requests: { first: () => null } };
  gates.autopaySetupLink = true;
  // Bank on the standalone link rides the SAME ACH-capture kill switch as
  // the estimate accept capture.
  gates.acceptAchCapture = true;
  gates.autopayCustomerSms = true;
  mockHasConsentSnapshotForVariant.mockResolvedValue(false);
  mockResolveForInvoice.mockResolvedValue(null);
  mockCustomerOnAutopay.mockResolvedValue(false);
  mockFindConsentedChargeableCard.mockResolvedValue(null);
  mockEnrollConsentedMethod.mockResolvedValue({ enrolled: true });
  mockSendCustomerMessage.mockResolvedValue({ sent: true });
  mockRenderTemplate.mockResolvedValue('Hi Pat! Set up Auto Pay: https://x/secure/tok');
  mockSavePaymentMethod.mockResolvedValue({ id: 'pm-row-1', method_type: 'card' });
  mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_new', type: 'card' });
  mockCreateSetupIntent.mockResolvedValue({ clientSecret: 'cs_new', setupIntentId: 'seti_new', paymentMethodTypes: ['card', 'us_bank_account'], status: 'requires_payment_method' });
});
afterAll(() => { gates.autopaySetupLink = false; gates.acceptAchCapture = false; gates.autopayCustomerSms = false; });

describe('requestAutopaySetupLink — ordered checks', () => {
  it('is inert with the gate off (nothing read, nothing minted, nothing sent)', async () => {
    gates.autopaySetupLink = false;
    expect(await requestAutopaySetupLink({ customerId: 'cust-1' })).toEqual({ requested: false, action: 'skipped', reason: 'gate_off' });
    expect(mockDbTouches).toHaveLength(0);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  it('skips an unknown customer', async () => {
    mockTableHandlers.customers = { first: () => null };
    expect((await requestAutopaySetupLink({ customerId: 'nope' })).reason).toBe('customer_not_found');
  });

  it('exempts payer-billed customers and fails toward exempt on a payer lookup error', async () => {
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    expect((await requestAutopaySetupLink({ customerId: 'cust-1' })).reason).toBe('payer_billed');
    mockResolveForInvoice.mockRejectedValue(new Error('db blip'));
    expect((await requestAutopaySetupLink({ customerId: 'cust-1' })).reason).toBe('payer_check_uncertain');
    expect(touches('appointment_card_requests')).toHaveLength(0);
  });

  it('skips a customer already on Auto Pay', async () => {
    mockCustomerOnAutopay.mockResolvedValue(true);
    expect((await requestAutopaySetupLink({ customerId: 'cust-1' })).reason).toBe('autopay_already_active');
  });

  it('treats a PAUSED enrollment as already configured (never a silent resume)', async () => {
    mockTableHandlers.customers = { first: () => ({ ...CUSTOMER, autopay_enabled: true, autopay_paused_until: '2099-01-01' }) };
    expect((await requestAutopaySetupLink({ customerId: 'cust-1' })).reason).toBe('autopay_paused');
    expect(mockEnrollConsentedMethod).not.toHaveBeenCalled();
  });

  it('skips lanes whose visits are covered (monthly dues, annual prepay) or one-time — the per-visit promise would be false', async () => {
    for (const mode of ['monthly_membership', 'annual_prepay', 'one_time']) {
      mockTableHandlers.customers = { first: () => ({ ...CUSTOMER, billing_mode: mode }) };
      expect((await requestAutopaySetupLink({ customerId: 'cust-1' })).reason).toBe('unsupported_billing_lane');
    }
    for (const mode of ['per_visit', 'per_application']) {
      mockTableHandlers.customers = { first: () => ({ ...CUSTOMER, billing_mode: mode }) };
      expect((await requestAutopaySetupLink({ customerId: 'cust-1' })).action).toBe('link_created');
    }
  });

  it('auto-secures from a consented saved card (enrolls, mints no row, sends nothing)', async () => {
    mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pm-row-7', stripe_payment_method_id: 'pm_7' });
    const r = await requestAutopaySetupLink({ customerId: 'cust-1', delivery: 'sms' });
    expect(r).toEqual({ requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' });
    expect(mockEnrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', paymentMethodId: 'pm-row-7', source: 'save_card_consent' }));
    expect(touches('appointment_card_requests')).toHaveLength(0);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  it('a refused saved-method enrollment is a retryable skip, not a link', async () => {
    mockFindConsentedChargeableCard.mockResolvedValue({ id: 'pm-row-7' });
    mockEnrollConsentedMethod.mockResolvedValue({ enrolled: false, reason: 'ach_blocked' });
    expect((await requestAutopaySetupLink({ customerId: 'cust-1' })).reason).toBe('enrollment_refused:ach_blocked');
    expect(touches('appointment_card_requests')).toHaveLength(0);
  });
});

describe('requestAutopaySetupLink — link minting and delivery', () => {
  it('inline: mints a kind=customer row with a 30-day expiry, hands the link back, sends nothing', async () => {
    const before = Date.now();
    const r = await requestAutopaySetupLink({ customerId: 'cust-1', delivery: 'inline', trigger: 'admin' });
    expect(r.action).toBe('link_created');
    expect(r.reason).toBe('created');
    expect(r.secureUrl).toMatch(/^https:\/\/portal\.test\/secure\/[A-Za-z0-9_-]{22}$/);
    const insert = touches('appointment_card_requests').flatMap((c) => c.calls).find((c) => c[0] === 'insert')[1];
    expect(insert).toEqual(expect.objectContaining({ kind: 'customer', customer_id: 'cust-1', status: 'pending', trigger: 'admin' }));
    expect(insert.scheduled_service_id).toBeUndefined();
    const ttlDays = (new Date(insert.expires_at).getTime() - before) / (24 * 3600 * 1000);
    expect(ttlDays).toBeGreaterThan(29.99);
    expect(ttlDays).toBeLessThan(30.01);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
    expect(mockRenderTemplate).not.toHaveBeenCalled();
  });

  it('reuses a live pending row (same token) instead of minting a second link', async () => {
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING }) };
    const r = await requestAutopaySetupLink({ customerId: 'cust-1' });
    expect(r).toEqual(expect.objectContaining({ action: 'link_created', reason: 'request_exists', secureUrl: 'https://portal.test/secure/tok1' }));
    expect(touches('appointment_card_requests').flatMap((c) => c.calls).some((c) => c[0] === 'insert')).toBe(false);
  });

  it('an EXPIRED mid-completion row: a fresh claim reports completion_in_progress, a stale one is retired and a new link mints', async () => {
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING, status: 'completing', expires_at: PAST, updated_at: new Date() }) };
    expect((await requestAutopaySetupLink({ customerId: 'cust-1' })).reason).toBe('completion_in_progress');
    mockDbTouches = [];
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING, status: 'completing', expires_at: PAST, updated_at: new Date(Date.now() - 20 * 60 * 1000) }) };
    const r = await requestAutopaySetupLink({ customerId: 'cust-1' });
    expect(r.action).toBe('link_created');
    expect(r.reason).toBe('created');
    const calls = touches('appointment_card_requests').flatMap((c) => c.calls);
    expect(calls.find((c) => c[0] === 'update')[1]).toEqual(expect.objectContaining({ status: 'expired' }));
  });

  it('treats a live mid-completion row as live: reuses its token and never mints a second link', async () => {
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING, status: 'completing', expires_at: FUTURE }) };
    const r = await requestAutopaySetupLink({ customerId: 'cust-1' });
    expect(r).toEqual(expect.objectContaining({ action: 'link_created', reason: 'request_exists', secureUrl: 'https://portal.test/secure/tok1' }));
    const calls = touches('appointment_card_requests').flatMap((c) => c.calls);
    expect(calls.some((c) => c[0] === 'insert')).toBe(false);
    expect(calls.some((c) => c[0] === 'update')).toBe(false);
    expect(calls.find((c) => c[0] === 'whereIn')).toEqual(['whereIn', 'status', ['pending', 'completing']]);
  });

  it('retires an EXPIRED pending row and mints a fresh one', async () => {
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING, expires_at: PAST }) };
    const r = await requestAutopaySetupLink({ customerId: 'cust-1' });
    expect(r.action).toBe('link_created');
    expect(r.reason).toBe('created');
    expect(r.secureUrl).not.toBe('https://portal.test/secure/tok1');
    const calls = touches('appointment_card_requests').flatMap((c) => c.calls);
    expect(calls.find((c) => c[0] === 'update')[1]).toEqual(expect.objectContaining({ status: 'expired' }));
    expect(calls.some((c) => c[0] === 'insert')).toBe(true);
  });

  it('sms: renders the autopay_setup_link template and sends through the card_request purpose, operator-initiated', async () => {
    const r = await requestAutopaySetupLink({ customerId: 'cust-1', delivery: 'sms', trigger: 'admin' });
    expect(r.action).toBe('sent');
    expect(mockRenderTemplate).toHaveBeenCalledWith(expect.objectContaining({ first_name: 'Pat', secure_link: r.secureUrl }), 'autopay_setup_link');
    expect(mockSendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415551234',
      channel: 'sms',
      audience: 'customer',
      purpose: 'card_request',
      customerId: 'cust-1',
      operatorInitiated: true,
      metadata: expect.objectContaining({ original_message_type: 'autopay_setup_link', trigger: 'admin' }),
    }));
    const calls = touches('appointment_card_requests').flatMap((c) => c.calls);
    expect(calls.find((c) => c[0] === 'update')[1]).toEqual(expect.objectContaining({ sent_at: expect.any(Date) }));
  });

  it('sms: GATE_AUTOPAY_CUSTOMER_SMS off is surfaced as autopay_sms_gate_off (link still returned, nothing sent)', async () => {
    gates.autopayCustomerSms = false;
    const r = await requestAutopaySetupLink({ customerId: 'cust-1', delivery: 'sms' });
    expect(r.reason).toBe('autopay_sms_gate_off');
    expect(r.secureUrl).toMatch(/\/secure\//);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  it('sms: a failed sent_at stamp after an accepted send still reports sent (never a duplicate-inviting failure)', async () => {
    mockTableHandlers.appointment_card_requests = {
      first: () => null,
      update: (chain, patch) => { if (patch.sent_at) throw new Error('db blip'); return 1; },
    };
    const r = await requestAutopaySetupLink({ customerId: 'cust-1', delivery: 'sms' });
    expect(r.action).toBe('sent');
    expect(r.secureUrl).toMatch(/\/secure\//);
  });

  it('sms: an inactive template is a dark lever — the link exists but nothing sends', async () => {
    mockRenderTemplate.mockResolvedValue(null);
    const r = await requestAutopaySetupLink({ customerId: 'cust-1', delivery: 'sms' });
    expect(r.reason).toBe('template_inactive');
    expect(r.secureUrl).toMatch(/\/secure\//);
    expect(mockSendCustomerMessage).not.toHaveBeenCalled();
  });

  it('sms: no phone on file skips the send but still returns the link for copy/paste', async () => {
    mockTableHandlers.customers = { first: () => ({ ...CUSTOMER, phone: null }) };
    const r = await requestAutopaySetupLink({ customerId: 'cust-1', delivery: 'sms' });
    expect(r.reason).toBe('no_customer_phone');
    expect(r.secureUrl).toMatch(/\/secure\//);
  });

  it('sms: a blocked send reports the pipeline reason and leaves the row pending (no sent_at)', async () => {
    mockSendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, reason: 'opted_out' });
    const r = await requestAutopaySetupLink({ customerId: 'cust-1', delivery: 'sms' });
    expect(r.reason).toBe('opted_out');
    const calls = touches('appointment_card_requests').flatMap((c) => c.calls);
    expect(calls.some((c) => c[0] === 'update' && c[1].sent_at)).toBe(false);
  });

  it('never throws — an unexpected failure is a skip', async () => {
    mockTableHandlers.customers = { first: () => { throw new Error('db down'); } };
    expect((await requestAutopaySetupLink({ customerId: 'cust-1' })).reason).toBe('request_failed');
  });
});

describe('loadAutopaySetupPageData — state machine', () => {
  it('renders secured for completed / satisfied rows and "saving" (never secured) for a mid-completion row', async () => {
    for (const status of ['completed', 'satisfied']) {
      const d = await loadAutopaySetupPageData({ ...PENDING, status });
      expect(d).toEqual(expect.objectContaining({ state: 'secured', kind: 'customer', firstName: 'Pat', cancelFeeNote: null }));
    }
    expect((await loadAutopaySetupPageData({ ...PENDING, status: 'completing' })).state).toBe('saving');
    // Expiry wins over the claim state.
    expect((await loadAutopaySetupPageData({ ...PENDING, status: 'completing', expires_at: PAST })).state).toBe('closed');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('renders closed when the customer moved to a lane the per-visit promise does not fit', async () => {
    mockTableHandlers.customers = { first: () => ({ ...CUSTOMER, billing_mode: 'monthly_membership' }) };
    expect((await loadAutopaySetupPageData({ ...PENDING })).state).toBe('closed');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('renders closed once the link expired, was retired, or the customer became payer-billed', async () => {
    expect((await loadAutopaySetupPageData({ ...PENDING, expires_at: PAST })).state).toBe('closed');
    expect((await loadAutopaySetupPageData({ ...PENDING, status: 'expired' })).state).toBe('closed');
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    expect((await loadAutopaySetupPageData({ ...PENDING })).state).toBe('closed');
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('heals the row to satisfied and renders secured when Auto Pay is already active', async () => {
    mockCustomerOnAutopay.mockResolvedValue(true);
    expect((await loadAutopaySetupPageData({ ...PENDING })).state).toBe('secured');
    const calls = touches('appointment_card_requests').flatMap((c) => c.calls);
    expect(calls.find((c) => c[0] === 'update')[1]).toEqual(expect.objectContaining({ status: 'satisfied' }));
  });

  it('mints a card_or_bank INSTANT-verification SetupIntent for a healthy customer and persists its id', async () => {
    const d = await loadAutopaySetupPageData({ ...PENDING });
    expect(d).toEqual(expect.objectContaining({ state: 'ready', kind: 'customer', clientSecret: 'cs_new', setupIntentId: 'seti_new', paymentMethodTypes: ['card', 'us_bank_account'] }));
    expect(mockCreateSetupIntent).toHaveBeenCalledWith('cust-1', 'card_or_bank', expect.objectContaining({
      metadata: { purpose: 'autopay_setup_link', request_id: 'req-1' },
      verificationMethod: 'instant',
      // Deterministic per (request, tender): concurrent page loads replay ONE intent.
      idempotencyKey: 'autopay_setup_link_req-1_card_or_bank',
    }));
    const calls = touches('appointment_card_requests').flatMap((c) => c.calls);
    expect(calls.find((c) => c[0] === 'update')[1]).toEqual(expect.objectContaining({ stripe_setup_intent_id: 'seti_new' }));
  });

  it('mints card-only while GATE_ACCEPT_ACH_CAPTURE is off (one ACH-capture kill switch)', async () => {
    gates.acceptAchCapture = false;
    await loadAutopaySetupPageData({ ...PENDING });
    expect(mockCreateSetupIntent).toHaveBeenCalledWith('cust-1', 'card', expect.objectContaining({ idempotencyKey: 'autopay_setup_link_req-1_card' }));
  });

  it('refuses a BANK capture at completion once GATE_ACCEPT_ACH_CAPTURE is off (intent minted earlier)', async () => {
    gates.acceptAchCapture = false;
    mockRetrieveSetupIntent.mockResolvedValue({ id: 'seti_new', status: 'succeeded', payment_method: { id: 'pm_b', type: 'us_bank_account' }, metadata: { purpose: 'autopay_setup_link', request_id: 'req-1' } });
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).code).toBe('bank_not_allowed');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
  });

  it('mints card-only when the customer ACH state is unhealthy', async () => {
    mockTableHandlers.customers = { first: () => ({ ...CUSTOMER, ach_status: 'suspended' }) };
    await loadAutopaySetupPageData({ ...PENDING });
    expect(mockCreateSetupIntent).toHaveBeenCalledWith('cust-1', 'card', expect.anything());
  });

  it('replays an existing confirmable SetupIntent pinned to this request instead of minting again', async () => {
    mockRetrieveSetupIntent.mockResolvedValue({ id: 'seti_old', client_secret: 'cs_old', status: 'requires_payment_method', payment_method_types: ['card'], metadata: { purpose: 'autopay_setup_link', request_id: 'req-1' } });
    const d = await loadAutopaySetupPageData({ ...PENDING, stripe_setup_intent_id: 'seti_old' });
    expect(d.clientSecret).toBe('cs_old');
    expect(d.paymentMethodTypes).toEqual(['card']);
    expect(mockCreateSetupIntent).not.toHaveBeenCalled();
  });

  it('walks the idempotency generation past a canceled replay', async () => {
    mockCreateSetupIntent
      .mockResolvedValueOnce({ clientSecret: 'cs_dead', setupIntentId: 'seti_dead', paymentMethodTypes: ['card'], status: 'canceled' })
      .mockResolvedValueOnce({ clientSecret: 'cs_2', setupIntentId: 'seti_2', paymentMethodTypes: ['card', 'us_bank_account'], status: 'requires_payment_method' });
    const d = await loadAutopaySetupPageData({ ...PENDING });
    expect(d.setupIntentId).toBe('seti_2');
    expect(mockCreateSetupIntent).toHaveBeenNthCalledWith(2, 'cust-1', 'card_or_bank', expect.objectContaining({ idempotencyKey: 'autopay_setup_link_req-1_card_or_bank_g1' }));
  });

  it('does NOT replay a bank-capable confirmable intent once bank is no longer offered — mints a card-only generation', async () => {
    gates.acceptAchCapture = false;
    mockRetrieveSetupIntent.mockResolvedValue({ id: 'seti_old', client_secret: 'cs_old', status: 'requires_payment_method', payment_method_types: ['card', 'us_bank_account'], metadata: { purpose: 'autopay_setup_link', request_id: 'req-1' } });
    mockCreateSetupIntent.mockResolvedValue({ clientSecret: 'cs_card', setupIntentId: 'seti_card', paymentMethodTypes: ['card'], status: 'requires_payment_method' });
    const d = await loadAutopaySetupPageData({ ...PENDING, stripe_setup_intent_id: 'seti_old' });
    expect(d.setupIntentId).toBe('seti_card');
    expect(d.paymentMethodTypes).toEqual(['card']);
    expect(mockCreateSetupIntent).toHaveBeenCalledWith('cust-1', 'card', expect.objectContaining({ idempotencyKey: 'autopay_setup_link_req-1_card' }));
  });

  it('renders unavailable (not closed) when Stripe cannot mint', async () => {
    mockCreateSetupIntent.mockRejectedValue(new Error('stripe down'));
    expect((await loadAutopaySetupPageData({ ...PENDING })).state).toBe('unavailable');
  });
});

describe('completion tail (page POST + webhook)', () => {
  const GOOD_SI = { id: 'seti_new', status: 'succeeded', payment_method: 'pm_new', metadata: { purpose: 'autopay_setup_link', request_id: 'req-1' } };

  it('live-verifies the intent against Stripe and runs save → consent → enroll → completed', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockTableHandlers.payment_methods = { first: () => null };
    const r = await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new', ip: '1.2.3.4', userAgent: 'jest' });
    expect(r).toEqual({ ok: true });
    expect(mockSavePaymentMethod).toHaveBeenCalledWith('cust-1', 'pm_new', { enableAutopay: false, makeDefault: false, requireAttached: true });
    expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', stripePaymentMethodId: 'pm_new', source: 'autopay_setup_link', methodType: 'card', ip: '1.2.3.4' }));
    expect(mockEnrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', paymentMethodId: 'pm-row-1', source: 'save_card_consent' }));
    const updates = touches('appointment_card_requests').flatMap((c) => c.calls).filter((c) => c[0] === 'update').map((c) => c[1]);
    expect(updates[0]).toEqual(expect.objectContaining({ status: 'completing' }));
    expect(updates[updates.length - 1]).toEqual(expect.objectContaining({ status: 'completed', stripe_payment_method_id: 'pm_new', payment_method_id: 'pm-row-1' }));
  });

  it('guards every write on its own lease token and reports retryable (never success) when the final update misses', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockTableHandlers.payment_methods = { first: () => null };
    // The completed write affects 0 rows — another worker adopted/reverted.
    mockTableHandlers.appointment_card_requests = {
      first: () => null,
      update: (chain, patch) => (patch.status === 'completed' ? 0 : 1),
    };
    const r = await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' });
    expect(r).toEqual({ ok: false, code: 'completion_in_progress' });
    const chains = touches('appointment_card_requests');
    const completedChain = chains.find((c) => c.calls.some((x) => x[0] === 'update' && x[1].status === 'completed'));
    const claimChain = chains.find((c) => c.calls.some((x) => x[0] === 'update' && x[1].status === 'completing'));
    const claimStamp = claimChain.calls.find((x) => x[0] === 'update')[1].updated_at;
    expect(completedChain.calls.find((x) => x[0] === 'where')[1]).toEqual({ id: 'req-1', status: 'completing', updated_at: claimStamp });
  });

  it('records a FRESH consent row per authorization event: a prior consent for the method does not suppress it, a retry of this request does', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockTableHandlers.payment_methods = { first: () => ({ id: 'pm-row-old', customer_id: 'cust-1', method_type: 'card' }) };
    const created = new Date('2026-09-01T12:00:00Z');
    mockHasConsentSnapshotForVariant.mockResolvedValue(false);
    await completeAutopaySetupCapture({ request: { ...PENDING, created_at: created }, setupIntentId: 'seti_new' });
    expect(mockHasConsentSnapshotForVariant).toHaveBeenCalledWith('cust-1', 'pm_new', expect.objectContaining({ methodType: 'card', since: created }));
    expect(mockRecordConsent).toHaveBeenCalledTimes(1);
    mockRecordConsent.mockClear();
    mockHasConsentSnapshotForVariant.mockResolvedValue(true);
    await completeAutopaySetupCapture({ request: { ...PENDING, created_at: created }, setupIntentId: 'seti_new' });
    expect(mockRecordConsent).not.toHaveBeenCalled();
  });

  it('mints a card-only generation instead of replaying a SUCCEEDED bank-capable intent once bank is no longer offered (GH #3726 r1 P0)', async () => {
    gates.acceptAchCapture = false;
    mockRetrieveSetupIntent.mockResolvedValue({ id: 'seti_bank', client_secret: 'cs_bank', status: 'succeeded', payment_method: 'pm_b', payment_method_types: ['card', 'us_bank_account'], metadata: { purpose: 'autopay_setup_link', request_id: 'req-1' } });
    mockCreateSetupIntent.mockResolvedValue({ clientSecret: 'cs_card', setupIntentId: 'seti_card', paymentMethodTypes: ['card'], status: 'requires_payment_method' });
    const d = await loadAutopaySetupPageData({ ...PENDING, stripe_setup_intent_id: 'seti_bank' });
    expect(d.setupIntentId).toBe('seti_card');
    expect(d.paymentMethodTypes).toEqual(['card']);
  });

  it('snapshots the ACH consent from the STRIPE-verified type, even when the local row carries a null/alias method_type', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_new', type: 'us_bank_account' });
    mockTableHandlers.payment_methods = { first: () => ({ id: 'pm-row-legacy', customer_id: 'cust-1', method_type: null }) };
    await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' });
    expect(mockHasConsentSnapshotForVariant).toHaveBeenCalledWith('cust-1', 'pm_new', expect.objectContaining({ methodType: 'ach' }));
    expect(mockRecordConsent).toHaveBeenCalledWith(expect.objectContaining({ methodType: 'ach' }));
  });

  it('passes the SetupIntent authorization moment to enrollment so a later opt-out is honored on retry', async () => {
    mockRetrieveSetupIntent.mockResolvedValue({ ...GOOD_SI, created: 1756800000 });
    mockTableHandlers.payment_methods = { first: () => null };
    await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' });
    expect(mockEnrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({ authorizedAt: new Date(1756800000 * 1000) }));
    mockEnrollConsentedMethod.mockClear();
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING }) };
    await completeAutopaySetupCaptureFromWebhook({ ...GOOD_SI, created: 1756800000 });
    expect(mockEnrollConsentedMethod).toHaveBeenCalledWith(expect.objectContaining({ authorizedAt: new Date(1756800000 * 1000) }));
  });

  it('never reattaches a method the customer removed: PM_NOT_ATTACHED retires the link (method_removed, permanent)', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockTableHandlers.payment_methods = { first: () => null };
    const err = new Error('detached'); err.code = 'PM_NOT_ATTACHED';
    mockSavePaymentMethod.mockRejectedValue(err);
    const r = await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' });
    expect(r).toEqual({ ok: false, code: 'method_removed' });
    expect(mockEnrollConsentedMethod).not.toHaveBeenCalled();
    const updates = touches('appointment_card_requests').flatMap((c) => c.calls).filter((c) => c[0] === 'update').map((c) => c[1]);
    expect(updates[updates.length - 1]).toEqual(expect.objectContaining({ status: 'expired' }));
  });

  it.each([
    ['wrong purpose', { ...GOOD_SI, metadata: { purpose: 'appointment_card_request', request_id: 'req-1' } }],
    ['another request', { ...GOOD_SI, metadata: { ...GOOD_SI.metadata, request_id: 'req-9' } }],
    ['not succeeded', { ...GOOD_SI, status: 'requires_action' }],
  ])('refuses an intent that does not pin to this request (%s)', async (_l, si) => {
    mockRetrieveSetupIntent.mockResolvedValue(si);
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: si.id })).code).toBe('intent_mismatch');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
  });

  it('a refused enrollment reverts the claim, alerts the office, and stays retryable', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockTableHandlers.payment_methods = { first: () => null };
    mockEnrollConsentedMethod.mockResolvedValue({ enrolled: false, reason: 'ach_blocked' });
    const r = await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' });
    expect(r.code).toBe('completion_failed');
    expect(mockNotifyAdmin).toHaveBeenCalled();
    const updates = touches('appointment_card_requests').flatMap((c) => c.calls).filter((c) => c[0] === 'update').map((c) => c[1]);
    expect(updates[updates.length - 1]).toEqual(expect.objectContaining({ status: 'pending' }));
  });

  it('refuses to complete an EXPIRED link on both the page POST and the webhook (nothing saved, nothing enrolled)', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    expect((await completeAutopaySetupCapture({ request: { ...PENDING, expires_at: PAST }, setupIntentId: 'seti_new' })).code).toBe('no_longer_needed');
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING, expires_at: PAST }) };
    expect((await completeAutopaySetupCaptureFromWebhook(GOOD_SI)).code).toBe('no_longer_needed');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    expect(mockEnrollConsentedMethod).not.toHaveBeenCalled();
    expect(touches('appointment_card_requests').flatMap((c) => c.calls).some((c) => c[0] === 'update')).toBe(false);
  });

  it('refuses a BANK capture once the customer ACH state is unhealthy (permanent bank_not_allowed, nothing saved)', async () => {
    mockRetrieveSetupIntent.mockResolvedValue({ ...GOOD_SI, payment_method: { id: 'pm_b', type: 'us_bank_account' } });
    mockTableHandlers.customers = { first: () => ({ ...CUSTOMER, ach_status: 'needs_verification' }) };
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).code).toBe('bank_not_allowed');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    // A card on the same customer still completes.
    mockRetrieveSetupIntent.mockResolvedValue({ ...GOOD_SI, payment_method: { id: 'pm_k', type: 'card' } });
    mockTableHandlers.payment_methods = { first: () => null };
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).ok).toBe(true);
  });

  it('resolves a string pm type via Stripe before judging it and fails closed on a lookup error', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockRetrievePaymentMethod.mockResolvedValue({ id: 'pm_new', type: 'us_bank_account' });
    mockTableHandlers.customers = { first: () => ({ ...CUSTOMER, ach_status: 'suspended' }) };
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).code).toBe('bank_not_allowed');
    mockRetrievePaymentMethod.mockRejectedValue(new Error('stripe down'));
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).code).toBe('verification_failed');
  });

  it('a transient ACH-state read failure at completion is verification_failed (retryable), never bank_not_allowed', async () => {
    mockRetrieveSetupIntent.mockResolvedValue({ ...GOOD_SI, payment_method: { id: 'pm_b', type: 'us_bank_account' } });
    mockTableHandlers.customers = { first: () => { throw new Error('db blip'); } };
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).code).toBe('verification_failed');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
  });

  it('refuses to enable Auto Pay when the billing lane moved to a covered lane since the page loaded (permanent), retryable on a lookup blip', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockTableHandlers.customers = { first: () => ({ ...CUSTOMER, billing_mode: 'monthly_membership' }) };
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).code).toBe('no_longer_needed');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
    mockTableHandlers.customers = { first: () => { throw new Error('db blip'); } };
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).code).toBe('verification_failed');
  });

  it('refuses when the customer became payer-billed since the page loaded', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockResolveForInvoice.mockResolvedValue({ payerId: 'payer-1' });
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).code).toBe('no_longer_needed');
  });

  it('a transient payer lookup failure at completion is verification_failed (retryable), not a permanent refusal', async () => {
    mockRetrieveSetupIntent.mockResolvedValue(GOOD_SI);
    mockResolveForInvoice.mockRejectedValue(new Error('db blip'));
    expect((await completeAutopaySetupCapture({ request: { ...PENDING }, setupIntentId: 'seti_new' })).code).toBe('verification_failed');
    expect(mockSavePaymentMethod).not.toHaveBeenCalled();
  });

  it('webhook backstop completes a pending row from the signed event and acks non-pending rows', async () => {
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING }) };
    mockTableHandlers.payment_methods = { first: () => null };
    expect(await completeAutopaySetupCaptureFromWebhook(GOOD_SI)).toEqual({ ok: true });
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING, status: 'completed' }) };
    expect(await completeAutopaySetupCaptureFromWebhook(GOOD_SI)).toEqual({ ok: true, alreadyCompleted: true });
  });

  it('webhook backstop reports a FRESH completing claim as retryable and ignores visit-lane rows', async () => {
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING, status: 'completing', updated_at: new Date() }) };
    expect((await completeAutopaySetupCaptureFromWebhook(GOOD_SI)).code).toBe('completion_in_progress');
    mockTableHandlers.appointment_card_requests = { first: () => ({ ...PENDING, kind: 'visit' }) };
    expect((await completeAutopaySetupCaptureFromWebhook(GOOD_SI)).code).toBe('not_found');
  });
});

test('the autopay_setup_link consent source is registered in the real consent service and authorizes enrollment', () => {
  const real = jest.requireActual('../services/payment-method-consents');
  expect(real.VALID_SOURCES).toEqual(expect.arrayContaining(['autopay_setup_link']));
  expect(real.NON_ENROLLMENT_CONSENT_SOURCES.has('autopay_setup_link')).toBe(false);
});

describe('_test helpers', () => {
  it('isExpired reads expires_at against now', () => {
    expect(_test.isExpired({ expires_at: PAST })).toBe(true);
    expect(_test.isExpired({ expires_at: FUTURE })).toBe(false);
    expect(_test.isExpired({ expires_at: null })).toBe(false);
  });
});
