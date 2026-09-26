// Push channel routing decision rules. The pure decision must fail toward
// SMS on every uncertainty: gate off, no customer, media present,
// operator-authored, or an unlisted template. Conversational and
// link-critical templates must never appear in the policy table.

// attemptPushFirst's billing-leg DB access: mocked only for the
// `attemptPushFirst` describe block below (real `db` is never invoked by
// decidePushRoute/pushEligibleRuntime, which take an explicit knex stub).
const mockRootDb = jest.fn(() => { throw new Error('root pool must not be used on the billing leg'); });
jest.mock('../models/db', () => mockRootDb);
const mockCustomerStatus = jest.fn();
jest.mock('../services/push-notifications', () => ({
  PUSH_HEARTBEAT_HOURS: 72,
  customerStatus: mockCustomerStatus,
}));
const mockNotifyCustomer = jest.fn();
jest.mock('../services/notification-service', () => ({ notifyCustomer: mockNotifyCustomer }));
const mockResolveForInvoice = jest.fn();
jest.mock('../services/payer', () => ({ resolveForInvoice: mockResolveForInvoice }));
const mockRecordTouchpoint = jest.fn(() => Promise.resolve());
jest.mock('../services/conversations', () => ({ recordTouchpoint: mockRecordTouchpoint }));

const {
  decidePushRoute,
  PUSH_ROUTING_POLICY,
  attemptPushFirst,
  _test,
} = require('../services/messaging/push-channel-routing');

const base = {
  gateOn: true,
  customerId: 'c-1',
  messageType: 'appointment_reminder',
  hasMedia: false,
  humanAuthored: false,
  operatorInitiated: false,
};

describe('decidePushRoute', () => {
  it('is sms_only while the gate is off', () => {
    expect(decidePushRoute({ ...base, gateOn: false })).toBe('sms_only');
  });

  it('is sms_only without a customer id', () => {
    expect(decidePushRoute({ ...base, customerId: null })).toBe('sms_only');
  });

  it('is sms_only when the message carries media', () => {
    expect(decidePushRoute({ ...base, hasMedia: true })).toBe('sms_only');
  });

  it('is sms_only for operator-authored messages', () => {
    expect(decidePushRoute({ ...base, humanAuthored: true })).toBe('sms_only');
  });

  it('is sms_only when the operator explicitly initiated the send', () => {
    // Admin receipt routes accept via:'sms' with operatorInitiated:true —
    // the operator chose the channel; push must not override it.
    expect(decidePushRoute({ ...base, messageType: 'receipt', operatorInitiated: true })).toBe('sms_only');
  });

  it('is sms_only for admin-attributed sends (IB tools stamp adminUserId only)', () => {
    expect(decidePushRoute({ ...base, messageType: 'billing_reminder', adminAttributed: true })).toBe('sms_only');
  });

  it('routes critical templates to both channels', () => {
    for (const t of ['appointment_reminder', 'reminder_72h', 'billing_reminder', 'payment_failure', 'autopay']) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('push_and_sms');
    }
  });

  it('keeps operator-triggered appointment actions out of the policy', () => {
    // admin-schedule/admin-dispatch fire these via shared helpers that carry
    // no operatorInitiated provenance — they must stay sms_only.
    expect(decidePushRoute({ ...base, messageType: 'appointment_confirmation' })).toBe('sms_only');
    expect(decidePushRoute({ ...base, messageType: 'appointment_cancelled' })).toBe('sms_only');
  });

  it('routes low-stakes informational templates push-first', () => {
    expect(decidePushRoute({ ...base, messageType: 'tech_en_route' })).toBe('push_first');
    expect(decidePushRoute({ ...base, messageType: 'receipt' })).toBe('push_first');
  });

  it('defaults every unlisted template to sms_only', () => {
    for (const t of ['manual', 'ai_assistant', 'review_request', 'payment_link', 'invoice', 'internal_alert', 'made_up_type', undefined]) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('sms_only');
    }
  });
});

