// Customer-level overdue reminders — the LIVE wiring against a real
// PostgreSQL in a disposable schema (skipped without APP_TEST_DATABASE_URL,
// run for real in CI). What is proven here is the locking, which a fake
// cannot prove:
//   * fireStep takes the customer's dunning key SHARED before its invoice row
//     lock, the order the engine's claim uses (advisory EXCLUSIVE -> schedule
//     row -> member invoice rows -> sequence rows). An invoice held by
//     someone else while a claim and a per-invoice fire race for it never
//     deadlocks, and the owned row is never claimed or fired.
//   * a promotion racing fireStep / sendNextTouchNow: whichever commits
//     second sees the first (the owned row never fires; a fired row blocks
//     nothing it should not).
//   * the batch ownership predicate excludes exactly the owned customers and,
//     with no schedule rows, nothing.
//   * the kill switch releases open schedules and lands their members: a step
//     that already reached the customer is never sent again (a delivered final
//     completes what it named), a paused schedule's pause survives, and with the
//     Day 90 ladder off a member past Day 30 is handed to the legacy checker.
//   * the pre-visit balance note counts only a touch the schedule itself made.
// Interleavings are forced by pausing a transaction at its shared-key
// statement (`pauseAt`), never by timing alone.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
// When set, a transaction's raw statement matching `mockPause.pattern` waits
// on `mockPause.wait` first (before the statement runs).
let mockPause = null;
jest.mock('../models/db', () => {
  const pausing = (trx) => new Proxy(trx, {
    apply: (target, _this, args) => target(...args),
    get: (target, prop) => {
      if (prop !== 'raw') return target[prop];
      return async (sql, bindings) => {
        const pause = mockPause;
        if (pause && pause.pattern.test(sql)) {
          pause.reached();
          await pause.wait;
        }
        return target.raw(sql, bindings);
      };
    },
  });
  const database = (...args) => mockDatabase(...args);
  database.transaction = (fn, ...rest) => (typeof fn === 'function'
    ? mockDatabase.transaction((trx) => fn(pausing(trx)), ...rest)
    : mockDatabase.transaction(fn, ...rest));
  database.raw = (...args) => mockDatabase.raw(...args);
  Object.defineProperty(database, 'fn', { get: () => mockDatabase.fn });
  Object.defineProperty(database, 'schema', { get: () => mockDatabase.schema });
  Object.defineProperty(database, 'client', { get: () => mockDatabase.client });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockResolve = jest.fn();
jest.mock('../services/customer-dunning/balance-set', () => ({
  resolveDunnableSet: (...a) => mockResolve(...a),
}));
const mockNotify = jest.fn(async () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));

const migration = require('../models/migrations/20260930010000_customer_dunning_schedules');
const logger = require('../services/logger');
const FeatureGates = require('../config/feature-gates');
const Followups = require('../services/invoice-followups');
const Schedule = require('../services/customer-dunning/schedule');
const Wiring = require('../services/customer-dunning/wiring');
const Previsit = require('../services/previsit-balance-reminder');
const { reminderReservationKey } = require('../services/billing-reminder-delivery');
const { SOURCE, eventKey } = require('../services/customer-dunning/constants');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `customer_dunning_wiring_${randomUUID().replaceAll('-', '')}`;
jest.setTimeout(60000);

const DAY = 24 * 60 * 60 * 1000;

// `reached` rejects after 5 s: a transaction that never gets to its pause point
// is itself blocked on a lock it should not hold yet (a wrong lock order).
const openGates = [];
function pauseAt(pattern) {
  let release;
  let reached;
  const reachedP = new Promise((r) => { reached = r; });
  mockPause = { pattern, wait: new Promise((r) => { release = r; }), reached };
  const timeout = new Promise((_r, reject) => setTimeout(() => reject(new Error(`never reached ${pattern}: blocked on a lock before it`)), 5000).unref());
  const gate = { reached: Promise.race([reachedP, timeout]), release: () => { mockPause = null; release(); } };
  openGates.push(gate);
  return gate;
}

postgres('customer-dunning live wiring (PostgreSQL)', () => {
  let admin;
  let app;
  const savedGates = {};

  beforeAll(async () => {
    savedGates.ladder = process.env.GATE_DUNNING_LADDER_90;
    savedGates.pay = FeatureGates.gates.payIncludeBalance;
    process.env.GATE_DUNNING_LADDER_90 = 'true';
    FeatureGates.gates.payIncludeBalance = true;
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    admin = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    await admin.schema.createSchema(schema);
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 8 } });
    mockDatabase = app;
    await app.schema.createTable('customers', (t) => { t.uuid('id').primary(); t.timestamp('deleted_at'); t.text('first_name'); t.text('last_name'); });
    await app.schema.createTable('invoices', (t) => {
      t.uuid('id').primary();
      t.uuid('customer_id');
      t.string('status');
      t.timestamp('created_at');
      t.timestamp('sent_at');
      t.timestamp('sms_sent_at');
      t.uuid('payer_id');
      t.string('scheduled_send_error');
      t.string('token'); t.string('title'); t.decimal('total', 10, 2); t.decimal('credit_applied', 10, 2);
      t.string('stripe_payment_intent_id'); t.date('service_date'); t.date('due_date'); t.string('invoice_number');
    });
    await app.schema.createTable('invoice_followup_sequences', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('invoice_id');
      t.uuid('customer_id');
      t.string('status');
      t.integer('step_index').defaultTo(0);
      t.timestamp('next_touch_at');
      t.timestamp('last_touch_at');
      t.integer('touches_sent').defaultTo(0);
      t.timestamp('touch_claimed_at');
      t.timestamp('anchor_at');
      t.text('paused_reason');
      t.uuid('paused_by_admin_id');
      t.timestamp('created_at').defaultTo(app.fn.now());
      t.timestamp('updated_at').defaultTo(app.fn.now());
    });
    // the delivery ledger the release reads the current step's evidence from (production columns)
    await app.schema.createTable('collections_contact_ledger', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable();
      t.string('channel', 20).notNullable();
      t.string('purpose', 40).notNullable();
      t.jsonb('invoice_ids').notNullable().defaultTo('[]');
      t.timestamp('occurred_at', { useTz: true }).notNullable().defaultTo(app.fn.now());
      t.string('source', 60).notNullable();
      t.jsonb('metadata');
      t.string('idempotency_key', 120).unique();
    });
    await migration.up(app);
  });

  afterAll(async () => {
    if (savedGates.ladder === undefined) delete process.env.GATE_DUNNING_LADDER_90;
    else process.env.GATE_DUNNING_LADDER_90 = savedGates.ladder;
    FeatureGates.gates.payIncludeBalance = savedGates.pay;
    mockPause = null;
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  beforeEach(() => { mockResolve.mockReset(); mockNotify.mockClear(); jest.clearAllMocks(); mockPause = null; });
  // A failed test must never leave a transaction parked at a pause (it would hold its locks and block the schema drop).
  afterEach(() => { while (openGates.length) openGates.pop().release(); });

  // ── fixtures (synthetic ids; the customer is archived on purpose: a
  // per-invoice touch that DOES fire stops at "customer is soft-deleted" and
  // pauses its row, which is the observable "fired" signal) ───────────────
  async function customer() {
    const id = randomUUID();
    await app('customers').insert({ id, first_name: 'Sam', last_name: 'Fixture', deleted_at: new Date() });
    return id;
  }
  async function member(customerId, { sentDaysAgo = 40, step = 3, due = true, claimedAt = null, pi = null } = {}) {
    const invoiceId = randomUUID();
    const sentAt = new Date(Date.now() - sentDaysAgo * DAY);
    await app('invoices').insert({
      id: invoiceId, customer_id: customerId, status: 'overdue', created_at: sentAt, sent_at: sentAt, token: `tok-${invoiceId.slice(0, 8)}`, stripe_payment_intent_id: pi,
    });
    const [seq] = await app('invoice_followup_sequences').insert({
      invoice_id: invoiceId, customer_id: customerId, status: 'active', step_index: step,
      next_touch_at: due ? new Date(Date.now() - 60 * 1000) : new Date(Date.now() + 5 * DAY), touch_claimed_at: claimedAt,
    }).returning('*');
    return { invoiceId, seq, sentAt, pi };
  }
  const batchRow = (m) => ({ ...m.seq, invoice_id: m.invoiceId, invoice_stripe_pi: m.pi || null });
  async function openSchedule(customerId, over = {}) {
    const [row] = await app('customer_dunning_schedules').insert({
      customer_id: customerId, episode: 1, status: 'active', step_index: 3,
      next_touch_at: new Date(Date.now() - 60 * 1000), touches_sent: 3, ...over,
    }).returning('*');
    return row;
  }
  const setFor = (members) => ({
    kind: 'multi', reason: null, anchor: { id: members[0].invoiceId },
    members: members.map((m) => ({ invoice_id: m.invoiceId, cents: 10000, seqStatus: 'active', quiet: false })),
    totalCents: 10000 * members.length, digest: 'd', activeCount: members.length, excluded: { stopped: [], md: [] },
  });
  const seqRow = (id) => app('invoice_followup_sequences').where({ id }).first();
  const fired = () => logger.info.mock.calls.filter(([line]) => /is soft-deleted/.test(line)).length;
  const deadlocks = () => [...logger.error.mock.calls, ...logger.warn.mock.calls].filter(([line]) => /deadlock/i.test(String(line)));

  // Wait until another backend in this schema's database is waiting on a lock,
  // or `ms` passes (the correct lock order never makes the racer wait here).
  async function untilSomeoneWaits(ms = 1500) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const { rows } = await admin.raw("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
      if (rows[0].n > 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  // ── lock order ─────────────────────────────────────────────────────────
  describe('fireStep vs the engine\'s claim (lock order)', () => {
    // The mutation guard: with fireStep locking its invoice row BEFORE the
    // shared key, the paused fireStep would hold A's invoice, the claim would
    // take the key exclusively and queue on that invoice, and fireStep's key
    // request would then close the cycle (40P01).
    test('a claim racing a per-invoice fire on an owned customer: no deadlock, and fireStep never claims the owned row', async () => {
      const c = await customer();
      const a = await member(c);
      const b = await member(c, { sentDaysAgo: 35, step: 2 });
      const schedule = await openSchedule(c);
      const gate = pauseAt(/pg_advisory_xact_lock_shared/);
      const fire = Followups._test.fireStep(batchRow(a));
      await gate.reached;
      const claim = Schedule.claim(schedule.id, new Date(), { force: true });
      await Promise.race([claim, untilSomeoneWaits()]);
      gate.release();
      const [fireOut, claimed] = await Promise.all([fire, claim]);
      expect(deadlocks()).toEqual([]);
      expect(claimed).not.toBeNull();
      expect(fireOut).toEqual({ ownedBy: schedule.id });
      expect(fired()).toBe(0);
      // A's stamp is the CLAIM's, never fireStep's
      expect(new Date((await seqRow(a.seq.id)).touch_claimed_at).getTime()).toBe(claimed.claimStamp.getTime());
      await Schedule.releaseClaim(claimed);
      expect((await seqRow(b.seq.id)).touch_claimed_at).toBeNull();
    });

    test('an invoice held by a third party (an edit, a settlement) while both race for it: no deadlock, owned row never fired', async () => {
      const c = await customer();
      const a = await member(c);
      await member(c, { sentDaysAgo: 35, step: 2 });
      const schedule = await openSchedule(c);
      const holder = await app.transaction();
      await holder('invoices').where({ id: a.invoiceId }).forUpdate().first('id');
      const gate = pauseAt(/pg_advisory_xact_lock_shared/);
      const fire = Followups._test.fireStep(batchRow(a));
      await gate.reached;
      const claim = Schedule.claim(schedule.id, new Date(), { force: true });
      expect(await untilSomeoneWaits()).toBe(true); // the claim queues on the holder's invoice row
      gate.release();
      await new Promise((r) => setTimeout(r, 200));
      await holder.commit();
      const [fireOut, claimed] = await Promise.all([fire, claim]);
      expect(deadlocks()).toEqual([]);
      expect(claimed).not.toBeNull();
      expect(fireOut).toEqual({ ownedBy: schedule.id });
      expect(fired()).toBe(0);
      await Schedule.releaseClaim(claimed);
    });

    test('fireStep holding the shared key + its invoice row makes the claim wait, never deadlock', async () => {
      const c = await customer();
      const a = await member(c);
      await member(c, { sentDaysAgo: 35, step: 2 });
      const schedule = await openSchedule(c);
      // paused at its ownership read: it holds the key (shared) and A's invoice row
      const gate = pauseAt(/FROM customer_dunning_schedules WHERE customer_id = \?/);
      const fire = Followups._test.fireStep(batchRow(a));
      await gate.reached;
      const claim = Schedule.claim(schedule.id, new Date(), { force: true });
      expect(await untilSomeoneWaits()).toBe(true); // the claim waits for the key
      gate.release();
      const [fireOut, claimed] = await Promise.all([fire, claim]);
      expect(deadlocks()).toEqual([]);
      expect(fireOut).toEqual({ ownedBy: schedule.id });
      expect(fired()).toBe(0);
      expect(claimed).not.toBeNull();
      await Schedule.releaseClaim(claimed);
    });

    test('control: a customer with NO schedule still fires through the same fence', async () => {
      const c = await customer();
      const a = await member(c);
      expect(await Followups._test.fireStep(batchRow(a))).toBeUndefined();
      expect(fired()).toBe(1);
      const after = await seqRow(a.seq.id);
      expect(after.touch_claimed_at).toBeNull(); // claimed, then cleared in finally
      expect(after.status).toBe('paused'); // the archived-customer stop: the touch did run
    });
  });

  // ── promotion races ────────────────────────────────────────────────────
  describe('promotion vs the per-invoice paths', () => {
    test('promotion commits while fireStep waits for the key: the row is owned and never fires', async () => {
      const c = await customer();
      const a = await member(c);
      const b = await member(c, { sentDaysAgo: 30, step: 2, due: false });
      mockResolve.mockResolvedValue(setFor([a, b]));
      const gate = pauseAt(/pg_advisory_xact_lock_shared/);
      const fire = Followups._test.fireStep(batchRow(a));
      await gate.reached;
      const promoted = await Schedule.promoteCustomer(c, new Date());
      expect(promoted.promoted).toBe(true);
      gate.release();
      expect(await fire).toEqual({ ownedBy: promoted.schedule.id });
      expect(fired()).toBe(0);
      expect((await seqRow(a.seq.id)).touch_claimed_at).toBeNull();
    });

    test('fireStep holding the key: the promotion waits, then sees the fresh claim or the settled row — never a deadlock, one fire', async () => {
      const c = await customer();
      const a = await member(c);
      const b = await member(c, { sentDaysAgo: 30, step: 2, due: false });
      mockResolve.mockResolvedValue(setFor([a, b]));
      const gate = pauseAt(/FROM customer_dunning_schedules WHERE customer_id = \?/);
      const fire = Followups._test.fireStep(batchRow(a));
      await gate.reached;
      const promotion = Schedule.promoteCustomer(c, new Date());
      expect(await untilSomeoneWaits()).toBe(true);
      gate.release();
      const [fireOut, promoted] = await Promise.all([fire, promotion]);
      expect(deadlocks()).toEqual([]);
      expect(fireOut).toBeUndefined(); // not owned when it looked: it fired (and stopped at the archived customer)
      expect(fired()).toBe(1);
      expect(['member_claim_fresh', 'fewer_than_two_active_members', undefined]).toContain(promoted.reason);
    });

    // Codex #5503 r2 P1: the operator confirmed the invoice's own step (the panel loaded before the
    // promotion), so the combined step the schedule now owns is never sent unseen.
    test('sendNextTouchNow racing a promotion: the click is refused for confirmation (nothing sent) and the member row is left as it was', async () => {
      const c = await customer();
      const a = await member(c, { due: false });
      const b = await member(c, { sentDaysAgo: 30, step: 2, due: false });
      mockResolve.mockResolvedValue(setFor([a, b]));
      const before = await seqRow(a.seq.id);
      const toSchedule = jest.spyOn(Wiring, 'sendNowForSchedule');
      const gate = pauseAt(/pg_advisory_xact_lock_shared/);
      const click = Followups.sendNextTouchNow(a.invoiceId, { operatorInitiated: true });
      await gate.reached;
      const promoted = await Schedule.promoteCustomer(c, new Date());
      expect(promoted.promoted).toBe(true);
      gate.release();
      expect(await click).toMatchObject({
        routedTo: 'customer_schedule', scheduleId: promoted.schedule.id, ok: false, reason: 'combined_confirm_required',
      });
      expect(toSchedule).not.toHaveBeenCalled();
      expect(await app('customer_dunning_schedules').where({ id: promoted.schedule.id }).first('touch_claimed_at'))
        .toEqual({ touch_claimed_at: null });
      const after = await seqRow(a.seq.id);
      expect(after.status).toBe('active');
      expect(new Date(after.next_touch_at).getTime()).toBe(new Date(before.next_touch_at).getTime()); // not re-armed
      expect(after.touch_claimed_at).toBeNull();
      expect(fired()).toBe(0);
      toSchedule.mockRestore();
    });
  });

  // ── the batch predicate ────────────────────────────────────────────────
  describe('runPending batch ownership predicate', () => {
    const select = (ids, withPredicate) => {
      const q = app('invoice_followup_sequences as s').whereIn('s.customer_id', ids).where('s.status', 'active');
      if (withPredicate) q.where(Followups._test.notOwnedByCustomerSchedule);
      return q.orderBy('s.id').pluck('s.id');
    };

    test('no schedule rows: excludes nothing (byte-identical batch); an OPEN schedule excludes its customer; a closed one does not', async () => {
      const owned = await customer();
      const free = await customer();
      const closed = await customer();
      for (const id of [owned, free, closed]) { await member(id); await member(id, { step: 2 }); }
      const ids = [owned, free, closed];
      expect(await select(ids, true)).toEqual(await select(ids, false));
      for (const status of ['active', 'held', 'paused', 'autopay_hold']) {
        const row = await openSchedule(owned, { status });
        const left = await app('invoice_followup_sequences').whereIn('id', await select(ids, true)).pluck('customer_id');
        expect(new Set(left)).toEqual(new Set([free, closed]));
        await app('customer_dunning_schedules').where({ id: row.id }).del();
      }
      await openSchedule(closed, { status: 'released', closed_reason: 'released_admin', closed_at: new Date() });
      await openSchedule(closed, { status: 'completed', episode: 2, closed_reason: 'balance_cleared', closed_at: new Date() });
      expect(await select(ids, true)).toEqual(await select(ids, false));
    });
  });

  // ── micro-deposit verification nudges (Codex local review P1) ──────────
  describe('an owned customer\'s invoice waiting on micro-deposit verification keeps its own sender', () => {
    const StripeService = require('../services/stripe');
    let waiting;
    let stripeSpy;
    let savedGate;
    beforeEach(() => {
      waiting = new Set();
      savedGate = FeatureGates.gates.divertMicrodepositDunning;
      FeatureGates.gates.divertMicrodepositDunning = true;
      stripeSpy = jest.spyOn(StripeService, 'isInvoiceAwaitingMicrodepositVerification')
        .mockImplementation(async (inv) => waiting.has(String(inv.id)));
    });
    afterEach(() => { stripeSpy.mockRestore(); FeatureGates.gates.divertMicrodepositDunning = savedGate; });

    test('the batch predicate: an owned customer\'s PaymentIntent rows stay candidates, its other rows stay out; no schedule rows: nothing excluded', async () => {
      const owned = await customer();
      const free = await customer();
      const withPi = await member(owned, { pi: 'pi_md' });
      await member(owned);
      await member(free, { pi: 'pi_free' });
      await member(free);
      const ids = [owned, free];
      const select = (predicate) => app('invoice_followup_sequences as s').join('invoices as i', 's.invoice_id', 'i.id')
        .whereIn('s.customer_id', ids).where('s.status', 'active').where(predicate).orderBy('s.id').pluck('s.id');
      const all = await app('invoice_followup_sequences').whereIn('customer_id', ids).orderBy('id').pluck('id');
      expect(await select(Followups._test.notOwnedOrMicrodepositCandidate)).toEqual(all);
      await openSchedule(owned, { status: 'paused' });
      const left = await select(Followups._test.notOwnedOrMicrodepositCandidate);
      const freeRows = await app('invoice_followup_sequences').where({ customer_id: free }).pluck('id');
      expect(new Set(left)).toEqual(new Set([...freeRows, withPi.seq.id]));
    });

    test('still waiting: fireStep (ownedMicrodeposit) claims the owned row and its touch runs; Stripe is asked after the claim committed', async () => {
      const c = await customer();
      const a = await member(c, { pi: 'pi_md' });
      await member(c, { sentDaysAgo: 35, step: 2 });
      await openSchedule(c);
      waiting.add(a.invoiceId);
      let heldKeysAtStripe = null;
      stripeSpy.mockImplementation(async (inv) => {
        // no lock is held by this backend while Stripe is asked: the claim already committed
        const { rows } = await admin.raw("select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and a.datname = current_database()");
        heldKeysAtStripe = rows[0].n;
        expect((await seqRow(a.seq.id)).touch_claimed_at).not.toBeNull();
        return waiting.has(String(inv.id));
      });
      expect(await Followups._test.fireStep(batchRow(a), { ownedMicrodeposit: true })).toBeUndefined();
      expect(heldKeysAtStripe).toBe(0);
      expect(fired()).toBe(1); // reached the touch (stopped at the archived customer)
      const after = await seqRow(a.seq.id);
      expect(after.status).toBe('paused');
      expect(after.touch_claimed_at).toBeNull();
    });

    test('no longer waiting by the touch: nothing sent, the row\'s step / due time / status unchanged, claim cleared', async () => {
      const c = await customer();
      const a = await member(c, { pi: 'pi_md' });
      await member(c, { sentDaysAgo: 35, step: 2 });
      await openSchedule(c);
      const before = await seqRow(a.seq.id);
      expect(await Followups._test.fireStep(batchRow(a), { ownedMicrodeposit: true })).toBeUndefined();
      expect(fired()).toBe(0);
      const after = await seqRow(a.seq.id);
      expect([after.status, after.step_index, after.next_touch_at?.getTime(), after.touch_claimed_at])
        .toEqual([before.status, before.step_index, before.next_touch_at?.getTime(), null]);
    });

    test('the engine\'s claim holds the member rows: a verification fire for one of them claims nothing and sends nothing', async () => {
      const c = await customer();
      const a = await member(c, { pi: 'pi_md' });
      await member(c, { sentDaysAgo: 35, step: 2 });
      const schedule = await openSchedule(c);
      waiting.add(a.invoiceId);
      const claimed = await Schedule.claim(schedule.id, new Date(), { force: true });
      expect(claimed).not.toBeNull();
      expect(await Followups._test.fireStep(batchRow(a), { ownedMicrodeposit: true })).toBeUndefined();
      expect(fired()).toBe(0);
      expect(stripeSpy).not.toHaveBeenCalled();
      expect(new Date((await seqRow(a.seq.id)).touch_claimed_at).getTime()).toBe(claimed.claimStamp.getTime());
      await Schedule.releaseClaim(claimed);
    });

    // Pre-push audit P1: the nudge claims only its own sequence, never the schedule; a release during it
    // would land the row and the send's progress write would then overwrite that landing.
    test('a verification fire in flight: a release (admin / kill switch) refuses as in flight, the schedule and members untouched', async () => {
      const c = await customer();
      const a = await member(c, { pi: 'pi_md' });
      const b = await member(c, { sentDaysAgo: 35, step: 2 });
      const schedule = await openSchedule(c, { status: 'paused', paused_reason: 'admin_paused', next_touch_at: null });
      waiting.add(a.invoiceId);
      let reached;
      const atStripe = new Promise((r) => { reached = r; });
      let release;
      const gate = new Promise((r) => { release = r; });
      stripeSpy.mockImplementation(async () => { reached(); await gate; return true; });
      const fire = Followups._test.fireStep(batchRow(a), { ownedMicrodeposit: true });
      await atStripe;
      const beforeB = await seqRow(b.seq.id);
      const out = await Schedule.release(schedule, 'released_admin', new Date());
      expect(out).toMatchObject({ closed: false, reason: 'in_flight' });
      expect((await app('customer_dunning_schedules').where({ id: schedule.id }).first()).status).toBe('paused');
      expect(await seqRow(b.seq.id)).toEqual(beforeB);
      release();
      await fire;
      expect(deadlocks()).toEqual([]);
    });

    test('a verification fire in flight (claimed, asking Stripe): the engine\'s claim refuses, never a deadlock, never both', async () => {
      const c = await customer();
      const a = await member(c, { pi: 'pi_md' });
      await member(c, { sentDaysAgo: 35, step: 2 });
      const schedule = await openSchedule(c);
      waiting.add(a.invoiceId);
      let reached;
      const atStripe = new Promise((r) => { reached = r; });
      let release;
      const gate = new Promise((r) => { release = r; });
      stripeSpy.mockImplementation(async () => { reached(); await gate; return true; });
      const fire = Followups._test.fireStep(batchRow(a), { ownedMicrodeposit: true });
      await atStripe;
      expect(await Schedule.claim(schedule.id, new Date(), { force: true })).toBeNull(); // member claim fresh
      release();
      await fire;
      expect(deadlocks()).toEqual([]);
      expect(fired()).toBe(1);
    });
  });

  // ── the kill switch ────────────────────────────────────────────────────
  describe('a delivered final notice ends the members for good', () => {
    test('members the final named are marked cadence-exhausted, so the Day 60/90 revival never restarts them', async () => {
      const c = await customer();
      // Day 60/90 debt: step 4 is inside the revival range [4, 6)
      const a = await member(c, { sentDaysAgo: 70, step: 4, due: false });
      const b = await member(c, { sentDaysAgo: 65, step: 4, due: false });
      const stamp = new Date(Date.now() - 1000);
      const schedule = await openSchedule(c, { step_index: 5, touch_claimed_at: stamp });
      const now = new Date();
      const out = await Schedule.completeFinal(schedule, {
        claimStamp: stamp, deliveredAt: now, namedInvoiceIds: [a.invoiceId, b.invoiceId], now,
      });
      expect(out.completed).toBe(true);
      for (const m of [a, b]) expect(await seqRow(m.seq.id)).toMatchObject({ status: 'completed', step_index: 6 });
      // the invoices are still unpaid (overdue): the per-invoice revival must leave them completed
      await Followups._test.reviveLegacyFinishedSequences();
      for (const m of [a, b]) expect(await seqRow(m.seq.id)).toMatchObject({ status: 'completed', next_touch_at: null });
    });
  });

  describe('releaseIfDark (kill switch)', () => {
    // Every open schedule is the kill switch's; settle the earlier tests' rows first.
    beforeEach(async () => {
      await app('customer_dunning_schedules').whereIn('status', ['active', 'held', 'paused', 'autopay_hold'])
        .update({ status: 'released', closed_reason: 'released_admin', closed_at: new Date(), touch_claimed_at: null });
    });

    test('gate off: every open schedule is released (released_gate_off) and its members land on their own ladder, none due this run', async () => {
      delete process.env.GATE_DUNNING_CUSTOMER_SCHEDULE;
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 40, step: 3, due: false });
      const b = await member(c, { sentDaysAgo: 20, step: 1, due: false });
      const schedule = await openSchedule(c, { step_index: 3 });
      const now = new Date();
      const tally = await Wiring.releaseIfDark(now);
      expect(tally.failed).toBe(0);
      const row = await app('customer_dunning_schedules').where({ id: schedule.id }).first();
      expect(row).toMatchObject({ status: 'released', closed_reason: 'released_gate_off' });
      for (const m of [a, b]) {
        const seq = await seqRow(m.seq.id);
        expect(seq.status).toBe('active');
        expect(seq.step_index).toBeGreaterThanOrEqual(3); // no step repeated
        expect(new Date(seq.next_touch_at).getTime()).toBeGreaterThan(now.getTime()); // nothing sends in this run
      }
      // and the batch now sees them again
      expect(await app('invoice_followup_sequences as s').where('s.customer_id', c).where(Followups._test.notOwnedByCustomerSchedule).count('* as n').first().then((r) => ({ n: Number(r.n) })))
        .toMatchObject({ n: 2 });
    });

    test('a prerequisite off releases as released_prereq_off; a send in flight is left for the next run', async () => {
      const c = await customer();
      // young debt: its landing stays inside the legacy Day 30 cadence the prerequisite-off run computes with
      await member(c, { sentDaysAgo: 8, step: 1, due: false });
      await member(c, { sentDaysAgo: 5, step: 0, due: false });
      const busy = await customer();
      await member(busy, { due: false });
      const busySchedule = await openSchedule(busy, { touch_claimed_at: new Date(Date.now() - 60 * 1000) });
      const schedule = await openSchedule(c, { step_index: 1 });
      delete process.env.GATE_DUNNING_LADDER_90;
      try {
        const tally = await Wiring.releaseIfDark(new Date());
        expect(tally.inFlight).toBeGreaterThanOrEqual(1);
      } finally {
        process.env.GATE_DUNNING_LADDER_90 = 'true';
      }
      expect(await app('customer_dunning_schedules').where({ id: schedule.id }).first()).toMatchObject({ status: 'released', closed_reason: 'released_prereq_off' });
      expect(await app('customer_dunning_schedules').where({ id: busySchedule.id }).first()).toMatchObject({ status: 'active', closed_reason: null });
      expect(mockNotify).not.toHaveBeenCalled();
      await app('customer_dunning_schedules').where({ id: busySchedule.id }).update({ touch_claimed_at: null });
    });
  });

  // ── release never repeats a delivered step (F1), keeps a pause (F2), honours the ladder-off handoff (F3) ──
  describe('what release does with each member', () => {
    beforeEach(async () => {
      await app('customer_dunning_schedules').whereIn('status', ['active', 'held', 'paused', 'autopay_hold'])
        .update({ status: 'released', closed_reason: 'released_admin', closed_at: new Date(), touch_claimed_at: null });
    });
    // A leg of the schedule's touch at `stepIndex`, quoting `invoiceIds` (the reservation snapshot): delivered by
    // default; `outcome: {}` is a reservation with no outcome stamped (unconfirmed), `{ send_failed: true }` a
    // confirmed non-send.
    async function delivered(schedule, stepIndex, invoiceIds, { channel = 'sms', outcome = { delivered: true } } = {}) {
      const key = eventKey(schedule, Schedule.STEPS[stepIndex].id);
      await app('collections_contact_ledger').insert({
        customer_id: schedule.customer_id, channel, purpose: 'late_payment', source: SOURCE,
        invoice_ids: JSON.stringify(invoiceIds), idempotency_key: reminderReservationKey(schedule.customer_id, key, channel),
        metadata: JSON.stringify({ notificationEventKey: key, ...outcome, selectedChannels: ['email', 'sms'] }),
      });
    }

    test('TOLD at a mid step (one leg delivered, one retrying): the members it named land AFTER it; a member it did not name lands on it', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 40, step: 3, due: false });
      const b = await member(c, { sentDaysAgo: 20, step: 1, due: false });
      const unnamed = await member(c, { sentDaysAgo: 15, step: 0, due: false }); // e.g. microdeposit-pending, left out of the touch
      const schedule = await openSchedule(c, { step_index: 3, last_touch_at: new Date() }); // d30, TOLD: still at the step
      await delivered(schedule, 3, [a.invoiceId, b.invoiceId]);
      const out = await Schedule.release(schedule, 'released_gate_off', new Date());
      expect(out.closed).toBe(true);
      expect(await seqRow(a.seq.id)).toMatchObject({ status: 'active', step_index: 4 });
      expect(await seqRow(b.seq.id)).toMatchObject({ status: 'active', step_index: 4 }); // never Day 30 again
      expect(await seqRow(unnamed.seq.id)).toMatchObject({ status: 'active', step_index: 3 }); // it never got Day 30
      // a touch of ANOTHER step (or another episode) is not this step's evidence
      const c2 = await customer();
      const y = await member(c2, { sentDaysAgo: 20, step: 1, due: false });
      await member(c2, { sentDaysAgo: 15, step: 0, due: false });
      const s2 = await openSchedule(c2, { step_index: 3 });
      await delivered(s2, 2, [y.invoiceId]);
      await Schedule.release(s2, 'released_gate_off', new Date());
      expect((await seqRow(y.seq.id)).step_index).toBe(3);
    });

    test('a delivered FINAL notice completes the members it named (cadence-exhausted), never sends them a second final', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 95, step: 5, due: false });
      const b = await member(c, { sentDaysAgo: 70, step: 4, due: false });
      const unnamed = await member(c, { sentDaysAgo: 50, step: 3, due: false });
      const schedule = await openSchedule(c, { step_index: 5, last_touch_at: new Date() });
      await delivered(schedule, 5, [a.invoiceId, b.invoiceId]);
      const out = await Schedule.release(schedule, 'released_gate_off', new Date());
      expect(out.closed).toBe(true);
      for (const m of [a, b]) expect(await seqRow(m.seq.id)).toMatchObject({ status: 'completed', step_index: 6, next_touch_at: null });
      // the invoice the notice did not name still gets its own final
      expect(await seqRow(unnamed.seq.id)).toMatchObject({ status: 'active', step_index: 5 });
      expect(mockNotify).not.toHaveBeenCalled();
      // and the Day 60/90 revival leaves the completed members alone
      await Followups._test.reviveLegacyFinishedSequences();
      for (const m of [a, b]) expect(await seqRow(m.seq.id)).toMatchObject({ status: 'completed' });
    });

    test('a delivered final whose named invoices cannot be read: members paused for a person (never completed, never sent again)', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 92, step: 5, due: false });
      const b = await member(c, { sentDaysAgo: 70, step: 4, due: false });
      const schedule = await openSchedule(c, { step_index: 5 });
      await delivered(schedule, 5, []); // a delivered leg with no snapshot
      await Schedule.release(schedule, 'released_admin', new Date());
      for (const m of [a, b]) expect(await seqRow(m.seq.id)).toMatchObject({ status: 'paused', paused_reason: 'released_final_notice_unreadable' });
      expect(mockNotify).toHaveBeenCalledTimes(2);
      expect(mockNotify.mock.calls[0][2]).toMatch(/after its final notice/);
    });

    test('a ledger that cannot be read releases nothing (evidence_unreadable); the kill switch counts it failed and alerts', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 40, step: 3, due: false });
      await member(c, { sentDaysAgo: 20, step: 1, due: false });
      const schedule = await openSchedule(c, { step_index: 3 });
      await app.raw('ALTER TABLE collections_contact_ledger RENAME TO collections_contact_ledger_off');
      let tally;
      try {
        expect(await Schedule.release(schedule, 'released_admin', new Date())).toMatchObject({ closed: false, reason: 'evidence_unreadable' });
        delete process.env.GATE_DUNNING_CUSTOMER_SCHEDULE;
        tally = await Wiring.releaseIfDark(new Date());
      } finally {
        await app.raw('ALTER TABLE collections_contact_ledger_off RENAME TO collections_contact_ledger');
      }
      expect(tally).toMatchObject({ released: 0, failed: 1 });
      expect(await app('customer_dunning_schedules').where({ id: schedule.id }).first()).toMatchObject({ status: 'active' });
      expect(await seqRow(a.seq.id)).toMatchObject({ status: 'active', step_index: 3 });
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    test('a current-step leg whose outcome is UNCONFIRMED releases nothing (it may have gone out); a confirmed non-send does not block', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 40, step: 3, due: false });
      const b = await member(c, { sentDaysAgo: 20, step: 1, due: false });
      const schedule = await openSchedule(c, { step_index: 3 });
      await delivered(schedule, 3, [a.invoiceId, b.invoiceId], { outcome: {} }); // reserved, never stamped
      expect(await Schedule.release(schedule, 'released_admin', new Date())).toMatchObject({ closed: false, reason: 'outcome_unconfirmed' });
      delete process.env.GATE_DUNNING_CUSTOMER_SCHEDULE;
      const tally = await Wiring.releaseIfDark(new Date());
      expect(tally).toMatchObject({ released: 0, failed: 1 });
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify.mock.calls[0][3]).toMatchObject({ dedupeKey: `customer-dunning-release-failed:${schedule.id}` });
      expect(await app('customer_dunning_schedules').where({ id: schedule.id }).first()).toMatchObject({ status: 'active' });
      expect(await seqRow(b.seq.id)).toMatchObject({ status: 'active', step_index: 1 }); // untouched: still owned
      // admin release says so
      expect(await require('../services/customer-dunning/admin').release(schedule.id, { now: new Date() }))
        .toMatchObject({ ok: false, reason: 'outcome_unconfirmed' });
      // the same leg confirmed NOT sent: nothing went out, so the members are handed back on the step
      await app('collections_contact_ledger').where({ customer_id: c }).update({ metadata: app.raw('metadata || ?::jsonb', [JSON.stringify({ send_failed: true })]) });
      expect((await Schedule.release(schedule, 'released_admin', new Date())).closed).toBe(true);
      expect(await seqRow(b.seq.id)).toMatchObject({ status: 'active', step_index: 3 });
    });

    test('a same-step TOLD delivery that commits between the evidence read and the release lock is seen: members land AFTER it, never on it', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 40, step: 3, due: false });
      const b = await member(c, { sentDaysAgo: 20, step: 1, due: false });
      const schedule = await openSchedule(c, { step_index: 3 });
      // the release reads its snapshot + evidence (nothing delivered yet), then waits at its advisory lock
      const gate = pauseAt(/pg_advisory_xact_lock\(/);
      const releasing = Schedule.release(schedule, 'released_admin', new Date());
      await gate.reached;
      // a sender (holding the customer's key, which the release has not taken yet) delivers one leg of the
      // SAME step, marks it TOLD (no advance) and clears its claim, all committed before the release resumes
      const stamp = new Date();
      await app('customer_dunning_schedules').where({ id: schedule.id }).update({ touch_claimed_at: stamp });
      await delivered(schedule, 3, [a.invoiceId, b.invoiceId]);
      expect(await Schedule.markTold(schedule, { claimStamp: stamp, deliveredAt: new Date(), database: app })).toBe(true);
      await Schedule.releaseClaim({ schedule, claimStamp: stamp, memberSeqIds: [] }, { database: app });
      expect(await app('customer_dunning_schedules').where({ id: schedule.id }).first()).toMatchObject({ step_index: 3, touch_claimed_at: null });
      gate.release();
      const out = await releasing;
      expect(deadlocks()).toEqual([]);
      expect(out.closed).toBe(true);
      // Day 30 reached both: B (whose own Day 30 is still ahead) never gets it again
      expect(await seqRow(a.seq.id)).toMatchObject({ status: 'active', step_index: 4 });
      expect(await seqRow(b.seq.id)).toMatchObject({ status: 'active', step_index: 4 });
    });

    test('a PAUSED schedule\'s members stay paused on their own ladder, carrying the office\'s reason and admin', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 40, step: 3, due: false });
      const b = await member(c, { sentDaysAgo: 20, step: 1, due: false });
      const adminId = randomUUID();
      const schedule = await openSchedule(c, {
        step_index: 3, status: 'paused', paused_reason: 'customer will pay Friday', paused_by_admin_id: adminId, next_touch_at: null,
      });
      delete process.env.GATE_DUNNING_CUSTOMER_SCHEDULE;
      const tally = await Wiring.releaseIfDark(new Date());
      expect(tally.failed).toBe(0);
      expect(await app('customer_dunning_schedules').where({ id: schedule.id }).first()).toMatchObject({ status: 'released' });
      // each at its own landing step (A's Day 30 is past: Day 60; B's Day 30 is still ahead), paused as the office left it
      for (const [m, step] of [[a, 4], [b, 3]]) {
        expect(await seqRow(m.seq.id)).toMatchObject({
          status: 'paused', step_index: step, paused_reason: 'customer will pay Friday', paused_by_admin_id: adminId, next_touch_at: null,
        });
      }
      // a paused per-invoice row still holds its invoice from the legacy checker (the office resumes it)
      expect(await Followups.hasActiveSequence(a.invoiceId)).toBe(true);
    });

    test('GATE_DUNNING_LADDER_90 off: a member of a schedule past Day 30 keeps that step (handed to the legacy checker), never re-sent Day 30', async () => {
      const c = await customer();
      await member(c, { sentDaysAgo: 65, step: 4, due: false });
      const young = await member(c, { sentDaysAgo: 25, step: 1, due: false }); // its Day 30 is 5 days out
      const schedule = await openSchedule(c, { step_index: 4 }); // the combined Day 60 named both
      delete process.env.GATE_DUNNING_LADDER_90;
      try {
        expect((await Schedule.release(schedule, 'released_prereq_off', new Date())).closed).toBe(true);
        const row = await seqRow(young.seq.id);
        expect(row).toMatchObject({ status: 'active', step_index: 4 }); // not clamped to the legacy Day 30 (index 3)
        expect(new Date(row.next_touch_at).getTime()).toBeGreaterThan(Date.now());
        // main's ladder-off rule: an active row past the legacy steps no longer holds the invoice
        expect(await Followups.hasActiveSequence(young.invoiceId)).toBe(false);
      } finally {
        process.env.GATE_DUNNING_LADDER_90 = 'true';
      }
    });
  });

  // ── the pre-visit balance note counts only a SCHEDULE touch (C2) ────────
  describe('pre-visit suppression after promotion', () => {
    test('a touch seeded from the members at promotion does not suppress; a real combined touch does', async () => {
      const c = await customer();
      const now = new Date();
      const cutoff = new Date(now.getTime() - 72 * 3600 * 1000);
      const touched = Previsit._test.customerScheduleTouchedSince;
      // promoted yesterday; last_touch_at = the newest member touch, two days ago (inside the 72h window)
      const schedule = await openSchedule(c, {
        status: 'released', closed_reason: 'released_admin', closed_at: now,
        created_at: new Date(now.getTime() - 1 * DAY), last_touch_at: new Date(now.getTime() - 2 * DAY),
      });
      expect(await touched(c, cutoff, app)).toBe(false);
      // the schedule's own combined touch, after it was created
      await app('customer_dunning_schedules').where({ id: schedule.id }).update({ last_touch_at: new Date(now.getTime() - 3600 * 1000) });
      expect(await touched(c, cutoff, app)).toBe(true);
      // ...and older than the window it no longer counts
      expect(await touched(c, new Date(now.getTime() - 60 * 1000), app)).toBe(false);
    });
  });
});
