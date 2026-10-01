// The customer-dunning email goes through the REAL billing email authority (skipped without
// APP_TEST_DATABASE_URL, run for real in CI): processSchedule claims the schedule, the authority opens its
// comms-lock transaction and re-reads the customer, preferences and the schedule claim in real SQL, the
// final boundary passes, and the email is handed to the provider once. The db module is the disposable schema.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const database = (...args) => mockDatabase(...args);
  database.transaction = (...args) => mockDatabase.transaction(...args);
  database.raw = (...args) => mockDatabase.raw(...args);
  Object.defineProperty(database, 'fn', { get: () => mockDatabase.fn });
  Object.defineProperty(database, 'schema', { get: () => mockDatabase.schema });
  Object.defineProperty(database, 'client', { get: () => mockDatabase.client });
  return database;
});
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
    mockDatabase = app;
    await app.schema.createTable('customers', (t) => {
      t.uuid('id').primary(); t.text('first_name'); t.text('email'); t.text('phone'); t.timestamp('deleted_at');
    });
    await app.schema.createTable('notification_prefs', (t) => { t.uuid('customer_id'); t.jsonb('invoice_channels'); });
    // the collections-hold table the send boundary reads (no rows = no hold)
    await app.schema.createTable('collections_flags', (t) => {
      t.increments('id'); t.uuid('customer_id'); t.text('flag'); t.text('reason'); t.timestamp('released_at'); t.text('created_by');
    });
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

  async function seed() {
    const outer = app;
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

  test('processSchedule: the authority re-reads the customer, preferences and the schedule CLAIM in real SQL, sends the email once, and advances', async () => {
    const sent = acceptingLibrary();
    const { customerId, schedule } = await seed();
    const out = await Runner.processSchedule(schedule.id, NOW);
    expect(out.outcome).toBe('advanced');
    expect(sent).toEqual(['invoice.followup_combined_60_day']);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    const row = await app('customer_dunning_schedules').where({ id: schedule.id }).first();
    expect(row).toMatchObject({ status: 'active', step_index: 5 });
    expect(row.touch_claimed_at).toBeNull();
    const ledger = await app('collections_contact_ledger').where({ customer_id: customerId, channel: 'email' });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].metadata).toMatchObject({ delivered: true });
  });

  test('a claim that is not ours (the stamp moved) is refused at the authority\'s boundary, nothing is handed to the provider', async () => {
    const sent = acceptingLibrary();
    const { customerId, invoiceIds, schedule } = await seed();
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    const stamp = new Date(NOW.getTime() + 1000);
    await app('customer_dunning_schedules').where({ id: schedule.id }).update({ touch_claimed_at: stamp });
    const snapshot = Boundary.snapshotOf(customerId, set(invoiceIds), { scheduleId: schedule.id, claimStamp: new Date(NOW.getTime() + 5000) });
    const outcome = await dispatchUnderBillingEmailAuthority({
      input: { customerId, invoiceId: null, channel: 'email', metadata: { billingDeliveryCategory: 'invoice' } },
      recipientEmail: EMAIL, templateKey: 'invoice.followup_combined_60_day',
      preSendCheck: Boundary.check(snapshot), dispatch: async () => { sent.push('x'); }, state,
    });
    expect(outcome).toEqual({ ok: false });
    expect(state.boundaryBlock).toMatchObject({ code: 'DUNNING_SCHEDULE_CHANGED', retryable: true });
    expect(sent).toEqual([]);
  });

  test('a customer who left the email choice (prefs now text-only) is refused by the authority\'s locked recheck', async () => {
    const sent = acceptingLibrary();
    const { customerId, invoiceIds } = await seed();
    await app('notification_prefs').where({ customer_id: customerId }).update({ invoice_channels: JSON.stringify(['sms']) });
    const state = { boundaryBlock: null, handoffStarted: false, providerAccepted: false };
    const outcome = await dispatchUnderBillingEmailAuthority({
      input: { customerId, invoiceId: null, channel: 'email', metadata: { billingDeliveryCategory: 'invoice' } },
      recipientEmail: EMAIL, templateKey: 'invoice.followup_combined_60_day',
      preSendCheck: Boundary.check(Boundary.snapshotOf(customerId, set(invoiceIds))), dispatch: async () => { sent.push('x'); }, state,
    });
    expect(outcome).toEqual({ ok: false });
    expect(state.boundaryBlock).toMatchObject({ retryable: true });
    expect(sent).toEqual([]);
  });

  // ── operator send-now through the SAME authority (#5475 r2) ────────────────
  describe('operator send-now: the shared authority with the explicit preference-bypass option', () => {
    const Suppression = require('../services/messaging/validators/suppression');
    const Library = require('../services/email-template-library');
    const authorityCall = (customerId, invoiceIds, state, extra = {}) => dispatchUnderBillingEmailAuthority({
      input: { customerId, invoiceId: null, channel: 'email', metadata: { billingDeliveryCategory: 'invoice' } },
      recipientEmail: EMAIL, authorityRecipientEmail: EMAIL, templateKey: 'invoice.followup_combined_60_day',
      preSendCheck: Boundary.check(Boundary.snapshotOf(customerId, set(invoiceIds), { operatorInitiated: true })),
      dispatch: async () => { state.dispatched = true; }, state, ...extra,
    });
    const freshState = () => ({ boundaryBlock: null, handoffStarted: false, providerAccepted: false, dispatched: false });
    afterEach(() => {
      Suppression.checkSuppression.mockImplementation(async () => ({ ok: true }));
      Library.activeSuppressionFor.mockImplementation(async () => null);
    });

    test('prefs say text-only: the DEFAULT authority call refuses (unchanged), the operator-bypass call sends', async () => {
      const { customerId, invoiceIds } = await seed();
      await app('notification_prefs').where({ customer_id: customerId }).update({ invoice_channels: JSON.stringify(['sms']) });
      const plain = freshState();
      expect(await authorityCall(customerId, invoiceIds, plain)).toEqual({ ok: false });
      expect(plain.boundaryBlock).toMatchObject({ retryable: true });
      expect(plain.dispatched).toBe(false);
      const operator = freshState();
      expect(await authorityCall(customerId, invoiceIds, operator, { operatorBypassPreferences: true })).toEqual({ ok: true });
      expect(operator.dispatched).toBe(true);
    });

    test('end to end: a processSchedule send-now to a text-only customer sends the email once and advances', async () => {
      const sent = acceptingLibrary();
      const { customerId, schedule } = await seed();
      await app('notification_prefs').where({ customer_id: customerId }).update({ invoice_channels: JSON.stringify(['sms']) });
      const out = await Runner.processSchedule(schedule.id, NOW, { operatorInitiated: true, force: true });
      expect(out.outcome).toBe('advanced');
      expect(sent).toEqual(['invoice.followup_combined_60_day']);
    });

    test('a messaging_suppression entry (staff manual DNC) refuses the operator email TERMINALLY - the shared check the authority owns', async () => {
      const sent = acceptingLibrary();
      const { customerId, schedule } = await seed();
      Suppression.checkSuppression.mockImplementation(async () => ({ ok: false, code: 'SUPPRESSED_MANUAL_DNC', reason: 'Staff marked do-not-contact', retryable: false }));
      const out = await Runner.processSchedule(schedule.id, NOW, { operatorInitiated: true, force: true });
      expect(out.outcome).toBe('paused');
      expect(sent).toEqual([]);
      expect(Suppression.checkSuppression).toHaveBeenCalled();
      const ledger = await app('collections_contact_ledger').where({ customer_id: customerId, channel: 'email' });
      expect(ledger[0].metadata).toMatchObject({ resolved: true, resolution: 'email_terminal_refusal' });
    });

    test('an email suppression store entry refuses it too (EMAIL_SUPPRESSED, terminal)', async () => {
      const { customerId, invoiceIds } = await seed();
      Library.activeSuppressionFor.mockImplementation(async () => ({ suppression_type: 'unsubscribe' }));
      const state = freshState();
      expect(await authorityCall(customerId, invoiceIds, state, { operatorBypassPreferences: true })).toEqual({ ok: false });
      expect(state.boundaryBlock).toMatchObject({ code: 'EMAIL_SUPPRESSED' });
      expect(state.boundaryBlock.retryable).toBeUndefined();
      expect(state.dispatched).toBe(false);
    });

    test('the address changed after it was prepared: refused under the lock (retryable), nothing dispatched; a case-only difference is the same address', async () => {
      const { customerId, invoiceIds } = await seed();
      await app('customers').where({ id: customerId }).update({ email: 'new-address@example.test' });
      const changed = freshState();
      expect(await authorityCall(customerId, invoiceIds, changed, { operatorBypassPreferences: true })).toEqual({ ok: false });
      expect(changed.boundaryBlock).toMatchObject({ code: 'EMAIL_RECIPIENT_CHANGED', retryable: true });
      expect(changed.dispatched).toBe(false);

      await app('customers').where({ id: customerId }).update({ email: 'Pat@Example.TEST' });
      const sameAddress = freshState();
      expect(await authorityCall(customerId, invoiceIds, sameAddress, { operatorBypassPreferences: true, recipientEmail: 'Pat@Example.TEST', authorityRecipientEmail: 'pat@example.test' })).toEqual({ ok: true });
    });

    test('the final provider-boundary check still runs for an operator send: a set that changed during preparation vetoes it with a tagged refusal', async () => {
      const sent = acceptingLibrary();
      const { customerId, invoiceIds, schedule } = await seed();
      let n = 0;
      // read 1 = the run, 2 = the authority's first check; every later read (the FINAL check, the re-render) differs again
      mockResolve.mockImplementation(async () => { n += 1; return n <= 2 ? set(invoiceIds) : { ...set(invoiceIds), digest: `changed-${n}`, totalCents: 10000 + n }; });
      const out = await Runner.processSchedule(schedule.id, NOW, { operatorInitiated: true, force: true });
      expect(sent).toEqual([]); // vetoed at the final check every time: nothing reached the provider
      expect(out.outcome).toBe('held');
      const ledger = await app('collections_contact_ledger').where({ customer_id: customerId, channel: 'email' });
      expect(ledger.some((r) => r.metadata.delivered === true)).toBe(false);
    });

    test('the dispute-hold exemption: a plain dispute hold is skipped for the operator, a wrong-party hold still waits (retryable COLLECTION_HOLD_DEFER)', async () => {
      const { customerId, invoiceIds } = await seed();
      const [{ id }] = await app('collections_flags').insert({ customer_id: customerId, flag: 'collection_hold', reason: 'Dispute: customer says the work was not done', created_by: 'test' }).returning('id');
      const operator = freshState();
      expect(await authorityCall(customerId, invoiceIds, operator, { operatorBypassPreferences: true, holdExempt: 'operator' })).toEqual({ ok: true });
      const plain = freshState();
      expect(await authorityCall(customerId, invoiceIds, plain, {})).toEqual({ ok: false });
      expect(plain.boundaryBlock).toMatchObject({ code: 'COLLECTION_HOLD_DEFER' });
      await app('collections_flags').where({ id }).update({ released_at: NOW });
      await app('collections_flags').insert({ customer_id: customerId, flag: 'collection_hold', reason: 'Wrong number', created_by: 'test' });
      const fallback = freshState();
      expect(await authorityCall(customerId, invoiceIds, fallback, { operatorBypassPreferences: true, holdExempt: 'operator' })).toEqual({ ok: false });
      expect(fallback.boundaryBlock).toMatchObject({ code: 'COLLECTION_HOLD_DEFER', retryable: true });
    });
  });
});