describe('pushEligibleRuntime', () => {
  // Minimal chainable knex stub. A fixture value may be an object (row), an
  // Error (throwing lookup), or a function of the LAST where() arg — the
  // function form lets `customers` serve both the phone lookup (where by id)
  // and the primary-profile resolver (where by account_id).
  const stubKnex = (tables) => (name) => {
    let lastWhere;
    return {
      where(arg) { lastWhere = arg; return this; },
      async first() {
        let v = tables[name];
        if (typeof v === 'function') v = v(lastWhere);
        if (v instanceof Error) throw v;
        return v;
      },
    };
  };

  it('routes when the recipient is the account holder and prefs sit at the seeded sms default', async () => {
    const knex = stubKnex({
      customers: { phone: '+1 (941) 555-0123', account_id: null },
      notification_prefs: { en_route_channel: 'sms' },
    });
    await expect(_test.pushEligibleRuntime('c-1', '9415550123', 'tech_en_route', knex)).resolves.toBe(true);
  });

  it('routes when no prefs row exists at all', async () => {
    const knex = stubKnex({ customers: { phone: '9415550123', account_id: null }, notification_prefs: undefined });
    await expect(_test.pushEligibleRuntime('c-1', '+19415550123', 'tech_en_route', knex)).resolves.toBe(true);
  });

  it('vetoes on an explicit non-default channel choice (email/both)', async () => {
    for (const value of ['email', 'both']) {
      const knex = stubKnex({
        customers: { phone: '9415550123', account_id: null },
        notification_prefs: { en_route_channel: value },
      });
       
      await expect(_test.pushEligibleRuntime('c-1', '9415550123', 'tech_en_route', knex)).resolves.toBe(false);
    }
  });

  it('reads BILLING/receipt choices from the charged profile own row, never the primary', async () => {
    // routes/notifications.js deliberately keeps billing_channel +
    // payment_receipt_channel per charged customer row — a secondary
    // profile's explicit 'both' must veto even when the primary sits at
    // the seeded default.
    const knex = stubKnex({
      customers: (where) => (where && where.account_id
        ? { id: 'primary-1' }
        : { phone: '9415550123', account_id: 'acct-1' }),
      notification_prefs: (where) => (where && where.customer_id === 'primary-1'
        ? { payment_receipt_channel: 'sms' } // primary at default
        : { payment_receipt_channel: 'both' }), // charged profile's explicit choice
    });
    await expect(_test.pushEligibleRuntime('c-2', '9415550123', 'receipt', knex)).resolves.toBe(false);
  });

  it('reads the channel choice from the account PRIMARY profile, not the selected property', async () => {
    const knex = stubKnex({
      customers: (where) => (where && where.account_id
        ? { id: 'primary-1' } // resolver: primary profile of the account
        : { phone: '9415550123', account_id: 'acct-1' }),
      notification_prefs: (where) => (where && where.customer_id === 'primary-1'
        ? { en_route_channel: 'both' } // primary profile's explicit choice
        : { en_route_channel: 'sms' }),
    });
    await expect(_test.pushEligibleRuntime('c-2', '9415550123', 'tech_en_route', knex)).resolves.toBe(false);
  });

  it('vetoes when the primary-profile lookup FAILS (unknown ownership ≠ fallback)', async () => {
    // The route resolver's default swallows errors and falls back to the
    // current profile — routing must instead fail closed to SMS, or a
    // transient failure could override the primary profile's explicit choice.
    const knex = stubKnex({
      customers: (where) => {
        if (where && where.account_id) throw new Error('db down');
        return { phone: '9415550123', account_id: 'acct-1' };
      },
      notification_prefs: { en_route_channel: 'sms' },
    });
    await expect(_test.pushEligibleRuntime('c-2', '9415550123', 'tech_en_route', knex)).resolves.toBe(false);
  });

  it('vetoes secondary-contact recipients (to is not the account holder phone)', async () => {
    const knex = stubKnex({ customers: { phone: '9415550123', account_id: null }, notification_prefs: undefined });
    await expect(_test.pushEligibleRuntime('c-1', '9415559999', 'tech_en_route', knex)).resolves.toBe(false);
  });

  it('vetoes on customer or prefs lookup failure', async () => {
    const bad = stubKnex({ customers: new Error('db down') });
    await expect(_test.pushEligibleRuntime('c-1', '9415550123', 'tech_en_route', bad)).resolves.toBe(false);
    const badPrefs = stubKnex({ customers: { phone: '9415550123', account_id: null }, notification_prefs: new Error('db down') });
    await expect(_test.pushEligibleRuntime('c-1', '9415550123', 'tech_en_route', badPrefs)).resolves.toBe(false);
  });
});

