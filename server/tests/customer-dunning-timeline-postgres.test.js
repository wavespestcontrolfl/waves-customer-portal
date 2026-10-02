// Customer-level overdue reminders: ONE customer walked through a whole episode, in order, against a real
// PostgreSQL in a disposable schema (skipped without APP_TEST_DATABASE_URL, run for real in CI). Every concern
// has its own suite (promotion, claim, locking, landing, boundary, pre-visit); what none of them proves is the
// sequence a customer actually lives through:
//
//   1  two overdue invoices on per-invoice ladders -> promotion makes one schedule, the batch stops firing them
//   2  the first combined step -> ONE reminder naming 2 invoices
//   3  an invoice is paid -> the next step names 1 (the single wording)
//   4  a third invoice goes overdue -> the next step names 2 again at the CURRENT stage (no reset)
//   5  a dispute hold -> nothing sent, no office alert, schedule not advanced; released -> the next tick sends
//   6  staff pause -> nothing sent; resume -> sends at the next due tick
//   7  the pre-visit balance note is suppressed by a real schedule touch, never by the promotion-seeded copy
//   8  the oldest invoice reaches Day 90 -> ONE final notice naming every open invoice; the named invoices are
//      cadence-exhausted and nothing is ever sent again
//   plus two branches on fresh customers: everything paid mid-episode, and a staff release after a told step.
//
// The REAL engine runs: promotion, the claim, the runner, the send path (the reservation ledger, the contact
// ledger, the billing email authority), the schedule writers, the staff controls, the release and the pre-visit
// reader. What is replaced is the provider edge (the email template library's send and the text sender), the
// short link, the SMS template renderer, the collections rail guard (its own suites), the admin notification
// sink, and resolveDunnableSet, whose pay-page authority needs Stripe and a dozen tables: here the set is DERIVED
// FROM THE INVOICE ROWS IN THE TEST DATABASE (open invoices, their sequence rows, their amounts), so a payment or
// a new invoice written to the database really changes it.
//
// Time: every engine call is handed `now`. The engine also stamps ledger rows with the wall clock, so the system
// Date (and nothing else: no timer, no sleep) is pinned to the same instant for each tick, as the email
// authority suite does.
const { randomUUID, createHash } = require('node:crypto');
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
// The SMS renderer: what the customer would read is recorded by the text sender below.
const mockGetTemplate = jest.fn(async (key, vars) => `SMS[${key}] ${vars.invoice_count ?? 1}`);
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: (...a) => mockGetTemplate(...a) }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn(async () => false) }));
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: jest.fn(async () => ({ allowed: true })) }));
const mockNotify = jest.fn(async () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));
const mockSendMessage = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSendMessage(...a) }));
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
const FeatureGates = require('../config/feature-gates');
const Followups = require('../services/invoice-followups');
const Previsit = require('../services/previsit-balance-reminder');
const Schedule = require('../services/customer-dunning/schedule');
const Runner = require('../services/customer-dunning/runner');
const Wiring = require('../services/customer-dunning/wiring');
const { SOURCE } = require('../services/customer-dunning/constants');
const Timeline = require('../scripts/dunning-customer-timeline');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `customer_dunning_timeline_${randomUUID().replaceAll('-', '')}`;
jest.setTimeout(120000);

const at = (iso) => new Date(iso);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TERMINAL = ['paid', 'prepaid', 'void', 'processing', 'refunded', 'canceled', 'cancelled'];
const PHONE = '+15555550100';
const EMAIL = 'test.customer@example.test';

// Every date below is EDT (before the Nov 1 fall-back); the engine's 10:00 ET step time is 14:00Z.
const A_SENT = at('2026-07-01T12:00:00Z'); // Wed
const B_SENT = at('2026-07-03T12:00:00Z'); // Fri
const C_SENT = at('2026-07-15T12:00:00Z'); // Wed

// The ladder, on the oldest open invoice, is Day 3/10/17/30/60/90 after it was sent:
//   A (Jul 1):  d3 Jul 4   d10 Jul 11  d17 Jul 18  d30 Jul 31  d60 Aug 30  d90 Sep 29
//   B (Jul 3):  d3 Jul 6   d10 Jul 13  d17 Jul 20  d30 Aug 2   d60 Sep 1   d90 Oct 1
// The cron fires Tue-Fri 10:16 ET, so a Saturday/Sunday/Monday step goes out on the next Tuesday.
const T1 = at('2026-07-07T14:16:00Z'); // Tue: promotion (A's and B's own d3 are both due)
const T2 = at('2026-07-08T14:16:00Z'); // Wed: first combined step (d3), 2 invoices
const T3 = at('2026-07-14T14:16:00Z'); // Tue: A was paid; B alone, Day 10 (single wording)
const T4 = at('2026-07-21T14:16:00Z'); // Tue: C joined; B + C at Day 17, not reset
const T5 = at('2026-08-04T14:16:00Z'); // Tue: Day 30 due, a dispute hold stands
const T5_RELEASED = at('2026-08-05T13:00:00Z');
const T5_SEND = at('2026-08-05T14:16:00Z'); // Wed: the first tick after the release
const T6_PAUSE = at('2026-09-01T13:00:00Z'); // Day 60 due at 14:00Z today
const T6_TICK_PAUSED = at('2026-09-01T14:16:00Z');
const T6_RESUME = at('2026-09-01T15:00:00Z');
const T6_TICK_RESUMED = at('2026-09-01T16:00:00Z');
const T6_SEND = at('2026-09-02T14:16:00Z'); // Wed: the next due tick
const T8 = at('2026-10-01T14:16:00Z'); // Thu: B's Day 90
const AFTER = at('2026-10-06T14:16:00Z');

