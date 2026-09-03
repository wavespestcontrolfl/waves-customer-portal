/**
 * Backlink Manager v2 step 4 (PR 2a) — the nightly `link-authority` bridge.
 * In-memory knex-shaped store; the pure §6.3 decision is the real one.
 * Behavior pinned: gate/dryRun = selection only; placements per lane; one
 * authority row per required instance; OWNER_* parks (with the two deferrals);
 * DENY/INVALID stamp only; waiver honoured for its exact floors; stale rows
 * re-decided + approvals invalidated; satisfied rows untouched; released when
 * the policy loosens; Judge-owned statuses never moved; §3.1 aggregate; one
 * bell per run; idempotent re-runs.
 */
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { isEnabled } = require('../config/feature-gates');
const { WAVES_LOCATIONS } = require('../config/locations');
const { canonicalProspectDomain } = require('../services/seo/prospect-domain-lock');
const P = require('../services/seo/link-authority-policy');
const bridge = require('../services/seo/link-authority-bridge');

// ---------------------------------------------------------------------------
// In-memory knex-shaped store
// ---------------------------------------------------------------------------
let idSeq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;
const TABLES = ['seo_link_domains', 'seo_link_acquisition_paths', 'seo_link_prospects', 'seo_link_placement_authorities', 'seo_link_floor_waivers', 'seo_link_approvals', 'seo_link_policy'];

function makeDb(seed = {}) {
  const tables = Object.fromEntries(TABLES.map((t) => [t, []]));
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }));
  const raws = [];
  const op = (a, l, r) => (a === '<' ? l < r : a === '<=' ? l <= r : a === '>' ? l > r : a === '>=' ? l >= r : a === '<>' || a === '!=' ? l !== r : l === r);
  function builder(table) {
    const rows = tables[table];
    if (!rows) throw new Error(`unknown table ${table}`);
    const st = { preds: [], order: null, limit: null, cols: null };
    const matches = (r) => st.preds.every((p) => p(r));
    const project = (r) => (!st.cols || st.cols.includes('*') ? { ...r } : Object.fromEntries(st.cols.map((c) => [c, r[c]])));
    const resolve = () => {
      let out = rows.filter(matches);
      if (st.order) out = [...out].sort((a, b) => (String(a[st.order.col]) < String(b[st.order.col]) ? -1 : 1) * (st.order.dir === 'desc' ? -1 : 1));
      if (st.limit != null) out = out.slice(0, st.limit);
      return out.map(project);
    };
    const q = {
      where(a, b, c) {
        if (typeof a === 'object') st.preds.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (c !== undefined) st.preds.push((r) => op(b, r[a], c));
        else st.preds.push((r) => r[a] === b);
        return q;
      },
      whereNull(col) { st.preds.push((r) => r[col] == null); return q; },
      whereNotNull(col) { st.preds.push((r) => r[col] != null); return q; },
      whereIn(col, arr) { st.preds.push((r) => arr.includes(r[col])); return q; },
      whereRaw(sql, bindings = []) {
        if (/split_part/.test(sql)) st.preds.push((r) => canonicalProspectDomain(r.target_domain) === bindings[0]);
        else throw new Error(`unsupported whereRaw: ${sql}`);
        return q;
      },
      orderBy(col, dir = 'asc') { st.order = { col, dir }; return q; },
      limit(n) { st.limit = n; return q; },
      select(...cols) { st.cols = cols.length ? cols : null; return q; },
      forUpdate() { return q; },
      async first(...cols) { if (cols.length) st.cols = cols; return resolve()[0]; },
      async update(patch) { const hit = rows.filter(matches); for (const r of hit) Object.assign(r, patch); return hit.length; },
      insert(row) {
        const created = { id: uid(), ...row };
        rows.push(created);
        return { returning: async () => [{ ...created }], then: (res, rej) => Promise.resolve([{ ...created }]).then(res, rej) };
      },
      then(res, rej) { return Promise.resolve(resolve()).then(res, rej); },
    };
    return q;
  }
  const db = Object.assign((table) => builder(table), {
    raw: async (sql) => { raws.push(sql); return {}; },
    transaction: async (cb) => cb(db),
    _tables: tables,
    _raws: raws,
  });
  return db;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const NOW = new Date('2026-09-03T07:35:00Z');
