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
      status: 'delivered',
      delivered_at: new Date(),
      idempotency_key: `synthetic:${id}`,
      categories: JSON.stringify(['estimate_accepted_onboarding', 'signup_full']),
      payload_snapshot: JSON.stringify({ property_address: '100 Test Lane, Test City, 00000' }),
      text_snapshot: `You can get ready now:\n${require('../services/signup-single-email').APP_SECTION_VALUES.join('\n')}`,
      ...overrides,
    });
    return id;
  }

  const Signup = require('../services/signup-single-email');

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
      ['sent', { status: 'sent', delivered_at: null }],
      ['delivered', { status: 'delivered' }],
      ['reported as spam after delivery', { status: 'spam_report' }],
      ['blocked by the provider with a retry scheduled (the retry rail will deliver it)', { status: 'failed', delivered_at: null, provider_retry_next_at: new Date(Date.now() + 600000) }],
      ['claimed by the retry rail and in flight', { status: 'queued', delivered_at: null, provider_retry_count: 1 }],
    ])('an earlier full email that was accepted for sending (%s) makes this an added property', async (_label, overrides) => {
      await message(overrides);
      expect(await ask()).toBe(true);
    });

    test.each([
      ['only a short email earlier', { template_key: 'estimate.accepted_additional_property', categories: JSON.stringify(['estimate_accepted_onboarding', 'signup_short']) }],
      ['a plain onboarding email (the old template)', { template_key: 'estimate.accepted_onboarding', categories: JSON.stringify(['estimate_accepted_onboarding']) }],
      ['an email that failed with no retry left', { status: 'failed' }],
      ['an email whose provider-retry rail is exhausted', { status: 'failed', provider_retry_exhausted_at: new Date() }],
      ['an email that bounced', { status: 'bounced' }],
      ['an email that was dropped', { status: 'dropped' }],
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

      test.each([
        ['sent', { status: 'sent', delivered_at: null }],
        ['reported as spam / unsubscribed after delivery', { status: 'unsubscribed' }],
        ['blocked with a provider retry scheduled', { status: 'failed', delivered_at: null, provider_retry_next_at: new Date(Date.now() + 600000) }],
        ['claimed by the retry rail and in flight', { status: 'queued', delivered_at: null, provider_retry_count: 2 }],
      ])('a full signup email accepted for sending (%s) covers the welcome email', async (_label, overrides) => {
        await message(overrides);
        expect(await covers()).toBe(true);
      });

      test.each([
        ['bounced', { status: 'bounced' }],
        ['dropped', { status: 'dropped' }],
        ['blocked', { status: 'blocked' }],
        ['failed with no retry', { status: 'failed', delivered_at: null }],
        ['failed and the retry rail exhausted', { status: 'failed', delivered_at: null, provider_retry_exhausted_at: new Date() }],
        ['queued for its first send (no retry yet)', { status: 'queued', delivered_at: null, provider_retry_count: 0 }],
      ])('a full signup email that is %s does not cover it: the welcome email sends', async (_label, overrides) => {
        await message(overrides);
        expect(await covers()).toBe(false);
      });

      test('marker kept but the app link removed: not covered (the welcome email sends)', async () => {
        await message({ text_snapshot: 'You can get ready now: sign in with the mobile number on your account, and enter your texted code.' });
        expect(await covers()).toBe(false);
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
    const third = require('../models/migrations/20260930000000_signup_email_drop_payment_section');
    const PAYMENT_KEYS = third._private.PAYMENT_VARIABLES;
    const activeVersion = async (key) => {
      const t = await template(key);
      return { t, v: await trx('email_template_versions').where({ id: t.active_version_id }).first() };
    };

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

    test('the signup template previews the property, plan and app sections, and NO payment section (the Auto Pay email stays its own email)', async () => {
      const t = await template('estimate.accepted_signup');
      const fixtures = await trx('email_template_fixtures').where({ template_id: t.id });
      const full = fixtures.find((f) => f.is_default);
      const r = await lib.renderVersion(t.active_version_id, full.payload);
      for (const part of ['PROPERTY', 'YOUR PLAN', 'enter your texted code', 'You accepted electronically']) expect(r.text).toContain(part);
      for (const gone of ['PAYMENT', 'Auto Pay method:', 'exactly as you agreed to it']) expect(r.text).not.toContain(gone);
      expect(r.validation.ok).toBe(true);
      expect(r.subject).toBe("You're booked, Taylor — here's what happens next");
      for (const f of fixtures) expect(Object.keys(f.payload).filter((k) => PAYMENT_KEYS.includes(k))).toEqual([]);
    });

    test('the app-section values the welcome check requires are all present in the rendered signup email (template and constant cannot drift)', async () => {
      const t = await template('estimate.accepted_signup');
      const fixtures = await trx('email_template_fixtures').where({ template_id: t.id });
      const r = await lib.renderVersion(t.active_version_id, fixtures.find((f) => f.is_default).payload);
      const Signup = require('../services/signup-single-email');
      expect(Signup.messageCarriesAll({ rendered: { text: r.text, html: r.html } }, Signup.APP_SECTION_VALUES)).toBe(true);
      // And the check is whole-section: dropping the app link from the same render fails it.
      expect(Signup.messageCarriesAll({ rendered: { text: r.text.split('https://www.wavespestcontrol.com/app/').join(''), html: '' } }, Signup.APP_SECTION_VALUES)).toBe(false);
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
      // Version 1 from that migration, version 2 from the Payment-drop migration; a re-run adds none.
      expect(await trx('email_template_versions').where({ template_id: before.id })).toHaveLength(2);
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
      expect(JSON.stringify(version.blocks)).toContain('{{plan_name}}');
      expect(rebuilt.send_stream).toBe('transactional_required');
    });

    describe('20260930000000 drops the Payment section (owner 2026-09-30: Auto Pay stays its own email)', () => {
      const KEYS = ['estimate.accepted_onboarding', 'estimate.accepted_signup', 'estimate.accepted_additional_property'];
      const paymentBlocks = third._private.PAYMENT_BLOCKS;

      test('applied: no active version references a payment variable, plan and app sections remain, fixtures carry no payment values', async () => {
        for (const key of KEYS) {
          const { t, v } = await activeVersion(key);
          const text = JSON.stringify(v.blocks);
          for (const name of PAYMENT_KEYS) expect(text).not.toContain(`{{${name}}}`);
          expect(text).toContain('{{plan_name}}');
          const fixtures = await trx('email_template_fixtures').where({ template_id: t.id });
          expect(fixtures.length).toBeGreaterThan(0);
          for (const f of fixtures) expect(Object.keys(f.payload).filter((k) => PAYMENT_KEYS.includes(k))).toEqual([]);
          const r = await lib.renderVersion(t.active_version_id, fixtures.find((f) => f.is_default).payload);
          expect(r.text).not.toContain('PAYMENT');
          expect(r.validation.ok).toBe(true);
        }
        const { v } = await activeVersion('estimate.accepted_signup');
        expect(JSON.stringify(v.blocks)).toContain('enter your texted code');
      });

      test('the redundant with/without fixtures are gone and the added-property preview is named plainly', async () => {
        const signup = await template('estimate.accepted_signup');
        const names = (await trx('email_template_fixtures').where({ template_id: signup.id })).map((f) => f.name);
        expect(names).not.toContain('Signup email — no Auto Pay section');
        const short = await template('estimate.accepted_additional_property');
        const shortNames = (await trx('email_template_fixtures').where({ template_id: short.id })).map((f) => f.name);
        expect(shortNames).toEqual(['Added property']);
      });

      test('a second run changes nothing (idempotent)', async () => {
        const before = await Promise.all(KEYS.map(async (k) => (await template(k)).active_version_id));
        await third.up(trx);
        const after = await Promise.all(KEYS.map(async (k) => (await template(k)).active_version_id));
        expect(after).toEqual(before);
      });

      test('a template whose Payment blocks were reshaped by staff is left whole, not half-patched', async () => {
        const { t, v } = await activeVersion('estimate.accepted_signup');
        const blocks = JSON.parse(JSON.stringify(v.blocks));
        const at = blocks.findIndex((b) => b.type === 'heading' && b.content === '{{plan_heading}}');
        // Staff re-added a customised payment paragraph (not the seeded run).
        blocks.splice(at + 2, 0, { type: 'paragraph', content: 'Custom {{payment_manage_line}}' });
        await trx('email_template_versions').where({ id: v.id }).update({ blocks: JSON.stringify(blocks) });
        await third.up(trx);
        const now = await template('estimate.accepted_signup');
        expect(now.active_version_id).toBe(t.active_version_id);
        expect(JSON.stringify((await trx('email_template_versions').where({ id: now.active_version_id }).first()).blocks)).toContain('Custom {{payment_manage_line}}');
      });

      test('the seeded run is removed exactly, wherever it sits, and only it', async () => {
        const { t, v } = await activeVersion('estimate.accepted_signup');
        const blocks = JSON.parse(JSON.stringify(v.blocks));
        const at = blocks.findIndex((b) => b.type === 'heading' && b.content === '{{plan_heading}}');
        blocks.splice(at + 2, 0, ...JSON.parse(JSON.stringify(paymentBlocks)));
        await trx('email_template_versions').where({ id: v.id }).update({ blocks: JSON.stringify(blocks) });
        await trx('email_template_fixtures').where({ template_id: t.id, is_default: true }).update({ payload: JSON.stringify({ first_name: 'Taylor', payment_heading: 'Payment', authorization_text: 'x' }) });
        await third.up(trx);
        const now = await template('estimate.accepted_signup');
        expect(now.active_version_id).not.toBe(t.active_version_id);
        const next = await trx('email_template_versions').where({ id: now.active_version_id }).first();
        expect(next.blocks).toEqual(v.blocks);
        expect((await trx('email_template_versions').where({ id: v.id }).first()).status).toBe('archived');
        const fixture = await trx('email_template_fixtures').where({ template_id: t.id, is_default: true }).first();
        expect(fixture.payload).toEqual({ first_name: 'Taylor' });
      });
    });

    describe('20260930010000 fixes the names and descriptions and audits the signup migrations', () => {
      const fourth = require('../models/migrations/20260930010000_signup_email_template_names_and_audit');
      const auditCount = async (action) => (await trx('audit_log').where({ action })).length;

      test('applied: neither library entry mentions Auto Pay or a payment section any more', async () => {
        for (const key of ['estimate.accepted_signup', 'estimate.accepted_additional_property']) {
          const t = await template(key);
          expect(`${t.name} ${t.description}`).not.toMatch(/Auto Pay authorization|Auto Pay included|payment section only/i);
        }
        expect((await template('estimate.accepted_signup')).name).toBe('Estimate Accepted — Signup Email');
      });

      test('audit events exist for 20260929220000, 20260930000000 and 20260930010000, one each', async () => {
        for (const migration of ['20260929220000', '20260930000000', '20260930010000']) {
          expect(await auditCount(`migration:${migration}:publish`)).toBe(1);
        }
        const event = await trx('audit_log').where({ action: 'migration:20260930000000:publish' }).first();
        expect(event.metadata.template_keys).toEqual(expect.arrayContaining(['estimate.accepted_signup', 'estimate.accepted_onboarding', 'estimate.accepted_additional_property']));
      });

      test('a re-run is idempotent: no second event, nothing rewritten', async () => {
        const before = await template('estimate.accepted_signup');
        await fourth.up(trx);
        for (const migration of ['20260929220000', '20260930000000', '20260930010000']) {
          expect(await auditCount(`migration:${migration}:publish`)).toBe(1);
        }
        expect((await template('estimate.accepted_signup')).updated_at).toEqual(before.updated_at);
      });

      test('text staff edited is preserved; text still at the seeded value is updated (and audited once)', async () => {
        const signup = await template('estimate.accepted_signup');
        const short = await template('estimate.accepted_additional_property');
        await trx('email_templates').where({ id: signup.id }).update({ name: 'Admin-renamed', description: fourth._private.TEXT['estimate.accepted_signup'].description.from });
        await trx('audit_log').where({ action: 'migration:20260930010000:publish' }).del();
        await fourth.up(trx);
        const after = await template('estimate.accepted_signup');
        expect(after.name).toBe('Admin-renamed');
        expect(after.description).toBe(fourth._private.TEXT['estimate.accepted_signup'].description.to);
        expect((await template('estimate.accepted_additional_property')).description).toBe(short.description);
        const event = await trx('audit_log').where({ action: 'migration:20260930010000:publish' }).first();
        expect(event.metadata.fields).toEqual({ 'estimate.accepted_signup': ['description'] });
      });
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
