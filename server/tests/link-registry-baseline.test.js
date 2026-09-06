/**
 * Backlink Manager v2 step 2 — existing-profile baseline import (plan §4).
 * Runs importExistingBacklinks against an in-memory knex-shaped double that
 * enforces the real unique keys (domain, touch, active path_key, placement
 * triple, backlink_id) and records every write.
 */
const { importExistingBacklinks, _internals } = require('../services/seo/link-registry-baseline');
const R = require('../services/seo/link-registry');
const { SPOKE_SITE_KEYS } = require('../services/content-astro/spoke-sites');
const { LOCK_PREFIX } = require('../services/seo/prospect-domain-lock');

const HOME = 'https://wavespestcontrol.com/';
const TERMITE = 'https://www.wavespestcontrol.com/termite-control/';

// ---------------------------------------------------------------------------
// knex-shaped double
// ---------------------------------------------------------------------------
const canon = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^(www|mail)\./, '').replace(/[/:].*$/, '');
const UNIQUE = {
  seo_link_domains: (a, b) => a.domain === b.domain,
  seo_link_domain_sources: (a, b) => a.domain_id === b.domain_id && a.touch_key === b.touch_key,
  seo_link_acquisition_paths: (a, b) => a.domain_id === b.domain_id && a.path_key === b.path_key && a.superseded_by == null && b.superseded_by == null,
  seo_link_prospects: (a, b) => a.target_domain === b.target_domain && a.target_page === b.target_page && a.location_key === b.location_key,
  seo_link_placement_backlinks: (a, b) => a.backlink_id === b.backlink_id,
};

function fakeDb(seed = {}) {
  const store = {
    seo_backlinks: [], seo_link_domains: [], seo_link_domain_sources: [], seo_link_acquisition_paths: [],
    seo_link_attempts: [], seo_link_prospects: [], seo_link_placement_backlinks: [], ...seed,
  };
  const writes = [];
  const seq = {};
  const nextId = (table) => { seq[table] = (seq[table] || 0) + 1; return `${table.replace(/^seo_link_|^seo_/, '').slice(0, 4)}-${seq[table]}`; };

  function builder(table, group = null) {
    const st = { preds: [], insert: null, update: null, columns: null, first: false };
    const add = (fn, or = false) => { st.preds.push({ fn, or }); return q; };
    const cmp = (row, col, val) => (val === null ? row[col] == null : row[col] === val);
    const q = {
      insert(rows) { st.insert = Array.isArray(rows) ? rows : [rows]; return q; },
      onConflict() { return q; },
      ignore() { return q; },
      returning() { return q; },
      raw(s) { return s; },
      select(...cols) { st.columns = cols; return q; },
      where(a, b) {
        if (typeof a === 'function') {
          const sub = builder(table, true);
          a(sub);
          return add((row) => sub._eval(row));
        }
        if (typeof a === 'object') return add((row) => Object.entries(a).every(([k, v]) => cmp(row, k, v)));
        return add((row) => cmp(row, a, b));
      },
      orWhere(a, b) { return add((row) => cmp(row, a, b), true); },
      whereNot(a, b) { return add((row) => !cmp(row, a, b)); },
      whereNull(col) { return add((row) => row[col] == null); },
      whereNotNull(col) { return add((row) => row[col] != null); },
      whereIn(col, vals) { return add((row) => vals.includes(row[col])); },
      whereRaw(sql, bindings) {
        if (/target_domain/.test(sql)) return add((row) => canon(row.target_domain) === bindings[0]);
        throw new Error(`fake: unexpected whereRaw ${sql}`);
      },
      orderBy() { return q; },
      limit() { return q; },
      forUpdate() { return q; },
      first(...cols) { st.first = true; st.columns = cols; return q.then((r) => r[0] || null); },
      update(patch) { st.update = patch; return q; },
      _eval(row) {
        let ok = null;
        for (const p of st.preds) {
          const v = p.fn(row);
          ok = ok === null ? v : p.or ? ok || v : ok && v;
        }
        return ok === null ? true : ok;
      },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          const rows = store[table];
          if (!rows) throw new Error(`fake: unknown table ${table}`);
          if (st.insert) {
            const out = [];
            for (const r of st.insert) {
              if (rows.some((x) => UNIQUE[table](x, r))) continue; // ON CONFLICT DO NOTHING
              const row = { id: nextId(table), ...r };
              rows.push(row); out.push({ id: row.id });
              writes.push({ op: 'insert', table, row });
            }
            return out;
          }
          const matched = rows.filter((r) => q._eval(r));
          if (st.update) {
            for (const r of matched) { Object.assign(r, st.update); writes.push({ op: 'update', table, id: r.id, patch: st.update }); }
            return matched.length;
          }
          return matched.map((r) => ({ ...r }));
        }).then(resolve, reject);
      },
    };
    return q;
  }
  const db = jest.fn((table) => builder(table));
  store.raws = [];
  db.raw = jest.fn(async (s, b) => { store.raws.push([s, b]); return s; });
  db.fn = { now: () => 'NOW()' };
  db.transaction = jest.fn(async (fn) => fn(db));
  db._store = store;
  db._writes = writes;
  return db;
}

