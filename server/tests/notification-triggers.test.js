jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })),
}));
jest.mock('../services/push-notifications', () => ({
  sendToAdminUsers: jest.fn(async () => ({ subscriptions: 0, sent: 0, expired: 0, failed: 0, skipped: 0, results: [] })),
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

  test('non-SMS triggers keep collapsing by trigger key', () => {
    expect(__private.pushTagFor('payment_failed', {})).toBe('waves-payment_failed');
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

  test('reports bellWritten true when the insert succeeds', async () => {
    const result = await triggerNotification('twilio_failure', { channel: 'sms' });

    expect(result.bellWritten).toBe(true);
  });
});
