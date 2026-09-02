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
const mockStore = { seo_link_prospects: [], seo_link_acquisition_paths: [], seo_link_domains: [] };
jest.mock('../models/db', () => {
  const builder = (table) => {
    const preds = [];
    let limitN = null;
    const get = (row, col) => row[String(col).includes('.') ? String(col).split('.')[1] : col];
    const rows = () => { const r = mockStore[table].filter((row) => preds.every((p) => p(row))); return limitN == null ? r : r.slice(0, limitN); };
    const eq = (l, r) => (l instanceof Date && r instanceof Date ? l.getTime() === r.getTime() : l === r);
    const cmp = (op, l, r) => (op === '<' ? l < r : op === '<=' ? l <= r : eq(l, r));
    const vals = (arr) => (arr && typeof arr._rows === 'function' ? arr._rows().map((r) => r[(arr._select || ['id'])[0]]) : arr); // a sub-builder resolves lazily as a sub-select
    // grouped where: OR-combined like knex's callback builder, nesting allowed
    const group = (fn) => {
      const sub = [];
      const g = {
        where(col, op, v) { if (typeof col === 'function') { sub.push(group(col)); return g; } sub.push(v === undefined ? (row) => eq(get(row, col), op) : (row) => cmp(op, get(row, col), v)); return g; },
        whereNull(col) { sub.push((row) => get(row, col) == null); return g; },
        whereNotNull(col) { sub.push((row) => get(row, col) != null); return g; },
        orWhere(col, op, v) { sub.push(v === undefined ? (row) => eq(get(row, col), op) : (row) => cmp(op, get(row, col), v)); return g; },
        orWhereNotIn(col, arr) { sub.push((row) => !vals(arr).includes(get(row, col))); return g; },
      };
      fn(g);
      return (row) => sub.some((p) => p(row));
    };
    const q = {
      where(a, b, c) {
        if (typeof a === 'function') { preds.push(group(a)); return q; }
        if (typeof a === 'object') preds.push((row) => Object.entries(a).every(([k, v]) => eq(get(row, k), v)));
        else if (c !== undefined) preds.push((row) => cmp(b, get(row, a), c));
        else preds.push((row) => eq(get(row, a), b));
        return q;
      },
      whereIn(col, arr) { preds.push((row) => vals(arr).includes(get(row, col))); return q; },
      whereNotIn(col, arr) { preds.push((row) => !vals(arr).includes(get(row, col))); return q; },
      _rows: rows,
      whereNull(col) { preds.push((row) => get(row, col) == null); return q; },
      whereNotNull(col) { preds.push((row) => get(row, col) != null); return q; },
      whereRaw() { return q; },
      orderByRaw() { return q; },
      orderBy() { return q; },
      limit(n) { limitN = n; return q; },
      forUpdate() { return q; },
      skipLocked() { return q; },
      select(...cols) { q._select = cols; return q; },
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

beforeEach(() => { mockStore.seo_link_prospects.length = 0; mockStore.seo_link_acquisition_paths.length = 0; mockStore.seo_link_domains.length = 0; });

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
  expect(preview).toHaveLength(0); // a live run would settle (not lease) this row — the preview never reports its retired URL as claimable (r2)
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
  expect(toOutreach).toMatchObject({ path_id: 'p-outreach', target_url: null, link_type: 'editorial', automation_policy: null, claimed_at: null }); // left the signup lane; a URL-less successor clears the retired route (r29)
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

test('a placement on a DISPROVEN path (confidence 0, not superseded) is never leased, whatever policy it still carries (Codex PR r23 P1)', async () => {
  const gone = { id: 'p-gone', domain_id: 'd1', submission_url: 'https://example.com/join', superseded_by: null, link_type: 'directory', confidence: 0 }; // 404'd / omitted under coverage
  const unverified = { id: 'p-unverified', domain_id: 'd2', submission_url: 'https://other.example/apply', superseded_by: null, link_type: 'directory', confidence: 0 }; // a claim no pass has observed
  const live = { id: 'p-live', domain_id: 'd3', submission_url: 'https://live.example/add', superseded_by: null, link_type: 'directory', confidence: 0.7 };
  mockStore.seo_link_acquisition_paths.push(gone, unverified, live);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40 };
  const onGone = { ...base, id: 'r-gone', target_domain: 'example.com', path_id: 'p-gone', target_url: 'https://example.com/join' };
  const onUnverified = { ...base, id: 'r-unv', target_domain: 'other.example', path_id: 'p-unverified', target_url: 'https://other.example/apply' };
  const onLive = { ...base, id: 'r-live', target_domain: 'live.example', path_id: 'p-live', target_url: 'https://live.example/add' };
  mockStore.seo_link_prospects.push(onGone, onUnverified, onLive);
  const claimed = await worker.claim({ n: 5, type: 'signup' });
  expect(claimed.map((r) => r.id)).toEqual(['r-live']);
  expect(onGone.claimed_at).toBeNull();
  expect(onUnverified.claimed_at).toBeNull();
});

test('disproven and retired paths are filtered BEFORE the claim limit — a dead prefix never starves valid prospects (Codex PR r24 P1)', async () => {
  const dead = { id: 'p-dead', domain_id: 'd1', submission_url: 'https://dead.example/join', superseded_by: null, link_type: 'directory', confidence: 0 };
  const retired = { id: 'p-ret', domain_id: 'd2', submission_url: 'https://ret.example/old', superseded_by: 'p-ret-live', link_type: 'directory', confidence: 0.7 };
  const retLive = { id: 'p-ret-live', domain_id: 'd2', submission_url: 'https://ret.example/new', superseded_by: null, link_type: 'directory', confidence: 0.7 };
  const live = { id: 'p-live', domain_id: 'd3', submission_url: 'https://live.example/add', superseded_by: null, link_type: 'directory', confidence: 0.7 };
  mockStore.seo_link_acquisition_paths.push(dead, retired, retLive, live);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, automation_policy: 'submit_free', priority: 'high' };
  // the dead-route rows outrank the valid one and would fill a limit of 1 every claim
  mockStore.seo_link_prospects.push(
    { ...base, id: 'r-dead', target_domain: 'dead.example', path_id: 'p-dead', target_url: 'https://dead.example/join', domain_rating: 90 },
    { ...base, id: 'r-ret', target_domain: 'ret.example', path_id: 'p-ret', target_url: 'https://ret.example/old', domain_rating: 80, claimed_at: null },
    { ...base, id: 'r-live', target_domain: 'live.example', path_id: 'p-live', target_url: 'https://live.example/add', domain_rating: 10 },
  );
  // ONE claim: the disproven row is filtered before the cut; the retired-path row is the top candidate and is
  // SETTLED (moved onto its successor, unclassified, consumed exactly once, never leased) — and the claim keeps
  // batching until a live row is leased, so a one-shot worker never sees an empty batch while work exists (hook P1)
  expect((await worker.claim({ n: 1, type: 'signup' })).map((r) => r.id)).toEqual(['r-live']);
  const ret = mockStore.seo_link_prospects.find((r) => r.id === 'r-ret');
  expect(ret).toMatchObject({ path_id: 'p-ret-live', target_url: 'https://ret.example/new', automation_policy: null, claimed_at: null });
  expect(await worker.claim({ n: 1, type: 'signup' })).toEqual([]); // nothing left
});

test('claim refreshes a placement\'s execution URL from the live path when the route moved to its working origin (Codex PR r26 P2)', async () => {
  const moved = { id: 'p-www', domain_id: 'd1', submission_url: 'https://www.example.com/get-listed', superseded_by: null, link_type: 'directory', confidence: 0.7 };
  mockStore.seo_link_acquisition_paths.push(moved);
  const row = { id: 'r1', status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-www', target_url: 'https://example.com/get-listed' };
  mockStore.seo_link_prospects.push(row);
  const claimed = await worker.claim({ n: 5, type: 'signup' });
  expect(claimed).toEqual([]); // a changed execution URL is a new page: refreshed, unclassified, NOT leased until the classifier has read it (r27)
  expect(row).toMatchObject({ target_url: 'https://www.example.com/get-listed', automation_policy: null, last_classified_at: null, claimed_at: null });
});

test('a placement under a domain the owner parked (Watch) or refused (Reject) is never leased (Codex PR r27 P1)', async () => {
  mockStore.seo_link_domains.push({ id: 'dW', agent_state: 'watching' }, { id: 'dR', agent_state: 'rejected' }, { id: 'dQ', agent_state: 'qualified' });
  const live = (id, host) => ({ id, domain_id: 'x', submission_url: `https://${host}/add`, superseded_by: null, link_type: 'directory', confidence: 0.7 });
  mockStore.seo_link_acquisition_paths.push(live('p-w', 'w.example'), live('p-r', 'r.example'), live('p-q', 'q.example'));
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40 };
  mockStore.seo_link_prospects.push(
    { ...base, id: 'r-w', domain_id: 'dW', target_domain: 'w.example', path_id: 'p-w', target_url: 'https://w.example/add' },
    { ...base, id: 'r-r', domain_id: 'dR', target_domain: 'r.example', path_id: 'p-r', target_url: 'https://r.example/add' },
    { ...base, id: 'r-q', domain_id: 'dQ', target_domain: 'q.example', path_id: 'p-q', target_url: 'https://q.example/add' },
    { ...base, id: 'r-legacy', domain_id: null, target_domain: 'legacy.example', path_id: null, target_url: 'https://legacy.example/add' },
  );
  const claimed = await worker.claim({ n: 5, type: 'signup' });
  expect(claimed.map((r) => r.id).sort()).toEqual(['r-q']); // owner rulings hold at the chokepoint; an un-backfilled row (no path yet) is not leased until the catch-up links it (r4)
});

test('a retired path that was ALSO disproven still reaches settlement — the pre-filter is for active disproven paths only (Codex PR r27 P2)', async () => {
  const retiredDead = { id: 'p-old', domain_id: 'd1', submission_url: 'https://example.com/old', superseded_by: 'p-new', link_type: 'directory', confidence: 0 };
  const live = { id: 'p-new', domain_id: 'd1', submission_url: 'https://example.com/new', superseded_by: null, link_type: 'directory', confidence: 0.7 };
  mockStore.seo_link_acquisition_paths.push(retiredDead, live);
  const row = { id: 'r1', status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-old', target_url: 'https://example.com/old' };
  mockStore.seo_link_prospects.push(row);
  expect(await worker.claim({ n: 5, type: 'signup' })).toEqual([]);
  expect(row).toMatchObject({ path_id: 'p-new', target_url: 'https://example.com/new', automation_policy: null, claimed_at: null }); // settled, not stranded
});

test('a lease released through report() settles the placement onto its successor even though it will never be claimed again (Codex PR r29 P1)', async () => {
  const old = { id: 'p-old', domain_id: 'd1', submission_url: 'https://example.com/old-join', superseded_by: 'p-live', link_type: 'directory', confidence: 0.7 };
  const live = { id: 'p-live', domain_id: 'd1', submission_url: 'https://example.com/join', superseded_by: null, link_type: 'directory', confidence: 0.7 };
  mockStore.seo_link_acquisition_paths.push(old, live);
  const lease = new Date('2026-09-02T01:00:00.000Z');
  // leased on p-old when the investigator superseded it; the runner now reports a terminal failure (MAX_ATTEMPTS → rejected: never claimable again)
  const row = { id: 'r1', status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: lease, claimed_by: worker.WORKER, attempts: worker.MAX_ATTEMPTS - 1, automation_policy: 'submit_free', priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-old', target_url: 'https://example.com/old-join', quality_signals: null };
  mockStore.seo_link_prospects.push(row);
  const rep = await worker.report({ prospect_id: 'r1', outcome: 'failed', lease_token: lease.toISOString() });
  expect(rep.ok).toBe(true);
  expect(row).toMatchObject({ status: 'prospect', attempts: 0, claimed_at: null, path_id: 'p-live', target_url: 'https://example.com/join', automation_policy: null }); // released AND settled in the same report; the terminal failure belonged to the predecessor — the successor reopens with a fresh count (r2)
});

test('an owner Watch that commits between the candidate SELECT and the lease write wins — the row is not handed out (Codex PR #3687 r30 P1)', async () => {
  mockStore.seo_link_domains.push({ id: 'dQ', agent_state: 'qualified' });
  const live = { id: 'p-q', domain_id: 'dQ', submission_url: 'https://q.example/add', superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 3 };
  mockStore.seo_link_acquisition_paths.push(live);
  const row = { id: 'r-q', domain_id: 'dQ', status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40, target_domain: 'q.example', path_id: 'p-q', target_url: 'https://q.example/add' };
  mockStore.seo_link_prospects.push(row);
  // the owner parks the domain right after the candidate read — simulated at the settlement call, which
  // runs after the candidate SELECT and before the lease UPDATE
  const dom = mockStore.seo_link_domains[0];
  let flipped = false;
  const settle = require('../services/seo/link-registry');
  const spy = jest.spyOn(settle, 'settleRetiredPlacements').mockImplementation(async (...args) => { if (!flipped) { dom.agent_state = 'watching'; flipped = true; } return 0; });
  try {
    const claimed = await worker.claim({ n: 5, type: 'signup' });
    expect(claimed).toEqual([]);
    expect(row.claimed_at).toBeNull(); // the lease UPDATE re-asserted the owner's ruling
  } finally { spy.mockRestore(); }
});

test('the lease stamps the path revision; a same-path change that lands while leased is applied at release (Codex PR #3687 r30 P1)', async () => {
  const path = { id: 'p-live', domain_id: 'd1', submission_url: 'https://example.com/join', superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 2 };
  mockStore.seo_link_acquisition_paths.push(path);
  const row = { id: 'r1', status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, attempts: 0, automation_policy: 'submit_free', last_classified_at: new Date('2026-08-01'), priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-live', target_url: 'https://example.com/join', quality_signals: null };
  mockStore.seo_link_prospects.push(row);
  const [claimed] = await worker.claim({ n: 5, type: 'signup' });
  expect(claimed.id).toBe('r1');
  expect(row.leased_path_revision).toBe(2); // stamped at lease time
  // while leased, the investigator learns the route is now account-gated (revision 3) — the immediate transition skipped this leased row
  path.revision = 3;
  const rep = await worker.report({ prospect_id: 'r1', outcome: 'failed', lease_token: claimed.lease_token });
  expect(rep.ok).toBe(true);
  expect(row).toMatchObject({ claimed_at: null, path_id: 'p-live', automation_policy: null, last_classified_at: null, leased_path_revision: null }); // reconciled at release: unclassified for the changed route; the stamp is consumed
  // an unchanged path releases without a transition
  const row2 = { id: 'r2', status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, attempts: 0, automation_policy: 'submit_free', last_classified_at: new Date('2026-08-01'), priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-live', target_url: 'https://example.com/join', quality_signals: null };
  mockStore.seo_link_prospects.push(row2);
  const [c2] = await worker.claim({ n: 5, type: 'signup' });
  await worker.report({ prospect_id: 'r2', outcome: 'failed', lease_token: c2.lease_token });
  expect(row2).toMatchObject({ claimed_at: null, automation_policy: 'submit_free' });
});

test('a path the investigator marked NOT agent-completable is never leased — before the limit and after settlement (Codex #3720 r1 P1)', async () => {
  const human = { id: 'p-human', domain_id: 'd1', submission_url: 'https://example.com/apply', superseded_by: null, link_type: 'directory', confidence: 0.8, revision: 1, agent_completable: false };
  const ok = { id: 'p-ok', domain_id: 'd2', submission_url: 'https://ok.example/add', superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 1, agent_completable: true };
  mockStore.seo_link_acquisition_paths.push(human, ok);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, automation_policy: 'submit_free', priority: 'high' };
  mockStore.seo_link_prospects.push(
    { ...base, id: 'r-human', target_domain: 'example.com', path_id: 'p-human', target_url: 'https://example.com/apply', domain_rating: 90 },
    { ...base, id: 'r-ok', target_domain: 'ok.example', path_id: 'p-ok', target_url: 'https://ok.example/add', domain_rating: 10 },
  );
  expect((await worker.claim({ n: 1, type: 'signup' })).map((r) => r.id)).toEqual(['r-ok']); // the human-step route never consumed the limit
});

test('a confidence drop to zero during the lease is reconciled at release even though the revision did not move (Codex #3720 r1 P1)', async () => {
  const path = { id: 'p-live', domain_id: 'd1', submission_url: 'https://example.com/join', superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 2 };
  mockStore.seo_link_acquisition_paths.push(path);
  const row = { id: 'r1', status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, attempts: 0, automation_policy: 'submit_free', last_classified_at: new Date('2026-08-01'), priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-live', target_url: 'https://example.com/join', quality_signals: null };
  mockStore.seo_link_prospects.push(row);
  const [claimed] = await worker.claim({ n: 5, type: 'signup' });
  path.confidence = 0; // disproven while leased — confidence is not a §3.2 input, so revision stays 2
  const rep = await worker.report({ prospect_id: 'r1', outcome: 'failed', lease_token: claimed.lease_token });
  expect(rep.ok).toBe(true);
  expect(row).toMatchObject({ claimed_at: null, automation_policy: null, last_classified_at: null }); // the transition ran: nothing composed on a dead route stays actionable
});

test('a read-only preview never reports a placement on a superseded path as claimable (Codex #3720 r2 P2)', async () => {
  const old = { id: 'p-old', domain_id: 'd1', submission_url: 'https://example.com/old', superseded_by: 'p-new', link_type: 'directory', confidence: 0.7 };
  const live = { id: 'p-new', domain_id: 'd1', submission_url: 'https://example.com/new', superseded_by: null, link_type: 'directory', confidence: 0.7 };
  const ok = { id: 'p-ok', domain_id: 'd2', submission_url: 'https://ok.example/add', superseded_by: null, link_type: 'directory', confidence: 0.7 };
  mockStore.seo_link_acquisition_paths.push(old, live, ok);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40 };
  mockStore.seo_link_prospects.push(
    { ...base, id: 'r-old', target_domain: 'example.com', path_id: 'p-old', target_url: 'https://example.com/old' },
    { ...base, id: 'r-ok', target_domain: 'ok.example', path_id: 'p-ok', target_url: 'https://ok.example/add' },
  );
  const preview = await worker.claim({ n: 5, type: 'signup', preview: true });
  expect(preview.map((r) => r.id)).toEqual(['r-ok']); // the retired-URL row would be settled (not leased) by a live run — never previewed as claimable
  expect(mockStore.seo_link_prospects.every((r) => r.claimed_at == null)).toBe(true); // no writes
});

test('a terminal failure reported on a superseded predecessor moves the row to the successor with a FRESH retry lifecycle (Codex #3720 r2 P1)', async () => {
  const old = { id: 'p-old', domain_id: 'd1', submission_url: 'https://example.com/old', superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 1 };
  const next = { id: 'p-new', domain_id: 'd1', submission_url: 'https://example.com/new', superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 1 };
  mockStore.seo_link_acquisition_paths.push(old, next);
  const row = { id: 'r1', status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, attempts: worker.MAX_ATTEMPTS - 1, automation_policy: 'submit_free', priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-old', target_url: 'https://example.com/old', quality_signals: null };
  mockStore.seo_link_prospects.push(row);
  const [claimed] = await worker.claim({ n: 5, type: 'signup' });
  old.superseded_by = 'p-new'; // the investigator retires the predecessor while the lease is held
  const rep = await worker.report({ prospect_id: 'r1', outcome: 'failed', lease_token: claimed.lease_token });
  expect(rep).toEqual({ ok: true, status: 'prospect', attempts: 0, reopened_on_successor: true }); // the report tells the truth about the post-settlement row
  expect(row).toMatchObject({ path_id: 'p-new', target_url: 'https://example.com/new', status: 'prospect', attempts: 0, claimed_at: null, automation_policy: null }); // the successor had no attempt: not terminal, count reset, unclassified for the classifier
});

test('a drafted report whose settlement moved the placement is refused as path_moved — no phantom draft is counted (local Codex P1)', async () => {
  const old = { id: 'p-old', domain_id: 'd1', submission_url: null, superseded_by: null, link_type: 'editorial', confidence: 0.7, revision: 1 };
  const next = { id: 'p-new', domain_id: 'd1', submission_url: null, superseded_by: null, link_type: 'editorial', confidence: 0.7, revision: 1 };
  mockStore.seo_link_acquisition_paths.push(old, next);
  const row = { id: 'r1', status: 'prospect', link_type: 'editorial', claimed_at: null, claimed_by: null, attempts: 0, automation_policy: null, priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-old', target_url: null, contact_email: 'ed@example.com', outreach_status: null, outreach_sent_at: null, quality_signals: null };
  mockStore.seo_link_prospects.push(row);
  const [claimed] = await worker.claim({ n: 5, type: 'outreach' });
  old.superseded_by = 'p-new'; // superseded while the drafter worked
  const rep = await worker.report({ prospect_id: 'r1', outcome: 'drafted', lease_token: claimed.lease_token, outreach_to_email: 'ed@example.com', outreach_subject: 'Pitch', outreach_body: 'Hi there' });
  expect(rep).toMatchObject({ ok: false, code: 'path_moved' });
  expect(row).toMatchObject({ path_id: 'p-new', outreach_status: 'none', outreach_to_email: null, claimed_at: null }); // released, moved, the stale draft cleared
});

test('a terminal failure released after a same-path REVISION reopens with a fresh count; after a confidence-only disproof it stays closed (local Codex P1)', async () => {
  const mk = (id, host) => ({ id, domain_id: 'd', submission_url: `https://${host}/join`, superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 2 });
  const revisedPath = mk('p-rev', 'rev.example'); const deadPath = mk('p-dead', 'dead.example');
  mockStore.seo_link_acquisition_paths.push(revisedPath, deadPath);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, claimed_by: null, attempts: worker.MAX_ATTEMPTS - 1, automation_policy: 'submit_free', last_classified_at: new Date('2026-08-01'), priority: 'high', domain_rating: 40, quality_signals: null };
  const onRevised = { ...base, id: 'r-rev', target_domain: 'rev.example', path_id: 'p-rev', target_url: 'https://rev.example/join' };
  const onDead = { ...base, id: 'r-dead', target_domain: 'dead.example', path_id: 'p-dead', target_url: 'https://dead.example/join' };
  mockStore.seo_link_prospects.push(onRevised, onDead);
  const claimed = await worker.claim({ n: 5, type: 'signup' });
  const tok = (id) => claimed.find((r) => r.id === id).lease_token;
  revisedPath.revision = 3; // a gate/URL/lane change landed while leased
  deadPath.confidence = 0;  // a disproof landed while leased (revision unchanged)
  expect(await worker.report({ prospect_id: 'r-rev', outcome: 'failed', lease_token: tok('r-rev') })).toMatchObject({ ok: true, status: 'prospect', attempts: 0, reopened_on_successor: true });
  expect(onRevised).toMatchObject({ status: 'prospect', attempts: 0, automation_policy: null });
  const dead = await worker.report({ prospect_id: 'r-dead', outcome: 'failed', lease_token: tok('r-dead') });
  expect(dead).toMatchObject({ ok: true, status: 'rejected' });
  expect(onDead).toMatchObject({ status: 'rejected', attempts: worker.MAX_ATTEMPTS, automation_policy: null }); // closed for good; the transition still unclassified it
});

test('a skipped report on a path that changed during the lease reopens the placement on the new route (Codex #3720 r3 P1)', async () => {
  const old = { id: 'p-old', domain_id: 'd1', submission_url: null, superseded_by: null, link_type: 'editorial', confidence: 0.7, revision: 1 };
  const next = { id: 'p-new', domain_id: 'd1', submission_url: null, superseded_by: null, link_type: 'editorial', confidence: 0.7, revision: 1 };
  mockStore.seo_link_acquisition_paths.push(old, next);
  const row = { id: 'r1', status: 'prospect', link_type: 'editorial', claimed_at: null, claimed_by: null, attempts: 0, automation_policy: null, priority: 'high', domain_rating: 40, target_domain: 'example.com', path_id: 'p-old', target_url: null, contact_email: 'ed@example.com', outreach_status: null, outreach_sent_at: null, quality_signals: null };
  mockStore.seo_link_prospects.push(row);
  const [claimed] = await worker.claim({ n: 5, type: 'outreach' });
  old.superseded_by = 'p-new'; // the route changed while the drafter decided to skip the OLD one
  const rep = await worker.report({ prospect_id: 'r1', outcome: 'skipped', lease_token: claimed.lease_token });
  expect(rep).toMatchObject({ ok: true, status: 'prospect', attempts: 0, reopened_on_successor: true });
  expect(row).toMatchObject({ path_id: 'p-new', status: 'prospect', attempts: 0, claimed_at: null });
});

test('a board row the catch-up has not linked to a path yet is never leased or previewed (Codex #3720 r4 P1)', async () => {
  const live = { id: 'p-ok', domain_id: 'd1', submission_url: 'https://ok.example/add', superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 1 };
  mockStore.seo_link_acquisition_paths.push(live);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, automation_policy: 'submit_free', priority: 'high', domain_rating: 40 };
  mockStore.seo_link_prospects.push(
    { ...base, id: 'r-unlinked', target_domain: 'new.example', path_id: null, target_url: 'https://new.example/add' },
    { ...base, id: 'r-ok', target_domain: 'ok.example', path_id: 'p-ok', target_url: 'https://ok.example/add' },
  );
  expect((await worker.claim({ n: 5, type: 'signup', preview: true })).map((r) => r.id)).toEqual(['r-ok']);
  expect((await worker.claim({ n: 5, type: 'signup' })).map((r) => r.id)).toEqual(['r-ok']);
});

test('claim keeps batching past any number of retired-path rows until a live one is leased (local Codex P1)', async () => {
  const live = { id: 'p-live', domain_id: 'dL', submission_url: 'https://live.example/add', superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 1 };
  mockStore.seo_link_acquisition_paths.push(live);
  const base = { status: 'prospect', link_type: worker.SIGNUP_TYPES[0], claimed_at: null, automation_policy: 'submit_free', priority: 'high' };
  for (let i = 0; i < 12; i++) { // twelve higher-ranked rows, each on its own retired path
    mockStore.seo_link_acquisition_paths.push({ id: `p-old-${i}`, domain_id: `d${i}`, submission_url: `https://d${i}.example/old`, superseded_by: `p-new-${i}`, link_type: 'directory', confidence: 0.7 }, { id: `p-new-${i}`, domain_id: `d${i}`, submission_url: `https://d${i}.example/new`, superseded_by: null, link_type: 'directory', confidence: 0.7, revision: 1 });
    mockStore.seo_link_prospects.push({ ...base, id: `r-old-${i}`, target_domain: `d${i}.example`, path_id: `p-old-${i}`, target_url: `https://d${i}.example/old`, domain_rating: 100 - i });
  }
  mockStore.seo_link_prospects.push({ ...base, id: 'r-live', target_domain: 'live.example', path_id: 'p-live', target_url: 'https://live.example/add', domain_rating: 1 });
  expect((await worker.claim({ n: 1, type: 'signup' })).map((r) => r.id)).toEqual(['r-live']);
  expect(mockStore.seo_link_prospects.filter((r) => r.id.startsWith('r-old-')).every((r) => r.path_id.startsWith('p-new-') && r.claimed_at == null)).toBe(true); // all twelve settled, none leased
});