postgres('customer-level overdue reminders: one customer through a whole episode (PostgreSQL)', () => {
  let admin;
  let app;
  const saved = {};
  let emailMode = 'accept'; // accept | fail (a provider that refuses the email leg, retryably)
  let sendLog = [];

  beforeAll(async () => {
    jest.useFakeTimers({
      now: T1,
      doNotFake: ['setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick',
        'queueMicrotask', 'performance', 'hrtime', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'],
    });
    for (const key of ['GATE_DUNNING_LADDER_90', 'GATE_DUNNING_CUSTOMER_SCHEDULE', 'DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST', 'GATE_BALANCE_REMINDER_LEGACY_OFF']) saved[key] = process.env[key];
    saved.pay = FeatureGates.gates.payIncludeBalance;
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    process.env.GATE_DUNNING_CUSTOMER_SCHEDULE = 'true';
    delete process.env.DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST;
    delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
    FeatureGates.gates.payIncludeBalance = true;
    expect(FeatureGates.dunningCustomerScheduleLive()).toBe(true);

    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 8 } });
    mockDatabase = app;
    await createTables();
    await migration.up(app);
    mockResolve.mockImplementation((customerId, opts = {}) => setFromRows(opts.database || app, customerId));
    installProviders();
  }, 60000);

  afterAll(async () => {
    jest.useRealTimers();
    for (const key of ['GATE_DUNNING_LADDER_90', 'GATE_DUNNING_CUSTOMER_SCHEDULE', 'DUNNING_CUSTOMER_SCHEDULE_ALLOWLIST', 'GATE_BALANCE_REMINDER_LEGACY_OFF']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    FeatureGates.gates.payIncludeBalance = saved.pay;
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
    await require('../models/db').destroy?.();
  });

  // ── schema: the production columns the engine reads, hand-built ──────────
  async function createTables() {
    await app.schema.createTable('customers', (t) => {
      t.uuid('id').primary(); t.text('first_name'); t.text('last_name'); t.text('email'); t.text('phone'); t.timestamp('deleted_at');
    });
    await app.schema.createTable('notification_prefs', (t) => { t.uuid('customer_id'); t.jsonb('invoice_channels'); });
    // the collections-hold table (production columns: a hold is an unreleased collection_hold row)
    await app.schema.createTable('collections_flags', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.uuid('customer_id'); t.string('flag', 40); t.text('reason'); t.string('created_by', 80);
      t.timestamp('created_at', { useTz: true }).defaultTo(app.fn.now()); t.timestamp('released_at', { useTz: true });
    });
    await app.schema.createTable('scheduled_services', (t) => { t.uuid('id').primary(); t.uuid('customer_id'); t.boolean('is_recurring'); });
    await app.schema.createTable('invoices', (t) => {
      t.uuid('id').primary();
      t.uuid('customer_id');
      t.string('status');
      t.timestamp('created_at');
      t.timestamp('sent_at');
      t.timestamp('sms_sent_at');
      t.timestamp('last_reminder_at');
      t.uuid('payer_id');
      t.uuid('scheduled_service_id');
      t.string('scheduled_send_error');
      t.string('token'); t.string('title'); t.decimal('total', 10, 2); t.decimal('credit_applied', 10, 2);
      t.string('stripe_payment_intent_id'); t.date('service_date'); t.date('due_date'); t.string('invoice_number');
    });
    await app.schema.createTable('invoice_followup_sequences', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('invoice_id').unique(); // one sequence per invoice, as in production
      t.uuid('customer_id');
      t.string('status');
      t.integer('step_index').defaultTo(0);
      t.timestamp('next_touch_at');
      t.timestamp('last_touch_at');
      t.integer('touches_sent').defaultTo(0);
      t.timestamp('touch_claimed_at');
      t.timestamp('anchor_at');
      t.text('paused_reason');
      t.text('stopped_reason');
      t.uuid('paused_by_admin_id');
      t.boolean('is_autopay_held').defaultTo(false);
      t.timestamp('created_at').defaultTo(app.fn.now());
      t.timestamp('updated_at').defaultTo(app.fn.now());
    });
    await app.schema.createTable('collections_contact_ledger', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable(); t.string('channel', 20).notNullable(); t.string('purpose', 40).notNullable();
      t.jsonb('invoice_ids').notNullable().defaultTo('[]');
      t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(app.fn.now());
      t.string('source', 60).notNullable(); t.jsonb('metadata'); t.string('idempotency_key', 120).unique();
    });
    await app.schema.createTable('sms_templates', (t) => { t.text('template_key'); t.boolean('is_active'); });
    await app.schema.createTable('customer_interactions', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.uuid('customer_id'); t.text('interaction_type'); t.text('subject'); t.text('body'); t.jsonb('metadata');
    });
    await app.schema.createTable('activity_log', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()')); t.uuid('admin_user_id'); t.uuid('customer_id'); t.string('action', 50).notNullable();
      t.text('description'); t.jsonb('metadata'); t.timestamp('created_at').defaultTo(app.fn.now());
    });
    const keys = [3, 10, 17, 30, 60, 90].flatMap((d) => [`invoice_followup_combined_${d}day`])
      .concat(['invoice_followup_3day', 'invoice_followup_7day', 'invoice_followup_14day', 'invoice_followup_30day', 'invoice_followup_60day', 'invoice_followup_90day']);
    await app('sms_templates').insert(keys.map((template_key) => ({ template_key, is_active: true })));
  }

  // ── the set authority, derived from the invoice rows ─────────────────────
  // What resolveDunnableSet answers (balance-set.js): the open invoices, oldest first, minus those whose sequence
  // is stopped; paused / autopay-held members hold the customer; two or more members are `multi`, one `single`,
  // none `empty`. The digest is the real one (sha256 of anchor + sorted id:cents).
  async function setFromRows(database, customerId) {
    const open = await database('invoices').where({ customer_id: customerId }).whereNotIn('status', TERMINAL)
      .orderBy([{ column: 'created_at', order: 'asc' }, { column: 'id', order: 'asc' }]);
    const base = {
      reason: null, anchor: null, members: [], totalCents: 0, digest: null, activeCount: 0, excluded: { stopped: [], md: [] },
    };
    if (!open.length) return { ...base, kind: 'empty', reason: 'no_open_invoices' };
    const seqs = await database('invoice_followup_sequences').whereIn('invoice_id', open.map((i) => i.id)).select('invoice_id', 'status', 'id');
    const bySeq = new Map(seqs.map((s) => [String(s.invoice_id), s]));
    const stopped = open.filter((i) => bySeq.get(String(i.id))?.status === 'stopped').map((i) => String(i.id));
    const live = open.filter((i) => !stopped.includes(String(i.id)));
    if (!live.length) return { ...base, kind: 'empty', reason: 'all_excluded', excluded: { stopped, md: [] } };
    const members = live.map((i) => {
      const seq = bySeq.get(String(i.id));
      const seqStatus = seq?.status || 'none';
      return {
        invoice_id: String(i.id), cents: Math.round((Number(i.total) - Number(i.credit_applied || 0)) * 100), seqStatus, quiet: seqStatus === 'completed' || seqStatus === 'none', seq_id: seq?.id || null,
      };
    });
    const anchor = live[0];
    const digest = createHash('sha256').update(`${anchor.id}|${members.map((m) => `${m.invoice_id}:${m.cents}`).sort().join(',')}`).digest('hex');
    const parts = {
      ...base,
      anchor: { id: String(anchor.id), token: anchor.token, invoice_number: anchor.invoice_number, title: anchor.title, service_date: anchor.service_date, due_date: anchor.due_date },
      members,
      totalCents: members.reduce((sum, m) => sum + m.cents, 0),
      digest,
      activeCount: members.filter((m) => m.seqStatus === 'active').length,
      excluded: { stopped, md: [] },
    };
    if (members.some((m) => m.seqStatus === 'paused')) return { ...parts, kind: 'hold', reason: 'member_paused' };
    if (members.some((m) => m.seqStatus === 'autopay_hold')) return { ...parts, kind: 'hold', reason: 'member_autopay_hold' };
    return { ...parts, kind: members.length >= 2 ? 'multi' : 'single' };
  }

  // ── the provider edge ────────────────────────────────────────────────────
  // sendLog = what reached the customer: channel, template, wording (multi names a count, single one invoice), count.
  function installProviders() {
    mockSendTemplate.mockImplementation(async (args) => {
      if (emailMode === 'fail') return { sent: false, blocked: false, reason: 'provider_unavailable' };
      let dispatched = false;
      // the real billing email authority: its provider handoff is the dispatch below, with the final boundary re-check
      const verdict = await args.withProviderHandoff(async (database, providerBoundaryCheck) => {
        await new Promise((resolve) => { setImmediate(resolve); });
        if (providerBoundaryCheck) await providerBoundaryCheck({ database });
        dispatched = true;
      });
      if (!dispatched || verdict?.ok === false) return { sent: false, blocked: true, reason: 'aborted_by_caller_before_dispatch' };
      sendLog.push({
        channel: 'email',
        template: args.templateKey,
        variant: args.payload.invoice_count ? 'multi' : 'single',
        invoices: Number(args.payload.invoice_count || 1),
        total: args.payload.total_due || args.payload.amount_due,
      });
      return { sent: true, message: { id: 'em-1', sent_at: new Date() } };
    });
    mockSendMessage.mockImplementation(async (args) => {
      const [, template, count] = /^SMS\[(.+)\] (\d+)$/.exec(args.body);
      sendLog.push({ channel: 'sms', template, variant: template.includes('combined') ? 'multi' : 'single', invoices: Number(count) });
      return { sent: true, ok: true, deliveryOutcome: 'accepted' };
    });
  }
  const takeSends = () => { const out = sendLog; sendLog = []; return out; };

  beforeEach(() => { mockNotify.mockClear(); });

  // ── fixtures ─────────────────────────────────────────────────────────────
  async function newCustomer() {
    const id = randomUUID();
    const serviceId = randomUUID();
    await app('customers').insert({ id, first_name: 'Test', last_name: 'Customer', email: EMAIL, phone: PHONE });
    await app('notification_prefs').insert({ customer_id: id, invoice_channels: JSON.stringify(['email', 'sms']) });
    await app('scheduled_services').insert({ id: serviceId, customer_id: id, is_recurring: true });
    return { id, serviceId };
  }

  // An overdue invoice on its own per-invoice ladder (step 0, its Day 3 due), as the invoice send arms it.
  async function addInvoice(customer, { sentAt, total, stamped = null }) {
    const id = randomUUID();
    const dueDate = new Date(sentAt.getTime() - 10 * 24 * HOUR);
    await app('invoices').insert({
      id, customer_id: customer.id, status: 'overdue', created_at: sentAt, sent_at: sentAt, token: `tok-${id.slice(0, 8)}`, title: 'Test service', total, credit_applied: 0,
      invoice_number: `TEST-${id.slice(0, 6)}`, service_date: sentAt, due_date: dueDate, scheduled_service_id: customer.serviceId,
    });
    await app('invoice_followup_sequences').insert({
      invoice_id: id, customer_id: customer.id, status: 'active', step_index: 0, touches_sent: 0,
      next_touch_at: Followups.computeNextTouchAt(sentAt, 0), last_touch_at: stamped,
    });
    return id;
  }

  async function pay(invoiceId) {
    await app('invoices').where({ id: invoiceId }).update({ status: 'paid' });
    await Followups.stopOnPayment(invoiceId); // the Stripe webhook's own hook: the sequence completes
  }

  // runPending's per-invoice batch for ONE customer: due active sequences on open invoices that no schedule owns.
  const batchFor = (customerId, now) => app('invoice_followup_sequences as s').join('invoices as i', 's.invoice_id', 'i.id')
    .where('s.customer_id', customerId).where('s.status', 'active').where('s.next_touch_at', '<=', now)
    .whereNotIn('i.status', TERMINAL).whereNull('i.payer_id').where(Followups._test.notOwnedByCustomerSchedule)
    .orderBy('i.created_at').pluck('i.id');

  // One cron tick, in runPending's order (the kill switch, promotion, then the schedule engine), every call handed `now`.
  async function tick(now) {
    jest.setSystemTime(now);
    await Wiring.releaseIfDark(now);
    const promotion = await Schedule.promote(now);
    const run = await Runner.runCustomerSchedules(now, { clockStartedAt: Date.now() });
    return { promoted: promotion.promoted, processed: run.processed, failed: run.failed, outcomes: run.outcomes };
  }

  const scheduleRows = (customerId) => app('customer_dunning_schedules').where({ customer_id: customerId }).orderBy('episode');
  const only = async (customerId) => { const rows = await scheduleRows(customerId); expect(rows).toHaveLength(1); return rows[0]; };
  const time = (value) => (value == null ? null : new Date(value).getTime());
  const sortIds = (ids) => [...ids].map(String).sort();

  // The schedule row's own fields (b), as dates compare: every time as epoch ms.
  function expectSchedule(row, want) {
    const got = {
      status: row.status, step_index: row.step_index, touches_sent: row.touches_sent,
      next_touch_at: time(row.next_touch_at), last_touch_at: time(row.last_touch_at),
    };
    const wanted = { ...want };
    for (const key of ['next_touch_at', 'last_touch_at']) if (key in wanted) wanted[key] = time(wanted[key]);
    expect(got).toMatchObject(wanted);
    expect(row.touch_claimed_at).toBeNull(); // a finished tick always gives its claim back
  }

  // Member sequence rows (c), by label, with the claim cleared.
  async function sequences(customerId, labels) {
    const rows = await app('invoice_followup_sequences').where({ customer_id: customerId });
    const out = {};
    for (const row of rows) {
      out[labels[row.invoice_id]] = { status: row.status, step_index: row.step_index, touches_sent: row.touches_sent, next_touch_at: time(row.next_touch_at), claimed: row.touch_claimed_at != null };
    }
    return out;
  }

  // What the ledger recorded for the touch delivered at `when` (the invoices it NAMED), per channel.
  async function ledgerAt(customerId, when) {
    const rows = await app('collections_contact_ledger').where({ customer_id: customerId, source: SOURCE }).orderBy('channel');
    return rows.filter((r) => time(r.occurred_at) === time(when)).map((r) => ({
      channel: r.channel, delivered: r.metadata.delivered === true, step_id: r.metadata.step_id, variant: r.metadata.variant, named: sortIds(r.invoice_ids),
    }));
  }
  const ledgerCount = async (customerId) => Number((await app('collections_contact_ledger').where({ customer_id: customerId }).count('* as n').first()).n);
  const noAlerts = () => expect(mockNotify).not.toHaveBeenCalled();

  // ══ the episode ═══════════════════════════════════════════════════════════
  describe('one customer, one episode, in order', () => {
    const ep = { labels: {} };

    test('1. two overdue invoices on per-invoice ladders: promotion seeds one schedule from the oldest, and the per-invoice batch stops firing them', async () => {
      jest.setSystemTime(T1);
      ep.customer = await newCustomer();
      const c = ep.customer.id;
      // A had an office re-send two days before promotion (its own per-invoice stamp): what promotion seeds last_touch_at from
      ep.a = await addInvoice(ep.customer, { sentAt: A_SENT, total: 100, stamped: new Date(T1.getTime() - 30 * HOUR) });
      ep.b = await addInvoice(ep.customer, { sentAt: B_SENT, total: 150 });
      ep.labels = { [ep.a]: 'A', [ep.b]: 'B' };

      // control: before promotion both rows are due and nothing owns them, so the per-invoice batch fires them
      expect(await batchFor(c, T1)).toEqual([ep.a, ep.b]);

      const out = await tick(T1);
      expect(out.promoted).toHaveLength(1);
      expect(out.processed).toBe(0); // promotion never sends in its own run: the first step is due tomorrow
      const row = await only(c);
      expectSchedule(row, {
        status: 'active', step_index: 0, touches_sent: 0,
        next_touch_at: at('2026-07-08T14:00:00Z'), // the next run's anchor, not today
        last_touch_at: new Date(T1.getTime() - 30 * HOUR), // seeded from A's own stamp
      });
      expect(Schedule.STEPS[row.step_index].id).toBe('d3_friendly'); // seeded from the OLDEST invoice (A) at its first live step
      expect(row.episode).toBe(1);
      expect(time(row.created_at)).toBe(T1.getTime());
      expect(row.seeded_from.map((s) => s.invoice_id).sort()).toEqual(sortIds([ep.a, ep.b]));
      ep.scheduleId = row.id;

      // the batch no longer fires them, though both are still due, and a direct fire is refused as owned
      expect(await batchFor(c, T1)).toEqual([]);
      const aRow = await app('invoice_followup_sequences').where({ invoice_id: ep.a }).first();
      expect(await Followups._test.fireStep({ ...aRow, invoice_id: ep.a, invoice_stripe_pi: null })).toEqual({ ownedBy: row.id });

      // the pre-visit balance note, judged right after promotion (asserted in step 7): the schedule's last_touch_at is A's
      // own stamp, inside the note's 72-hour window, but it was COPIED in at promotion, so it must suppress nothing
      const justPromoted = new Date(T1.getTime() + 5 * MIN);
      const cutoff = new Date(justPromoted.getTime() - 72 * HOUR);
      expect(time(row.last_touch_at)).toBeGreaterThanOrEqual(cutoff.getTime());
      ep.preVisitBefore = {
        scheduleTouched: await Previsit._test.customerScheduleTouchedSince(c, cutoff, app),
        eligible: (await Previsit._test.freshOverdueRecurringInvoices(c, justPromoted, app)).map((r) => String(r.id)),
      };

      expect(takeSends()).toEqual([]);
      expect(await ledgerCount(c)).toBe(0);
      // the per-invoice rows are membership state now: untouched, no claim left behind
      expect(await sequences(c, ep.labels)).toEqual({
        A: { status: 'active', step_index: 0, touches_sent: 0, next_touch_at: time(Followups.computeNextTouchAt(A_SENT, 0)), claimed: false },
        B: { status: 'active', step_index: 0, touches_sent: 0, next_touch_at: time(Followups.computeNextTouchAt(B_SENT, 0)), claimed: false },
      });
      noAlerts();
    });

    test('2. the first combined step is due: ONE reminder (email + text) names 2 invoices, and the schedule advances', async () => {
      const c = ep.customer.id;
      const out = await tick(T2);
      expect(out.outcomes).toEqual({ advanced: 1 });
      expect(takeSends()).toEqual([
        { channel: 'email', template: 'invoice.followup_combined_3_day', variant: 'multi', invoices: 2, total: '$250.00' },
        { channel: 'sms', template: 'invoice_followup_combined_3day', variant: 'multi', invoices: 2 },
      ]);
      expect(await ledgerAt(c, T2)).toEqual([
        { channel: 'email', delivered: true, step_id: 'd3_friendly', variant: 'multi', named: sortIds([ep.a, ep.b]) },
        { channel: 'sms', delivered: true, step_id: 'd3_friendly', variant: 'multi', named: sortIds([ep.a, ep.b]) },
      ]);
      expectSchedule(await only(c), {
        status: 'active', step_index: 1, touches_sent: 1, last_touch_at: T2,
        next_touch_at: at('2026-07-11T14:00:00Z'), // A's Day 10 (a Saturday: it goes out on the Tuesday tick)
      });
      // one touch, not one per invoice: the per-invoice rows were never advanced by it
      expect(await sequences(c, ep.labels)).toMatchObject({
        A: { status: 'active', step_index: 0, touches_sent: 0, claimed: false },
        B: { status: 'active', step_index: 0, touches_sent: 0, claimed: false },
      });
      noAlerts();
    });

    test('3. invoice A is paid: the next step names ONE invoice, in the single wording, and drops the paid one', async () => {
      const c = ep.customer.id;
      jest.setSystemTime(at('2026-07-14T13:00:00Z'));
      await pay(ep.a);
      expect((await mockResolve(c)).kind).toBe('single'); // the set really changed with the row

      const out = await tick(T3);
      expect(out.outcomes).toEqual({ advanced: 1 });
      expect(takeSends()).toEqual([
        { channel: 'email', template: 'invoice.followup_7_day', variant: 'single', invoices: 1, total: '$150.00' }, // Day 10 is the ladder's 7day template
        { channel: 'sms', template: 'invoice_followup_7day', variant: 'single', invoices: 1 },
      ]);
      expect(await ledgerAt(c, T3)).toEqual([
        { channel: 'email', delivered: true, step_id: 'd7_reminder', variant: 'single', named: [ep.b] },
        { channel: 'sms', delivered: true, step_id: 'd7_reminder', variant: 'single', named: [ep.b] },
      ]);
      expectSchedule(await only(c), {
        status: 'active', step_index: 2, touches_sent: 2, last_touch_at: T3,
        next_touch_at: at('2026-07-20T14:00:00Z'), // B's Day 17: the cadence now follows B, the oldest OPEN invoice
      });
      expect(await sequences(c, ep.labels)).toMatchObject({
        A: { status: 'completed', claimed: false }, B: { status: 'active', step_index: 0, claimed: false },
      });
      noAlerts();
    });

    test('4. a third invoice goes overdue: it joins the next reminder at the CURRENT stage (Day 17), the stage is not reset', async () => {
      const c = ep.customer.id;
      jest.setSystemTime(at('2026-07-15T12:30:00Z'));
      ep.c = await addInvoice(ep.customer, { sentAt: C_SENT, total: 80 });
      ep.labels[ep.c] = 'C';
      const before = await only(c);
      expect(before.step_index).toBe(2);
      // C is due for its OWN Day 3 on Jul 18, but the schedule owns it: the batch never fires it
      expect(await batchFor(c, T4)).toEqual([]);

      const out = await tick(T4);
      expect(out.outcomes).toEqual({ advanced: 1 });
      expect(takeSends()).toEqual([
        { channel: 'email', template: 'invoice.followup_combined_17_day', variant: 'multi', invoices: 2, total: '$230.00' },
        { channel: 'sms', template: 'invoice_followup_combined_17day', variant: 'multi', invoices: 2 },
      ]);
      expect(await ledgerAt(c, T4)).toEqual([
        { channel: 'email', delivered: true, step_id: 'd14_firmer', variant: 'multi', named: sortIds([ep.b, ep.c]) },
        { channel: 'sms', delivered: true, step_id: 'd14_firmer', variant: 'multi', named: sortIds([ep.b, ep.c]) },
      ]);
      expectSchedule(await only(c), {
        status: 'active', step_index: 3, touches_sent: 3, last_touch_at: T4,
        next_touch_at: at('2026-08-02T14:00:00Z'), // B's Day 30
      });
      // C never ran its own Day 3 / 10: its row is untouched membership state
      expect(await sequences(c, ep.labels)).toMatchObject({
        B: { status: 'active', step_index: 0, claimed: false },
        C: { status: 'active', step_index: 0, touches_sent: 0, next_touch_at: time(Followups.computeNextTouchAt(C_SENT, 0)), claimed: false },
      });
      noAlerts();
    });

    test('5. a dispute hold: the tick sends nothing, raises NO office alert and does not advance; once released the next tick sends', async () => {
      const c = ep.customer.id;
      jest.setSystemTime(at('2026-08-04T13:00:00Z'));
      const [{ id: holdId }] = await app('collections_flags').insert({
        customer_id: c, flag: 'collection_hold', reason: 'dispute on call: synthetic billing question', created_by: 'test', created_at: new Date(),
      }).returning('id');
      const touchesBefore = await ledgerCount(c);

      const held = await tick(T5);
      expect(held.outcomes).toEqual({ held: 1 });
      expect(takeSends()).toEqual([]);
      expect(await ledgerCount(c)).toBe(touchesBefore); // nothing reserved, nothing failed
      const row = await only(c);
      expectSchedule(row, {
        status: 'held', step_index: 3, touches_sent: 3, last_touch_at: T4, // not advanced, last touch is still the Day 17
        next_touch_at: at('2026-08-05T04:00:00Z'), // revisited at the start of the next ET day
      });
      expect(row.held_reason).toBe('collection_hold');
      noAlerts(); // the office placed the hold: nobody is told
      expect(await sequences(c, ep.labels)).toMatchObject({ B: { step_index: 0, claimed: false }, C: { step_index: 0, claimed: false } });

      // released: the next tick sends the step that was held (Day 30), at that stage, not a later one
      await app('collections_flags').where({ id: holdId }).update({ released_at: T5_RELEASED });
      const sent = await tick(T5_SEND);
      expect(sent.outcomes).toEqual({ advanced: 1 });
      expect(takeSends()).toEqual([
        { channel: 'email', template: 'invoice.followup_combined_30_day', variant: 'multi', invoices: 2, total: '$230.00' },
        { channel: 'sms', template: 'invoice_followup_combined_30day', variant: 'multi', invoices: 2 },
      ]);
      expect(await ledgerAt(c, T5_SEND)).toEqual([
        { channel: 'email', delivered: true, step_id: 'd30_final', variant: 'multi', named: sortIds([ep.b, ep.c]) },
        { channel: 'sms', delivered: true, step_id: 'd30_final', variant: 'multi', named: sortIds([ep.b, ep.c]) },
      ]);
      const after = await only(c);
      expectSchedule(after, {
        status: 'active', step_index: 4, touches_sent: 4, last_touch_at: T5_SEND,
        next_touch_at: at('2026-09-01T14:00:00Z'), // B's Day 60
      });
      expect(after.held_reason).toBeNull();
      expect(after.held_since).toBeNull();
      noAlerts();
    });

    test('6. staff pause: nothing sends while paused; after the resume the next due tick sends and the cadence continues', async () => {
      const c = ep.customer.id;
      const adminId = randomUUID();
      jest.setSystemTime(T6_PAUSE);
      const paused = await Wiring.controlCustomerSchedule(c, 'pause', { adminId, now: T6_PAUSE });
      expect(paused.status).toBe(200);
      const pausedRow = await only(c);
      expectSchedule(pausedRow, { status: 'paused', step_index: 4, touches_sent: 4, next_touch_at: null, last_touch_at: T5_SEND });
      expect(pausedRow.paused_by_admin_id).toBe(adminId);

      // Day 60 comes due at 14:00Z; the paused schedule is not claimed
      const idle = await tick(T6_TICK_PAUSED);
      expect(idle).toMatchObject({ processed: 0, outcomes: {} });
      expect(takeSends()).toEqual([]);
      expect((await only(c)).status).toBe('paused');
      noAlerts();

      jest.setSystemTime(T6_RESUME);
      const resumed = await Wiring.controlCustomerSchedule(c, 'resume', { adminId, now: T6_RESUME });
      expect(resumed.status).toBe(200);
      expectSchedule(await only(c), { status: 'active', step_index: 4, touches_sent: 4, next_touch_at: at('2026-09-02T04:00:00Z') }); // never sends in the click itself
      // later the same day: still not due (a resume lands on the next run, not now)
      expect(await tick(T6_TICK_RESUMED)).toMatchObject({ processed: 0 });
      expect(takeSends()).toEqual([]);

      const sent = await tick(T6_SEND);
      expect(sent.outcomes).toEqual({ advanced: 1 });
      expect(takeSends()).toEqual([
        { channel: 'email', template: 'invoice.followup_combined_60_day', variant: 'multi', invoices: 2, total: '$230.00' },
        { channel: 'sms', template: 'invoice_followup_combined_60day', variant: 'multi', invoices: 2 },
      ]);
      expectSchedule(await only(c), {
        status: 'active', step_index: 5, touches_sent: 5, last_touch_at: T6_SEND,
        next_touch_at: at('2026-10-01T14:00:00Z'), // B's Day 90
      });
      // both presses are on the customer's activity log with who pressed them
      const presses = await app('activity_log').where({ customer_id: c }).orderBy('created_at').select('action', 'admin_user_id');
      expect(presses.map((p) => p.action)).toEqual(['combined_reminders_pause', 'combined_reminders_resume']);
      expect(presses.every((p) => p.admin_user_id === adminId)).toBe(true);
      noAlerts();
    });

    test('7. the pre-visit balance note: not suppressed by the promotion-seeded last_touch_at, suppressed by a real combined touch inside its window', async () => {
      const c = ep.customer.id;
      const touched = Previsit._test.customerScheduleTouchedSince;
      const eligible = async (now) => (await Previsit._test.freshOverdueRecurringInvoices(c, now, app)).map((r) => String(r.id)).sort();
      const window = (now) => new Date(now.getTime() - 72 * HOUR); // the note's recent-touch window

      // (before any real combined touch, read in step 1) the seeded copy was inside the window and suppressed nothing:
      // A is held back by its OWN per-invoice stamp, B (no stamp of its own) still gets its note
      expect(ep.preVisitBefore).toEqual({ scheduleTouched: false, eligible: [ep.b] });

      // (after) a real combined touch, Day 60 at Sep 2 14:16Z: inside 72 hours it covers every invoice...
      const soon = at('2026-09-03T13:00:00Z');
      expect(await touched(c, window(soon), app)).toBe(true);
      expect(await eligible(soon)).toEqual([]);
      // ...and once the window has passed the touch no longer counts and both invoices are eligible again
      const later = at('2026-09-06T15:00:00Z');
      expect(await touched(c, window(later), app)).toBe(false);
      expect(await eligible(later)).toEqual(sortIds([ep.b, ep.c]));
      noAlerts();
    });

    test('8. the oldest invoice reaches Day 90: ONE final notice names every open invoice, the schedule completes, the named invoices are exhausted for good', async () => {
      const c = ep.customer.id;
      const out = await tick(T8);
      expect(out.outcomes).toEqual({ completed: 1 });
      expect(takeSends()).toEqual([
        { channel: 'email', template: 'invoice.followup_combined_90_day', variant: 'multi', invoices: 2, total: '$230.00' },
        { channel: 'sms', template: 'invoice_followup_combined_90day', variant: 'multi', invoices: 2 },
      ]);
      expect(await ledgerAt(c, T8)).toEqual([
        { channel: 'email', delivered: true, step_id: 'd90_final_notice', variant: 'multi', named: sortIds([ep.b, ep.c]) },
        { channel: 'sms', delivered: true, step_id: 'd90_final_notice', variant: 'multi', named: sortIds([ep.b, ep.c]) },
      ]);
      const row = await only(c);
      expectSchedule(row, { status: 'completed', step_index: 5, touches_sent: 6, last_touch_at: T8, next_touch_at: null });
      expect(row.closed_reason).toBe('final_notice_delivered');
      expect(time(row.final_notice_at)).toBe(T8.getTime());
      expect(time(row.closed_at)).toBe(T8.getTime());
      // every invoice the notice named carries the cadence-exhausted mark (past the last ladder step); the paid one is untouched
      const exhausted = Schedule.STEPS.length;
      expect(await sequences(c, ep.labels)).toMatchObject({
        A: { status: 'completed', step_index: 0 },
        B: { status: 'completed', step_index: exhausted, next_touch_at: null, claimed: false },
        C: { status: 'completed', step_index: exhausted, next_touch_at: null, claimed: false },
      });
      noAlerts();

      // never revived, never a second final: both revival passes and a later tick leave everything as it is
      const before = await app('invoice_followup_sequences').where({ customer_id: c }).orderBy('invoice_id').select('invoice_id', 'status', 'step_index', 'next_touch_at');
      await Followups._test.reviveLegacyFinishedSequences();
      await Followups._test.reviveReopenedLowStepSequences();
      expect(await app('invoice_followup_sequences').where({ customer_id: c }).orderBy('invoice_id').select('invoice_id', 'status', 'step_index', 'next_touch_at')).toEqual(before);
      const later = await tick(AFTER);
      expect(later).toMatchObject({ promoted: [], processed: 0, failed: 0 });
      expect(await batchFor(c, AFTER)).toEqual([]);
      expect(takeSends()).toEqual([]);
      expect(await scheduleRows(c)).toHaveLength(1); // no second episode
      noAlerts();
    });

    test('the timeline script reads the whole episode back, read-only, in time order, with the sub-7-day gap flagged and no personal data', async () => {
      const c = ep.customer.id;
      const report = await Timeline.inReadOnlyTransaction(app, (trx) => Timeline.readTimeline(trx, c, { now: AFTER, days: 120 }));
      expect(report.notes).toEqual([]); // every table was readable
      // six touches, two legs each
      expect(report.attempts).toHaveLength(12);
      expect(report.attempts.every((a) => a.state === 'delivered')).toBe(true);
      const touchDates = report.attempts.filter((a) => !a.sameTouch).map((a) => a.row.occurred_at.toISOString());
      expect(touchDates).toEqual([T2, T3, T4, T5_SEND, T6_SEND, T8].map((d) => d.toISOString()));
      // Jul 8 -> Jul 14 is 6.0 days (a late first step followed by A's own Day 10): the one flagged gap
      expect(report.attempts.filter((a) => a.underSpacing).map((a) => a.row.occurred_at.toISOString())).toEqual([T3.toISOString()]);
      expect(report.schedules).toHaveLength(1);
      expect(report.sequences).toHaveLength(3);
      expect(report.holds.map((h) => h.kind)).toEqual(['collection_hold']);
      expect(report.controls.map((x) => x.action)).toEqual(['combined_reminders_pause', 'combined_reminders_resume']);

      const text = Timeline.formatReport(report).join('\n');
      const events = Timeline.buildEvents(report);
      expect(events.map((e) => e.at.getTime())).toEqual(events.map((e) => e.at.getTime()).sort((x, y) => x - y));
      expect(text).toContain('** UNDER 7 DAYS **');
      expect(text).toContain('touches under 7 days apart: 1');
      expect(text).toContain('staff press  combined_reminders_pause  done');
      expect(text).toContain('staff press  combined_reminders_resume  done');
      expect(text).toContain('closed 2026-10-01T14:16:00.000Z reason final_notice_delivered');
      for (const personal of ['Test', 'Customer', EMAIL, PHONE, 'synthetic billing question', 'SMS[']) expect(text).not.toContain(personal);

      // the transaction is read only: Postgres itself refuses a write through it
      await expect(Timeline.inReadOnlyTransaction(app, (trx) => trx('collections_flags').insert({ customer_id: c, flag: 'do_not_text' })))
        .rejects.toThrow(/read-only transaction/);
      expect(await app('collections_flags').where({ customer_id: c, flag: 'do_not_text' })).toHaveLength(0);
    });
  });

  // ══ branches, each on a fresh customer ═══════════════════════════════════
  describe('branches', () => {
    test('(i) everything is paid mid-episode: the schedule closes on balance_cleared, nothing is sent, nobody is alerted', async () => {
      const customer = await newCustomer();
      const c = customer.id;
      jest.setSystemTime(T1);
      const x = await addInvoice(customer, { sentAt: A_SENT, total: 100 });
      const y = await addInvoice(customer, { sentAt: B_SENT, total: 150 });
      await tick(T1);
      await tick(T2);
      expect(takeSends()).toHaveLength(2); // the first combined step went out (email + text)
      expectSchedule(await only(c), { status: 'active', step_index: 1, touches_sent: 1 });

      jest.setSystemTime(at('2026-07-09T12:00:00Z'));
      await pay(x);
      await pay(y);
      expect((await mockResolve(c)).kind).toBe('empty');
      const sentBefore = await ledgerCount(c);

      const out = await tick(at('2026-07-14T14:16:00Z')); // Day 10 would have been due
      expect(out.outcomes).toEqual({ closed: 1 });
      expect(takeSends()).toEqual([]);
      expect(await ledgerCount(c)).toBe(sentBefore); // nothing reserved either
      const row = await only(c);
      expect(row).toMatchObject({ status: 'completed', closed_reason: 'balance_cleared', step_index: 1, touches_sent: 1 });
      expect(row.next_touch_at).toBeNull();
      expect(time(row.closed_at)).toBe(at('2026-07-14T14:16:00Z').getTime());
      expect(row.touch_claimed_at).toBeNull();
      noAlerts();
      // and it stays closed: a later tick neither sends nor starts a second episode
      expect(await tick(at('2026-07-21T14:16:00Z'))).toMatchObject({ promoted: [], processed: 0 });
      expect(await scheduleRows(c)).toHaveLength(1);
    });

    test('(ii) a staff release after a TOLD step: members go back to their own ladder AFTER it, so nothing already told repeats', async () => {
      const customer = await newCustomer();
      const c = customer.id;
      jest.setSystemTime(T1);
      const x = await addInvoice(customer, { sentAt: A_SENT, total: 100 });
      const y = await addInvoice(customer, { sentAt: B_SENT, total: 150 });
      const labels = { [x]: 'X', [y]: 'Y' };
      await tick(T1);
      await tick(T2); // Day 3, both legs: delivered, advanced to step 1
      takeSends();

      // Day 10: the text reaches the customer, the email leg is refused retryably -> TOLD (the step stays, the email retries)
      emailMode = 'fail';
      let told;
      try { told = await tick(T3); } finally { emailMode = 'accept'; }
      expect(told.outcomes).toEqual({ told: 1 });
      expect(takeSends().map((s) => s.channel)).toEqual(['sms']);
      const row = await only(c);
      expectSchedule(row, { status: 'active', step_index: 1, touches_sent: 1, last_touch_at: T3 }); // still on Day 10, which has already reached them by text
      const ledger = await app('collections_contact_ledger').where({ customer_id: c }).orderBy('occurred_at').orderBy('channel').select('channel', 'metadata', 'occurred_at');
      const day10 = ledger.filter((r) => r.metadata.step_id === 'd7_reminder');
      expect(day10.map((r) => [r.channel, r.metadata.delivered === true, r.metadata.send_failed === true])).toEqual([['email', false, true], ['sms', true, false]]);

      // staff release, later that day
      const adminId = randomUUID();
      const releasedAt = at('2026-07-14T16:00:00Z');
      jest.setSystemTime(releasedAt);
      const released = await Wiring.controlCustomerSchedule(c, 'release', { adminId, now: releasedAt });
      expect(released.status).toBe(200);
      const closed = await only(c);
      expect(closed).toMatchObject({ status: 'released', closed_reason: 'released_admin' });
      expect(closed.next_touch_at).toBeNull();

      // each member lands on its OWN ladder at the step AFTER the told Day 10 (Day 17 = index 2): never Day 3, never Day 10 again
      const landed = await app('invoice_followup_sequences').where({ customer_id: c }).orderBy('invoice_id').select('invoice_id', 'status', 'step_index', 'next_touch_at');
      const byLabel = Object.fromEntries(landed.map((r) => [labels[r.invoice_id], r]));
      expect(byLabel.X).toMatchObject({ status: 'active', step_index: 2 });
      expect(byLabel.Y).toMatchObject({ status: 'active', step_index: 2 });
      expect(time(byLabel.X.next_touch_at)).toBe(time(Followups.computeNextTouchAt(A_SENT, 2)));
      expect(time(byLabel.Y.next_touch_at)).toBe(time(Followups.computeNextTouchAt(B_SENT, 2)));
      expect(await sequences(c, labels)).toMatchObject({ X: { claimed: false }, Y: { claimed: false } });

      // the per-invoice batch owns them again: nothing before their own Day 17, both rows on it once due
      expect(await batchFor(c, at('2026-07-17T14:16:00Z'))).toEqual([]);
      expect(await batchFor(c, at('2026-07-21T14:16:00Z'))).toEqual([x, y]);

      // With the live gate on, the next run promotes a customer with two active invoices again (a release restarts the
      // episode, it does not switch the schedule off). What matters here: the new episode starts at the landing step,
      // so neither Day 3 nor the already-told Day 10 is ever sent again, and nothing is sent in that run.
      const again = await tick(at('2026-07-15T14:16:00Z'));
      expect(again.promoted).toHaveLength(1);
      expect(again.processed).toBe(0);
      const episodes = await scheduleRows(c);
      expect(episodes.map((e) => [e.episode, e.status])).toEqual([[1, 'released'], [2, 'active']]);
      expect(episodes[1]).toMatchObject({ step_index: 2 });
      expect(time(episodes[1].next_touch_at)).toBe(at('2026-07-18T14:00:00Z').getTime()); // A's own Day 17
      expect(takeSends()).toEqual([]);
      const presses = await app('activity_log').where({ customer_id: c }).select('action', 'admin_user_id');
      expect(presses).toEqual([{ action: 'combined_reminders_release', admin_user_id: adminId }]);
      noAlerts();
    });
  });
});
