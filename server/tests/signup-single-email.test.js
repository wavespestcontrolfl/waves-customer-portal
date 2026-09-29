// ONE SIGNUP EMAIL (GATE_SIGNUP_SINGLE_EMAIL): what the combined email carries,
// when a separate email is skipped, and that every fallback still sends it.

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
jest.mock('../services/card-enrollment-email', () => ({
  buildAutopayPaymentSection: jest.fn(),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const Membership = require('../services/account-membership-email');
const CardEmail = require('../services/card-enrollment-email');
const gates = require('../config/feature-gates');
const { sendEstimateAcceptedOnboarding } = require('../services/estimate-accepted-email');
const { createSignupEmailLane, signupLaneEligible } = require('../services/signup-single-email');

const AUTH_TEXT = 'By checking this box, I authorize Waves Pest Control, LLC to save this card and charge it for future service visits.';
const PLAN = {
  planName: 'WaveGuard Gold',
  variables: {
    plan_heading: 'Your plan', plan_name: 'WaveGuard Gold', plan_effective_date: 'October 6, 2026',
    plan_rate: '$89.00', plan_billing: 'monthly', plan_services: 'Quarterly Pest Control',
  },
};
const PAYMENT = {
  authorizationText: AUTH_TEXT,
  variables: {
    payment_heading: 'Payment', payment_method_label: 'Visa ending 4242',
    payment_timing_line: 'Your card is charged monthly.', authorization_intro: 'Your Auto Pay authorization, exactly as you agreed to it:',
    authorization_text: AUTH_TEXT, payment_manage_line: 'You can turn Auto Pay off anytime.',
  },
};
const MEMBERSHIP_ARGS = { customerId: 'cust-1', membershipTier: 'Gold', monthlyRate: 89 };
const SIGNUP = { membershipEmail: MEMBERSHIP_ARGS, paymentMethodRowId: 'pm-1' };

function chain(result) {
  const qb = {};
  for (const m of ['where', 'whereIn', 'whereRaw', 'whereNot', 'whereNull', 'orderBy']) qb[m] = jest.fn(() => qb);
  qb.first = jest.fn(async () => result);
  qb.select = jest.fn(async () => result);
  return qb;
}

// Table router. `state` overrides per test.
function mockDb(state = {}) {
  const s = {
    customer: { id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com', account_id: null },
    estimate: { customer_name: 'Taylor Example', customer_email: 'taylor@example.com', address: '12 Palm Ave, Bradenton, FL 34205' },
    stamped: null,
    priorFull: null,
    acceptance: null,
    ...state,
  };
  db.mockImplementation((table) => {
    if (table === 'customers') return chain(s.customer);
    if (table === 'estimates') return chain(s.estimate);
    if (table === 'estimate_acceptances') return chain(s.acceptance);
    if (table === 'scheduled_services') return chain(s.stamped);
    if (table === 'email_messages') return chain(s.priorFull);
    throw new Error(`unexpected table ${table}`);
  });
  return s;
}

const valuesOf = (variables) => Object.entries(variables).filter(([k]) => !k.endsWith('_heading')).map(([, v]) => v);
const PLAN_TEXT = valuesOf(PLAN.variables).join('\n');
const PAYMENT_TEXT = valuesOf(PAYMENT.variables).join('\n');

function renderedWith(...parts) {
  const text = parts.join('\n');
  return { sent: true, rendered: { text, html: `<p>${text}</p>` }, message: {} };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_SIGNUP_SINGLE_EMAIL;
  Membership.buildMembershipStartedSection.mockResolvedValue(PLAN);
  CardEmail.buildAutopayPaymentSection.mockResolvedValue(PAYMENT);
});

describe('gate reader', () => {
  test('on only for exactly "true", read at call time', () => {
    expect(gates.signupSingleEmailLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'yes', '']) {
      process.env.GATE_SIGNUP_SINGLE_EMAIL = v;
      expect(gates.signupSingleEmailLive()).toBe(false);
    }
    process.env.GATE_SIGNUP_SINGLE_EMAIL = 'true';
    expect(gates.signupSingleEmailLive()).toBe(true);
    delete process.env.GATE_SIGNUP_SINGLE_EMAIL;
    expect(gates.signupSingleEmailLive()).toBe(false);
  });

  test('lane eligibility: gate + standard recurring signup only (annual prepay, skipped conversion, no customer stay out)', () => {
    const standardConversion = { membershipEmail: MEMBERSHIP_ARGS };
    const args = { annualPrepaySelected: false, customerId: 'cust-1', standardConversion };
    expect(signupLaneEligible(args)).toBe(false); // gate off
    process.env.GATE_SIGNUP_SINGLE_EMAIL = 'true';
    expect(signupLaneEligible(args)).toBe(true);
    expect(signupLaneEligible({ ...args, annualPrepaySelected: true })).toBe(false);
    expect(signupLaneEligible({ ...args, customerId: null })).toBe(false);
    expect(signupLaneEligible({ ...args, standardConversion: null })).toBe(false);
    expect(signupLaneEligible({ ...args, standardConversion: { membershipEmail: null } })).toBe(false);
    expect(signupLaneEligible({ ...args, standardConversion: { ...standardConversion, recurringConversionSkipped: true } })).toBe(false);
  });
});

describe('the onboarding email itself', () => {
  const base = { customerId: 'cust-1', estimateId: 'est-1', serviceLabel: 'Quarterly Pest Control', appointment: { id: 'ss-1', scheduled_date: '2026-10-06', window_start: '08:00:00' } };

  test('no signup option (gate off, other callers, the sweep): the email is exactly what it always was', async () => {
    mockDb();
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
    const res = await sendEstimateAcceptedOnboarding(base);
    expect(res).toEqual({ sent: true }); // no `signup` key added
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    const call = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('estimate.accepted_onboarding');
    expect(call.categories).toEqual(['estimate_accepted_onboarding']);
    expect(Object.keys(call.payload).sort()).toEqual(['acceptance_note', 'appointment_line', 'company_phone', 'customer_portal_url', 'first_name', 'service_type']);
    expect(Membership.buildMembershipStartedSection).not.toHaveBeenCalled();
    expect(CardEmail.buildAutopayPaymentSection).not.toHaveBeenCalled();
  });

  test('signup passed but the gate is off: still the plain email', async () => {
    mockDb();
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
    const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
    expect(res.signup).toBeUndefined();
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.plan_name).toBeUndefined();
    expect(Membership.buildMembershipStartedSection).not.toHaveBeenCalled();
  });

  describe('gate on', () => {
    beforeEach(() => { process.env.GATE_SIGNUP_SINGLE_EMAIL = 'true'; });

    test('first acceptance today: full email with property, plan and payment; coverage from what was rendered', async () => {
      mockDb({ stamped: { service_address_line1: '77 Coral Way', service_address_line2: 'Unit 3', service_address_city: 'Venice', service_address_state: 'FL', service_address_zip: '34285' } });
      EmailTemplates.sendTemplate.mockResolvedValue(renderedWith(PLAN_TEXT, PAYMENT_TEXT));
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      const call = EmailTemplates.sendTemplate.mock.calls[0][0];
      expect(call.templateKey).toBe('estimate.accepted_onboarding');
      expect(call.categories).toEqual(['estimate_accepted_onboarding', 'signup_full']);
      // The stamped visit address wins over the estimate address.
      expect(call.payload).toMatchObject({
        property_heading: 'Property',
        property_address: '77 Coral Way Unit 3, Venice, FL 34285',
        plan_name: 'WaveGuard Gold',
        payment_method_label: 'Visa ending 4242',
        authorization_text: AUTH_TEXT,
      });
      expect(CardEmail.buildAutopayPaymentSection).toHaveBeenCalledWith({ customerId: 'cust-1', paymentMethodRowId: 'pm-1' });
      expect(res.signup).toEqual({ short: false, planCovered: true, paymentCovered: true });
    });

    test('property falls back to the estimate address, then the customer street address, never the nickname', async () => {
      mockDb();
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
      await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.property_address).toBe('12 Palm Ave, Bradenton, FL 34205');

      jest.clearAllMocks();
      Membership.buildMembershipStartedSection.mockResolvedValue(PLAN);
      // estimate has no address → the customer's own street address
      db.mockImplementation((table) => {
        if (table === 'customers') return chain({ id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com', address_line1: '9 Home St', city: 'Sarasota', state: 'FL', zip: '34236', profile_label: 'Primary' });
        if (table === 'estimates') return chain({ address: '' });
        if (table === 'scheduled_services') return chain(null);
        if (table === 'estimate_acceptances') return chain(null);
        if (table === 'email_messages') return chain(null);
        throw new Error(table);
      });
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
      await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.property_address).toBe('9 Home St, Sarasota, FL 34236');
    });

    test('a section the delivered email does not carry is not covered (older template version)', async () => {
      mockDb();
      EmailTemplates.sendTemplate.mockResolvedValue(renderedWith('You are booked'));
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(res.signup).toEqual({ short: false, planCovered: false, paymentCovered: false });
    });

    test('a section counts only when EVERY one of its values is in the delivered email (an edit that kept one row is not enough)', async () => {
      mockDb();
      // plan name and rate present, cadence/services/date dropped; authorization present but not the method label or timing
      EmailTemplates.sendTemplate.mockResolvedValue(renderedWith('WaveGuard Gold', '$89.00', AUTH_TEXT));
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(res.signup).toEqual({ short: false, planCovered: false, paymentCovered: false });
    });

    test('plan carried but authorization text missing: only the plan is covered', async () => {
      mockDb();
      EmailTemplates.sendTemplate.mockResolvedValue(renderedWith(PLAN_TEXT));
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(res.signup).toEqual({ short: false, planCovered: true, paymentCovered: false });
    });

    test('authorization text is matched word for word, including in the HTML-escaped copy', async () => {
      mockDb();
      const tricky = 'I authorize Waves & Co "as agreed" — it\'s <final>.';
      CardEmail.buildAutopayPaymentSection.mockResolvedValue({ ...PAYMENT, authorizationText: tricky, variables: { ...PAYMENT.variables, authorization_text: tricky } });
      const escaped = 'I authorize Waves &amp; Co &quot;as agreed&quot; — it&#39;s &lt;final&gt;.';
      CardEmail.buildAutopayPaymentSection.mockResolvedValue({ authorizationText: tricky, variables: { authorization_text: tricky } });
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, rendered: { text: '', html: `<p>${PLAN_TEXT}</p><p>${escaped}</p>` } });
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(res.signup.paymentCovered).toBe(true);
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, rendered: { text: '', html: `<p>${PLAN_TEXT}</p><p>I authorize Waves</p>` } });
      expect((await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP })).signup.paymentCovered).toBe(false);
    });

    test('a deduped earlier send counts from its stored snapshot', async () => {
      mockDb();
      EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, deduped: true, message: { text_snapshot: `${PLAN_TEXT}\n${PAYMENT_TEXT}` } });
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(res.signup).toMatchObject({ planCovered: true, paymentCovered: true });
    });

    test('no payment method to fold in (already enrolled, gate off, other method in charge): no payment section', async () => {
      mockDb();
      EmailTemplates.sendTemplate.mockResolvedValue(renderedWith(PLAN_TEXT));
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: { membershipEmail: MEMBERSHIP_ARGS, paymentMethodRowId: null } });
      expect(CardEmail.buildAutopayPaymentSection).not.toHaveBeenCalled();
      expect(EmailTemplates.sendTemplate.mock.calls[0][0].payload.authorization_text).toBeUndefined();
      expect(res.signup.paymentCovered).toBe(false);
    });

    test('a payment section that cannot be built (no enrollment-scoped consent) is simply absent', async () => {
      mockDb();
      CardEmail.buildAutopayPaymentSection.mockResolvedValue(null);
      EmailTemplates.sendTemplate.mockResolvedValue(renderedWith(PLAN_TEXT));
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(res.signup).toEqual({ short: false, planCovered: true, paymentCovered: false });
    });

    test('a section builder that throws never blocks the email', async () => {
      mockDb();
      Membership.buildMembershipStartedSection.mockRejectedValue(new Error('boom'));
      CardEmail.buildAutopayPaymentSection.mockRejectedValue(new Error('boom'));
      EmailTemplates.sendTemplate.mockResolvedValue(renderedWith('hello'));
      const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
      expect(res.sent).toBe(true);
      expect(res.signup).toEqual({ short: false, planCovered: false, paymentCovered: false });
    });

    describe('several properties on one day', () => {
      test('a later acceptance the same ET day gets the short per-property email, no app section', async () => {
        mockDb({ priorFull: { id: 'email-earlier' } });
        EmailTemplates.sendTemplate.mockResolvedValue(renderedWith(PLAN_TEXT));
        const res = await sendEstimateAcceptedOnboarding({ ...base, acceptanceId: 'acc-2', signup: { membershipEmail: MEMBERSHIP_ARGS, paymentMethodRowId: null } });
        const call = EmailTemplates.sendTemplate.mock.calls[0][0];
        expect(call.templateKey).toBe('estimate.accepted_additional_property');
        expect(call.categories).toEqual(['estimate_accepted_onboarding', 'signup_short']);
        expect(call.payload).toMatchObject({ property_street: '12 Palm Ave', property_address: '12 Palm Ave, Bradenton, FL 34205', plan_name: 'WaveGuard Gold' });
        // Same idempotency key scheme as the full email: one email per acceptance.
        expect(call.idempotencyKey).toBe('estimate.accepted_onboarding:est-1:acc:acc-2');
        expect(res.signup).toMatchObject({ short: true, planCovered: true, paymentCovered: false });
      });

      test('the same-day lookup only counts a delivered FULL signup email to this customer and address, excluding this acceptance', async () => {
        const s = mockDb();
        const qbs = [];
        db.mockImplementation((table) => {
          const qb = chain(table === 'customers' ? s.customer : table === 'estimates' ? s.estimate : null);
          qb.table = table; qbs.push(qb);
          return qb;
        });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, acceptanceId: 'acc-9', signup: SIGNUP });
        const q = qbs.find((x) => x.table === 'email_messages');
        expect(q.where).toHaveBeenCalledWith({ template_key: 'estimate.accepted_onboarding', recipient_type: 'customer' });
        expect(q.whereIn).toHaveBeenCalledWith('recipient_id', ['cust-1']);
        expect(q.whereIn).toHaveBeenCalledWith('status', ['sent', 'delivered', 'opened', 'clicked']);
        expect(q.whereRaw).toHaveBeenCalledWith('categories @> ?::jsonb', [JSON.stringify(['signup_full'])]);
        expect(q.whereRaw).toHaveBeenCalledWith('lower(recipient_email_snapshot) = ?', ['taylor@example.com']);
        expect(q.whereNot).toHaveBeenCalledWith('idempotency_key', 'estimate.accepted_onboarding:est-1:acc:acc-9');
      });

      test('a later acceptance can carry a payment section when a NEW method was just made the one in charge', async () => {
        mockDb({ priorFull: { id: 'email-earlier' } });
        EmailTemplates.sendTemplate.mockResolvedValue(renderedWith(PLAN_TEXT, PAYMENT_TEXT));
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_additional_property');
        expect(res.signup).toMatchObject({ short: true, planCovered: true, paymentCovered: true });
      });

      test('if the earlier full email did not go out, the first acceptance the customer actually received is the full one', async () => {
        mockDb({ priorFull: null });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_onboarding');
      });

      test('a later acceptance whose property cannot be named falls back to the full email', async () => {
        db.mockImplementation((table) => {
          if (table === 'customers') return chain({ id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com', account_id: null });
          if (table === 'estimates') return chain({ address: '' });
          if (table === 'email_messages') return chain({ id: 'x' });
          return chain(null);
        });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, appointment: null, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe('estimate.accepted_onboarding');
      });

      test('customers on the same account count as the same customer', async () => {
        const s = mockDb({ customer: { id: 'cust-1', first_name: 'Taylor', email: 'taylor@example.com', account_id: 'acct-1' } });
        const qbs = [];
        db.mockImplementation((table) => {
          const rows = table === 'customers' ? s.customer : table === 'estimates' ? s.estimate : null;
          const qb = chain(rows);
          if (table === 'customers') qb.select = jest.fn(async () => [{ id: 'cust-1' }, { id: 'cust-2' }]);
          qb.table = table; qbs.push(qb);
          return qb;
        });
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: true });
        await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        const q = qbs.find((x) => x.table === 'email_messages');
        expect(q.whereIn).toHaveBeenCalledWith('recipient_id', ['cust-1', 'cust-2']);
      });
    });

    describe('fallbacks: nothing folded in unless the email was accepted for sending', () => {
      test('suppressed / blocked: no coverage', async () => {
        mockDb();
        EmailTemplates.sendTemplate.mockResolvedValue({ sent: false, blocked: true, reason: 'unsubscribed', rendered: { text: `${PLAN_TEXT}\n${PAYMENT_TEXT}` } });
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(res.sent).toBe(false);
        expect(res.signup).toEqual({ short: false, planCovered: false, paymentCovered: false });
      });

      test('no email address anywhere: nothing sent, no coverage key', async () => {
        db.mockImplementation((table) => {
          if (table === 'customers') return chain({ id: 'cust-1', first_name: 'Taylor', email: '', account_id: null, is_primary_profile: true });
          if (table === 'estimates') return chain({ customer_name: 'Taylor', customer_email: '' });
          return chain(null);
        });
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(res).toEqual({ sent: false, outcome: 'no_address' });
        expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
      });

      test('provider failure: failed outcome, no coverage key', async () => {
        mockDb();
        EmailTemplates.sendTemplate.mockRejectedValue(Object.assign(new Error('nope'), { status: 503 }));
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(res).toMatchObject({ sent: false, outcome: 'failed' });
        expect(res.signup).toBeUndefined();
      });

      test('the short template missing: the customer still gets the plain onboarding email, nothing folded in', async () => {
        mockDb({ priorFull: { id: 'earlier' } });
        EmailTemplates.sendTemplate
          .mockRejectedValueOnce(Object.assign(new Error('template not found'), { code: 'EMAIL_TEMPLATE_UNAVAILABLE' }))
          .mockResolvedValueOnce({ sent: true, rendered: { text: 'plain' } });
        const res = await sendEstimateAcceptedOnboarding({ ...base, signup: SIGNUP });
        expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(2);
        const retry = EmailTemplates.sendTemplate.mock.calls[1][0];
        expect(retry.templateKey).toBe('estimate.accepted_onboarding');
        expect(retry.categories).toEqual(['estimate_accepted_onboarding']);
        expect(retry.payload.plan_name).toBeUndefined();
        expect(res.sent).toBe(true);
        expect(res.signup).toBeUndefined(); // nothing covered → every separate email goes out
      });
    });
  });
});

