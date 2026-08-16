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
  ['whereIn', 'where', 'whereRaw', 'whereNotExists', 'whereNull', 'orWhere', 'orderBy', 'limit'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.select = jest.fn(async () => rows);
  return q;
}

function promoteChain(result = 1, { first } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNot', 'whereNull', 'whereRaw'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.update = jest.fn(async () => result);
  return q;
}

// The case lock runs inside db.transaction; the trx dispatches to the same
// table queues and its raw() is the advisory-lock call.
function armTransaction() {
  db.transaction = jest.fn(async (fn) => {
    const trx = (t) => db(t);
    trx.raw = jest.fn(async () => ({}));
    trx.fn = db.fn;
    return fn(trx);
  });
}

function caseRow(id, state = 'shadow') {
  return { id, customer_id: 'cust-1', current_state: state, case_version: 1 };
}

// In-lock owner re-read chain (gh-r8): returns the matching owner.
function ownerChain() {
  return promoteChain(0, { first: { customer_id: 'cust-1' } });
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
  armTransaction();
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
  const queues = [promoteChain(0), /* reclaim */ cChain, ownerChain(), promoteChain(0, {}), pChain]; // live-check then promote
  db.mockImplementation(() => queues.shift());
  const res = await runCollectionsDialSweep({ now: NOW });
  expect(res).toMatchObject({ skipped: false, promoted: 1, dialed: 1, refused: 0 });
  // Candidate query shape.
  expect(cChain.whereIn).toHaveBeenCalledWith('current_state', ['shadow', 'proposed']);
  // Guarded promote: state + version fence, system stamp, 24h expiry.
  expect(pChain.where).toHaveBeenCalledWith({ id: 'case-1', customer_id: 'cust-1', current_state: 'shadow', case_version: 1 });
  const patch = pChain.update.mock.calls[0][0];
  expect(patch.current_state).toBe('approved');
  expect(patch.approved_by).toBe('system:autodial');
  expect(patch.approval_expires_at.getTime() - patch.approved_at.getTime()).toBe(24 * 60 * 60 * 1000);
  expect(originateCollectionCall).toHaveBeenCalledWith('case-1', { now: NOW });
});

test('a LOST promote stands down — no dial for that case', async () => {
  armGates();
  const queues = [promoteChain(0), /* reclaim */ candidateChain([caseRow('case-1')]), ownerChain(), promoteChain(0, {}), promoteChain(0)];
  db.mockImplementation(() => queues.shift());
  const res = await runCollectionsDialSweep({ now: NOW });
  expect(res).toMatchObject({ promoted: 0, dialed: 0 });
  expect(originateCollectionCall).not.toHaveBeenCalled();
});

test('the cap counts dial ATTEMPTS; policy refusals pass through without consuming it', async () => {
  armGates();
  const rows = [caseRow('c1'), caseRow('c2'), caseRow('c3'), caseRow('c4')];
  // per candidate: in-lock live-check + promote; the refusal adds a revert.
  const queues = [
    promoteChain(0), // reclaim
    candidateChain(rows),
    ownerChain(), promoteChain(0, {}), promoteChain(1), promoteChain(1), // c1: live, promote, revert
    ownerChain(), promoteChain(0, {}), promoteChain(1), // c2: live, promote
    ownerChain(), promoteChain(0, {}), promoteChain(1), // c3: live, promote
  ];
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
  const queues = [promoteChain(0), /* reclaim */ candidateChain([])];
  db.mockImplementation(() => queues.shift());
  const res = await runCollectionsDialSweep({ now: NOW });
  expect(res.cap).toBe(10); // hard ceiling
  process.env.COLLECTIONS_AUTODIAL_MAX_PER_RUN = 'lots';
  const queues2 = [promoteChain(0), candidateChain([])];
  db.mockImplementation(() => queues2.shift());
  const res2 = await runCollectionsDialSweep({ now: NOW });
  expect(res2.cap).toBe(DEFAULT_MAX_PER_RUN);
});

