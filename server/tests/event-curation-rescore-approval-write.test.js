/**
 * Codex P1 (2026-09-27), event-curation.js: "Revalidate rows before rescore
 * auto-approval". applyRescore's approval branch used to write
 * admin_status='approved' whenever decision.approve was true — purely
 * deterministic score math with no re-check that the row is STILL eligible
 * under current rules. This isolates the actual DB write path (mocked —
 * no live Postgres in this environment) to prove the `canApprove` gate
 * (computed by runScoreRescore from the SAME eligibility pipeline fresh
 * curation uses) is what the write obeys, not decision.approve alone.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { applyRescore, hasContentChangedSinceCuration, revalidateStaleRescoreCandidate } = require('../services/event-curation');

function wireDb() {
  const calls = [];
  db.fn = { now: jest.fn(() => 'NOW()') };
  db.mockImplementation(() => ({
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    whereNotNull: jest.fn().mockReturnThis(),
    whereNot: jest.fn().mockReturnThis(),
    whereNotIn: jest.fn().mockReturnThis(),
    update: jest.fn((patch) => { calls.push(patch); return Promise.resolve(1); }),
  }));
  return calls;
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
  const row = { id: 'row-1' };

  test('canApprove: false (current-eligibility check failed) never writes admin_status=approved, even though decision.approve is true', async () => {
    const calls = wireDb();
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
    const calls = wireDb();
    const outcome = await applyRescore(row, APPROVING_DECISION);
    expect(outcome).toBe('approved');
    expect(calls).toHaveLength(1);
    expect(calls[0].admin_status).toBe('approved');
    expect(calls[0].approved_via).toBe('auto_curation');
  });

  test('neither write path touches updated_at — hasContentChangedSinceCuration must stay valid across repeated rescore passes', async () => {
    const calls = wireDb();
    await applyRescore(row, APPROVING_DECISION, { canApprove: true });
    await applyRescore(row, APPROVING_DECISION, { canApprove: false });
    for (const patch of calls) expect(patch.updated_at).toBeUndefined();
  });

  test('a rejected-policy decision (approve: false) never approves regardless of canApprove', async () => {
    const calls = wireDb();
    const rejected = { ...APPROVING_DECISION, approve: false, rejectionCodes: ['retail_promotion'] };
    const outcome = await applyRescore(row, rejected, { canApprove: false });
    expect(outcome).toBe('rescored');
    expect(calls[0].admin_status).toBeUndefined();
  });
});

describe('revalidateStaleRescoreCandidate clears the assessment and curated_at (Codex P1 content-drift path)', () => {
  test('writes curated_at: null and clears the stored score so the row re-enters fresh curation', async () => {
    const calls = wireDb();
    await revalidateStaleRescoreCandidate({ id: 'row-2' }, 'content changed');
    expect(calls).toHaveLength(1);
    expect(calls[0].curated_at).toBeNull();
    expect(calls[0].editorial_score).toBeNull();
    expect(calls[0].score_breakdown).toBeNull();
    expect(calls[0].curation_note).toBe('content changed');
  });
});

// Re-asserted here (also covered directly in event-curation.test.js) so this
// file stands on its own as the "before/after" proof for the write path.
describe('hasContentChangedSinceCuration', () => {
  test('detects drift introduced by a later write that bumps updated_at past curated_at', () => {
    expect(hasContentChangedSinceCuration({
      curated_at: '2026-09-27T06:15:00.000Z',
      updated_at: '2026-09-27T09:00:00.000Z',
    })).toBe(true);
  });
});
