// Customer-level overdue reminders: what release and a delivered final notice leave on EVERY member row, against
// the fully MIGRATED database (Codex #5503 r3; skipped without APP_TEST_DATABASE_URL, run for real in CI).
//   * a member that is not active (paused from the invoice panel, autopay-held, a quiet completed row) keeps its
//     status through a release, but its step moves past what the combined schedule delivered, so a later resume
//     never repeats a delivered step;
//   * every invoice a delivered final named (active, quiet completed, or with no sequence at all) is left with
//     terminal evidence the per-invoice paths honour: neither revival pass revives it and orphan adoption does
//     not arm it.
// Synthetic customers only; every row this suite writes is removed afterwards.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const target = function db() {};
  return new Proxy(target, {
    apply: (_t, _this, args) => mockDatabase(...args),
    get: (_t, prop) => {
      const value = mockDatabase[prop];
      return typeof value === 'function' ? value.bind(mockDatabase) : value;
    },
  });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const Schedule = require('../services/customer-dunning/schedule');
const Followups = require('../services/invoice-followups');
const { SOURCE, eventKey } = require('../services/customer-dunning/constants');
const { reminderReservationKey } = require('../services/billing-reminder-delivery');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(120000);

const DAY = 24 * 60 * 60 * 1000;
const TABLE = 'customer_dunning_schedules';
const SEQ = 'invoice_followup_sequences';