describe('policy table hygiene', () => {
  it('never lists conversational or tokenized-link templates', () => {
    for (const t of ['manual', 'ai_assistant', 'review_request', 'payment_link', 'internal_alert']) {
      expect(PUSH_ROUTING_POLICY[t]).toBeUndefined();
    }
  });

  it('maps every policy type to a notification_prefs channel column', () => {
    // A saved customer channel choice must always be able to veto routing —
    // a policy type without a prefs mapping would silently skip that veto.
    for (const type of Object.keys(PUSH_ROUTING_POLICY)) {
      expect(typeof _test.PREF_CHANNEL_COLUMN[type]).toBe('string');
    }
  });

  it('normalizes phones to their last ten digits for the recipient-identity check', () => {
    expect(_test.normalizeDigits('+1 (941) 555-0123')).toBe('9415550123');
    expect(_test.normalizeDigits('19415550123')).toBe('9415550123');
    expect(_test.normalizeDigits('')).toBe('');
  });

  it('presentation titles carry no emoji and every policy type has a portal link', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const type of Object.keys(PUSH_ROUTING_POLICY)) {
      const p = _test.pushPresentation(type);
      expect(emoji.test(p.title)).toBe(false);
      expect(p.link.startsWith('/')).toBe(true);
    }
    const fallback = _test.pushPresentation('unknown_type');
    expect(fallback.title).toBe('Waves Pest Control');
    expect(fallback.link).toBe('/');
  });

  // Completion/report pushes open Documents (customer-wide) like the lifecycle
  // "Service completed" bell — never Visits, which is property-scoped and
  // fails closed for a house retired since the visit (uncapped codex r1z P1).
  it('completion and report pushes deep-link to Documents, not Visits', () => {
    for (const type of ['service_complete', 'service_complete_with_invoice', 'service_report_v1']) {
      const p = _test.pushPresentation(type);
      expect(p.link).toBe('/?tab=documents');
      expect(p.title).toBe('Your service report is ready');
    }
  });
});

