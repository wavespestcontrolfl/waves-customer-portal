jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })),
}));
jest.mock('../services/push-notifications', () => ({
  sendToAdminUsers: jest.fn(async () => ({ subscriptions: 0, sent: 0, expired: 0, failed: 0, skipped: 0, results: [] })),
}));
jest.mock('../services/admin-unread', () => ({
  getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })),
}));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { TRIGGER_REGISTRY, __private, triggerNotification } = require('../services/notification-triggers');

function tableMock(rows) {
  const chain = {
    where: jest.fn(() => chain),
    select: jest.fn(() => Promise.resolve(rows)),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

describe('notification trigger push tags', () => {
  test('SMS replies get unique tags so iOS does not silently replace prior alerts', () => {
    const payload = { threadId: 'customer-123', fromPhone: '+19415551234' };

    const first = __private.pushTagFor('sms_reply', payload);
    const second = __private.pushTagFor('sms_reply', payload);

    expect(first).toMatch(/^waves-sms_reply-customer-123-/);
    expect(second).toMatch(/^waves-sms_reply-customer-123-/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(payload.fromPhone);
    expect(second).not.toContain(payload.fromPhone);
  });

  test('tracking SMS leads have a per-message tag while ordinary leads retain their tag', () => {
    const first = __private.pushTagFor('new_lead', { twilioSid: 'SM-synthetic-first' });
    const second = __private.pushTagFor('new_lead', { twilioSid: 'SM-synthetic-second' });
    expect(first).toBe('waves-new_lead-SM-synthetic-first');
    expect(second).not.toBe(first);
    expect(__private.pushTagFor('new_lead', {})).toBe('waves-new_lead');
  });

  test('non-SMS triggers keep collapsing by trigger key', () => {
    expect(__private.pushTagFor('payment_failed', {})).toBe('waves-payment_failed');
  });

  it('customer_landline_from_call gets a per-customer push tag so concurrent alerts do not collapse', () => {
    const a = __private.pushTagFor('customer_landline_from_call', { customerId: 'cust-a' });
    const b = __private.pushTagFor('customer_landline_from_call', { customerId: 'cust-b' });
    expect(a).toBe('waves-customer_landline_from_call-cust-a');
    expect(b).toBe('waves-customer_landline_from_call-cust-b');
    expect(a).not.toBe(b);
    expect(__private.pushTagFor('customer_landline_from_call', {})).toBe('waves-customer_landline_from_call-unknown-customer');
  });

  test('bill payment error trigger highlights ACH checkout failures', () => {
    const built = TRIGGER_REGISTRY.bill_payment_error.build({
      invoiceId: 'inv_123',
      invoiceNumber: 'WPC-2026-0100',
      customerName: 'Virginia Demo',
      methodLabel: 'Bank account',
      phaseLabel: 'Stripe confirmation',
      reason: 'Bank account could not be verified',
    });

    expect(built.title).toBe('Bank payment error');
    expect(built.body).toBe('Invoice WPC-2026-0100 - Virginia Demo - Bank account during Stripe confirmation: Bank account could not be verified');
    expect(built.link).toBe('/admin/invoices?invoice=inv_123');
  });

  test('new lead trigger can carry tracking number context', () => {
    const built = TRIGGER_REGISTRY.new_lead.build({
      title: 'New lead from palmettoexterminator.com',
      name: 'Unknown prospect',
      source: 'palmettoexterminator.com',
      area: 'Palmetto',
      phone: '+18182079399',
      message: 'Cynthia Sparagna 1000 Riverside Drive',
      leadId: 'lead-123',
    });

    expect(built.title).toBe('New lead from palmettoexterminator.com');
    expect(built.body).toContain('Unknown prospect via palmettoexterminator.com (Palmetto)');
    expect(built.body).toContain('Phone: ***9399');
    expect(built.body).toContain('Message included on lead record');
    expect(built.body).not.toContain('+18182079399');
    expect(built.body).not.toContain('1000 Riverside Drive');
    expect(built.link).toBe('/admin/leads?lead=lead-123');
  });

  test('new lead trigger without a lead record points at the SMS inbox', () => {
    // Tracking-line texts from unknown numbers no longer mint a customer
    // row (twilio-webhook.js domain/van branch), so the bell must not send
    // the owner to a lead that does not exist.
    const built = TRIGGER_REGISTRY.new_lead.build({
      title: 'New text from wavespestcontrol.com',
      name: 'Unknown sender',
      source: 'wavespestcontrol.com',
      area: 'Bradenton',
      phone: '+12025550101',
      message: 'Please quote service for the garden shed.',
      link: '/admin/communications',
    });

    expect(built.title).toBe('New text from wavespestcontrol.com');
    expect(built.body).toContain('Unknown sender via wavespestcontrol.com (Bradenton)');
    expect(built.body).toContain('Message in the SMS inbox');
    expect(built.body).not.toContain('swimming pool');
    expect(built.link).toBe('/admin/communications');
  });

  test('SMS reply trigger masks fallback phone and redacts sensitive message text', () => {
    const built = TRIGGER_REGISTRY.sms_reply.build({
      fromPhone: '+19415551234',
      message: 'Call me at +19415551234 or test@example.com near 1000 Riverside Drive',
      threadId: 'customer-123',
    });

    expect(built.title).toBe('SMS from ***1234');
    expect(built.body).toContain('***1234');
    expect(built.body).toContain('t***@example.com');
    expect(built.body).toContain('[address]');
    expect(built.body).not.toContain('+19415551234');
    expect(built.body).not.toContain('test@example.com');
    expect(built.body).not.toContain('1000 Riverside Drive');
    expect(built.link).toBe('/admin/communications?thread=customer-123');
  });

  test('KB audit trigger summarizes flagged entries for the admin bell', () => {
    const built = TRIGGER_REGISTRY.kb_audit_flagged.build({
      count: 2,
      entries: [
        { title: 'Rodent Service Phases', summary: 'Correct the RUP claim.' },
        { title: 'SEO Strategy', summary: 'Address the doorway-page risk.' },
      ],
    });

    expect(built.title).toBe('KB audit flagged 2 entries');
    expect(built.body).toContain('Rodent Service Phases: Correct the RUP claim.');
    expect(built.body).toContain('SEO Strategy: Address the doorway-page risk.');
    expect(built.link).toBe('/admin/kb');
  });

  test('legacy internal admin SMS redirects have a generic notification trigger', () => {
    const built = TRIGGER_REGISTRY.internal_admin_alert.build({
      title: 'Tax Deadline Alert',
      body: 'Two filings need review.',
      link: '/admin/tax',
    });

    expect(built).toEqual({
      title: 'Tax Deadline Alert',
      body: 'Two filings need review.',
      link: '/admin/tax',
    });
  });

  test('bundle quote trigger distinguishes inquiry from self-applied bundle', () => {
    const inquiry = TRIGGER_REGISTRY.bundle_quote_requested.build({
      customerName: 'Existing Appointment Demo',
      suggestedService: 'Lawn Care',
      previousTier: 'Bronze',
      estimateId: 'estimate-123',
    });

    expect(inquiry).toEqual({
      title: 'Bundle inquiry: Existing Appointment Demo',
      body: 'Interested in adding Lawn Care to Bronze plan',
      link: '/admin/estimates?estimateId=estimate-123',
    });

    const selfApplied = TRIGGER_REGISTRY.bundle_quote_requested.build({
      customerName: 'Existing Appointment Demo',
      suggestedService: 'Lawn Care',
      bundled: true,
      newTier: 'Silver',
      newMonthly: 112.5,
      estimateId: 'estimate-123',
    });

    expect(selfApplied).toEqual({
      title: 'Bundle self-applied: Existing Appointment Demo',
      body: 'Added Lawn Care \u2192 Silver @ $112.50/mo',
      link: '/admin/estimates?estimateId=estimate-123',
    });

    // When the customer is known, deep-link to the Customer 360 requests panel \u2014
    // that's the only surface where staff can mark the add-on request handled now
    // that /admin/requests is gone.
    const withCustomer = TRIGGER_REGISTRY.bundle_quote_requested.build({
      customerName: 'Existing Appointment Demo',
      suggestedService: 'Lawn Care',
      previousTier: 'Bronze',
      estimateId: 'estimate-123',
      customerId: 'cust-789',
    });
    expect(withCustomer.link).toBe('/admin/customers?customerId=cust-789');
  });

  test('notification body sanitizer redacts customer contact details across triggers', () => {
    const built = __private.sanitizeBuiltNotification({
      title: 'Admin alert for test@example.com',
      body: 'Text +19415551234 about 1000 Riverside Drive',
      link: '/admin/dashboard',
    });

    expect(built.title).toBe('Admin alert for t***@example.com');
    expect(built.body).toBe('Text ***1234 about [address]');
    expect(built.link).toBe('/admin/dashboard');
  });

  test('phone redaction leaves digit runs inside identifiers alone', () => {
    // payment_failed: any non-exempt trigger — twilio_failure is
    // allowContactDetails (owner ruling 2026-07-30) and skips redaction.
    const safe = __private.sanitizeNotificationPayload('payment_failed', {
      // Hashed dedupe keys and hex digests contain 10+ digit runs ~3% of the
      // time; masking them corrupted the stored key so dedupe never matched.
      dedupeKey: 'twilio:1a2345678901bcde',
      requestId: 'req-1234567890abcdef',
      message: 'twilio:1234567890abcdef retry +19415551234 later',
    });

    expect(safe.dedupeKey).toBe('twilio:1a2345678901bcde');
    expect(safe.requestId).toBe('req-1234567890abcdef');
    // Digit run glued to hex tail is preserved; the real phone still masks.
    expect(safe.message).toBe('twilio:1234567890abcdef retry ***1234 later');
  });

  test('phone redaction masks extension-suffixed numbers by the PHONE last four', () => {
    const safe = __private.sanitizeNotificationPayload('payment_failed', {
      message: 'call +19415551234x123 or 19415552222 ext 99 today',
    });

    // The identifying suffix comes from the phone itself, never the
    // extension digits; the extension is consumed and dropped.
    expect(safe.message).toBe('call ***1234 or ***2222 today');
  });

  test('phone redaction still masks URL-encoded numbers', () => {
    const safe = __private.sanitizeNotificationPayload('payment_failed', {
      message: 'Lookup phone=%2B19415551212&Fields=caller_name failed',
    });

    expect(safe.message).toBe('Lookup phone=***1212&Fields=caller_name failed');
  });

  test('notification metadata payload sanitizer does not persist raw contact fields', () => {
    const safe = __private.sanitizeNotificationPayload('new_lead', {
      phone: '+18182079399',
      email: 'lead@example.com',
      address: '1000 Riverside Drive',
      message: 'Reach me at +18182079399 from 1000 Riverside Drive',
      nested: {
        body: 'Email lead@example.com',
      },
    });

    expect(safe).toEqual({
      phone: '***9399',
      email: 'l***@example.com',
      address: '[address]',
      message: 'Reach me at ***9399 from [address]',
      nested: {
        body: 'Email l***@example.com',
      },
    });
  });
});

describe('triggerNotification bell outcome', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => (
      table === 'technicians' ? tableMock([{ id: 'admin-1' }]) : tableMock([])
    ));
  });

  test('reports bellWritten false when the notification insert fails', async () => {
    // NotificationService.create catches insert errors and returns null —
    // callers deciding whether an alert was delivered must see the truth.
    NotificationService.notifyAdmin.mockResolvedValueOnce(null);

    const result = await triggerNotification('twilio_failure', { channel: 'sms' });

    expect(NotificationService.notifyAdmin).toHaveBeenCalled();
    expect(result.bellWritten).toBe(false);
  });

  test.each([
    ['sandy_provider_failure', 'AI call callback'],
    [undefined, 'Voicemail'],
  ])('callback title reflects the actual call source: %s', async (reason, label) => {
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'bell-fixture' });
    await triggerNotification('customer_voicemail_callback', { callLogId: 'call-fixture', reason });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('voicemail_callback', `${label} — Unknown caller`, expect.any(String), expect.any(Object));
  });

  test('relay callback ownership is checked by the bell transaction and a refused bell never pushes', async () => {
    const relayFailureCall = { callSid: 'CA-fixture', owner: 'owner-fixture' };
    NotificationService.notifyAdmin.mockResolvedValueOnce({ suppressed: true });
    const result = await triggerNotification('customer_voicemail_callback', { callLogId: 'call-fixture', phone: '+19415551234' }, { relayFailureCall });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('voicemail_callback', expect.any(String), expect.any(String), expect.objectContaining({ relayFailureCall, dedupeKey: 'relay-failure:CA-fixture' }));
    expect(result.bellWritten).toBe(false);
    expect(require('../services/push-notifications').sendToAdminUsers).not.toHaveBeenCalled();
  });

  test('reports the committed bell before slow push delivery completes', async () => {
    let completePush;
    const push = new Promise((resolve) => { completePush = resolve; });
    require('../services/push-notifications').sendToAdminUsers.mockReturnValueOnce(push);
    let committed;
    const bell = new Promise((resolve) => { committed = resolve; });
    let finished = false;
    const delivery = triggerNotification('customer_voicemail_callback', { callLogId: 'call-fixture' }, {
      relayFailureCall: { callSid: 'CA-fixture', owner: 'owner-fixture' }, onBell: committed,
    }).then((result) => { finished = true; return result; });
    expect(await bell).toBe(true);
    expect(finished).toBe(false);
    completePush({ sent: 1 });
    expect((await delivery).bellWritten).toBe(true);
  });

  test('reports bellWritten true when the insert succeeds', async () => {
    const result = await triggerNotification('twilio_failure', { channel: 'sms' });

    expect(result.bellWritten).toBe(true);
  });

  test('resumable events use the canonical bell identity and retain the push handoff check', async () => {
    const beforePush = jest.fn(async () => false);
    const result = await triggerNotification('twilio_failure', { channel: 'sms' }, {
      dedupeKey: 'fixture_completion_record', beforePush,
    });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String),
      expect.objectContaining({ dedupeKey: 'fixture_completion_record' }));
    expect(result).toMatchObject({ bellWritten: true, retryable: false });
    expect(beforePush).toHaveBeenCalled();
    expect(require('../services/push-notifications').sendToAdminUsers).not.toHaveBeenCalled();
  });

  test('a failed durable bell stays retryable for a resumed event', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce(null);
    expect(await triggerNotification('twilio_failure', {}, { dedupeKey: 'fixture_completion_record' }))
      .toMatchObject({ bellWritten: false, retryable: true });
  });

  test('the durable push check runs after badge work and immediately before sending', async () => {
    const order = [];
    db.mockImplementation((table) => tableMock(table === 'technicians' ? [{ id: 'admin-1', role: 'admin' }] : []));
    require('../services/admin-unread').getUnreadCountForAdmin.mockImplementationOnce(async () => {
      order.push('badge');
      return { count: 0, at: Date.now() };
    });
    require('../services/push-notifications').sendToAdminUsers.mockImplementationOnce(async (_ids, _build, { beforeDispatch }) => {
      order.push('lookup');
      await beforeDispatch();
      order.push('send');
      return { sent: 1 };
    });
    await triggerNotification('job_complete', {}, { beforePush: async ({ dispatching }) => {
      order.push(dispatching ? 'claim' : 'eligibility');
      return true;
    } });
    expect(order).toEqual(['eligibility', 'badge', 'lookup', 'claim', 'send']);
  });

  test('a push claim refused after the subscription lookup reads as superseded', async () => {
    db.mockImplementation((table) => tableMock(table === 'technicians' ? [{ id: 'admin-1', role: 'admin' }] : []));
    require('../services/push-notifications').sendToAdminUsers.mockImplementationOnce(async (_ids, _build, { beforeDispatch }) => (
      (await beforeDispatch()) === false ? { subscriptions: 1, sent: 0, superseded: true } : { sent: 1 }));
    const result = await triggerNotification('job_complete', {}, {
      dedupeKey: 'fixture_completion_record', beforePush: async ({ dispatching }) => !dispatching,
    });
    expect(result.push).toEqual({ sent: 0, skipped: 'superseded_before_push' });
    expect(result.retryable).toBe(false);
  });

  test('a push lookup failure keeps a resumed event retryable without taking the claim', async () => {
    db.mockImplementation((table) => tableMock(table === 'technicians' ? [{ id: 'admin-1', role: 'admin' }] : []));
    require('../services/push-notifications').sendToAdminUsers.mockRejectedValueOnce(new Error('Synthetic subscription lookup outage'));
    const claim = jest.fn(async () => true);
    const result = await triggerNotification('job_complete', {}, {
      dedupeKey: 'fixture_completion_record', beforePush: ({ dispatching }) => (dispatching ? claim() : true),
    });
    expect(claim).not.toHaveBeenCalled();
    expect(result).toMatchObject({ push: null, retryable: true, error: 'Synthetic subscription lookup outage' });
  });

  test('an intentionally suppressed durable bell is not a retryable failure', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce({ suppressed: true });
    expect(await triggerNotification('twilio_failure', {}, { dedupeKey: 'fixture_completion_record' }))
      .toMatchObject({ bellWritten: false, retryable: false });
  });

  test('a resumed event retries an unavailable recipient lookup without dispatching', async () => {
    db.mockImplementation((table) => {
      if (table === 'technicians') throw new Error('Synthetic recipient lookup outage');
      return tableMock([]);
    });
    expect(await triggerNotification('twilio_failure', {}, { dedupeKey: 'fixture_completion_record' }))
      .toMatchObject({ bellWritten: false, retryable: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(require('../services/push-notifications').sendToAdminUsers).not.toHaveBeenCalled();
  });
});

