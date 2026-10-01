// Customer merge reconciliation for customer_dunning_schedules (customer-dunning/merge.js,
// Codex #5503 r2 P1): a merge of two customers that both have schedule rows used to fail on
// UNIQUE (customer_id, episode) / the one-open-schedule index. Before its transaction the merge
// reads each open schedule's version and delivery evidence and refuses (for BOTH customers, writing
// nothing) what a release would refuse; inside its transaction it takes both dunning keys, releases
// each open schedule ON THAT TRANSACTION against the version it read (so a merge refused later rolls
// the release back: Codex local review P2), refuses a schedule that opened meanwhile and renumbers
// the loser's episodes above the winner's. The real transaction is proven in
// customer-dunning-merge-postgres.test.js; this suite pins the decisions.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockSchedule = {
  claimIsFresh: jest.fn(() => false),
  rowSnapshot: jest.fn(),
  currentStepDelivery: jest.fn(async () => null),
  activeMemberRows: jest.fn(async () => []),
  closeUnderLock: jest.fn(),
  alertPastFinal: jest.fn(async () => {}),
};
jest.mock('../services/customer-dunning/schedule', () => mockSchedule);

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

// Steps 2a and 2b back to back (executeMerge takes its own locks between them).
const reconcile = async (trx, opts) => DunningMerge.releaseInMergeTransaction(
  trx, await DunningMerge.lockInMergeTransaction(trx, opts), { now: opts.now },
);

beforeEach(() => {
  jest.clearAllMocks();
  mockSchedule.claimIsFresh.mockImplementation(() => false);
  mockSchedule.rowSnapshot.mockImplementation(async (_db, id) => ({ step_index: 3, episode: 1, row_version: `v-${id}` }));
  mockSchedule.currentStepDelivery.mockImplementation(async () => null);
  mockSchedule.activeMemberRows.mockImplementation(async () => []);
  mockSchedule.closeUnderLock.mockImplementation(async () => ({ closed: true, landed: [] }));
});