const EARLIER = new Date('2026-09-01T00:00:00Z');
const HASH = 'a'.repeat(64);
const policyRow = (over = {}) => ({ id: 1, ...P.normalizePolicyRow(null), updated_at: EARLIER, ...over });
const domainRow = (over = {}) => ({ id: uid(), domain: 'example.org', source: 'competitor_gap', agent_state: 'qualified', score: 75, spam_score: 2, best_path_id: null, updated_at: EARLIER, ...over });
const pathRow = (domain, over = {}) => ({
  id: uid(), domain_id: domain.id, acquisition_type: 'self_service_free', link_type: 'directory', submission_url: 'https://example.org/add',
  estimated_cost_cents: null, renewal_cost_cents: null, renewal_period: null, currency: 'unknown', fee_scope: null, merchant_binding: null,
  account_required: false, email_verification: false, payment_required: false, legal_attestation: false, legal_terms_hash: null,
  agent_completable: true, terms_accepted_by_send: false, execution_after_send: true, baseline: false, confidence: '0.80',
  expected_rel: 'dofollow', revision: 1, revision_payment: 1, revision_communication: 1, revision_execution: 1,
  last_investigated_at: EARLIER, superseded_by: null, authority_last_decided: null, updated_at: EARLIER, ...over,
});
const outreachPath = (domain, over = {}) => pathRow(domain, { acquisition_type: 'resource_outreach', link_type: 'resource', submission_url: null, ...over });
const paidPath = (domain, over = {}) => pathRow(domain, {
  acquisition_type: 'paid_listing', payment_required: true, estimated_cost_cents: 4500, currency: 'USD', fee_scope: 'per_location',
  merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'checkout.stripe.com', merchant_account_id: 'acct_1' } }, ...over,
});

function scenario({ make = pathRow, domain: dOver = {}, path: pOver = {}, policy = {}, extra = {} } = {}) {
  const d = domainRow(dOver);
  const p = make(d, pOver);
  d.best_path_id = p.id;
  const db = makeDb({ seo_link_domains: [d], seo_link_acquisition_paths: [p], seo_link_policy: [policyRow(policy)], ...extra });
  return { db, d, p };
}
const run = (db, opts = {}) => bridge.runAuthorityBridge(db, { now: NOW, exclusive: (k, fn) => fn(), notify: opts.notify || jest.fn(), ...opts });
const placements = (db) => db._tables.seo_link_prospects;
const rows = (db) => db._tables.seo_link_placement_authorities;
const domainState = (db) => db._tables.seo_link_domains[0].agent_state;

beforeEach(() => { isEnabled.mockReturnValue(true); });

describe('gate / dryRun', () => {
  test('gate off ⇒ selection only, zero writes, no bell', async () => {
    isEnabled.mockReturnValue(false);
    const { db } = scenario();
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r).toMatchObject({ gated: true, selected: 1, decided: 0, placementsCreated: 0 });
    expect(placements(db)).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });
  test('dryRun ⇒ counts only', async () => {
    const { db } = scenario();
    const r = await run(db, { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, gated: false, selected: 1, decided: 0 });
    expect(placements(db)).toHaveLength(0);
    expect(rows(db)).toHaveLength(0);
  });
  test('a held lease is reported and nothing is written', async () => {
    const { db } = scenario();
    const r = await run(db, { exclusive: async () => ({ skipped: true, reason: 'lease_held' }) });
    expect(r.skipped).toBe('lease_held');
    expect(placements(db)).toHaveLength(0);
  });
});

