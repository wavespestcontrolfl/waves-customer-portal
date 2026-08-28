/**
 * Backlink Manager v2 step 1 — registry primitives + intake skeleton.
 * Pure mappings are pinned exactly (the migration CHECKs them); ensureDomain /
 * intake run against a knex-shaped double that records every write.
 */
const R = require('../services/seo/link-registry');
const { parseOpportunities, intake } = require('../services/seo/link-registry-intake');
const { CLAIMABLE_LINK_TYPES } = require('../services/seo/prospect-scorer');
const { SPOKE_SITE_KEYS } = require('../services/content-astro/spoke-sites');

describe('enums (plan §3)', () => {
  test('§3.5 provenance is the plan list, legacy_unknown included, no duplicates', () => {
    expect(R.LINK_SOURCES).toEqual(['owner_seed', 'list_import', 'competitor_gap', 'competitor_clone', 'recursive', 'x', 'google_search', 'dataforseo', 'strategy_agent', 'existing_backlink', 'lost_recovery', 'local_opportunity', 'legacy_unknown']);
    for (const arr of [R.LINK_SOURCES, R.AGENT_STATES, R.ACQUISITION_TYPES, R.ATTEMPT_OUTCOMES, R.AUTHORITY_LEVELS, R.ATTEMPT_PROVIDERS, R.ATTEMPT_ACTIONS]) {
      expect(new Set(arr).size).toBe(arr.length);
      expect(Object.isFrozen(arr)).toBe(true);
    }
  });
  test('path link_type set == the worker-claimable lanes (a path can never carry a lane nothing can lease)', () => {
    expect(new Set(R.PATH_LINK_TYPES)).toEqual(CLAIMABLE_LINK_TYPES);
  });
  test('§6.1 levels: OWNER_OVERRIDE is never a dimension level; DENY/INVALID are', () => {
    expect(R.AUTHORITY_LEVELS).not.toContain('OWNER_OVERRIDE');
    expect(R.AUTHORITY_LEVELS).toEqual(expect.arrayContaining(['AUTO_FREE', 'AUTO_PAID_WITHIN_POLICY', 'OWNER_MANUAL_PAYMENT', 'OWNER_HUMAN_STEP', 'DENY', 'INVALID']));
    expect(R.AUTHORITY_DIMENSIONS).toEqual(['execution', 'payment', 'communication']);
  });
  test('§3.4 outcome enum holds every state the plan names, send_error included', () => {
    for (const o of ['slot_reserved', 'submitting', 'submit_ambiguous', 'placed', 'pending', 'drafted', 'sent', 'failed', 'skipped', 'blocked', 'captcha', 'needs_owner', 'human_step_done', 'ready_for_payment', 'ready_for_credentials', 'no_payment_required', 'price_changed', 'instrument_unavailable', 'auto_renew_unavoidable', 'payment_ambiguous', 'mint_not_started', 'terms_changed', 'send_error', 'sandbox_replay']) {
      expect(R.ATTEMPT_OUTCOMES).toContain(o);
    }
    expect(R.ATTEMPT_OUTCOMES.length).toBe(24);
  });
});

