jest.mock('../models/db');
jest.mock('../services/seo/omega-indexer');

const db = require('../models/db');
const omega = require('../services/seo/omega-indexer');
const { pushForIndexing } = require('../services/seo/link-prospect-verifier');

// Mock the knex builder. pushForIndexing issues up to two updates per call:
//   1. the atomic claim — quality_signals = db.raw("jsonb_set(...)") — returns
//      `claimAffected` (1 = we won the row, 0 = another run owns it).
//   2. the result/release write — a JSON string (success/failure) or a raw
//      "quality_signals - 'omega_inflight'" (skipped release).
let claimAffected;
let updates; // every update patch, in order

function wireDb() {
  claimAffected = 1;
  updates = [];
  db.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  db.mockImplementation(() => {
    const b = {};
    b.where = jest.fn(() => b);
    b.whereRaw = jest.fn(() => b);
    b.update = jest.fn((patch) => {
      updates.push(patch);
      const qs = patch.quality_signals;
      // Only the atomic claim SETS omega_inflight via a jsonb path ('{omega_inflight}').
      if (qs && qs.__raw && qs.__raw.includes("'{omega_inflight}'")) return Promise.resolve(claimAffected);
      return Promise.resolve(1);
    });
    return b;
  });
}

const rawOf = (p) => (p && p.quality_signals && p.quality_signals.__raw) || '';
// The atomic claim is the only write that SETS omega_inflight.
const claimUpdate = () => updates.find((p) => rawOf(p).includes("'{omega_inflight}'"));
// Result writes touch only omega_* keys on the live column via jsonb_set/delete.
const successWrite = () => updates.find((p) => rawOf(p).includes("'{omega_submitted}'"));
const failureWrite = () => updates.find((p) => rawOf(p).includes("'{omega_attempts}'"));
const releaseWrite = () => updates.find((p) => rawOf(p) === "quality_signals - 'omega_inflight'");

const NOW = new Date('2026-06-12T08:00:00Z');
const base = { id: 'p1', status: 'placed', indexing_status: 'not_checked', target_domain: 'showmysites.com', quality_signals: null };

beforeEach(() => { jest.clearAllMocks(); });

describe('pushForIndexing — Omega dedupe, atomic claim, retry discipline', () => {
  test('claims then submits a dofollow link and marks omega_submitted on success', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: true, status: 200 });
    const out = await pushForIndexing(base, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(true);
    expect(claimUpdate()).toBeTruthy(); // atomic claim happened before the call
    expect(omega.submit).toHaveBeenCalledWith('showmysites.com', ['https://showmysites.com/x/']);
    const w = successWrite();
    expect(w).toBeTruthy();
    // stamps omega_submitted with NOW and clears attempts/error/inflight, all via
    // jsonb_set/delete on the live column (no snapshot clobber).
    expect(w.quality_signals.bindings).toContain(NOW.toISOString());
    expect(w.quality_signals.__raw).toMatch(/- 'omega_attempts'/);
    expect(w.quality_signals.__raw).toMatch(/- 'omega_inflight'/);
    expect(failureWrite()).toBeUndefined();
  });

  test('does NOT submit a nofollow link (and never claims)', async () => {
    wireDb();
    const out = await pushForIndexing(base, 'https://showmysites.com/x/', false, NOW);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  test('does NOT submit an already-indexed page', async () => {
    wireDb();
    const indexed = { ...base, status: 'indexed', indexing_status: 'indexed' };
    const out = await pushForIndexing(indexed, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
  });

  test('lost the atomic claim race → does not call Omega', async () => {
    wireDb();
    claimAffected = 0; // another verifier run owns the row
    omega.submit.mockResolvedValue({ ok: true });
    const out = await pushForIndexing(base, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
  });

  test('a failed submit does NOT set omega_submitted — it stays retryable', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: false, error: 'boom' });
    const out = await pushForIndexing(base, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    expect(successWrite()).toBeUndefined(); // <-- the P1 fix: never marks submitted
    const w = failureWrite();
    expect(w).toBeTruthy();
    expect(w.quality_signals.bindings).toEqual([1, 'boom']); // attempts=1, error
    expect(w.quality_signals.__raw).toMatch(/- 'omega_inflight'/); // claim released
  });

  test('already-submitted link is never re-pushed (no claim, no call)', async () => {
    wireDb();
    const p = { ...base, quality_signals: { omega_submitted: '2026-06-01T00:00:00Z' } };
    const out = await pushForIndexing(p, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  test('stops retrying after the attempt cap (no claim, no call)', async () => {
    wireDb();
    const p = { ...base, quality_signals: { omega_attempts: 5 } };
    const out = await pushForIndexing(p, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
  });

  test('skipped (no API key) releases the claim and burns no attempt', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: false, skipped: true, error: 'OMEGA_INDEXER_API_KEY not set' });
    const out = await pushForIndexing(base, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    expect(omega.submit).toHaveBeenCalledTimes(1);
    // no success/failure write; just a raw inflight-release update
    expect(successWrite()).toBeUndefined();
    expect(failureWrite()).toBeUndefined();
    expect(releaseWrite()).toBeTruthy();
  });
});