let n = 0;
function bl(over = {}) {
  n += 1;
  return {
    id: `b${String(n).padStart(2, '0')}`, status: 'active', discovery_source: null,
    source_url: `https://dir.example/listing-${n}`, source_domain: 'dir.example', target_url: 'https://wavespestcontrol.com/',
    anchor_text: null, domain_rating: 30, first_seen: '2026-06-01', is_dofollow: true, link_type: 'directory', ...over,
  };
}
beforeEach(() => { n = 0; });

const NOW = new Date('2026-08-30T00:00:00Z');

// ---------------------------------------------------------------------------

describe('scan-tracked source predicate + grouping (pure)', () => {
  test('only active, scan-tracked rows are scanned (GSC export rows are history, not evidence)', async () => {
    const db = fakeDb({ seo_backlinks: [
      bl(), bl({ discovery_source: 'dataforseo' }), bl({ discovery_source: 'gsc_links_export' }), bl({ status: 'lost' }), bl({ status: 'disavowed', discovery_source: 'dataforseo' }),
    ] });
    const r = await importExistingBacklinks(db, { now: NOW });
    expect(r.scanned).toBe(2);
    expect(db._store.seo_link_placement_backlinks.map((m) => m.backlink_id).sort()).toEqual(['b01', 'b02']);
  });
  test('representative order: dofollow beats nofollow, then earliest first_seen, then id; NULL is_dofollow sorts last', () => {
    const rows = [
      { id: 'z', is_dofollow: null, first_seen: '2025-01-01' },
      { id: 'c', is_dofollow: false, first_seen: '2025-01-01' },
      { id: 'b', is_dofollow: true, first_seen: '2026-02-01' },
      { id: 'a', is_dofollow: true, first_seen: '2026-01-01' },
      { id: 'a0', is_dofollow: true, first_seen: '2026-01-01' },
      { id: 'y', is_dofollow: null, first_seen: null },
    ];
    expect([...rows].sort(_internals.representativeOrder).map((r) => r.id)).toEqual(['a', 'a0', 'b', 'c', 'z', 'y']);
  });
  test('host comes from source_domain, else the source_url host; own + never-target hosts are skipped with a reason', () => {
    const rows = [
      bl({ source_domain: 'WWW.Dir.Example' }),
      bl({ source_domain: '', source_url: 'https://www.other.example/p' }),
      bl({ source_domain: '', source_url: 'not a url' }),
      bl({ source_domain: 'blog.wavespestcontrol.com' }),
      bl({ source_domain: SPOKE_SITE_KEYS[0] }),
      bl({ source_domain: 'x.com' }),
      bl({ source_domain: 'maps.google.com' }),
    ];
    const { domains, skipped } = _internals.groupProfile(rows);
    expect(domains.map((d) => d.host)).toEqual(['dir.example', 'other.example']);
    expect(skipped).toEqual([
      { backlink_id: 'b03', reason: 'no_host' },
      { backlink_id: 'b04', reason: 'own_domain' },
      { backlink_id: 'b05', reason: 'own_domain' },
      { backlink_id: 'b06', reason: 'never_target' },
      { backlink_id: 'b07', reason: 'never_target' },
    ]);
  });
});