describe('a qualified domain with a free signup-lane path', () => {
  test('one placement per GBP location, one execution row each, OWNER_FREE parks, one bell', async () => {
    const { db, d, p } = scenario();
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r).toMatchObject({ selected: 1, decided: 1, placementsCreated: WAVES_LOCATIONS.length, rowsWritten: WAVES_LOCATIONS.length, parked: WAVES_LOCATIONS.length, errors: [] });
    const ps = placements(db);
    expect(ps.map((x) => x.location_key).sort()).toEqual(WAVES_LOCATIONS.map((l) => l.id).sort());
    for (const x of ps) {
      expect(x).toMatchObject({ target_domain: 'example.org', target_page: bridge.HOMEPAGE, domain_id: d.id, path_id: p.id, link_type: 'directory', source: 'competitor_gap', status: 'awaiting_owner', parked_from_status: 'prospect', authority: 'OWNER_FREE' });
    }
    const rs = rows(db);
    expect(rs).toHaveLength(WAVES_LOCATIONS.length);
    for (const x of rs) {
      expect(x).toMatchObject({ dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', path_revision: 1, floor_waiver_id: null, decided_at: NOW });
      expect(x.decision_inputs_hash).toBe(P.decisionInputsHash('execution', { path: p, domain: d, policy: P.normalizePolicyRow(null), score: 75 }));
    }
    expect(db._tables.seo_link_acquisition_paths[0].authority_last_decided).toBe('OWNER_FREE');
    expect(domainState(db)).toBe('qualified'); // awaiting the owner
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][2]).toMatchObject({ bell: true, link: '/admin/seo', dedupeKey: 'link-authority:2026-09-03', refreshOnDedupe: true, metadata: { lane: 'link_authority', parked: WAVES_LOCATIONS.length, domains: ['example.org'] } });
  });
  test('auto_free_acquisition on ⇒ AUTO_FREE, stays prospect, domain ready_to_acquire, no bell', async () => {
    const { db } = scenario({ policy: { auto_free_acquisition: true } });
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r.parked).toBe(0);
    expect(placements(db).every((x) => x.status === 'prospect' && x.authority === 'AUTO_FREE')).toBe(true);
    expect(domainState(db)).toBe('ready_to_acquire');
    expect(notify).not.toHaveBeenCalled();
  });
  test('a second run is a no-op (idempotent)', async () => {
    const { db } = scenario();
    await run(db);
    const before = JSON.stringify([placements(db), rows(db)]);
    const r = await run(db);
    expect(r).toMatchObject({ decided: 1, placementsCreated: 0, rowsWritten: 0, redecided: 0, parked: 0, released: 0 });
    expect(JSON.stringify([placements(db), rows(db)])).toBe(before);
  });
});

describe('outreach-lane paths', () => {
  test('one unscoped placement; OWNER_OUTREACH with no draft stays prospect (the draft lease runs first); deferred payment never parks', async () => {
    const { db } = scenario({ make: outreachPath, path: { acquisition_type: 'resource_outreach', link_type: 'resource', submission_url: null, payment_required: true, estimated_cost_cents: 20000, currency: 'USD', fee_scope: 'per_location', merchant_binding: { checkout_origin: 'https://example.org', processor: { host: 'h', merchant_account_id: 'm' } } } });
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r).toMatchObject({ placementsCreated: 1, rowsWritten: 2, parked: 0 });
    const [pl] = placements(db);
    expect(pl).toMatchObject({ location_key: '-', status: 'prospect', authority: 'OWNER_PAYMENT' });
    expect(rows(db).map((x) => [x.dimension, x.level]).sort()).toEqual([['communication', 'OWNER_OUTREACH'], ['payment', 'OWNER_PAYMENT']]);
    expect(domainState(db)).toBe('qualified');
    expect(notify).not.toHaveBeenCalled();
  });
  test('with a draft present the send approval parks the placement', async () => {
    const { db, d, p } = scenario({ make: outreachPath });
    db._tables.seo_link_prospects.push({ id: uid(), target_domain: 'www.example.org', target_page: 'https://www.wavespestcontrol.com/', location_key: '-', domain_id: d.id, path_id: p.id, status: 'prospect', outreach_status: 'drafted', link_type: 'resource', updated_at: EARLIER });
    const r = await run(db);
    expect(r).toMatchObject({ placementsCreated: 0, parked: 1 }); // the existing row is matched by canonical host + page variant
    expect(placements(db)[0].status).toBe('awaiting_owner');
  });
  test('legal attestation adds the accept_terms execution instance at OWNER_LEGAL', async () => {
    const { db } = scenario({ make: outreachPath, path: { acquisition_type: 'resource_outreach', link_type: 'resource', submission_url: null, legal_attestation: true, legal_terms_hash: HASH } });
    await run(db);
    expect(rows(db).map((x) => [x.dimension, x.instance_kind, x.instance_key, x.level]).sort()).toEqual([['communication', '-', '-:1', 'OWNER_LEGAL'], ['execution', 'terms', 'terms:1', 'OWNER_LEGAL']]);
  });
});

