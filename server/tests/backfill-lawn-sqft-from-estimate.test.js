// Backfill script: classifier (every class), CSV privacy, CLI guards, and the
// apply path (only differs / turf_profile_empty are written, one customer at a
// time, through the shared writer) against fake loaders.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const script = require('../scripts/backfill-lawn-sqft-from-estimate');

const ADDR = { address_line1: '100 Main St', address_line2: null, city: 'Bradenton', zip: '34205' };
const customer = (over = {}) => ({ id: 'c1', ...ADDR, property_sqft: null, ...over });
const primary = (over = {}) => ({ id: 'p1', customer_id: 'c1', ...ADDR, property_sqft: null, ...over });
const data = (sqft = 5200, basis = 'measuredTurfSf') => ({
  result: { recurring: { services: [{ name: 'Lawn Care', service: 'lawn_care', monthly: 60 }] } },
  engineResult: { lineItems: [{ service: 'lawn_care', lawnSqFt: sqft, turfBasis: basis, turfEstimated: basis !== 'measuredTurfSf' }] },
});
const est = (id, over = {}) => ({
  id, customer_id: 'c1', property_id: null, address: '100 Main St, Bradenton, FL 34205', status: 'accepted',
  accepted_at: '2026-06-01T00:00:00Z', estimate_data: data(), ...over,
});
const classify = (input) => script.classifyCustomer({ customer: customer(), primary: primary(), turf: null, linked: [], accepted: [], ...input });