describe('prepareMergeRelease (before the merge transaction: reads, refuses, never writes)', () => {
  test('nothing open on either side: reads once, prepares nothing', async () => {
    const fake = fakeDb([
      { id: 's1', customer_id: WINNER, episode: 1, status: 'completed' },
      { id: 's2', customer_id: LOSER, episode: 1, status: 'released' },
    ]);
    await expect(DunningMerge.prepareMergeRelease([WINNER, LOSER], { database: fake.database })).resolves.toEqual([]);
    expect(mockSchedule.rowSnapshot).not.toHaveBeenCalled();
    expect(fake.log).toEqual([['select']]);
  });

  test('every open schedule of either party: its row version and the current step\'s evidence, read against that version; no write, no release', async () => {
    const now = new Date('2026-10-01T15:00:00Z');
    const fake = fakeDb([
      { id: 's-w', customer_id: WINNER, episode: 2, status: 'paused', step_index: 1 },
      { id: 's-l', customer_id: LOSER, episode: 1, status: 'active', step_index: 1 },
      { id: 's-old', customer_id: LOSER, episode: 0, status: 'completed' },
      { id: 's-other', customer_id: 'someone-else', episode: 1, status: 'active' },
    ]);
    const evidence = { delivered: true, unconfirmed: false, final: false, named: new Set() };
    mockSchedule.currentStepDelivery.mockResolvedValueOnce(null).mockResolvedValueOnce(evidence);
    const out = await DunningMerge.prepareMergeRelease([WINNER, LOSER], { now, database: fake.database });
    expect(out.map((p) => [p.schedule.id, p.at.row_version, p.delivery])).toEqual([
      ['s-w', 'v-s-w', null],
      ['s-l', 'v-s-l', evidence],
    ]);
    // the evidence is read at the step the version snapshot saw, not the stale list read
    expect(mockSchedule.currentStepDelivery.mock.calls.map(([sch]) => [sch.id, sch.step_index])).toEqual([['s-w', 3], ['s-l', 3]]);
    expect(fake.log.some(([kind]) => kind === 'update')).toBe(false);
    expect(mockSchedule.closeUnderLock).not.toHaveBeenCalled();
  });

  test('a schedule closed by another writer since the list read is skipped (the transaction re-checks)', async () => {
    const fake = fakeDb([{ id: 's-l', customer_id: LOSER, episode: 1, status: 'held' }]);
    mockSchedule.rowSnapshot.mockResolvedValueOnce(undefined);
    await expect(DunningMerge.prepareMergeRelease([WINNER, LOSER], { database: fake.database })).resolves.toEqual([]);
  });

  test.each([
    ['in_flight', /sending to one of these customers right now/, () => { mockSchedule.claimIsFresh.mockImplementation((s) => s.id === 's-b'); }],
    ['evidence_unreadable', /could not be read/, () => {
      mockSchedule.currentStepDelivery.mockImplementation(async (s) => { if (s.id === 's-b') throw new Error('ledger down'); return null; });
    }],
    ['outcome_unconfirmed', /still unconfirmed/, () => {
      mockSchedule.currentStepDelivery.mockImplementation(async (s) => (s.id === 's-b' ? { unconfirmed: true, delivered: false } : null));
      mockSchedule.activeMemberRows.mockResolvedValue([{ id: 'm' }]);
    }],
  ])('either customer\'s schedule a release would refuse (%s): a 409 in plain words before ANY release, nothing written', async (reason, words, arrange) => {
    // s-a (loser) is releasable; s-b (winner) is not: the merge stops before releasing either
    const fake = fakeDb([
      { id: 's-a', customer_id: LOSER, episode: 1, status: 'paused' },
      { id: 's-b', customer_id: WINNER, episode: 1, status: 'active' },
    ]);
    arrange();
    const err = await DunningMerge.prepareMergeRelease([WINNER, LOSER], { database: fake.database }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ statusCode: 409, code: 'DUNNING_SCHEDULE_BUSY', dunningReason: reason });
    expect(err.message).toMatch(words);
    expect(err.message).toMatch(/nothing was merged/);
    expect(err.message).not.toMatch(/_/); // no reason code in the copy
    expect(mockSchedule.closeUnderLock).not.toHaveBeenCalled();
    expect(fake.log.some(([kind]) => kind === 'update')).toBe(false);
  });

  test('an unconfirmed outcome with no member left to land is releasable (the release itself allows it)', async () => {
    const fake = fakeDb([{ id: 's-a', customer_id: LOSER, episode: 1, status: 'active' }]);
    mockSchedule.currentStepDelivery.mockResolvedValue({ unconfirmed: true, delivered: false });
    await expect(DunningMerge.prepareMergeRelease([WINNER, LOSER], { database: fake.database })).resolves.toHaveLength(1);
    expect(mockSchedule.activeMemberRows).toHaveBeenCalledWith(LOSER, { database: fake.database });
  });

  test('a failed read fails the merge (nothing has moved yet)', async () => {
    const database = jest.fn(() => ({ whereIn: () => ({ select: async () => { throw new Error('read failed'); } }) }));
    await expect(DunningMerge.prepareMergeRelease([WINNER, LOSER], { database })).rejects.toThrow('read failed');
    expect(mockSchedule.rowSnapshot).not.toHaveBeenCalled();
  });
});

