jest.mock('../models/db');
jest.mock('../services/seo/dataforseo');
jest.mock('../services/seo/search-console');

const db = require('../models/db');
const dataforseo = require('../services/seo/dataforseo');
const SearchConsole = require('../services/seo/search-console');
const { runOne } = require('../services/seo/link-prospect-indexer');

let updatePatch;
function wireDb() {
  updatePatch = null;
  db.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  db.mockImplementation(() => ({
    where: jest.fn().mockReturnThis(),
    update: jest.fn((patch) => { updatePatch = patch; return Promise.resolve(1); }),
  }));
}

beforeEach(() => { jest.clearAllMocks(); });

describe('link indexer — concurrency-safe quality_signals write', () => {
  test('patches ONLY target_indexed via jsonb_set, never a wholesale snapshot', async () => {
    wireDb();
    dataforseo.checkIndexed.mockResolvedValue('not_indexed');
    SearchConsole.inspectUrl.mockResolvedValue({ ok: true, indexed: true });

    // prospect already carries an omega_submitted dedupe marker the verifier set.
    await runOne({
      id: 'p1', status: 'live', live_url: 'https://dir.com/x',
      target_page: 'https://wavespestcontrol.com/', target_domain: 'dir.com',
      quality_signals: { omega_submitted: '2026-06-12T08:00:00Z' },
    });

    // The write must be a jsonb_set on target_indexed (preserving omega_*), NOT a
    // serialized object that would drop omega_submitted.
    expect(typeof updatePatch.quality_signals).toBe('object');
    expect(updatePatch.quality_signals.__raw).toMatch(/jsonb_set/);
    expect(updatePatch.quality_signals.__raw).toMatch(/'\{target_indexed\}'/);
    expect(updatePatch.quality_signals.bindings).toEqual([true]);
    expect(updatePatch.indexing_status).toBe('not_indexed');
  });

  test('omits the quality_signals write entirely when target indexation is unknown', async () => {
    wireDb();
    dataforseo.checkIndexed.mockResolvedValue('indexed');
    SearchConsole.inspectUrl.mockResolvedValue({ ok: false }); // tgt = null

    await runOne({
      id: 'p2', status: 'live', live_url: 'https://dir.com/y',
      target_page: 'https://wavespestcontrol.com/wdo-inspection/', target_domain: 'dir.com',
      quality_signals: { omega_submitted: 'x' },
    });

    expect(updatePatch.quality_signals).toBeUndefined(); // nothing to change -> omega_* untouched
    expect(updatePatch.status).toBe('indexed');
  });
});
