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

  function tables({ insertThrows = null, active = null } = {}) {
    const updates = [];
    const inserts = [];
    const build = () => {
      const q = {};
      ['where', 'whereNull'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.first = jest.fn(async () => active);
      q.insert = jest.fn(async (row) => { inserts.push(row); if (insertThrows) throw insertThrows; return [1]; });
      q.update = jest.fn(async (patch) => { updates.push(patch); return 1; });
      return q;
    };
    db.mockImplementation(() => build());
    return { updates, inserts };
  }

  test('writes the reason discriminator the money check matches: "dispute on call: <summary>" / "dispute raised on call"', async () => {
    const withSummary = tables();
    await placeDisputeHold('c-1', { summary: 'says July is wrong' });
    expect(withSummary.inserts[0]).toMatchObject({ flag: 'collection_hold', reason: 'dispute on call: says July is wrong' });
    const bare = tables();
    await placeDisputeHold('c-1', {});
    expect(bare.inserts[0]).toMatchObject({ reason: 'dispute raised on call' });
  });

  test('a dispute over an ACTIVE fallback row (unique index) upgrades that row so the dispute is never swallowed', async () => {
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    const t = tables({ insertThrows: dup, active: { id: 'row-1', reason: 'wrong-party answer on billing follow-up call; review card failed to file' } });
    const res = await placeDisputeHold('c-1', { summary: 'bill is wrong' });
    expect(res.ok).toBe(true);
    expect(t.updates).toHaveLength(1);
    expect(t.updates[0].reason).toMatch(/^dispute on call: bill is wrong; earlier hold: wrong-party answer/);
  });

  test('a dispute over an already-dispute row changes nothing; a failed upgrade reports ok:false (never a silent non-hold)', async () => {
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    const same = tables({ insertThrows: dup, active: { id: 'row-1', reason: 'dispute on call: earlier' } });
    expect((await placeDisputeHold('c-1', { summary: 'again' })).ok).toBe(true);
    expect(same.updates).toHaveLength(0);
    // first call (insert) must hit the unique violation, the lookup then fails
    let calls = 0;
    db.mockImplementation(() => {
      calls += 1;
      const q = {};
      ['where', 'whereNull'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.insert = jest.fn(async () => { throw dup; });
      q.first = jest.fn(async () => { throw new Error('read failed'); });
      return q;
    });
    expect((await placeDisputeHold('c-1', { summary: 'x' })).ok).toBe(false);
    expect(calls).toBeGreaterThan(1);
  });
});
