/**
 * collections/outbound-voice/dial-sweep.js (PR C) — pins:
 *  - GATE OFF ⇒ ZERO db reads (provable no-op, byte-identical dark), and
 *    every gate in the chain is required (autodial alone never lights it);
 *  - candidates = shadow/proposed with next_eligible_at null-or-past;
 *  - GUARDED promote (state + case_version fence) stamped
 *    'system:autodial' with a 24h expiry; a lost promote stands down;
 *  - the cap counts DIAL ATTEMPTS (dialed or dial_failed), never policy
 *    refusals — refusals must not starve a run, attempts must not exceed
 *    pilot pace;
 *  - origination is the only authorization boundary this module trusts.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/collections/outbound-voice/origination', () => ({
  originateCollectionCall: jest.fn(),
}));

const db = require('../models/db');
const { originateCollectionCall } = require('../services/collections/outbound-voice/origination');
const { runCollectionsDialSweep, DEFAULT_MAX_PER_RUN } = require('../services/collections/outbound-voice/dial-sweep');

const NOW = new Date('2026-08-12T15:30:00Z'); // Wed 11:30 ET — in window

function candidateChain(rows) {
  const q = { _wheres: [] };
  ['whereIn', 'where', 'whereRaw', 'whereNull', 'orWhere', 'orderBy', 'limit'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.select = jest.fn(async () => rows);
  return q;
}

function promoteChain(result = 1) {
  const q = {};
  ['where', 'whereNull', 'whereRaw'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.update = jest.fn(async () => result);
  return q;
}

function caseRow(id, state = 'shadow') {
  return { id, current_state: state, case_version: 1 };
}

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset, not just clear: leftover mockResolvedValueOnce queue entries
  // survive clearAllMocks and would fire FIRST in the next test.
  originateCollectionCall.mockReset();
  delete process.env.GATE_VOICE_LATE_PAYMENT;
  delete process.env.GATE_VOICE_LATE_PAYMENT_AUTODIAL;
  delete process.env.GATE_COLLECTIONS_POLICY;
  delete process.env.COLLECTIONS_AUTODIAL_MAX_PER_RUN;
  originateCollectionCall.mockResolvedValue({ dialed: true, reason: 'dialed' });
});

afterAll(() => {
  delete process.env.GATE_VOICE_LATE_PAYMENT;
  delete process.env.GATE_VOICE_LATE_PAYMENT_AUTODIAL;
  delete process.env.GATE_COLLECTIONS_POLICY;
  delete process.env.COLLECTIONS_AUTODIAL_MAX_PER_RUN;
});

function armGates() {
  process.env.GATE_VOICE_LATE_PAYMENT = 'true';
  process.env.GATE_VOICE_LATE_PAYMENT_AUTODIAL = 'true';
  process.env.GATE_COLLECTIONS_POLICY = 'true';
}

test('every gate in the chain is required — any one off ⇒ ZERO db reads', async () => {
  const combos = [
    {}, // all off
    { GATE_VOICE_LATE_PAYMENT_AUTODIAL: 'true' }, // autodial alone
    { GATE_VOICE_LATE_PAYMENT: 'true', GATE_VOICE_LATE_PAYMENT_AUTODIAL: 'true' }, // no policy gate
    { GATE_VOICE_LATE_PAYMENT: 'true', GATE_COLLECTIONS_POLICY: 'true' }, // no autodial gate
  ];
  for (const combo of combos) {
    delete process.env.GATE_VOICE_LATE_PAYMENT;
    delete process.env.GATE_VOICE_LATE_PAYMENT_AUTODIAL;
    delete process.env.GATE_COLLECTIONS_POLICY;
    Object.assign(process.env, combo);
    const res = await runCollectionsDialSweep({ now: NOW });
    expect(res).toEqual({ skipped: true, reason: 'autodial_gate_off' });
  }
  expect(db).not.toHaveBeenCalled();
  expect(originateCollectionCall).not.toHaveBeenCalled();
});

test('promotes a shadow candidate with the guarded fence and dials it', async () => {
  armGates();
  const cChain = candidateChain([caseRow('case-1')]);
  const pChain = promoteChain(1);
  const queues = [cChain, pChain];
  db.mockImplementation(() => queues.shift());
  const res = await runCollectionsDialSweep({ now: NOW });
  expect(res).toMatchObject({ skipped: false, promoted: 1, dialed: 1, refused: 0 });
  // Candidate query shape.
  expect(cChain.whereIn).toHaveBeenCalledWith('current_state', ['shadow', 'proposed']);
  // Guarded promote: state + version fence, system stamp, 24h expiry.
  expect(pChain.where).toHaveBeenCalledWith({ id: 'case-1', current_state: 'shadow', case_version: 1 });
  const patch = pChain.update.mock.calls[0][0];
  expect(patch.current_state).toBe('approved');
  expect(patch.approved_by).toBe('system:autodial');
  expect(patch.approval_expires_at.getTime() - patch.approved_at.getTime()).toBe(24 * 60 * 60 * 1000);
  expect(originateCollectionCall).toHaveBeenCalledWith('case-1', { now: NOW });
});

test('a LOST promote stands down — no dial for that case', async () => {
  armGates();
  const queues = [candidateChain([caseRow('case-1')]), promoteChain(0)];
  db.mockImplementation(() => queues.shift());
  const res = await runCollectionsDialSweep({ now: NOW });
  expect(res).toMatchObject({ promoted: 0, dialed: 0 });
  expect(originateCollectionCall).not.toHaveBeenCalled();
});

test('the cap counts dial ATTEMPTS; policy refusals pass through without consuming it', async () => {
  armGates();
  const rows = [caseRow('c1'), caseRow('c2'), caseRow('c3'), caseRow('c4')];
  const queues = [candidateChain(rows), promoteChain(1), promoteChain(1), promoteChain(1), promoteChain(1)];
  db.mockImplementation(() => queues.shift());
  originateCollectionCall
    .mockResolvedValueOnce({ dialed: false, reason: 'policy_denied' }) // refusal — no cap
    .mockResolvedValueOnce({ dialed: true, reason: 'dialed' }) // attempt 1
    .mockResolvedValueOnce({ dialed: false, reason: 'dial_failed' }) // attempt 2 (failed dial IS an attempt)
    .mockResolvedValueOnce({ dialed: true, reason: 'dialed' }); // must never run (cap 2)
  const res = await runCollectionsDialSweep({ now: NOW });
  expect(res).toMatchObject({ dialed: 2, refused: 1 });
  expect(originateCollectionCall).toHaveBeenCalledTimes(3);
});

test('COLLECTIONS_AUTODIAL_MAX_PER_RUN respects the hard ceiling and bad values fall to the default', async () => {
  armGates();
  process.env.COLLECTIONS_AUTODIAL_MAX_PER_RUN = '50'; // above ceiling
  const queues = [candidateChain([])];
  db.mockImplementation(() => queues.shift());
  const res = await runCollectionsDialSweep({ now: NOW });
  expect(res.cap).toBe(10); // hard ceiling
  process.env.COLLECTIONS_AUTODIAL_MAX_PER_RUN = 'lots';
  const queues2 = [candidateChain([])];
  db.mockImplementation(() => queues2.shift());
  const res2 = await runCollectionsDialSweep({ now: NOW });
  expect(res2.cap).toBe(DEFAULT_MAX_PER_RUN);
});

test('an unexpected originate THROW is treated as an attempt (conservative pace) and the sweep survives', async () => {
  armGates();
  const rows = [caseRow('c1'), caseRow('c2')];
  // c1: promote, (throw), revert; c2: promote — the throw path reverts too.
  const queues = [candidateChain(rows), promoteChain(1), promoteChain(1), promoteChain(1)];
  db.mockImplementation(() => queues.shift());
  originateCollectionCall
    .mockRejectedValueOnce(new Error('unexpected'))
    .mockResolvedValueOnce({ dialed: true, reason: 'dialed' });
  const res = await runCollectionsDialSweep({ now: NOW });
  expect(res).toMatchObject({ dialed: 2 }); // throw counted as an attempt
});

// codex gh-r1 pins.
describe('gh-r1', () => {
  test('a TRANSIENT pre-dial refusal reverts OUR promotion back to proposed (guarded on the autodial actor)', async () => {
    armGates();
    const revert = promoteChain(1);
    const queues = [candidateChain([caseRow('c1')]), promoteChain(1), revert];
    db.mockImplementation(() => queues.shift());
    originateCollectionCall.mockResolvedValue({ dialed: false, reason: 'relay_unavailable' });
    const res = await runCollectionsDialSweep({ now: NOW });
    expect(res).toMatchObject({ refused: 1, dialed: 0 });
    // The revert fence: still-approved, same version, OUR actor only.
    expect(revert.where).toHaveBeenCalledWith({
      id: 'c1', current_state: 'approved', case_version: 1, approved_by: 'system:autodial',
    });
    const patch = revert.update.mock.calls[0][0];
    expect(patch.current_state).toBe('proposed');
    expect(patch.approved_by).toBeNull();
  });

  test('a refusal origination already resolved (dial_failed path) never triggers the revert', async () => {
    armGates();
    const queues = [candidateChain([caseRow('c1')]), promoteChain(1)];
    db.mockImplementation(() => queues.shift());
    originateCollectionCall.mockResolvedValue({ dialed: false, reason: 'dial_failed' });
    const res = await runCollectionsDialSweep({ now: NOW });
    expect(res).toMatchObject({ dialed: 1, refused: 0 });
    // Only two db calls happened: candidates + promote — no revert query.
    expect(db).toHaveBeenCalledTimes(2);
  });
});


// codex gh-r2 pins.
describe('gh-r2', () => {
  test('already_dialed reverts to LAPSED (one call per version) — every other refusal to proposed', async () => {
    armGates();
    const revert = promoteChain(1);
    // queues: candidates, promote, revert (no idempotency_key ⇒ no card query)
    const queues = [candidateChain([caseRow('c1')]), promoteChain(1), revert];
    db.mockImplementation(() => queues.shift());
    originateCollectionCall.mockResolvedValue({ dialed: false, reason: 'already_dialed' });
    await runCollectionsDialSweep({ now: NOW });
    expect(revert.update.mock.calls[0][0].current_state).toBe('lapsed');
  });

  test('an originate THROW also reverts our promotion (guarded)', async () => {
    armGates();
    const revert = promoteChain(1);
    const queues = [candidateChain([caseRow('c1')]), promoteChain(1), revert];
    db.mockImplementation(() => queues.shift());
    originateCollectionCall.mockRejectedValue(new Error('infra blip'));
    const res = await runCollectionsDialSweep({ now: NOW });
    expect(res).toMatchObject({ dialed: 1 });
    expect(revert.where).toHaveBeenCalledWith(expect.objectContaining({ approved_by: 'system:autodial' }));
    expect(revert.update.mock.calls[0][0].current_state).toBe('proposed');
  });

  test('a held promotion retires the shadow proposal card by dedupe key', async () => {
    armGates();
    const card = promoteChain(1);
    const queues = [
      candidateChain([{ ...caseRow('c1'), idempotency_key: 'collections:cust:1:14' }]),
      promoteChain(1), card,
    ];
    db.mockImplementation(() => queues.shift());
    originateCollectionCall.mockResolvedValue({ dialed: true, reason: 'dialed' });
    await runCollectionsDialSweep({ now: NOW });
    expect(card.whereRaw).toHaveBeenCalledWith("metadata->>'dedupeKey' = ?", ['collections:cust:1:14']);
  });
});
