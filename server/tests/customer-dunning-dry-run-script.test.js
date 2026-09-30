// server/scripts/dunning-customer-schedule-dry-run.js — READ-ONLY by
// construction. It must never write, mint, reserve or send; it prints ids
// only. (The real-Postgres proof that a write inside its transaction is
// refused lives in customer-dunning-schedules-migration-postgres.test.js.)
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
const script = require('../scripts/dunning-customer-schedule-dry-run');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'dunning-customer-schedule-dry-run.js'), 'utf8');
const CODE = SOURCE.replace(/^\s*\/\/.*$/gm, ''); // ignore the header comments

describe('static guard: the script cannot write, mint or send', () => {
  test.each([
    ['.insert(', /\.insert\(/],
    ['.update(', /\.update\(/],
    ['.del(', /\.del\(/],
    ['.delete(', /\.delete\(/],
    ['.truncate(', /\.truncate\(/],
    ['a raw write', /raw\(\s*['"`]\s*(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i],
    ['applyCreditBeforeResolve', /applyCreditBeforeResolve/],
    ['a short-link mint', /shortenOrPassthrough|createShortCode/],
    ['a send', /sendCustomerMessage|sendReminderChannels|sendTemplate|sendOne\(/],
    ['a --execute flag', /--execute/],
    ['a commit', /\.commit\(/],
  ])('contains no %s', (_label, pattern) => {
    expect(CODE).not.toMatch(pattern);
  });

  test('says READ-ONLY at the top and runs each customer in a READ ONLY transaction', () => {
    expect(SOURCE.split('\n')[1]).toMatch(/READ-ONLY/);
    expect(CODE).toMatch(/SET TRANSACTION READ ONLY/);
  });

  test('requiring the module has no side effects (no connection, no exit)', () => {
    expect(typeof script.buildCustomerReport).toBe('function');
  });
});

describe('inReadOnlyTransaction', () => {
  function fakeDb(order) {
    const trx = { raw: jest.fn(async (sql) => { order.push(`raw:${sql}`); }), rollback: jest.fn(async () => { order.push('rollback'); }), commit: jest.fn() };
    return { db: { transaction: jest.fn(async () => { order.push('begin'); return trx; }) }, trx };
  }

  test('sets READ ONLY before anything else and always rolls back', async () => {
    const order = [];
    const { db, trx } = fakeDb(order);
    const out = await script.inReadOnlyTransaction(db, async () => { order.push('work'); return 7; });
    expect(out).toBe(7);
    expect(order).toEqual(['begin', 'raw:SET TRANSACTION READ ONLY', 'work', 'rollback']);
    expect(trx.commit).not.toHaveBeenCalled();
  });

  test('rolls back when the work throws, and rethrows', async () => {
    const order = [];
    const { db, trx } = fakeDb(order);
    await expect(script.inReadOnlyTransaction(db, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(trx.commit).not.toHaveBeenCalled();
  });
});

describe('findCandidateCustomerIds', () => {
  test('active sequences on live, homeowner-billed, non-withdrawn invoices, 2 or more per customer', async () => {
    const calls = [];
    const q = {};
    for (const m of ['join', 'where', 'whereNotIn', 'whereNull', 'groupBy', 'havingRaw', 'orderBy']) {
      q[m] = jest.fn((...a) => { calls.push([m, ...a]); return q; });
    }
    q.select = jest.fn(async () => [{ customer_id: 'cust-a' }, { customer_id: 'cust-b' }]);
    const database = jest.fn(() => q);
    await expect(script.findCandidateCustomerIds(database)).resolves.toEqual(['cust-a', 'cust-b']);
    expect(database).toHaveBeenCalledWith('invoice_followup_sequences as s');
    expect(calls).toContainEqual(['where', 's.status', 'active']);
    expect(calls).toContainEqual(['whereNull', 'i.payer_id']);
    expect(calls).toContainEqual(['havingRaw', 'count(*) >= 2']);
    const terminal = calls.find(([m]) => m === 'whereNotIn')[2];
    expect(terminal).toEqual(expect.arrayContaining(['paid', 'prepaid', 'void', 'processing', 'refunded']));
  });
});

describe('buildCustomerReport', () => {
  const NOW = new Date('2026-09-30T14:16:00Z');
  const seqRows = [
    { id: 'seq-A', invoice_id: 'inv-A', step_index: 5, next_touch_at: new Date('2026-10-20T14:00:00Z'), last_touch_at: null, customer_id: 'cust-1' },
    { id: 'seq-B', invoice_id: 'inv-B', step_index: 4, next_touch_at: new Date('2026-10-13T14:00:00Z'), last_touch_at: null, customer_id: 'cust-1' },
  ];
  const database = () => {
    const q = {};
    for (const m of ['join', 'where', 'orderBy']) q[m] = jest.fn(() => q);
    q.select = jest.fn(async () => seqRows);
    return jest.fn(() => q);
  };
  const stepIdAt = (i) => ['d3', 'd10', 'd17', 'd30', 'd60', 'd90'][i] || null;
  const member = (id, seqStatus, quiet = false) => ({ invoice_id: id, cents: 10000, seqStatus, quiet, seq_id: `seq-${id.slice(-1)}` });
  const deps = (set, seedResult = { step_index: 5, step_id: 'd90', next_touch_at: new Date('2026-10-20T14:00:00Z'), last_touch_at: null, touches_sent: 5, oldest_invoice_id: 'inv-A' }) => ({
    database: database(), now: NOW, stepIdAt,
    resolve: jest.fn(async () => set), seed: jest.fn(() => seedResult),
  });
  const base = { reason: null, anchor: { id: 'inv-A' }, digest: 'd', excluded: { stopped: [], md: [] } };

  test('a multi customer with 2 active members would be promoted, with the seed and the absorbed touches', async () => {
    const d = deps({ ...base, kind: 'multi', members: [member('inv-A', 'active'), member('inv-B', 'active')], totalCents: 20000, activeCount: 2 });
    const r = await script.buildCustomerReport('cust-1', d);
    expect(r).toMatchObject({ customer_id: 'cust-1', kind: 'multi', would_promote: true, would_hold: false, anchor_invoice_id: 'inv-A', member_count: 2, total_cents: 20000 });
    expect(r.seed).toMatchObject({ step_id: 'd90', next_touch_at: '2026-10-20T14:00:00.000Z' });
    expect(r.absorbed).toEqual([
      { invoice_id: 'inv-A', step_id: 'd90', next_touch_at: '2026-10-20T14:00:00.000Z' },
      { invoice_id: 'inv-B', step_id: 'd60', next_touch_at: '2026-10-13T14:00:00.000Z' },
    ]);
    // the seed is computed from the active members' rows only
    expect(d.seed.mock.calls[0][0].map((row) => row.invoice_id)).toEqual(['inv-A', 'inv-B']);
  });

  test('a held customer is reported as WOULD BE HELD with its reason, and is not promoted', async () => {
    const d = deps({ ...base, kind: 'hold', reason: 'member_paused', members: [member('inv-A', 'active'), member('inv-B', 'paused')], totalCents: 20000, activeCount: 1 });
    const r = await script.buildCustomerReport('cust-1', d);
    expect(r).toMatchObject({ kind: 'hold', reason: 'member_paused', would_hold: true, would_promote: false, seed: null, absorbed: [] });
    expect(d.seed).not.toHaveBeenCalled();
  });

  test('quiet members do not count toward promotion (needs 2 ACTIVE)', async () => {
    const d = deps({ ...base, kind: 'multi', members: [member('inv-A', 'active'), member('inv-B', 'completed', true)], totalCents: 20000, activeCount: 1 });
    const r = await script.buildCustomerReport('cust-1', d);
    expect(r.would_promote).toBe(false);
    expect(r.members.map((m) => m.quiet)).toEqual([false, true]);
  });

  test('the report carries ids and amounts only — never a name or address', async () => {
    const d = deps({ ...base, kind: 'multi', members: [member('inv-A', 'active'), member('inv-B', 'active')], totalCents: 20000, activeCount: 2 });
    const r = await script.buildCustomerReport('cust-1', d);
    expect(Object.keys(r).sort()).toEqual([
      'absorbed', 'anchor_invoice_id', 'customer_id', 'excluded', 'kind', 'member_count', 'members', 'per_invoice_touches',
      'reason', 'seed', 'total_cents', 'would_hold', 'would_promote',
    ]);
    expect(JSON.stringify(r)).not.toMatch(/first_name|last_name|email|phone|address|token/i);
  });
});