describe('floors and waivers', () => {
  test('DENY stamps every row and the placement, parks nothing, and rejects the domain', async () => {
    const { db } = scenario({ domain: { spam_score: 30 } });
    const notify = jest.fn();
    const r = await run(db, { notify });
    expect(r.parked).toBe(0);
    expect(rows(db).every((x) => x.level === 'DENY' && /spam_score 30 > 10/.test(x.reason))).toBe(true);
    expect(placements(db).every((x) => x.status === 'prospect' && x.authority === 'DENY')).toBe(true);
    expect(domainState(db)).toBe('rejected');
    expect(notify).not.toHaveBeenCalled();
  });
  test('INVALID (unenriched) stamps and sends the domain back to investigating', async () => {
    const { db } = scenario({ domain: { spam_score: null } });
    await run(db);
    expect(rows(db).every((x) => x.level === 'INVALID')).toBe(true);
    expect(domainState(db)).toBe('investigating');
  });
  test('a valid waiver passes the floors: the UNDERLYING level is stamped with floor_waiver_id; a stale waiver is invalidated', async () => {
    const { db, d, p } = scenario({ domain: { spam_score: 30 } });
    const policy = P.normalizePolicyRow(null);
    const waiver = { id: uid(), domain_id: d.id, path_id: p.id, decision_inputs_hash: P.floorInputsHash({ path: p, domain: d, policy, score: 75 }), overridden_floors: [], approved_by: 'adam', approved_at: EARLIER, invalidated_at: null };
    db._tables.seo_link_floor_waivers.push(waiver);
    const r = await run(db);
    expect(r.parked).toBe(WAVES_LOCATIONS.length);
    expect(rows(db).every((x) => x.level === 'OWNER_FREE' && x.floor_waiver_id === waiver.id && /floors waived/.test(x.reason))).toBe(true);
    // spam rises further ⇒ the waiver no longer matches the floors the owner looked at
    db._tables.seo_link_domains[0].spam_score = 40;
    db._tables.seo_link_domains[0].updated_at = NOW;
    const r2 = await run(db, { now: new Date(NOW.getTime() + 1000) });
    expect(r2.invalidatedWaivers).toBe(1);
    expect(db._tables.seo_link_floor_waivers[0].invalidated_at).toBeTruthy();
    expect(rows(db).every((x) => x.level === 'DENY' && x.floor_waiver_id === null)).toBe(true);
    expect(placements(db).every((x) => x.status === 'prospect' && x.parked_from_status === null)).toBe(true); // released: nothing owner-gated any more
  });
});

