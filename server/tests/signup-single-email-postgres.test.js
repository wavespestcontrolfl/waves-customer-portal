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
      template_key: 'estimate.accepted_onboarding',
      recipient_type: 'customer',
      recipient_id: customerId,
      recipient_email_snapshot: EMAIL,
      status: 'sent',
      idempotency_key: `synthetic:${id}`,
      categories: JSON.stringify(['estimate_accepted_onboarding', 'signup_full']),
      text_snapshot: 'You can get ready now: sign in with the mobile number on your account, and enter your texted code.',
      ...overrides,
    });
    return id;
  }

  describe('same-ET-day check for a later acceptance', () => {
    const { _private } = require('../services/estimate-accepted-email');
    const ask = (overrides = {}) => _private.priorFullSignupEmailToday({ customerId, email: EMAIL, ownKey: 'synthetic:own', ...overrides });

    test('a delivered full signup email today counts, case-insensitively on the address', async () => {
      await message({ recipient_email_snapshot: EMAIL.toUpperCase() });
      expect(await ask()).toBe(true);
    });

    test('nothing today: false', async () => {
      expect(await ask()).toBe(false);
    });

    test('a customer on the same account counts as the same customer', async () => {
      await message({ recipient_id: siblingId });
      expect(await ask()).toBe(true);
    });

    test.each([
      ['a short email (not the full one)', { categories: JSON.stringify(['estimate_accepted_onboarding', 'signup_short']) }],
      ['a plain onboarding email (no signup category)', { categories: JSON.stringify(['estimate_accepted_onboarding']) }],
      ['an email that failed', { status: 'failed' }],
      ['an email that was blocked', { status: 'blocked' }],
      ['another recipient address', { recipient_email_snapshot: 'someone-else@example.invalid' }],
      ['another template', { template_key: 'membership.started' }],
      ['another customer entirely', { recipient_id: randomUUID() }],
    ])('%s does not count', async (_label, overrides) => {
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
        expect(await covers(undefined, { id: customerId, email: EMAIL })).toBe(true);
        expect(await covers(undefined, { id: siblingId, email: EMAIL })).toBe(true);
      });

      test('the second property accepted hours after the first is covered by the first\'s full email (same ET day)', async () => {
        // Row queued 4:00 PM ET; the full email went out 9:30 AM ET the same day.
        await message({ created_at: new Date('2026-09-29T13:30:00Z') });
        expect(await covers({ created_at: new Date('2026-09-29T20:00:00Z') })).toBe(true);
        // ...but not one from the previous ET day.
        await trx('email_messages').del();
        await message({ created_at: new Date('2026-09-29T03:30:00Z') });
        expect(await covers({ created_at: new Date('2026-09-29T20:00:00Z') })).toBe(false);
      });

      test('a full email to a different address does not cover a customer with their own address', async () => {
        await message({ recipient_id: siblingId, recipient_email_snapshot: 'other@example.invalid' });
        expect(await covers(undefined, { id: customerId, email: EMAIL })).toBe(false);
      });

      test.each([
        ['it lost the app steps (reworded copy)', { text_snapshot: 'Welcome aboard.' }],
        ['it was never accepted for sending', { status: 'failed' }],
        ['it is the short version', { categories: JSON.stringify(['estimate_accepted_onboarding', 'signup_short']) }],
        ['it is the plain email', { categories: JSON.stringify(['estimate_accepted_onboarding']) }],
        ['it went to another customer', { recipient_id: randomUUID() }],
        ['it was sent the previous day', { created_at: new Date(Date.now() - 30 * 60 * 60 * 1000) }],
      ])('does not cover when %s', async (_label, overrides) => {
        await message(overrides);
        expect(await covers()).toBe(false);
      });
    });
  });

  describe('published templates', () => {
    const lib = require('../services/email-template-library');
    const migration = require('../models/migrations/20260929200000_signup_single_email_templates');
    const LEGACY_PAYLOAD = {
      first_name: 'Taylor', service_type: 'Quarterly Pest Control Service',
      appointment_line: 'Your first visit is scheduled for Tuesday.', acceptance_note: 'You accepted electronically on a day.',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login', company_phone: '(941) 297-5749',
    };

    async function baseVersions() {
      const t = await trx('email_templates').where({ template_key: 'estimate.accepted_onboarding' }).first();
      const versions = await trx('email_template_versions').where({ template_id: t.id }).orderBy('version_number');
      return { t, versions };
    }

    test('the onboarding email renders byte-identically without the new variables (gate off)', async () => {
      const { t, versions } = await baseVersions();
      const active = versions.find((v) => v.id === t.active_version_id);
      const prior = versions.filter((v) => v.version_number < active.version_number).pop();
      expect(JSON.stringify(active.blocks)).toContain('{{authorization_text}}');
      expect(JSON.stringify(prior.blocks)).not.toContain('{{authorization_text}}');
      const a = await lib.renderVersion(prior.id, LEGACY_PAYLOAD);
      const b = await lib.renderVersion(active.id, LEGACY_PAYLOAD);
      expect(b.html).toBe(a.html);
      expect(b.text).toBe(a.text);
      expect(b.subject).toBe(a.subject);
    });

    test('the default preview fixture renders every section; the no-Auto-Pay fixture drops only Payment', async () => {
      const { t } = await baseVersions();
      const fixtures = await trx('email_template_fixtures').where({ template_id: t.id });
      const full = fixtures.find((f) => f.is_default);
      const noPay = fixtures.find((f) => f.name === 'Signup email — no Auto Pay section');
      const r = await lib.renderVersion(t.active_version_id, full.payload);
      for (const part of ['PROPERTY', 'YOUR PLAN', 'PAYMENT', 'Auto Pay method:', 'exactly as you agreed to it', 'enter your texted code']) expect(r.text).toContain(part);
      const r2 = await lib.renderVersion(t.active_version_id, noPay.payload);
      expect(r2.text).toContain('YOUR PLAN');
      expect(r2.text).not.toContain('PAYMENT');
      expect(r2.text).not.toContain('Auto Pay method');
    });

    test('the short per-property template names the property, has the plan and no app section, and previews both cases', async () => {
      const short = await trx('email_templates').where({ template_key: 'estimate.accepted_additional_property' }).first();
      expect(short.status).toBe('active');
      expect(short.send_stream).toBe('service_operational');
      const fixtures = await trx('email_template_fixtures').where({ template_id: short.id });
      expect(fixtures.map((f) => f.name).sort()).toEqual(['Added property — new payment method', 'Added property — no new payment method']);
      const r = await lib.renderVersion(short.active_version_id, fixtures.find((f) => f.is_default).payload);
      expect(r.subject).toBe('Added 123 Example Street to your Waves plan');
      expect(r.text).toContain('123 Example Street, Bradenton, FL 34205');
      expect(r.text).toContain('YOUR PLAN');
      expect(r.text).toContain('You accepted electronically');
      expect(r.text).not.toContain('PAYMENT');
      expect(r.text).not.toContain('enter your texted code');
      const rPay = await lib.renderVersion(short.active_version_id, fixtures.find((f) => !f.is_default).payload);
      expect(rPay.text).toContain('PAYMENT');
      expect(r.validation.ok).toBe(true);
    });

    test('re-running the migration changes nothing (idempotent, admin edits kept)', async () => {
      const before = await baseVersions();
      const shortBefore = await trx('email_templates').where({ template_key: 'estimate.accepted_additional_property' }).first();
      await migration.up(trx);
      const after = await baseVersions();
      expect(after.versions.length).toBe(before.versions.length);
      expect(after.t.active_version_id).toBe(before.t.active_version_id);
      expect((await trx('email_templates').where({ template_key: 'estimate.accepted_additional_property' }).first()).active_version_id).toBe(shortBefore.active_version_id);
      expect(await trx('email_template_versions').where({ template_id: shortBefore.id })).toHaveLength(1);
    });

    test('a template with a custom plain-text body is left whole (the separate emails keep sending)', async () => {
      const { t } = await baseVersions();
      const active = await trx('email_template_versions').where({ id: t.active_version_id }).first();
      // Back to the pre-migration shape: strip the new blocks and give it a custom text body.
      const stripped = JSON.parse(JSON.stringify(active.blocks)).filter((b) => !JSON.stringify(b).match(/property_|plan_|payment_|authorization_/));
      await trx('email_template_versions').where({ id: active.id }).update({ blocks: JSON.stringify(stripped), text_body: 'Custom plain text' });
      await migration.up(trx);
      const { versions, t: t2 } = await baseVersions();
      expect(t2.active_version_id).toBe(active.id);
      expect(versions.at(-1).id).toBe(active.id);
    });

    test('the new sections land before "After every visit" and the property under the opener, whatever the version', () => {
      const blocks = migration._private.insertSections([
        { type: 'paragraph', content: 'Hi {{first_name}}, welcome.' },
        { type: 'heading', content: 'After every visit' },
        { type: 'paragraph', content: '{{acceptance_note}}' },
      ]);
      expect(blocks.map((b) => b.content || b.type)).toEqual([
        'Hi {{first_name}}, welcome.', '{{property_heading}}', '{{property_address}}',
        '{{plan_heading}}', 'details', '{{payment_heading}}', 'details',
        '{{payment_timing_line}}', '{{authorization_intro}}', '{{authorization_text}}', '{{payment_manage_line}}',
        'After every visit', '{{acceptance_note}}',
      ]);
      // A reshaped email (no anchors) still gets every section, ahead of the closing blocks.
      const reshaped = migration._private.insertSections([{ type: 'paragraph', content: 'Custom' }, { type: 'cta', label: 'Go', url_variable: 'customer_portal_url' }]);
      expect(reshaped.findIndex((b) => b.content === '{{authorization_text}}')).toBeLessThan(reshaped.findIndex((b) => b.type === 'cta'));
    });
  });
});
