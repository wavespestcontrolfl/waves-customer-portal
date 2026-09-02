/**
 * signup-classifier run(): the post-fetch UPDATE is optimistic on the ROUTE
 * it classified, not only on claimed_at / last_classified_at (Codex PR #3687
 * r22 P1). A path supersession (registry.settleRetiredPlacements) moves
 * path_id / target_url and leaves last_classified_at null, so a snapshot of
 * an unclassified row must not write the old page's policy onto the new
 * route. Recording db double; the known-directory heuristic avoids any fetch.
 */
const mockState = { rows: [], updates: [] };
jest.mock('../models/db', () => {
  const builder = () => {
    const rec = { wheres: [], patch: null };
    const q = {
      where(a, b, c) { rec.wheres.push(c !== undefined ? [a, b, c] : b !== undefined ? [a, b] : [a]); return q; },
      whereIn() { return q; },
      whereNull(col) { rec.wheres.push([col, 'IS NULL']); return q; },
      andWhere(fn) { fn({ whereNull: () => ({ orWhere: () => {} }) }); return q; },
      orderByRaw() { return q; },
      limit() { return q; },
      modify(fn) { fn(q); return q; },
      async update(patch) { rec.patch = patch; mockState.updates.push(rec); return 1; },
      then(res, rej) { return Promise.resolve(mockState.rows.map((r) => ({ ...r }))).then(res, rej); },
    };
    return q;
  };
  return jest.fn(() => builder());
});
jest.mock('../services/seo/contact-finder', () => ({ fetchPageText: jest.fn(async () => { throw new Error('known directory — no fetch'); }) }));

const classifier = require('../services/seo/signup-classifier');

test('the classification UPDATE is guarded on path_id + target_url as well as the lease and stamp', async () => {
  mockState.rows = [{ id: 'p1', target_domain: 'citysquares.com', target_url: 'https://citysquares.com/add', path_id: 'path-1', link_type: 'directory', status: 'prospect', claimed_at: null, last_classified_at: null, tier: 1, score: 10 }];
  mockState.updates.length = 0;
  await classifier.run({ limit: 5 });
  expect(mockState.updates).toHaveLength(1);
  const { wheres, patch } = mockState.updates[0];
  expect(patch.automation_policy).toBe('submit_free'); // citysquares is a known free-form directory
  expect(wheres).toEqual(expect.arrayContaining([
    [{ id: 'p1' }], ['status', 'prospect'], ['claimed_at', 'IS NULL'], ['last_classified_at', 'IS NULL'],
    ['path_id', 'path-1'], ['target_url', 'https://citysquares.com/add'],
  ]));
});

test('a row snapshotted with no route guards on NULL path_id / target_url (never an unbounded write)', async () => {
  mockState.rows = [{ id: 'p2', target_domain: 'citysquares.com', target_url: null, path_id: null, link_type: 'directory', status: 'prospect', claimed_at: null, last_classified_at: null }];
  mockState.updates.length = 0;
  await classifier.run({ limit: 5 });
  expect(mockState.updates[0].wheres).toEqual(expect.arrayContaining([['path_id', 'IS NULL'], ['target_url', 'IS NULL']]));
});
