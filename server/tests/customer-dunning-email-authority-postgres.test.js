// The customer-dunning email goes through the billing email authority on the handle the run was given
// (skipped without APP_TEST_DATABASE_URL, run for real in CI). processSchedule runs INSIDE an outer
// transaction whose schedule claim, customer and preferences are uncommitted, with the process-wide pool
// poisoned: the authority's lock transaction opens on the handle (a savepoint), so it and the final boundary
// see the claim and send once; opened on the pool it could not see it and refused every email.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

const mockPool = jest.fn(() => { throw new Error('the default pool was used'); });
mockPool.schema = { hasTable: () => { throw new Error('the default pool was used'); } };
mockPool.raw = () => { throw new Error('the default pool was used'); };
mockPool.transaction = () => { throw new Error('the default pool was used'); };
jest.mock('../models/db', () => mockPool);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.test' }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async () => 'https://s.example.test/x'), invoiceShortCodePrefix: () => 'W-1' }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async (key) => `SMS[${key}] pay`) }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn(async () => false) }));
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async () => ({ suppressionLoaded: true })),
  checkSuppression: jest.fn(async () => ({ ok: true })),
}));
const mockSendTemplate = jest.fn();
jest.mock('../services/email-template-library', () => ({
  sendTemplate: (...a) => mockSendTemplate(...a),
  loadTemplateByKey: jest.fn(async () => ({ template: { status: 'active' }, activeVersion: { id: 'v1' } })),
  activeSuppressionFor: jest.fn(async () => null),
  redactEmailAddresses: (x) => x,
}));
const mockResolve = jest.fn();
jest.mock('../services/customer-dunning/balance-set', () => ({ resolveDunnableSet: (...a) => mockResolve(...a) }));

const migration = require('../models/migrations/20260930010000_customer_dunning_schedules');
const Runner = require('../services/customer-dunning/runner');
const Boundary = require('../services/customer-dunning/boundary');
const { dispatchUnderBillingEmailAuthority } = require('../services/billing-channel-email-authority');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `customer_dunning_authority_${randomUUID().replaceAll('-', '')}`;
jest.setTimeout(60000);

const NOW = new Date('2026-10-06T14:16:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW.getTime() - days * DAY);
const EMAIL = 'pat@example.test';

// Date only: pg and the runner keep real timers.
beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick',
      'queueMicrotask', 'performance', 'hrtime', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'],
  });
});
afterAll(() => { jest.useRealTimers(); });

