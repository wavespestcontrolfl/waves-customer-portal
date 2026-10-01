// Customer merge x customer-level overdue reminders, against the fully MIGRATED database (Codex #5503
// r2 P1; skipped without APP_TEST_DATABASE_URL, run for real in CI). customer_dunning_schedules carries
// UNIQUE (customer_id, episode) and one open schedule per customer, so executeMerge's FK sweep used to
// raise 23505 for two ordinary episode-1 histories (or two open schedules) and abort the whole merge.
// Proven here with the REAL executeMerge / revertMerge and the real engine release:
//   * both customers with episode-1 history, the loser with an open schedule: the merge succeeds, the
//     open schedule is released (released_merge) with its members landed on their own ladders, the
//     loser's episodes sit above the winner's (unique), and no open schedule is left anywhere;
//   * a release the engine refuses (a send in flight) aborts the merge before anything moved;
//   * the undo moves the closed schedule history back to the restored customer.
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

const dedupe = require('../services/customer-dedupe');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(120000);

const DAY = 24 * 60 * 60 * 1000;
const TABLE = 'customer_dunning_schedules';

postgres('customer merge reconciles customer-level overdue reminder schedules (PostgreSQL)', () => {
  const created = { customers: new Set(), invoices: new Set() };
  let savedLadder;

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    mockDatabase = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    if (!(await mockDatabase.schema.hasTable(TABLE))) throw new Error('run the migrations first: customer_dunning_schedules is missing');
    savedLadder = process.env.GATE_DUNNING_LADDER_90;
    process.env.GATE_DUNNING_LADDER_90 = 'true';
  });

  afterAll(async () => {
    if (savedLadder === undefined) delete process.env.GATE_DUNNING_LADDER_90;
    else process.env.GATE_DUNNING_LADDER_90 = savedLadder;
    if (!mockDatabase) return;
    const customers = [...created.customers];
    const invoices = [...created.invoices];
    const bestEffort = async (fn) => { try { await fn(); } catch { /* cleanup only */ } };
    await bestEffort(() => mockDatabase('customer_merge_journal').whereIn('winner_customer_id', customers).del());
    await bestEffort(() => mockDatabase(TABLE).whereIn('customer_id', customers).del());
    await bestEffort(() => mockDatabase('invoice_followup_sequences').whereIn('invoice_id', invoices).del());
    await bestEffort(() => mockDatabase('invoices').whereIn('id', invoices).del());
    await bestEffort(() => mockDatabase('customer_activity_events').whereIn('customer_id', customers).del());
    await bestEffort(() => mockDatabase('customers').whereIn('id', customers).del());
    await mockDatabase.destroy();
  });

  async function customer(label, phone) {
    const id = randomUUID();
    created.customers.add(id);
    await mockDatabase('customers').insert({ id, first_name: 'Synthetic', last_name: label, phone });
    return id;
  }

  async function memberInvoice(customerId, { sentDaysAgo = 20, stepIndex = 1 } = {}) {
    const id = randomUUID();
    created.invoices.add(id);
    const sentAt = new Date(Date.now() - sentDaysAgo * DAY);
    await mockDatabase('invoices').insert({
      id, customer_id: customerId, status: 'sent', sent_at: sentAt, created_at: sentAt,
      token: `tok-${id}`, invoice_number: `QA-${id.slice(0, 8)}`, total: 100,
    });
    await mockDatabase('invoice_followup_sequences').insert({
      invoice_id: id, customer_id: customerId, status: 'active', step_index: stepIndex,
      next_touch_at: new Date(Date.now() - DAY), touches_sent: stepIndex,
    });
    return id;
  }

  const schedule = (customerId, episode, status, extra = {}) => mockDatabase(TABLE).insert({
    customer_id: customerId, episode, status, step_index: 1,
    next_touch_at: ['active', 'held', 'autopay_hold'].includes(status) ? new Date(Date.now() + DAY) : null,
    closed_reason: ['completed', 'released'].includes(status) ? (status === 'completed' ? 'balance_cleared' : 'released_admin') : null,
    closed_at: ['completed', 'released'].includes(status) ? new Date(Date.now() - 30 * DAY) : null,
    ...extra,
  }).returning('*').then(([row]) => row);

  test('two episode-1 histories and an open loser schedule: the merge succeeds, episodes stay unique, nothing is left open, the members land', async () => {
    const phone = `+1999555${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const winnerId = await customer('Winner', phone);
    const loserId = await customer('Loser', phone);
    const winnerHistory = await schedule(winnerId, 1, 'completed');
    const loserHistory = await schedule(loserId, 1, 'released');
    const loserOpen = await schedule(loserId, 2, 'active');
    const invoiceA = await memberInvoice(loserId);
    const invoiceB = await memberInvoice(loserId);

    const result = await dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:dunning-merge' });
    expect(result.journalId).toBeTruthy();

    const rows = await mockDatabase(TABLE).whereIn('id', [winnerHistory.id, loserHistory.id, loserOpen.id]).select('*');
    // every row now belongs to the winner, with unique episodes: the loser's went above the winner's 1
    expect(rows.every((r) => r.customer_id === winnerId)).toBe(true);
    const episodeOf = Object.fromEntries(rows.map((r) => [r.id, r.episode]));
    expect(episodeOf).toEqual({ [winnerHistory.id]: 1, [loserHistory.id]: 2, [loserOpen.id]: 3 });
    // the open schedule was released by the engine, never repointed open
    const released = rows.find((r) => r.id === loserOpen.id);
    expect(released).toMatchObject({ status: 'released', closed_reason: 'released_merge', next_touch_at: null });
    expect(await mockDatabase(TABLE).whereIn('customer_id', [winnerId, loserId])
      .whereIn('status', ['active', 'held', 'paused', 'autopay_hold']).first()).toBeUndefined();
    // the members landed on their own ladders (active, dated ahead), now under the winner
    const members = await mockDatabase('invoice_followup_sequences').whereIn('invoice_id', [invoiceA, invoiceB]).select('*');
    expect(members).toHaveLength(2);
    for (const m of members) {
      expect(m).toMatchObject({ status: 'active', customer_id: winnerId });
      expect(new Date(m.next_touch_at).getTime()).toBeGreaterThan(Date.now());
      expect(m.step_index).toBeGreaterThanOrEqual(1);
    }
    // the renumber is in the journal for audit
    const journal = await mockDatabase('customer_merge_journal').where({ id: result.journalId }).first();
    const recorded = typeof journal.repointed_ids === 'string' ? JSON.parse(journal.repointed_ids) : journal.repointed_ids;
    expect(recorded.dunning_episode_renumbers).toEqual([
      { id: loserHistory.id, from: 1, to: 2 },
      { id: loserOpen.id, from: 2, to: 3 },
    ]);
    expect(recorded.collision_handlers).toEqual([]);
    // the next promotion of the merged customer gets the next free episode
    const next = await mockDatabase(TABLE).where({ customer_id: winnerId }).max('episode as max').first();
    expect(Number(next.max)).toBe(3);

    // The undo moves the closed history back to the restored customer by id (no collision: the
    // loser has no other rows), keeping the new numbers.
    await dedupe.revertMerge({ journalId: result.journalId, performedBy: 'test:dunning-merge' });
    const back = await mockDatabase(TABLE).whereIn('id', [loserHistory.id, loserOpen.id]).select('id', 'customer_id', 'episode');
    expect(back.every((r) => r.customer_id === loserId)).toBe(true);
    expect((await mockDatabase(TABLE).where({ id: winnerHistory.id }).first()).customer_id).toBe(winnerId);
  });

  test('two OPEN schedules: both are released and the merge succeeds', async () => {
    const phone = `+1999556${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const winnerId = await customer('Winner', phone);
    const loserId = await customer('Loser', phone);
    const winnerOpen = await schedule(winnerId, 1, 'active');
    const loserOpen = await schedule(loserId, 1, 'paused', { paused_reason: 'admin_paused' });
    await memberInvoice(winnerId);
    const loserInvoice = await memberInvoice(loserId);

    await dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:dunning-merge' });

    const rows = await mockDatabase(TABLE).whereIn('id', [winnerOpen.id, loserOpen.id]).select('*');
    expect(rows.map((r) => [r.id, r.customer_id, r.episode, r.status, r.closed_reason]).sort()).toEqual([
      [winnerOpen.id, winnerId, 1, 'released', 'released_merge'],
      [loserOpen.id, winnerId, 2, 'released', 'released_merge'],
    ].sort());
    // a paused schedule's members keep that pause on their own ladder (release never resumes them)
    expect(await mockDatabase('invoice_followup_sequences').where({ invoice_id: loserInvoice }).first())
      .toMatchObject({ status: 'paused', paused_reason: 'admin_paused', customer_id: winnerId });
  });

  test('a release the engine refuses (a send in flight) aborts the merge before anything moved', async () => {
    const phone = `+1999557${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const winnerId = await customer('Winner', phone);
    const loserId = await customer('Loser', phone);
    await schedule(winnerId, 1, 'completed');
    const loserOpen = await schedule(loserId, 1, 'active', { touch_claimed_at: new Date() });
    const invoice = await memberInvoice(loserId);

    await expect(dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:dunning-merge' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'DUNNING_SCHEDULE_BUSY', dunningReason: 'in_flight' });

    expect(await mockDatabase(TABLE).where({ id: loserOpen.id }).first())
      .toMatchObject({ customer_id: loserId, status: 'active', episode: 1 });
    expect((await mockDatabase('customers').where({ id: loserId }).first()).deleted_at).toBeNull();
    expect((await mockDatabase('invoices').where({ id: invoice }).first()).customer_id).toBe(loserId);
    expect(await mockDatabase('customer_merge_journal').where({ loser_customer_id: loserId }).first()).toBeUndefined();
  });
});
