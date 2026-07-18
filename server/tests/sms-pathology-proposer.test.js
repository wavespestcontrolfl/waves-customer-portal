/**
 * Pathology proposer + review — threshold gating, per-run cell cap,
 * supersede-after-insert ordering, park+bell, and the pending-only review
 * transitions with in-transaction audit.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/deep', () => ({ createDeepMessage: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({})));

const { createDeepMessage } = require('../services/llm/deep');
const NotificationService = require('../services/notification-service');
const { proposePatches, reviewPatchProposal } = require('../services/sms-pathology-ledger');

function makeProposerDb({ cells = [], entries = [], priorPending = null } = {}) {
  const inserts = [];
  const updates = [];
  const kvWheres = [];
  const order = []; // interleaving record: proposal insert vs supersede update
  const dbi = (table) => {
    const tableKey = typeof table === 'object' ? Object.values(table)[0] : table;
    const b = { _tableKey: tableKey, _insert: null, _update: null, _first: false, _wheres: [] };
    const rec = (name) => (...args) => {
      if (name === 'insert') b._insert = args[0];
      if (name === 'update') b._update = args[0];
      if (name === 'first') b._first = true;
      if (name === 'where' && typeof args[0] === 'object') b._wheres.push(args[0]);
      if (name === 'where' && typeof args[0] === 'string' && args.length === 3) kvWheres.push(args);
      if (name === 'modify' && typeof args[0] === 'function') args[0](b); // run the group so inner filters record
      return b;
    };
    for (const m of ['leftJoin', 'whereRaw', 'groupBy', 'select', 'count', 'orderBy', 'where', 'limit',
      'insert', 'returning', 'update', 'first', 'max', 'as', 'modify']) b[m] = rec(m);
    b.then = (resolve, reject) => Promise.resolve().then(() => {
      if (b._insert) {
        inserts.push(b._insert);
        order.push('insert');
        return [{ id: `p-new-${inserts.length}` }];
      }
      if (b._update) {
        updates.push({ wheres: b._wheres, patch: b._update });
        order.push('update');
        return 1;
      }
      if (tableKey === 'sms_pathology_entries') {
        // cells rollup vs evidence fetch: the rollup has no object-where.
        return b._wheres.length ? entries : cells;
      }
      if (tableKey === 'sms_patch_proposals') {
        if (b._first) return priorPending;
        return [];
      }
      return [];
    }).then(resolve, reject);
    return b;
  };
  dbi.fn = { now: () => new Date() };
  dbi.raw = (sql) => sql;
  // The proposer supersedes-then-inserts inside dbi.transaction — the fake
  // reuses the same table router as the trx and counts entries so tests can
  // assert both writes happened inside one transaction.
  let transactions = 0;
  dbi.transaction = (fn) => {
    transactions += 1;
    return Promise.resolve(fn(dbi));
  };
  dbi.inserts = inserts;
  dbi.updates = updates;
  dbi.kvWheres = kvWheres;
  dbi.order = order;
  dbi.transactionCount = () => transactions;
  return dbi;
}

const entryRows = Array.from({ length: 6 }, (_, i) => ({
  id: `e${i}`, intent: 'general', prompt_version: 'house_voice_v8', verifier_missed: i % 2 === 0,
  summary: `Invented a schedule detail (case ${i}).`,
}));

beforeEach(() => {
  createDeepMessage.mockReset();
  NotificationService.notifyAdmin.mockClear();
  createDeepMessage.mockResolvedValue({ model: 'deep-test', content: [{ text: '## Pattern\nInvented windows.\n## Proposed change\nAdd dispatch state to facts.\n## Validation\nSealed exam unsafe rate.' }] });
});

describe('proposePatches — threshold + cap + ordering', () => {
  test('cells below the evidence bar produce nothing (no DEEP spend)', async () => {
    const dbi = makeProposerDb({ cells: [{ surface: 'other', failure_mode: 'other', fresh: '2' }] });
    const out = await proposePatches({ dbi, anthropicClient: {} });
    expect(out.proposed).toBe(0);
    expect(createDeepMessage).not.toHaveBeenCalled();
  });

  test('an eligible cell parks ONE pending proposal + bell; evidence ids recorded', async () => {
    const dbi = makeProposerDb({
      cells: [{ surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta', fresh: '7' }],
      entries: entryRows,
    });
    const out = await proposePatches({ dbi, anthropicClient: {} });
    expect(out.proposed).toBe(1);
    expect(dbi.inserts).toHaveLength(1);
    expect(dbi.inserts[0]).toMatchObject({
      surface: 'facts_block_gap',
      failure_mode: 'invented_schedule_eta',
      evidence_count: 7,
      status: 'pending',
    });
    expect(JSON.parse(dbi.inserts[0].evidence_ids)).toContain('e0');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][1]).toMatch(/facts_block_gap/);
  });

  test('repeat proposals fetch only evidence classified after the last proposal (fresh cohort)', async () => {
    const dbi = makeProposerDb({
      cells: [{ surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta', fresh: '6', last_proposed_at: '2026-07-11T00:00:00Z' }],
      entries: entryRows,
    });
    await proposePatches({ dbi, anthropicClient: {} });
    const cutoff = dbi.kvWheres.find(([col, op]) => col === 'classified_at' && op === '>');
    expect(cutoff).toBeTruthy();
    expect(cutoff[2]).toBe('2026-07-11T00:00:00Z');
  });

  test('at most maxCells proposals per run, highest-evidence cells first', async () => {
    const dbi = makeProposerDb({
      cells: [
        { surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta', fresh: '9' },
        { surface: 'prompt_discipline', failure_mode: 'invented_billing', fresh: '8' },
        { surface: 'verifier_miss', failure_mode: 'invented_commitment', fresh: '7' },
      ],
      entries: entryRows,
    });
    const out = await proposePatches({ dbi, anthropicClient: {}, maxCells: 2 });
    expect(out.proposed).toBe(2);
    expect(createDeepMessage).toHaveBeenCalledTimes(2);
    expect(dbi.inserts.map((i) => i.surface)).toEqual(['facts_block_gap', 'prompt_discipline']);
  });

  test('a prior pending proposal is superseded and replaced inside ONE transaction (atomic swap)', async () => {
    const dbi = makeProposerDb({
      cells: [{ surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta', fresh: '6' }],
      entries: entryRows,
    });
    await proposePatches({ dbi, anthropicClient: {} });
    expect(dbi.transactionCount()).toBe(1);
    // Supersede-then-insert (the one-pending unique index requires this
    // order); atomicity comes from the shared transaction, so a failure of
    // either write rolls back both and the old card survives.
    expect(dbi.order).toEqual(['update', 'insert']);
    expect(dbi.updates[0].wheres[0]).toMatchObject({
      surface: 'facts_block_gap',
      failure_mode: 'invented_schedule_eta',
      status: 'pending',
    });
    expect(dbi.updates[0].patch.status).toBe('superseded');
  });

  test('an empty proposer response fails that cell before any transaction — nothing inserted or superseded', async () => {
    createDeepMessage.mockResolvedValue({ content: [{ text: '' }] });
    const dbi = makeProposerDb({
      cells: [{ surface: 'facts_block_gap', failure_mode: 'invented_schedule_eta', fresh: '6' }],
      entries: entryRows,
      priorPending: { id: 'p-old' },
    });
    const out = await proposePatches({ dbi, anthropicClient: {} });
    expect(out.proposed).toBe(0);
    expect(dbi.transactionCount()).toBe(0);
    expect(dbi.inserts).toHaveLength(0);
    expect(dbi.updates).toHaveLength(0); // the old reviewable card survives
  });
});

/* Transaction-capable fake for reviewPatchProposal */
function makeReviewDb({ row } = {}) {
  const updates = [];
  const audits = [];
  const trx = (table) => {
    const b = { _update: null, _insert: null };
    const rec = (name) => (...args) => {
      if (name === 'update') b._update = args[0];
      if (name === 'insert') b._insert = args[0];
      return b;
    };
    for (const m of ['where', 'forUpdate', 'first', 'update', 'insert']) b[m] = rec(m);
    b.then = (resolve, reject) => Promise.resolve().then(() => {
      if (b._insert) {
        audits.push(b._insert);
        return [];
      }
      if (b._update) {
        updates.push(b._update);
        return 1;
      }
      return table === 'sms_patch_proposals' ? row : undefined;
    }).then(resolve, reject);
    return b;
  };
  trx.fn = { now: () => new Date() };
  const dbi = { transaction: (fn) => Promise.resolve(fn(trx)) };
  dbi.updates = updates;
  dbi.audits = audits;
  return dbi;
}