describe('re-decision', () => {
  test('a stale row (policy changed since decided_at) is re-decided; a loosened policy releases the park; an attached approval whose inputs moved is invalidated', async () => {
    const { db, d, p } = scenario();
    await run(db);
    expect(placements(db).every((x) => x.status === 'awaiting_owner')).toBe(true);
    // an owner approval attached to one row (PR 2b writes these)
    const target = rows(db)[0];
    const approval = { id: uid(), prospect_id: target.prospect_id, path_id: p.id, decision: 'approved', authority: 'OWNER_FREE', dimension: 'execution', instance_key: '-:1', invalidated_at: null };
    db._tables.seo_link_approvals.push(approval);
    target.approval_id = approval.id;
    // the owner flips auto_free on
    Object.assign(db._tables.seo_link_policy[0], { auto_free_acquisition: true, updated_at: NOW });
    db._tables.seo_link_domains[0].agent_state = 'qualified';
    const later = new Date(NOW.getTime() + 60000);
    const r = await run(db, { now: later });
    expect(r).toMatchObject({ selected: 1, redecided: WAVES_LOCATIONS.length, released: WAVES_LOCATIONS.length, invalidatedApprovals: 1, parked: 0 });
    expect(rows(db).every((x) => x.level === 'AUTO_FREE' && x.decided_at === later && x.approval_id == null)).toBe(true);
    expect(db._tables.seo_link_approvals[0]).toMatchObject({ invalidated_at: later });
    expect(placements(db).every((x) => x.status === 'prospect' && x.parked_from_status === null && x.authority === 'AUTO_FREE')).toBe(true);
    expect(domainState(db)).toBe('ready_to_acquire');
    expect(d.id).toBeTruthy();
  });
  test('a stale row is selected through the stale scan even when the domain is no longer qualified', async () => {
    const { db } = scenario({ policy: { auto_free_acquisition: true } });
    await run(db);
    expect(domainState(db)).toBe('ready_to_acquire');
    Object.assign(db._tables.seo_link_policy[0], { auto_free_acquisition: false, updated_at: new Date(NOW.getTime() + 1000) });
    const later = new Date(NOW.getTime() + 60000);
    const r = await run(db, { now: later });
    expect(r).toMatchObject({ selected: 1, redecided: WAVES_LOCATIONS.length, parked: WAVES_LOCATIONS.length });
    expect(domainState(db)).toBe('qualified'); // a tightened policy re-parks
  });
  test('a satisfied instance is never re-decided; Judge-owned statuses are never moved; the domain reads acquired', async () => {
    const { db } = scenario();
    await run(db);
    const [pl] = placements(db);
    Object.assign(pl, { status: 'live' });
    const row = rows(db).find((x) => x.prospect_id === pl.id);
    Object.assign(row, { satisfied_at: NOW, satisfied_reason: 'placed', level: 'OWNER_FREE' });
    Object.assign(db._tables.seo_link_policy[0], { auto_free_acquisition: true, updated_at: NOW });
    await run(db, { now: new Date(NOW.getTime() + 60000) });
    expect(rows(db).find((x) => x.id === row.id).level).toBe('OWNER_FREE');
    expect(placements(db).find((x) => x.id === pl.id).status).toBe('live');
    // the remaining siblings are AUTO_FREE + prospect ⇒ authorized-pending wins over acquired (§3.1)
    expect(domainState(db)).toBe('ready_to_acquire');
    for (const x of placements(db)) if (x.id !== pl.id) Object.assign(x, { status: 'rejected' });
    db._tables.seo_link_domains[0].updated_at = new Date(NOW.getTime() + 120000);
    await run(db, { now: new Date(NOW.getTime() + 180000) });
    expect(domainState(db)).toBe('acquired');
  });
  test('a superseded best path is skipped with a reason and writes nothing', async () => {
    const { db } = scenario({ path: { superseded_by: 'x' } });
    const r = await run(db);
    expect(r.decided).toBe(0);
    expect(r.errors).toEqual([{ domain: 'example.org', skipped: 'best path superseded' }]);
    expect(placements(db)).toHaveLength(0);
  });
  test('a placement still on an older path follows the best path: its unsatisfied instances end as superseded and fresh ones are decided', async () => {
    const { db, d, p } = scenario();
    const old = pathRow(d, { superseded_by: p.id });
    db._tables.seo_link_acquisition_paths.push(old);
    const pl = { id: uid(), target_domain: 'example.org', target_page: bridge.HOMEPAGE, location_key: WAVES_LOCATIONS[0].id, domain_id: d.id, path_id: old.id, status: 'prospect', link_type: 'directory', updated_at: EARLIER };
    db._tables.seo_link_prospects.push(pl);
    db._tables.seo_link_placement_authorities.push({ id: uid(), prospect_id: pl.id, dimension: 'execution', instance_kind: '-', instance_key: '-:1', level: 'OWNER_FREE', decision_inputs_hash: 'old', path_revision: 1, decided_at: EARLIER, ended_at: null, satisfied_at: null });
    db._tables.seo_link_domains[0].agent_state = 'ready_to_acquire'; // not `qualified`: reached only by the stale scan (path_id ≠ best_path_id)
    const r = await run(db);
    expect(r.selected).toBe(1);
    expect(r.ended).toBe(1);
    const mine = rows(db).filter((x) => x.prospect_id === pl.id);
    expect(mine.filter((x) => x.ended_at).map((x) => x.end_outcome)).toEqual(['superseded']);
    expect(mine.filter((x) => !x.ended_at)).toHaveLength(1);
    expect(placements(db).find((x) => x.id === pl.id).path_id).toBe(p.id);
  });
});

