// Customer-level overdue reminders (dunning consolidation PR 2): the schedule
// state machine against a real PostgreSQL in a disposable schema (skipped
// without APP_TEST_DATABASE_URL, run for real in CI). The set authority
// (balance-set) is stubbed — it has its own suite — so what is proven here is
// the SQL: promotion under the advisory lock (seed rules, never sends, quiet
// members, fresh claim, concurrent workers, unique-violation), the claim and
// OUR-stamp-only release, the guarded advance / final completion, close and
// release of surviving members, the disposition writers, the boundary read on
// a handed transaction under DB_POOL_MAX=2 (A-17), and that the shadow run
// changes no row anywhere.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

// The engine runs on the db module; here it IS the disposable test schema (set in beforeAll).
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
const mockResolve = jest.fn();
jest.mock('../services/customer-dunning/balance-set', () => ({
  resolveDunnableSet: (...a) => mockResolve(...a),
}));
// The shadow run now runs the live pre-send guards. Their reads that go through the
// process-wide pool (delivery progress, autopay eligibility, the email template
// library) are stubbed here; the customer, preference and schedule reads run on `app`.
jest.mock('../services/billing-reminder-delivery', () => ({
  ...jest.requireActual('../services/billing-reminder-delivery'),
  reminderProgress: jest.fn(async () => []),
}));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn(async () => false) }));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  loadTemplateByKey: jest.fn(async () => ({ template: { status: 'active' }, activeVersion: { id: 'v1' } })),
}));
const mockNotify = jest.fn(async () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));

const migration = require('../models/migrations/20260930010000_customer_dunning_schedules');
const Followups = require('../services/invoice-followups');
const Schedule = require('../services/customer-dunning/schedule');
const Boundary = require('../services/customer-dunning/boundary');
const Runner = require('../services/customer-dunning/runner');
const Send = require('../services/customer-dunning/send');
const Admin = require('../services/customer-dunning/admin');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const schema = `customer_dunning_engine_${randomUUID().replaceAll('-', '')}`;
jest.setTimeout(60000);