describe('importExistingBacklinks (live)', () => {
  test('one domain (acquired), one baseline path, one representative placement per target page, every backlink mapped', async () => {
    const db = fakeDb({ seo_backlinks: [
      bl({ is_dofollow: false, first_seen: '2025-03-01' }),                       // b01 nofollow, earliest
      bl({ is_dofollow: true, first_seen: '2026-02-01' }),                        // b02 dofollow, later
      bl({ is_dofollow: true, first_seen: '2026-01-01', source_url: 'https://dir.example/best' }), // b03 dofollow, earliest dofollow → representative
      bl({ is_dofollow: null, first_seen: '2024-01-01' }),                        // b04 unknown rel (GSC-style null)
      bl({ target_url: 'https://www.wavespestcontrol.com/termite-control', is_dofollow: false, link_type: 'forum' }), // b05 other page
    ] });
    const r = await importExistingBacklinks(db, { now: NOW });
    expect(r).toEqual({ dryRun: false, scanned: 5, domainsCreated: 1, domainsTouched: 1, placementsCreated: 2, placementsExisting: 0, placementsReconciled: 0, mappingsCreated: 5, pathsCreated: 1, skipped: [] });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    // board admission under the shared per-domain advisory lock, inside the transaction
    expect(db._store.raws).toContainEqual(['SELECT pg_advisory_xact_lock(hashtext(?))', [`${LOCK_PREFIX}dir.example`]]);

    const [dom] = db._store.seo_link_domains;
    expect(dom).toMatchObject({ domain: 'dir.example', source: 'existing_backlink', source_detail: 'baseline_import', agent_state: 'acquired', discovery_priority: 'normal' });
    expect(db._store.seo_link_domain_sources).toEqual([expect.objectContaining({ domain_id: dom.id, source: 'existing_backlink', touch_key: 'existing_backlink:baseline_import', seen_at: new Date('2024-01-01') })]);

    const [path] = db._store.seo_link_acquisition_paths;
    expect(path).toMatchObject({
      domain_id: dom.id, acquisition_type: 'self_service_account', baseline: true, path_key: 'self_service_account:baseline:dir.example', // directory lane → the shared mapping
      account_required: false, email_verification: false, payment_required: false, legal_attestation: false, agent_completable: false,
      terms_accepted_by_send: false, execution_after_send: true,
      expected_rel: 'dofollow', expected_indexability: 'unknown', expected_persistence: 'unknown', link_type: 'directory',
      confidence: 0.1, last_investigated_at: null, submission_url: 'https://dir.example/best',
    });
    expect(JSON.parse(path.investigation)).toEqual({ baseline: true, backlink_count: 5 });
    expect(R.ACQUISITION_TYPES).toContain(path.acquisition_type);
    expect(R.PATH_LINK_TYPES).toContain(path.link_type);
    for (const k of ['account_required', 'email_verification', 'payment_required', 'legal_attestation', 'agent_completable', 'baseline', 'terms_accepted_by_send', 'execution_after_send']) expect(typeof path[k]).toBe('boolean');
    expect(dom.best_path_id).toBe(path.id);

    const placements = db._store.seo_link_prospects;
    expect(placements.length).toBe(2);
    const home = placements.find((p) => p.target_page === HOME);
    const termite = placements.find((p) => p.target_page === TERMITE);
    expect(home).toMatchObject({
      target_domain: 'dir.example', status: 'live', source: 'existing_backlink', source_detail: 'baseline_import', location_key: '-',
      link_type: 'directory', live_url: 'https://dir.example/best', target_url: 'https://dir.example/best', is_dofollow: true,
      first_live_at: '2026-01-01', backlink_id: 'b03', domain_id: dom.id, path_id: path.id,
    });
    expect(termite).toMatchObject({ status: 'live', link_type: 'resource', is_dofollow: false, backlink_id: 'b05', live_url: 'https://dir.example/listing-5' });
    // D30/D90 and every learning field: never written
    for (const p of placements) for (const k of Object.keys(p)) expect(k).not.toMatch(/d30|d90|survived|learn/i);
    for (const k of Object.keys(path)) expect(k).not.toMatch(/d30|d90|survived|learn/i);

    const maps = db._store.seo_link_placement_backlinks;
    expect(maps.map((m) => [m.backlink_id, m.prospect_id === home.id ? 'home' : m.prospect_id === termite.id ? 'termite' : '?']).sort()).toEqual([
      ['b01', 'home'], ['b02', 'home'], ['b03', 'home'], ['b04', 'home'], ['b05', 'termite'],
    ]);
  });

  test('a nofollow-only host still gets a representative (earliest nofollow) and expected_rel=nofollow; NULL-only → unknown', async () => {
    const db = fakeDb({ seo_backlinks: [
      bl({ is_dofollow: false, first_seen: '2026-05-01' }),
      bl({ is_dofollow: false, first_seen: '2026-04-01', source_url: 'https://dir.example/early' }),
      bl({ is_dofollow: null, first_seen: '2020-01-01' }),
      bl({ source_domain: 'nul.example', is_dofollow: null, source_url: 'https://nul.example/a', link_type: null }),
    ] });
    await importExistingBacklinks(db, { now: NOW });
    const dir = db._store.seo_link_prospects.find((p) => p.target_domain === 'dir.example');
    expect(dir).toMatchObject({ backlink_id: 'b02', live_url: 'https://dir.example/early', is_dofollow: false });
    expect(db._store.seo_link_acquisition_paths.find((p) => p.path_key === 'self_service_account:baseline:dir.example').expected_rel).toBe('nofollow');
    const nul = db._store.seo_link_prospects.find((p) => p.target_domain === 'nul.example');
    expect(nul).toMatchObject({ backlink_id: 'b04', is_dofollow: null, link_type: 'resource' }); // classifier found nothing → unknown → non-claimable lane
    expect(db._store.seo_link_acquisition_paths.find((p) => p.path_key === 'unknown:baseline:nul.example')).toMatchObject({ expected_rel: 'unknown', link_type: 'resource', acquisition_type: 'unknown' }); // classifier found nothing → unknown
  });

  test('idempotent: a second run creates nothing; a newly seen link is only mapped, the representative is never re-picked', async () => {
    const db = fakeDb({ seo_backlinks: [bl({ is_dofollow: false, first_seen: '2026-01-01' }), bl({ source_domain: 'two.example', source_url: 'https://two.example/x' })] });
    const r1 = await importExistingBacklinks(db, { now: NOW });
    expect(r1).toMatchObject({ domainsCreated: 2, pathsCreated: 2, placementsCreated: 2, mappingsCreated: 2 });
    const before = db._writes.length;
    const r2 = await importExistingBacklinks(db, { now: NOW });
    expect(r2).toEqual({ dryRun: false, scanned: 2, domainsCreated: 0, domainsTouched: 0, placementsCreated: 0, placementsExisting: 2, placementsReconciled: 0, mappingsCreated: 0, pathsCreated: 0, skipped: [] });
    expect(db._writes.length).toBe(before);
    expect(db._store.seo_link_domains.length).toBe(2);
    expect(db._store.seo_link_domain_sources.length).toBe(2);
    expect(db._store.seo_link_acquisition_paths.length).toBe(2);
    expect(db._store.seo_link_prospects.length).toBe(2);
    expect(db._store.seo_link_placement_backlinks.length).toBe(2);
    // a better (dofollow) link appears later: mapped to the existing placement, representative untouched
    db._store.seo_backlinks.push(bl({ is_dofollow: true, first_seen: '2026-08-01' }));
    const r3 = await importExistingBacklinks(db, { now: NOW });
    expect(r3).toMatchObject({ domainsCreated: 0, pathsCreated: 0, placementsCreated: 0, placementsExisting: 2, mappingsCreated: 1 });
    const dir = db._store.seo_link_prospects.find((p) => p.target_domain === 'dir.example');
    expect(dir.backlink_id).toBe('b01');
    expect(db._store.seo_link_placement_backlinks.filter((m) => m.prospect_id === dir.id).map((m) => m.backlink_id).sort()).toEqual(['b01', 'b03']);
    expect(db._writes.slice(before).filter((w) => w.op === 'update')).toEqual([]);
  });

  test('a GBP-scoped placement for the same (host, page) is NOT reused: the baseline owns the distinct unscoped row', async () => {
    const db = fakeDb({
      seo_backlinks: [bl()],
      seo_link_prospects: [{ id: 'pr-scoped', target_domain: 'dir.example', target_page: 'https://www.wavespestcontrol.com/', location_key: 'sarasota', status: 'live', backlink_id: null }],
    });
    const r = await importExistingBacklinks(db, { now: NOW });
    expect(r).toMatchObject({ placementsCreated: 1, placementsExisting: 0, mappingsCreated: 1 });
    const rows = db._store.seo_link_prospects.filter((p) => canon(p.target_domain) === 'dir.example');
    expect(rows.map((p) => p.location_key).sort()).toEqual(['-', 'sarasota']);
    const unscoped = rows.find((p) => p.location_key === '-');
    expect(unscoped.id).not.toBe('pr-scoped');
    expect(db._store.seo_link_placement_backlinks.find((m) => m.backlink_id === 'b01').prospect_id).toBe(unscoped.id);
    expect(db._store.seo_link_prospects.find((p) => p.id === 'pr-scoped')).toMatchObject({ status: 'live', backlink_id: null });
  });

  test('a reused board row is reconciled to the live evidence: an unsent prospect → live + un-claimed; placed/lost → live; a row mid-outreach is left alone; live rows with a live_url untouched', async () => {
    const page = 'https://www.wavespestcontrol.com/';
    const seed = (id, host, extra) => ({ id, target_domain: host, target_page: page, location_key: '-', backlink_id: null, ...extra });
    const db = fakeDb({
      seo_backlinks: [
        bl(), // dir.example
        bl({ source_domain: 'placed.example', source_url: 'https://placed.example/a', is_dofollow: true, first_seen: '2026-03-01' }),
        bl({ source_domain: 'mid.example', source_url: 'https://mid.example/a' }),
        bl({ source_domain: 'done.example', source_url: 'https://done.example/a' }),
      ],
      seo_link_prospects: [
        seed('pr-prospect', 'dir.example', { status: 'prospect', outreach_status: 'drafted', outreach_sent_at: null, claimed_by: 'worker-1', claimed_at: NOW }),
        seed('pr-placed', 'placed.example', { status: 'placed', first_live_at: null }),
        seed('pr-mid', 'mid.example', { status: 'contacted' }),
        seed('pr-done', 'done.example', { status: 'live', live_url: 'https://done.example/old', backlink_id: 'b-old' }),
      ],
    });
    const r = await importExistingBacklinks(db, { now: NOW });
    expect(r).toMatchObject({ placementsCreated: 0, placementsExisting: 4, placementsReconciled: 4 }); // 2 promotions + 2 FK-only linkages
    const byId = Object.fromEntries(db._store.seo_link_prospects.map((p) => [p.id, p]));
    expect(byId['pr-prospect']).toMatchObject({ status: 'live', live_url: 'https://dir.example/listing-1', backlink_id: 'b01', outreach_status: 'none', claimed_by: null, claimed_at: null, first_live_at: '2026-06-01' });
    expect(byId['pr-placed']).toMatchObject({ status: 'live', live_url: 'https://placed.example/a', backlink_id: 'b02', is_dofollow: true, first_live_at: '2026-03-01' });
    expect(byId['pr-mid']).toMatchObject({ status: 'contacted', backlink_id: null }); // status untouched…
    expect(byId['pr-mid'].domain_id).toBeTruthy(); // …but the registry FKs are linked
    expect(byId['pr-mid'].path_id).toBeTruthy();
    expect(byId['pr-done']).toMatchObject({ status: 'live', live_url: 'https://done.example/old', backlink_id: 'b-old' });
    expect(byId['pr-done'].domain_id).toBeTruthy(); // evidenced rows still get missing FKs, nothing else
    // a live row that never had a representative gets one (backlink_id) without changing status or live_url
    const b = bl();
    const db3 = fakeDb({ seo_backlinks: [b], seo_link_prospects: [seed('pr-live-norep', 'dir.example', { status: 'live', live_url: 'https://dir.example/kept', backlink_id: null })] });
    const r3 = await importExistingBacklinks(db3, { now: NOW });
    expect(r3).toMatchObject({ placementsExisting: 1, placementsReconciled: 1 });
    expect(db3._store.seo_link_prospects[0]).toMatchObject({ status: 'live', live_url: 'https://dir.example/kept', backlink_id: b.id });
    // every backlink is still mapped to its (reused) placement
    expect(db._store.seo_link_placement_backlinks.map((m) => m.prospect_id).sort()).toEqual(['pr-done', 'pr-mid', 'pr-placed', 'pr-prospect']);
    // a prospect whose outreach already went out is NOT promoted (the send finalizer owns it)
    const db2 = fakeDb({ seo_backlinks: [bl()], seo_link_prospects: [seed('pr-sent', 'dir.example', { status: 'prospect', outreach_status: 'sent', outreach_sent_at: NOW })] });
    const r2 = await importExistingBacklinks(db2, { now: NOW });
    expect(r2).toMatchObject({ placementsExisting: 1, placementsReconciled: 0 });
    expect(db2._store.seo_link_prospects[0]).toMatchObject({ status: 'prospect', outreach_status: 'sent', backlink_id: null });
  });

  test('a scan row with NULL link_type is classified through the scan\'s own classifier before lanes are derived (yelp → directory → self_service_account), and live evidence promotes a stale new domain to acquired', async () => {
    const db = fakeDb({
      seo_backlinks: [bl({ source_domain: 'yelp.com.example', link_type: null, source_url: 'https://yelp.com.example/business/waves' })],
      seo_link_domains: [{ id: 'dom-n', domain: 'yelp.com.example', source: 'competitor_gap', discovery_priority: 'normal', agent_state: 'new', best_path_id: null }],
    });
    const r = await importExistingBacklinks(db, { now: NOW });
    const path = db._store.seo_link_acquisition_paths[0];
    expect(path).toMatchObject({ acquisition_type: 'self_service_account', link_type: 'directory', path_key: 'self_service_account:baseline:yelp.com.example' });
    expect(db._store.seo_link_prospects[0].link_type).toBe('directory');
    expect(db._store.seo_link_domains[0].agent_state).toBe('acquired'); // live evidence promotes 'new'
    void r;
  });

  test('the baseline path is reused by its DOMAIN identity: a later scan with a different-lane representative never mints a sibling baseline path', async () => {
    const db = fakeDb({ seo_backlinks: [bl({ link_type: 'editorial', source_url: 'https://dir.example/story' })], seo_link_acquisition_paths: [{ id: 'p-base', domain_id: 'dom-1', path_key: 'self_service_account:baseline:dir.example', baseline: true, superseded_by: null }], seo_link_domains: [{ id: 'dom-1', domain: 'dir.example', source: 'existing_backlink', discovery_priority: 'normal', agent_state: 'acquired', best_path_id: 'p-base' }] });
    const r = await importExistingBacklinks(db, { now: NOW });
    expect(r.pathsCreated).toBe(0);
    expect(db._store.seo_link_acquisition_paths).toHaveLength(1); // reused, no editorial sibling
    expect(db._store.seo_link_prospects[0].path_id).toBe('p-base');
  });

  test('a known domain keeps its agent_state, first-touch source and best_path_id; an existing board row (any spelling) is reused', async () => {
    const db = fakeDb({
      seo_backlinks: [bl(), bl({ source_domain: 'fresh.example', source_url: 'https://fresh.example/a' })],
      seo_link_domains: [{ id: 'd-known', domain: 'dir.example', source: 'competitor_gap', discovery_priority: 'normal', agent_state: 'investigating', best_path_id: 'p-real' }],
      seo_link_acquisition_paths: [{ id: 'p-real', domain_id: 'd-known', path_key: 'self_service_account:https://dir.example/add', superseded_by: null }],
      seo_link_prospects: [{ id: 'pr-known', target_domain: 'www.dir.example', target_page: 'https://www.wavespestcontrol.com/', location_key: '-', status: 'indexed', backlink_id: null }],
    });
    const r = await importExistingBacklinks(db, { now: NOW });
    expect(r).toMatchObject({ domainsCreated: 1, domainsTouched: 2, pathsCreated: 2, placementsCreated: 1, placementsExisting: 1, mappingsCreated: 2 });
    const known = db._store.seo_link_domains.find((d) => d.id === 'd-known');
    expect(known).toMatchObject({ source: 'competitor_gap', agent_state: 'investigating', best_path_id: 'p-real' });
    expect(db._store.seo_link_acquisition_paths.filter((p) => p.domain_id === 'd-known').map((p) => p.path_key).sort()).toEqual(['self_service_account:baseline:dir.example', 'self_service_account:https://dir.example/add']);
    // the existing board row was reused: no second dir.example placement, mapping points at it; an indexed row
    // keeps its status and only gains the live evidence it lacked (live_url / backlink_id)
    expect(db._store.seo_link_prospects.filter((p) => canon(p.target_domain) === 'dir.example')).toEqual([expect.objectContaining({ id: 'pr-known', status: 'indexed', backlink_id: 'b01', live_url: 'https://dir.example/listing-1' })]);
    expect(r.placementsReconciled).toBe(1);
    expect(db._store.seo_link_placement_backlinks.find((m) => m.backlink_id === 'b01').prospect_id).toBe('pr-known');
    const fresh = db._store.seo_link_domains.find((d) => d.domain === 'fresh.example');
    expect(fresh.agent_state).toBe('acquired');
    expect(fresh.best_path_id).toBe(db._store.seo_link_acquisition_paths.find((p) => p.domain_id === fresh.id).id);
  });

  test('never-target and own hosts are skipped with a reason and produce no rows; limit caps domains', async () => {
    const db = fakeDb({ seo_backlinks: [
      bl({ source_domain: 'twitter.com' }), bl({ source_domain: 'www.wavespestcontrol.com' }), bl({ source_domain: SPOKE_SITE_KEYS[1] || SPOKE_SITE_KEYS[0] }),
      bl({ source_domain: 'b.example', source_url: 'https://b.example/1' }), bl({ source_domain: 'a.example', source_url: 'https://a.example/1' }), bl({ source_domain: 'c.example', source_url: 'https://c.example/1' }),
    ] });
    const r = await importExistingBacklinks(db, { now: NOW, limit: 2 });
    expect(r.skipped).toEqual([{ backlink_id: 'b01', reason: 'never_target' }, { backlink_id: 'b02', reason: 'own_domain' }, { backlink_id: 'b03', reason: 'own_domain' }]);
    expect(r).toMatchObject({ scanned: 6, domainsCreated: 2, placementsCreated: 2, mappingsCreated: 2 });
    expect(db._store.seo_link_domains.map((d) => d.domain)).toEqual(['a.example', 'b.example']);
    expect(db._store.seo_link_placement_backlinks.map((m) => m.backlink_id)).toEqual(['b05', 'b04']);
  });
});

