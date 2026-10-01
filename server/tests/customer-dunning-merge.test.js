// Customer merge reconciliation for customer_dunning_schedules (customer-dunning/merge.js,
// Codex #5503 r2 P1): a merge of two customers that both have schedule rows used to fail on
// UNIQUE (customer_id, episode) / the one-open-schedule index. The merge now releases every open
// schedule through the engine first (a refused release aborts the merge), and inside its
// transaction takes both dunning keys, refuses a schedule that opened meanwhile and renumbers the
// loser's episodes above the winner's. The real transaction is proven in
// customer-dunning-merge-postgres.test.js; this suite pins the decisions.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockRelease = jest.fn();
jest.mock('../services/customer-dunning/schedule', () => ({ release: (...a) => mockRelease(...a) }));

const DunningMerge = require('../services/customer-dunning/merge');

const WINNER = 'aaaaaaaa-0000-0000-0000-000000000002';
const LOSER = 'aaaaaaaa-0000-0000-0000-000000000001'; // sorts first: the keys must still go in id order

// A recording knex stub over an in-memory customer_dunning_schedules table.
function fakeDb(rows) {
  const log = [];
  const table = rows.map((r) => ({ ...r }));
  const database = jest.fn((name) => {
    expect(name).toBe('customer_dunning_schedules');
    const filters = [];
    const q = {
      whereIn(column, values) { filters.push((r) => values.map(String).includes(String(r[column]))); return q; },
      where(match) { filters.push((r) => Object.entries(match).every(([k, v]) => String(r[k]) === String(v))); return q; },
      async select() { log.push(['select']); return table.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r })); },
      async update(patch) {
        const hit = table.filter((r) => filters.every((f) => f(r)));
        for (const r of hit) {
          for (const [k, v] of Object.entries(patch)) {
            if (k === 'updated_at') continue;
            r[k] = v && v.negate ? -r[k] : v;
          }
        }
        log.push(['update', patch.episode && patch.episode.negate ? 'negate' : patch, hit.map((r) => r.id)]);
        return hit.length;
      },
    };
    return q;
  });
  database.raw = jest.fn(async (sql, bindings) => { log.push(['raw', sql, bindings]); });
  database.fn = { now: () => 'NOW()' };
  return { database, table, log, trx: database };
}

// trx.raw('-episode') in the module: the stub hands back a marker the fake update understands.
function withNegateRaw(fake) {
  const { database } = fake;
  const raw = database.raw;
  database.raw = jest.fn((sql, bindings) => (sql === '-episode' ? { negate: true } : raw(sql, bindings)));
  return fake;
}

beforeEach(() => { mockRelease.mockReset(); });