describe('classifyCustomer', () => {
  const synced = { customer: customer({ property_sqft: 5200 }), primary: primary({ property_sqft: 5200 }) };
  test('same: turf and every applicable mirror agree', () => {
    const r = classify({ ...synced, turf: { lawn_sqft: 5200 }, linked: [est('e1')] });
    expect(r).toMatchObject({ class: 'same', via: 'linked', estimate_id: 'e1', confirmed_sqft: 5200, turf_lawn_sqft: 5200, primary_property_sqft: 5200, customer_property_sqft: 5200 });
  });
  test('mirrors_differ: turf matches but the primary property or the customer mirror does not (all three numbers shown)', () => {
    const a = classify({ customer: customer({ property_sqft: 5200 }), primary: primary({ property_sqft: 3000 }), turf: { lawn_sqft: 5200 }, linked: [est('e1')] });
    expect(a).toMatchObject({ class: 'mirrors_differ', turf_lawn_sqft: 5200, primary_property_sqft: 3000, customer_property_sqft: 5200 });
    const b = classify({ customer: customer({ property_sqft: null }), primary: primary({ property_sqft: 5200 }), turf: { lawn_sqft: 5200 }, linked: [est('e1')] });
    expect(b).toMatchObject({ class: 'mirrors_differ', customer_property_sqft: '' });
    expect(script.APPLY_CLASSES.has('mirrors_differ')).toBe(true);
  });
  test('mirror applicability: no primary row checks only the customer mirror; a primary at another address has no mirrors', () => {
    const input = { turf: { lawn_sqft: 5200 }, linked: [est('e1')] };
    expect(classify({ ...input, customer: customer({ property_sqft: 5200 }), primary: null }).class).toBe('same');
    expect(classify({ ...input, customer: customer({ property_sqft: 1 }), primary: null }).class).toBe('mirrors_differ');
    expect(classify({ ...input, customer: customer({ property_sqft: 1 }), primary: primary({ address_line1: '5 Elm St', property_sqft: 2 }) }).class).toBe('same');
  });
  test('differs carries both numbers and the percent difference', () => {
    const r = classify({ turf: { lawn_sqft: 4000 }, linked: [est('e1')] });
    expect(r).toMatchObject({ class: 'differs', confirmed_sqft: 5200, turf_lawn_sqft: 4000, pct_diff: 30 });
  });
  test('turf profile empty (no row, or null size)', () => {
    expect(classify({ linked: [est('e1')] }).class).toBe('turf_profile_empty');
    expect(classify({ turf: { lawn_sqft: null }, linked: [est('e1')] }).class).toBe('turf_profile_empty');
  });
  test('no accepted lawn estimate: nothing found, or the linked one is not accepted', () => {
    expect(classify({})).toMatchObject({ class: 'no_accepted_lawn_estimate', reason: 'none_found' });
    expect(classify({ linked: [est('e1', { status: 'sent' })] })).toMatchObject({ class: 'no_accepted_lawn_estimate', reason: 'linked_estimate_not_an_accepted_lawn_estimate' });
  });
  test('a pest-only accepted estimate is not a lawn candidate', () => {
    const pest = est('e1', { estimate_data: { result: { recurring: { services: [{ name: 'General Pest Control', service: 'pest_control' }] } } } });
    expect(classify({ accepted: [pest] }).class).toBe('no_accepted_lawn_estimate');
  });
  test('estimate has no confirmed size (AI estimate), with the reason', () => {
    const r = classify({ turf: { lawn_sqft: 4000 }, linked: [est('e1', { estimate_data: data(5200, 'estimatedTurfSf') })] });
    expect(r).toMatchObject({ class: 'estimate_has_no_confirmed_size', reason: 'unconfirmed_estimate' });
  });
  test('estimate for another property', () => {
    expect(classify({ linked: [est('e1', { property_id: 'p9' })] })).toMatchObject({ class: 'estimate_for_another_property', reason: 'other_property' });
    expect(classify({ linked: [est('e1', { address: '9 Other Rd, Bradenton, FL 34205' })] }).class).toBe('estimate_for_another_property');
  });
  test('ambiguous: two linked estimates that disagree', () => {
    const r = classify({ linked: [est('e1'), est('e2', { estimate_data: data(6100) })] });
    expect(r).toMatchObject({ class: 'ambiguous', reason: 'linked_estimates_disagree', candidate_count: 2 });
  });
  test('two linked estimates that agree are not ambiguous; the newest is used', () => {
    const r = classify({ linked: [est('e1', { accepted_at: '2026-01-01T00:00:00Z' }), est('e2')] });
    expect(r).toMatchObject({ class: 'turf_profile_empty', estimate_id: 'e2', candidate_count: 2 });
  });
  test('no live link: the latest accepted estimate for the primary property wins', () => {
    const older = est('e1', { accepted_at: '2026-01-01T00:00:00Z', estimate_data: data(4000) });
    const newer = est('e2');
    const other = est('e3', { accepted_at: '2026-09-01T00:00:00Z', property_id: 'p9' });
    const r = classify({ turf: { lawn_sqft: 4000 }, accepted: [older, other, newer] });
    expect(r).toMatchObject({ class: 'differs', via: 'latest_accepted', estimate_id: 'e2' });
  });
  test('no live link and two accepted at the same instant is ambiguous', () => {
    const r = classify({ accepted: [est('e1'), est('e2')] });
    expect(r).toMatchObject({ class: 'ambiguous', reason: 'tied_accepted_at' });
  });
  test('flags a confirmed size above the estimate tool review threshold', () => {
    expect(classify({ linked: [est('e1', { estimate_data: data(25000) })] }).over_20000).toBe('yes');
  });
});

describe('csv and summary', () => {
  test('the CSV carries customer ids and numbers only: no name, phone or address columns', () => {
    expect(script.CSV_COLUMNS.join(',')).not.toMatch(/name|phone|address|email|street/i);
    const row = script.classifyCustomer({ customer: customer(), primary: primary(), turf: { lawn_sqft: 4000 }, linked: [est('e1')], accepted: [] });
    const { estimate, ...plain } = row;
    const csv = script.toCsv([plain]);
    expect(csv).not.toMatch(/Main St|Bradenton/);
    expect(csv.split('\n')[1]).toContain('c1,differs');
  });
  test('summary counts every class, including empty ones', () => {
    const counts = script.summarize([{ class: 'same' }, { class: 'same' }, { class: 'differs' }]);
    expect(counts).toMatchObject({ same: 2, differs: 1, ambiguous: 0, turf_profile_empty: 0 });
    expect(script.summaryText(counts, 3, 'dry run')).toContain('differs: 1  (written by --apply)');
  });
});