postgres('customer-level reminders leave every member row with what was delivered (PostgreSQL)', () => {
  const created = { customers: new Set(), invoices: new Set() };
  const saved = {};

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    mockDatabase = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    if (!(await mockDatabase.schema.hasTable(TABLE))) throw new Error('run the migrations first: customer_dunning_schedules is missing');
    for (const k of ['GATE_DUNNING_LADDER_90', 'GATE_LATE_PAYMENT_CHECKER_OFF']) saved[k] = process.env[k];
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    process.env.GATE_LATE_PAYMENT_CHECKER_OFF = 'true'; // both revival passes live
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (!mockDatabase) return;
    const customers = [...created.customers];
    const invoices = [...created.invoices];
    const bestEffort = async (fn) => { try { await fn(); } catch { /* cleanup only */ } };
    await bestEffort(() => mockDatabase('collections_contact_ledger').whereIn('customer_id', customers).del());
    await bestEffort(() => mockDatabase(TABLE).whereIn('customer_id', customers).del());
    await bestEffort(() => mockDatabase(SEQ).whereIn('invoice_id', invoices).del());
    await bestEffort(() => mockDatabase('invoices').whereIn('id', invoices).del());
    await bestEffort(() => mockDatabase('customers').whereIn('id', customers).del());
    await mockDatabase.destroy();
  });

  async function customer() {
    const id = randomUUID();
    created.customers.add(id);
    await mockDatabase('customers').insert({ id, first_name: 'Synthetic', last_name: 'Member', phone: `+1999570${String(Math.floor(Math.random() * 9000) + 1000)}` });
    return id;
  }
  // An open invoice; with `seq`, its per-invoice row ({ status, step, ... }), else none at all.
  async function invoice(customerId, { sentDaysAgo = 40, seq = { status: 'active', step: 3 } } = {}) {
    const id = randomUUID();
    created.invoices.add(id);
    const sentAt = new Date(Date.now() - sentDaysAgo * DAY);
    await mockDatabase('invoices').insert({
      id, customer_id: customerId, status: 'sent', sent_at: sentAt, created_at: sentAt,
      token: `tok-${id}`, invoice_number: `QA-${id.slice(0, 8)}`, total: 100,
    });
    if (seq) {
      await mockDatabase(SEQ).insert({
        invoice_id: id, customer_id: customerId, status: seq.status, step_index: seq.step,
        next_touch_at: seq.status === 'active' ? new Date(Date.now() + DAY) : null,
        paused_reason: seq.status === 'paused' ? 'admin_paused' : null,
        is_autopay_held: seq.status === 'autopay_hold',
      });
    }
    return id;
  }
  const seqOf = (invoiceId) => mockDatabase(SEQ).where({ invoice_id: invoiceId }).first();
  const openSchedule = (customerId, over = {}) => mockDatabase(TABLE).insert({
    customer_id: customerId, episode: 1, status: 'active', step_index: 3, next_touch_at: new Date(Date.now() + DAY), touches_sent: 3, ...over,
  }).returning('*').then(([row]) => row);
  async function delivered(schedule, stepIndex, invoiceIds) {
    const key = eventKey(schedule, Schedule.STEPS[stepIndex].id);
    await mockDatabase('collections_contact_ledger').insert({
      customer_id: schedule.customer_id, channel: 'sms', purpose: 'late_payment', source: SOURCE,
      invoice_ids: JSON.stringify(invoiceIds), idempotency_key: reminderReservationKey(schedule.customer_id, key, 'sms'),
      metadata: JSON.stringify({ notificationEventKey: key, delivered: true, selectedChannels: ['sms'] }),
    });
  }

  describe('release keeps a non-active member\'s status but moves its step past what was delivered', () => {
    test('a member paused from the invoice panel: released after a delivered Day 30, then resumed, it never repeats Day 30', async () => {
      const c = await customer();
      const active = await invoice(c, { sentDaysAgo: 45, seq: { status: 'active', step: 2 } });
      const paused = await invoice(c, { sentDaysAgo: 40, seq: { status: 'paused', step: 1 } });
      const held = await invoice(c, { sentDaysAgo: 38, seq: { status: 'autopay_hold', step: 0 } });
      const schedule = await openSchedule(c, { step_index: 3, last_touch_at: new Date() }); // d30, delivered (TOLD)
      await delivered(schedule, 3, [active, paused, held]);

      const out = await Schedule.release(schedule, 'released_admin', new Date());
      expect(out.closed).toBe(true);
      expect(await seqOf(active)).toMatchObject({ status: 'active', step_index: 4 });
      // status, reason and hold untouched (release never un-pauses); the step is past the delivered Day 30
      expect(await seqOf(paused)).toMatchObject({ status: 'paused', paused_reason: 'admin_paused', step_index: 4, next_touch_at: null });
      expect(await seqOf(held)).toMatchObject({ status: 'autopay_hold', is_autopay_held: true, step_index: 4 });

      await Followups.resumeSequence(paused);
      const resumed = await seqOf(paused);
      expect(resumed.status).toBe('active');
      expect(resumed.step_index).toBe(4); // Day 60 next, never Day 7 / 14 / 30 again
    });

    test('nothing delivered at the current step: a paused member moves up to the schedule\'s step, never down', async () => {
      const c = await customer();
      await invoice(c, { seq: { status: 'active', step: 1 } });
      const low = await invoice(c, { seq: { status: 'paused', step: 0 } });
      const high = await invoice(c, { sentDaysAgo: 100, seq: { status: 'paused', step: 5 } });
      const schedule = await openSchedule(c, { step_index: 2 });
      await Schedule.release(schedule, 'released_admin', new Date());
      expect(await seqOf(low)).toMatchObject({ status: 'paused', step_index: 2 });
      expect(await seqOf(high)).toMatchObject({ status: 'paused', step_index: 5 });
    });
  });

  describe('a delivered final notice leaves terminal evidence on every invoice it named', () => {
    async function noReminderRevivesOrAdopts(invoiceIds) {
      const before = await mockDatabase(SEQ).whereIn('invoice_id', invoiceIds).orderBy('invoice_id').select('invoice_id', 'status', 'step_index', 'next_touch_at');
      await Followups._test.reviveLegacyFinishedSequences();
      await Followups._test.reviveReopenedLowStepSequences();
      const after = await mockDatabase(SEQ).whereIn('invoice_id', invoiceIds).orderBy('invoice_id').select('invoice_id', 'status', 'step_index', 'next_touch_at');
      expect(after).toEqual(before);
      const { candidates } = await Followups.adoptOrphanInvoices({ dryRun: true });
      expect(candidates.filter((cand) => invoiceIds.includes(String(cand.invoice_id)))).toEqual([]);
    }

    test('completeFinal: active + quiet completed + sequence-less named => all exhausted; no revival pass or adoption brings one back', async () => {
      const c = await customer();
      const active = await invoice(c, { sentDaysAgo: 95, seq: { status: 'active', step: 5 } });
      const quietDay60 = await invoice(c, { sentDaysAgo: 70, seq: { status: 'completed', step: 4 } }); // Day 60/90 revival range
      const quietLow = await invoice(c, { sentDaysAgo: 60, seq: { status: 'completed', step: 1 } }); // reopened low-step range
      const none = await invoice(c, { sentDaysAgo: 65, seq: null }); // adoption range
      const pausedNamed = await invoice(c, { sentDaysAgo: 62, seq: { status: 'paused', step: 2 } });
      const stamp = new Date();
      const schedule = await openSchedule(c, { step_index: 5, touch_claimed_at: stamp });
      const named = [active, quietDay60, quietLow, none, pausedNamed];

      const out = await Schedule.completeFinal(schedule, { claimStamp: stamp, deliveredAt: new Date(), namedInvoiceIds: named });
      expect(out.completed).toBe(true);
      const exhausted = Schedule.STEPS.length;
      expect(await seqOf(active)).toMatchObject({ status: 'completed', step_index: exhausted, next_touch_at: null });
      expect(await seqOf(quietDay60)).toMatchObject({ status: 'completed', step_index: exhausted });
      expect(await seqOf(quietLow)).toMatchObject({ status: 'completed', step_index: exhausted });
      expect(await seqOf(none)).toMatchObject({ status: 'completed', step_index: exhausted, customer_id: c, next_touch_at: null });
      expect(await seqOf(pausedNamed)).toMatchObject({ status: 'paused', step_index: exhausted });
      await noReminderRevivesOrAdopts(named);
    });

    test('release over a delivered final: the same terminal evidence, sequence-less named invoice included', async () => {
      const c = await customer();
      const active = await invoice(c, { sentDaysAgo: 95, seq: { status: 'active', step: 5 } });
      const quiet = await invoice(c, { sentDaysAgo: 70, seq: { status: 'completed', step: 4 } });
      const none = await invoice(c, { sentDaysAgo: 65, seq: null });
      const schedule = await openSchedule(c, { step_index: 5, last_touch_at: new Date() });
      await delivered(schedule, 5, [active, quiet, none]);
      const out = await Schedule.release(schedule, 'released_admin', new Date());
      expect(out.closed).toBe(true);
      const exhausted = Schedule.STEPS.length;
      for (const id of [active, quiet, none]) expect(await seqOf(id)).toMatchObject({ status: 'completed', step_index: exhausted });
      await noReminderRevivesOrAdopts([active, quiet, none]);
    });
  });
});