// Pre-push audit P1 on #4843: invoice.js's withProviderHandoff transaction
// (threaded via preSendCheck.handoffTrx — send-customer-message.js's
// dispatchProvider) must be reused for EVERY db read/write on the billing
// leg of attemptPushFirst, never a second root-pool connection, or two
// concurrent App invoice sends can deadlock the DB_POOL_MAX=2 pool.
describe('attemptPushFirst billing-leg handoff transaction reuse', () => {
  // Minimal chainable knex query-builder stub. `config` may set `first` and/or
  // `returning` results.
  function makeQuery(config = {}) {
    const q = {};
    for (const method of ['where', 'whereIn', 'whereNull', 'whereRaw', 'forUpdate', 'insert', 'update']) {
      q[method] = jest.fn(() => q);
    }
    q.first = jest.fn(async () => config.first);
    q.returning = jest.fn(async () => config.returning || []);
    q.then = (resolve, reject) => Promise.resolve(1).then(resolve, reject);
    q.catch = (reject) => Promise.resolve(1).catch(reject);
    return q;
  }

  // Keyed-by-table connection stub. `responses[table]` may be a static config
  // object or a function of the per-table call count (sms_log is hit twice:
  // the proof-row insert, then the metadata patch).
  function makeConnStub(responses) {
    const callsByTable = {};
    const conn = jest.fn((table) => {
      callsByTable[table] = (callsByTable[table] || 0) + 1;
      const config = typeof responses[table] === 'function'
        ? responses[table](callsByTable[table])
        : (responses[table] || {});
      return makeQuery(config);
    });
    conn.callsByTable = callsByTable;
    return conn;
  }

  const ORIGINAL_GATE = process.env.GATE_CUSTOMER_APP_NOTIFICATIONS;

  beforeEach(() => {
    jest.clearAllMocks();
    // Any un-stubbed root-pool call fails loudly — the point of this suite.
    mockRootDb.mockImplementation(() => { throw new Error('root pool must not be used on the billing leg'); });
    process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = 'true';
    mockCustomerStatus.mockResolvedValue({ enabled: true, fresh: true });
    mockResolveForInvoice.mockResolvedValue({ payerId: null });
    mockNotifyCustomer.mockResolvedValue({ id: 'notif-1', push: { accepted: 1 } });
  });

  afterAll(() => {
    if (ORIGINAL_GATE === undefined) delete process.env.GATE_CUSTOMER_APP_NOTIFICATIONS;
    else process.env.GATE_CUSTOMER_APP_NOTIFICATIONS = ORIGINAL_GATE;
  });

  it('with a handoff trx present, every billing-leg read/write uses it and the root db is never touched', async () => {
    const conn = makeConnStub({
      customers: { first: { phone: null, account_id: null } },
      notification_prefs: { first: { invoice_channels: ['push'] } },
      invoices: { first: { token: 'tok-1', status: 'sent', scheduled_service_id: 'svc-1' } },
      sms_log: (n) => (n === 1 ? { returning: [{ id: 'row-1' }] } : {}),
    });
    const preSendCheck = () => true;
    preSendCheck.handoffTrx = conn;

    const result = await attemptPushFirst({
      customerId: 'cust-1',
      to: null,
      body: 'Your invoice is ready.',
      messageType: 'invoice',
      fromNumber: '+19415550100',
      preSendCheck,
      explicitPushOnly: true,
      invoiceId: 'inv-1',
      billingDeliveryCategory: 'invoice',
    });

    expect(result).toMatchObject({ delivered: true, deliveryOutcome: 'accepted' });

    // Every read/write attemptPushFirst issues on this leg went through the
    // handoff trx, never the root pool.
    expect(conn.callsByTable.customers).toBe(1);
    expect(conn.callsByTable.notification_prefs).toBe(1);
    expect(conn.callsByTable.invoices).toBe(1);
    expect(conn.callsByTable.sms_log).toBe(2); // proof-row insert + metadata patch
    expect(mockRootDb).not.toHaveBeenCalled();

    // hasFreshPushDevice's customer-status read and the invoice's payer
    // resolution both received the SAME handoff connection, not a default.
    expect(mockCustomerStatus).toHaveBeenCalledWith('cust-1', conn);
    expect(mockResolveForInvoice).toHaveBeenCalledWith(expect.objectContaining({ database: conn, customerId: 'cust-1' }));
  });

  it('non-billing push (no billingDeliveryCategory) keeps using the root pool exactly as today', async () => {
    // No billingDeliveryCategory ⇒ `conn` resolves to the root `db`, even
    // though a handoff trx is present on preSendCheck — the ternary in
    // attemptPushFirst gates on billingDeliveryCategory first, so a
    // non-billing push must never receive the fake trx.
    const rootCallsByTable = {};
    mockRootDb.mockImplementation((table) => {
      rootCallsByTable[table] = (rootCallsByTable[table] || 0) + 1;
      if (table === 'customers') return makeQuery({ first: { phone: '9415550123', account_id: null } });
      if (table === 'notification_prefs') return makeQuery({ first: { payment_receipt_channel: 'push' } });
      throw new Error(`unexpected root-pool table in this scenario: ${table}`);
    });
    const conn = makeConnStub({});
    const preSendCheck = () => true;
    preSendCheck.handoffTrx = conn;
    mockCustomerStatus.mockResolvedValue({ enabled: true, fresh: false }); // no fresh device ⇒ falls back to SMS

    const result = await attemptPushFirst({
      customerId: 'cust-1',
      to: '9415550123',
      body: 'Here is your receipt.',
      messageType: 'receipt',
      fromNumber: '+19415550100',
      preSendCheck,
      explicitPushOnly: false,
    });

    expect(result).toMatchObject({ delivered: false, reason: 'no_fresh_device' });
    expect(rootCallsByTable.customers).toBe(1);
    expect(rootCallsByTable.notification_prefs).toBe(1);
    // customerStatus received the root db, not the fake trx.
    expect(mockCustomerStatus).toHaveBeenCalledWith('cust-1', mockRootDb);
    // The handoff trx sitting on preSendCheck was never reached at all.
    expect(conn).not.toHaveBeenCalled();
  });
});