describe('runBackfill apply path', () => {
  const rowsByCustomer = {
    c1: { customer: customer({ id: 'c1' }), primary: primary({ customer_id: 'c1' }), turf: { lawn_sqft: 4000 }, linked: [est('e1', { customer_id: 'c1' })] },
    c2: { customer: customer({ id: 'c2' }), primary: primary({ id: 'p2', customer_id: 'c2' }), turf: null, linked: [est('e2', { customer_id: 'c2' })] },
    c3: { customer: customer({ id: 'c3', property_sqft: 5200 }), primary: primary({ id: 'p3', customer_id: 'c3', property_sqft: 5200 }), turf: { lawn_sqft: 5200 }, linked: [est('e3', { customer_id: 'c3' })] },
    c4: { customer: customer({ id: 'c4' }), primary: primary({ id: 'p4', customer_id: 'c4' }), turf: { lawn_sqft: 3000 }, linked: [est('e4a', { customer_id: 'c4' }), est('e4b', { customer_id: 'c4', estimate_data: data(6100) })] },
    c5: { customer: customer({ id: 'c5' }), primary: primary({ id: 'p5', customer_id: 'c5' }), turf: { lawn_sqft: 3000 }, linked: [est('e5', { customer_id: 'c5', estimate_data: data(5200, 'lotFallback') })] },
    c7: { customer: customer({ id: 'c7', property_sqft: 1800 }), primary: primary({ id: 'p7', customer_id: 'c7', property_sqft: 1800 }), turf: { lawn_sqft: 5200 }, linked: [est('e7', { customer_id: 'c7' })] },
    c6: { customer: customer({ id: 'c6' }), primary: primary({ id: 'p6', customer_id: 'c6' }), turf: { lawn_sqft: 3000 }, linked: [est('e6', { customer_id: 'c6', property_id: 'other' })] },
  };
  const deps = (applyFn) => ({
    loadLawnCustomers: async (_k, { only, limit }) => Object.keys(rowsByCustomer).filter((id) => !only || id === only).slice(0, limit || 99)
      .map((id) => ({ customer_id: id, estimate_ids: rowsByCustomer[id].linked.map((e) => e.id) })),
    loadRows: async (_k, entries) => {
      const customers = new Map(); const primaries = new Map(); const turfs = new Map(); const estimates = new Map(); const acceptedBy = new Map();
      for (const { customer_id: id } of entries) {
        const r = rowsByCustomer[id];
        customers.set(id, r.customer); primaries.set(id, r.primary); if (r.turf) turfs.set(id, r.turf);
        r.linked.forEach((e) => estimates.set(e.id, e)); acceptedBy.set(id, r.linked);
      }
      return { customers, primaries, turfs, estimates, acceptedBy };
    },
    applyEstimateLawnSqft: applyFn,
  });

  test('dry run classifies everything and writes nothing', async () => {
    const apply = jest.fn();
    const out = await script.runBackfill({ knex: {}, today: '2026-10-04', apply: false }, deps(apply));
    expect(apply).not.toHaveBeenCalled();
    expect(out.counts).toMatchObject({ differs: 1, turf_profile_empty: 1, same: 1, mirrors_differ: 1, ambiguous: 1, estimate_has_no_confirmed_size: 1, estimate_for_another_property: 1 });
  });

  test('--apply writes only differs and turf_profile_empty, one customer at a time, through the shared writer', async () => {
    const apply = jest.fn(async (_k, { customerId }) => ({ status: 'written', sqft: 5200, before: { turf_lawn_sqft: customerId === 'c1' ? 4000 : null }, after: { turf_lawn_sqft: 5200 } }));
    const out = await script.runBackfill({ knex: { tag: 'db' }, today: '2026-10-04', apply: true }, deps(apply));
    expect(apply.mock.calls.map(([, a]) => a.customerId)).toEqual(['c1', 'c2', 'c7']);
    expect(apply.mock.calls[0][0]).toEqual({ tag: 'db' });
    expect(apply.mock.calls[0][1]).toMatchObject({ trigger: 'backfill', estimate: expect.objectContaining({ id: 'e1' }) });
    expect(out.applied.map((a) => [a.customer_id, a.status])).toEqual([['c1', 'written'], ['c2', 'written'], ['c7', 'written']]);
  });

  test('an error on one customer is recorded and the next customer still runs', async () => {
    const apply = jest.fn(async (_k, { customerId }) => {
      if (customerId === 'c1') throw new Error('boom');
      return { status: 'written', sqft: 5200, before: {}, after: { turf_lawn_sqft: 5200 } };
    });
    const out = await script.runBackfill({ knex: {}, today: '2026-10-04', apply: true }, deps(apply));
    expect(out.applied.map((a) => [a.customer_id, a.status])).toEqual([['c1', 'error'], ['c2', 'written'], ['c7', 'written']]);
  });

  test('--only and --limit narrow the set', async () => {
    const apply = jest.fn(async () => ({ status: 'unchanged', before: {}, after: {} }));
    expect((await script.runBackfill({ knex: {}, today: 'x', only: 'c3' }, deps(apply))).rows.map((r) => r.customer_id)).toEqual(['c3']);
    expect((await script.runBackfill({ knex: {}, today: 'x', limit: 2 }, deps(apply))).rows).toHaveLength(2);
  });
});