// Tuesday 2026-10-06 10:16 ET.
const NOW = new Date('2026-10-06T14:16:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(NOW.getTime() - days * DAY);

postgres('customer_dunning_schedules engine (PostgreSQL)', () => {
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
    app = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 6 } });
    mockDatabase = app;
    await app.schema.createTable('customers', (t) => { t.uuid('id').primary(); });
    await app.schema.createTable('notification_prefs', (t) => { t.uuid('customer_id'); });
    await app.schema.createTable('invoices', (t) => {
      t.uuid('id').primary();
      t.uuid('customer_id');
      t.string('status');
      t.timestamp('created_at');
      t.timestamp('sent_at');
      t.timestamp('sms_sent_at');
      t.uuid('payer_id');
      t.string('scheduled_send_error');
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
      t.timestamp('created_at').defaultTo(app.fn.now());
      t.timestamp('updated_at').defaultTo(app.fn.now());
    });
    await app.schema.createTable('collections_contact_ledger', (t) => {
      t.uuid('id').primary().defaultTo(app.raw('gen_random_uuid()'));
      t.jsonb('metadata');
    });
    await migration.up(app);
  });

  afterAll(async () => {
    delete process.env.GATE_DUNNING_LADDER_90;
    if (admin) await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (app) await app.destroy();
    if (admin) await admin.destroy();
  });

  beforeEach(() => { mockResolve.mockReset(); mockNotify.mockClear(); });

  // ── fixtures ───────────────────────────────────────────────────────────
  async function customer() {
    const id = randomUUID();
    await app('customers').insert({ id });
    return id;
  }
  // sentDaysAgo anchors the cadence (sequenceAnchor = invoice sent_at).
  async function member(customerId, { sentDaysAgo, sentOn = null, step = 0, status = 'active', next = null, last = null, touches = 0, claimedAt = null, invoiceStatus = 'overdue' }) {
    const invoiceId = randomUUID();
    const sentAt = sentOn || ago(sentDaysAgo);
    await app('invoices').insert({ id: invoiceId, customer_id: customerId, status: invoiceStatus, created_at: sentAt, sent_at: sentAt });
    const [seq] = await app('invoice_followup_sequences').insert({
      invoice_id: invoiceId, customer_id: customerId, status, step_index: step,
      next_touch_at: next, last_touch_at: last, touches_sent: touches, touch_claimed_at: claimedAt,
    }).returning('*');
    return { invoiceId, seq, sentAt };
  }
  const setFor = (members, over = {}) => ({
    kind: 'multi', reason: null, anchor: { id: members[0].invoiceId },
    members: members.map((m) => ({ invoice_id: m.invoiceId, cents: 10000, seqStatus: m.seqStatus || 'active', quiet: false })),
    totalCents: 10000 * members.length, digest: 'd', activeCount: members.filter((m) => (m.seqStatus || 'active') === 'active').length,
    excluded: { stopped: [], md: [] }, ...over,
  });
  const schedules = (customerId) => app('customer_dunning_schedules').where({ customer_id: customerId }).orderBy('episode');
  const seqRow = (id) => app('invoice_followup_sequences').where({ id }).first();

  async function openSchedule(customerId, over = {}) {
    const [row] = await app('customer_dunning_schedules').insert({
      customer_id: customerId, episode: over.episode || 1, status: 'active', step_index: 4,
      next_touch_at: ago(0.05), touches_sent: 4, ...over,
    }).returning('*');
    return row;
  }

  // ── promotion ──────────────────────────────────────────────────────────
  describe('promotion', () => {
    test('seeds from the OLDEST active member at its first non-stale step, never sends in its own run', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 45, step: 3, touches: 3, last: ago(20) }); // d30 (15d ago) is stale -> d60 = sent+60 = 15 days ahead
      const b = await member(c, { sentDaysAgo: 20, step: 1, touches: 1, last: ago(5) });
      mockResolve.mockResolvedValue(setFor([a, b]));
      const out = await Schedule.promoteCustomer(c, NOW, { database: app });
      expect(out.promoted).toBe(true);
      const [row] = await schedules(c);
      expect(row).toMatchObject({ episode: 1, status: 'active', step_index: 4, touches_sent: 3 });
      expect(new Date(row.next_touch_at).getTime()).toBe(Followups.computeNextTouchAt(a.sentAt, 4).getTime());
      expect(new Date(row.next_touch_at).getTime()).toBeGreaterThan(NOW.getTime());
      expect(new Date(row.last_touch_at).getTime()).toBe(ago(5).getTime());
      expect(row.seeded_from.map((s) => s.invoice_id).sort()).toEqual([a.invoiceId, b.invoiceId].sort());
    });

    test('a seed already due lands on the NEXT run, not now (promotion never sends)', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 60, step: 4 }); // d60 due exactly today at 10:00 ET, within grace
      const b = await member(c, { sentDaysAgo: 30, step: 3 });
      mockResolve.mockResolvedValue(setFor([a, b]));
      await Schedule.promoteCustomer(c, NOW, { database: app });
      const [row] = await schedules(c);
      expect(new Date(row.next_touch_at).getTime()).toBeGreaterThan(NOW.getTime());
    });

    test('quiet members are named but never count toward promotion (needs two ACTIVE)', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 30, step: 3 });
      const done = await member(c, { sentDaysAgo: 100, step: 5, status: 'completed' });
      mockResolve.mockResolvedValue(setFor([a, { ...done, seqStatus: 'completed' }]));
      const out = await Schedule.promoteCustomer(c, NOW, { database: app });
      expect(out).toMatchObject({ promoted: false, reason: 'fewer_than_two_active_members' });
      expect(await schedules(c)).toHaveLength(0);
    });

    test('a member with a FRESH claim skips the promotion; a stale claim does not', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 30, step: 3 });
      const b = await member(c, { sentDaysAgo: 30, step: 3, claimedAt: new Date(NOW.getTime() - 60 * 1000) });
      mockResolve.mockResolvedValue(setFor([a, b]));
      expect(await Schedule.promoteCustomer(c, NOW, { database: app })).toMatchObject({ promoted: false, reason: 'member_claim_fresh' });
      await app('invoice_followup_sequences').where({ id: b.seq.id }).update({ touch_claimed_at: new Date(NOW.getTime() - 20 * 60 * 1000) });
      expect((await Schedule.promoteCustomer(c, NOW, { database: app })).promoted).toBe(true);
    });

    test('a hold or a non-multi set is not promoted', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 30, step: 3 });
      const b = await member(c, { sentDaysAgo: 30, step: 3 });
      mockResolve.mockResolvedValue(setFor([a, b], { kind: 'hold', reason: 'member_paused' }));
      expect(await Schedule.promoteCustomer(c, NOW, { database: app })).toMatchObject({ promoted: false, reason: 'member_paused' });
      mockResolve.mockResolvedValue(setFor([a], { kind: 'single' }));
      expect(await Schedule.promoteCustomer(c, NOW, { database: app })).toMatchObject({ promoted: false, reason: 'set_single' });
    });

    test('a set already past the final step is refused (no final notice nobody else would send)', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 200, step: 5 });
      const b = await member(c, { sentDaysAgo: 200, step: 5 });
      mockResolve.mockResolvedValue(setFor([a, b]));
      expect(await Schedule.promoteCustomer(c, NOW, { database: app })).toMatchObject({ promoted: false, reason: 'past_final_step' });
    });

    test('two workers promoting the same customer: exactly one wins (advisory lock), the other sees it open', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 30, step: 3 });
      const b = await member(c, { sentDaysAgo: 20, step: 2 });
      mockResolve.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 150)); return setFor([a, b]); });
      const [x, y] = await Promise.all([
        Schedule.promoteCustomer(c, NOW, { database: app }),
        Schedule.promoteCustomer(c, NOW, { database: app }),
      ]);
      expect([x.promoted, y.promoted].sort()).toEqual([false, true]);
      expect([x, y].find((o) => !o.promoted).reason).toBe('already_open');
      expect(await schedules(c)).toHaveLength(1);
    });

    test('a unique-violation on the open index (a promotion that slipped past the lock) is tolerated', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 30, step: 3 });
      const b = await member(c, { sentDaysAgo: 20, step: 2 });
      mockResolve.mockResolvedValue(setFor([a, b]));
      const rival = { transaction: async () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); } };
      expect(await Schedule.promoteCustomer(c, NOW, { database: rival })).toMatchObject({ promoted: false, reason: 'concurrent_promotion' });
      // and the real index does refuse a second open episode
      await app('customer_dunning_schedules').insert({ customer_id: c, episode: 1, status: 'active', step_index: 2 });
      await expect(app('customer_dunning_schedules').insert({ customer_id: c, episode: 2, status: 'held', step_index: 2 })).rejects.toMatchObject({ code: '23505' });
      expect((await seqRow(a.seq.id)).status).toBe('active'); // per-invoice rows untouched
    });

    test('the set resolve runs OUTSIDE the promotion transaction (no Stripe I/O under the advisory lock)', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 30, step: 3 });
      const b = await member(c, { sentDaysAgo: 20, step: 2 });
      let lockedDuringResolve = null;
      mockResolve.mockImplementation(async () => {
        const [{ n }] = (await app.raw("select count(*)::int as n from pg_locks where locktype = 'advisory' and granted")).rows;
        lockedDuringResolve = n;
        return setFor([a, b]);
      });
      const before = (await app.raw("select count(*)::int as n from pg_locks where locktype = 'advisory' and granted")).rows[0].n;
      expect((await Schedule.promoteCustomer(c, NOW, { database: app })).promoted).toBe(true);
      expect(lockedDuringResolve).toBe(before);
    });

    test('a member that stopped being active between the resolve and the lock is not promoted over', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 30, step: 3 });
      const b = await member(c, { sentDaysAgo: 20, step: 2 });
      mockResolve.mockImplementation(async () => {
        const set = setFor([a, b]);
        await app('invoice_followup_sequences').where({ id: b.seq.id }).update({ status: 'stopped' }); // stopped after the set was read
        return set;
      });
      expect(await Schedule.promoteCustomer(c, NOW, { database: app })).toMatchObject({ promoted: false, reason: 'fewer_than_two_active_members' });
    });

    test('a closed episode frees the customer: the next promotion is episode 2', async () => {
      const c = await customer();
      await app('customer_dunning_schedules').insert({ customer_id: c, episode: 1, status: 'completed', closed_reason: 'balance_cleared' });
      const a = await member(c, { sentDaysAgo: 30, step: 3 });
      const b = await member(c, { sentDaysAgo: 20, step: 2 });
      mockResolve.mockResolvedValue(setFor([a, b]));
      await Schedule.promoteCustomer(c, NOW, { database: app });
      expect((await schedules(c)).map((r) => r.episode)).toEqual([1, 2]);
    });

    test('candidates: 2+ active sequences, no open schedule; a single-invoice customer is never a candidate', async () => {
      const two = await customer();
      await member(two, { sentDaysAgo: 30, step: 3 }); await member(two, { sentDaysAgo: 20, step: 2 });
      const one = await customer();
      await member(one, { sentDaysAgo: 30, step: 3 });
      const owned = await customer();
      await member(owned, { sentDaysAgo: 30, step: 3 }); await member(owned, { sentDaysAgo: 20, step: 2 });
      await openSchedule(owned);
      const ids = await Schedule.promotionCandidates({ database: app });
      expect(ids).toContain(two);
      expect(ids).not.toContain(one);
      expect(ids).not.toContain(owned);
    });
  });

  // ── the customer 8c5c90c6 worked example (plan §10), synthetic ids ────────
  describe('the worked example: A and B at Day 90 due Tue Oct 20, C at Day 60 due Tue Oct 13', () => {
    const OCT20 = new Date('2026-10-20T14:16:00Z');
    async function fixture() {
      const c = await customer();
      const a = await member(c, { sentOn: new Date('2026-07-22T15:00:00Z'), step: 5, touches: 5 }); // d90 = Oct 20
      const b = await member(c, { sentOn: new Date('2026-07-22T15:30:00Z'), step: 5, touches: 5 });
      const cc = await member(c, { sentOn: new Date('2026-08-14T15:00:00Z'), step: 4, touches: 4 }); // d60 = Oct 13
      return { c, a, b, cc };
    }

    test('promoted any tick before Oct 13: seeds d90 dated Oct 20; the younger invoice\'s Day 60 is absorbed; ONE final completes all three', async () => {
      const { c, a, b, cc } = await fixture();
      mockResolve.mockResolvedValue(setFor([a, b, cc]));
      const before = new Date('2026-10-06T14:16:00Z');
      expect((await Schedule.promoteCustomer(c, before, { database: app })).promoted).toBe(true);
      const [row] = await schedules(c);
      expect(row.step_index).toBe(5);
      expect(new Date(row.next_touch_at).getTime()).toBe(Followups.computeNextTouchAt(a.sentAt, 5).getTime());
      expect(new Date(row.next_touch_at).toISOString()).toBe('2026-10-20T14:00:00.000Z');
      // Oct 13: nothing fires for C — its per-invoice row is frozen (the schedule owns it); the schedule is not due
      expect(await Schedule.claim(row.id, new Date('2026-10-13T14:16:00Z'), { database: app })).toBeNull();
      // Oct 20: the one final notice
      const claimed = await Schedule.claim(row.id, OCT20, { database: app });
      expect(claimed).not.toBeNull();
      const out = await Schedule.completeFinal(claimed.schedule, {
        claimStamp: claimed.claimStamp, deliveredAt: OCT20, namedInvoiceIds: [a.invoiceId, b.invoiceId, cc.invoiceId], now: OCT20, database: app,
      });
      expect(out.completed).toBe(true);
      for (const m of [a, b, cc]) expect((await seqRow(m.seq.id)).status).toBe('completed');
    });

    test('C paid first (its sequence stopped): the final names two and completes exactly those', async () => {
      const { c, a, b, cc } = await fixture();
      mockResolve.mockResolvedValue(setFor([a, b, cc]));
      await Schedule.promoteCustomer(c, new Date('2026-10-06T14:16:00Z'), { database: app });
      await app('invoice_followup_sequences').where({ id: cc.seq.id }).update({ status: 'stopped' });
      const [row] = await schedules(c);
      const claimed = await Schedule.claim(row.id, OCT20, { database: app });
      await Schedule.completeFinal(claimed.schedule, {
        claimStamp: claimed.claimStamp, deliveredAt: OCT20, namedInvoiceIds: [a.invoiceId, b.invoiceId], now: OCT20, database: app,
      });
      expect((await seqRow(a.seq.id)).status).toBe('completed');
      expect((await seqRow(b.seq.id)).status).toBe('completed');
      expect((await seqRow(cc.seq.id)).status).toBe('stopped');
    });

    test('promoted Oct 14-19 (C\'s Day 60 already went out per-invoice): the same single final on Oct 20', async () => {
      const { c, a, b, cc } = await fixture();
      await app('invoice_followup_sequences').where({ id: cc.seq.id }).update({ step_index: 5, touches_sent: 5, last_touch_at: new Date('2026-10-13T14:20:00Z') });
      mockResolve.mockResolvedValue(setFor([a, b, cc]));
      await Schedule.promoteCustomer(c, new Date('2026-10-15T14:16:00Z'), { database: app });
      const [row] = await schedules(c);
      expect(row.step_index).toBe(5);
      expect(new Date(row.next_touch_at).toISOString()).toBe('2026-10-20T14:00:00.000Z');
      expect(new Date(row.last_touch_at).toISOString()).toBe('2026-10-13T14:20:00.000Z');
    });

    test('promoted after Oct 20 (A and B already finished separately): C alone is active — never promoted, today\'s behaviour', async () => {
      const { c, a, b, cc } = await fixture();
      await app('invoice_followup_sequences').whereIn('id', [a.seq.id, b.seq.id]).update({ status: 'completed' });
      expect(await Schedule.promotionCandidates({ database: app })).not.toContain(c);
      mockResolve.mockResolvedValue(setFor([a, b, cc]));
      const out = await Schedule.promoteCustomer(c, new Date('2026-10-22T14:16:00Z'), { database: app });
      expect(out.promoted).toBe(false);
    });
  });

  // ── claim ──────────────────────────────────────────────────────────────
  describe('claim / releaseClaim', () => {
    test('stamps the schedule AND the free active member rows; a second claim is refused while fresh', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 60, step: 4 });
      const b = await member(c, { sentDaysAgo: 30, step: 3 });
      const s = await openSchedule(c);
      const claimed = await Schedule.claim(s.id, NOW, { database: app });
      expect(claimed.memberSeqIds.sort()).toEqual([a.seq.id, b.seq.id].sort());
      expect((await seqRow(a.seq.id)).touch_claimed_at).not.toBeNull();
      expect(await Schedule.claim(s.id, NOW, { database: app })).toBeNull();
    });

    test('not due, wrong status, wrong step: refused; force (operator) skips only the due test', async () => {
      const c = await customer();
      await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c, { next_touch_at: new Date(NOW.getTime() + DAY) });
      expect(await Schedule.claim(s.id, NOW, { database: app })).toBeNull();
      expect(await Schedule.claim(s.id, NOW, { database: app, expectedStepIndex: 2, force: true })).toBeNull();
      const forced = await Schedule.claim(s.id, NOW, { database: app, force: true });
      expect(forced).not.toBeNull();
      await Schedule.releaseClaim(forced, { database: app });
      await app('customer_dunning_schedules').where({ id: s.id }).update({ status: 'paused' });
      expect(await Schedule.claim(s.id, NOW, { database: app, force: true })).toBeNull();
    });

    test('a stale claim (crashed sender) is replaced, stale member stamps included', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 60, step: 4 });
      const old = await member(c, { sentDaysAgo: 30, step: 3, claimedAt: new Date(NOW.getTime() - 30 * 60 * 1000) });
      const s = await openSchedule(c, { touch_claimed_at: new Date(NOW.getTime() - 30 * 60 * 1000) });
      const claimed = await Schedule.claim(s.id, NOW, { database: app });
      expect(claimed).not.toBeNull();
      expect(claimed.memberSeqIds.sort()).toEqual([a.seq.id, old.seq.id].sort());
    });

    test('F4: a member row another worker holds a FRESH claim on refuses the claim outright (nothing is stamped)', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 60, step: 4 });
      const busy = await member(c, { sentDaysAgo: 30, step: 3, claimedAt: new Date(NOW.getTime() - 60 * 1000) });
      const s = await openSchedule(c);
      expect(await Schedule.claim(s.id, NOW, { database: app })).toBeNull();
      expect((await app('customer_dunning_schedules').where({ id: s.id }).first()).touch_claimed_at).toBeNull();
      expect((await seqRow(a.seq.id)).touch_claimed_at).toBeNull();
      // the busy worker settles; the next run claims
      await app('invoice_followup_sequences').where({ id: busy.seq.id }).update({ touch_claimed_at: null });
      expect(await Schedule.claim(s.id, NOW, { database: app })).not.toBeNull();
    });

    test('release clears OUR stamps only: a successor that replaced the claim keeps its own', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c);
      const claimed = await Schedule.claim(s.id, NOW, { database: app });
      const successor = new Date(NOW.getTime() + 15 * 60 * 1000);
      await app('customer_dunning_schedules').where({ id: s.id }).update({ touch_claimed_at: successor });
      await app('invoice_followup_sequences').where({ id: a.seq.id }).update({ touch_claimed_at: successor });
      await Schedule.releaseClaim(claimed, { database: app });
      expect(new Date((await app('customer_dunning_schedules').where({ id: s.id }).first()).touch_claimed_at).getTime()).toBe(successor.getTime());
      expect(new Date((await seqRow(a.seq.id)).touch_claimed_at).getTime()).toBe(successor.getTime());
    });

    test('release of an untouched claim clears both', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c);
      await Schedule.releaseClaim(await Schedule.claim(s.id, NOW, { database: app }), { database: app });
      expect((await app('customer_dunning_schedules').where({ id: s.id }).first()).touch_claimed_at).toBeNull();
      expect((await seqRow(a.seq.id)).touch_claimed_at).toBeNull();
    });
  });

  // ── advance / final ────────────────────────────────────────────────────
  describe('advance and the final notice', () => {
    test('advance: one guarded UPDATE, deliveredAt kept, next date from the CURRENT oldest active member, never before the floor', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c, { held_reason: 'x', held_since: ago(3), link_digest: 'd'.repeat(64), link_url: 'https://short/x' });
      const claimed = await Schedule.claim(s.id, NOW, { database: app });
      const rows = await Schedule.activeMemberRows(c, { database: app });
      const deliveredAt = new Date(NOW.getTime() - 5000);
      expect(await Schedule.advance(claimed.schedule, { claimStamp: claimed.claimStamp, deliveredAt, activeRows: rows, now: NOW, database: app })).toBe(true);
      const row = await app('customer_dunning_schedules').where({ id: s.id }).first();
      expect(row).toMatchObject({ step_index: 5, touches_sent: 5, status: 'active', held_reason: null, held_since: null, link_digest: null, link_url: null });
      expect(new Date(row.last_touch_at).getTime()).toBe(deliveredAt.getTime());
      expect(new Date(row.next_touch_at).getTime()).toBe(Followups.computeNextTouchAt(a.sentAt, 5).getTime());
    });

    test('advance is a no-op when the step moved or the claim is not ours (an admin edit / successor race)', async () => {
      const c = await customer();
      await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c);
      const claimed = await Schedule.claim(s.id, NOW, { database: app });
      await app('customer_dunning_schedules').where({ id: s.id }).update({ step_index: 3 });
      expect(await Schedule.advance(claimed.schedule, { claimStamp: claimed.claimStamp, now: NOW, database: app })).toBe(false);
      await app('customer_dunning_schedules').where({ id: s.id }).update({ step_index: 4, touch_claimed_at: new Date(NOW.getTime() + 1000) });
      expect(await Schedule.advance(claimed.schedule, { claimStamp: claimed.claimStamp, now: NOW, database: app })).toBe(false);
    });

    test('final notice completes EXACTLY the invoices it named; a survivor is re-landed on its own ladder without repeating a step', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 90, step: 5 });
      const b = await member(c, { sentDaysAgo: 40, step: 3 });
      const survivor = await member(c, { sentDaysAgo: 20, step: 2 }); // e.g. microdeposit-pending: not named
      const s = await openSchedule(c, { step_index: 5 });
      const claimed = await Schedule.claim(s.id, NOW, { database: app });
      const out = await Schedule.completeFinal(claimed.schedule, {
        claimStamp: claimed.claimStamp, deliveredAt: NOW, namedInvoiceIds: [a.invoiceId, b.invoiceId], now: NOW, database: app,
      });
      expect(out.completed).toBe(true);
      const row = await app('customer_dunning_schedules').where({ id: s.id }).first();
      expect(row).toMatchObject({ status: 'completed', closed_reason: 'final_notice_delivered', touches_sent: 5 });
      expect(row.final_notice_at).not.toBeNull();
      expect((await seqRow(a.seq.id)).status).toBe('completed');
      expect((await seqRow(b.seq.id)).status).toBe('completed');
      const kept = await seqRow(survivor.seq.id);
      expect(kept.status).toBe('active');
      expect(kept.step_index).toBeGreaterThanOrEqual(5); // max(row step, schedule step) — never repeats a stage
    });

    test('a survivor already past its own final step is PAUSED for a person (never stale-completed), with an alert', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 90, step: 5 });
      const stale = await member(c, { sentDaysAgo: 400, step: 5 });
      const s = await openSchedule(c, { step_index: 5 });
      const claimed = await Schedule.claim(s.id, NOW, { database: app });
      await Schedule.completeFinal(claimed.schedule, {
        claimStamp: claimed.claimStamp, deliveredAt: NOW, namedInvoiceIds: [a.invoiceId], now: NOW, database: app,
      });
      const row = await seqRow(stale.seq.id);
      expect(row).toMatchObject({ status: 'paused', paused_reason: 'released_past_final_step' });
      expect(mockNotify).toHaveBeenCalledWith('alert', expect.any(String), expect.stringContaining(stale.invoiceId), expect.objectContaining({ dedupeKey: expect.stringContaining('past-final') }));
    });

    test('completeFinal is guarded on our claim (a lost race completes nothing)', async () => {
      const c = await customer();
      const a = await member(c, { sentDaysAgo: 90, step: 5 });
      const s = await openSchedule(c, { step_index: 5 });
      const claimed = await Schedule.claim(s.id, NOW, { database: app });
      await app('customer_dunning_schedules').where({ id: s.id }).update({ touch_claimed_at: new Date(NOW.getTime() + 1000) });
      const out = await Schedule.completeFinal(claimed.schedule, {
        claimStamp: claimed.claimStamp, deliveredAt: NOW, namedInvoiceIds: [a.invoiceId], now: NOW, database: app,
      });
      expect(out.completed).toBe(false);
      expect((await seqRow(a.seq.id)).status).toBe('active');
    });
  });

  // ── close / release ────────────────────────────────────────────────────
  describe('close and release', () => {
    test('balance_cleared: survivors re-landed at max(row step, schedule step), no step repeated; the customer is freed', async () => {
      const c = await customer();
      const md = await member(c, { sentDaysAgo: 50, step: 2 });
      const s = await openSchedule(c, { step_index: 4 });
      const out = await Schedule.close(s, 'balance_cleared', NOW, { database: app });
      expect(out.closed).toBe(true);
      const row = await app('customer_dunning_schedules').where({ id: s.id }).first();
      expect(row).toMatchObject({ status: 'completed', closed_reason: 'balance_cleared', next_touch_at: null });
      const back = await seqRow(md.seq.id);
      expect(back.step_index).toBeGreaterThanOrEqual(4);
      expect(new Date(back.next_touch_at).getTime()).toBeGreaterThan(NOW.getTime());
      expect(await Schedule.openScheduleFor(c, { database: app })).toBeUndefined();
    });

    test('release (gate off / admin) restores members and marks the row released; closing twice is a no-op', async () => {
      const c = await customer();
      const m1 = await member(c, { sentDaysAgo: 30, step: 3 });
      const s = await openSchedule(c, { step_index: 3 });
      expect((await Schedule.release(s, 'released_gate_off', NOW, { database: app })).closed).toBe(true);
      expect((await app('customer_dunning_schedules').where({ id: s.id }).first()).status).toBe('released');
      expect((await Schedule.release(s, 'released_gate_off', NOW, { database: app })).closed).toBe(false);
      expect((await seqRow(m1.seq.id)).status).toBe('active');
    });

    test('release pauses a row that is past its final step and alerts (never completes it silently)', async () => {
      const c = await customer();
      const m1 = await member(c, { sentDaysAgo: 300, step: 5 });
      const s = await openSchedule(c, { step_index: 5 });
      await Schedule.release(s, 'released_admin', NOW, { database: app });
      expect(await seqRow(m1.seq.id)).toMatchObject({ status: 'paused', paused_reason: 'released_past_final_step' });
      expect(mockNotify).toHaveBeenCalled();
    });

    test('a paid member (terminal invoice) is not touched by release', async () => {
      const c = await customer();
      const paid = await member(c, { sentDaysAgo: 30, step: 2, invoiceStatus: 'paid' });
      const s = await openSchedule(c, { step_index: 4 });
      await Schedule.release(s, 'released_admin', NOW, { database: app });
      expect((await seqRow(paid.seq.id)).step_index).toBe(2);
    });
  });

  // ── disposition writers ────────────────────────────────────────────────
  describe('disposition writers', () => {
    async function claimed(over = {}) {
      const c = await customer();
      await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c, over);
      return { c, s, claim: await Schedule.claim(s.id, NOW, { database: app }) };
    }
    const fresh = (id) => app('customer_dunning_schedules').where({ id }).first();

    test('held: floor retime (never stale-dropped), held_since kept from the FIRST hold, no alert before 7 days', async () => {
      const { s, claim } = await claimed({ held_since: ago(2), status: 'held' });
      await Schedule.markHeld(claim.schedule, 'progress_unreadable', { claimStamp: claim.claimStamp, now: NOW, database: app });
      const row = await fresh(s.id);
      expect(row).toMatchObject({ status: 'held', held_reason: 'progress_unreadable' });
      expect(new Date(row.held_since).getTime()).toBe(ago(2).getTime());
      expect(new Date(row.next_touch_at).getTime()).toBe(Followups.heldTouchFloor(NOW).getTime());
      expect(mockNotify).not.toHaveBeenCalled();
    });

    test('held 7+ days: ONE alert, then never again', async () => {
      const { s, claim } = await claimed({ held_since: ago(8), status: 'held' });
      await Schedule.markHeld(claim.schedule, 'payer_unresolved', { claimStamp: claim.claimStamp, now: NOW, database: app });
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect((await fresh(s.id)).hold_alerted_at).not.toBeNull();
      await Schedule.releaseClaim(claim, { database: app });
      const again = await Schedule.claim(s.id, new Date(NOW.getTime() + DAY), { database: app });
      await Schedule.markHeld(again.schedule, 'payer_unresolved', { claimStamp: again.claimStamp, now: new Date(NOW.getTime() + DAY), database: app });
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    test('a hold the office must resolve (paused member) alerts at once', async () => {
      const { claim } = await claimed();
      await Schedule.markHeld(claim.schedule, 'member_paused', { claimStamp: claim.claimStamp, now: NOW, database: app });
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    test('unused account credit (the engine never applies it): alerts the office at once to apply it, then never again while held', async () => {
      const { s, claim } = await claimed();
      await Schedule.markHeld(claim.schedule, 'account_credit_available', { claimStamp: claim.claimStamp, now: NOW, database: app });
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify.mock.calls[0][1]).toBe('Apply customer account credit');
      expect((await fresh(s.id)).hold_alerted_at).not.toBeNull();
      await Schedule.releaseClaim(claim, { database: app });
      const again = await Schedule.claim(s.id, new Date(NOW.getTime() + DAY), { database: app });
      await Schedule.markHeld(again.schedule, 'account_credit_available', { claimStamp: again.claimStamp, now: new Date(NOW.getTime() + DAY), database: app });
      expect(mockNotify).toHaveBeenCalledTimes(1);
    });

    test('paused: terminal for the step, next_touch_at null, staff alert; the final step says so', async () => {
      const { s, claim } = await claimed({ step_index: 5 });
      await Schedule.markPaused(claim.schedule, 'no_reachable_channel', { claimStamp: claim.claimStamp, now: NOW, database: app });
      expect(await fresh(s.id)).toMatchObject({ status: 'paused', paused_reason: 'no_reachable_channel', next_touch_at: null });
      expect(mockNotify.mock.calls[0][1]).toBe('Final notice not delivered');
    });

    test('told: last_touch_at stamped, floor retime, step unchanged, held state cleared', async () => {
      const { s, claim } = await claimed({ held_since: ago(1), held_reason: 'x', status: 'held' });
      const at = new Date(NOW.getTime() - 3000);
      await Schedule.markTold(claim.schedule, { claimStamp: claim.claimStamp, deliveredAt: at, now: NOW, database: app });
      const row = await fresh(s.id);
      expect(row).toMatchObject({ status: 'active', step_index: 4, held_reason: null, held_since: null });
      expect(new Date(row.last_touch_at).getTime()).toBe(at.getTime());
      expect(new Date(row.next_touch_at).getTime()).toBe(Followups.heldTouchFloor(NOW).getTime());
    });

    test('autopay hold: status autopay_hold, revisited the next day (next_touch_at = the held-touch floor), still owns its members', async () => {
      const { s, claim } = await claimed();
      expect(await Schedule.markAutopayHold(claim.schedule, { claimStamp: claim.claimStamp, now: NOW, database: app })).toBe(true);
      const row = await fresh(s.id);
      expect(row.status).toBe('autopay_hold');
      expect(new Date(row.next_touch_at).getTime()).toBe(Followups.heldTouchFloor(NOW).getTime());
      expect(await Schedule.openScheduleFor(claim.schedule.customer_id, { database: app })).toBeDefined();
    });

    test('an autopay_hold schedule is claimable once due (not before), re-armable, and resumable only under its own claim', async () => {
      const c = await customer();
      await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c, { status: 'autopay_hold', next_touch_at: new Date(NOW.getTime() + DAY) });
      expect(await Schedule.claim(s.id, NOW, { database: app })).toBeNull(); // not due yet
      const later = new Date(NOW.getTime() + 2 * DAY);
      const claim = await Schedule.claim(s.id, later, { database: app });
      expect(claim).not.toBeNull();
      expect(await Schedule.markAutopayHold(claim.schedule, { claimStamp: claim.claimStamp, now: later, database: app })).toBe(true); // re-armed
      expect((await fresh(s.id)).status).toBe('autopay_hold');
      expect(await Schedule.resumeFromAutopay(claim.schedule, { claimStamp: new Date(later.getTime() - 1), database: app })).toBe(false);
      expect(await Schedule.resumeFromAutopay(claim.schedule, { claimStamp: claim.claimStamp, database: app })).toBe(true);
      expect((await fresh(s.id)).status).toBe('active');
    });

    describe('processSchedule on a revisited autopay hold (real SQL)', () => {
      const autopay = () => require('../services/autopay-eligibility').customerOnAutopay;
      afterEach(() => autopay().mockResolvedValue(false));

      test('the invoices were paid meanwhile: the hold is CLOSED (balance_cleared), the customer is freed', async () => {
        const c = await customer();
        const s = await openSchedule(c, { status: 'autopay_hold', next_touch_at: ago(0.05) });
        autopay().mockResolvedValue(true);
        mockResolve.mockResolvedValue({ kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 });
        expect(await Runner.processSchedule(s.id, NOW)).toMatchObject({ outcome: 'closed', reason: 'balance_cleared' });
        expect(await fresh(s.id)).toMatchObject({ status: 'completed', closed_reason: 'balance_cleared', next_touch_at: null });
        expect(await Schedule.openScheduleFor(c, { database: app })).toBeUndefined();
      });

      test('a live schedule whose invoices are all paid, with the customer on autopay, CLOSES instead of going to autopay_hold', async () => {
        const c = await customer();
        const s = await openSchedule(c);
        autopay().mockResolvedValue(true);
        mockResolve.mockResolvedValue({ kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 });
        expect((await Runner.processSchedule(s.id, NOW)).outcome).toBe('closed');
        expect((await fresh(s.id)).status).toBe('completed');
      });

      test('still owing and still on autopay: the hold is re-armed for tomorrow and the claim released; the due scan revisits it then', async () => {
        const c = await customer();
        const m = await member(c, { sentDaysAgo: 60, step: 4 });
        const s = await openSchedule(c, { status: 'autopay_hold', next_touch_at: ago(0.05) });
        autopay().mockResolvedValue(true);
        mockResolve.mockResolvedValue(setFor([m]));
        expect((await Runner.processSchedule(s.id, NOW)).outcome).toBe('autopay_hold');
        const row = await fresh(s.id);
        expect(row.status).toBe('autopay_hold');
        expect(new Date(row.next_touch_at).getTime()).toBe(Followups.heldTouchFloor(NOW).getTime());
        expect(row.touch_claimed_at).toBeNull();
        const tomorrow = new Date(NOW.getTime() + 2 * DAY);
        expect((await Runner.runCustomerSchedules(tomorrow)).outcomes.autopay_hold).toBeGreaterThanOrEqual(1);
        // this schedule was among those revisited: re-armed again, for the day after
        expect(new Date((await fresh(s.id)).next_touch_at).getTime()).toBe(Followups.heldTouchFloor(tomorrow).getTime());
      });
    });
    test('stage catch-up write moves step_index up and drops the link cache', async () => {
      const { s, claim } = await claimed({ step_index: 2, link_digest: 'a'.repeat(64), link_url: 'u' });
      expect(await Schedule.writeStage(claim.schedule, 4, { claimStamp: claim.claimStamp, database: app })).toBe(true);
      expect(await fresh(s.id)).toMatchObject({ step_index: 4, link_digest: null, link_url: null });
    });
  });

  // ── the boundary re-reads the schedule row (P1: control writes after the claim) ──
  describe('the send boundary and control writes', () => {
    async function claimedWithBoundary() {
      const c = await customer();
      const m = await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c);
      const claim = await Schedule.claim(s.id, NOW, { database: app });
      mockResolve.mockImplementation(async () => setFor([m]));
      const check = Boundary.check(Boundary.snapshotOf(c, setFor([m]), { scheduleId: s.id, claimStamp: claim.claimStamp }));
      return { c, s, claim, check };
    }
    const fresh = (id) => app('customer_dunning_schedules').where({ id }).first();

    test('control: an open schedule under OUR claim passes on the pool and on a transaction', async () => {
      const { check } = await claimedWithBoundary();
      expect(await check({ database: app })).toEqual({ ok: true });
      await app.transaction(async (trx) => { expect(await check({ database: trx })).toEqual({ ok: true }); });
    });

    test('pause after the claim: the boundary refuses (pool and transaction) and the schedule stays paused', async () => {
      const { s, check } = await claimedWithBoundary();
      // a control write that got past the in-flight guard (e.g. after a claim TTL expiry)
      await app('customer_dunning_schedules').where({ id: s.id }).update({ status: 'paused' });
      expect(await check({ database: app })).toMatchObject({ ok: false, code: Boundary.SCHEDULE_CHANGED, retryable: true });
      await app.transaction(async (trx) => {
        expect(await check({ database: trx })).toMatchObject({ ok: false, code: Boundary.SCHEDULE_CHANGED });
      });
      expect(await fresh(s.id)).toMatchObject({ status: 'paused' });
    });

    test('release / close after the claim: the boundary refuses and the schedule stays released', async () => {
      const { s, claim, check } = await claimedWithBoundary();
      // the run's own close (or an expired-claim release) lands after the claim
      expect((await Schedule.close(claim.schedule, 'released_admin', NOW, { database: app, claimStamp: claim.claimStamp })).closed).toBe(true);
      expect(await check({ database: app })).toMatchObject({ ok: false, code: Boundary.SCHEDULE_CHANGED });
      expect(await fresh(s.id)).toMatchObject({ status: 'released' });
    });

    test('a successor that replaced our claim (TTL expiry) makes our boundary refuse', async () => {
      const { s, check } = await claimedWithBoundary();
      await app('customer_dunning_schedules').where({ id: s.id }).update({ touch_claimed_at: new Date(NOW.getTime() + 60000) });
      expect(await check({ database: app })).toMatchObject({ ok: false, code: Boundary.SCHEDULE_CHANGED });
    });

    test('a pause cannot interleave with a boundary transaction: it waits for the row lock the check took, then lands', async () => {
      const { s, check } = await claimedWithBoundary();
      let pauseSettled = false;
      let pausing;
      await app.transaction(async (trx) => {
        expect(await check({ database: trx })).toEqual({ ok: true }); // locks the row FOR UPDATE
        pausing = app('customer_dunning_schedules').where({ id: s.id }).update({ status: 'paused' }).then((n) => { pauseSettled = true; return n; });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(pauseSettled).toBe(false); // the dispatch window: the control write is queued behind us
      });
      expect(await pausing).toBe(1);
      expect(await fresh(s.id)).toMatchObject({ status: 'paused' });
    });
  });

  // ── control writes vs a claim (F3 / C2 / C5) ──────────────────────────
  describe('control writes against a claim', () => {
    const fresh = (id) => app('customer_dunning_schedules').where({ id }).first();
    async function inFlight() {
      const c = await customer();
      const m = await member(c, { sentDaysAgo: 25, step: 2 });
      const s = await openSchedule(c, { step_index: 4 });
      const claim = await Schedule.claim(s.id, NOW, { database: app }); // a worker is sending right now
      return { c, m, s, claim };
    }

    test('pause and release REFUSE while another run holds a fresh claim; nothing changes, no member is handed back', async () => {
      const { s, m } = await inFlight();
      const memberBefore = await seqRow(m.seq.id);
      expect(await Admin.pause(s.id, { now: NOW })).toMatchObject({ ok: false, reason: 'in_flight', message: expect.stringMatching(/try again in a minute/i) });
      expect(await Admin.release(s.id, { now: NOW })).toMatchObject({ ok: false, reason: 'in_flight' });
      expect(await fresh(s.id)).toMatchObject({ status: 'active' });
      const memberAfter = await seqRow(m.seq.id);
      expect(memberAfter.step_index).toBe(memberBefore.step_index);
      expect(memberAfter.status).toBe('active');
    });

    test('once the claim has expired (crashed sender) pause and release go through', async () => {
      const { s } = await inFlight();
      const later = new Date(NOW.getTime() + 11 * 60 * 1000);
      expect(await Admin.pause(s.id, { now: later })).toEqual({ ok: true });
      expect(await fresh(s.id)).toMatchObject({ status: 'paused' });
      expect(await Admin.release(s.id, { now: later })).toMatchObject({ ok: true });
    });

    test('the run\'s OWN claim never blocks its own close; another run\'s stamp does', async () => {
      const { s, claim } = await inFlight();
      expect((await Schedule.close(claim.schedule, 'balance_cleared', NOW, { database: app, claimStamp: new Date(NOW.getTime() - 1) })).reason).toBe('claim_lost');
      expect((await Schedule.close(claim.schedule, 'balance_cleared', NOW, { database: app, claimStamp: claim.claimStamp })).closed).toBe(true);
      expect((await fresh(s.id)).status).toBe('completed');
    });

    describe('a runner-internal close is held to the claim it acted on', () => {
      const later = new Date(NOW.getTime() + 11 * 60 * 1000); // the slow worker's claim has expired by now
      const membersAreUntouched = async (m) => {
        const row = await seqRow(m.seq.id);
        expect(row.step_index).toBe(2);
        expect(row.status).toBe('active');
      };

      test('an admin pause during a slow run: the runner\'s close is refused, the schedule stays paused, members are untouched', async () => {
        const { s, m, claim } = await inFlight();
        expect(await Admin.pause(s.id, { now: later })).toEqual({ ok: true }); // the claim had expired
        const out = await Schedule.close(claim.schedule, 'balance_cleared', later, { database: app, claimStamp: claim.claimStamp });
        expect(out).toMatchObject({ closed: false, reason: 'claim_lost' });
        expect(await fresh(s.id)).toMatchObject({ status: 'paused', closed_reason: null });
        await membersAreUntouched(m);
      });

      test('pause then resume clears the stamp: the stale worker\'s close is refused and the schedule stays active', async () => {
        const { s, m, claim } = await inFlight();
        await Admin.pause(s.id, { now: later });
        await Admin.resume(s.id, { now: later });
        expect((await fresh(s.id)).touch_claimed_at).toBeNull();
        const out = await Schedule.close(claim.schedule, 'no_active_member', later, { database: app, claimStamp: claim.claimStamp });
        expect(out).toMatchObject({ closed: false, reason: 'claim_lost' });
        expect(await fresh(s.id)).toMatchObject({ status: 'active' });
        await membersAreUntouched(m);
      });

      test('the step moved on under another run: refused (the judgement was about a different step)', async () => {
        const { s, m, claim } = await inFlight();
        await app('customer_dunning_schedules').where({ id: s.id }).update({ step_index: 5 });
        const out = await Schedule.close(claim.schedule, 'balance_cleared', NOW, { database: app, claimStamp: claim.claimStamp });
        expect(out).toMatchObject({ closed: false, reason: 'claim_lost' });
        expect((await fresh(s.id)).status).toBe('active');
        await membersAreUntouched(m);
      });

      test('the runner under its OWN claim still closes, active or held, even after the claim has aged past the TTL', async () => {
        const { s, claim } = await inFlight();
        await app('customer_dunning_schedules').where({ id: s.id }).update({ status: 'held', held_reason: 'x', held_since: NOW });
        const out = await Schedule.close(claim.schedule, 'balance_cleared', later, { database: app, claimStamp: claim.claimStamp });
        expect(out.closed).toBe(true);
        expect((await fresh(s.id)).status).toBe('completed');
      });

      test('the admin release path is unchanged: a fresh foreign claim is in_flight, an expired one goes through', async () => {
        const { s } = await inFlight();
        expect(await Admin.release(s.id, { now: NOW })).toMatchObject({ ok: false, reason: 'in_flight' });
        expect(await Admin.release(s.id, { now: later })).toMatchObject({ ok: true });
      });
    });

    test('C2: resume clears the claim, so a worker from before the pause cannot regain authority', async () => {
      const { s, claim } = await inFlight();
      await app('customer_dunning_schedules').where({ id: s.id }).update({ status: 'paused', next_touch_at: null });
      expect(await Admin.resume(s.id, { now: NOW })).toEqual({ ok: true });
      const row = await fresh(s.id);
      expect(row.status).toBe('active');
      expect(row.touch_claimed_at).toBeNull();
      // the old worker's guarded writes now match nothing
      expect(await Schedule.advance(claim.schedule, { claimStamp: claim.claimStamp, now: NOW, database: app })).toBe(false);
      expect(await Schedule.markTold(claim.schedule, { claimStamp: claim.claimStamp, now: NOW, database: app })).toBe(false);
      expect((await fresh(s.id)).step_index).toBe(4);
    });

    test('C5: release lands the members from the schedule row AS LOCKED, not from the caller\'s stale copy', async () => {
      const c = await customer();
      const m = await member(c, { sentDaysAgo: 25, step: 2 });
      const s = await openSchedule(c, { step_index: 4 });
      const stale = { ...s, step_index: 0 }; // what a pre-lock read would have said
      expect((await Schedule.close(stale, 'released_admin', NOW, { database: app })).closed).toBe(true);
      expect((await seqRow(m.seq.id)).step_index).toBe(4);
    });
  });

  // ── hold / pause alert identity (F2) ───────────────────────────────────
  describe('hold and pause alerts are per event', () => {
    const fresh = (id) => app('customer_dunning_schedules').where({ id }).first();
    async function claimAt(id, now) { return Schedule.claim(id, now, { database: app }); }
    const keys = () => mockNotify.mock.calls.map((c) => c[3].dedupeKey);

    test('a DIFFERENT hold reason is a new hold: held_since and hold_alerted_at start over, so the office alert rings', async () => {
      const c = await customer();
      await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c);
      const first = await claimAt(s.id, NOW);
      await Schedule.markHeld(first.schedule, 'COLLECTIONS_POLICY', { claimStamp: first.claimStamp, now: new Date(NOW.getTime() - 9 * DAY), database: app });
      // 9 days on, the same hold has been alerted once (long-held), then the reason changes
      const secondNow = new Date(NOW.getTime());
      await Schedule.releaseClaim(first, { database: app });
      const second = await claimAt(s.id, secondNow);
      await Schedule.markHeld(second.schedule, 'COLLECTIONS_POLICY', { claimStamp: second.claimStamp, now: secondNow, database: app });
      expect(mockNotify).toHaveBeenCalledTimes(1); // the 7-day alert
      await Schedule.releaseClaim(second, { database: app });
      const third = await claimAt(s.id, new Date(NOW.getTime() + DAY));
      await Schedule.markHeld(third.schedule, 'account_credit_available', { claimStamp: third.claimStamp, now: new Date(NOW.getTime() + DAY), database: app });
      expect(mockNotify).toHaveBeenCalledTimes(2);
      expect(mockNotify.mock.calls[1][1]).toBe('Apply customer account credit');
      const row = await fresh(s.id);
      expect(row.held_reason).toBe('account_credit_available');
      expect(new Date(row.held_since).getTime()).toBe(NOW.getTime() + DAY);
      expect(row.hold_alerted_at).not.toBeNull();
    });

    test('the same reason keeps its clock and its single alert', async () => {
      const c = await customer();
      await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c);
      for (let day = 0; day < 3; day += 1) {
        const at = new Date(NOW.getTime() + day * DAY);
        const claim = await claimAt(s.id, at);
        await Schedule.markHeld(claim.schedule, 'account_credit_available', { claimStamp: claim.claimStamp, now: at, database: app });
        await Schedule.releaseClaim(claim, { database: app });
      }
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(new Date((await fresh(s.id)).held_since).getTime()).toBe(NOW.getTime());
    });

    test('a hold that comes back after a release/resume uses a NEW dedupe key (notifyAdmin dedupes a key for good)', async () => {
      const c = await customer();
      await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c);
      const a = await claimAt(s.id, NOW);
      await Schedule.markHeld(a.schedule, 'member_paused', { claimStamp: a.claimStamp, now: NOW, database: app });
      await Schedule.releaseClaim(a, { database: app });
      // the hold clears (a delivered step resets the hold fields), then a later step holds for the same reason
      await app('customer_dunning_schedules').where({ id: s.id }).update({ status: 'active', held_reason: null, held_since: null, hold_alerted_at: null, next_touch_at: NOW });
      const later = new Date(NOW.getTime() + 20 * DAY);
      const b = await claimAt(s.id, later);
      await Schedule.markHeld(b.schedule, 'member_paused', { claimStamp: b.claimStamp, now: later, database: app });
      expect(mockNotify).toHaveBeenCalledTimes(2);
      expect(new Set(keys()).size).toBe(2);
    });

    test('paused alerts are per pause event: pause, resume, pause again rings twice', async () => {
      const c = await customer();
      await member(c, { sentDaysAgo: 60, step: 4 });
      const s = await openSchedule(c);
      const a = await claimAt(s.id, NOW);
      await Schedule.markPaused(a.schedule, 'all_channels_terminal', { claimStamp: a.claimStamp, now: NOW, database: app });
      await Schedule.releaseClaim(a, { database: app });
      await Admin.resume(s.id, { now: NOW });
      await app('customer_dunning_schedules').where({ id: s.id }).update({ next_touch_at: NOW });
      const later = new Date(NOW.getTime() + 3 * DAY);
      const b = await claimAt(s.id, later);
      await Schedule.markPaused(b.schedule, 'all_channels_terminal', { claimStamp: b.claimStamp, now: later, database: app });
      expect(mockNotify).toHaveBeenCalledTimes(2);
      expect(new Set(keys()).size).toBe(2);
    });
  });

  // ── boundary on a handed transaction, DB_POOL_MAX=2 (A-17) ─────────────
  describe('A-17: the email boundary reads on the authority\'s transaction', () => {
    test('with the pool exhausted (lease + authority transaction), the boundary read completes on the handed trx; a pool read would time out', async () => {
      const tight = knex({ client: 'pg', connection, searchPath: [schema], pool: { min: 0, max: 2 }, acquireConnectionTimeout: 1500 });
      try {
        const lease = await tight.transaction(); // runExclusive's connection
        try {
          await tight.transaction(async (trx) => { // withCustomerCommsLock's connection
            mockResolve.mockImplementation(async (customerId, { database }) => {
              await database.raw('select 1');
              return { kind: 'multi', digest: 'd', totalCents: 200, anchor: { id: 'a1' }, members: [] };
            });
            const snap = { customerId: 'c1', kind: 'multi', digest: 'd', totalCents: 200, anchorId: 'a1' };
            expect(await Boundary.check(snap)({ database: trx })).toEqual({ ok: true });
            expect(mockResolve).toHaveBeenLastCalledWith('c1', { database: trx });
            await expect(tight.raw('select 1')).rejects.toThrow(/timeout|acquire/i); // what a pooled read would have done
          });
        } finally {
          await lease.rollback();
        }
      } finally {
        await tight.destroy();
      }
    });
  });

  // ── A-11: the never_contacted stamp clears with SQL Postgres accepts ────
  describe('A-11: clearing a stale never_contacted stamp (real SQL)', () => {
    test('removes only that key, leaves other metadata, and is a no-op on a row without it', async () => {
      const [withFlag] = await app('collections_contact_ledger').insert({ metadata: JSON.stringify({ never_contacted: true, send_failed: true, keep: 'x' }) }).returning('id');
      const [plain] = await app('collections_contact_ledger').insert({ metadata: JSON.stringify({ keep: 'y' }) }).returning('id');
      const [nulled] = await app('collections_contact_ledger').insert({ metadata: null }).returning('id');
      for (const row of [withFlag, plain, nulled]) await Send.stampNeverContacted({ id: row.id }, false);
      expect((await app('collections_contact_ledger').where({ id: withFlag.id }).first()).metadata).toEqual({ send_failed: true, keep: 'x' });
      expect((await app('collections_contact_ledger').where({ id: plain.id }).first()).metadata).toEqual({ keep: 'y' });
      expect((await app('collections_contact_ledger').where({ id: nulled.id }).first()).metadata).toBeNull();
    });
  });

  // ── shadow: writes nothing ─────────────────────────────────────────────
  describe('shadowRun', () => {
    const snapshot = async () => {
      const out = {};
      for (const t of ['customers', 'invoices', 'invoice_followup_sequences', 'customer_dunning_schedules']) {
        out[t] = JSON.stringify(await app(t).orderBy('id'));
      }
      return out;
    };

    test('PostgreSQL itself refuses a write inside the shadow transaction, and rolls back', async () => {
      const c = await customer();
      await expect(Schedule.inReadOnlyTransaction(app, (trx) => trx('customers').insert({ id: randomUUID() })))
        .rejects.toMatchObject({ code: '25006' });
      expect(await app('customers').where({ id: c })).toHaveLength(1);
    });

    test('a shadow run with promotable customers and a due schedule changes no row in any table', async () => {
      const promotable = await customer();
      const a = await member(promotable, { sentDaysAgo: 45, step: 3 });
      const b = await member(promotable, { sentDaysAgo: 20, step: 1 });
      const owned = await customer();
      const o1 = await member(owned, { sentDaysAgo: 60, step: 4 });
      await openSchedule(owned);
      mockResolve.mockImplementation(async (customerId) => (customerId === promotable
        ? setFor([a, b]) : setFor([o1, o1])));
      const before = await snapshot();
      const tally = await Runner.shadowRun(NOW);
      expect(await snapshot()).toEqual(before);
      expect(tally.promote).toBeGreaterThanOrEqual(1);
      expect(tally.send).toBeGreaterThanOrEqual(1);
      expect(mockNotify).not.toHaveBeenCalled();
    });
  });
});
