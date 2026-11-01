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
    // per-attempt when the webhook passes the identity (codex P2 on #4392)
    expect(__private.pushTagFor('payment_failed', { paymentIntentId: 'pi_1', attemptId: 'ch_9' })).toBe('waves-payment_failed-ch_9');
    expect(__private.pushTagFor('payment_failed', { paymentIntentId: 'pi_1' })).toBe('waves-payment_failed-pi_1');
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

  test('SMS reply trigger leads with a lead\'s CALL / TEXT choice and is unchanged without it', () => {
    const base = { fromName: 'Dana Example', message: 'Call', threadId: 'customer-123', twilioSid: 'SM1' };
    const call = TRIGGER_REGISTRY.sms_reply.build({ ...base, leadPreference: 'call', textCount: 1 });
    const text = TRIGGER_REGISTRY.sms_reply.build({ ...base, leadPreference: 'text', textCount: 2 });
    const plain = TRIGGER_REGISTRY.sms_reply.build({ ...base, textCount: 1 });
    const plainMany = TRIGGER_REGISTRY.sms_reply.build({ ...base, textCount: 3 });
    expect(call.title).toBe('Wants a call: Dana Example');
    expect(text.title).toBe('Prefers text: Dana Example (2 texts)');
    expect(plain.title).toBe('SMS from Dana Example');
    expect(plainMany.title).toBe('3 texts from Dana Example');
    // Body and link are identical with or without the preference.
    expect(call.body).toBe(plain.body);
    expect(call.link).toBe(plain.link);
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

  test('job complete bell opens that visit on its day (the dispatch page reads appointment + date, not service)', () => {
    const base = { techName: 'Adam', serviceName: 'Pest Control', customerName: 'Pat Demo' };
    expect(TRIGGER_REGISTRY.job_complete.build({ ...base, serviceId: 'svc-1', serviceDate: '2026-10-28' }).link)
      .toBe('/admin/dispatch?tab=schedule&date=2026-10-28&appointment=svc-1');
    // No date: the page cannot find the visit, so fall back to the plain schedule.
    expect(TRIGGER_REGISTRY.job_complete.build({ ...base, serviceId: 'svc-1' }).link).toBe('/admin/schedule');
    expect(TRIGGER_REGISTRY.job_complete.build(base).link).toBe('/admin/schedule');
  });

  test('SEO sync failure links to the Advisor view the SEO page reads', () => {
    const built = TRIGGER_REGISTRY.seo_sync_failed.build({ source: 'GSC', reason: 'quota' });
    expect(built.link).toBe('/admin/seo?workspace=command&view=advisor');
  });

  test('newsletter notices open History and no longer point at the removed composer', () => {
    // Owner 2026-10-30: the weekly issue is autonomous; there is no Compose tab.
    const draft = TRIGGER_REGISTRY.newsletter_autopilot_draft.build({ subject: 'Weekly', eventCount: 6 });
    expect(draft.link).toBe('/admin/newsletter?tab=history');
    expect(draft.body).toMatch(/It is in Newsletter → History\.$/);
    expect(draft.body).not.toMatch(/send when ready/i);
    expect(TRIGGER_REGISTRY.newsletter_proof_sent.build({ sendId: 'send-7', subject: 'x', recipient: 'r', recipientCount: 1 }).link).toBe('/admin/newsletter?tab=history');
    const blocked = TRIGGER_REGISTRY.newsletter_proof_blocked.build({ sendId: 'send-7', subject: 'x', errors: ['e'] });
    expect(blocked.link).toBe('/admin/newsletter?tab=history');
    expect(blocked.body).toMatch(/Nothing was sent\.$/);
    expect(blocked.body).not.toMatch(/composer/i);
    expect(TRIGGER_REGISTRY.newsletter_send_not_dispatched).toBeUndefined();
    expect(TRIGGER_REGISTRY.pest_insider_draft).toBeUndefined();
    for (const type of Object.keys(TRIGGER_REGISTRY).filter((t) => t.startsWith('newsletter_'))) {
      expect(TRIGGER_REGISTRY[type].build({ sendId: 'send-7' }).link).not.toMatch(/tab=compose/);
    }
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

  test('KB audit trigger names where a generated entry is fixed', () => {
    const built = TRIGGER_REGISTRY.kb_audit_flagged.build({
      count: 1,
      entries: [{ title: 'Sample SC', summary: 'Formulation missing.', fixLabel: 'Products catalog' }],
    });

    expect(built.body).toBe('Sample SC (fix in Products catalog): Formulation missing.');
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

  test('promise-chaser copy always states when the caller called — dispatched only by the durable sweep, after the call already ended', () => {
    const built = TRIGGER_REGISTRY.promise_chaser.build({
      name: 'Fixture Lead', what: 'callback', when: 'Sep 26, 2:00 PM', calledAtLabel: '4:15 PM',
    });
    expect(built.body).toBe('Fixture Lead called at 4:15 PM. We still owe them a callback promised Sep 26, 2:00 PM.');
    expect(built.body).not.toContain('calling in now');
  });

  test('promise-chaser headline leads with the caller name; with no name it leads with the formatted number (owner 2026-10-21)', () => {
    const named = TRIGGER_REGISTRY.promise_chaser.build({
      name: 'Martin Fixtureson', phone: '+19415550199', what: 'quote', when: 'Oct 19, 3:50 PM', calledAtLabel: '12:31 PM',
    });
    expect(named.title).toBe('Martin Fixtureson called back — we still owe a quote');
    const unnamed = TRIGGER_REGISTRY.promise_chaser.build({
      name: null, phone: '+19415550199', what: 'quote', when: 'Oct 19, 3:50 PM', calledAtLabel: '12:31 PM',
    });
    expect(unnamed.title).toBe('(941) 555-0199 called back — we still owe a quote');
    expect(unnamed.body).toBe('+19415550199 called at 12:31 PM. We still owe them a quote promised Oct 19, 3:50 PM.');
    expect(TRIGGER_REGISTRY.promise_chaser.build({ what: 'callback' }).title).toBe('A lead called back — we still owe a callback');
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

  test('GATE_PORTAL_ITEM_CLOSE: the add-service bell carries its request id and customer on top of its metadata; off, or with no request row, the build is exactly as before', () => {
    const payload = { customerName: 'Pat Fixture', suggestedService: 'Mosquito', previousTier: 'Bronze', customerId: 'cust-789', requestId: 'req-456' };
    try {
      delete process.env.GATE_PORTAL_ITEM_CLOSE;
      expect(TRIGGER_REGISTRY.bundle_quote_requested.build(payload)).not.toHaveProperty('alert');
      process.env.GATE_PORTAL_ITEM_CLOSE = 'true';
      expect(TRIGGER_REGISTRY.bundle_quote_requested.build(payload).alert).toEqual({ requestId: 'req-456', customerId: 'cust-789' });
      // a self-applied bundle has no request row; a request with no customer cannot be judged
      expect(TRIGGER_REGISTRY.bundle_quote_requested.build({ ...payload, requestId: undefined })).not.toHaveProperty('alert');
      expect(TRIGGER_REGISTRY.bundle_quote_requested.build({ ...payload, customerId: undefined })).not.toHaveProperty('alert');
    } finally {
      delete process.env.GATE_PORTAL_ITEM_CLOSE;
    }
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

  test('address redaction never starts at a clock time: the time stays, the street goes', () => {
    const at = (body) => __private.sanitizeBuiltNotification({ title: 't', body, link: '/admin' }).body;
    expect(at('Monday, Nov 2 at 8:00 AM at 421 Spring Ave')).toBe('Monday, Nov 2 at 8:00 AM at [address]');
    expect(at('Visit 8 AM at 421 Spring Ave')).toBe('Visit 8 AM at [address]');
    expect(at('Tue 10:30 am, 12 Oak Dr')).toBe('Tue 10:30 am, [address]');
    expect(at('Address:421 Spring Ave')).toBe('Address:[address]');
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

  test('id lists pass verbatim: a UUID with a phone-like digit tail is never masked', () => {
    const tailUuid = '14f3d827-0191-4701-8123-295768912345';
    const safe = __private.sanitizeNotificationPayload('payment_failed', {
      allocationInvoiceIds: [tailUuid, '22222222-2222-4222-8222-222222222222'],
      event_ids: [tailUuid],
      message: 'retry +19415551234 later',
    });
    expect(safe.allocationInvoiceIds).toEqual([tailUuid, '22222222-2222-4222-8222-222222222222']);
    expect(safe.event_ids).toEqual([tailUuid]);
    expect(safe.message).toBe('retry ***1234 later');
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

  test('pushOnly re-sends the push without writing a second bell row (missed-call push retry)', async () => {
    const PushService = require('../services/push-notifications');
    PushService.sendToAdminUsers.mockClear();
    const stats = await triggerNotification('customer_missed_call', { customerId: null, name: 'Test Caller', phone: '+19415550100', callLogId: 'call-1' },
      { pushOnly: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(stats.bellWritten).toBe(false);
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    expect(PushService.sendToAdminUsers.mock.calls[0][1]('admin-1').tag).toBe('waves-customer_missed_call-call-1');
    // Without the option the same call writes its bell as before.
    await triggerNotification('customer_missed_call', { customerId: null, name: 'Test Caller', phone: '+19415550100', callLogId: 'call-1' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a keyed SMS replay reuses its committed bell and does not push again', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'committed-bell', deduped: true });
    expect(await triggerNotification('sms_reply', { twilioSid: 'SM-synthetic-replay' },
      { dedupeKey: 'sms-reply:SM-synthetic-replay' })).toMatchObject({ bellWritten: true, deduped: true, push: null });
    expect(require('../services/push-notifications').sendToAdminUsers).not.toHaveBeenCalled();
  });

  // One bell row per conversation (owner 2026-10-01): a known sender's next text
  // rewrites the standing thread row. That is a NEW message, so its push goes.
  test('a thread row refreshed by a new text still pushes, and asks notifyAdmin to refresh and bump it', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'thread-row', deduped: true, refreshed: true, rung: true });
    const PushService = require('../services/push-notifications');
    PushService.sendToAdminUsers.mockClear();
    const stats = await triggerNotification('sms_reply', { threadId: 'cust-1', twilioSid: 'SM-2', message: 'Second text', textCount: 2 },
      { dedupeKey: 'sms-thread:cust-1', refreshOnDedupe: true, bumpOnRefresh: true });
    expect(stats.bellWritten).toBe(true);
    expect(stats.deduped).toBeUndefined();
    const [, title, body, opts] = NotificationService.notifyAdmin.mock.calls.at(-1);
    expect(title).toBe('2 texts from unknown');
    expect(body).toBe('Second text');
    expect(opts).toMatchObject({ dedupeKey: 'sms-thread:cust-1', refreshOnDedupe: true, bumpOnRefresh: true, link: '/admin/communications?thread=cust-1&message=SM-2' });
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
  });

  test('refreshPayload becomes a lock-time standingRefresh: an older message keeps the row content, a newer one rebuilds it with the new count', async () => {
    const payload = { threadId: 'cust-1', fromName: 'Dana Example', twilioSid: 'SM-new', message: 'Newer text', textCount: 1 };
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'thread-row', deduped: true, refreshed: true });
    await triggerNotification('sms_reply', payload, {
      dedupeKey: 'sms-thread:cust-1', refreshOnDedupe: true, bumpOnRefresh: true,
      refreshPayload: (_row, base) => ({ payload: { textCount: base.textCount + 1 }, keepContent: base.twilioSid === 'SM-held' }),
    });
    const { standingRefresh } = NotificationService.notifyAdmin.mock.calls.at(-1)[3];
    const row = { body: 'Held text', link: '/admin/communications?thread=cust-1&message=SM-held', detail: null };
    const kept = await standingRefresh(row, { payload: { threadId: 'cust-1', fromName: 'Dana Example', twilioSid: 'SM-held', textCount: 2 } });
    expect(kept).toMatchObject({ title: '3 texts from Dana Example', body: 'Held text', link: row.link, quiet: true });
    expect(kept.metadata.payload).toMatchObject({ twilioSid: 'SM-held', textCount: 3 });
    const took = await standingRefresh(row, { payload: { twilioSid: 'SM-older', textCount: 2 } });
    expect(took).toMatchObject({ title: '3 texts from Dana Example', body: 'Newer text', link: '/admin/communications?thread=cust-1&message=SM-new' });
    expect(took.quiet).toBeUndefined();
    expect(took.metadata.payload).toMatchObject({ twilioSid: 'SM-new', textCount: 3 });
  });

  // The bell title always matches the text the row displays: a label belongs to ONE text,
  // the next newer text replaces it, an older late text cannot move it.
  describe('lead CALL / TEXT label on a standing thread row', () => {
    const ring = async (payload, keepOlder) => {
      NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'thread-row', deduped: true, refreshed: true });
      await triggerNotification('sms_reply', { threadId: 'cust-1', fromName: 'Dana Example', message: 'x', textCount: 1, ...payload }, {
        dedupeKey: 'sms-thread:cust-1', refreshOnDedupe: true, bumpOnRefresh: true,
        refreshPayload: (_row, base) => ({ payload: { textCount: base.textCount + 1 }, keepContent: keepOlder }),
      });
      return NotificationService.notifyAdmin.mock.calls.at(-1)[3].standingRefresh;
    };
    const row = { body: 'Held text', link: '/admin/communications?thread=cust-1&message=SM-held', detail: null };

    test('a newer plain text replaces the label', async () => {
      const refresh = await ring({ twilioSid: 'SM-new', message: 'ants again' }, false);
      const took = await refresh(row, { payload: { twilioSid: 'SM-held', leadPreference: 'call', textCount: 1 } });
      expect(took.title).toBe('2 texts from Dana Example');
      expect(took.metadata.payload.leadPreference).toBeUndefined();
    });

    test('a newer CALL text labels the row', async () => {
      const refresh = await ring({ twilioSid: 'SM-new', message: 'Call', leadPreference: 'call' }, false);
      const took = await refresh(row, { payload: { twilioSid: 'SM-held', textCount: 1 } });
      expect(took.title).toBe('Wants a call: Dana Example (2 texts)');
      expect(took.metadata.payload.leadPreference).toBe('call');
    });

    test('an OLDER late text cannot change the title: not add a label, not remove one', async () => {
      const olderCall = await ring({ twilioSid: 'SM-old', message: 'Call', leadPreference: 'call' }, true);
      const plainRow = await olderCall(row, { payload: { fromName: 'Dana Example', threadId: 'cust-1', twilioSid: 'SM-held', textCount: 1 } });
      expect(plainRow.title).toBe('2 texts from Dana Example');
      expect(plainRow.metadata.payload.leadPreference).toBeUndefined();
      const olderPlain = await ring({ twilioSid: 'SM-old', message: 'hello' }, true);
      const labelled = await olderPlain(row, { payload: { fromName: 'Dana Example', threadId: 'cust-1', twilioSid: 'SM-held', leadPreference: 'text', textCount: 1 } });
      expect(labelled.title).toBe('Prefers text: Dana Example (2 texts)');
      expect(labelled.metadata.payload.leadPreference).toBe('text');
    });
  });

  test('a thread row hit with identical content (a replayed text) is not a refresh and does not push again', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'thread-row', deduped: true });
    const PushService = require('../services/push-notifications');
    PushService.sendToAdminUsers.mockClear();
    const stats = await triggerNotification('sms_reply', { threadId: 'cust-1', twilioSid: 'SM-2', message: 'Second text', textCount: 2 },
      { dedupeKey: 'sms-thread:cust-1', refreshOnDedupe: true, bumpOnRefresh: true });
    expect(stats).toMatchObject({ bellWritten: true, deduped: true, push: null });
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
  });

  // A second same-day callback on the SAME open promise dedupes to the
  // committed bell — the promise-chaser bell's own dedupeKey — and must not
  // re-buzz the phone either, even though it is a genuinely new call.
  // Like sms_reply, a promise-chaser dedupe HIT skips the push. The sweep is
  // stateless and never retries a push, so a dedupe hit can only be a
  // concurrent dispatch of the same (promise, ET day) that already pushed.
  test('a promise-chaser dedupe hit does not push again (a concurrent dispatch already did)', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'committed-bell', deduped: true });
    const stats = await triggerNotification('promise_chaser', { commitmentId: 'fixture-commitment-1', phone: '+19415550199' },
      { dedupeKey: 'waves-promise_chaser-fixture-commitment-1-2026-09-26' });
    expect(stats.deduped).toBe(true);
    expect(require('../services/push-notifications').sendToAdminUsers).not.toHaveBeenCalled();
  });

  test('push-only SMS recovery retains its message tag and avoids renotification', async () => {
    db.mockImplementation(table => tableMock(table === 'technicians' ? [{ id: 'admin-1' }]
      : [{ admin_user_id: 'admin-1', bell_enabled: false, push_enabled: true }]));
    const PushService = require('../services/push-notifications');
    const payload = { twilioSid: 'SM-synthetic-push-only' };
    await triggerNotification('sms_reply', payload, { dedupeKey: 'sms-reply:SM-synthetic-push-only' });
    await triggerNotification('sms_reply', payload, { dedupeKey: 'sms-reply:SM-synthetic-push-only' });
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(2);
    for (const [, build] of PushService.sendToAdminUsers.mock.calls) {
      expect(build('admin-1')).toMatchObject({ tag: 'waves-sms_reply-SM-synthetic-push-only', renotify: false });
    }
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  // With every admin bell-disabled, notifyAdmin's own dedupe lock (inside
  // the bell-enabled branch) never runs — the push tag has to carry the
  // dedupe identity on its own, same fix as the SMS case above.
  test('push-only promise-chaser callbacks tag by the bell dedupeKey and avoid renotification', async () => {
    db.mockImplementation(table => tableMock(table === 'technicians' ? [{ id: 'admin-1' }]
      : [{ admin_user_id: 'admin-1', bell_enabled: false, push_enabled: true }]));
    const PushService = require('../services/push-notifications');
    const payload = { commitmentId: 'fixture-commitment-2', phone: '+19415550199' };
    const dedupeKey = 'waves-promise_chaser-fixture-commitment-2-2026-09-26';
    await triggerNotification('promise_chaser', payload, { dedupeKey });
    await triggerNotification('promise_chaser', payload, { dedupeKey });
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(2);
    for (const [, build] of PushService.sendToAdminUsers.mock.calls) {
      expect(build('admin-1')).toMatchObject({ tag: dedupeKey, renotify: false });
    }
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
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

  // job_complete is quietByDefault: these push-handoff tests need an explicit
  // opted-in preference row, or the event never reaches the push path.
  const jobCompleteOptIn = (table) => tableMock(
    table === 'technicians' ? [{ id: 'admin-1', role: 'admin' }]
      : table === 'notification_preferences' ? [{ admin_user_id: 'admin-1', trigger_key: 'job_complete', bell_enabled: true, push_enabled: true, sound_enabled: true }]
        : []);

  test('a quietByDefault trigger with no preference row writes no bell and sends no push', async () => {
    db.mockImplementation((table) => tableMock(table === 'technicians' ? [{ id: 'admin-1', role: 'admin' }] : []));
    const result = await triggerNotification('job_complete', { techName: 'Adam' });
    expect(result.bellWritten).toBe(false);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(require('../services/push-notifications').sendToAdminUsers).not.toHaveBeenCalled();
    // An explicit opt-in row turns the same event back on.
    db.mockImplementation(jobCompleteOptIn);
    const optedIn = await triggerNotification('job_complete', { techName: 'Adam' });
    expect(optedIn.bellWritten).toBe(true);
  });

  test('the durable push check runs after badge work and immediately before sending', async () => {
    const order = [];
    db.mockImplementation(jobCompleteOptIn);
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
    db.mockImplementation(jobCompleteOptIn);
    require('../services/push-notifications').sendToAdminUsers.mockImplementationOnce(async (_ids, _build, { beforeDispatch }) => (
      (await beforeDispatch()) === false ? { subscriptions: 1, sent: 0, superseded: true } : { sent: 1 }));
    const result = await triggerNotification('job_complete', {}, {
      dedupeKey: 'fixture_completion_record', beforePush: async ({ dispatching }) => !dispatching,
    });
    expect(result.push).toEqual({ sent: 0, skipped: 'superseded_before_push' });
    expect(result.retryable).toBe(false);
  });

  test('a push lookup failure keeps a resumed event retryable without taking the claim', async () => {
    db.mockImplementation(jobCompleteOptIn);
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

  // GATE_ALERT_CATALOG=watch (bell rebuild step D1): this silence returns before NotificationService.create, so it
  // leaves the muted record itself; otherwise every muted registry event (payments, dashboard alerts) went uncounted.
  test.each([['watch', 1], [undefined, 0]])('GATE_ALERT_CATALOG=%p: a registry event the bell policy silences leaves %p muted record(s)', async (mode, rows) => {
    const bellPolicy = require('../services/notification-bell-policy');
    const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
    const allowSpy = jest.spyOn(bellPolicy, 'bellAllowed').mockResolvedValue(false);
    const auditInsert = jest.fn(async () => []);
    db.mockImplementation((table) => (
      table === 'audit_log' ? { insert: auditInsert }
        : table === 'technicians' ? tableMock([{ id: 'admin-1' }]) : tableMock([])
    ));
    if (mode) process.env.GATE_ALERT_CATALOG = mode;
    try {
      const stats = await triggerNotification('dashboard_alert', { title: `Catalog check ${mode}`, body: 'y' });
      expect(stats.policySilenced).toBe(true);
      expect(auditInsert).toHaveBeenCalledTimes(rows);
      if (rows) {
        expect(JSON.parse(auditInsert.mock.calls[0][0].metadata))
          .toMatchObject({ category: TRIGGER_REGISTRY.dashboard_alert.category, triggerKey: 'dashboard_alert' });
      }
    } finally {
      delete process.env.GATE_ALERT_CATALOG;
      gateSpy.mockRestore(); allowSpy.mockRestore();
    }
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

  // GATE_CUSTOMER_ALERTS_RING (owner 2026-10-29, "small" E1): a bundle quote request is declared a customer contact.
  // Its 'estimate' category is muted by the bell policy; with the gate on it passes, and its bell write carries
  // bell: true so NotificationService.create's own check (category + trigger key only) agrees.
  test.each([[undefined, false], ['true', true]])('GATE_CUSTOMER_ALERTS_RING=%p: a bundle quote request rings: %p', async (mode, rings) => {
    const NotificationService = require('../services/notification-service');
    const bellPolicy = require('../services/notification-bell-policy');
    bellPolicy.clearOverrideCache();
    const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
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
    if (mode) process.env.GATE_CUSTOMER_ALERTS_RING = mode;
    try {
      const stats = await triggerNotification('bundle_quote_requested', { customerName: 'Pat Bundle', customerId: 'cust-9' });
      expect(Boolean(stats.policySilenced)).toBe(!rings);
      expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(rings ? 1 : 0);
      if (rings) {
        expect(NotificationService.notifyAdmin.mock.calls[0][0]).toBe('estimate');
        expect(NotificationService.notifyAdmin.mock.calls[0][3]).toMatchObject({ bell: true });
      }
    } finally {
      delete process.env.GATE_CUSTOMER_ALERTS_RING;
      gateSpy.mockRestore();
      bellPolicy.clearOverrideCache();
    }
  });

  test('GATE_CUSTOMER_ALERTS_RING on: an undeclared type keeps today\'s answer and its bell write gets no bell tag', async () => {
    const NotificationService = require('../services/notification-service');
    const bellPolicy = require('../services/notification-bell-policy');
    const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
    const allowSpy = jest.spyOn(bellPolicy, 'bellAllowed').mockResolvedValue(true);
    NotificationService.notifyAdmin.mockClear();
    process.env.GATE_CUSTOMER_ALERTS_RING = 'true';
    try {
      await triggerNotification('dashboard_alert', { title: 'x', body: 'y' });
      expect(allowSpy).toHaveBeenCalledWith(expect.objectContaining({ triggerKey: 'dashboard_alert', declared: TRIGGER_REGISTRY.dashboard_alert.rule }));
      expect(NotificationService.notifyAdmin.mock.calls[0][3]).not.toHaveProperty('bell');
    } finally {
      delete process.env.GATE_CUSTOMER_ALERTS_RING;
      gateSpy.mockRestore(); allowSpy.mockRestore();
    }
  });
});

describe('payment failure settlement recheck', () => {
  const PushService = require('../services/push-notifications');
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockImplementation((table) => table === 'technicians'
      ? tableMock([{ id: 'admin-1', role: 'admin' }]) : tableMock([]));
    NotificationService.notifyAdmin.mockImplementation(async (_category, _title, _body, opts) => (
      await opts.shouldContinue() ? { id: 'synthetic-bell' } : { suppressed: true }
    ));
  });

  test('a settlement discovered at the persistence boundary suppresses both channels', async () => {
    const shouldContinue = jest.fn(async () => false);
    const result = await triggerNotification('payment_failed', { paymentIntentId: 'pi_synthetic' }, {
      dedupeKey: 'payment-failed:pi_synthetic:ch_synthetic', shouldContinue, beforePush: shouldContinue,
    });
    expect(shouldContinue).toHaveBeenCalled();
    expect(result.bellWritten).toBe(false);
    expect(result.suppressed).toBe(true);
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
  });

  test('partial phone failure stays retryable even after the bell is written', async () => {
    PushService.sendToAdminUsers.mockResolvedValueOnce({ sent: 1, failed: 1, deliveredSubscriptionIds: ['sub-accepted'] });
    const shouldContinue = jest.fn(async () => true);
    const result = await triggerNotification('payment_failed', { paymentIntentId: 'pi_synthetic' }, {
      dedupeKey: 'payment-failed:pi_synthetic:ch_synthetic', shouldContinue,
      beforePush: shouldContinue, deliveredSubscriptionIds: ['sub-prior'],
    });
    expect(result).toMatchObject({ bellWritten: true, retryable: true,
      push: { deliveredSubscriptionIds: ['sub-accepted'] } });
    expect(PushService.sendToAdminUsers).toHaveBeenCalledWith(expect.any(Array), expect.any(Function),
      expect.objectContaining({ deliveredSubscriptionIds: ['sub-prior'] }));
  });

  test('settlement after bell persistence prevents provider fan-out', async () => {
    const shouldContinue = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const result = await triggerNotification('payment_failed', { paymentIntentId: 'pi_synthetic' }, {
      dedupeKey: 'payment-failed:pi_synthetic:ch_synthetic', shouldContinue, beforePush: shouldContinue,
    });
    expect(result.bellWritten).toBe(true);
    expect(result.push.skipped).toBe('superseded_before_push');
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
  });
});

describe('sms_reply thread row title', () => {
  test('one text reads "SMS from Name"; a running count leads the title from the second text', () => {
    const { build } = TRIGGER_REGISTRY.sms_reply;
    expect(build({ fromName: 'Dana Example', message: 'Hi', threadId: 'c1', twilioSid: 'SM1' }).title).toBe('SMS from Dana Example');
    expect(build({ fromName: 'Dana Example', message: 'Hi', threadId: 'c1', twilioSid: 'SM1', textCount: 1 }).title).toBe('SMS from Dana Example');
    const third = build({ fromName: 'Dana Example', message: 'Third', threadId: 'c1', twilioSid: 'SM3', textCount: 3 });
    expect(third.title).toBe('3 texts from Dana Example');
    expect(third.body).toBe('Third');
    // The link keeps the thread prefix the read-state matchers split on.
    expect(third.link).toBe('/admin/communications?thread=c1&message=SM3');
  });
});

describe('sms_reply keeps the whole text for the bell', () => {
  test('a text over 140 characters carries the full message as detail; a short one carries none', () => {
    const long = `Could you come back out this week? ${'The ants are back by the patio door. '.repeat(5)}Thanks.`;
    const built = TRIGGER_REGISTRY.sms_reply.build({ fromName: 'Dana Example', message: long, threadId: 'customer-123' });
    expect(built.body).toHaveLength(140);
    expect(built.detail).toBe(long);
    const short = TRIGGER_REGISTRY.sms_reply.build({ fromName: 'Dana Example', message: 'See you at 4.', threadId: 'customer-123' });
    expect(short.detail).toBeUndefined();
  });
});
