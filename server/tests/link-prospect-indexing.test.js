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
      if (qs && qs.__raw && qs.__raw.includes('jsonb_set')) return Promise.resolve(claimAffected);
      return Promise.resolve(1);
    });
    return b;
  });
}

const stringWrite = () => {
  const u = updates.find((p) => typeof p.quality_signals === 'string');
  return u ? JSON.parse(u.quality_signals) : null;
};
const claimUpdate = () => updates.find((p) => p.quality_signals && p.quality_signals.__raw && p.quality_signals.__raw.includes('jsonb_set'));

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
    const w = stringWrite();
    expect(w.omega_submitted).toBe(NOW.toISOString());
    expect(w.omega_attempts).toBeUndefined();
    expect(w.omega_inflight).toBeUndefined(); // claim released
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
    const w = stringWrite();
    expect(w.omega_submitted).toBeUndefined(); // <-- the P1 fix
    expect(w.omega_attempts).toBe(1);
    expect(w.omega_error).toBe('boom');
    expect(w.omega_inflight).toBeUndefined();
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
    // no JSON success/failure write; a raw inflight-release update instead
    expect(stringWrite()).toBeNull();
    const release = updates.find((p) => p.quality_signals && p.quality_signals.__raw && p.quality_signals.__raw.includes("- 'omega_inflight'"));
    expect(release).toBeTruthy();
  });
});