describe('legacy mappings (plan §4 / §3.4)', () => {
  test('mapLegacySource is exhaustive over the enum and keeps the verbatim value', () => {
    const cases = {
      manual: 'owner_seed', strategy_agent: 'strategy_agent', lost_recovery: 'lost_recovery', competitor_gap: 'competitor_gap',
      'local_opportunity_2026-07-01': 'local_opportunity', local_opportunity: 'local_opportunity',
      'deep_harvest_2026-06-30': 'competitor_gap', signup_agent: 'x', existing_backlink: 'existing_backlink',
      'competitor-gap-miner': 'legacy_unknown', '': 'legacy_unknown', weird: 'legacy_unknown',
    };
    for (const [legacy, source] of Object.entries(cases)) {
      const m = R.mapLegacySource(legacy);
      expect(m.source).toBe(source);
      expect(R.LINK_SOURCES).toContain(m.source);
      expect(m.source_detail).toBe(`legacy:${legacy || '-'}`);
    }
    expect(R.mapLegacySource(null)).toEqual({ source: 'legacy_unknown', source_detail: 'legacy:-' });
    // a date-suffixed prefix that is NOT local_opportunity/deep_harvest stays unknown (no prefix guessing)
    expect(R.mapLegacySource('local_opportunityx').source).toBe('legacy_unknown');
  });
  test('mapLegacyOutcome lands every legacy value inside the CHECK enum', () => {
    const cases = { blocked_account: 'needs_owner', blocked_payment: 'needs_owner', blocked_phone: 'needs_owner', blocked_phone_verification: 'needs_owner', blocked_price_changed: 'price_changed', blocked_captcha: 'captcha', submitted: 'placed', placed: 'placed', pending: 'pending', skipped: 'skipped', failed: 'failed', error: 'failed', '': 'failed', garbage: 'failed' };
    for (const [legacy, v2] of Object.entries(cases)) {
      expect(R.mapLegacyOutcome(legacy)).toBe(v2);
      expect(R.ATTEMPT_OUTCOMES).toContain(v2);
    }
    expect(R.mapLegacyOutcome(undefined)).toBe('failed');
    // every blocked_* the filler/runner can emit is an owner park, never a failure
    const fs = require('fs'); const path = require('path');
    const emitted = new Set();
    for (const f of ['browser-form-filler.js', 'signup-runner.js', 'signup-classifier.js']) {
      for (const m of fs.readFileSync(path.join(__dirname, '..', 'services/seo', f), 'utf8').matchAll(/blocked_[a-z_]+/g)) emitted.add(m[0]);
    }
    expect(emitted.size).toBeGreaterThanOrEqual(5);
    for (const o of emitted) expect({ o, mapped: R.mapLegacyOutcome(o) }).not.toEqual({ o, mapped: 'failed' });
  });
  test('lane → acquisition type; non-claimable lanes → unknown/resource', () => {
    expect(R.acquisitionTypeForLinkType('editorial')).toBe('editorial_outreach');
    expect(R.acquisitionTypeForLinkType('guest_post')).toBe('editorial_outreach');
    expect(R.acquisitionTypeForLinkType('haro')).toBe('editorial_outreach');
    expect(R.acquisitionTypeForLinkType('resource')).toBe('resource_outreach');
    for (const t of ['directory', 'citation', 'social']) expect(R.acquisitionTypeForLinkType(t)).toBe('self_service_account');
    for (const t of ['forum', 'comment', null, undefined, 'unknown']) {
      expect(R.acquisitionTypeForLinkType(t)).toBe('unknown');
      expect(R.pathLinkTypeFor(t)).toBe('resource');
    }
    for (const t of R.PATH_LINK_TYPES) expect(R.ACQUISITION_TYPES).toContain(R.acquisitionTypeForLinkType(t));
  });
  test('path_key = type:normalized url — host lower/no-www, no fragment, no trailing slash, "-" when empty', () => {
    expect(R.pathKey('self_service_account', 'HTTPS://WWW.Example.com/Add/#top')).toBe('self_service_account:https://example.com/Add');
    expect(R.pathKey('self_service_account', 'https://www.example.com/')).toBe('self_service_account:https://example.com');
    expect(R.pathKey('resource_outreach', 'example.com/resources/?a=1')).toBe('resource_outreach:https://example.com/resources/?a=1');
    expect(R.pathKey('unknown', '')).toBe('unknown:-');
    expect(R.pathKey('unknown', null)).toBe('unknown:-');
  });
  test('acquisitionPathFromLegacyRow: every NOT NULL boolean explicit, classifier answers honored, never paid, uninvestigated', () => {
    const signup = R.acquisitionPathFromLegacyRow({ link_type: 'directory', target_url: 'https://dir.example/add', requires_account: false, requires_email_verification: true, requires_payment: null, detected_price_usd: '12.50', offered_link_rel: 'nofollow' });
    expect(signup).toMatchObject({ acquisition_type: 'self_service_account', link_type: 'directory', account_required: false, email_verification: true, payment_required: false, legal_attestation: false, agent_completable: true, baseline: false, expected_rel: 'nofollow', estimated_cost_cents: 1250, confidence: 0.2, last_investigated_at: null, path_key: 'self_service_account:https://dir.example/add' });
    expect(R.PAID_ACQUISITION_TYPES).not.toContain(signup.acquisition_type);
    const outreach = R.acquisitionPathFromLegacyRow({ link_type: 'editorial', target_url: null, offered_link_rel: 'weird' });
    expect(outreach).toMatchObject({ acquisition_type: 'editorial_outreach', account_required: false, email_verification: false, payment_required: false, agent_completable: true, expected_rel: 'unknown', estimated_cost_cents: null, path_key: 'editorial_outreach:-' });
    const orphan = R.acquisitionPathFromLegacyRow({ link_type: null, target_url: 'https://x.example' });
    expect(orphan).toMatchObject({ acquisition_type: 'unknown', link_type: 'resource', agent_completable: false, account_required: false });
    // default for an unclassified signup row is account_required=true (fail-closed for the runner)
    expect(R.acquisitionPathFromLegacyRow({ link_type: 'citation' }).account_required).toBe(true);
    for (const p of [signup, outreach, orphan]) {
      for (const k of ['account_required', 'email_verification', 'payment_required', 'legal_attestation', 'agent_completable', 'baseline']) expect(typeof p[k]).toBe('boolean');
      expect(R.PATH_LINK_TYPES).toContain(p.link_type);
      expect(R.ACQUISITION_TYPES).toContain(p.acquisition_type);
    }
  });
  test('attemptFromLegacyRow: provider/action fixed, outcome mapped, verbatim legacy kept in detail, legacy id carried, timestamps preserved', () => {
    const created = new Date('2026-07-01T10:00:00Z');
    const a = R.attemptFromLegacyRow({ id: 'L1', prospect_id: 'P1', outcome: 'blocked_captcha', mode: 'auto', live_url: null, evidence_url: 'e.png', screenshot_url: 'e.png', cost_usd: '0.25', link_rel: 'nofollow', indexed: null, error_code: 'blocked_captcha', error_message: 'captcha wall', created_at: created, updated_at: created }, { pathId: 'PATH' });
    expect(a).toMatchObject({ prospect_id: 'P1', path_id: 'PATH', provider: 'deterministic_runner', action: 'submit', outcome: 'captcha', cost_cents: 25, sandbox: false, evidence_url: 'e.png', legacy_attempt_id: 'L1', created_at: created, updated_at: created });
    expect(JSON.parse(a.detail)).toEqual({ legacy_outcome: 'blocked_captcha', mode: 'auto', live_url: null, link_rel: 'nofollow', indexed: null, error_code: 'blocked_captcha', error_message: 'captcha wall', screenshot_url: 'e.png' });
    expect(R.attemptFromLegacyRow({ id: 'L2', outcome: 'submitted', cost_usd: null }).cost_cents).toBeNull();
    // placed/submitted WITHOUT a live URL = moderation pending (same rule as the live writer)
    expect(R.attemptFromLegacyRow({ id: 'L3', outcome: 'placed' }).outcome).toBe('pending');
    expect(R.attemptFromLegacyRow({ id: 'L4', outcome: 'submitted', live_url: '' }).outcome).toBe('pending');
    expect(R.attemptFromLegacyRow({ id: 'L5', outcome: 'placed', live_url: 'https://dir.example/waves' }).outcome).toBe('placed');
  });
});