describe('concurrent acceptance between the read and the write', () => {
  // The first read decides "c1: turf 4000, estimate e1 (5200) -> differs". A newer
  // estimate e2 (6100) is then accepted and commits before the backfill's fence.
  const setup = () => {
    const state = { links: ['e1'], accepted: false };
    const e1 = est('e1', { accepted_at: '2026-06-01T00:00:00Z' });
    const e2 = est('e2', { accepted_at: '2026-10-04T00:00:00Z', estimate_data: data(6100) });
    const deps = {
      loadLawnCustomers: async () => [{ customer_id: 'c1', estimate_ids: state.links }],
      loadRows: async () => ({
        customers: new Map([['c1', customer()]]), primaries: new Map([['c1', primary()]]),
        turfs: new Map([['c1', { lawn_sqft: state.accepted ? 6100 : 4000 }]]),
        estimates: new Map([['e1', e1], ['e2', e2]]), acceptedBy: new Map([['c1', state.accepted ? [e1, e2] : [e1]]]),
      }),
    };
    const acceptNewer = () => { state.accepted = true; state.links = ['e2']; };
    return { deps, acceptNewer };
  };

  test('the write is skipped (skipped_changed_since_read) when the re-read inside the fence finds a newer estimate', async () => {
    const { deps, acceptNewer } = setup();
    const wrote = jest.fn();
    // Stand-in for the shared writer: acceptance commits, then the fence is taken and revalidate runs.
    const applyFn = jest.fn(async (_k, args) => {
      acceptNewer();
      const stale = await args.revalidate({ tag: 'locked-trx' });
      if (stale) return { status: 'skipped', reason: 'changed_since_read', detail: stale };
      wrote(args);
      return { status: 'written', sqft: 5200, before: {}, after: {} };
    });
    const out = await script.runBackfill({ knex: {}, today: '2026-10-04', apply: true }, { ...deps, applyEstimateLawnSqft: applyFn });
    expect(wrote).not.toHaveBeenCalled();
    expect(out.applied).toEqual([expect.objectContaining({ customer_id: 'c1', status: 'skipped_changed_since_read', reason: expect.stringContaining('e1 -> e2') })]);
  });

  test('revalidation reads through the locked handle it is given, and passes when nothing changed', async () => {
    const { deps } = setup();
    const seen = [];
    const spyDeps = { ...deps, loadLawnCustomers: async (h, o) => { seen.push(h); return deps.loadLawnCustomers(h, o); } };
    const applyFn = jest.fn(async (_k, args) => {
      const stale = await args.revalidate({ tag: 'locked-trx' });
      return stale ? { status: 'skipped', reason: 'changed_since_read', detail: stale } : { status: 'written', sqft: 5200, before: {}, after: {} };
    });
    const out = await script.runBackfill({ knex: { tag: 'pool' }, today: '2026-10-04', apply: true }, { ...spyDeps, applyEstimateLawnSqft: applyFn });
    expect(out.applied[0].status).toBe('written');
    expect(seen).toEqual([{ tag: 'pool' }, { tag: 'locked-trx' }]);
  });
});