describe('the accept route lane: hold, then send what the combined email did not carry', () => {
  function makeLane(overrides = {}) {
    const fired = { autopay: jest.fn() };
    const sendMembershipStarted = jest.fn(async () => ({ ok: true }));
    const enrollment = { sendEnrollmentConfirmation: fired.autopay, confirmationMethodRowId: 'pm-1', paymentMethodRowId: 'pm-1' };
    const lane = createSignupEmailLane({
      eligible: true, customerId: 'cust-1', membershipEmail: MEMBERSHIP_ARGS,
      getEnrollment: () => enrollment, sendMembershipStarted, guardMs: 1000, ...overrides,
    });
    return { lane, fired, sendMembershipStarted };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  test('not eligible (gate off, prepay, no conversion): nothing is held and nothing extra ever fires', async () => {
    const { lane, fired, sendMembershipStarted } = makeLane({ eligible: false });
    expect(lane.holdEnrollmentConfirmation).toBe(false);
    await lane.run(async () => ({ sent: true, signup: { planCovered: true, paymentCovered: true } }));
    lane.settle();
    await flush();
    expect(sendMembershipStarted).not.toHaveBeenCalled();
    expect(fired.autopay).not.toHaveBeenCalled();
  });

  test('combined email delivered with both sections: neither separate email is sent', async () => {
    const { lane, fired, sendMembershipStarted } = makeLane();
    expect(lane.holdEnrollmentConfirmation).toBe(true);
    let seen;
    await lane.run(async (signup) => { seen = signup; return { sent: true, signup: { planCovered: true, paymentCovered: true } }; });
    await flush();
    expect(seen).toEqual({ membershipEmail: MEMBERSHIP_ARGS, paymentMethodRowId: 'pm-1' });
    expect(sendMembershipStarted).not.toHaveBeenCalled();
    expect(fired.autopay).not.toHaveBeenCalled();
  });

  test('only the plan folded in: the Auto Pay confirmation still goes out, once', async () => {
    const { lane, fired, sendMembershipStarted } = makeLane();
    await lane.run(async () => ({ sent: true, signup: { planCovered: true, paymentCovered: false } }));
    lane.settle();
    await flush();
    expect(sendMembershipStarted).not.toHaveBeenCalled();
    expect(fired.autopay).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['suppressed / blocked', { sent: false, blocked: true }],
    ['failed', { sent: false, outcome: 'failed' }],
    ['no email on file', { sent: false, outcome: 'no_address' }],
    ['null result', null],
    ['sent but sections not rendered (template missing the blocks)', { sent: true, signup: { planCovered: false, paymentCovered: false } }],
    ['sent by a plain fallback (no coverage info)', { sent: true }],
  ])('%s: both separate emails go out exactly as they would have', async (_label, result) => {
    const { lane, fired, sendMembershipStarted } = makeLane();
    await lane.run(async () => result);
    lane.settle();
    await flush();
    expect(sendMembershipStarted).toHaveBeenCalledTimes(1);
    expect(sendMembershipStarted).toHaveBeenCalledWith(MEMBERSHIP_ARGS);
    expect(fired.autopay).toHaveBeenCalledTimes(1);
  });

  test('the combined send throwing releases both', async () => {
    const { lane, fired, sendMembershipStarted } = makeLane();
    await lane.run(async () => { throw new Error('boom'); });
    await flush();
    expect(sendMembershipStarted).toHaveBeenCalledTimes(1);
    expect(fired.autopay).toHaveBeenCalledTimes(1);
  });

  test('a payment method with no held confirmation (already enrolled): no payment section is requested and nothing extra fires', async () => {
    const { lane, sendMembershipStarted } = makeLane({ getEnrollment: () => ({ enrolled: true, paymentMethodRowId: 'pm-1' }) });
    let seen;
    await lane.run(async (signup) => { seen = signup; return { sent: true, signup: { planCovered: true, paymentCovered: false } }; });
    await flush();
    expect(seen.paymentMethodRowId).toBeNull();
    expect(sendMembershipStarted).not.toHaveBeenCalled();
  });

  test('enrollment refused / no enrollment: only membership is held and it follows the coverage', async () => {
    const { lane, sendMembershipStarted } = makeLane({ getEnrollment: () => null });
    await lane.run(async () => ({ sent: false }));
    await flush();
    expect(sendMembershipStarted).toHaveBeenCalledTimes(1);
  });

  test('settle after run is a no-op (each held email fires at most once)', async () => {
    const { lane, fired, sendMembershipStarted } = makeLane();
    await lane.run(async () => ({ sent: false }));
    lane.settle();
    lane.settle({ planCovered: false });
    await flush();
    expect(sendMembershipStarted).toHaveBeenCalledTimes(1);
    expect(fired.autopay).toHaveBeenCalledTimes(1);
  });

  test('an accept that throws before the onboarding send still releases the held emails (route finally)', async () => {
    const { lane, fired, sendMembershipStarted } = makeLane();
    lane.settle();
    await flush();
    expect(sendMembershipStarted).toHaveBeenCalledTimes(1);
    expect(fired.autopay).toHaveBeenCalledTimes(1);
  });

  test('a membership send failure is logged, never thrown', async () => {
    const { lane } = makeLane({ sendMembershipStarted: jest.fn(async () => { throw new Error('smtp'); }) });
    await expect(lane.run(async () => ({ sent: false }))).resolves.toBeUndefined();
    await flush();
  });

  describe('safety timer', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('the held Auto Pay confirmation goes out on its own if the accept never reaches the send', () => {
      const { lane, fired } = makeLane();
      lane.armGuard();
      jest.advanceTimersByTime(999);
      expect(fired.autopay).not.toHaveBeenCalled();
      jest.advanceTimersByTime(2);
      expect(fired.autopay).toHaveBeenCalledTimes(1);
    });

    test('settling first clears the timer: no late duplicate', async () => {
      const { lane, fired } = makeLane();
      lane.armGuard();
      await lane.run(async () => ({ sent: true, signup: { planCovered: true, paymentCovered: true } }));
      jest.advanceTimersByTime(5000);
      expect(fired.autopay).not.toHaveBeenCalled();
    });

    test('the timer is not running until enrollment has returned (armGuard), so it can never settle before a closure exists', () => {
      const { lane, fired } = makeLane();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(10000);
      expect(fired.autopay).not.toHaveBeenCalled();
      lane.armGuard();
      lane.armGuard(); // idempotent
      expect(jest.getTimerCount()).toBe(1);
    });

    test('an ineligible lane arms no timer', () => {
      const { lane, fired } = makeLane({ eligible: false });
      lane.armGuard();
      jest.advanceTimersByTime(5000);
      expect(fired.autopay).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