describe('lockInMergeTransaction + releaseInMergeTransaction: the releases run on the merge\'s own transaction', () => {
  const prep = (row) => ({ schedule: row, at: { row_version: `v-${row.id}` }, delivery: { tag: row.id } });

  test('each open schedule is closed on THE MERGE\'S trx (released_merge) against the version prepared, after both keys', async () => {
    const now = new Date('2026-10-01T15:00:00Z');
    const rows = [
      { id: 's-w', customer_id: WINNER, episode: 2, status: 'paused' },
      { id: 's-l', customer_id: LOSER, episode: 1, status: 'active' },
    ];
    const fake = withNegateRaw(fakeDb(rows));
    mockSchedule.closeUnderLock.mockImplementation(async (_trx, schedule) => ({ closed: true, landed: schedule.id === 's-l' ? [{ rowId: 'm1' }] : [] }));
    const prepared = rows.map(prep);
    const out = await reconcile(fake.trx, { winnerId: WINNER, loserId: LOSER, prepared, now });
    expect(mockSchedule.closeUnderLock.mock.calls.map(([trx, s, reason, at, version, delivery]) => [trx, s.id, reason, at, version.row_version, delivery.tag]))
      .toEqual([
        [fake.trx, 's-w', 'released_merge', now, 'v-s-w', 's-w'],
        [fake.trx, 's-l', 'released_merge', now, 'v-s-l', 's-l'],
      ]);
    expect(out.released).toEqual([{ schedule: prepared[0].schedule, landed: [] }, { schedule: prepared[1].schedule, landed: [{ rowId: 'm1' }] }]);
    // the keys came first
    expect(fake.log.slice(0, 2).map(([kind]) => kind)).toEqual(['raw', 'raw']);
    // the released loser schedule is renumbered above the winner's episode 2
    expect(out.renumbers).toEqual([{ id: 's-l', from: 1, to: 3 }]);
  });

  test.each([
    ['changed', { closed: false, landed: [], changed: true }, 'schedule_changed'],
    ['in flight', { closed: false, landed: [], reason: 'in_flight' }, 'in_flight'],
    ['unconfirmed', { closed: false, landed: [], reason: 'outcome_unconfirmed' }, 'outcome_unconfirmed'],
    ['gone', { closed: false, landed: [] }, 'schedule_changed'],
  ])('a release refused under the keys (%s) throws a 409: the merge transaction rolls back every release with it', async (_label, refusal, reason) => {
    const rows = [
      { id: 's-l', customer_id: LOSER, episode: 1, status: 'active' },
      { id: 's-w', customer_id: WINNER, episode: 1, status: 'active' },
    ];
    const fake = withNegateRaw(fakeDb(rows));
    mockSchedule.closeUnderLock.mockResolvedValueOnce({ closed: true, landed: [] }).mockResolvedValueOnce(refusal);
    await expect(reconcile(fake.trx, { winnerId: WINNER, loserId: LOSER, prepared: rows.map(prep) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'DUNNING_SCHEDULE_BUSY', dunningReason: reason });
    expect(fake.log.some(([kind]) => kind === 'update')).toBe(false); // no renumber either
  });

  // Pre-push audit P1: member sequences locked before their invoices could deadlock with an invoice edit
  // (invoice row, then rescheduleForInvoiceEdit's sequence write). Step 2a writes and row-locks nothing;
  // step 2b locks every member invoice of BOTH customers in one id-ordered statement before any close.
  test('2a takes the keys and reads, nothing else; 2b locks both customers\' member invoices (one id-ordered statement) before any close', async () => {
    const rows = [
      { id: 's-w', customer_id: WINNER, episode: 2, status: 'paused' },
      { id: 's-l', customer_id: LOSER, episode: 1, status: 'active' },
    ];
    const fake = withNegateRaw(fakeDb(rows));
    const order = [];
    const base = fake.database.getMockImplementation();
    fake.database.mockImplementation((name) => {
      if (name !== 'invoices') return base(name);
      const q = {
        whereIn: (col, ids) => { order.push(['lock invoices', ids]); return q; },
        orderBy: (col) => { order.push(['orderBy', col]); return q; },
        forUpdate: () => { order.push(['forUpdate']); return q; },
        select: async () => [],
      };
      return q;
    });
    mockSchedule.activeMemberRows.mockImplementation(async (id) => (id === WINNER
      ? [{ invoice_id: 'inv-9' }, { invoice_id: 'inv-2' }] : [{ invoice_id: 'inv-5' }]));
    mockSchedule.closeUnderLock.mockImplementation(async (_t, schedule) => { order.push(['close', schedule.id]); return { closed: true, landed: [] }; });
    const plan = await DunningMerge.lockInMergeTransaction(fake.trx, { winnerId: WINNER, loserId: LOSER, prepared: rows.map(prep) });
    expect(fake.log.map(([kind]) => kind)).toEqual(['raw', 'raw', 'select']);
    expect(order).toEqual([]);
    expect(mockSchedule.activeMemberRows).not.toHaveBeenCalled();
    await DunningMerge.releaseInMergeTransaction(fake.trx, plan, {});
    expect(order).toEqual([
      ['lock invoices', ['inv-2', 'inv-5', 'inv-9']], ['orderBy', 'id'], ['forUpdate'],
      ['close', 's-w'], ['close', 's-l'],
    ]);
  });

  test('nothing open: 2b locks no invoice and reads no member', async () => {
    const fake = withNegateRaw(fakeDb([{ id: 'w1', customer_id: WINNER, episode: 1, status: 'completed' }]));
    const plan = await DunningMerge.lockInMergeTransaction(fake.trx, { winnerId: WINNER, loserId: LOSER });
    await expect(DunningMerge.releaseInMergeTransaction(fake.trx, plan)).resolves.toEqual({ renumbers: [], released: [] });
    expect(mockSchedule.activeMemberRows).not.toHaveBeenCalled();
  });

  test('afterMergeCommit: the past-final alert per released schedule, post-commit; a failing alert never throws', async () => {
    const released = [{ schedule: { id: 's-1', customer_id: LOSER }, landed: [{ pausedPastFinal: true }] }, { schedule: { id: 's-2', customer_id: WINNER }, landed: [] }];
    mockSchedule.alertPastFinal.mockRejectedValueOnce(new Error('alerts down'));
    await expect(DunningMerge.afterMergeCommit(released)).resolves.toBeUndefined();
    expect(mockSchedule.alertPastFinal.mock.calls).toEqual([[released[0].schedule, released[0].landed], [released[1].schedule, released[1].landed]]);
    await expect(DunningMerge.afterMergeCommit([])).resolves.toBeUndefined();
  });
});

describe('lockInMergeTransaction / releaseInMergeTransaction: keys and episodes', () => {
  const lockCalls = (log) => log.filter(([kind]) => kind === 'raw');

  test('takes both dunning keys EXCLUSIVE in sorted id order before any read or write', async () => {
    const fake = withNegateRaw(fakeDb([]));
    await reconcile(fake.trx, { winnerId: WINNER, loserId: LOSER });
    const locks = lockCalls(fake.log);
    expect(locks.map(([, sql, b]) => [sql, b])).toEqual([
      ['SELECT pg_advisory_xact_lock(hashtext(?))', [`customer-dunning:${LOSER}`]],
      ['SELECT pg_advisory_xact_lock(hashtext(?))', [`customer-dunning:${WINNER}`]],
    ]);
    expect(fake.log[0][0]).toBe('raw');
    expect(fake.log[1][0]).toBe('raw');
  });

  test.each(['active', 'held', 'paused', 'autopay_hold'])('an open (%s) schedule on either side that step 1 did not prepare refuses: one opened since', async (status) => {
    for (const owner of [WINNER, LOSER]) {
      const fake = withNegateRaw(fakeDb([{ id: 's', customer_id: owner, episode: 1, status }]));
      await expect(reconcile(fake.trx, { winnerId: WINNER, loserId: LOSER }))
        .rejects.toMatchObject({ statusCode: 409, code: 'DUNNING_SCHEDULE_BUSY', dunningReason: 'reopened' });
      expect(fake.log.some(([kind]) => kind === 'update')).toBe(false);
      expect(mockSchedule.closeUnderLock).not.toHaveBeenCalled();
    }
  });

  test('two episode-1 histories: the loser\'s episode goes above the winner\'s', async () => {
    const fake = withNegateRaw(fakeDb([
      { id: 'w1', customer_id: WINNER, episode: 1, status: 'completed' },
      { id: 'l1', customer_id: LOSER, episode: 1, status: 'released' },
    ]));
    const { renumbers: out, released } = await reconcile(fake.trx, { winnerId: WINNER, loserId: LOSER });
    expect(out).toEqual([{ id: 'l1', from: 1, to: 2 }]);
    expect(released).toEqual([]);
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
    const { renumbers: out } = await reconcile(fake.trx, { winnerId: WINNER, loserId: LOSER });
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
      await expect(reconcile(fake.trx, { winnerId: WINNER, loserId: LOSER })).resolves.toEqual({ renumbers: [], released: [] });
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
    await expect(reconcile(fake.trx, { winnerId: WINNER, loserId: LOSER }))
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