postgres('customer-dunning email authority on the run\'s handle (PostgreSQL)', () => {
  let admin;
  let app;

  beforeAll(async () => {
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 4 } });
    await app.schema.createTable('customers', (t) => {
      t.uuid('id').primary(); t.text('first_name'); t.text('email'); t.text('phone'); t.timestamp('deleted_at');
    });
    await app.schema.createTable('notification_prefs', (t) => { t.uuid('customer_id'); t.jsonb('invoice_channels'); });
    await app.schema.createTable('invoices', (t) => { t.uuid('id').primary(); t.uuid('customer_id'); t.string('status'); t.timestamp('created_at'); t.timestamp('sent_at'); t.timestamp('sms_sent_at'); t.uuid('payer_id'); t.string('scheduled_send_error'); });
    await app.schema.createTable('invoice_followup_sequences', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.uuid('invoice_id'); t.uuid('customer_id'); t.string('status'); t.integer('step_index').defaultTo(0);
      t.timestamp('next_touch_at'); t.timestamp('last_touch_at'); t.integer('touches_sent').defaultTo(0); t.timestamp('touch_claimed_at'); t.timestamp('anchor_at');
      t.text('paused_reason'); t.timestamp('created_at').defaultTo(app.fn.now()); t.timestamp('updated_at').defaultTo(app.fn.now());
    });
    await app.schema.createTable('collections_contact_ledger', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.uuid('customer_id'); t.string('channel', 20); t.string('purpose', 40);
      t.jsonb('invoice_ids'); t.timestamp('occurred_at', { useTz: true }); t.string('source', 60); t.jsonb('metadata'); t.string('idempotency_key', 120).unique();
    });
    await app.schema.createTable('sms_templates', (t) => { t.text('template_key'); t.boolean('is_active'); });
    await app.schema.createTable('customer_interactions', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.uuid('customer_id'); t.text('interaction_type'); t.text('subject'); t.text('body'); t.jsonb('metadata');
    });
    await migration.up(app);
  }, 30000);

  afterAll(async () => {
    delete process.env.GATE_DUNNING_LADDER_90;
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  const set = (ids) => ({
    kind: 'multi', reason: null, anchor: { id: ids[0], token: 't', title: 'x', invoice_number: 'W-1', service_date: '2026-08-01', due_date: '2026-08-15' },
    members: ids.map((id) => ({ invoice_id: id, cents: 10000, seqStatus: 'active', quiet: false })),
    totalCents: 10000 * ids.length, digest: `d-${ids.length}`, activeCount: ids.length, excluded: { stopped: [], md: [] },
  });

  // Inside an outer transaction the customer, preferences, invoices, sequences and the schedule are all UNCOMMITTED.
  async function seed(outer) {
    const customerId = randomUUID();
    await outer('customers').insert({ id: customerId, first_name: 'Pat', email: EMAIL, phone: null });
    await outer('notification_prefs').insert({ customer_id: customerId, invoice_channels: JSON.stringify(['email']) });
    const invoiceIds = [];
    for (const [i, days] of [60, 59].entries()) {
      const id = randomUUID(); invoiceIds.push(id);
      await outer('invoices').insert({ id, customer_id: customerId, status: 'overdue', created_at: ago(days), sent_at: ago(days) });
      await outer('invoice_followup_sequences').insert({ invoice_id: id, customer_id: customerId, status: 'active', step_index: 4, touches_sent: 4, next_touch_at: ago(0.1) });
      expect(i).toBeLessThan(2);
    }
    const [schedule] = await outer('customer_dunning_schedules').insert({
      customer_id: customerId, episode: 1, status: 'active', step_index: 4, next_touch_at: ago(0.05), touches_sent: 4,
    }).returning('*');
    mockResolve.mockImplementation(async () => set(invoiceIds));
    return { customerId, invoiceIds, schedule };
  }

  // The template library modelled around the REAL authority: its provider handoff is the authority's dispatch.
  const acceptingLibrary = () => {
    const sent = [];
    mockSendTemplate.mockImplementation(async (args) => {
      let dispatched = false;
      const verdict = await args.withProviderHandoff(async (database, providerBoundaryCheck) => {
        await new Promise((resolve) => { setImmediate(resolve); });
        if (providerBoundaryCheck) await providerBoundaryCheck({ database });
        dispatched = true;
      });
      if (!dispatched || verdict?.ok === false) return { sent: false, blocked: true, reason: 'aborted_by_caller_before_dispatch' };
      sent.push(args.templateKey);
      return { sent: true, message: { id: 'em-1', sent_at: NOW } };
    });
    return sent;
  };

  beforeEach(() => { mockSendTemplate.mockReset(); mockResolve.mockReset(); });

  test('processSchedule inside an outer transaction: the authority sees the UNCOMMITTED claim (customer, prefs and schedule), sends the email once, and advances', async () => {
    const sent = acceptingLibrary();
    const rolledBack = new Error('rollback');
    await expect(app.transaction(async (outer) => {
      const { customerId, schedule } = await seed(outer);
      // nothing of this is visible to another connection: only the handle can see the claim
      expect(await app('customers').where({ id: customerId }).first()).toBeUndefined();
      expect(await app('customer_dunning_schedules').where({ id: schedule.id }).first()).toBeUndefined();

      const out = await Runner.processSchedule(schedule.id, NOW, { database: outer });
      expect(out.outcome).toBe('advanced');
      expect(sent).toEqual(['invoice.followup_combined_60_day']);
      expect(mockSendTemplate).toHaveBeenCalledTimes(1);
      const row = await outer('customer_dunning_schedules').where({ id: schedule.id }).first();
      expect(row).toMatchObject({ status: 'active', step_index: 5 });
      expect(row.touch_claimed_at).toBeNull();
      const ledger = await outer('collections_contact_ledger').where({ customer_id: customerId, channel: 'email' });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].metadata).toMatchObject({ delivered: true });
      throw rolledBack; // leave nothing behind
    })).rejects.toBe(rolledBack);
  });

  test('a claim that is not ours (the stamp moved) is still refused at the authority\'s boundary, on the handle', async () => {
    const sent = acceptingLibrary();
    const rolledBack = new Error('rollback');
    await expect(app.transaction(async (outer) => {
      const { customerId, invoiceIds, schedule } = await seed(outer);
      const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
      const stamp = new Date(NOW.getTime() + 1000);
      await outer('customer_dunning_schedules').where({ id: schedule.id }).update({ touch_claimed_at: stamp });
      const snapshot = Boundary.snapshotOf(customerId, set(invoiceIds), { scheduleId: schedule.id, claimStamp: new Date(NOW.getTime() + 5000) });
      const outcome = await dispatchUnderBillingEmailAuthority({
        input: { customerId, invoiceId: null, channel: 'email', metadata: { billingDeliveryCategory: 'invoice' } },
        recipientEmail: EMAIL, templateKey: 'invoice.followup_combined_60_day',
        preSendCheck: Boundary.check(snapshot, { database: outer }), dispatch: async () => { sent.push('x'); }, state, database: outer,
      });
      expect(outcome).toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'DUNNING_SCHEDULE_CHANGED', retryable: true });
      expect(sent).toEqual([]);
      throw rolledBack;
    })).rejects.toBe(rolledBack);
  });

  test('without the run\'s handle the authority opens on the pool, cannot see the uncommitted rows, and refuses (the bug this closes)', async () => {
    const rolledBack = new Error('rollback');
    await expect(app.transaction(async (outer) => {
      const { customerId, invoiceIds } = await seed(outer);
      const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
      let dispatched = false;
      const outcome = await dispatchUnderBillingEmailAuthority({
        input: { customerId, invoiceId: null, channel: 'email', metadata: { billingDeliveryCategory: 'invoice' } },
        recipientEmail: EMAIL, templateKey: 'invoice.followup_combined_60_day',
        preSendCheck: Boundary.check(Boundary.snapshotOf(customerId, set(invoiceIds)), { database: outer }),
        dispatch: async () => { dispatched = true; }, state, // no `database`: the (poisoned) pool
      });
      expect(outcome).toEqual({ ok: false });
      expect(dispatched).toBe(false);
      expect(state.boundaryBlock).toMatchObject({ code: 'BILLING_EMAIL_RECHECK_FAILED', retryable: true });
      throw rolledBack;
    })).rejects.toBe(rolledBack);
  });
});