describe('never-a-target hosts (plan §4 step 1)', () => {
  test('X/Twitter, Google, shorteners, and every Waves host (hub + spokes, subdomains) are dropped', () => {
    for (const h of ['x.com', 'https://twitter.com/waves', 't.co', 'www.google.com', 'maps.google.com', 'bit.ly', 'wavespestcontrol.com', 'www.wavespestcontrol.com', 'blog.wavespestcontrol.com', ...SPOKE_SITE_KEYS]) {
      expect({ h, never: R.isNeverTargetHost(h) }).toEqual({ h, never: true });
    }
    for (const h of ['example.com', 'notx.com', 'googleplex.example', 'sunrise-irrigation.com']) expect(R.isNeverTargetHost(h)).toBe(false);
    expect(R.isNeverTargetHost('')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// knex-shaped double: records inserts/updates; answers lookups from a store
// ---------------------------------------------------------------------------
function fakeDb({ domains = [] } = {}) {
  const store = { domains: [...domains], sources: [], updates: [] };
  const builder = (table) => {
    const st = { table, where: null, whereIn: null, insert: null, conflict: null };
    const q = {
      insert(row) { st.insert = row; return q; },
      onConflict(c) { st.conflict = c; return q; },
      ignore() { return q; },
      returning() { return q.then(); },
      where(w) { st.where = w; return q; },
      whereIn(col, vals) { st.whereIn = [col, vals]; return q; },
      select() { return q.then(); },
      async first() {
        const r = await q.then();
        return r[0];
      },
      update(patch) { store.updates.push({ table, where: st.where, patch }); return Promise.resolve(1); },
      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (st.insert) {
            if (table === 'seo_link_domains') {
              if (store.domains.some((d) => d.domain === st.insert.domain)) return [];
              const row = { id: `d${store.domains.length + 1}`, discovery_priority: 'normal', ...st.insert };
              store.domains.push(row); return [{ id: row.id }];
            }
            if (table === 'seo_link_domain_sources') {
              if (store.sources.some((s) => s.domain_id === st.insert.domain_id && s.touch_key === st.insert.touch_key)) return [];
              const row = { id: `s${store.sources.length + 1}`, ...st.insert };
              store.sources.push(row); return [{ id: row.id }];
            }
            throw new Error(`unexpected insert into ${table}`);
          }
          if (table === 'seo_link_domains') {
            let rows = store.domains;
            if (st.where) rows = rows.filter((d) => Object.entries(st.where).every(([k, v]) => d[k] === v));
            if (st.whereIn) rows = rows.filter((d) => st.whereIn[1].includes(d[st.whereIn[0]]));
            return rows;
          }
          return [];
        }).then(resolve, reject);
      },
    };
    return q;
  };
  const db = jest.fn(builder);
  db.fn = { now: () => 'NOW()' };
  db.transaction = async (fn) => fn(db);
  db._store = store;
  return db;
}

describe('ensureDomain (the one registry upsert)', () => {
  test('inserts the canonical host with first-touch source + a touch row; a repeat is a no-op touch; first-touch source never rewritten', async () => {
    const db = fakeDb();
    const a = await ensureBoth(db, { domain: 'HTTPS://WWW.Example.com/path', source: 'list_import', sourceDetail: 'paste:2026-08-28' });
    expect(a).toEqual({ id: 'd1', domain: 'example.com', created: true, touched: true });
    expect(db._store.domains[0]).toMatchObject({ domain: 'example.com', source: 'list_import', source_detail: 'paste:2026-08-28', discovery_priority: 'normal', agent_state: 'new' });
    expect(db._store.sources[0]).toMatchObject({ domain_id: 'd1', source: 'list_import', touch_key: 'list_import:paste:2026-08-28' });
    const b = await ensureBoth(db, { domain: 'example.com', source: 'list_import', sourceDetail: 'paste:2026-08-28' });
    expect(b).toEqual({ id: 'd1', domain: 'example.com', created: false, touched: false });
    // a different feeder touches the same host: new touch row, source untouched
    const c = await ensureBoth(db, { domain: 'example.com', source: 'competitor_gap', sourceRef: 'gap-1' });
    expect(c).toEqual({ id: 'd1', domain: 'example.com', created: false, touched: true });
    expect(db._store.domains[0].source).toBe('list_import');
    expect(db._store.sources.map((s) => s.touch_key)).toEqual(['list_import:paste:2026-08-28', 'competitor_gap:gap-1']);
    expect(db._store.updates).toEqual([]);
  });
  test('an owner_seed touch on an existing normal row raises discovery_priority (never lowers it)', async () => {
    const db = fakeDb({ domains: [{ id: 'd9', domain: 'seed.example', source: 'competitor_gap', discovery_priority: 'normal' }] });
    await ensureBoth(db, { domain: 'seed.example', source: 'owner_seed' });
    expect(db._store.updates).toEqual([{ table: 'seo_link_domains', where: { id: 'd9' }, patch: expect.objectContaining({ discovery_priority: 'owner_seed' }) }]);
    const db2 = fakeDb({ domains: [{ id: 'd9', domain: 'seed.example', source: 'owner_seed', discovery_priority: 'owner_seed' }] });
    await ensureBoth(db2, { domain: 'seed.example', source: 'list_import' });
    expect(db2._store.updates).toEqual([]);
  });
  test('seen_at/created_at pass through for historical touches (never now()); unknown source / empty domain refuse', async () => {
    const db = fakeDb();
    const then = new Date('2026-06-23T12:00:00Z');
    await ensureBoth(db, { domain: 'old.example', source: 'owner_seed', sourceDetail: 'legacy:manual', seenAt: then, createdAt: then });
    expect(db._store.domains[0]).toMatchObject({ created_at: then, updated_at: then, discovery_priority: 'owner_seed' });
    expect(db._store.sources[0]).toMatchObject({ seen_at: then });
    await expect(ensureBoth(db, { domain: 'x.example', source: 'nope' })).rejects.toThrow(/unknown source/);
    await expect(ensureBoth(db, { domain: '', source: 'owner_seed' })).rejects.toThrow(/empty domain/);
  });
  test('touch_key: ref wins over detail; detail is case/space-normalized; "-" when neither', () => {
    expect(R.touchKey('x', 'ref1', 'detail')).toBe('x:ref1');
    expect(R.touchKey('list_import', null, '  Backlinks CSV  2026 ')).toBe('list_import:backlinks csv 2026');
    expect(R.touchKey('recursive', null, null)).toBe('recursive:-');
  });
});
async function ensureBoth(db, args) { return R.ensureDomain(db, args); }

describe('parseOpportunities (intake normalize, pure)', () => {
  test('domains, URLs (hint kept), CSV rows, emails stripped, X posts unresolved, never-targets dropped, batch-deduped', () => {
    const text = [
      'Example.com, https://www.Example.com/submit-a-listing/',
      '"Sunrise Irrigation","https://sunrise-irrigation.com/partners", contact: joe@sunrise-irrigation.com',
      'https://x.com/someone/status/1234567890',
      'https://twitter.com/waves',
      'bit.ly/abc  wavespestcontrol.com/blog  https://blog.wavespestcontrol.com/x',
      'localhost  notahost  192.168.1.1',
      'Trailing punctuation: (bradentonchamber.org).',
    ].join('\n');
    const r = parseOpportunities(text);
    expect(r.candidates).toEqual([
      { domain: 'example.com', url: 'https://www.Example.com/submit-a-listing/' },
      { domain: 'sunrise-irrigation.com', url: 'https://sunrise-irrigation.com/partners' },
      { domain: 'bradentonchamber.org', url: null },
    ]);
    expect(r.unresolved).toEqual(['https://x.com/someone/status/1234567890']);
    expect(r.dropped.map((d) => d.token)).toEqual(expect.arrayContaining(['https://twitter.com/waves', 'bit.ly/abc', 'wavespestcontrol.com/blog', 'https://blog.wavespestcontrol.com/x']));
    expect(r.dropped.every((d) => d.reason === 'never_target')).toBe(true);
    // the email's host never became a candidate on its own line either
    expect(parseOpportunities('bob@lonely.example').candidates).toEqual([]);
    expect(parseOpportunities('')).toEqual({ candidates: [], unresolved: [], dropped: [] });
    expect(parseOpportunities(null).candidates).toEqual([]);
  });
  test('an X post is parked as unresolved, never turned into an x.com domain; mobile./www. spellings too', () => {
    for (const u of ['x.com/a/status/1', 'https://mobile.twitter.com/a/status/22', 'https://www.x.com/a/status/333?s=20']) {
      const r = parseOpportunities(u);
      expect(r.candidates).toEqual([]);
      expect(r.unresolved.length).toBe(1);
    }
  });
});

describe('intake (dedupe + upsert; dryRun writes nothing)', () => {
  test('dryRun reports would-insert vs existing with zero writes', async () => {
    const db = fakeDb({ domains: [{ id: 'd1', domain: 'known.example', source: 'competitor_gap', discovery_priority: 'normal' }] });
    const r = await intake(db, { text: 'known.example new.example https://x.com/u/status/9', source: 'list_import', sourceDetail: 'paste', dryRun: true });
    expect(r).toMatchObject({ dryRun: true, inserted: 1, existing: 1, touched: 0, unresolved: ['https://x.com/u/status/9'] });
    expect(r.candidates).toEqual([{ domain: 'known.example', url: null, existing: true }, { domain: 'new.example', url: null, existing: false }]);
    expect(db._store.domains.length).toBe(1);
    expect(db._store.sources).toEqual([]);
    expect(db._store.updates).toEqual([]);
  });
  test('live: every candidate upserted in one transaction; second identical paste adds nothing', async () => {
    const db = fakeDb();
    const trx = jest.spyOn(db, 'transaction');
    const r1 = await intake(db, { text: 'a.example\nb.example\na.example', source: 'owner_seed', sourceDetail: 'seed:adam' });
    expect(trx).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ inserted: 2, existing: 0, touched: 2, dryRun: false, source: 'owner_seed' });
    expect(db._store.domains.map((d) => [d.domain, d.discovery_priority, d.source])).toEqual([['a.example', 'owner_seed', 'owner_seed'], ['b.example', 'owner_seed', 'owner_seed']]);
    const r2 = await intake(db, { text: 'a.example b.example', source: 'owner_seed', sourceDetail: 'seed:adam' });
    expect(r2).toMatchObject({ inserted: 0, existing: 2, touched: 0 });
    expect(db._store.sources.length).toBe(2);
  });
  test('a pasted submission URL is persisted as the touch detail (recoverable by the investigator), idempotently', async () => {
    const db = fakeDb();
    await intake(db, { text: 'https://dir.example/add-your-business/ plain.example', source: 'list_import', sourceDetail: 'paste:2026-08-28' });
    expect(db._store.domains.find((d) => d.domain === 'dir.example').source_detail).toBe('paste:2026-08-28 https://dir.example/add-your-business/');
    expect(db._store.sources.map((s) => [s.source_detail, s.touch_key])).toEqual([
      ['paste:2026-08-28 https://dir.example/add-your-business/', 'list_import:paste:2026-08-28 https://dir.example/add-your-business/'],
      ['paste:2026-08-28', 'list_import:paste:2026-08-28'],
    ]);
    const again = await intake(db, { text: 'https://dir.example/add-your-business/', source: 'list_import', sourceDetail: 'paste:2026-08-28' });
    expect(again).toMatchObject({ inserted: 0, existing: 1, touched: 0 });
    // a NEW url for a known host is a new touch, first-touch detail untouched
    await intake(db, { text: 'https://dir.example/submit', source: 'list_import', sourceDetail: 'paste:2026-08-28' });
    expect(db._store.sources.length).toBe(3);
    expect(db._store.domains.find((d) => d.domain === 'dir.example').source_detail).toBe('paste:2026-08-28 https://dir.example/add-your-business/');
  });
  test('empty / host-less text is a no-op result; an unknown source is refused before any read', async () => {
    const db = fakeDb();
    expect(await intake(db, { text: 'nothing here' })).toMatchObject({ inserted: 0, existing: 0, candidates: [] });
    expect(db).not.toHaveBeenCalled();
    await expect(intake(db, { text: 'a.example', source: 'bogus' })).rejects.toMatchObject({ code: 'invalid_source' });
  });
});
