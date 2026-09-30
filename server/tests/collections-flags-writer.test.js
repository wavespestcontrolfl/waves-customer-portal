/**
 * collections flags writer — the ONE mechanism every flag write/release goes
 * through (relay webhooks, conversation, and ops/agents/collections-flag.js).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => { const fn = jest.fn(); fn.fn = { now: jest.fn(() => 'NOW()') }; return fn; });

const db = require('../models/db');
const { writeFlag, releaseFlag, activeFlags } = require('../services/collections/outbound-voice/flags');

function chain({ updateResult = 1, rows = [], insertThrows = null } = {}) {
  const q = {};
  ['where', 'whereNull', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(async () => rows);
  q.update = jest.fn(async () => updateResult);
  q.insert = jest.fn(async () => { if (insertThrows) throw insertThrows; return [1]; });
  return q;
}
beforeEach(() => jest.clearAllMocks());

test('writeFlag inserts once; a unique-violation (already active) is success-by-intent', async () => {
  db.mockImplementation(() => chain());
  expect(await writeFlag({ customerId: 'c-1', flag: 'pays_by_check', reason: 'r', createdBy: 'owner:ops-script' })).toEqual({ ok: true, created: true });
  db.mockImplementation(() => chain({ insertThrows: Object.assign(new Error('dup'), { code: '23505' }) }));
  expect(await writeFlag({ customerId: 'c-1', flag: 'pays_by_check' })).toEqual({ ok: true, created: false });
  expect(await writeFlag({ customerId: null, flag: 'pays_by_check' })).toEqual({ ok: false, reason: 'missing_args' });
});

test('releaseFlag stamps released_at on the active row only — never deletes; idempotent', async () => {
  const q = chain({ updateResult: 1 }); db.mockImplementation(() => q);
  expect(await releaseFlag({ customerId: 'c-1', flag: 'pays_by_check' })).toEqual({ ok: true, released: 1 });
  expect(q.where).toHaveBeenCalledWith({ customer_id: 'c-1', flag: 'pays_by_check' });
  expect(q.whereNull).toHaveBeenCalledWith('released_at');
  expect(q.update).toHaveBeenCalledWith({ released_at: 'NOW()' });
  db.mockImplementation(() => chain({ updateResult: 0 }));
  expect(await releaseFlag({ customerId: 'c-1', flag: 'pays_by_check' })).toEqual({ ok: true, released: 0 });
  expect(await releaseFlag({ customerId: 'c-1' })).toEqual({ ok: false, reason: 'missing_args' });
});

test('activeFlags lists unreleased rows oldest first', async () => {
  const q = chain({ rows: [{ flag: 'pays_by_check' }] }); db.mockImplementation(() => q);
  expect(await activeFlags('c-1')).toEqual([{ flag: 'pays_by_check' }]);
  expect(q.whereNull).toHaveBeenCalledWith('released_at');
  expect(q.orderBy).toHaveBeenCalledWith('created_at', 'asc');
  expect(await activeFlags(null)).toEqual([]);
});

test('E: a collection_hold write is a PLAIN insert — no transaction, no advisory lock, it never waits on a charge in flight', async () => {
  const q = chain();
  db.transaction = jest.fn();
  db.raw = jest.fn();
  db.mockImplementation(() => q);
  expect(await writeFlag({ customerId: 'c-1', flag: 'collection_hold', reason: 'dispute on call: x' })).toEqual({ ok: true, created: true });
  expect(q.insert).toHaveBeenCalledTimes(1);
  expect(db.transaction).not.toHaveBeenCalled();
  expect(db.raw).not.toHaveBeenCalled();
});

describe('placeDisputeHold (B: only DISPUTE holds stop money)', () => {
  const { placeDisputeHold } = require('../services/collections/outbound-voice/flags');
  jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
  const dup = Object.assign(new Error('dup'), { code: '23505' });

  // script: per-call behaviours for the collections_flags table
  function world({ inserts = [], updates = [], activeDispute = [] }) {
    const log = { inserts: [], updates: [] };
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    db.mockImplementation(() => {
      const q = {};
      ['where', 'whereNull', 'whereRaw'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.insert = jest.fn(async (row) => {
        log.inserts.push(row);
        const next = inserts.shift();
        if (next === 'dup') throw dup;
        return [1];
      });
      q.update = jest.fn(async (patch) => { log.updates.push(patch); return updates.length ? updates.shift() : 0; });
      q.first = jest.fn(async () => (activeDispute.length ? activeDispute.shift() : null));
      return q;
    });
    return log;
  }

  test('writes the reason discriminator the money check matches', async () => {
    const a = world({});
    await placeDisputeHold('c-1', { summary: 'says July is wrong' });
    expect(a.inserts[0]).toMatchObject({ flag: 'collection_hold', reason: 'dispute on call: says July is wrong' });
    const b = world({});
    await placeDisputeHold('c-1', {});
    expect(b.inserts[0]).toMatchObject({ reason: 'dispute raised on call' });
  });

  test('an active fallback row is upgraded by ONE conditional UPDATE on the active, non-dispute row', async () => {
    const w = world({ inserts: ['dup'], updates: [1] });
    const res = await placeDisputeHold('c-1', { summary: 'bill is wrong' });
    expect(res.ok).toBe(true);
    expect(w.inserts).toHaveLength(1);
    expect(w.updates).toHaveLength(1);
    expect(w.updates[0].reason.sql).toMatch(/earlier hold/);
    expect(w.updates[0].reason.bindings[0]).toBe('dispute on call: bill is wrong');
  });

  test('RACE 1: the fallback is released between the duplicate insert and the update - the insert is retried and a dispute row lands', async () => {
    const w = world({ inserts: ['dup', 'ok'], updates: [0], activeDispute: [null] });
    const res = await placeDisputeHold('c-1', { summary: 'x' });
    expect(res.ok).toBe(true);
    expect(w.inserts).toHaveLength(2);
  });

  test('RACE 2: already a dispute row (update matches 0) is verified active, not re-inserted', async () => {
    const w = world({ inserts: ['dup'], updates: [0], activeDispute: [{ id: 'r1' }] });
    expect((await placeDisputeHold('c-1', {})).ok).toBe(true);
    expect(w.inserts).toHaveLength(1);
  });

  test('bounded: repeated release races give up with ok:false and no success card', async () => {
    const { notifyAdmin } = require('../services/notification-service');
    notifyAdmin.mockClear();
    const w = world({ inserts: ['dup', 'dup', 'dup'], updates: [0, 0, 0], activeDispute: [null, null, null] });
    const res = await placeDisputeHold('c-1', {});
    expect(res.ok).toBe(false);
    expect(w.inserts).toHaveLength(3);
    expect(notifyAdmin).not.toHaveBeenCalled();
  });

  test('a db failure reports ok:false (never a silent non-hold)', async () => {
    db.raw = jest.fn();
    db.mockImplementation(() => { const q = {}; ['where', 'whereNull', 'whereRaw'].forEach((m) => { q[m] = () => q; }); q.insert = async () => { throw dup; }; q.update = async () => { throw new Error('boom'); }; return q; });
    expect((await placeDisputeHold('c-1', {})).ok).toBe(false);
  });
});
