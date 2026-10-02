// Owner audit 2026-10-01: admin alerts say WHO and WHAT, so they are actionable without
// opening anything. Four prod alerts that named neither: the SMS / email follow-up bells,
// "Payment failed", "Prepaid coverage needs review", and "Estimate accepted". All names are
// synthetic. docs/admin-notifications.md is the contract (composeAdminAlert throws under
// NODE_ENV=test on any breach, so a green run proves the rule too).
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const NotificationService = require('../services/notification-service');
const { MAX_HEADLINE_CHARS, MAX_WHY_CHARS } = require('../services/admin-alert-compose');
const { ringOverdueBell } = require('../services/sms-operational-actions');
const { TRIGGER_REGISTRY } = require('../services/notification-triggers');
const { buildAcceptNotificationPayload } = require('../routes/estimate-public');
const { _prepayCoverageCopy: prepayCoverageCopy } = require('../services/schedule-integrity-watchdog');

const trxFor = (customer) => () => ({ where: () => ({ first: async () => customer }) });
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const sourceAt = new Date('2026-09-29T14:46:00Z'); // 10:46 AM ET

const row = (extra = {}) => ({
  id: 'commit-1', kind: 'send_estimate', description: 'send the estimate',
  evidence: [{ quote: 'Swarming termites mobile home tenting free estimate', matched: true }],
  sms_context: { basis: 'ask' }, ...extra,
});
const ring = (over = {}, customer = { first_name: 'Albert', last_name: 'Clark' }) => ringOverdueBell(trxFor(customer), {
  row: row(over.row), message: { id: 'sms-1', customer_id: CUSTOMER_ID, created_at: sourceAt, message_body: 'Hi, swarming termites in my mobile home, can I get a free estimate?' },
  verdict: { verdict: 'open', ...over.verdict }, dedupeKey: 'sms-commitment:commit-1', ...over.args,
});
const lastCall = () => NotificationService.notifyAdmin.mock.calls.at(-1);

beforeEach(() => NotificationService.notifyAdmin.mockClear());