describe('importExistingBacklinks (dryRun)', () => {
  test('reports the same counts with zero writes and no transaction; on a fully imported profile every create count is zero', async () => {
    const db = fakeDb({ seo_backlinks: [bl({ is_dofollow: false }), bl(), bl({ source_domain: 'two.example', source_url: 'https://two.example/x' }), bl({ source_domain: 'x.com' })] });
    const dry = await importExistingBacklinks(db, { dryRun: true, now: NOW });
    expect(dry).toEqual({ dryRun: true, scanned: 4, domainsCreated: 2, domainsTouched: 2, placementsCreated: 2, placementsExisting: 0, placementsReconciled: 0, mappingsCreated: 3, pathsCreated: 2, skipped: [{ backlink_id: 'b04', reason: 'never_target' }] });
    expect(db._writes).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db._store.raws.filter(([s]) => /pg_advisory_xact_lock/.test(String(s)))).toEqual([]); // no lock outside a transaction
    for (const t of ['seo_link_domains', 'seo_link_domain_sources', 'seo_link_acquisition_paths', 'seo_link_prospects', 'seo_link_placement_backlinks']) expect(db._store[t]).toEqual([]);

    const live = await importExistingBacklinks(db, { now: NOW });
    expect(live).toEqual({ ...dry, dryRun: false });
    const after = db._writes.length;
    const dry2 = await importExistingBacklinks(db, { dryRun: true, now: NOW });
    expect(dry2).toEqual({ dryRun: true, scanned: 4, domainsCreated: 0, domainsTouched: 0, placementsCreated: 0, placementsExisting: 2, placementsReconciled: 0, mappingsCreated: 0, pathsCreated: 0, skipped: [{ backlink_id: 'b04', reason: 'never_target' }] });
    expect(db._writes.length).toBe(after);
  });
  test('an empty profile returns zero counts without opening a transaction', async () => {
    const db = fakeDb();
    expect(await importExistingBacklinks(db, { dryRun: false })).toEqual({ dryRun: false, scanned: 0, domainsCreated: 0, domainsTouched: 0, placementsCreated: 0, placementsExisting: 0, placementsReconciled: 0, mappingsCreated: 0, pathsCreated: 0, skipped: [] });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
