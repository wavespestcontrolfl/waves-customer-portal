/**
 * Step-1 backfills: legacy board → registry (domain + touches + path + links)
 * and seo_signup_attempts → seo_link_attempts (idempotent, keyed by
 * legacy_attempt_id). Run against a recording knex double; the one raw
 * fragment (the partial-index ON CONFLICT target) is compiled with real knex.
 */
const { backfillLegacyAttempts, backfillLegacyBoard, ATTEMPT_BATCH } = require('../services/seo/link-registry-backfill');

function fakeDb({ prospects = [], legacyAttempts = [], hasLegacyTable = true } = {}) {
  const store = { domains: [], sources: [], paths: [], attempts: [], prospectPatches: [] };
  let attemptsPass = 0;
  const builder = (table) => {
    const st = { insert: null, where: null, whereNull: [], first: false };
    const q = {
      insert(rows) { st.insert = rows; return q; },
      onConflict(c) { st.conflict = c; return q; },
      ignore() { return q; },
      returning() { return q.then(); },
      where(w) { st.where = w; return q; },
      whereNull(c) { st.whereNull.push(c); return q; },
      leftJoin() { return q; },
      orderBy() { return q; },
      limit() { return q; },
      select() { return q.then(); },
      async first() { return (await q.then())[0]; },
      update(patch) { store.prospectPatches.push({ where: st.where, patch }); return Promise.resolve(1); },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          const t = table.replace(/ as .*$/, '');
          if (st.insert) {
            if (t === 'seo_link_domains') {
              const dup = store.domains.find((d) => d.domain === st.insert.domain);
              if (dup) return [];
              const row = { id: `d${store.domains.length + 1}`, discovery_priority: 'normal', ...st.insert };
              store.domains.push(row); return [{ id: row.id }];
            }
            if (t === 'seo_link_domain_sources') {
              if (store.sources.some((s) => s.domain_id === st.insert.domain_id && s.touch_key === st.insert.touch_key)) return [];
              const row = { id: `s${store.sources.length + 1}`, ...st.insert }; store.sources.push(row); return [{ id: row.id }];
            }
            if (t === 'seo_link_acquisition_paths') {
              const row = { id: `path${store.paths.length + 1}`, ...st.insert }; store.paths.push(row); return [{ id: row.id }];
            }
            if (t === 'seo_link_attempts') {
              const fresh = st.insert.filter((a) => !store.attempts.some((x) => x.legacy_attempt_id === a.legacy_attempt_id));
              store.attempts.push(...fresh); return fresh.map((a, i) => ({ id: `att${store.attempts.length - fresh.length + i + 1}` }));
            }
            throw new Error(`unexpected insert ${t}`);
          }
          if (t === 'seo_link_prospects') return prospects;
          if (t === 'seo_link_domains') return store.domains.filter((d) => Object.entries(st.where || {}).every(([k, v]) => d[k] === v));
          if (t === 'seo_link_acquisition_paths') return store.paths.filter((p) => Object.entries(st.where || {}).every(([k, v]) => p[k] === v) && !p.superseded_by);
          if (t === 'seo_signup_attempts') {
            // rows with no twin yet (the LEFT JOIN … WHERE la.id IS NULL)
            attemptsPass += 1;
            return legacyAttempts.filter((a) => !store.attempts.some((x) => x.legacy_attempt_id === a.id)).slice(0, ATTEMPT_BATCH)
              .map((a) => ({ ...a, prospect_path_id: (prospects.find((p) => p.id === a.prospect_id) || {}).path_id || null }));
          }
          return [];
        }).then(resolve, reject);
      },
    };
    return q;
  };
  const db = jest.fn(builder);
  db.fn = { now: () => 'NOW()' };
  db.raw = (s) => ({ toString: () => s, sql: s });
  db.schema = { hasTable: jest.fn(async () => hasLegacyTable) };
  db._store = store;
  db._passes = () => attemptsPass;
  return db;
}

