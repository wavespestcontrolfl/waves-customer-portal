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
    // Shortened at a word with a visible ellipsis, never shaved mid-word.
    expect(title).toBe('Comms — send Bartholomew-Alexander… the estimate');
  });

  test('every Waves commitment kind has its own wording, none falls through to the generic one', async () => {
    const { COMMITMENT_KINDS, kindBelongsToParty } = require('../services/call-commitments');
    for (const kind of COMMITMENT_KINDS.filter((k) => k !== 'other' && kindBelongsToParty('waves', k))) {
      await ring({ row: { kind } });
      expect(lastCall()[1]).not.toBe('Comms — follow up with Albert Clark');
    }
    await ring({ row: { kind: 'send_reschedule_link', evidence: [{ quote: 'send me a link to move my appointment' }] } });
    expect(lastCall()[1]).toBe('Schedule — send Albert Clark the reschedule link');
    expect(lastCall()[2]).toBe('“send me a link to move my appointment” (Sep 29) — no reschedule link sent yet.');
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

describe('fitAction name shortening', () => {
  const { fitAction } = require('../services/admin-alert-names');
  const send = [(n) => `send ${n} the estimate`];
  test('a long name is cut at a word with an ellipsis', () => {
    expect(fitAction('Comms', 'Bartholomew-Alexander Montgomery-Featherstonehaugh', send)).toBe('send Bartholomew-Alexander… the estimate');
  });
  test('when even the first word does not fit it is cut and gets the ellipsis', () => {
    const action = fitAction('Comms', 'Bartholomew-Alexander-Montgomery-Featherstonehaugh-Smythe', send);
    expect(action).toMatch(/^send Bartholomew\S*… the estimate$/);
    expect(`Comms — ${action}`.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
  });
  test('a name that fits is left alone', () => {
    expect(fitAction('Comms', 'Albert Clark', send)).toBe('send Albert Clark the estimate');
  });
});

describe('payment_failed bell', () => {
  const { build } = TRIGGER_REGISTRY.payment_failed;

  test('the customer leads the headline and the link opens the invoice', () => {
    const built = build({ amount: 104.98, customerName: 'Albert Clark', customerId: 'c1', invoiceId: 'inv1', reason: 'Your card was declined.' });
    expect(built).toEqual({ title: "Billing — Albert Clark's $104.98 payment failed", body: 'Your card was declined.', detail: 'Your card was declined.', link: '/admin/invoices?invoice=inv1' });
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

  test('a two-sentence reason gives a one-sentence why; the whole reason rides in detail', () => {
    const reason = 'Your card was declined. Please try a different card or contact your bank.';
    const built = build({ amount: 85, customerName: 'Albert Clark', customerId: 'c1', invoiceId: 'inv1', reason });
    expect(built.body).toBe('Your card was declined.');
    expect(built.detail).toBe(reason);
    const { composeAdminAlert } = require('../services/admin-alert-compose');
    expect(() => composeAdminAlert({ area: 'Billing', action: 'x', why: built.body, severity: 'needs-you', link: built.link,
      subject: { type: 'invoice', id: 'inv1' }, doneWhen: 'invoice_followed_up', who: 'person' })).not.toThrow();
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

  test('copy the rule refuses keeps the structured fields; only the wording falls back', () => {
    const copy = prepayCoverageCopy(visit, 'manual_series_stamp_missing', 'Albert [Clark]');
    expect(copy.title).toBe('Prepaid coverage needs review for Albert [Clark] on Oct 6');
    expect(copy.link).toBe('/admin/dispatch?tab=schedule&date=2026-10-06&appointment=visit-1');
    expect(copy.metadata).toMatchObject({ area: 'Schedule', severity: 'needs-you', subject: { type: 'visit', id: 'visit-1' },
      doneWhen: 'coverage_reconciled', who: 'person' });
    expect(copy.metadata.ruleViolations).toEqual(expect.arrayContaining([expect.stringContaining('bracket_tag')]));
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

// Codex r1 P2: severity and lifecycle follow the accept's outcome. An accept with nothing to do
// is an FYI row (needs-me leaves it out); only a real next step is needs-you, and its
// done-when is a name that already exists elsewhere (no new predicate).
describe('estimate accepted: severity follows the outcome', () => {
  const base = { customerName: 'John Cowley', waveguardTier: 'Silver', monthlyTotal: 104.98 };
  const needsYou = [
    ['payer invoice not delivered', { payerBilled: true, invoiceLinkDelivered: false }, 'invoice_followed_up'],
    ['commercial plan, office to schedule', { waveguardTier: 'Commercial' }, 'visit_booked'],
    ['commercial plan, pay link sent', { waveguardTier: 'Commercial', invoicePayUrl: '/pay/x' }, 'visit_booked'],
    ['recurring invoice not sent', { billByInvoice: true }, 'invoice_followed_up'],
    ['one-time invoice not sent', { billByInvoice: true, treatAsOneTime: true, serviceLabel: 'Rodent Service' }, 'invoice_followed_up'],
    ['one-time with no booking link or slot', { treatAsOneTime: true, serviceLabel: 'Rodent Service' }, 'visit_booked'],
    ['annual prepay, no invoice', { billingTerm: 'prepay_annual', annualPrepayAmount: 660 }, 'invoice_followed_up'],
    ['recurring fallthrough', {}, 'invoice_followed_up'],
  ];
  const nothingToDo = [
    ['termite signature pending', { invoiceKind: 'annual_prepay_deferred' }],
    ['payer invoice delivered', { payerBilled: true, invoiceLinkDelivered: true }],
    ['settled by credit', { invoiceSettledByCredit: true }],
    ['pay link going out (recurring)', { billByInvoice: true, invoiceMode: true, invoiceLinkDelivered: true }],
    ['pay link going out (one-time)', { billByInvoice: true, invoiceMode: true, invoiceLinkDelivered: true, treatAsOneTime: true, serviceLabel: 'Rodent Service' }],
    ['one-time appointment confirmed', { treatAsOneTime: true, serviceLabel: 'Rodent Service', reservationCommitted: true }],
    ['one-time booking link sent', { treatAsOneTime: true, serviceLabel: 'Rodent Service', bookingUrl: '/book/x' }],
    ['prepay paid by card', { billingTerm: 'prepay_annual', prepayChargeOutcome: 'paid' }],
    ['prepay paid by credit', { billingTerm: 'prepay_annual', prepayChargeOutcome: 'paid', prepayCoveredByCredit: true }],
    ['prepay bank processing', { billingTerm: 'prepay_annual', prepayChargeOutcome: 'processing' }],
    ['prepay outcome ambiguous', { billingTerm: 'prepay_annual', prepayChargeOutcome: 'ambiguous' }],
    ['prepay charge deferred', { billingTerm: 'prepay_annual', prepayChargeOutcome: 'deferred' }],
    ['prepay invoice created', { billingTerm: 'prepay_annual', invoiceMode: true, invoiceLinkDelivered: true }],
    ['setup fee deferred', { setupFeeDeferred: true }],
    ['invoice created, pay link sent', { invoiceMode: true, invoiceLinkDelivered: true }],
    ['invoice created, link not delivered', { invoiceMode: true, invoiceLinkDelivered: false }],
    ['after-visit billing, auto pay off', { afterVisitBilling: true, afterVisitDisabled: true }],
    ['after-visit billing, auto pay paused', { afterVisitBilling: true, afterVisitPaused: true }],
    ['after-visit billing', { afterVisitBilling: true }],
  ];

  test.each(needsYou)('a real next step is needs-you with an existing done-when: %s', (_name, over, doneWhen) => {
    const payload = buildAcceptNotificationPayload({ ...base, ...over });
    expect(payload.adminDoneWhen).toBe(doneWhen);
    expect(payload.adminWhy).toMatch(/[Nn]ext:/);
  });

  test.each(nothingToDo)('nothing to do carries no done-when: %s', (_name, over) => {
    const payload = buildAcceptNotificationPayload({ ...base, ...over });
    expect(payload.adminDoneWhen ?? null).toBeNull();
    expect(payload.adminWhy).not.toMatch(/Next:/);
  });

  // The route's own raise, with the real composer: severity from adminDoneWhen, fyiRow so the
  // bell still rings for every accept.
  const raise = (over) => {
    const payload = buildAcceptNotificationPayload({ ...base, ...over });
    return require('../services/admin-alert-compose').raiseAdminAlert('estimate', {
      area: 'Estimates', action: payload.adminAction, why: payload.adminWhy,
      severity: payload.adminDoneWhen ? 'needs-you' : 'fyi', link: '/admin/estimates?estimateId=e1',
      subject: { type: 'estimate', id: 'e1' }, doneWhen: payload.adminDoneWhen || 'already_done', who: 'person',
    }, { icon: '\u2705', bell: true, fyiRow: true, detail: payload.adminBody, metadata: { estimateId: 'e1' } });
  };

  test('a real next step rings a needs-you row', async () => {
    await raise({});
    const [, , , opts] = lastCall();
    expect(opts).toMatchObject({ bell: true, link: '/admin/estimates?estimateId=e1',
      metadata: { severity: 'needs-you', doneWhen: 'invoice_followed_up', subject: { type: 'estimate', id: 'e1' } } });
  });

  test('nothing to do still rings, as an FYI row that needs-me leaves out', async () => {
    await raise({ billingTerm: 'prepay_annual', prepayChargeOutcome: 'paid' });
    const [, title, body, opts] = lastCall();
    expect(title).toBe('Estimates — John Cowley accepted Silver annual prepay');
    expect(body).toBe('Paid by card on file; nothing to do.');
    expect(opts).toMatchObject({ bell: true, metadata: { severity: 'fyi', doneWhen: 'already_done' } });
  });
});
