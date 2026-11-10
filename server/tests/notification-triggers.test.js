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
// The instance notification-triggers itself holds: an earlier test resets the module registry, so a later require is another copy.
const PushServiceHeld = require('../services/push-notifications');
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

  // Sweep #7303 B1: two urgent callers' pages must not replace each other on the phone.
  test('the voice agent pages get a per-call / per-ticket push tag', () => {
    expect(__private.pushTagFor('relay_hot_lead', { callSid: 'CA-a' })).toBe('waves-relay_hot_lead-CA-a');
    expect(__private.pushTagFor('relay_reservice_filed', { requestId: 'req-a' })).toBe('waves-relay_reservice_filed-req-a');
    expect(__private.pushTagFor('relay_hot_lead', {})).not.toBe(__private.pushTagFor('relay_hot_lead', {}));
  });

  // GATE_PORTAL_ASK_PUSH: one banner per ask, so a repeat collapses and a second customer's ask does not replace the first.
  test('portal_ask gets a per-ask push tag', () => {
    expect(__private.pushTagFor('portal_ask', { itemKey: 'request:r-1' })).toBe('waves-portal_ask-request:r-1');
    expect(__private.pushTagFor('portal_ask', { itemKey: 'late:n-9' })).not.toBe(__private.pushTagFor('portal_ask', { itemKey: 'request:r-1' }));
    expect(__private.pushTagFor('portal_ask', {})).not.toBe(__private.pushTagFor('portal_ask', {}));
  });

  // GATE_MORNING_BANNER: one banner per ET day, so a late repeat replaces the same day's banner and tomorrow's does not.
  test('waiting_summary gets a per-ET-day push tag', () => {
    expect(__private.pushTagFor('waiting_summary', { day: '2026-11-03' })).toBe('waves-waiting_summary-2026-11-03');
    expect(__private.pushTagFor('waiting_summary', { day: '2026-11-04' })).not.toBe(__private.pushTagFor('waiting_summary', { day: '2026-11-03' }));
  });

  it('customer_landline_from_call gets a per-customer push tag so concurrent alerts do not collapse', () => {
    const a = __private.pushTagFor('customer_landline_from_call', { customerId: 'cust-a' });
    const b = __private.pushTagFor('customer_landline_from_call', { customerId: 'cust-b' });
    expect(a).toBe('waves-customer_landline_from_call-cust-a');
    expect(b).toBe('waves-customer_landline_from_call-cust-b');
    expect(a).not.toBe(b);
    expect(__private.pushTagFor('customer_landline_from_call', {})).toBe('waves-customer_landline_from_call-unknown-customer');
  });

  // GATE_MORNING_BANNER (owner 2026-11-03, "ok add", choice C).
  test('waiting_summary says how many items wait, with the top three areas, and opens the alert list', () => {
    const areas = [{ area: 'Comms', count: 6 }, { area: 'Schedule', count: 3 }, { area: 'Billing', count: 2 }, { area: 'Leads', count: 1 }];
    const built = TRIGGER_REGISTRY.waiting_summary.build({ count: 12, areas });
    expect(built.title).toBe('12 items wait for you');
    expect(built.body).toBe('Comms 6 \u00b7 Schedule 3 \u00b7 Billing 2');
    expect(built.link).toBe('/admin/dashboard?bell=open');
    expect(TRIGGER_REGISTRY.waiting_summary.build({ count: 1, areas: [{ area: 'Billing', count: 1 }] }).title).toBe('1 item waits for you');
    expect(TRIGGER_REGISTRY.waiting_summary.build({ count: 2, areas: [{ area: 'Billing', count: 2 }] }).title).toBe('2 items wait for you');
    expect(TRIGGER_REGISTRY.waiting_summary.build({ count: 3, areas: [] }).body).toBeNull();
    // Owner 2026-11-04 "fix count": read items still open show as "N open in all" after the unread areas.
    expect(TRIGGER_REGISTRY.waiting_summary.build({ count: 39, total: 334, areas }).body).toBe('Comms 6 \u00b7 Schedule 3 \u00b7 Billing 2 \u00b7 334 open in all');
    expect(TRIGGER_REGISTRY.waiting_summary.build({ count: 12, total: 12, areas }).body).toBe('Comms 6 \u00b7 Schedule 3 \u00b7 Billing 2');
    expect(TRIGGER_REGISTRY.waiting_summary).toMatchObject({ label: 'Morning summary: items waiting for you', category: 'alert', priority: 'normal', group: 'Alerts' });
    expect(TRIGGER_REGISTRY.waiting_summary.techVisible).toBeUndefined();
  });

  // GATE_OWNER_NUDGE_BANNER (owner 2026-11-04, "banner").
  test('open_visits_nudge carries the text\'s words, opens the tech close-out page and has no bell-row rule beyond fyi', () => {
    const built = TRIGGER_REGISTRY.open_visits_nudge.build({
      headline: '3 visits from today are still open',
      lines: ['9:00 AM - Ana R. - Pest Control (not started)', '+2 more'],
      day: '2026-11-04',
    });
    expect(built.title).toBe('3 visits from today are still open');
    expect(built.body).toBe('Tap to close out.\n9:00 AM - Ana R. - Pest Control (not started)\n+2 more');
    expect(built.link).toBe('/tech');
    expect(TRIGGER_REGISTRY.open_visits_nudge.build({}).body).toBe('Tap to close out.');
    expect(TRIGGER_REGISTRY.open_visits_nudge).toMatchObject({ category: 'alert', priority: 'normal', group: 'Alerts', rule: { severity: 'fyi' } });
    expect(TRIGGER_REGISTRY.open_visits_nudge.techVisible).toBeUndefined();
  });

  test('open_visits_nudge gets a per-ET-day push tag', () => {
    expect(__private.pushTagFor('open_visits_nudge', { day: '2026-11-04' })).toBe('waves-open_visits_nudge-2026-11-04');
    expect(__private.pushTagFor('open_visits_nudge', { day: '2026-11-05' })).not.toBe(__private.pushTagFor('open_visits_nudge', { day: '2026-11-04' }));
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

  test('an unknown sender\'s text to a tracking line says what they wrote, masked, and opens the SMS inbox (owner 2026-11-04)', () => {
    // Tracking-line texts from unknown numbers mint no customer row
    // (twilio-webhook.js domain/van branch), so the bell must not send the
    // owner to a lead that does not exist. It used to say only "Message in
    // the SMS inbox"; it quotes the text the way every bell body is masked.
    const sid = `SM${'0123456789abcdef'.repeat(2)}`;
    const text = { name: null, twilioSid: sid, source: 'wavespestcontrol.com', phone: '+12025550101', link: `/admin/communications?message=${sid}` };
    const built = TRIGGER_REGISTRY.new_lead.build({ ...text, message: 'Please quote ants at 1000 Riverside Drive, call 941-555-0123', textCount: 1 });

    expect(built.title).toBe('New text from wavespestcontrol.com');
    expect(built.body).toBe('“Please quote ants at [address], call ***0123” — unknown sender ***0101');
    expect(built.body).not.toContain('Message in the SMS inbox');
    expect(built.detail).toBeUndefined();
    expect(built.link).toBe(`/admin/communications?message=${sid}`);
    // Call: the Communications thread's Call back for the sender, named by the text.
    expect(built.alert.buttons.items[0].args).toEqual({ smsSid: sid });

    // The sender's row counts its texts; a long text is cut inside the 110-character why and kept whole for
    // "Show full text"; a text with no words (the webhook rings only for words or a photo) is a photo.
    const long = 'Hi there, I have roaches all over my kitchen and garage and I need someone to come out this week, what do you charge?';
    const second = TRIGGER_REGISTRY.new_lead.build({ ...text, message: long, textCount: 2 });
    expect(second.title).toBe('2 texts from wavespestcontrol.com');
    expect(second.body.length).toBeLessThanOrEqual(110);
    expect(second.body).toMatch(/^“Hi there, I have roaches .*…” — unknown sender \*\*\*0101$/);
    expect(second.detail).toBe(long);
    const photo = TRIGGER_REGISTRY.new_lead.build({ ...text, message: '' });
    expect(photo.body).toBe('Photo message — unknown sender ***0101');
    expect(photo.detail).toBeUndefined();

    // A name on file for the number leads instead of the bare number (owner 2026-11-04), with the line they texted.
    const named = TRIGGER_REGISTRY.new_lead.build({ ...text, name: 'Jane Fixture', message: 'Do you treat roaches?', textCount: 2 });
    expect(named.title).toBe('2 texts from Jane Fixture');
    expect(named.body).toBe('“Do you treat roaches?” — via wavespestcontrol.com');
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

  test('promise-chaser headline and body lead with the caller name; with no name, the formatted number in both (owner 2026-10-21, 2026-11-04)', () => {
    const named = TRIGGER_REGISTRY.promise_chaser.build({
      name: 'Martin Fixtureson', phone: '+19415550199', what: 'quote', when: 'Sun, Oct 19 at 3:50 PM', calledAtLabel: '12:31 PM',
    });
    expect(named.title).toBe('Martin Fixtureson called back — we still owe a quote');
    const unnamed = TRIGGER_REGISTRY.promise_chaser.build({
      name: null, phone: '+19415550199', what: 'quote', when: 'Sun, Oct 19 at 3:50 PM', calledAtLabel: '12:31 PM',
    });
    expect(unnamed.title).toBe('(941) 555-0199 called back — we still owe a quote');
    // The body names the caller the way the headline does, never the raw +1 number.
    expect(unnamed.body).toBe('(941) 555-0199 called at 12:31 PM. We still owe them a quote promised Sun, Oct 19 at 3:50 PM.');
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

  test('the add-service bell carries its request id and customer on top of its metadata; with no request row, the build has none', () => {
    const payload = { customerName: 'Pat Fixture', suggestedService: 'Mosquito', previousTier: 'Bronze', customerId: 'cust-789', requestId: 'req-456' };
    expect(TRIGGER_REGISTRY.bundle_quote_requested.build(payload).alert).toEqual({ requestId: 'req-456', customerId: 'cust-789' });
    // a self-applied bundle has no request row; a request with no customer cannot be judged
    expect(TRIGGER_REGISTRY.bundle_quote_requested.build({ ...payload, requestId: undefined })).not.toHaveProperty('alert');
    expect(TRIGGER_REGISTRY.bundle_quote_requested.build({ ...payload, customerId: undefined })).not.toHaveProperty('alert');
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

  // GATE_ALERT_RING_BUDGET (services/alert-ring-budget.js): a row the daily budget held is Activity-only, so no phone push follows it.
  test('a bell row the daily ring budget held sends no phone push; a row that rang still does', async () => {
    const PushService = require('../services/push-notifications');
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'held-1', metadata: { feed: 'activity', quiet: true, ringBudgetHeld: '2026-11-05' } });
    const held = await triggerNotification('dashboard_alert', { title: 'Synthetic', message: 'Synthetic held alert' });
    expect(held).toMatchObject({ bellWritten: true, push: { sent: 0, skipped: 'ring_budget' }, ringBudgetHeld: true });
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'rang-1', metadata: { ringBudgetDay: '2026-11-05' } });
    await triggerNotification('dashboard_alert', { title: 'Synthetic', message: 'Synthetic ringing alert' });
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
  });

  // GATE_ALERT_RING_BUDGET, push-only recipients: every admin turned bell entries off but kept the phone push on.
  describe('push-only recipients under the daily ring budget', () => {
    const ringBudget = require('../services/alert-ring-budget');
    const pushOnlyDb = () => db.mockImplementation((table) => {
      if (table === 'technicians') return tableMock([{ id: 'admin-1', role: 'admin' }]);
      if (table === 'notification_preferences') return tableMock([{ admin_user_id: 'admin-1', bell_enabled: false, push_enabled: true, sound_enabled: true }]);
      return tableMock([]);
    });
    afterEach(() => { delete process.env.GATE_ALERT_RING_BUDGET; jest.restoreAllMocks(); });

    test('past the budget no push goes and no bell entry is requested by the trigger itself', async () => {
      const PushService = require('../services/push-notifications');
      process.env.GATE_ALERT_RING_BUDGET = 'true';
      pushOnlyDb();
      const spy = jest.spyOn(ringBudget, 'budgetPushOnly').mockResolvedValue({ held: true });
      const stats = await triggerNotification('dashboard_alert', { title: 'Synthetic', message: 'Synthetic' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({ category: 'alert', metadata: { triggerKey: 'dashboard_alert' } });
      expect(stats).toMatchObject({ bellWritten: false, push: { sent: 0, skipped: 'ring_budget' }, ringBudgetHeld: true });
      expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    });

    test('within the budget the push goes as before', async () => {
      const PushService = require('../services/push-notifications');
      process.env.GATE_ALERT_RING_BUDGET = 'true';
      pushOnlyDb();
      jest.spyOn(ringBudget, 'budgetPushOnly').mockResolvedValue({ held: false });
      await triggerNotification('dashboard_alert', { title: 'Synthetic', message: 'Synthetic' });
      expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    });

    test('a dedupe hit on a keyed alert whose push already went sends no second push, as the bell loop does; a refresh still pushes', async () => {
      const PushService = require('../services/push-notifications');
      process.env.GATE_ALERT_RING_BUDGET = 'true';
      const payload = { failures: ['golden_addr:Example (no parcel)'] };
      const opts = { dedupeKey: 'property-lookup-canary:2026-11-06' };
      pushOnlyDb();
      jest.spyOn(ringBudget, 'budgetPushOnly').mockResolvedValue({ held: false, created: { id: 'n-1', deduped: true, refreshed: false } });
      const stats = await triggerNotification('property_lookup_canary_failed', payload, opts);
      expect(stats).toMatchObject({ bellWritten: false, deduped: true });
      expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();

      jest.restoreAllMocks();
      pushOnlyDb();
      jest.spyOn(ringBudget, 'budgetPushOnly').mockResolvedValue({ held: false, created: { id: 'n-1', deduped: true, refreshed: true } });
      await triggerNotification('property_lookup_canary_failed', payload, opts);
      expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    });

    test('gate off: the budget is not consulted and nothing else changes', async () => {
      const PushService = require('../services/push-notifications');
      pushOnlyDb();
      const spy = jest.spyOn(ringBudget, 'budgetPushOnly');
      await triggerNotification('dashboard_alert', { title: 'Synthetic', message: 'Synthetic' });
      expect(spy).not.toHaveBeenCalled();
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
      expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    });
  });

  // GATE_BELL_BANNERS: a banner for a bell row its writer rang under bell: true keeps that authorization, so it does
  // not depend on GATE_CUSTOMER_ALERTS_RING (real policy on, that gate off).
  test.each(['call_commitment_overdue', 'sms_operational_followup', 'messenger_reply'])(
    'policy on, GATE_CUSTOMER_ALERTS_RING off: a %s banner pushes only as bellAuthorized pushOnly', async (key) => {
      const PushService = require('../services/push-notifications');
      const bellPolicy = require('../services/notification-bell-policy');
      bellPolicy.clearOverrideCache();
      const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
      db.mockImplementation((table) => (
        table === 'technicians' ? tableMock([{ id: 'admin-1', role: 'admin' }]) : tableMock([])
      ));
      delete process.env.GATE_CUSTOMER_ALERTS_RING;
      const payload = { alertRowId: 'n-1', alertTitle: 'Comms — follow up', alertBody: 'Body.', alertLink: '/admin', customerId: 'cust-1' };
      try {
        PushService.sendToAdminUsers.mockClear();
        const plain = await triggerNotification(key, payload, { pushOnly: true, adminOnly: true });
        expect(plain.policySilenced).toBe(true);
        expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
        const notPushOnly = await triggerNotification(key, payload, { bellAuthorized: true });
        expect(notPushOnly.policySilenced).toBe(true);
        expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
        const banner = await triggerNotification(key, payload, { pushOnly: true, adminOnly: true, bellAuthorized: true });
        expect(Boolean(banner.policySilenced)).toBe(false);
        expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
        expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
      } finally {
        gateSpy.mockRestore();
        bellPolicy.clearOverrideCache();
      }
    },
  );

  test('an iPhone alert sound rides on the admin push only when the Sound switch is on and the trigger has one', async () => {
    const PushService = require('../services/push-notifications');
    const soundPref = (soundEnabled) => (table) => (
      table === 'technicians' ? tableMock([{ id: 'admin-1' }])
        : table === 'notification_preferences'
          ? tableMock([{ admin_user_id: 'admin-1', trigger_key: 'customer_missed_call', bell_enabled: true, push_enabled: true, sound_enabled: soundEnabled }])
          : tableMock([]));
    const missed = { customerId: null, name: 'Test Caller', phone: '+19415550100', callLogId: 'call-1' };
    const pushFor = async (trigger, payload) => {
      PushService.sendToAdminUsers.mockClear();
      await triggerNotification(trigger, payload, { pushOnly: true });
      return PushService.sendToAdminUsers.mock.calls[0][1]('admin-1');
    };
    db.mockImplementation(soundPref(true));
    expect(await pushFor('customer_missed_call', missed)).toMatchObject({ sound: 'waves-missed-call.caf', silent: false });
    expect(await pushFor('portal_ask', { itemKey: 'request:r-9', title: 't', body: 'b' })).toMatchObject({ sound: 'waves-text.caf' });
    // An alert type with no file sends no sound, so APNs plays the default.
    expect(await pushFor('twilio_failure', {})).not.toHaveProperty('sound');
    // Sound switch off: the push stays silent and names no file.
    db.mockImplementation(soundPref(false));
    const quiet = await pushFor('customer_missed_call', missed);
    expect(quiet).toMatchObject({ silent: true, vibrate: [0] });
    expect(quiet).not.toHaveProperty('sound');
  });

  test('portal_ask is a pushOnly page: it writes no bell row and pushes one banner tagged by the ask', async () => {
    const PushService = require('../services/push-notifications');
    PushService.sendToAdminUsers.mockClear();
    const trigger = TRIGGER_REGISTRY.portal_ask;
    expect(trigger).toEqual(expect.objectContaining({ label: 'Customer asked in the app', priority: 'high', group: 'Communication', adminRoleOnly: true }));
    expect(trigger.rule).toEqual({ area: 'Comms', severity: 'needs-you', who: 'person', expiryDays: 30, contact: true });
    const payload = { itemKey: 'request:r-1', title: 'Answer a portal request', body: 'Pat S. sent a pest control request', link: '/admin/customers?customerId=c-1' };
    await triggerNotification('portal_ask', payload, { pushOnly: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    const sent = PushService.sendToAdminUsers.mock.calls[0][1]('admin-1');
    expect(sent.tag).toBe('waves-portal_ask-request:r-1');
    expect(sent.title).toBe('Answer a portal request');
    expect(sent.body).toBe('Pat S. sent a pest control request');
    // A fallback link when the payload carries none.
    expect(trigger.build({ title: 't' }).link).toBe('/admin/communications');
  });

  test('portal_ask re-alerts on a repeat ask in the same chat: same banner tag, renotify on', async () => {
    const PushService = require('../services/push-notifications');
    PushService.sendToAdminUsers.mockClear();
    const payload = { itemKey: 'portal-chat-escalation:esc-7', title: 'Reply to a portal chat', body: 'Pat S. asked about scheduling' };
    await triggerNotification('portal_ask', payload, { pushOnly: true });
    await triggerNotification('portal_ask', { ...payload, body: 'Pat S. asked about pricing' }, { pushOnly: true });
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(2);
    for (const [, build] of PushService.sendToAdminUsers.mock.calls) {
      expect(build('admin-1')).toMatchObject({ tag: 'waves-portal_ask-portal-chat-escalation:esc-7', renotify: true });
    }
  });

  test('portal_ask redacts a phone number or email that slipped into the text', async () => {
    const PushService = require('../services/push-notifications');
    PushService.sendToAdminUsers.mockClear();
    await triggerNotification('portal_ask', { itemKey: 'request:r-2', title: 'Answer a portal request', body: 'Pat S. wrote pat@example.com or 941-555-0100' }, { pushOnly: true });
    const sent = PushService.sendToAdminUsers.mock.calls[0][1]('admin-1');
    expect(sent.body).not.toMatch(/pat@example\.com|941-555-0100/);
  });

  test('a keyed SMS replay reuses its committed bell and does not push again', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'committed-bell', deduped: true });
    expect(await triggerNotification('sms_reply', { twilioSid: 'SM-synthetic-replay' },
      { dedupeKey: 'sms-reply:SM-synthetic-replay' })).toMatchObject({ bellWritten: true, deduped: true, push: null });
    expect(require('../services/push-notifications').sendToAdminUsers).not.toHaveBeenCalled();
  });

  // Sweep #7303 B1: Sandy's hot-lead page is keyed per call, so a dedupe hit is a
  // reconnect's or the hourly sweep's retry of a page that already landed.
  test('a keyed hot-lead page retry reuses its bell and does not push again', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'hot-bell', deduped: true });
    expect(await triggerNotification('relay_hot_lead', { title: 'Leads — call back Pat Rivera now', callSid: 'CA-synthetic' },
      { dedupeKey: 'relay-hot-lead:CA-synthetic' })).toMatchObject({ bellWritten: true, deduped: true, push: null });
    expect(require('../services/push-notifications').sendToAdminUsers).not.toHaveBeenCalled();
  });

  test('the hot-lead page writes its composed parts and full text onto the bell row', async () => {
    const alert = { area: 'Leads', severity: 'needs-you', who: 'person', contact: true, subject: { type: 'lead', id: 'l-9' }, doneWhen: 'urgent_caller_called_back' };
    await triggerNotification('relay_hot_lead', {
      title: 'Leads — call back Pat Rivera now', body: 'Sandy flagged the call urgent.', detail: 'Pat Rivera\nCall them back.',
      link: '/admin/leads?leadId=l-9', alert, callSid: 'CA-synthetic',
    }, { dedupeKey: 'relay-hot-lead:CA-synthetic' });
    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect([category, title, body]).toEqual(['new_lead', 'Leads — call back Pat Rivera now', 'Sandy flagged the call urgent.']);
    expect(opts).toMatchObject({
      link: '/admin/leads?leadId=l-9', detail: 'Pat Rivera\nCall them back.', dedupeKey: 'relay-hot-lead:CA-synthetic',
      metadata: { ...alert, triggerKey: 'relay_hot_lead' },
    });
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

    // The buttons follow the text the row shows (alert-call-button.js): a CALL text's emission carries Call into the
    // row's metadata, and an older late text leaves the row the buttons of the text it still shows. Checked on the
    // metadata notifyAdmin writes: the refresh's metadata merged over the emission's (notification-service.js).
    test('Call rides with the CALL text the row shows; an older late text never moves the buttons', async () => {
      const LEAD = '00000000-0000-4000-8000-0000000000e1';
      const HANDLED = { id: 'handled', label: 'Handled' };
      const HANDLED_ONLY = { kind: 'close_note', items: [HANDLED] };
      const CALL_AND_HANDLED = { kind: 'call_back', items: [expect.objectContaining({ id: 'call', label: 'Call', args: { customerId: LEAD } }), HANDLED] };
      const { mergeRefreshMetadata } = jest.requireActual('../services/notification-service')._private;
      // What notifyAdmin stores for this emission on the standing row: useMeta = { ...metadata, ...adjusted.metadata }.
      const written = async (emission, keepOlder, existingMeta) => {
        const refresh = await ring(emission, keepOlder);
        const { metadata } = NotificationService.notifyAdmin.mock.calls.at(-1)[3];
        const adjusted = await refresh(row, existingMeta);
        return mergeRefreshMetadata(existingMeta, { ...metadata, ...adjusted.metadata }, false);
      };
      const plain = { fromName: 'Dana Example', threadId: LEAD, twilioSid: 'SM-held', textCount: 1 };
      const callText = { ...plain, leadPreference: 'call' };

      // A newer CALL text: Call, then Handled. A newer plain text: Handled only.
      expect((await written({ threadId: LEAD, twilioSid: 'SM-new', message: 'Call', leadPreference: 'call' }, false, { payload: plain, buttons: HANDLED_ONLY })).buttons).toEqual(CALL_AND_HANDLED);
      expect((await written({ threadId: LEAD, twilioSid: 'SM-new', message: 'ants again' }, false, { payload: callText, buttons: CALL_AND_HANDLED })).buttons).toEqual(HANDLED_ONLY);
      // An older late CALL text on a row showing a plain text, with or without stored buttons: no Call.
      const olderCall = { threadId: LEAD, twilioSid: 'SM-old', message: 'Call', leadPreference: 'call' };
      expect((await written(olderCall, true, { payload: plain, buttons: HANDLED_ONLY })).buttons).toEqual(HANDLED_ONLY);
      expect((await written(olderCall, true, { payload: plain })).buttons).toEqual(HANDLED_ONLY);
      // An older late plain text on a row showing the CALL text: Call stays.
      expect((await written({ threadId: LEAD, twilioSid: 'SM-old', message: 'hello' }, true, { payload: callText, buttons: CALL_AND_HANDLED })).buttons).toEqual(CALL_AND_HANDLED);
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

    // The same for an unknown sender's thread row on a website line (new_lead, refreshed in place); a keyed
    // new_lead that is not a thread row still pushes on a hit.
    const sid = `SM${'0123456789abcdef'.repeat(2)}`;
    const text = { name: 'Jane Fixture', twilioSid: sid, phone: '+12025550101', message: 'Second text', source: 'wavespestcontrol.com', textCount: 1 };
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'tracking-row', deduped: true });
    expect(await triggerNotification('new_lead', text, { dedupeKey: 'sms-tracking-thread:abc', refreshOnDedupe: true, bumpOnRefresh: true }))
      .toMatchObject({ bellWritten: true, deduped: true, push: null });
    expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    // At rest the row's payload masks the sender's number (new_lead carries no contact details); the name on file stays.
    expect(NotificationService.notifyAdmin.mock.calls.at(-1)[3].metadata.payload).toMatchObject({ phone: '***0101', name: 'Jane Fixture' });
    // The sender's next text rewrites the row (a refresh, even after a close): that one pushes.
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'tracking-row', deduped: true, refreshed: true, rung: true });
    await triggerNotification('new_lead', { ...text, twilioSid: `SM${'fedcba9876543210'.repeat(2)}`, message: 'Third text' },
      { dedupeKey: 'sms-tracking-thread:abc', refreshOnDedupe: true, bumpOnRefresh: true });
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    NotificationService.notifyAdmin.mockResolvedValueOnce({ id: 'keyed-lead-row', deduped: true });
    await triggerNotification('new_lead', text, { dedupeKey: 'some-other-lead-key:abc' });
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(2);
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

  // The Call on the Waves Admin push (alert-call-button.js pushCallAction): the row this emission wrote names
  // itself on admin-role pushes only; a technician's push of the same tech-visible alert carries no Call.
  test('the push carries the written row\'s Call for admins only', async () => {
    const ROW = '00000000-0000-4000-8000-0000000000a9';
    const callButton = require('../services/alert-call-button');
    const spy = jest.spyOn(callButton, 'pushCallAction').mockResolvedValue({ callAction: `${ROW}.${'c'.repeat(32)}`, apnsCategory: 'WAVES_CALL' });
    try {
      db.mockImplementation((table) => tableMock(table === 'technicians'
        ? [{ id: 'admin-1', role: 'admin' }, { id: 'tech-1', role: 'technician' }] : []));
      NotificationService.notifyAdmin.mockResolvedValueOnce({ id: ROW });
      const PushService = require('../services/push-notifications');
      PushService.sendToAdminUsers.mockClear();
      await triggerNotification('customer_voicemail_callback', { name: 'Test Caller', phone: '+19415550100', callLogId: '00000000-0000-4000-8000-0000000000d1' });
      expect(spy).toHaveBeenCalledWith(ROW);
      const toUser = PushService.sendToAdminUsers.mock.calls[0][1];
      expect(toUser('admin-1')).toMatchObject({ callAction: `${ROW}.${'c'.repeat(32)}`, apnsCategory: 'WAVES_CALL' });
      expect(toUser('tech-1')).not.toHaveProperty('callAction');
      expect(toUser('tech-1')).not.toHaveProperty('apnsCategory');
      // No row written (push-only retry): no Call is looked up.
      spy.mockClear();
      await triggerNotification('customer_missed_call', { name: 'Test Caller', callLogId: 'call-1' }, { pushOnly: true });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // Owner 2026-11-04 (technician visibility D1 A): what a voicemail caller asked about is call content. A technician's
  // push leaves it out; the admin's push and the shared bell row keep it.
  test('a voicemail callback push leaves out what the caller asked about for a technician only', async () => {
    db.mockImplementation((table) => tableMock(table === 'technicians'
      ? [{ id: 'admin-1', role: 'admin' }, { id: 'tech-1', role: 'technician' }] : []));
    NotificationService.notifyAdmin.mockClear();
    const PushService = require('../services/push-notifications');
    PushService.sendToAdminUsers.mockClear();
    await triggerNotification('customer_voicemail_callback', { name: 'Test Caller', service: 'WDO Inspection', phone: '+19415550100' });
    const toUser = PushService.sendToAdminUsers.mock.calls[0][1];
    expect(toUser('admin-1')).toMatchObject({ title: 'Voicemail — Test Caller', body: 'Test Caller - Asked about WDO Inspection - Callback: (941) 555-0100' });
    expect(toUser('tech-1')).toMatchObject({ title: 'Voicemail — Test Caller', body: 'Test Caller - Callback: (941) 555-0100' });
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).toBe('Test Caller - Asked about WDO Inspection - Callback: (941) 555-0100');
  });

  test('technicianRowCopy: a stored voicemail row without the service; no stored payload = no body; other rows as stored', () => {
    const { technicianRowCopy } = require('../services/notification-triggers');
    const payload = { name: 'Test Caller', service: 'WDO Inspection', phone: '+19415550100' };
    const row = { id: 'n-1', title: 'Voicemail — Test Caller', body: 'Test Caller - Asked about WDO Inspection - Callback: (941) 555-0100', metadata: { triggerKey: 'customer_voicemail_callback', payload } };
    expect(technicianRowCopy(row)).toMatchObject({ body: 'Test Caller - Callback: (941) 555-0100', metadata: { payload: { name: 'Test Caller', phone: '+19415550100' } } });
    expect(technicianRowCopy(row).metadata.payload).not.toHaveProperty('service');
    expect(technicianRowCopy({ ...row, metadata: { triggerKey: 'customer_voicemail_callback' } })).toMatchObject({ title: row.title, body: null });
    const other = { id: 'n-2', title: 'Text from Pat Example', body: 'Running late', metadata: '{"triggerKey":"sms_reply"}' };
    expect(technicianRowCopy(other)).toBe(other);
    expect(technicianRowCopy({ id: 'n-3', metadata: '{not json' })).toMatchObject({ id: 'n-3' });
  });

  test('a new-lead alert carries Call for its lead, else the customer, else the sender\'s text', () => {
    const LEAD = '00000000-0000-4000-8000-0000000000e2';
    const CUSTOMER = '00000000-0000-4000-8000-0000000000c2';
    const SID = `SM${'0123456789abcdef'.repeat(2)}`;
    const callArgs = (p) => TRIGGER_REGISTRY.new_lead.build(p).alert?.buttons?.items[0].args;
    expect(callArgs({ name: 'Pat Sample', leadId: LEAD, customerId: CUSTOMER })).toEqual({ leadId: LEAD });
    // A web form whose lead row failed sends the customer id as leadId.
    expect(callArgs({ name: 'Pat Sample', leadId: CUSTOMER, customerId: CUSTOMER })).toEqual({ customerId: CUSTOMER });
    expect(callArgs({ title: 'New text from example.com', twilioSid: SID, phone: '+19415550100' })).toEqual({ smsSid: SID });
    expect(TRIGGER_REGISTRY.new_lead.build({ title: 'New lead from van wrap number', phone: '+19415550100' }).alert).toBeUndefined();
  });

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

  // GATE_MORNING_BANNER: with the bell policy on, the banner pushes (pushOnly, no bell row) only while its gate is on.
  test.each([['true', 1], [undefined, 0]])('GATE_MORNING_BANNER=%p: the pushOnly waiting_summary banner sends %p push(es), never a bell row', async (gate, pushes) => {
    const PushService = require('../services/push-notifications');
    const bellPolicy = require('../services/notification-bell-policy');
    const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
    db.mockImplementation((table) => (
      table === 'technicians' ? tableMock([{ id: 'admin-1', role: 'admin' }]) : tableMock([])
    ));
    NotificationService.notifyAdmin.mockClear();
    PushService.sendToAdminUsers.mockClear();
    if (gate) process.env.GATE_MORNING_BANNER = gate;
    try {
      const stats = await triggerNotification('waiting_summary', { count: 5, areas: [{ area: 'Comms', count: 5 }], day: '2026-11-03' }, { pushOnly: true });
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
      expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(pushes);
      if (!pushes) {
        expect(stats.policySilenced).toBe(true);
        return;
      }
      const [adminIds, payloadFor] = PushService.sendToAdminUsers.mock.calls[0];
      expect(adminIds).toEqual(['admin-1']);
      expect(payloadFor('admin-1')).toMatchObject({
        title: '5 items wait for you', body: 'Comms 5', url: '/admin/dashboard?bell=open',
        tag: 'waves-waiting_summary-2026-11-03', sound: 'waves-reminder.caf', priority: 'normal',
      });
    } finally {
      delete process.env.GATE_MORNING_BANNER;
      gateSpy.mockRestore();
    }
  });

  // GATE_OWNER_NUDGE_BANNER: pushOnly + onlyUserIds reaches only the named admin, never a bell row, only while its gate is on.
  test.each([['true', 1], [undefined, 0]])('GATE_OWNER_NUDGE_BANNER=%p: the pushOnly open_visits_nudge banner sends %p push(es) to the owner alone, never a bell row', async (gate, pushes) => {
    const PushService = require('../services/push-notifications');
    const bellPolicy = require('../services/notification-bell-policy');
    const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
    db.mockImplementation((table) => (
      table === 'technicians' ? tableMock([{ id: 'owner-1', role: 'admin' }, { id: 'admin-2', role: 'admin' }]) : tableMock([])
    ));
    NotificationService.notifyAdmin.mockClear();
    PushService.sendToAdminUsers.mockClear();
    if (gate) process.env.GATE_OWNER_NUDGE_BANNER = gate;
    try {
      const stats = await triggerNotification(
        'open_visits_nudge',
        { headline: '2 visits from today are still open', lines: ['9:00 AM - Ana R. - Pest Control'], day: '2026-11-04' },
        { pushOnly: true, adminOnly: true, onlyUserIds: ['owner-1'] },
      );
      expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
      expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(pushes);
      if (!pushes) {
        expect(stats.policySilenced).toBe(true);
        return;
      }
      const [adminIds, payloadFor] = PushService.sendToAdminUsers.mock.calls[0];
      expect(adminIds).toEqual(['owner-1']);
      expect(payloadFor('owner-1')).toMatchObject({
        title: '2 visits from today are still open', body: 'Tap to close out.\n9:00 AM - Ana R. - Pest Control', url: '/tech',
        tag: 'waves-open_visits_nudge-2026-11-04', sound: 'waves-reminder.caf', priority: 'normal',
      });
    } finally {
      delete process.env.GATE_OWNER_NUDGE_BANNER;
      gateSpy.mockRestore();
    }
  });

  test('onlyUserIds naming nobody who is active sends no push (the nudge then falls back to the text)', async () => {
    const PushService = require('../services/push-notifications');
    const bellPolicy = require('../services/notification-bell-policy');
    const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(false);
    db.mockImplementation((table) => (
      table === 'technicians' ? tableMock([{ id: 'admin-2', role: 'admin' }]) : tableMock([])
    ));
    PushService.sendToAdminUsers.mockClear();
    try {
      const stats = await triggerNotification('open_visits_nudge', { headline: 'x', lines: [], day: '2026-11-04' }, { pushOnly: true, onlyUserIds: ['owner-1'] });
      expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
      expect(stats.push?.sent ?? 0).toBe(0);
    } finally {
      gateSpy.mockRestore();
    }
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

  // GATE_ALERT_CLAUDE_FAULTS (owner 2026-11-02): a registry fault marked "Claude fixes this" that the bell policy drops
  // is written to Claude's queue instead: one row, stamped, keyed like the bell write, no push, no muted record.
  describe('a dropped Claude fault goes to Claude\'s queue (GATE_ALERT_CLAUDE_FAULTS)', () => {
    const run = async ({ gate = 'true', key = 'property_lookup_canary_failed', payload = { failures: ['golden_addr:Example (no parcel)'] }, opts = {} } = {}) => {
      const NotificationService = require('../services/notification-service');
      const PushService = require('../services/push-notifications');
      const bellPolicy = require('../services/notification-bell-policy');
      const gateSpy = jest.spyOn(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
      const allowSpy = jest.spyOn(bellPolicy, 'bellAllowed').mockResolvedValue(false);
      const auditInsert = jest.fn(async () => []);
      db.mockImplementation((table) => (
        table === 'audit_log' ? { insert: auditInsert }
          : table === 'technicians' ? tableMock([{ id: 'admin-1', role: 'admin' }]) : tableMock([])
      ));
      NotificationService.notifyAdmin.mockClear();
      PushService.sendToAdminUsers.mockClear();
      if (gate) process.env.GATE_ALERT_CLAUDE_FAULTS = gate;
      process.env.GATE_ALERT_CATALOG = 'watch';
      try {
        const stats = await triggerNotification(key, payload, opts);
        return { stats, notifyAdmin: NotificationService.notifyAdmin, push: PushService.sendToAdminUsers, auditInsert };
      } finally {
        delete process.env.GATE_ALERT_CLAUDE_FAULTS;
        delete process.env.GATE_ALERT_CATALOG;
        gateSpy.mockRestore(); allowSpy.mockRestore();
      }
    };

    test('gate on: one stamped row, keyed like the bell write, no push and no muted record', async () => {
      const onBell = jest.fn();
      const { stats, notifyAdmin, push, auditInsert } = await run({ opts: { dedupeKey: 'property-lookup-canary:2026-11-02', onBell } });
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      const [category, title, , options] = notifyAdmin.mock.calls[0];
      expect(category).toBe(TRIGGER_REGISTRY.property_lookup_canary_failed.category);
      expect(title).toBe('Estimator data canary: county parser regression');
      expect(options.dedupeKey).toBe('property-lookup-canary:2026-11-02');
      expect(options.metadata).toMatchObject({ triggerKey: 'property_lookup_canary_failed', feed: 'activity', who: 'claude', severity: 'broken', claudeQueue: 'property_lookup_canary_failed' });
      expect(push).not.toHaveBeenCalled();
      expect(auditInsert).not.toHaveBeenCalled();
      expect(onBell).toHaveBeenCalledWith(true);
      expect(stats).toEqual({ bellWritten: true, push: { sent: 0, skipped: 'claude_queue' }, policySilenced: true, claudeQueue: true });
    });

    test('gate off: dropped exactly as before', async () => {
      const { stats, notifyAdmin, auditInsert } = await run({ gate: null });
      expect(notifyAdmin).not.toHaveBeenCalled();
      expect(auditInsert).toHaveBeenCalledTimes(1);
      expect(stats.push).toEqual({ sent: 0, skipped: 'bell_policy' });
    });

    test('gate on: an unmarked trigger, a left-out trigger and a push-only retry are dropped as before', async () => {
      for (const args of [
        { key: 'dashboard_alert', payload: { title: 'x', body: 'y' } },
        { key: 'service_report_pdf_failed', payload: { scopeCustomerId: 'c-1', customerName: 'Pat Example', serviceLabel: 'Pest', errorMessage: 'render timeout' } },
        { opts: { pushOnly: true } },
      ]) {
        const { stats, notifyAdmin } = await run(args);
        expect(notifyAdmin).not.toHaveBeenCalled();
        expect(stats.push).toEqual({ sent: 0, skipped: 'bell_policy' });
      }
    });

    test('gate on: a failed write reports bellWritten false (the canary then holds its counters and retries)', async () => {
      const NotificationService = require('../services/notification-service');
      NotificationService.notifyAdmin.mockImplementationOnce(async () => null);
      const { stats } = await run();
      expect(stats).toMatchObject({ bellWritten: false, claudeQueue: true });
    });
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

// GATE_BELL_BANNERS (bell-banners.js): three bell-only alerts also send a phone banner, built from the written row's words.
describe('bell banner triggers', () => {
  const PushService = require('../services/push-notifications');
  const recipients = [];
  const withRecipients = (rows) => {
    recipients.length = 0;
    db.mockImplementation((table) => {
      if (table !== 'technicians') return tableMock([]);
      const chain = tableMock(rows);
      const where = chain.where;
      chain.where = jest.fn((cond) => { recipients.push(cond); return where(cond); });
      return chain;
    });
  };
  const bannerPayload = { alertRowId: 'n-42', alertTitle: 'Reply to Pat S. on Facebook', alertBody: 'Facebook: can you call me?', alertLink: '/admin/communications#tab=messenger&thread=t-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    withRecipients([{ id: 'admin-1', role: 'admin' }]);
  });

  test('builds prefer the written row\'s words and keep today\'s shapes without them', () => {
    const { sms_operational_followup: sms, call_commitment_overdue: calls, messenger_reply: fb } = TRIGGER_REGISTRY;
    expect(sms.build({ customerId: 'c-1', ...bannerPayload })).toEqual({ title: bannerPayload.alertTitle, body: bannerPayload.alertBody, link: bannerPayload.alertLink });
    expect(calls.build({ count: 3, summary: 'old', ...bannerPayload })).toEqual({ title: bannerPayload.alertTitle, body: bannerPayload.alertBody, link: bannerPayload.alertLink });
    expect(fb.build(bannerPayload)).toEqual({ title: bannerPayload.alertTitle, body: bannerPayload.alertBody, link: bannerPayload.alertLink });
    // No alert fields: the shapes the registry always had.
    expect(sms.build({ customerId: 'c 1' })).toEqual({
      title: 'An SMS request needs follow-up',
      body: 'Open the customer profile to verify completion or take the next step.',
      link: '/admin/customers?customerId=c%201&tab=comms',
    });
    expect(calls.build({ count: 3 }).title).toBe('3 promises to callers are overdue');
    expect(calls.build({}).title).toBe('A promise to a caller is overdue');
    expect(calls.build({ summary: 'Call Pat S. back.' }).body).toBe('Call Pat S. back.');
    expect(calls.build({}).link).toBe('/admin/communications#tab=owed');
    expect(fb.build({}).link).toBe('/admin/communications#tab=messenger');
  });

  test('messenger_reply is a needs-you customer contact for a person, closed by the Messenger inbox, and admin-only like its bell', () => {
    const fb = TRIGGER_REGISTRY.messenger_reply;
    expect(fb).toEqual(expect.objectContaining({ label: 'Facebook message', category: 'alert', priority: 'high', group: 'Communication' }));
    expect(fb.techVisible).toBeUndefined();
    expect(fb.rule).toEqual({ area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'customer_answered', closedBy: 'server/services/messenger-inbox.js', contact: true });
    // It sits right after sms_reply.
    const keys = Object.keys(TRIGGER_REGISTRY);
    expect(keys.indexOf('messenger_reply')).toBe(keys.indexOf('sms_reply') + 1);
  });

  test('new_lead_email (GATE_RING_NEW_CONTACTS) builds from the written row, is admin-only, and pushes with the New lead sound', async () => {
    const lead = TRIGGER_REGISTRY.new_lead_email;
    expect(lead).toEqual(expect.objectContaining({ category: 'new_lead', priority: 'high', group: 'Leads & Sales', adminRoleOnly: true }));
    expect(lead.rule).toEqual({ area: 'Leads', severity: 'needs-you', who: 'person', expiryDays: 30 });
    expect(lead.build(bannerPayload)).toEqual({ title: bannerPayload.alertTitle, body: bannerPayload.alertBody, link: bannerPayload.alertLink });
    expect(lead.build({}).link).toBe('/admin/email');
    await triggerNotification('new_lead_email', bannerPayload, { pushOnly: true, adminOnly: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    const sent = PushService.sendToAdminUsers.mock.calls.at(-1)[1]('admin-1');
    expect(sent).toMatchObject({ title: bannerPayload.alertTitle, tag: 'waves-new_lead_email-n-42', sound: 'waves-lead.caf' });
  });

  test('the banner is tagged by its row, so a refresh ring replaces it, and a second row never does', () => {
    expect(__private.pushTagFor('messenger_reply', { alertRowId: 'n-42' })).toBe('waves-messenger_reply-n-42');
    expect(__private.pushTagFor('call_commitment_overdue', { alertRowId: 'n-43' })).toBe('waves-call_commitment_overdue-n-43');
    expect(__private.pushTagFor('messenger_reply', { alertRowId: 'n-42' })).not.toBe(__private.pushTagFor('messenger_reply', { alertRowId: 'n-44' }));
    // Without a row id the old behavior stands.
    expect(__private.pushTagFor('messenger_reply', {})).toBe('waves-messenger_reply');
  });

  test('pushOnly sends the row\'s words with its sound, re-alerts on a repeat, and writes no bell', async () => {
    await triggerNotification('messenger_reply', bannerPayload, { pushOnly: true, adminOnly: true });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1);
    const sent = PushService.sendToAdminUsers.mock.calls[0][1]('admin-1');
    expect(sent).toMatchObject({ title: bannerPayload.alertTitle, body: bannerPayload.alertBody, url: bannerPayload.alertLink, tag: 'waves-messenger_reply-n-42', renotify: true, sound: 'waves-text.caf' });
  });

  test('the two reminders keep their reminder sound', async () => {
    for (const key of ['sms_operational_followup', 'call_commitment_overdue']) {
      PushService.sendToAdminUsers.mockClear();
      await triggerNotification(key, { ...bannerPayload, customerId: null }, { pushOnly: true, adminOnly: true });
      expect(PushService.sendToAdminUsers.mock.calls[0][1]('admin-1')).toMatchObject({ sound: 'waves-reminder.caf', tag: `waves-${key}-n-42` });
    }
  });

  test('adminOnly keeps a banner off technician phones even for a tech-visible type; without it the type reaches them', async () => {
    await triggerNotification('call_commitment_overdue', bannerPayload, { pushOnly: true, adminOnly: true });
    expect(recipients).toContainEqual({ role: 'admin' });
    withRecipients([{ id: 'admin-1', role: 'admin' }]);
    await triggerNotification('call_commitment_overdue', bannerPayload, { pushOnly: true });
    expect(recipients).not.toContainEqual({ role: 'admin' });
  });

  test('a test account\'s customer gets no banner', async () => {
    jest.resetModules();
    jest.doMock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: (id) => id === 'cust-test' }));
    jest.doMock('../models/db', () => jest.fn(() => tableMock([])));
    jest.doMock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({})) }));
    jest.doMock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
    const fresh = require('../services/notification-triggers');
    const Push = require('../services/push-notifications');
    const out = await fresh.triggerNotification('sms_operational_followup', { ...bannerPayload, customerId: 'cust-test' }, { pushOnly: true, adminOnly: true });
    expect(out.suppressed).toBe(true);
    expect(Push.sendToAdminUsers).not.toHaveBeenCalled();
    jest.dontMock('../services/internal-test-customers');
  });
});

// GATE_ALERT_REGISTRY_LABELS (owner 2026-11-05, admin-alert plan S1): the bell row a registry event writes also stores the
// labels its rule declares. Gate off = the metadata of today.
describe('registry labels on the bell row (GATE_ALERT_REGISTRY_LABELS)', () => {
  const LABEL_KEYS = ['area', 'severity', 'who', 'doneWhen', 'contact', 'promise', 'subject'];

  const ringMetadata = async (key, payload, { gate = 'true', opts = {} } = {}) => {
    db.mockImplementation((table) => (
      table === 'technicians' ? tableMock([{ id: 'admin-1', role: 'admin' }]) : tableMock([])
    ));
    NotificationService.notifyAdmin.mockClear();
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-1' });
    if (gate) process.env.GATE_ALERT_REGISTRY_LABELS = gate; else delete process.env.GATE_ALERT_REGISTRY_LABELS;
    try {
      await triggerNotification(key, payload, opts);
    } finally {
      delete process.env.GATE_ALERT_REGISTRY_LABELS;
    }
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    return NotificationService.notifyAdmin.mock.calls[0][3].metadata;
  };
  const missedCall = { customerId: null, name: 'Pat Sample', phone: '+19415550100', callLogId: 'call-1' };

  // Spies are undone one by one: restoreAllMocks would also reset the module mocks above (notifyAdmin's return value).
  const spies = [];
  const spy = (obj, name) => { const s = jest.spyOn(obj, name); spies.push(s); return s; };
  afterEach(() => { delete process.env.GATE_ALERT_REGISTRY_LABELS; while (spies.length) spies.pop().mockRestore(); });

  test('gate off: the metadata carries no label, exactly as before', async () => {
    const meta = await ringMetadata('customer_missed_call', missedCall, { gate: null });
    expect(Object.keys(meta).filter((k) => LABEL_KEYS.includes(k))).toEqual([]);
    expect(meta).toMatchObject({ triggerKey: 'customer_missed_call', priority: expect.any(String), payload: expect.any(Object) });
    // Any value but the exact string 'true' is off.
    const loose = await ringMetadata('customer_missed_call', missedCall, { gate: '1' });
    expect(Object.keys(loose).filter((k) => LABEL_KEYS.includes(k))).toEqual([]);
  });

  test('gate on: a customer contact row stores area, severity, who, doneWhen and contact true, and no subject', async () => {
    const off = await ringMetadata('customer_missed_call', missedCall, { gate: null });
    const on = await ringMetadata('customer_missed_call', missedCall);
    expect(on).toMatchObject({ area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'caller_reached', contact: true });
    expect(on).not.toHaveProperty('promise');
    expect(on).not.toHaveProperty('subject');
    // Only the labels are added: every key the gate-off row had keeps its value.
    for (const [k, v] of Object.entries(off)) expect(on[k]).toEqual(v);
  });

  test('gate on: a promise type stores promise true and never contact; an expiry type stores no doneWhen', async () => {
    const promise = await ringMetadata('promise_chaser', { customerName: 'Pat Sample', phone: '+19415550100', callLogId: 'call-2' });
    expect(promise).toMatchObject({ area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'promise_fulfilled', promise: true });
    expect(promise).not.toHaveProperty('contact');
    const expiring = await ringMetadata('twilio_failure', { error: 'test', to: '+19415550100' });
    expect(expiring).toMatchObject({ area: 'Comms', severity: 'needs-you', who: 'person' });
    expect(expiring).not.toHaveProperty('doneWhen');
    expect(expiring).not.toHaveProperty('contact');
    expect(expiring).not.toHaveProperty('promise');
  });

  test('gate on: an engineering type stores who claude and severity broken', async () => {
    const meta = await ringMetadata('seo_sync_failed', { error: 'sync failed' });
    expect(meta).toMatchObject({ area: 'Content', severity: 'broken', who: 'claude' });
  });

  test("gate on: the built alert's own fields win over the rule's", async () => {
    const original = TRIGGER_REGISTRY.customer_missed_call.build;
    spy(TRIGGER_REGISTRY.customer_missed_call, 'build').mockImplementation((p) => ({
      ...original(p), alert: { area: 'Schedule', doneWhen: 'own_done_when', who: 'either', extra: 'kept' },
    }));
    const meta = await ringMetadata('customer_missed_call', missedCall);
    expect(meta).toMatchObject({ area: 'Schedule', doneWhen: 'own_done_when', who: 'either', extra: 'kept', severity: 'needs-you', contact: true });
  });

  test('registryLabels drops every value the composer would refuse, and never invents a subject', () => {
    process.env.GATE_ALERT_REGISTRY_LABELS = 'true';
    const { registryLabels } = __private;
    expect(registryLabels({ rule: { area: 'Nowhere', severity: 'urgent', who: 'robot', doneWhen: 'Not Valid', contact: 'yes', promise: 1 } })).toEqual({});
    expect(registryLabels({ rule: { area: 'Billing', severity: 'urgent', who: 'person', doneWhen: 'invoice_paid', contact: false } }))
      .toEqual({ area: 'Billing', who: 'person', doneWhen: 'invoice_paid' });
    // Both declarations together are refused as a pair, like the composer; one alone is kept only as true.
    expect(registryLabels({ rule: { area: 'Comms', contact: true, promise: true } })).toEqual({ area: 'Comms' });
    expect(registryLabels({ rule: { area: 'Comms', promise: true } })).toEqual({ area: 'Comms', promise: true });
    expect(registryLabels({ rule: { area: 'Comms', subject: { type: 'customer', id: 'c-1' }, buttons: { kind: 'x' } } })).toEqual({ area: 'Comms' });
    expect(registryLabels({})).toEqual({});
    expect(registryLabels(undefined)).toEqual({});
    expect(registryLabels({ rule: null })).toEqual({});
  });

  test('a test that mocks feature-gates without the reader reads the gate as off', () => {
    process.env.GATE_ALERT_REGISTRY_LABELS = 'true';
    const gates = require('../config/feature-gates');
    const reader = gates.alertRegistryLabelsLive;
    expect(reader()).toBe(true);
    delete gates.alertRegistryLabelsLive;
    try {
      expect(__private.registryLabels(TRIGGER_REGISTRY.new_lead)).toEqual({});
    } finally {
      gates.alertRegistryLabelsLive = reader;
    }
  });

  test('every registry type: gate on stores exactly the labels its rule declares, no more', () => {
    process.env.GATE_ALERT_REGISTRY_LABELS = 'true';
    for (const [key, trigger] of Object.entries(TRIGGER_REGISTRY)) {
      const { area, severity, who, doneWhen, contact, promise } = trigger.rule;
      const expected = { area, severity, who, ...(doneWhen ? { doneWhen } : {}), ...(contact ? { contact: true } : {}), ...(promise ? { promise: true } : {}) };
      expect({ key, labels: __private.registryLabels(trigger) }).toEqual({ key, labels: expected });
    }
  });

  test('gate on: a Claude fault the bell policy drops is rescued with its labels, still Activity-only with no push', async () => {
    const PushService = PushServiceHeld;
    const bellPolicy = require('../services/notification-bell-policy');
    spy(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
    spy(bellPolicy, 'bellAllowed').mockResolvedValue(false);
    PushService.sendToAdminUsers.mockClear();
    process.env.GATE_ALERT_CLAUDE_FAULTS = 'true';
    try {
      const meta = await ringMetadata('property_lookup_canary_failed', { failures: ['golden_addr:Example (no parcel)'] }, { opts: { dedupeKey: 'property-lookup-canary:2026-11-05' } });
      expect(meta).toMatchObject({ triggerKey: 'property_lookup_canary_failed', area: 'System', severity: 'broken', who: 'claude', feed: 'activity', claudeQueue: 'property_lookup_canary_failed' });
      expect(PushService.sendToAdminUsers).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_ALERT_CLAUDE_FAULTS;
    }
  });

  test('gate on: a customer contact row still passes the policy, keeps bell: true and still pushes', async () => {
    const PushService = PushServiceHeld;
    const bellPolicy = require('../services/notification-bell-policy');
    bellPolicy.clearOverrideCache();
    spy(bellPolicy, 'isBellPolicyEnabled').mockReturnValue(true);
    process.env.GATE_CUSTOMER_ALERTS_RING = 'true';
    PushService.sendToAdminUsers.mockClear();
    db.mockImplementation((table) => (
      table === 'technicians' ? tableMock([{ id: 'admin-1', role: 'admin' }]) : tableMock([])
    ));
    const rungWith = async (gate) => {
      NotificationService.notifyAdmin.mockClear();
      NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-1' });
      PushService.sendToAdminUsers.mockClear();
      if (gate) process.env.GATE_ALERT_REGISTRY_LABELS = gate; else delete process.env.GATE_ALERT_REGISTRY_LABELS;
      try {
        const stats = await triggerNotification('bundle_quote_requested', { customerName: 'Pat Bundle', customerId: 'cust-9' });
        return { stats, options: NotificationService.notifyAdmin.mock.calls[0]?.[3], pushes: PushService.sendToAdminUsers.mock.calls.length };
      } finally { delete process.env.GATE_ALERT_REGISTRY_LABELS; }
    };
    try {
      const off = await rungWith(null);
      const on = await rungWith('true');
      expect(on.options.bell).toBe(true);
      expect(on.options.metadata).toMatchObject({ contact: true, severity: 'needs-you', who: 'person' });
      expect(on.stats.policySilenced).toBeUndefined();
      expect(on.pushes).toBe(off.pushes);
      expect(on.pushes).toBe(1);
    } finally {
      delete process.env.GATE_CUSTOMER_ALERTS_RING;
    }
  });
});
