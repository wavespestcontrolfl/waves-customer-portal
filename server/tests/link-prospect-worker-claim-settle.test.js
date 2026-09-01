/**
 * claim() settles superseded paths BEFORE leasing (Codex PR #3687 r19 / local
 * P1): a placement whose acquisition path the investigator retired — while it
 * was leased, or since its last release — is handed out on the LIVE successor
 * (path_id + execution target_url), never the obsolete route. Settling at
 * claim time, under the claim's own row locks, is the one place every
 * execution passes through; a release-then-settle sequence could always be
 * raced by the next claim. In-memory knex-shaped store, real
 * link-registry.settleRetiredPlacements.
 */
const mockStore = { seo_link_prospects: [], seo_link_acquisition_paths: [] };
jest.mock('../models/db', () => {
  const builder = (table) => {
    const preds = [];
    let limitN = null;
    const get = (row, col) => row[String(col).includes('.') ? String(col).split('.')[1] : col];
    const rows = () => { const r = mockStore[table].filter((row) => preds.every((p) => p(row))); return limitN == null ? r : r.slice(0, limitN); };
    const q = {
      where(a, b, c) {
        if (typeof a === 'object') preds.push((row) => Object.entries(a).every(([k, v]) => get(row, k) === v));
        else if (c !== undefined) preds.push((row) => (b === '<' ? get(row, a) < c : get(row, a) === c));
        else preds.push((row) => get(row, a) === b);
        return q;
      },
      whereIn(col, arr) { preds.push((row) => arr.includes(get(row, col))); return q; },
      whereNull(col) { preds.push((row) => get(row, col) == null); return q; },
      whereNotNull(col) { preds.push((row) => get(row, col) != null); return q; },
      whereRaw() { return q; },
      orderByRaw() { return q; },
      orderBy() { return q; },
      limit(n) { limitN = n; return q; },
      forUpdate() { return q; },
      skipLocked() { return q; },
      select() { return q; },
      async first() { return rows()[0] ? { ...rows()[0] } : undefined; },
      async update(patch) { const hit = rows(); for (const row of hit) Object.assign(row, patch); return hit.length; },
      then(res, rej) { return Promise.resolve(rows().map((r) => ({ ...r }))).then(res, rej); },
    };
    return q;
  };
  const db = (t) => builder(t);
  db.transaction = async (cb) => cb(db);
  return db;
});

const worker = require('../services/seo/link-prospect-worker');

beforeEach(() => { mockStore.seo_link_prospects.length = 0; mockStore.seo_link_acquisition_paths.length = 0; });

test('claim hands out a placement on its LIVE successor path, moving the execution URL, atomically with the lease', async () => {
  const old = { id: 'p-old', domain_id: 'd1', submission_url: 'https://example.com/old-join', superseded_by: 'p-mid' };
  const mid = { id: 'p-mid', domain_id: 'd1', submission_url: 'https://example.com/mid-join', superseded_by: 'p-live' };
  const live = { id: 'p-live', domain_id: 'd1', submission_url: 'https://example.com/join', superseded_by: null };
  mockStore.seo_link_acquisition_paths.push(old, mid, live);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, automation_policy: 'submit_free', outreach_status: null, priority: 'high', domain_rating: 40, target_domain: 'example.com' };
  const stale = { ...base, id: 'r-stale', path_id: 'p-old', target_url: 'https://example.com/old-join' }; // released after the investigator retired its path twice
  const current = { ...base, id: 'r-current', path_id: 'p-live', target_url: 'https://example.com/join' };
  mockStore.seo_link_prospects.push(stale, current);

  const claimed = await worker.claim({ n: 5, type: 'signup' });
  expect(claimed.map((r) => r.id)).toEqual(['r-current']); // only the already-live placement is leased
  expect(claimed[0].lease_token).toBe(claimed[0].claimed_at.toISOString());
  // the stale one was settled onto the live successor (execution URL included) and left UNCLASSIFIED for the
  // weekly classifier — its policy described the retired path, so it is never leased in the same claim
  expect(stale).toMatchObject({ path_id: 'p-live', target_url: 'https://example.com/join', automation_policy: null, last_classified_at: null, claimed_at: null });
  expect(current.claimed_at).toBeInstanceOf(Date);
});