describe('releaseOpenSchedulesForMerge (before the merge transaction)', () => {
  test('nothing open on either side: reads once and releases nothing', async () => {
    const { database } = fakeDb([
      { id: 's1', customer_id: WINNER, episode: 1, status: 'completed' },
      { id: 's2', customer_id: LOSER, episode: 1, status: 'released' },
    ]);
    await expect(DunningMerge.releaseOpenSchedulesForMerge([WINNER, LOSER], { database })).resolves.toEqual([]);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  test('every open schedule of either party is released through the engine as released_merge', async () => {
    const now = new Date('2026-10-01T15:00:00Z');
    const { database } = fakeDb([
      { id: 's-w', customer_id: WINNER, episode: 2, status: 'paused' },
      { id: 's-l', customer_id: LOSER, episode: 1, status: 'active' },
      { id: 's-old', customer_id: LOSER, episode: 0, status: 'completed' },
      { id: 's-other', customer_id: 'someone-else', episode: 1, status: 'active' },
    ]);
    mockRelease.mockImplementation(async (schedule) => ({ closed: true, landed: schedule.id === 's-l' ? [{}, {}] : [{}] }));
    const out = await DunningMerge.releaseOpenSchedulesForMerge([WINNER, LOSER], { now, database });
    expect(mockRelease.mock.calls.map(([s, reason, at, opts]) => [s.id, reason, at, opts.database])).toEqual([
      ['s-w', 'released_merge', now, database],
      ['s-l', 'released_merge', now, database],
    ]);
    expect(out).toEqual([
      { scheduleId: 's-w', customerId: WINNER, landed: 1 },
      { scheduleId: 's-l', customerId: LOSER, landed: 2 },
    ]);
  });

  test('a schedule another writer closed in between needs nothing', async () => {
    const { database } = fakeDb([{ id: 's-l', customer_id: LOSER, episode: 1, status: 'held' }]);
    mockRelease.mockResolvedValue({ closed: false, landed: [] });
    await expect(DunningMerge.releaseOpenSchedulesForMerge([WINNER, LOSER], { database })).resolves.toEqual([]);
  });

  test.each([
    ['in_flight', /sending to one of these customers right now/],
    ['outcome_unconfirmed', /still unconfirmed/],
    ['evidence_unreadable', /could not be read/],
    ['schedule_changed', /kept changing/],
  ])('a release the engine refuses (%s) aborts the merge with a 409 in plain words, releasing nothing more', async (reason, words) => {
    const { database } = fakeDb([
      { id: 's-a', customer_id: LOSER, episode: 1, status: 'active' },
      { id: 's-b', customer_id: WINNER, episode: 1, status: 'active' },
    ]);
    mockRelease.mockResolvedValueOnce({ closed: false, landed: [], reason });
    const err = await DunningMerge.releaseOpenSchedulesForMerge([WINNER, LOSER], { database }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ statusCode: 409, code: 'DUNNING_SCHEDULE_BUSY', dunningReason: reason });
    expect(err.message).toMatch(words);
    expect(err.message).toMatch(/nothing was merged/);
    expect(err.message).not.toMatch(/_/); // no reason code in the copy
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  test('a failed read fails the merge (nothing has moved yet)', async () => {
    const database = jest.fn(() => ({ whereIn: () => ({ select: async () => { throw new Error('read failed'); } }) }));
    await expect(DunningMerge.releaseOpenSchedulesForMerge([WINNER, LOSER], { database })).rejects.toThrow('read failed');
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe('reconcileInMergeTransaction (first inside the merge transaction)', () => {
  const lockCalls = (log) => log.filter(([kind]) => kind === 'raw');

  test('takes both dunning keys EXCLUSIVE in sorted id order before any read or write', async () => {
    const fake = withNegateRaw(fakeDb([]));
    await DunningMerge.reconcileInMergeTransaction(fake.trx, { winnerId: WINNER, loserId: LOSER });
    const locks = lockCalls(fake.log);
    expect(locks.map(([, sql, b]) => [sql, b])).toEqual([
      ['SELECT pg_advisory_xact_lock(hashtext(?))', [`customer-dunning:${LOSER}`]],
      ['SELECT pg_advisory_xact_lock(hashtext(?))', [`customer-dunning:${WINNER}`]],
    ]);
    expect(fake.log[0][0]).toBe('raw');
    expect(fake.log[1][0]).toBe('raw');
  });

  test.each(['active', 'held', 'paused', 'autopay_hold'])('an open (%s) schedule on either side refuses: one opened since the release', async (status) => {
    for (const owner of [WINNER, LOSER]) {
      const fake = withNegateRaw(fakeDb([{ id: 's', customer_id: owner, episode: 1, status }]));
      await expect(DunningMerge.reconcileInMergeTransaction(fake.trx, { winnerId: WINNER, loserId: LOSER }))
        .rejects.toMatchObject({ statusCode: 409, code: 'DUNNING_SCHEDULE_BUSY', dunningReason: 'reopened' });
      expect(fake.log.some(([kind]) => kind === 'update')).toBe(false);
    }
  });

  test('two episode-1 histories: the loser\'s episode goes above the winner\'s', async () => {
    const fake = withNegateRaw(fakeDb([
      { id: 'w1', customer_id: WINNER, episode: 1, status: 'completed' },
      { id: 'l1', customer_id: LOSER, episode: 1, status: 'released' },
    ]));
    const out = await DunningMerge.reconcileInMergeTransaction(fake.trx, { winnerId: WINNER, loserId: LOSER });
    expect(out).toEqual([{ id: 'l1', from: 1, to: 2 }]);
    expect(fake.table.find((r) => r.id === 'l1').episode).toBe(2);
    expect(fake.table.find((r) => r.id === 'w1').episode).toBe(1);
  });

  test('renumbering never collides mid-way: every loser episode goes negative first, then each takes its place in order', async () => {
    // loser 3 and 9 above a winner max of 1: a direct 9 -> 3 would hit the unmoved 3
    const fake = withNegateRaw(fakeDb([
      { id: 'w1', customer_id: WINNER, episode: 1, status: 'completed' },
      { id: 'l9', customer_id: LOSER, episode: 9, status: 'completed' },
      { id: 'l3', customer_id: LOSER, episode: 3, status: 'released' },
    ]));
    const out = await DunningMerge.reconcileInMergeTransaction(fake.trx, { winnerId: WINNER, loserId: LOSER });
    expect(out).toEqual([{ id: 'l3', from: 3, to: 2 }, { id: 'l9', from: 9, to: 3 }]);
    const updates = fake.log.filter(([kind]) => kind === 'update');
    expect(updates[0]).toEqual(['update', 'negate', ['l9', 'l3']]);
    expect(updates.slice(1).map(([, patch, ids]) => [patch.episode, ids])).toEqual([[2, ['l3']], [3, ['l9']]]);
    // every intermediate state is unique per customer
    const loserEpisodes = fake.table.filter((r) => r.customer_id === LOSER).map((r) => r.episode);
    expect(new Set(loserEpisodes).size).toBe(loserEpisodes.length);
  });

  test('nothing to renumber when the winner has no history, or the loser none', async () => {
    for (const rows of [
      [{ id: 'l1', customer_id: LOSER, episode: 1, status: 'completed' }],
      [{ id: 'w1', customer_id: WINNER, episode: 4, status: 'completed' }],
      [],
    ]) {
      const fake = withNegateRaw(fakeDb(rows));
      await expect(DunningMerge.reconcileInMergeTransaction(fake.trx, { winnerId: WINNER, loserId: LOSER })).resolves.toEqual([]);
      expect(fake.log.some(([kind]) => kind === 'update')).toBe(false);
    }
  });

  test('a loser row that appeared between the read and the renumber refuses rather than renumbering a partial set', async () => {
    const fake = withNegateRaw(fakeDb([
      { id: 'w1', customer_id: WINNER, episode: 1, status: 'completed' },
      { id: 'l1', customer_id: LOSER, episode: 1, status: 'completed' },
    ]));
    const select = fake.database.getMockImplementation();
    let reads = 0;
    fake.database.mockImplementation((name) => {
      const q = select(name);
      const origSelect = q.select;
      q.select = async (...a) => {
        reads += 1;
        const rows = await origSelect(...a);
        fake.table.push({ id: 'l2', customer_id: LOSER, episode: 2, status: 'completed' });
        return rows;
      };
      return q;
    });
    await expect(DunningMerge.reconcileInMergeTransaction(fake.trx, { winnerId: WINNER, loserId: LOSER }))
      .rejects.toMatchObject({ dunningReason: 'schedule_changed' });
    expect(reads).toBe(1);
  });
});

describe('lockForMergeUndo (revertMerge)', () => {
  test('takes both dunning keys EXCLUSIVE in sorted id order, nothing else', async () => {
    const fake = fakeDb([]);
    await DunningMerge.lockForMergeUndo(fake.trx, { winnerId: WINNER, loserId: LOSER });
    expect(fake.log).toEqual([
      ['raw', 'SELECT pg_advisory_xact_lock(hashtext(?))', [`customer-dunning:${LOSER}`]],
      ['raw', 'SELECT pg_advisory_xact_lock(hashtext(?))', [`customer-dunning:${WINNER}`]],
    ]);
  });
});