describe('reviewPatchProposal — pending-only transitions with audit', () => {
  test('accept flips pending → accepted and writes the audit row in the same transaction', async () => {
    const dbi = makeReviewDb({ row: { id: 'p1', status: 'pending', surface: 's', failure_mode: 'f' } });
    const out = await reviewPatchProposal({ id: 'p1', action: 'accept', reviewedBy: 'Adam', adminUserId: 'a1', dbi });
    expect(out).toMatchObject({ ok: true, status: 'accepted' });
    expect(dbi.updates[0].status).toBe('accepted');
    expect(dbi.audits).toHaveLength(1);
    expect(dbi.audits[0].action).toBe('sms_patch_proposal_reviewed');
  });

  test('dismiss flips pending → dismissed', async () => {
    const dbi = makeReviewDb({ row: { id: 'p1', status: 'pending', surface: 's', failure_mode: 'f' } });
    const out = await reviewPatchProposal({ id: 'p1', action: 'dismiss', dbi });
    expect(out).toMatchObject({ ok: true, status: 'dismissed' });
  });

  test('non-pending rows 409; unknown action 400; missing row 404', async () => {
    const done = makeReviewDb({ row: { id: 'p1', status: 'accepted', surface: 's', failure_mode: 'f' } });
    await expect(reviewPatchProposal({ id: 'p1', action: 'accept', dbi: done })).resolves.toMatchObject({ ok: false, status: 409 });
    const missing = makeReviewDb({ row: undefined });
    await expect(reviewPatchProposal({ id: 'nope', action: 'accept', dbi: missing })).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(reviewPatchProposal({ id: 'p1', action: 'explode', dbi: missing })).resolves.toMatchObject({ ok: false, status: 400 });
  });
});
