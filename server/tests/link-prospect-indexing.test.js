jest.mock('../models/db');
jest.mock('../services/seo/omega-indexer');

const db = require('../models/db');
const omega = require('../services/seo/omega-indexer');
const { pushForIndexing } = require('../services/seo/link-prospect-verifier');

// Capture what gets written so we can assert on the persisted quality_signals.
function wireDb() {
  const update = jest.fn().mockResolvedValue(1);
  db.mockReturnValue({ where: jest.fn().mockReturnValue({ update }) });
  return update;
}

const NOW = new Date('2026-06-12T08:00:00Z');
const base = { id: 'p1', target_domain: 'showmysites.com', quality_signals: null };

beforeEach(() => { jest.clearAllMocks(); });

describe('pushForIndexing — Omega dedupe + retry discipline', () => {
  test('submits a dofollow link and marks omega_submitted on success', async () => {
    const update = wireDb();
    omega.submit.mockResolvedValue({ ok: true, status: 200 });
    const out = await pushForIndexing(base, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(true);
    expect(omega.submit).toHaveBeenCalledWith('showmysites.com', ['https://showmysites.com/x/']);
    const written = JSON.parse(update.mock.calls[0][0].quality_signals);
    expect(written.omega_submitted).toBe(NOW.toISOString());
    expect(written.omega_attempts).toBeUndefined();
  });

  test('does NOT submit a nofollow link', async () => {
    wireDb();
    const out = await pushForIndexing(base, 'https://showmysites.com/x/', false, NOW);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
  });

  test('a failed submit does NOT set omega_submitted — it stays retryable', async () => {
    const update = wireDb();
    omega.submit.mockResolvedValue({ ok: false, error: 'boom' });
    const out = await pushForIndexing(base, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    const written = JSON.parse(update.mock.calls[0][0].quality_signals);
    expect(written.omega_submitted).toBeUndefined(); // <-- the P1 fix
    expect(written.omega_attempts).toBe(1);
    expect(written.omega_error).toBe('boom');
  });

  test('already-submitted link is never re-pushed', async () => {
    wireDb();
    const p = { ...base, quality_signals: { omega_submitted: '2026-06-01T00:00:00Z' } };
    const out = await pushForIndexing(p, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled();
  });

  test('stops retrying after the attempt cap', async () => {
    wireDb();
    omega.submit.mockResolvedValue({ ok: false, error: 'still down' });
    const p = { ...base, quality_signals: { omega_attempts: 5 } };
    const out = await pushForIndexing(p, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    expect(omega.submit).not.toHaveBeenCalled(); // cap reached, don't even call
  });

  test('skipped (no API key) is a pure no-op — no attempt burned, no write', async () => {
    const update = wireDb();
    omega.submit.mockResolvedValue({ ok: false, skipped: true, error: 'OMEGA_INDEXER_API_KEY not set' });
    const out = await pushForIndexing(base, 'https://showmysites.com/x/', true, NOW);
    expect(out).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