describe('triggerNotification preference lookup failure', () => {
  const { sendToAdminUsers } = require('../services/push-notifications');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('fails CLOSED — a thrown prefs query delivers to nobody instead of treating everyone as opted in', async () => {
    db.mockImplementation((table) => {
      if (table === 'notification_preferences') {
        return { where: jest.fn(() => Promise.reject(new Error('relation does not exist'))) };
      }
      return table === 'technicians' ? tableMock([{ id: 'admin-1' }]) : tableMock([]);
    });

    const result = await triggerNotification('twilio_failure', { channel: 'sms' });

    expect(result).toEqual({ bellWritten: false, push: null, prefsUnavailable: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(sendToAdminUsers).not.toHaveBeenCalled();
  });
});

describe('push follows the bell policy (owner ruling 2026-08-28)', () => {
  const db = require('../models/db');
  beforeEach(() => {
    db.mockImplementation((table) => (
      table === 'technicians' ? tableMock([{ id: 'admin-1' }]) : tableMock([])
    ));
  });
  test('an event the bell policy silences neither bells nor pushes — even for a push-only admin', async () => {
    const NotificationService = require('../services/notification-service');
    const PushService = require('../services/push-notifications');
    const bellPolicy = require('../services/notification-bell-policy');
    const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
    const allowSpy = jest.spyOn(bellPolicy, 'bellAllowed').mockResolvedValue(false);
    // bell off / push on for the only admin: the pre-fix bypass case.
    db.mockImplementation((table) => (
      table === 'technicians' ? tableMock([{ id: 'admin-1' }])
        : table === 'notification_preferences' ? tableMock([{ admin_user_id: 'admin-1', bell_enabled: false, push_enabled: true }])
          : tableMock([])
    ));
    NotificationService.notifyAdmin.mockClear();
    PushService.sendToAdminUsers.mockClear();
    const stats = await triggerNotification('dashboard_alert', { title: 'x', body: 'y' });
    expect(stats.policySilenced).toBe(true);
    expect(stats.push).toEqual({ sent: 0, skipped: 'bell_policy' });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    gateSpy.mockRestore(); allowSpy.mockRestore();
  });

  // codex review, PR #4341 r1 P1: customer_landline_from_call's category
  // ('alert') default-denies under the gated policy — it must instead ring
  // via its own DEFAULT_ON_CATEGORIES membership (notification-bell-policy.js),
  // same treatment as estimate_change_request. Real bellAllowed/
  // loadCategoryOverrides run (not mocked) so this proves the actual
  // allowlist wiring, not just an assertion about the registry's category.
  test('customer_landline_from_call rings under the gated bell policy with no owner override (DEFAULT_ON category)', async () => {
    const NotificationService = require('../services/notification-service');
    const bellPolicy = require('../services/notification-bell-policy');
    bellPolicy.clearOverrideCache();
    const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
    // notification_preferences serves two different shapes here: the plain
    // per-trigger prefs lookup (`.where(...)`, awaited directly) and
    // loadCategoryOverrides' join/select — empty rows either way, i.e. no
    // admin has ever saved an override for this trigger or category.
    const prefsChain = {
      where: jest.fn(() => prefsChain),
      join: jest.fn(() => prefsChain),
      select: jest.fn(() => Promise.resolve([])),
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    db.mockImplementation((table) => (
      table === 'technicians' ? tableMock([{ id: 'admin-1', role: 'admin' }])
        : table === 'notification_preferences' ? prefsChain
          : tableMock([])
    ));
    NotificationService.notifyAdmin.mockClear();

    const stats = await triggerNotification('customer_landline_from_call', {
      customerId: 'cust-1', name: 'Pat Landline', phone: '+19415550202',
    });

    expect(stats.policySilenced).toBeUndefined();
    expect(stats.bellWritten).toBe(true);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'customer_landline_from_call',
      expect.stringContaining('Pat Landline'),
      expect.any(String),
      expect.any(Object)
    );
    gateSpy.mockRestore();
    bellPolicy.clearOverrideCache();
  });
});
