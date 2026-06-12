jest.mock('../models/db');
jest.mock('../services/seo/omega-indexer');
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));

const db = require('../models/db');
const omega = require('../services/seo/omega-indexer');
const { isEnabled } = require('../config/feature-gates');
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
const successWrite = () => updates.find((p) => rawOf(p).includes("'{omega_submitted_url}'"));
const failureWrite = () => updates.find((p) => rawOf(p).includes("'{omega_attempts}'"));
const releaseWrite = () => updates.find((p) => rawOf(p) === "quality_signals - 'omega_inflight'");

const NOW = new Date('2026-06-12T08:00:00Z');
const URL = 'https://showmysites.com/x/';
const base = { id: 'p1', status: 'placed', indexing_status: 'not_checked', target_domain: 'showmysites.com', quality_signals: null };

beforeEach(() => { jest.clearAllMocks(); isEnabled.mockReturnValue(true); });

// Most tests exercise dedupe/claim/retry, not the confirm-crawl, so they pass
// dofollowConfirmed (skip the crawl). Confirm-specific tests inject a crawlFn.
const push = (p, url, dofollow, opts = { dofollowConfirmed: true }) => pushForIndexing(p, url, dofollow, NOW, opts);

describe('pushForIndexing — Omega dedupe, atomic claim, retry discipline', () => {
  test('does nothing when seoIntelligence is gated off (no claim, no paid call)', async () => {
    wireDb();
    isEnabled.mockReturnValue(false);
    const out = await push(base, URL, true);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  test('claims then submits a dofollow link and records the submitted URL on success', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: true, status: 200 });
    const out = await push(base, URL, true);
    expect(out).toBe(true);
    expect(claimUpdate()).toBeTruthy(); // atomic claim happened before the call
    expect(omega.submit).toHaveBeenCalledWith('showmysites.com', [URL]);
    const w = successWrite();
    expect(w).toBeTruthy();
    // records omega_submitted_url = the exact URL and clears per-URL attempt/error/
    // inflight keys, all via jsonb_set/delete on the live column (no snapshot clobber).
    expect(w.quality_signals.bindings).toContain(URL);
    expect(w.quality_signals.__raw).toMatch(/- 'omega_attempts'/);
    expect(w.quality_signals.__raw).toMatch(/- 'omega_inflight'/);
    expect(failureWrite()).toBeUndefined();
  });

  test('does NOT submit a nofollow link (and never claims)', async () => {
    wireDb();
    const out = await push(base, URL, false);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  test('does NOT submit an already-indexed page', async () => {
    wireDb();
    const indexed = { ...base, status: 'indexed', indexing_status: 'indexed' };
    const out = await push(indexed, URL, true);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
  });

  test('lost the atomic claim race → does not call Omega', async () => {
    wireDb();
    claimAffected = 0; // another verifier run owns the row
    omega.submit.mockResolvedValue({ ok: true });
    const out = await push(base, URL, true);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
  });

  test('a failed submit does NOT record omega_submitted_url — it stays retryable', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: false, error: 'boom' });
    const out = await push(base, URL, true);
    expect(out).toBe(false);
    expect(successWrite()).toBeUndefined(); // never marks the URL submitted
    const w = failureWrite();
    expect(w).toBeTruthy();
    expect(w.quality_signals.bindings).toEqual([1, URL, 'boom']); // attempts, url, error
    expect(w.quality_signals.__raw).toMatch(/- 'omega_inflight'/); // claim released
  });

  test('the SAME already-submitted URL is never re-pushed (no claim, no call)', async () => {
    wireDb();
    const p = { ...base, quality_signals: { omega_submitted_url: URL } };
    const out = await push(p, URL, true);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  test('a MOVED URL is submitted even though the old URL was indexed (URL-scoped dedupe)', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: true });
    const p = { ...base, quality_signals: { omega_submitted_url: 'https://showmysites.com/OLD/' } };
    const movedUrl = 'https://showmysites.com/NEW/';
    const out = await push(p, movedUrl, true);
    expect(out).toBe(true);
    expect(omega.submit).toHaveBeenCalledWith('showmysites.com', [movedUrl]);
    expect(successWrite().quality_signals.bindings).toContain(movedUrl);
  });

  test('attempt cap is per-URL: a moved URL resets the budget', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: true });
    // 5 failures recorded against the OLD url; the new url should NOT be capped.
    const p = { ...base, quality_signals: { omega_attempts: 5, omega_attempt_url: 'https://showmysites.com/OLD/' } };
    const out = await push(p, 'https://showmysites.com/NEW/', true);
    expect(out).toBe(true);
    expect(omega.submit).toHaveBeenCalled();
  });

  test('stops retrying after the cap for the SAME URL (no claim, no call)', async () => {
    wireDb();
    const p = { ...base, quality_signals: { omega_attempts: 5, omega_attempt_url: URL } };
    const out = await push(p, URL, true);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
  });

  test('skipped (no API key) releases the claim and burns no attempt', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: false, skipped: true, error: 'OMEGA_INDEXER_API_KEY not set' });
    const out = await push(base, URL, true);
    expect(out).toBe(false);
    expect(omega.submit).toHaveBeenCalledTimes(1);
    // no success/failure write; just a raw inflight-release update
    expect(successWrite()).toBeUndefined();
    expect(failureWrite()).toBeUndefined();
    expect(releaseWrite()).toBeTruthy();
  });
});

describe('pushForIndexing — crawl-confirms dofollow before spending (unreliable DataForSEO signal)', () => {
  test('DataForSEO says dofollow but a crawl finds nofollow → releases claim, no submit', async () => {
    wireDb();
    const crawlFn = jest.fn().mockResolvedValue({ found: true, isDofollow: false });
    const out = await pushForIndexing(base, URL, true, NOW, { crawlFn }); // dofollowConfirmed defaults false
    expect(out).toBe(false);
    expect(crawlFn).toHaveBeenCalledWith(URL, base.target_page);
    expect(omega.submit).not.toHaveBeenCalled();
    expect(releaseWrite()).toBeTruthy(); // claim released
    expect(successWrite()).toBeUndefined();
  });

  test('crawl cannot reach the page → releases claim, no submit (retryable)', async () => {
    wireDb();
    const crawlFn = jest.fn().mockResolvedValue({ found: false });
    const out = await pushForIndexing(base, URL, true, NOW, { crawlFn });
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
    expect(releaseWrite()).toBeTruthy();
  });

  test('crawl confirms dofollow → submits and records the URL', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: true });
    const crawlFn = jest.fn().mockResolvedValue({ found: true, isDofollow: true });
    const out = await pushForIndexing(base, URL, true, NOW, { crawlFn });
    expect(out).toBe(true);
    expect(crawlFn).toHaveBeenCalled();
    expect(omega.submit).toHaveBeenCalledWith('showmysites.com', [URL]);
    expect(successWrite().quality_signals.bindings).toContain(URL);
  });

  test('dofollowConfirmed=true (crawl path) skips the confirm crawl', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: true });
    const crawlFn = jest.fn();
    const out = await pushForIndexing(base, URL, true, NOW, { dofollowConfirmed: true, crawlFn });
    expect(out).toBe(true);
    expect(crawlFn).not.toHaveBeenCalled();
    expect(omega.submit).toHaveBeenCalled();
  });
});