test('an unexpected originate THROW is treated as an attempt (conservative pace) and the sweep survives', async () => {
  armGates();
  const rows = [caseRow('c1'), caseRow('c2')];
  // c1: promote, (throw), revert; c2: promote — the throw path reverts too.
  const queues = [promoteChain(0), /* reclaim */ candidateChain(rows), ownerChain(), promoteChain(0,{}), promoteChain(1), promoteChain(1), ownerChain(), promoteChain(0,{}), promoteChain(1)];
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
    const queues = [promoteChain(0), /* reclaim */ candidateChain([caseRow('c1')]), ownerChain(), promoteChain(0,{}), promoteChain(1), revert];
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
    const queues = [promoteChain(0), /* reclaim */ candidateChain([caseRow('c1')]), ownerChain(), promoteChain(0, {}), promoteChain(1)];
    db.mockImplementation(() => queues.shift());
    originateCollectionCall.mockResolvedValue({ dialed: false, reason: 'dial_failed' });
    const res = await runCollectionsDialSweep({ now: NOW });
    expect(res).toMatchObject({ dialed: 1, refused: 0 });
    // db calls: candidates + in-lock live-check + promote — no revert query.
    expect(db).toHaveBeenCalledTimes(5); // reclaim + candidates + owner + live-check + promote
  });
});


// codex gh-r2 pins.
describe('gh-r2', () => {
  test('already_dialed reverts to LAPSED (one call per version) — every other refusal to proposed', async () => {
    armGates();
    const revert = promoteChain(1);
    // queues: candidates, promote, revert (no idempotency_key ⇒ no card query)
    const queues = [promoteChain(0), /* reclaim */ candidateChain([caseRow('c1')]), ownerChain(), promoteChain(0,{}), promoteChain(1), revert];
    db.mockImplementation(() => queues.shift());
    originateCollectionCall.mockResolvedValue({ dialed: false, reason: 'already_dialed' });
    await runCollectionsDialSweep({ now: NOW });
    expect(revert.update.mock.calls[0][0].current_state).toBe('lapsed');
  });

  test('an originate THROW also reverts our promotion (guarded)', async () => {
    armGates();
    const revert = promoteChain(1);
    const queues = [promoteChain(0), /* reclaim */ candidateChain([caseRow('c1')]), ownerChain(), promoteChain(0,{}), promoteChain(1), revert];
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
      promoteChain(0), // reclaim
      candidateChain([{ ...caseRow('c1'), idempotency_key: 'collections:cust:1:14' }]),
      ownerChain(), promoteChain(0, {}), promoteChain(1), card,
    ];
    db.mockImplementation(() => queues.shift());
    originateCollectionCall.mockResolvedValue({ dialed: true, reason: 'dialed' });
    await runCollectionsDialSweep({ now: NOW });
    expect(card.whereRaw).toHaveBeenCalledWith("metadata->>'dedupeKey' = ?", ['collections:cust:1:14']);
  });
});

// codex gh-r6 pins.
describe('gh-r6', () => {
  test('expired orphaned approvals are reclaimed to proposed at the top of the run', async () => {
    armGates();
    const reclaim = promoteChain(2); // two orphans reclaimed
    const queues = [reclaim, candidateChain([])];
    db.mockImplementation(() => queues.shift());
    const res = await runCollectionsDialSweep({ now: NOW });
    expect(res.reclaimed).toBe(2);
    expect(reclaim.where).toHaveBeenCalledWith({ current_state: 'approved' });
    expect(reclaim.where).toHaveBeenCalledWith('approval_expires_at', '<', NOW);
    const patch = reclaim.update.mock.calls[0][0];
    expect(patch.current_state).toBe('proposed');
    expect(patch.approved_by).toBeNull();
  });

  test('a failed reclamation never blocks the run', async () => {
    armGates();
    const reclaim = promoteChain(0);
    reclaim.update = jest.fn(async () => { throw new Error('db blip'); });
    const queues = [reclaim, candidateChain([])];
    db.mockImplementation(() => queues.shift());
    const res = await runCollectionsDialSweep({ now: NOW });
    expect(res.skipped).toBe(false);
    expect(res.reclaimed).toBe(0);
  });
});