describe('follow-up bell (SMS and email share ringOverdueBell)', () => {
  test('an unanswered estimate request names the customer and quotes their words', async () => {
    await ring();
    const [category, title, body, opts] = lastCall();
    expect(category).toBe('alert');
    expect(title).toBe('Comms — send Albert Clark the estimate');
    expect(body).toBe('“Swarming termites mobile home tenting free estimate” (Sep 29) — no estimate sent yet.');
    expect(body.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
    expect(opts.detail).toContain('Albert Clark');
    expect(opts.detail).toContain('“Swarming termites mobile home tenting free estimate”');
    expect(opts.detail).toContain('do not establish completion');
  });

  test('dedupe, bell, link and metadata are unchanged; the rule stamps are added', async () => {
    await ring();
    const [, , , opts] = lastCall();
    expect(opts).toMatchObject({ bell: true, dedupeKey: 'sms-commitment:commit-1', dedupeWindowMs: 24 * 3600 * 1000, refreshOnDedupe: true,
      link: `/admin/customers?customerId=${CUSTOMER_ID}&tab=comms` });
    expect(opts.metadata).toMatchObject({ triggerKey: 'sms_operational_followup', customerId: CUSTOMER_ID, sms_log_id: 'sms-1',
      commitment_id: 'commit-1', kind: 'send_estimate', verification: 'open',
      area: 'Comms', severity: 'needs-you', who: 'person', doneWhen: 'promise_fulfilled', subject: { type: 'customer', id: CUSTOMER_ID } });
  });

  test('a staff promise is worded as ours, and a late finish says so', async () => {
    await ring({ row: { kind: 'other', evidence: [{ quote: "Gonna knock out your quarterly spray tomorrow" }], sms_context: { basis: 'promise' } },
      verdict: { late: true, verdict: 'fulfilled' } });
    const [, title, body, opts] = lastCall();
    expect(title).toBe('Comms — follow up with Albert Clark');
    expect(body).toBe('We said “Gonna knock out your quarterly spray tomorrow” (Sep 29) — done only after the promised time.');
    expect(opts.detail).toContain('only after the promised deadline');
    expect(opts.metadata.verification).toBe('kept_late');
  });

  test('an uncertain verdict says the agent cannot tell', async () => {
    await ring({ row: { kind: 'callback', evidence: [{ quote: 'please call me back about the gate' }] }, verdict: { verdict: 'uncertain' } });
    const [, title, body] = lastCall();
    expect(title).toBe('Comms — call Albert Clark back');
    expect(body).toBe("“please call me back about the gate” (Sep 29) — can't tell if it was done.");
  });

  test('scheduling kinds land in Schedule', async () => {
    await ring({ row: { kind: 'schedule_visit', evidence: [{ quote: 'can you come Friday morning' }] } });
    expect(lastCall()[1]).toBe("Schedule — schedule Albert Clark's visit");
  });

  test('contact details in the quote are masked, in the why and in the detail', async () => {
    await ring({ row: { evidence: [{ quote: 'text the estimate to 941-555-0142 or dana@example.test please' }] } });
    const [, , body, opts] = lastCall();
    for (const text of [body, opts.detail]) {
      expect(text).not.toContain('941-555-0142');
      expect(text).not.toContain('dana@example.test');
    }
    expect(body).toContain('***0142');
  });

  test('a long quote is cut inside the 110 character why and kept whole in detail', async () => {
    const quote = 'we have wasps and ants and a leaking irrigation line near the back lanai and would love a full quote soon please';
    await ring({ row: { evidence: [{ quote }] } });
    const [, , body, opts] = lastCall();
    expect(body.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
    expect(body).toContain('…”');
    expect(body.endsWith('— no estimate sent yet.')).toBe(true);
    expect(opts.detail).toContain(`“${quote}”`);
  });

  test('a long name is cut to keep the headline inside 60 characters', async () => {
    await ring({}, { first_name: 'Bartholomew-Alexander', last_name: 'Montgomery-Featherstonehaugh' });
    const title = lastCall()[1];
    expect(title.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
    expect(title.startsWith('Comms — send Bartholomew')).toBe(true);
  });

  test('no customer on file still rings, with a generic name', async () => {
    await ring({}, null);
    expect(lastCall()[1]).toBe('Comms — send the customer the estimate');
  });

  test('an email source is worded for email with the sender name and quote', async () => {
    await ring({ row: { sms_context: { basis: 'ask' }, evidence: [{ quote: 'Could you email me the termite report', email_id: 'e1' }], kind: 'send_report' },
      args: { sourceIdField: 'email_id', triggerKey: 'email_operational_followup', dedupeKey: 'email-commitment:commit-1' } });
    const [, title, body, opts] = lastCall();
    expect(title).toBe('Comms — send Albert Clark the report');
    expect(body).toBe('“Could you email me the termite report” (Sep 29) — no report sent yet.');
    expect(opts.detail).toContain('asked by email');
    expect(opts.metadata).toMatchObject({ triggerKey: 'email_operational_followup', email_id: 'sms-1' });
    expect(opts.dedupeKey).toBe('email-commitment:commit-1');
  });

  test('falls back to the description, then the message, when no quote is stored', async () => {
    await ring({ row: { evidence: null, description: 'send the estimate for the lanai' } });
    expect(lastCall()[2]).toContain('“send the estimate for the lanai”');
    await ring({ row: { evidence: [], description: null } });
    expect(lastCall()[2]).toContain('“Hi, swarming termites in my mobile home, can I get a free estimate”');
  });
});

describe('payment_failed bell', () => {
  const { build } = TRIGGER_REGISTRY.payment_failed;

  test('the customer leads the headline and the link opens the invoice', () => {
    const built = build({ amount: 104.98, customerName: 'Albert Clark', customerId: 'c1', invoiceId: 'inv1', reason: 'Your card was declined.' });
    expect(built).toEqual({ title: "Billing — Albert Clark's $104.98 payment failed", body: 'Your card was declined.', link: '/admin/invoices?invoice=inv1' });
    expect(built.title.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
  });

  test('with no invoice the link opens the customer, never the revenue list', () => {
    expect(build({ amount: 85, customerName: 'Albert Clark', customerId: 'c1' }).link).toBe('/admin/customers?customerId=c1');
    expect(build({ amount: 85 }).link).toBe('/admin/revenue');
  });

  test('an unnamed customer reads "a customer"; a long name is cut to fit', () => {
    expect(build({ amount: 85, customerName: 'customer', customerId: 'c1' }).title).toBe("Billing — a customer's $85.00 payment failed");
    expect(build({ amount: 1234.5, customerName: 'Bartholomew-Alexander Montgomery-Featherstonehaugh' }).title.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
  });
});

describe('prepaid coverage bell', () => {
  const visit = { id: 'visit-1', customer_id: 'c1', service_date: '2026-10-06', service_type: 'Lawn Care' };

  test('names the customer and the date, and links the visit', () => {
    const copy = prepayCoverageCopy(visit, 'manual_series_stamp_missing', 'Albert Clark');
    expect(copy.title).toBe("Schedule — check Albert Clark's prepaid visit on Oct 6");
    expect(copy.why).toBe('A series payment covers it but the visit has no allocation; reconcile before billing.');
    expect(copy.link).toBe('/admin/dispatch?tab=schedule&date=2026-10-06&appointment=visit-1');
    expect(copy.detail).toContain('Reconcile the recorded payment');
    expect(copy.metadata).toMatchObject({ area: 'Schedule', subject: { type: 'visit', id: 'visit-1' }, doneWhen: 'coverage_reconciled' });
  });

  test('every issue has a one-sentence why inside the budget', () => {
    for (const issue of ['annual_coverage_unverified', 'manual_series_stamp_missing', 'manual_series_stamp_conflict']) {
      const copy = prepayCoverageCopy(visit, issue, 'Albert Clark');
      expect(copy.why.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
    }
  });

  test('an unknown customer still gets a usable headline', () => {
    expect(prepayCoverageCopy(visit, 'annual_coverage_unverified', undefined).title).toBe("Schedule — check a customer's prepaid visit on Oct 6");
  });
});

describe('estimate accepted bell', () => {
  test('says who accepted what and the next step; keeps the full state in adminBody', () => {
    const payload = buildAcceptNotificationPayload({
      customerName: 'John Cowley', waveguardTier: 'Silver', monthlyTotal: 104.98, proposedMonthlyTotal: 92.4,
    });
    expect(payload.adminAction).toBe('John Cowley accepted Silver $104.98/mo');
    expect(payload.adminWhy).toBe('Next: send the invoice and check the first visit is booked; originally quoted $92.40/mo.');
    expect(payload.adminBody).toBe('Silver WaveGuard $104.98/mo (proposed at $92.40/mo) approved. Invoice follow-up needed.');
    expect(`Estimates — ${payload.adminAction}`.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
    expect(payload.adminWhy.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
  });

  test('no price difference, no quoted note', () => {
    const payload = buildAcceptNotificationPayload({ customerName: 'John Cowley', waveguardTier: 'Gold', monthlyTotal: 89, proposedMonthlyTotal: 89,
      invoiceMode: true, invoiceLinkDelivered: true, invoicePayUrl: '/pay/x' });
    expect(payload.adminWhy).toBe('Pay link sent; nothing to do.');
  });

  test('an invoice that did not send says to send it', () => {
    const payload = buildAcceptNotificationPayload({ customerName: 'John Cowley', waveguardTier: 'Gold', monthlyTotal: 89, billByInvoice: true });
    expect(payload.adminWhy).toBe('Next: send the invoice yourself.');
  });

  test('one-time, prepay, commercial and termite accepts each say who and what', () => {
    expect(buildAcceptNotificationPayload({ customerName: 'John Cowley', treatAsOneTime: true, serviceLabel: 'Rodent Service', bookingUrl: '/book/x' }))
      .toMatchObject({ adminAction: 'John Cowley accepted Rodent Service', adminWhy: 'Booking link sent; wait for them to pick a time.' });
    expect(buildAcceptNotificationPayload({ customerName: 'John Cowley', treatAsOneTime: true, serviceLabel: 'Rodent Service' }).adminWhy)
      .toBe('Next: schedule the appointment.');
    expect(buildAcceptNotificationPayload({ customerName: 'John Cowley', waveguardTier: 'Bronze', billingTerm: 'prepay_annual', annualPrepayAmount: 660, prepayChargeOutcome: 'paid' }))
      .toMatchObject({ adminAction: 'John Cowley accepted Bronze annual prepay', adminWhy: 'Paid by card on file; nothing to do.' });
    // The amount rides along when it fits.
    expect(buildAcceptNotificationPayload({ customerName: 'Jo Cowley', waveguardTier: 'Bronze', billingTerm: 'prepay_annual', annualPrepayAmount: 660 }).adminAction)
      .toBe('Jo Cowley accepted Bronze annual prepay $660.00');
    expect(buildAcceptNotificationPayload({ customerName: 'John Cowley', waveguardTier: 'Commercial', monthlyTotal: 300 }))
      .toMatchObject({ adminAction: 'John Cowley accepted commercial $300.00/mo', adminWhy: 'Next: confirm the details and schedule the recurring visits.' });
    expect(buildAcceptNotificationPayload({ customerName: 'John Cowley', invoiceKind: 'annual_prepay_deferred', annualPrepayAmount: 1200 }))
      .toMatchObject({ adminAction: 'John Cowley accepted the termite plan', adminWhy: 'Waiting on their signature; nothing is billed yet.' });
  });

  test('a long name keeps the headline inside 60 characters', () => {
    const payload = buildAcceptNotificationPayload({ customerName: 'Bartholomew-Alexander Montgomery-Featherstonehaugh', waveguardTier: 'Silver', monthlyTotal: 104.98 });
    expect(`Estimates — ${payload.adminAction}`.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
  });

  test('the composed alert passes the rule (composeAdminAlert throws under test on a breach)', () => {
    const { composeAdminAlert } = require('../services/admin-alert-compose');
    const payload = buildAcceptNotificationPayload({ customerName: 'John Cowley', waveguardTier: 'Silver', monthlyTotal: 104.98, proposedMonthlyTotal: 92.4 });
    expect(composeAdminAlert({ area: 'Estimates', action: payload.adminAction, why: payload.adminWhy, severity: 'needs-you', link: '/admin/estimates?estimateId=e1',
      subject: { type: 'estimate', id: 'e1' }, doneWhen: 'estimate_followed_up', who: 'person' }).headline).toBe('Estimates — John Cowley accepted Silver $104.98/mo');
  });
});