test('a placement on a live path claims unchanged; preview claims settle nothing and lease nothing', async () => {
  const live = { id: 'p-live', domain_id: 'd1', submission_url: 'https://example.com/join', superseded_by: null };
  const old = { id: 'p-old', domain_id: 'd1', submission_url: 'https://example.com/old-join', superseded_by: 'p-live' };
  mockStore.seo_link_acquisition_paths.push(old, live);
  const row = { id: 'r1', status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-old', target_url: 'https://example.com/old-join' };
  mockStore.seo_link_prospects.push(row);
  const preview = await worker.claim({ n: 5, type: 'signup', preview: true });
  expect(preview).toHaveLength(1);
  expect(row).toMatchObject({ path_id: 'p-old', claimed_at: null }); // read-only preview: no writes of any kind
  const claimed = await worker.claim({ n: 5, type: 'signup' });
  expect(claimed).toEqual([]); // settled, unclassified, not leased
  expect(row).toMatchObject({ path_id: 'p-live', target_url: 'https://example.com/join', automation_policy: null, claimed_at: null });
});

test('a moved placement never keeps a policy classified for the old path — and a lane change leaves the signup lane (local Codex P1 / PR r20 P1)', async () => {
  const oldA = { id: 'p-old', domain_id: 'd1', submission_url: 'https://example.com/free-listing', superseded_by: 'p-paid', link_type: 'directory' };
  const paid = { id: 'p-paid', domain_id: 'd1', submission_url: 'https://example.com/sponsor', superseded_by: null, link_type: 'directory' };
  const oldB = { id: 'p-old2', domain_id: 'd2', submission_url: 'https://gated.example/free', superseded_by: 'p-outreach', link_type: 'directory' };
  const outreach = { id: 'p-outreach', domain_id: 'd2', submission_url: null, superseded_by: null, link_type: 'editorial' };
  mockStore.seo_link_acquisition_paths.push(oldA, paid, oldB, outreach);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, automation_policy: 'submit_free', last_classified_at: new Date('2026-08-01'), priority: 'high', domain_rating: 40 };
  const toPaid = { ...base, id: 'r-paid', target_domain: 'example.com', path_id: 'p-old', target_url: 'https://example.com/free-listing' };
  const toOutreach = { ...base, id: 'r-out', target_domain: 'gated.example', path_id: 'p-old2', target_url: 'https://gated.example/free' };
  mockStore.seo_link_prospects.push(toPaid, toOutreach);

  expect(await worker.claim({ n: 5, type: 'signup' })).toEqual([]); // nothing eligible: both moved, both unclassified
  expect(toPaid).toMatchObject({ path_id: 'p-paid', target_url: 'https://example.com/sponsor', link_type: 'directory', automation_policy: null, last_classified_at: null, claimed_at: null });
  expect(toOutreach).toMatchObject({ path_id: 'p-outreach', target_url: 'https://gated.example/free', link_type: 'editorial', automation_policy: null, claimed_at: null }); // left the signup lane; URL-less successor keeps target_url
  expect(await worker.claim({ n: 5, type: 'signup' })).toEqual([]); // still not the free lane's until the classifier has read the successor
});

test('a REFUSED settlement never leases the retired path, and a sent-stamped row is never served (local Codex P1)', async () => {
  const old = { id: 'p-old', domain_id: 'd1', submission_url: 'https://example.com/old-join', superseded_by: 'p-live', link_type: 'directory' };
  const live = { id: 'p-live', domain_id: 'd1', submission_url: 'https://example.com/join', superseded_by: null, link_type: 'directory' };
  mockStore.seo_link_acquisition_paths.push(old, live);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40, target_domain: 'example.com' };
  // locked by a sent stamp although its status reads none — the registry refuses to move it
  const sentStamped = { ...base, id: 'r-sent', path_id: 'p-old', target_url: 'https://example.com/old-join', outreach_status: 'none', outreach_sent_at: new Date('2026-08-20') };
  const fine = { ...base, id: 'r-fine', path_id: 'p-live', target_url: 'https://example.com/join' };
  mockStore.seo_link_prospects.push(sentStamped, fine);
  const claimed = await worker.claim({ n: 5, type: 'signup' });
  expect(claimed.map((r) => r.id)).toEqual(['r-fine']);
  expect(sentStamped).toMatchObject({ path_id: 'p-old', claimed_at: null }); // neither moved nor leased on the obsolete route
});