// codex gh-r7 pins.
describe('gh-r7', () => {
  test('the candidate query excludes customers with a live/held sibling case (no window starvation)', async () => {
    armGates();
    const cChain = candidateChain([]);
    const queues = [promoteChain(0), cChain];
    db.mockImplementation(() => queues.shift());
    await runCollectionsDialSweep({ now: NOW });
    expect(cChain.whereNotExists).toHaveBeenCalled();
  });

  test('flipping the autodial gate MID-RUN stops before the next promotion', async () => {
    armGates();
    const rows = [caseRow('c1'), caseRow('c2')];
    const queues = [promoteChain(0), candidateChain(rows), ownerChain(), promoteChain(0, {}), promoteChain(1)];
    db.mockImplementation(() => queues.shift());
    originateCollectionCall.mockImplementation(async () => {
      delete process.env.GATE_VOICE_LATE_PAYMENT_AUTODIAL; // incident flip during c1's dial
      return { dialed: true, reason: 'dialed' };
    });
    const res = await runCollectionsDialSweep({ now: NOW });
    expect(res.dialed).toBe(1);
    expect(originateCollectionCall).toHaveBeenCalledTimes(1); // c2 never promoted
  });

  test('source shape: the merge takes the case locks and reconciles surplus approvals; the scheduler runs maintenance reclamation while autodial is dark', () => {
    const fs = require('fs');
    const dedupe = fs.readFileSync(require.resolve('../services/customer-dedupe'), 'utf8');
    expect(dedupe).toContain("['collections_case', custId]");
    expect(dedupe).toContain("hold_reason: 'merge_reconciled'");
    const sched = fs.readFileSync(require.resolve('../services/scheduler'), 'utf8');
    expect(sched).toContain('DialSweep.reclaimExpiredApprovals()');
    expect(sched).toContain('if (!isVoiceLatePaymentEnabled()) return; // fully dark — zero touches');
  });
});

// codex gh-r9 pins.
describe('gh-r9', () => {
  test('reclamation returns orphans to a SUPERVISED-ONLY park', async () => {
    armGates();
    const reclaim = promoteChain(1);
    const queues = [reclaim, candidateChain([])];
    db.mockImplementation(() => queues.shift());
    await runCollectionsDialSweep({ now: NOW });
    expect(reclaim.update.mock.calls[0][0].hold_reason).toBe('reclaimed_orphaned_approval');
  });

  test('the candidate query excludes supervised-park markers row-local AND via siblings', async () => {
    armGates();
    const cChain = candidateChain([]);
    const queues = [promoteChain(0), cChain];
    db.mockImplementation(() => queues.shift());
    await runCollectionsDialSweep({ now: NOW });
    const raws = cChain.whereRaw.mock.calls.map((c) => c[0]).join(' ');
    expect(raws).toContain("NOT IN ('dial_failed', 'reclaimed_orphaned_approval')");
    expect(cChain.whereNotExists).toHaveBeenCalled();
  });
});

describe('gh-r10', () => {
  test('the IN-LOCK sibling fence blocks live states AND supervised-park hold_reasons', async () => {
    armGates();
    const liveCheck = promoteChain(0, { first: { id: 'sib-parked' } });
    const queues = [promoteChain(0), /* reclaim */ candidateChain([caseRow('c1')]), ownerChain(), liveCheck];
    db.mockImplementation(() => queues.shift());
    const res = await runCollectionsDialSweep({ now: NOW });
    // A sibling parked dial_failed AFTER the candidate snapshot: stand down.
    expect(res).toMatchObject({ promoted: 0, dialed: 0 });
    expect(originateCollectionCall).not.toHaveBeenCalled();
    // Predicate shape: (live state) OR (supervised-park marker).
    const blocked = liveCheck.where.mock.calls.map((c) => c[0]).find((a) => typeof a === 'function');
    expect(blocked).toBeDefined();
    const rec = { whereIn: jest.fn(() => rec), orWhereIn: jest.fn(() => rec) };
    blocked.call(rec);
    expect(rec.whereIn).toHaveBeenCalledWith('current_state', ['approved', 'dialing', 'held']);
    expect(rec.orWhereIn).toHaveBeenCalledWith('hold_reason', ['dial_failed', 'reclaimed_orphaned_approval']);
  });
});