describe('backfillLegacyBoard (plan §4 legacy board backfill)', () => {
  const t0 = new Date('2026-06-23T10:00:00Z');
  const t1 = new Date('2026-07-15T10:00:00Z');
  const t2 = new Date('2026-08-01T10:00:00Z');
  const prospects = [
    // same canonical host under two spellings; earliest row is the first touch (manual → owner_seed)
    { id: 'p1', target_domain: 'www.Dir.Example', target_url: 'https://dir.example/add', link_type: 'directory', source: 'manual', source_ref: null, created_at: t0, domain_id: null, path_id: null, requires_account: false, requires_email_verification: false, requires_payment: false, detected_price_usd: null, offered_link_rel: 'nofollow' },
    { id: 'p2', target_domain: 'https://dir.example/', target_url: 'https://dir.example/add', link_type: 'directory', source: 'deep_harvest_2026-07-15', source_ref: null, created_at: t1, domain_id: null, path_id: null },
    { id: 'p3', target_domain: 'dir.example', target_url: null, link_type: 'editorial', source: 'strategy_agent', source_ref: 'run-1', created_at: t2, domain_id: null, path_id: null },
    // another host, already linked → untouched except its historical touch
    { id: 'p4', target_domain: 'done.example', target_url: 'https://done.example/x', link_type: 'resource', source: 'lost_recovery', source_ref: 'bl-1', created_at: t1, domain_id: 'dX', path_id: 'pX' },
    // unparseable host → skipped
    { id: 'p5', target_domain: '', target_url: null, link_type: null, source: 'manual', created_at: t2 },
  ];

  test('groups by canonical host; first-touch source from the earliest row; every row gets a historical touch (seen_at = its created_at)', async () => {
    const db = fakeDb({ prospects });
    const out = await backfillLegacyBoard(db);
    expect(out).toMatchObject({ domains: 2, domainsCreated: 2, paths: 2, linked: 3, skippedNoHost: 1 });
    const dir = db._store.domains.find((d) => d.domain === 'dir.example');
    expect(dir).toMatchObject({ source: 'owner_seed', source_detail: 'legacy:manual', discovery_priority: 'owner_seed', created_at: t0, agent_state: 'new' });
    const touches = db._store.sources.filter((s) => s.domain_id === dir.id).map((s) => [s.source, s.source_detail, s.seen_at]);
    expect(touches).toEqual([
      ['owner_seed', 'legacy:manual', t0],
      ['competitor_gap', 'legacy:deep_harvest_2026-07-15', t1],
      ['strategy_agent', 'legacy:strategy_agent', t2],
    ]);
    // never now(): every touch carries the legacy created_at
    expect(db._store.sources.every((s) => s.seen_at instanceof Date)).toBe(true);
    const done = db._store.domains.find((d) => d.domain === 'done.example');
    expect(done).toMatchObject({ source: 'lost_recovery', source_ref: 'bl-1', discovery_priority: 'normal' });
  });

  test('one active path per (domain, path_key): p1+p2 share the directory path; p3 gets an editorial path; links written only where missing', async () => {
    const db = fakeDb({ prospects });
    await backfillLegacyBoard(db);
    const dirId = db._store.domains.find((d) => d.domain === 'dir.example').id;
    const keys = db._store.paths.filter((p) => p.domain_id === dirId).map((p) => p.path_key).sort();
    expect(keys).toEqual(['editorial_outreach:-', 'self_service_account:https://dir.example/add']);
    const signupPath = db._store.paths.find((p) => p.path_key.startsWith('self_service_account'));
    expect(signupPath).toMatchObject({ acquisition_type: 'self_service_account', link_type: 'directory', account_required: false, email_verification: false, payment_required: false, legal_attestation: false, agent_completable: true, baseline: false, expected_rel: 'nofollow', confidence: 0.2, last_investigated_at: null });
    const patches = db._store.prospectPatches;
    expect(patches.map((p) => p.where.id).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(patches.find((p) => p.where.id === 'p1').patch).toMatchObject({ domain_id: dirId, path_id: signupPath.id });
    expect(patches.find((p) => p.where.id === 'p2').patch).toMatchObject({ domain_id: dirId, path_id: signupPath.id });
    // p4 was already linked → no patch, no path
    expect(patches.some((p) => p.where.id === 'p4')).toBe(false);
    expect(db._store.paths.some((p) => p.domain_id === db._store.domains.find((d) => d.domain === 'done.example').id)).toBe(false);
  });

  test('re-running against the linked board is a no-op (fixed point)', async () => {
    const db = fakeDb({ prospects });
    await backfillLegacyBoard(db);
    const linked = prospects.map((p) => {
      const patch = db._store.prospectPatches.find((x) => x.where.id === p.id);
      return patch ? { ...p, ...patch.patch } : p;
    });
    const before = JSON.stringify(db._store);
    const db2 = fakeDb({ prospects: linked });
    db2._store.domains = db._store.domains; db2._store.sources = db._store.sources; db2._store.paths = db._store.paths;
    const out = await backfillLegacyBoard(db2);
    expect(out).toMatchObject({ domainsCreated: 0, touches: 0, paths: 0, linked: 0 });
    expect(JSON.stringify(db._store)).toBe(before);
  });

  test('never inserts a board row (the pinned-writer guard stays intact)', async () => {
    const db = fakeDb({ prospects });
    await backfillLegacyBoard(db);
    expect(db._store.prospectPatches.every((p) => p.where && p.where.id)).toBe(true); // updates only, by id
    const fs = require('fs'); const path = require('path');
    expect(fs.readFileSync(path.join(__dirname, '..', 'services/seo/link-registry-backfill.js'), 'utf8')).not.toMatch(/seo_link_prospects'\)\.insert/);
  });
});

describe('backfillLegacyAttempts (plan §3.4 expand/contract)', () => {
  const legacy = [
    { id: 'L1', prospect_id: 'p1', outcome: 'submitted', mode: 'auto', cost_usd: '0', live_url: 'https://dir.example/waves', created_at: new Date('2026-07-01T00:00:00Z') },
    { id: 'L2', prospect_id: 'p2', outcome: 'blocked_payment', mode: 'auto', cost_usd: null, error_code: 'blocked_payment', created_at: new Date('2026-07-02T00:00:00Z') },
    { id: 'L3', prospect_id: null, outcome: 'garbage', created_at: new Date('2026-07-03T00:00:00Z') },
  ];
  const prospects = [{ id: 'p1', path_id: 'path-1' }, { id: 'p2', path_id: null }];

  test('copies every legacy row once: mapped outcome, provider deterministic_runner, path via the prospect, legacy id carried; re-run copies nothing', async () => {
    const db = fakeDb({ prospects, legacyAttempts: legacy });
    const r1 = await backfillLegacyAttempts(db);
    expect(r1).toEqual({ copied: 3, scanned: 3 });
    const rows = db._store.attempts;
    expect(rows.map((a) => [a.legacy_attempt_id, a.outcome, a.path_id, a.provider, a.action])).toEqual([
      ['L1', 'placed', 'path-1', 'deterministic_runner', 'submit'],
      ['L2', 'needs_owner', null, 'deterministic_runner', 'submit'],
      ['L3', 'failed', null, 'deterministic_runner', 'submit'],
    ]);
    expect(JSON.parse(rows[1].detail)).toMatchObject({ legacy_outcome: 'blocked_payment', error_code: 'blocked_payment' });
    expect(rows[0].created_at).toEqual(legacy[0].created_at);
    const r2 = await backfillLegacyAttempts(db);
    expect(r2).toEqual({ copied: 0, scanned: 0 });
    expect(db._store.attempts.length).toBe(3);
  });

  test('no legacy table (post-cleanup) → no-op; batches until the scan drains', async () => {
    const none = fakeDb({ hasLegacyTable: false });
    expect(await backfillLegacyAttempts(none)).toEqual({ copied: 0, scanned: 0 });
    expect(none).not.toHaveBeenCalled();
    const many = Array.from({ length: ATTEMPT_BATCH + 3 }, (_, i) => ({ id: `M${i}`, prospect_id: 'p1', outcome: 'failed', created_at: new Date(2026, 6, 1, 0, 0, i) }));
    const db = fakeDb({ prospects, legacyAttempts: many });
    const r = await backfillLegacyAttempts(db);
    expect(r).toEqual({ copied: ATTEMPT_BATCH + 3, scanned: ATTEMPT_BATCH + 3 });
    expect(db._passes()).toBe(2);
  });

  test('the ON CONFLICT target compiles to the partial unique index predicate with no stray binding', () => {
    const knex = require('knex')({ client: 'pg' });
    const { attemptFromLegacyRow } = require('../services/seo/link-registry');
    const q = knex('seo_link_attempts').insert([attemptFromLegacyRow({ id: 'L1', outcome: 'placed' })])
      .onConflict(knex.raw('(legacy_attempt_id) WHERE legacy_attempt_id IS NOT NULL')).ignore().returning(['id']).toSQL().toNative();
    expect(q.sql).toMatch(/on conflict \(legacy_attempt_id\) WHERE legacy_attempt_id IS NOT NULL do nothing returning "id"/i);
    expect(q.bindings.length).toBe(Object.keys(attemptFromLegacyRow({ id: 'L1', outcome: 'placed' })).length);
  });
});