describe('payment grouping', () => {
  test('an account_wide membership shares one payment group across every location and parks at OWNER_MEMBERSHIP', async () => {
    const { db } = scenario({ make: paidPath, path: { acquisition_type: 'membership', fee_scope: 'account_wide', account_required: true } });
    await run(db);
    const ps = placements(db);
    expect(ps).toHaveLength(WAVES_LOCATIONS.length);
    const group = ps[0].payment_group_id;
    expect(group).toBe(ps[0].id);
    expect(ps.every((x) => x.payment_group_id === group && x.status === 'awaiting_owner' && x.authority === 'OWNER_MEMBERSHIP')).toBe(true);
    expect(rows(db).filter((x) => x.dimension === 'payment').every((x) => x.level === 'OWNER_PAYMENT')).toBe(true);
  });
  test('a per_location paid listing gets no group', async () => {
    const { db } = scenario({ make: paidPath });
    await run(db);
    expect(placements(db).every((x) => x.payment_group_id == null)).toBe(true);
  });
});

describe('aggregateState (§3.1)', () => {
  const A = (level, satisfied = false) => ({ level, satisfied_at: satisfied ? NOW : null });
  test.each([
    ['authorized pending wins', [{ status: 'prospect', rows: [A('AUTO_FREE')] }, { status: 'live', rows: [A('OWNER_FREE', true)] }], 'ready_to_acquire'],
    ['satisfied rows count as authorized', [{ status: 'prospect', rows: [A('OWNER_FREE', true), A('OWNER_PAYMENT', true)] }], 'ready_to_acquire'],
    ['acquired once live with nothing pending', [{ status: 'live', rows: [A('OWNER_FREE', true)] }, { status: 'rejected', rows: [] }], 'acquired'],
    ['acquiring for the active intermediates', [{ status: 'contacted', rows: [A('OWNER_OUTREACH')] }], 'acquiring'],
    ['qualified while the owner holds it', [{ status: 'awaiting_owner', rows: [A('OWNER_FREE')] }, { status: 'prospect', rows: [A('DENY')] }], 'qualified'],
    ['qualified for a deferred owner decision', [{ status: 'prospect', rows: [A('OWNER_OUTREACH')] }], 'qualified'],
    ['investigating when every placement is INVALID', [{ status: 'prospect', rows: [A('INVALID')] }, { status: 'prospect', rows: [A('INVALID'), A('INVALID')] }], 'investigating'],
    ['rejected only when every placement is DENY', [{ status: 'prospect', rows: [A('DENY')] }], 'rejected'],
    ['a DENY beside an INVALID is not a rejection', [{ status: 'prospect', rows: [A('DENY')] }, { status: 'prospect', rows: [A('INVALID')] }], 'qualified'],
    ['no rows ⇒ qualified', [{ status: 'prospect', rows: [] }], 'qualified'],
  ])('%s', (_, placementsIn, expected) => { expect(bridge.aggregateState(placementsIn)).toBe(expected); });
});

describe('selection', () => {
  test('limit caps and dedupes across the two sources; domainIds narrows', async () => {
    const { db, d } = scenario();
    const d2 = domainRow({ domain: 'two.example', updated_at: NOW });
    const p2 = pathRow(d2);
    d2.best_path_id = p2.id;
    db._tables.seo_link_domains.push(d2);
    db._tables.seo_link_acquisition_paths.push(p2);
    expect((await bridge.selectDomains(db, { domainIds: null, limit: 1, policyUpdatedAt: EARLIER })).map((x) => x.id)).toEqual([d.id]);
    expect((await bridge.selectDomains(db, { domainIds: [d2.id], limit: 10, policyUpdatedAt: EARLIER })).map((x) => x.id)).toEqual([d2.id]);
    const r = await run(db, { limit: 1 });
    expect(r.selected).toBe(1);
  });
});
