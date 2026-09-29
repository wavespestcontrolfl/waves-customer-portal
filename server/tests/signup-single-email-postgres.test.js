// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
// The mocked-db suites cannot verify the raw SQL the one-signup-email lane
// relies on (jsonb containment, ILIKE, the ET-day window) or the published
// template versions, so this suite does.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/card-enrollment-email', () => ({ sendAutopayEnrollmentConfirmationDetailed: jest.fn(async () => ({ outcome: 'sent', result: { sent: true } })) }));
const { randomUUID } = require('node:crypto');

postgres('one signup email against migrated PostgreSQL', () => {
  let database;
  let trx;
  let customerId;
  let siblingId;
  let accountId;
  const EMAIL = 'synthetic-owner@example.invalid';

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });

  beforeEach(async () => {
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    siblingId = randomUUID();
    accountId = randomUUID();
    await trx('customer_accounts').insert({ id: accountId, first_name: 'Synthetic', last_name: 'Fixture' });
    const base = { first_name: 'Synthetic', last_name: 'Fixture', active: true, pipeline_stage: 'active_customer' };
    await trx('customers').insert({ id: customerId, ...base, email: EMAIL, phone: `fixture-${customerId.slice(0, 8)}`, account_id: accountId, address_line1: '100 Test Lane', city: 'Test City', zip: '00000' });
    await trx('customers').insert({ id: siblingId, ...base, email: EMAIL, phone: `fixture-${siblingId.slice(0, 8)}`, account_id: accountId, address_line1: '200 Test Lane', city: 'Test City', zip: '00000' });
  });

  afterEach(async () => { if (trx) await trx.rollback(); delete process.env.GATE_SIGNUP_SINGLE_EMAIL; });
  afterAll(async () => { await database?.destroy(); });

  async function message(overrides = {}) {
    const id = randomUUID();
    await trx('email_messages').insert({
      id,
      template_key: 'estimate.accepted_signup',
      recipient_type: 'customer',
      recipient_id: customerId,
      recipient_email_snapshot: EMAIL,
      status: 'sent',
      idempotency_key: `synthetic:${id}`,
      categories: JSON.stringify(['estimate_accepted_onboarding', 'signup_full']),
      payload_snapshot: JSON.stringify({ property_address: '100 Test Lane, Test City, 00000' }),
      text_snapshot: 'You can get ready now: sign in with the mobile number on your account, and enter your texted code.',
      ...overrides,
    });
    return id;
  }

  const Signup = require('../services/signup-single-email');
  const Membership = require('../services/account-membership-email');
  const CardEmail = require('../services/card-enrollment-email');

  describe('added property (same-ET-day short email)', () => {
    const { _private } = require('../services/estimate-accepted-email');
    const HERE = { full: '200 Test Lane, Test City, 00000', street: '200 Test Lane' };
    const ask = (overrides = {}) => _private.isAddedPropertyToday({ customerId, email: EMAIL, ownKey: 'synthetic:own', property: HERE, ...overrides });

    test('a delivered full email today for a DIFFERENT property makes this an added property (address match is case/space-insensitive)', async () => {
      await message({ recipient_email_snapshot: EMAIL.toUpperCase() });
      expect(await ask()).toBe(true);
    });

    test('the SAME property (pest in the morning, lawn in the afternoon) is not an added property, whether the earlier email was full or short', async () => {
      await message({ payload_snapshot: JSON.stringify({ property_address: '200  TEST lane, Test City, 00000' }) });
      expect(await ask()).toBe(false);
      await trx('email_messages').del();
      await message();
      await message({ template_key: 'estimate.accepted_additional_property', categories: JSON.stringify(['estimate_accepted_onboarding', 'signup_short']), payload_snapshot: JSON.stringify({ property_address: HERE.full }) });
      expect(await ask()).toBe(false);
    });

    test('a customer on the same account counts as the same customer', async () => {
      await message({ recipient_id: siblingId });
      expect(await ask()).toBe(true);
    });

    test.each([
      ['only a short email earlier', { template_key: 'estimate.accepted_additional_property', categories: JSON.stringify(['estimate_accepted_onboarding', 'signup_short']) }],
      ['a plain onboarding email (the old template)', { template_key: 'estimate.accepted_onboarding', categories: JSON.stringify(['estimate_accepted_onboarding']) }],
      ['an email that failed', { status: 'failed' }],
      ['an email that was blocked', { status: 'blocked' }],
      ['another recipient address', { recipient_email_snapshot: 'someone-else@example.invalid' }],
      ['another template', { template_key: 'membership.started' }],
      ['another customer entirely', { recipient_id: randomUUID() }],
    ])('%s does not make it an added property', async (_label, overrides) => {
      await message(overrides);
      expect(await ask()).toBe(false);
    });

    test('an email from before ET midnight does not count; this acceptance\'s own row is excluded', async () => {
      const { parseETDateTime, etDateString } = require('../utils/datetime-et');
      const startOfDay = parseETDateTime(`${etDateString()}T00:00`);
      await message({ created_at: new Date(startOfDay.getTime() - 60 * 1000) });
      expect(await ask()).toBe(false);
      await message({ idempotency_key: 'synthetic:own' });
      expect(await ask()).toBe(false);
      await message();
      expect(await ask()).toBe(true);
    });
  });

  describe('welcome-queue check', () => {
    const svc = require('../services/new-recurring-welcome-sms');
    const covers = (row = { created_at: new Date() }, customer = { id: customerId, email: EMAIL }) => svc._internals.combinedSignupEmailCoversWelcome(customer, row);

    test('gate off: never covered', async () => {
      await message();
      expect(await covers()).toBe(false);
    });

    describe('gate on', () => {
      beforeEach(() => { process.env.GATE_SIGNUP_SINGLE_EMAIL = 'true'; });

      test('a delivered full signup email that carries the app steps covers the welcome email', async () => {
        await message();
        expect(await covers()).toBe(true);
      });

      test('the email may be sent moments after the queue row', async () => {
        await message({ created_at: new Date(Date.now() + 5000) });
        expect(await covers({ created_at: new Date() })).toBe(true);
      });

      test('a second property on the same account is covered by the full email sent for the first, at the same address', async () => {
        await message({ recipient_id: siblingId });
        expect(await covers(undefined, { id: siblingId, email: EMAIL })).toBe(true);
      });

      test('the second property accepted hours after the first is covered (same ET day), but not by the previous day\'s email', async () => {
        await message({ created_at: new Date('2026-09-29T13:30:00Z') });
        expect(await covers({ created_at: new Date('2026-09-29T20:00:00Z') })).toBe(true);
        await trx('email_messages').del();
        await message({ created_at: new Date('2026-09-29T03:30:00Z') });
        expect(await covers({ created_at: new Date('2026-09-29T20:00:00Z') })).toBe(false);
      });

      test.each([
        ['it lost the app steps (reworded copy)', { text_snapshot: 'Welcome aboard.' }],
        ['it was never accepted for sending', { status: 'failed' }],
        ['it bounced', { status: 'bounced' }],
        ['it is the short version', { template_key: 'estimate.accepted_additional_property', categories: JSON.stringify(['estimate_accepted_onboarding', 'signup_short']) }],
        ['it is the plain email on the old template', { template_key: 'estimate.accepted_onboarding', categories: JSON.stringify(['estimate_accepted_onboarding']) }],
        ['it went to another customer', { recipient_id: randomUUID() }],
        ['it went to a different address', { recipient_email_snapshot: 'other@example.invalid' }],
        ['it was sent the previous day', { created_at: new Date(Date.now() - 30 * 60 * 60 * 1000) }],
      ])('does not cover when %s', async (_label, overrides) => {
        await message(overrides);
        expect(await covers()).toBe(false);
      });
    });
  });

  describe('durable owed emails (no in-memory holds)', () => {
    const KEY = 'estimate.accepted_onboarding:est-1:acc:acc-1';
    const MEMBERSHIP_ARGS = { customerId: '', effectiveDate: new Date('2026-10-06T16:00:00Z'), sourceId: 'estimate:est-1', membershipTier: 'Gold', monthlyRate: 89, billingCadence: 'monthly', billingLane: 'monthly_membership', perApplicationAmount: null, includedServices: 'Pest Control' };
    let estimateId;
    const owedRows = () => trx('sms_sequences').whereIn('sequence_type', Signup.OWED_TYPES).orderBy('created_at');
    const dueNow = () => trx('sms_sequences').whereIn('sequence_type', Signup.OWED_TYPES).update({ next_send_at: new Date(Date.now() - 1000) });
    const membership = () => Signup.recordOwedMembership(trx, { customerId, estimateId, onboardingKey: KEY, membershipEmail: { ...MEMBERSHIP_ARGS, customerId } });
    const autopay = (handle = trx) => Signup.recordOwedAutopay(handle, { customerId, paymentMethodRowId: 'pm-row-1', estimateId, onboardingKey: KEY });
    const delivered = (text, overrides = {}) => message({ idempotency_key: KEY, text_snapshot: text, ...overrides });

    beforeEach(() => {
      estimateId = randomUUID();
      Membership.sendMembershipStarted.mockClear().mockResolvedValue({ ok: true });
      CardEmail.sendAutopayEnrollmentConfirmationDetailed.mockClear().mockResolvedValue({ outcome: 'sent', result: { sent: true } });
    });

    test('an owed record is written once per email, due a few minutes out', async () => {
      const id = await membership();
      expect(await membership()).toBe(id);
      const [row] = await owedRows();
      expect(row).toMatchObject({ sequence_type: 'signup_membership', status: 'active', customer_id: customerId });
      expect(new Date(row.next_send_at).getTime()).toBeGreaterThan(Date.now() + 60 * 1000);
      expect(row.metadata).toMatchObject({ kind: 'membership', onboarding_key: KEY, owed_key: `membership:${estimateId}` });
    });

    test('the Auto Pay record commits and rolls back WITH the enrollment transaction', async () => {
      await expect(trx.transaction(async (sp) => { await autopay(sp); throw new Error('enrollment rolled back'); })).rejects.toThrow('enrollment rolled back');
      expect(await owedRows()).toHaveLength(0);
      await trx.transaction(async (sp) => { await autopay(sp); });
      expect(await owedRows()).toHaveLength(1);
    });

    test('a failed write can never abort the enrollment transaction: it returns null and the caller sends inline', async () => {
      const id = await trx.transaction(async (sp) => {
        const owed = await Signup.recordOwedAutopay(sp, { customerId: randomUUID(), paymentMethodRowId: 'pm', estimateId, onboardingKey: KEY }); // FK violation
        expect(owed).toBeNull();
        expect(await sp('customers').where({ id: customerId }).first('id')).toBeTruthy(); // outer transaction still usable
        return owed;
      });
      expect(id).toBeNull();
    });

    test('CRASH SAFETY: the process dies right after enrollment (no fast path ever runs); the sweep still sends each owed email exactly as today', async () => {
      await membership();
      await autopay();
      // Nothing is sent, held in memory or timer-driven: only rows exist.
      expect(Membership.sendMembershipStarted).not.toHaveBeenCalled();
      expect(CardEmail.sendAutopayEnrollmentConfirmationDetailed).not.toHaveBeenCalled();
      expect(await Signup.processDueSignupOwedEmails()).toMatchObject({ sent: 0 }); // not due yet
      await dueNow();
      expect(await Signup.processDueSignupOwedEmails()).toMatchObject({ sent: 2, satisfied: 0 });
      expect(Membership.sendMembershipStarted).toHaveBeenCalledTimes(1);
      const args = Membership.sendMembershipStarted.mock.calls[0][0];
      expect(args).toMatchObject({ customerId, sourceId: 'estimate:est-1', membershipTier: 'Gold', monthlyRate: 89, billingLane: 'monthly_membership', perApplicationAmount: null });
      expect(args.effectiveDate).toEqual(new Date('2026-10-06T16:00:00Z'));
      expect(CardEmail.sendAutopayEnrollmentConfirmationDetailed).toHaveBeenCalledWith({ customerId, paymentMethodRowId: 'pm-row-1' });
      expect((await owedRows()).map((r) => r.status)).toEqual(['completed', 'completed']);
      // Idempotent: a second sweep sends nothing more.
      await Signup.processDueSignupOwedEmails();
      expect(Membership.sendMembershipStarted).toHaveBeenCalledTimes(1);
      expect(CardEmail.sendAutopayEnrollmentConfirmationDetailed).toHaveBeenCalledTimes(1);
    });

    test('a claim a crashed sweep left in "sending" is recovered and resolved', async () => {
      const id = await membership();
      await trx('sms_sequences').where({ id }).update({ status: 'sending', updated_at: new Date(Date.now() - 60 * 60 * 1000) });
      await Signup.processDueSignupOwedEmails();
      expect(Membership.sendMembershipStarted).toHaveBeenCalledTimes(1);
    });

    describe('covered by the delivered combined email', () => {
      const PLAN_VALUES = ['WaveGuard Gold', 'October 6, 2026', '$89.00'];
      const PAY_VALUES = ['Visa ending 4242', 'AUTHORIZATION TEXT, word for word'];
      let membershipId;
      let autopayId;
      beforeEach(async () => {
        membershipId = await membership();
        autopayId = await autopay();
        await Signup.recordExpected(membershipId, PLAN_VALUES);
        await Signup.recordExpected(autopayId, PAY_VALUES);
      });

      test('a delivered email carrying every value satisfies both: nothing else is sent', async () => {
        const messageId = await delivered(`${PLAN_VALUES.join('\n')}\n${PAY_VALUES.join('\n')}`);
        expect(await Signup.resolveOwedEmail(membershipId)).toEqual({ satisfied: true });
        expect(await Signup.resolveOwedEmail(autopayId)).toEqual({ satisfied: true });
        expect(Membership.sendMembershipStarted).not.toHaveBeenCalled();
        expect(CardEmail.sendAutopayEnrollmentConfirmationDetailed).not.toHaveBeenCalled();
        const [row] = await owedRows();
        expect(row).toMatchObject({ status: 'completed' });
        expect(row.metadata.satisfied_by_message).toBe(messageId);
      });

      test('the short template and a sweep\'s day-scoped resend key count too', async () => {
        await delivered(PLAN_VALUES.join('\n'), { template_key: 'estimate.accepted_additional_property', idempotency_key: `${KEY}:2026-09-29` });
        expect(await Signup.resolveOwedEmail(membershipId)).toEqual({ satisfied: true });
      });

      test.each([
        ['queued (never accepted)', { status: 'queued' }],
        ['failed', { status: 'failed' }],
        ['bounced', { status: 'bounced' }],
        ['dropped', { status: 'dropped' }],
        ['blocked', { status: 'blocked' }],
        ['the plain onboarding template', { template_key: 'estimate.accepted_onboarding' }],
        ['another acceptance\'s key', { idempotency_key: 'estimate.accepted_onboarding:est-2:acc:acc-2' }],
      ])('a message that is %s does not cover: the email is sent', async (_label, overrides) => {
        await delivered(PLAN_VALUES.join('\n'), overrides);
        expect(await Signup.resolveOwedEmail(membershipId)).toEqual({ sent: true });
        expect(Membership.sendMembershipStarted).toHaveBeenCalledTimes(1);
      });

      test('a delivered email missing ONE value does not cover (an edited template that kept only a row)', async () => {
        await delivered(`${PLAN_VALUES.slice(0, 2).join('\n')}\n${PAY_VALUES.join('\n')}`);
        expect(await Signup.resolveOwedEmail(membershipId)).toEqual({ sent: true });
        expect(await Signup.resolveOwedEmail(autopayId)).toEqual({ satisfied: true }); // its own section is intact
      });

      test('no recorded expectation (the combined email never got that far): sent separately', async () => {
        const bare = await Signup.recordOwedMembership(trx, { customerId, estimateId: randomUUID(), onboardingKey: KEY, membershipEmail: { ...MEMBERSHIP_ARGS, customerId } });
        await delivered(PLAN_VALUES.join('\n'));
        expect(await Signup.resolveOwedEmail(bare)).toEqual({ sent: true });
      });

      test('two resolvers racing (the fast path and the sweep) send once', async () => {
        const results = await Promise.all([Signup.resolveOwedEmail(membershipId), Signup.resolveOwedEmail(membershipId)]);
        expect(results.filter((r) => r.sent)).toHaveLength(1);
        expect(Membership.sendMembershipStarted).toHaveBeenCalledTimes(1);
      });

      test('the gate turned off between accept and delivery changes nothing: uncovered mail still sends, covered mail is still covered', async () => {
        delete process.env.GATE_SIGNUP_SINGLE_EMAIL;
        await delivered(PLAN_VALUES.join('\n'));
        expect(await Signup.resolveOwedEmail(membershipId)).toEqual({ satisfied: true });
        expect(await Signup.resolveOwedEmail(autopayId)).toEqual({ sent: true });
      });
    });

    describe('retries', () => {
      test('a membership send that fails is retried, then given up after the attempt cap', async () => {
        const id = await membership();
        Membership.sendMembershipStarted.mockResolvedValue({ ok: false, reason: 'prefs_unavailable' });
        expect(await Signup.resolveOwedEmail(id)).toEqual({ requeued: true });
        expect((await owedRows())[0]).toMatchObject({ status: 'active' });
        await trx('sms_sequences').where({ id }).update({ step: 3 });
        expect(await Signup.resolveOwedEmail(id)).toEqual({ skipped: true });
        expect((await owedRows())[0]).toMatchObject({ status: 'cancelled' });
      });

      test('a sender-decided skip (opt-out, one_time lane) is final', async () => {
        const id = await membership();
        Membership.sendMembershipStarted.mockResolvedValue({ ok: false, skipped: true, reason: 'email_opted_out' });
        expect(await Signup.resolveOwedEmail(id)).toEqual({ sent: true });
        expect((await owedRows())[0].metadata).toMatchObject({ send_reason: 'email_opted_out' });
      });

      test('an Auto Pay confirmation that FAILED is retried, never completed; a deterministic skip is final', async () => {
        const id = await autopay();
        CardEmail.sendAutopayEnrollmentConfirmationDetailed.mockResolvedValue({ outcome: 'failed', result: null });
        expect(await Signup.resolveOwedEmail(id)).toEqual({ requeued: true });
        expect((await owedRows())[0]).toMatchObject({ status: 'active' });
        await trx('sms_sequences').where({ id }).update({ next_send_at: new Date() });
        CardEmail.sendAutopayEnrollmentConfirmationDetailed.mockResolvedValue({ outcome: 'sent', result: { sent: true } });
        expect(await Signup.resolveOwedEmail(id)).toEqual({ sent: true });
        expect((await owedRows())[0]).toMatchObject({ status: 'completed' });
        const id2 = await Signup.recordOwedAutopay(trx, { customerId, paymentMethodRowId: 'pm-row-2', estimateId, onboardingKey: KEY });
        CardEmail.sendAutopayEnrollmentConfirmationDetailed.mockResolvedValue({ outcome: 'skipped', result: null });
        expect(await Signup.resolveOwedEmail(id2)).toEqual({ sent: true });
      });

      test('a sender that throws releases the claim for the next sweep', async () => {
        const id = await membership();
        Membership.sendMembershipStarted.mockRejectedValue(new Error('boom'));
        expect(await Signup.resolveOwedEmail(id)).toEqual({ error: true });
        expect((await owedRows())[0]).toMatchObject({ status: 'active' });
      });
    });
  });

  describe('acceptance-copy catch-up sweep', () => {
    const sweeps = require('../services/lifecycle-email-sweeps');
    const Onboarding = require('../services/estimate-accepted-email');
    let estimateId;
    let acceptanceId;

    beforeEach(async () => {
      estimateId = randomUUID();
      acceptanceId = randomUUID();
      await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted', accepted_at: new Date(Date.now() - 3 * 3600 * 1000), accepted_service_mode: 'recurring', monthly_total: 100, annual_total: 1200, estimate_data: { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control' }] } } } });
      await trx('estimate_acceptances').insert({ id: acceptanceId, estimate_id: estimateId, customer_id: customerId, terms_version: 'v-test', terms_text: 'Accepting authorizes these services.', accepted_at: new Date(Date.now() - 3 * 3600 * 1000) });
      jest.spyOn(Onboarding, 'sendEstimateAcceptedOnboarding').mockResolvedValue({ sent: true });
    });
    afterEach(() => jest.restoreAllMocks());

    test.each([
      ['the combined signup email', 'estimate.accepted_signup'],
      ['the short per-property email', 'estimate.accepted_additional_property'],
    ])('a delivered %s that carries the acceptance copy is counted: the sweep stamps the copy as sent and resends nothing', async (_label, templateKey) => {
      await message({ template_key: templateKey, idempotency_key: Onboarding.acceptedOnboardingKey(estimateId, acceptanceId), text_snapshot: 'You accepted electronically on Tuesday. What you accepted: ...' });
      const result = await sweeps.runAcceptanceCopySweep();
      expect(result.sent).toBe(0);
      expect(Onboarding.sendEstimateAcceptedOnboarding).not.toHaveBeenCalled();
      expect((await trx('estimate_acceptances').where({ id: acceptanceId }).first()).copy_emailed_at).toBeTruthy();
    });

    test('when the combined email did not go out (failed), the sweep still resends the plain email under a day-scoped key', async () => {
      await message({ status: 'failed', idempotency_key: Onboarding.acceptedOnboardingKey(estimateId, acceptanceId) });
      await sweeps.runAcceptanceCopySweep();
      expect(Onboarding.sendEstimateAcceptedOnboarding).toHaveBeenCalledTimes(1);
      expect(Onboarding.sendEstimateAcceptedOnboarding.mock.calls[0][0].signup).toBeUndefined();
    });
  });

  describe('published templates', () => {
    const lib = require('../services/email-template-library');
    const second = require('../models/migrations/20260929220000_signup_email_transactional_streams');
    const LEGACY_PAYLOAD = {
      first_name: 'Taylor', service_type: 'Quarterly Pest Control Service',
      appointment_line: 'Your first visit is scheduled for Tuesday.', acceptance_note: 'You accepted electronically on a day.',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login', company_phone: '(941) 297-5749',
    };
    const template = (key) => trx('email_templates').where({ template_key: key }).first();

    test('the plain onboarding email keeps service_operational and renders byte-identically without the new variables (gate off)', async () => {
      const t = await template('estimate.accepted_onboarding');
      expect(t.send_stream).toBe('service_operational');
      const versions = await trx('email_template_versions').where({ template_id: t.id }).orderBy('version_number');
      const active = versions.find((v) => v.id === t.active_version_id);
      const prior = versions.filter((v) => v.version_number < active.version_number).pop();
      const a = await lib.renderVersion(prior.id, LEGACY_PAYLOAD);
      const b = await lib.renderVersion(active.id, LEGACY_PAYLOAD);
      expect(b.html).toBe(a.html);
      expect(b.text).toBe(a.text);
    });

    test('the gate-on templates ride transactional_required (the stream of the two emails they replace) and cannot be swallowed by a service_operational unsubscribe', async () => {
      for (const key of ['estimate.accepted_signup', 'estimate.accepted_additional_property']) {
        const t = await template(key);
        expect(t).toMatchObject({ status: 'active', send_stream: 'transactional_required', suppression_group_key: 'transactional_required' });
      }
      const membershipTemplate = await template('membership.started');
      expect(membershipTemplate.send_stream).toBe('transactional_required');
    });

    test('the signup template previews every section; the no-Auto-Pay fixture drops only Payment', async () => {
      const t = await template('estimate.accepted_signup');
      const fixtures = await trx('email_template_fixtures').where({ template_id: t.id });
      const full = fixtures.find((f) => f.is_default);
      const noPay = fixtures.find((f) => f.name === 'Signup email — no Auto Pay section');
      const r = await lib.renderVersion(t.active_version_id, full.payload);
      for (const part of ['PROPERTY', 'YOUR PLAN', 'PAYMENT', 'Auto Pay method:', 'exactly as you agreed to it', 'enter your texted code', 'You accepted electronically']) expect(r.text).toContain(part);
      expect(r.validation.ok).toBe(true);
      const r2 = await lib.renderVersion(t.active_version_id, noPay.payload);
      expect(r2.text).toContain('YOUR PLAN');
      expect(r2.text).not.toContain('PAYMENT');
      expect(r.subject).toBe("You're booked, Taylor — here's what happens next");
    });

    test('the short template names the property, has the plan and no app section', async () => {
      const short = await template('estimate.accepted_additional_property');
      const fixtures = await trx('email_template_fixtures').where({ template_id: short.id });
      const r = await lib.renderVersion(short.active_version_id, fixtures.find((f) => f.is_default).payload);
      expect(r.subject).toBe('Added 123 Example Street to your Waves plan');
      expect(r.text).toContain('YOUR PLAN');
      expect(r.text).toContain('You accepted electronically');
      expect(r.text).not.toContain('PAYMENT');
      expect(r.text).not.toContain('enter your texted code');
    });

    test('the new migration is idempotent and leaves an existing template (and its admin edits) alone', async () => {
      const before = await template('estimate.accepted_signup');
      await trx('email_templates').where({ id: before.id }).update({ name: 'Admin-renamed' });
      await second.up(trx);
      const after = await template('estimate.accepted_signup');
      expect(after.name).toBe('Admin-renamed');
      expect(after.active_version_id).toBe(before.active_version_id);
      expect(await trx('email_template_versions').where({ template_id: before.id })).toHaveLength(1);
    });

    test('a race in the earlier migration (base published WITHOUT the sections) cannot leave gate-on folding nothing: this migration inserts them', async () => {
      const signup = await template('estimate.accepted_signup');
      await trx('email_template_fixtures').where({ template_id: signup.id }).del();
      await trx('email_template_versions').where({ template_id: signup.id }).del().catch(() => {});
      await trx('email_templates').where({ id: signup.id }).del();
      const base = await template('estimate.accepted_onboarding');
      const active = await trx('email_template_versions').where({ id: base.active_version_id }).first();
      const bare = JSON.parse(JSON.stringify(active.blocks)).filter((b) => !JSON.stringify(b).match(/property_|plan_|payment_|authorization_/));
      await trx('email_template_versions').where({ id: active.id }).update({ blocks: JSON.stringify(bare) });
      await second.up(trx);
      const rebuilt = await template('estimate.accepted_signup');
      const version = await trx('email_template_versions').where({ id: rebuilt.active_version_id }).first();
      expect(JSON.stringify(version.blocks)).toContain('{{authorization_text}}');
      expect(JSON.stringify(version.blocks)).toContain('{{plan_name}}');
      expect(rebuilt.send_stream).toBe('transactional_required');
    });

    test('a lost race is NOT swallowed: the unique violation aborts the migration so it is not recorded as applied', async () => {
      const signup = await template('estimate.accepted_signup');
      await trx('email_template_fixtures').where({ template_id: signup.id }).del();
      await trx('email_templates').where({ id: signup.id }).del();
      // Another instance creates the template between our existence check and our insert.
      const fake = (table) => {
        const qb = trx(table);
        if (table !== 'email_templates') return qb;
        const where = qb.where.bind(qb);
        let hidden = 0;
        qb.where = (cond, ...rest) => {
          const q = where(cond, ...rest);
          if (cond && cond.template_key === 'estimate.accepted_signup' && hidden < 1) { hidden += 1; q.first = async () => undefined; }
          return q;
        };
        return qb;
      };
      fake.schema = trx.schema;
      fake.transaction = (cb) => cb(fake);
      await trx('email_templates').insert({ template_key: 'estimate.accepted_signup', name: 'Concurrent create', send_stream: 'transactional_required', suppression_group_key: 'transactional_required' });
      await expect(second.up(fake)).rejects.toMatchObject({ code: '23505' });
    });
  });
});
