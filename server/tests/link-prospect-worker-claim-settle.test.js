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
  const got = Object.fromEntries(claimed.map((r) => [r.id, r]));
  expect(got['r-stale']).toMatchObject({ path_id: 'p-live', target_url: 'https://example.com/join', claimed_by: worker.WORKER }); // the runner will submit at the live route
  expect(got['r-stale'].lease_token).toBe(got['r-stale'].claimed_at.toISOString());
  expect(got['r-current']).toMatchObject({ path_id: 'p-live', target_url: 'https://example.com/join' });
  // …and the store agrees: settled AND leased
  expect(stale).toMatchObject({ path_id: 'p-live', target_url: 'https://example.com/join' });
  expect(stale.claimed_at).toBeInstanceOf(Date);
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
  expect(claimed[0]).toMatchObject({ path_id: 'p-live', target_url: 'https://example.com/join' });
});

test('a submit_free placement whose successor is paid or gated is settled with the successor-derived policy and NOT leased (local Codex P1)', async () => {
  const old = { id: 'p-old', domain_id: 'd1', submission_url: 'https://example.com/free-listing', superseded_by: 'p-paid', account_required: false, email_verification: false, payment_required: false, legal_attestation: false, agent_completable: true };
  const paid = { id: 'p-paid', domain_id: 'd1', submission_url: 'https://example.com/sponsor', superseded_by: null, account_required: false, email_verification: false, payment_required: true, legal_attestation: false, agent_completable: true, expected_rel: 'dofollow' };
  const old2 = { id: 'p-old2', domain_id: 'd2', submission_url: 'https://gated.example/free', superseded_by: 'p-gated', payment_required: false };
  const gated = { id: 'p-gated', domain_id: 'd2', submission_url: 'https://gated.example/apply', superseded_by: null, account_required: false, email_verification: false, payment_required: false, legal_attestation: true, agent_completable: true };
  const stillFree = { id: 'p-free', domain_id: 'd3', submission_url: 'https://free.example/add', superseded_by: null, account_required: false, email_verification: false, payment_required: false, legal_attestation: false, agent_completable: true };
  const old3 = { id: 'p-old3', domain_id: 'd3', submission_url: 'https://free.example/old-add', superseded_by: 'p-free' };
  mockStore.seo_link_acquisition_paths.push(old, paid, old2, gated, old3, stillFree);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40 };
  const toPaid = { ...base, id: 'r-paid', target_domain: 'example.com', path_id: 'p-old', target_url: 'https://example.com/free-listing' };
  const toGated = { ...base, id: 'r-gated', target_domain: 'gated.example', path_id: 'p-old2', target_url: 'https://gated.example/free' };
  const toFree = { ...base, id: 'r-free', target_domain: 'free.example', path_id: 'p-old3', target_url: 'https://free.example/old-add' };
  mockStore.seo_link_prospects.push(toPaid, toGated, toFree);

  const claimed = await worker.claim({ n: 5, type: 'signup' });
  expect(claimed.map((r) => r.id)).toEqual(['r-free']); // only the still-free successor is leased
  expect(claimed[0]).toMatchObject({ path_id: 'p-free', target_url: 'https://free.example/add', automation_policy: 'submit_free' });
  // the others were settled onto their successors under the classifier's rules and left un-leased for their lanes
  expect(toPaid).toMatchObject({ path_id: 'p-paid', target_url: 'https://example.com/sponsor', automation_policy: 'pay_and_submit', claimed_at: null });
  expect(toGated).toMatchObject({ path_id: 'p-gated', target_url: 'https://gated.example/apply', automation_policy: 'needs_account', claimed_at: null });
  expect(toPaid.last_classified_at).toBeInstanceOf(Date); // the weekly classifier will not revert the runtime decision
  // a second claim finds nothing eligible — the reclassified rows never re-enter the free lane
  expect(await worker.claim({ n: 5, type: 'signup' })).toEqual([]);
});

