/**
 * Codex P1 (2026-09-27), event-curation.js: "Revalidate rows before rescore
 * auto-approval". applyRescore's approval branch used to write
 * admin_status='approved' whenever decision.approve was true — purely
 * deterministic score math with no re-check that the row is STILL eligible
 * under current rules. This isolates the actual DB write path (mocked —
 * no live Postgres in this environment) to prove the `canApprove` gate
 * (computed by runScoreRescore from the SAME eligibility pipeline fresh
 * curation uses) is what the write obeys, not decision.approve alone.
 *
 * Codex P1 (2026-09-27, second pass), event-curation.js:578 "Guard rescore
 * approval against concurrent content changes": hasContentChangedSinceCuration
 * only catches drift present in the batch's OWN fetch-time snapshot, not a
 * write that lands DURING the batch (between the initial SELECT and this
 * row's own approval UPDATE). The tests below prove the approval UPDATE's
 * WHERE is now optimistic — pinned to the exact `updated_at`/`curated_at`
 * the decision was computed from — so a concurrent write that changes either
 * makes it match 0 rows instead of approving from stale math.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { applyRescore, revalidateStaleRescoreCandidate } = require('../services/event-curation');

function wireDb({ approveRows = 1, rescoreRows = 1 } = {}) {
  const calls = [];
  const whereRawCalls = [];
  db.fn = { now: jest.fn(() => 'NOW()') };
  const chain = {
    where: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    whereNot: jest.fn(() => chain),
    whereNotIn: jest.fn(() => chain),
    whereRaw: jest.fn((sql, bindings) => { whereRawCalls.push({ sql, bindings }); return chain; }),
    update: jest.fn((patch) => {
      calls.push(patch);
      const isApprovalWrite = patch.admin_status === 'approved';
      return Promise.resolve(isApprovalWrite ? approveRows : rescoreRows);
    }),
  };
  db.mockImplementation(() => chain);
  return { calls, whereRawCalls };
}

beforeEach(() => jest.clearAllMocks());

describe('applyRescore write path obeys canApprove, not decision.approve alone', () => {
  const APPROVING_DECISION = {
    approve: true,
    score: 90,
    breakdown: { final: 90 },
    rejectionCodes: [],
    editorialReason: 'Great event',
  };
  const row = {
    id: 'row-1',
    updated_at: new Date('2026-09-27T09:00:00.000Z'),
    curated_at: new Date('2026-09-27T06:15:00.000Z'),
  };

  test('canApprove: false (current-eligibility check failed) never writes admin_status=approved, even though decision.approve is true', async () => {
    const { calls } = wireDb();
    const outcome = await applyRescore(row, APPROVING_DECISION, { canApprove: false });
    expect(outcome).toBe('rescored');
    expect(calls).toHaveLength(1);
    expect(calls[0].admin_status).toBeUndefined();
    expect(calls[0].approved_via).toBeUndefined();
    // Score/notes still recompute even when approval is refused — the Event
    // Inbox must never show a score frozen from a retired penalty rule.
    expect(calls[0].editorial_score).toBe(90);
  });

  test('canApprove: true (default from decision.approve when the caller passes nothing) writes admin_status=approved', async () => {
    const { calls } = wireDb();
    const outcome = await applyRescore(row, APPROVING_DECISION);
    expect(outcome).toBe('approved');
    expect(calls).toHaveLength(1);
    expect(calls[0].admin_status).toBe('approved');
    expect(calls[0].approved_via).toBe('auto_curation');
  });

  test('both write paths keep the stored content fingerprint, so the next pass still compares against what the model assessed', async () => {
    const { calls } = wireDb();
    const fingerprinted = { ...row, score_breakdown: JSON.stringify({ factors: {}, content_fingerprint: 'abc123' }) };
    await applyRescore(fingerprinted, APPROVING_DECISION, { canApprove: true });
    await applyRescore(fingerprinted, APPROVING_DECISION, { canApprove: false });
    for (const patch of calls) {
      expect(JSON.parse(patch.score_breakdown).content_fingerprint).toBe('abc123');
      expect(patch.updated_at).toBeUndefined();
    }
  });

  test('a rejected-policy decision (approve: false) never approves regardless of canApprove', async () => {
    const { calls } = wireDb();
    const rejected = { ...APPROVING_DECISION, approve: false, rejectionCodes: ['retail_promotion'] };
    const outcome = await applyRescore(row, rejected, { canApprove: false });
    expect(outcome).toBe('rescored');
    expect(calls[0].admin_status).toBeUndefined();
  });

  test('the approval UPDATE pins its WHERE to the row\'s own updated_at and curated_at via a millisecond-truncated comparison', async () => {
    const { whereRawCalls } = wireDb();
    await applyRescore(row, APPROVING_DECISION, { canApprove: true });
    expect(whereRawCalls).toHaveLength(2);
    const updatedAtClause = whereRawCalls.find((c) => c.bindings[0] === row.updated_at);
    const curatedAtClause = whereRawCalls.find((c) => c.bindings[0] === row.curated_at);
    expect(updatedAtClause).toBeTruthy();
    expect(curatedAtClause).toBeTruthy();
    // Not a plain `=` — node-postgres reads timestamptz back as a
    // millisecond-precision JS Date while the column itself is microsecond
    // precision, so a bare equality would never match even the SAME row.
    expect(updatedAtClause.sql).toMatch(/date_trunc\('milliseconds',\s*updated_at\)\s*=\s*\?/);
    expect(curatedAtClause.sql).toMatch(/date_trunc\('milliseconds',\s*curated_at\)\s*=\s*\?/);
  });

  test('the fallback score write is version-pinned too, and a mismatch leaves the row untouched', async () => {
    const { whereRawCalls } = wireDb({ approveRows: 0, rescoreRows: 0 });
    const outcome = await applyRescore(row, APPROVING_DECISION, { canApprove: true });
    expect(outcome).toBe('skipped');
    // Two pinned writes attempted (approval, then the plain rescore), each
    // carrying both version predicates.
    expect(whereRawCalls).toHaveLength(4);
    expect(whereRawCalls.filter((c) => c.bindings[0] === row.updated_at)).toHaveLength(2);
    expect(whereRawCalls.filter((c) => c.bindings[0] === row.curated_at)).toHaveLength(2);
  });

  test('a concurrent write between fetch and this UPDATE (WHERE matches 0 rows) never approves — the row is left "raced", not approved', async () => {
    const { calls } = wireDb({ approveRows: 0 });
    const outcome = await applyRescore(row, APPROVING_DECISION, { canApprove: true });
    // The version-pinned approval UPDATE is attempted (its SQL is sent) but
    // — simulating a concurrent write that moved updated_at/curated_at off
    // this row's snapshot — matches 0 rows, so applyRescore falls through to
    // the plain (non-approving) rescore write instead of ever claiming
    // 'approved'. runScoreRescore's own approved-count only increments on
    // outcome === 'approved', so this concurrent-write case is never
    // reported as a newly-approved row.
    expect(outcome).toBe('raced');
    expect(calls).toHaveLength(2);
    expect(calls[0].admin_status).toBe('approved'); // the attempted, but unmatched, approval write
    expect(calls[1].admin_status).toBeUndefined(); // the fallback write never sets admin_status
  });
});

describe('revalidateStaleRescoreCandidate clears the assessment and curated_at (Codex P1 content-drift path)', () => {
  test('writes curated_at: null and clears the stored score so the row re-enters fresh curation', async () => {
    const { calls } = wireDb();
    await revalidateStaleRescoreCandidate({ id: 'row-2' }, 'content changed');
    expect(calls).toHaveLength(1);
    expect(calls[0].curated_at).toBeNull();
    expect(calls[0].editorial_score).toBeNull();
    expect(calls[0].score_breakdown).toBeNull();
    expect(calls[0].curation_note).toBe('content changed');
  });
});