describe('dry run is read-only at the session level', () => {
  const fakeFactory = () => { const f = jest.fn((config) => ({ config, destroy: async () => {} })); return f; };
  const query = (config) => { const calls = []; const conn = { query: (sql, cb) => { calls.push(sql); cb(null); } }; const done = jest.fn(); config.pool.afterCreate(conn, done); return { calls, done, conn }; };

  test('buildKnex(readOnly) sets default_transaction_read_only on every new session', () => {
    const f = fakeFactory();
    script.buildKnex('postgresql://h/d', { readOnly: true }, f);
    const { calls, done, conn } = query(f.mock.calls[0][0]);
    expect(calls).toEqual(['SET default_transaction_read_only = on']);
    expect(done).toHaveBeenCalledWith(null, conn);
  });
  test('a failing SET fails the session instead of silently continuing writable', () => {
    const f = fakeFactory();
    script.buildKnex('postgresql://h/d', { readOnly: true }, f);
    const done = jest.fn();
    f.mock.calls[0][0].pool.afterCreate({ query: (_s, cb) => cb(new Error('no')) }, done);
    expect(done.mock.calls[0][0]).toBeInstanceOf(Error);
  });
  test('main: dry run builds a read-only pool; --apply does not', async () => {
    const original = console.log;
    console.log = jest.fn();
    const runBackfill = jest.fn(async () => ({ rows: [], applied: [], counts: script.summarize([]) }));
    const out = require('path').join(require('os').tmpdir(), `lawn-ro-${process.pid}.csv`);
    const env = { DATABASE_URL: 'postgresql://h.example.net:5432/d' };
    const dry = fakeFactory();
    await script.main(['--out', out], env, { knexFactory: dry, runBackfill });
    expect(dry.mock.calls[0][0].pool.afterCreate).toEqual(expect.any(Function));
    const app = fakeFactory();
    await script.main(['--apply', '--i-am-sure-this-is-the-intended-database', '--out', out], env, { knexFactory: app, runBackfill });
    expect(app.mock.calls[0][0].pool.afterCreate).toBeUndefined();
    for (const f of [out, `${out}.summary.txt`, `${out}.applied.csv`]) require('fs').rmSync(f, { force: true });
    console.log = original;
  });
});

describe('CLI guards', () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  afterAll(() => log.mockRestore());

  test('parseArgs reads flags and valued flags', () => {
    expect(script.parseArgs(['--apply', '--out', '/x.csv', '--limit=5', '--only', 'c1']))
      .toEqual({ apply: true, out: '/x.csv', limit: '5', only: 'c1' });
  });
  test('refuses to run without DATABASE_URL', async () => {
    await expect(script.main(['--out', '/x.csv'], {})).rejects.toThrow('DATABASE_URL is not set');
  });
  test('refuses --apply without the explicit database flag, after printing the masked host', async () => {
    await expect(script.main(['--apply', '--out', '/x.csv'], { DATABASE_URL: 'postgresql://user:secretpw@db.example-host.net:5432/railway' }))
      .rejects.toThrow('--i-am-sure-this-is-the-intended-database');
    const printed = log.mock.calls.flat().join('\n');
    expect(printed).toContain('host=db***net');
    expect(printed).not.toMatch(/secretpw|user:/);
  });
  test('refuses both --dry-run and --apply, and a missing --out', async () => {
    await expect(script.main(['--apply', '--dry-run', '--out', '/x'], { DATABASE_URL: 'postgresql://h/d' })).rejects.toThrow('not both');
    await expect(script.main([], { DATABASE_URL: 'postgresql://h/d' })).rejects.toThrow('--out');
  });
  test('describeDatabase masks host and database and never shows credentials', () => {
    const text = script.describeDatabase('postgresql://admin:pw123@monorail.proxy.rlwy.net:41234/railway');
    expect(text).toBe('host=mo***net port=41234 database=ra***way');
  });
});
