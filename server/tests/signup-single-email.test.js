// ONE SIGNUP EMAIL (GATE_SIGNUP_SINGLE_EMAIL): what the combined email carries,
// which template it rides, the send-time answer to "does it cover
// membership.started", and the property / same-day rules. The SQL the welcome
// and added-property checks rely on is proven against real Postgres in
// signup-single-email-postgres.test.js.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  redactEmailAddresses: (s) => String(s || ''),
}));
jest.mock('../services/account-membership-email', () => ({
  buildMembershipStartedSection: jest.fn(),
  sendMembershipStarted: jest.fn(async () => ({ ok: true })),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const Membership = require('../services/account-membership-email');
const Signup = require('../services/signup-single-email');
const gates = require('../config/feature-gates');
const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');

const PLAN = {
  planName: 'WaveGuard Gold',
  variables: {
    plan_heading: 'Your plan', plan_name: 'WaveGuard Gold', plan_effective_date: 'October 6, 2026',
    plan_rate: '$89.00', plan_billing: 'monthly', plan_services: 'Quarterly Pest Control',
  },
};
const MEMBERSHIP_ARGS = { customerId: 'cust-1', membershipTier: 'Gold', monthlyRate: 89 };
const SIGNUP = { membershipEmail: MEMBERSHIP_ARGS };
const PLAN_VALUES = ['WaveGuard Gold', 'October 6, 2026', '$89.00', 'monthly', 'Quarterly Pest Control'];
const rendered = (values = PLAN_VALUES) => ({ sent: true, rendered: { text: `Your plan\n${values.join('\n')}`, html: '' } });

function chain(result) {
  const qb = {};
  for (const m of ['where', 'whereIn', 'whereRaw', 'whereNot', 'whereNull', 'orderBy']) qb[m] = jest.fn(() => qb);
  qb.first = jest.fn(async () => result);
  qb.select = jest.fn(async () => result);
  return qb;
}

function mockDb(state = {}) {
  const s = {
    customer: { id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com', account_id: null },
    estimate: { customer_name: 'Taylor Example', customer_email: 'taylor@example.com', address: '12 Palm Ave, Bradenton, FL 34205' },
    stamped: null,
    earlier: [],
    ...state,
  };
  const qbs = [];
  db.mockImplementation((table) => {
    let qb;
    if (table === 'customers') qb = chain(s.customer);
    else if (table === 'estimates') qb = chain(s.estimate);
    else if (table === 'estimate_acceptances') qb = chain(null);
    else if (table === 'scheduled_services') qb = chain(s.stamped);
    else if (table === 'email_messages') qb = chain(s.earlier);
    else throw new Error(`unexpected table ${table}`);
    qb.table = table;
    qbs.push(qb);
    return qb;
  });
  s.qbs = qbs;
  return s;
}

const earlierFull = (address = '99 Other Rd, Bradenton, FL 34205') => ({ status: 'delivered', categories: ['estimate_accepted_onboarding', 'signup_full'], payload_snapshot: { property_address: address } });
const earlierShort = (address) => ({ status: 'delivered', categories: ['estimate_accepted_onboarding', 'signup_short'], payload_snapshot: { property_address: address } });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_SIGNUP_SINGLE_EMAIL;
  Membership.buildMembershipStartedSection.mockResolvedValue(PLAN);
});

describe('gate reader and lane eligibility', () => {
  test('on only for exactly "true", read at call time', () => {
    expect(gates.signupSingleEmailLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'yes', '']) {
      process.env.GATE_SIGNUP_SINGLE_EMAIL = v;
      expect(gates.signupSingleEmailLive()).toBe(false);
    }
    process.env.GATE_SIGNUP_SINGLE_EMAIL = 'true';
    expect(gates.signupSingleEmailLive()).toBe(true);
  });

  test('gate + standard recurring signup only (annual prepay, skipped conversion, no customer stay out)', () => {
    const standardConversion = { membershipEmail: MEMBERSHIP_ARGS };
    const args = { annualPrepaySelected: false, customerId: 'cust-1', standardConversion };
    expect(Signup.signupLaneEligible(args)).toBe(false);
    process.env.GATE_SIGNUP_SINGLE_EMAIL = 'true';
    expect(Signup.signupLaneEligible(args)).toBe(true);
    expect(Signup.signupLaneEligible({ ...args, annualPrepaySelected: true })).toBe(false);
    expect(Signup.signupLaneEligible({ ...args, customerId: null })).toBe(false);
    expect(Signup.signupLaneEligible({ ...args, standardConversion: null })).toBe(false);
    expect(Signup.signupLaneEligible({ ...args, standardConversion: { membershipEmail: null } })).toBe(false);
    expect(Signup.signupLaneEligible({ ...args, standardConversion: { ...standardConversion, recurringConversionSkipped: true } })).toBe(false);
  });
});

describe('the onboarding email itself', () => {
  const base = { customerId: 'cust-1', estimateId: 'est-1', serviceLabel: 'Quarterly Pest Control', appointment: { id: 'ss-1', scheduled_date: '2026-10-06', window_start: '08:00:00' } };

  test('no signup option (gate off, other callers, the sweep): the plain email exactly as it always was', async () => {
    mockDb();
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
    const res = await sendEstimateAcceptedOnboarding(base);
    expect(res).toEqual({ sent: true });
    const call = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('estimate.accepted_onboarding');
    expect(call.categories).toEqual(['estimate_accepted_onboarding']);
    expect(Object.keys(call.payload).sort()).toEqual(['acceptance_note', 'appointment_line', 'company_phone', 'customer_portal_url', 'first_name', 'service_type']);
    expect(Membership.buildMembershipStartedSection).not.toHaveBeenCalled();
  });

  test('signup passed but the gate is off: still the plain email on the plain template', async () => {
    mockDb();
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
    await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_onboarding');
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.plan_name).toBeUndefined();
  });

  describe('gate on', () => {
    beforeEach(() => { process.env.GATE_SIGNUP_SINGLE_EMAIL = 'true'; });

    test('the full email rides the transactional_required signup template with property and plan, and no payment section', async () => {
      mockDb({ stamped: { service_address_line1: '77 Coral Way', service_address_line2: 'Unit 3', service_address_city: 'Venice', service_address_state: 'FL', service_address_zip: '34285' } });
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
      await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      const call = EmailTemplates.sendTemplate.mock.calls[0][0];
      expect(call.templateKey).toBe('estimate.accepted_signup');
      expect(call.categories).toEqual(['estimate_accepted_onboarding', 'signup_full']);
      expect(call.payload).toMatchObject({
        property_heading: 'Property',
        property_address: '77 Coral Way Unit 3, Venice, FL 34285',
        plan_name: 'WaveGuard Gold',
      });
      // The Auto Pay confirmation stays its own email: nothing of it rides here.
      for (const key of ['payment_heading', 'payment_method_label', 'payment_timing_line', 'authorization_intro', 'authorization_text', 'payment_manage_line']) {
        expect(call.payload[key]).toBeUndefined();
      }
    });

    test('the plan section is asked for the address the email is actually going to (GH Codex r6 P1)', async () => {
      mockDb();
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
      await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      const to = EmailTemplates.sendTemplate.mock.calls[0][0].to;
      expect(Membership.buildMembershipStartedSection).toHaveBeenCalledWith(expect.objectContaining({ recipientEmail: to }));
    });

    describe('does the send cover membership.started? (decided here, at send time)', () => {
      test('accepted by the provider and every plan value rendered: covered', async () => {
        mockDb();
        EmailTemplates.sendTemplate.mockResolvedValue(rendered());
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(res).toMatchObject({ sent: true, coversMembership: true });
      });

      test('the html version alone carrying the values is enough', async () => {
        mockDb();
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, rendered: { text: '', html: `<p>${PLAN_VALUES.join('</p><p>')}</p>` } });
        expect((await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP })).coversMembership).toBe(true);
      });

      test.each(PLAN_VALUES.map((v, i) => [v, i]))('accepted but the rendered email lost "%s" (an edited template): NOT covered', async (_v, index) => {
        mockDb();
        EmailTemplates.sendTemplate.mockResolvedValue(rendered(PLAN_VALUES.filter((_x, i) => i !== index)));
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(res.sent).toBe(true);
        expect(res.coversMembership).toBeUndefined();
      });

      test.each([
        ['a suppression / preference block', { sent: false, blocked: true, rendered: { text: PLAN_VALUES.join('\n') } }],
        ['a not-sent result', { sent: false, reason: 'provider_error', rendered: { text: PLAN_VALUES.join('\n') } }],
      ])('%s: NOT covered even if the values were rendered', async (_label, result) => {
        mockDb();
        EmailTemplates.sendTemplate.mockResolvedValue(result);
        expect((await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP })).coversMembership).toBeUndefined();
      });

      test('the plan section could not be built: NOT covered (nothing to have carried)', async () => {
        mockDb();
        Membership.buildMembershipStartedSection.mockResolvedValue(null);
        EmailTemplates.sendTemplate.mockResolvedValue(rendered([]));
        expect((await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP })).coversMembership).toBeUndefined();
      });

      test('the gate is off at send time: the plain email goes and it is NOT covered', async () => {
        delete process.env.GATE_SIGNUP_SINGLE_EMAIL;
        mockDb();
        EmailTemplates.sendTemplate.mockResolvedValue(rendered());
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_onboarding');
        expect(res.coversMembership).toBeUndefined();
      });

      test('the signup template is missing: the plain email goes and it is NOT covered', async () => {
        mockDb();
        EmailTemplates.sendTemplate
          .mockRejectedValueOnce(Object.assign(new Error('template not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' }))
          .mockResolvedValueOnce(rendered());
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[1][0].templateKey).toBe('estimate.accepted_onboarding');
        expect(res.coversMembership).toBeUndefined();
      });

      test('the short (added property) email carries the plan too, so it covers membership.started', async () => {
        mockDb({ earlier: [earlierFull()] });
        EmailTemplates.sendTemplate.mockResolvedValue(rendered());
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_additional_property');
        expect(res.coversMembership).toBe(true);
      });
    });

    test('property falls back to the estimate address, then the customer street address, never the nickname', async () => {
      mockDb();
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
      await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.property_address).toBe('12 Palm Ave, Bradenton, FL 34205');
      jest.clearAllMocks();
      Membership.buildMembershipStartedSection.mockResolvedValue(PLAN);
      db.mockImplementation((table) => {
        if (table === 'customers') return chain({ id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com', address_line1: '9 Home St', city: 'Sarasota', state: 'FL', zip: '34236', profile_label: 'Primary' });
        if (table === 'estimates') return chain({ address: '' });
        return chain(null);
      });
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
      await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.property_address).toBe('9 Home St, Sarasota, FL 34236');
    });

    test('a section that cannot be built, or a builder that throws, never blocks the email', async () => {
      mockDb();
      Membership.buildMembershipStartedSection.mockRejectedValue(new Error('boom'));
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(res.sent).toBe(true);
      expect(res.coversMembership).toBeUndefined();
    });

    describe('several properties on one day', () => {
      test('a later acceptance the same ET day for a DIFFERENT property gets the short email, no app section', async () => {
        mockDb({ earlier: [earlierFull()] });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, acceptanceId: 'acc-2', signup: SIGNUP });
        const call = EmailTemplates.sendTemplate.mock.calls[0][0];
        expect(call.templateKey).toBe('estimate.accepted_additional_property');
        expect(call.categories).toEqual(['estimate_accepted_onboarding', 'signup_short']);
        expect(call.payload).toMatchObject({ property_street: '12 Palm Ave', property_address: '12 Palm Ave, Bradenton, FL 34205' });
        expect(call.idempotencyKey).toBe('estimate.accepted_onboarding:est-1:acc:acc-2');
      });

      test('a SAME-property add-on (pest in the morning, lawn in the afternoon) gets the full email, whether the earlier one was full or short', async () => {
        for (const earlier of [[earlierFull('12 PALM Ave,  Bradenton, FL 34205')], [earlierFull(), earlierShort('12 Palm Ave, Bradenton, FL 34205')]]) {
          mockDb({ earlier });
          EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
          await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
          expect(EmailTemplates.sendTemplate.mock.calls.pop()[0].templateKey).toBe('estimate.accepted_signup');
        }
      });

      test('no earlier full email today (or none delivered): the full email', async () => {
        mockDb({ earlier: [] });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_signup');
      });

      test.each([
        ['sent', { status: 'sent' }],
        ['delivered', { status: 'delivered' }],
        ['delivered then an unsubscribe / spam report', { status: 'spam_report' }],
        ['blocked by the provider with a retry scheduled', { status: 'failed', provider_retry_next_at: new Date(Date.now() + 600000) }],
        ['a retry claimed and in flight', { status: 'queued', provider_retry_count: 1 }],
      ])('an earlier full email that was accepted for sending (%s) makes this an added property: the short email', async (_label, fields) => {
        mockDb({ earlier: [{ ...earlierFull(), ...fields }] });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_additional_property');
      });

      test.each([
        ['bounced', { status: 'bounced' }],
        ['dropped', { status: 'dropped' }],
        ['blocked', { status: 'blocked' }],
        ['failed with no retry', { status: 'failed' }],
        ['failed and the retry rail exhausted', { status: 'failed', provider_retry_next_at: null, provider_retry_exhausted_at: new Date() }],
        ['queued for the first time (no retry yet)', { status: 'queued', provider_retry_count: 0 }],
      ])('an earlier full email that was %s does not count: the full email', async (_label, fields) => {
        mockDb({ earlier: [{ ...earlierFull(), ...fields }] });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_signup');
      });

      test('only short emails earlier (no full one delivered): the full email', async () => {
        mockDb({ earlier: [earlierShort('99 Other Rd')] });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_signup');
      });

      test('the lookup counts only delivered signup-template emails to this customer/account and address, excluding this acceptance', async () => {
        const s = mockDb({ earlier: [] });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, acceptanceId: 'acc-9', signup: SIGNUP });
        const q = s.qbs.find((x) => x.table === 'email_messages');
        expect(q.whereIn).toHaveBeenCalledWith('template_key', ['estimate.accepted_signup', 'estimate.accepted_additional_property']);
        expect(q.whereIn).toHaveBeenCalledWith('recipient_id', ['cust-1']);
        expect(q.whereIn).toHaveBeenCalledWith('status', ['sent', 'delivered', 'opened', 'clicked', 'spam_report', 'unsubscribed', 'failed', 'queued']);
        expect(q.whereRaw).toHaveBeenCalledWith('lower(recipient_email_snapshot) = ?', ['taylor@example.com']);
        expect(q.whereNot).toHaveBeenCalledWith('idempotency_key', 'estimate.accepted_onboarding:est-1:acc:acc-9');
      });

      test('a later acceptance whose property cannot be named falls back to the full email', async () => {
        db.mockImplementation((table) => {
          if (table === 'customers') return chain({ id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com', account_id: null });
          if (table === 'estimates') return chain({ address: '' });
          if (table === 'email_messages') return chain([earlierFull()]);
          return chain(null);
        });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, appointment: null, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_signup');
      });

      test('customers on the same account count as the same customer', async () => {
        const s = mockDb({ customer: { id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com', account_id: 'acct-1' } });
        db.mockImplementation((table) => {
          const rows = table === 'customers' ? s.customer : table === 'estimates' ? s.estimate : [];
          const qb = chain(rows);
          if (table === 'customers') qb.select = jest.fn(async () => [{ id: 'cust-1' }, { id: 'cust-2' }]);
          qb.table = table; s.qbs.push(qb);
          return qb;
        });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(s.qbs.find((x) => x.table === 'email_messages').whereIn).toHaveBeenCalledWith('recipient_id', ['cust-1', 'cust-2']);
      });
    });

    describe('fallbacks', () => {
      test('no email address anywhere: nothing sent, not covered', async () => {
        db.mockImplementation((table) => {
          if (table === 'customers') return chain({ id: 'cust-1', first_name: 'Taylor', email: '', account_id: null, is_primary_profile: true });
          if (table === 'estimates') return chain({ customer_name: 'Taylor', customer_email: '' });
          return chain(null);
        });
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(res).toEqual({ sent: false, outcome: 'no_address' });
        expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
      });

      test('provider failure: failed outcome and not covered (the route then sends membership.started)', async () => {
        mockDb();
        EmailTemplates.sendTemplate.mockRejectedValue(Object.assign(new Error('nope'), { status: 503 }));
        expect(await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP })).toMatchObject({ sent: false, outcome: 'failed' });
      });

      test('the failed result never claims coverage', async () => {
        mockDb();
        EmailTemplates.sendTemplate.mockRejectedValue(Object.assign(new Error('nope'), { status: 503 }));
        expect((await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP })).coversMembership).toBeUndefined();
      });

      test.each([
        ['the signup template', 'estimate.accepted_signup', {}],
        ['the short template', 'estimate.accepted_additional_property', { earlier: [earlierFull()] }],
      ])('%s missing: the customer still gets the plain onboarding email', async (_label, key, state) => {
        mockDb(state);
        EmailTemplates.sendTemplate
          .mockRejectedValueOnce(Object.assign(new Error('template not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' }))
          .mockResolvedValueOnce({ sent: true });
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe(key);
        const retry = EmailTemplates.sendTemplate.mock.calls[1][0];
        expect(retry.templateKey).toBe('estimate.accepted_onboarding');
        expect(retry.categories).toEqual(['estimate_accepted_onboarding']);
        expect(retry.payload.plan_name).toBeUndefined();
        expect(res.sent).toBe(true);
      });
    });
  });
});
