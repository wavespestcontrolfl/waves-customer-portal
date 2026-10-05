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

describe('unconfirmed guess for a customer with no size at all (--use-unconfirmed-when-empty)', () => {
  const guessEst = (sqft = 4793, basis = 'estimatedTurfSf') => est('g1', { estimate_data: data(sqft, basis) });
  const run = (input, flag = true) => script.classifyCustomer({ customer: customer(), primary: primary(), turf: null, linked: [guessEst()], accepted: [], ...input }, { useUnconfirmedWhenEmpty: flag });

  test('empty + AI guess + flag: its own class, guess and basis shown, has_any_size no', () => {
    expect(run({})).toMatchObject({ class: 'turf_profile_empty_unconfirmed', reason: 'unconfirmed_estimate', guess_sqft: 4793, guess_basis: 'estimatedTurfSf', guess_flag: '', has_any_size: 'no' });
  });
  test('turf 0 with no mirror size counts as empty', () => {
    expect(run({ turf: { lawn_sqft: 0 } }).class).toBe('turf_profile_empty_unconfirmed');
  });
  test('without the flag the row stays estimate_has_no_confirmed_size, with the guess still visible', () => {
    expect(run({}, false)).toMatchObject({ class: 'estimate_has_no_confirmed_size', guess_sqft: 4793, guess_basis: 'estimatedTurfSf', has_any_size: 'no' });
  });
  test('any existing size, in turf or either mirror, is never replaced by a guess', () => {
    for (const input of [
      { turf: { lawn_sqft: 4000 } },
      { customer: customer({ property_sqft: 3000 }) },
      { primary: primary({ property_sqft: 3000 }) },
    ]) {
      expect(run(input)).toMatchObject({ class: 'estimate_has_no_confirmed_size', guess_sqft: 4793, has_any_size: 'yes' });
    }
  });
  test.each([[300, 'under_500'], [499, 'under_500'], [20001, 'over_20000'], [30000, 'over_20000']])('a guess of %i is flagged %s for a person and not offered for writing', (sqft, flag) => {
    expect(run({ linked: [guessEst(sqft)] })).toMatchObject({ class: 'estimate_has_no_confirmed_size', guess_sqft: sqft, guess_flag: flag });
  });
  test('the floor and ceiling themselves are accepted', () => {
    expect(run({ linked: [guessEst(500)] }).class).toBe('turf_profile_empty_unconfirmed');
    expect(run({ linked: [guessEst(20000)] }).class).toBe('turf_profile_empty_unconfirmed');
  });
  test('a lot-fallback basis is a guess too, and its basis is shown', () => {
    expect(run({ linked: [guessEst(3900, 'lotFallback')] })).toMatchObject({ class: 'turf_profile_empty_unconfirmed', guess_basis: 'lotFallback' });
  });
  test('an estimate for another property gets no guess class', () => {
    expect(run({ linked: [est('g2', { property_id: 'p9', estimate_data: data(4793, 'estimatedTurfSf') })] }).class).toBe('estimate_for_another_property');
  });
  test('two linked estimates priced on different unconfirmed sizes are ambiguous with the flag, never written', () => {
    const a = est('ga', { accepted_at: '2026-01-01T00:00:00Z', estimate_data: data(4000, 'estimatedTurfSf') });
    const b = est('gb', { accepted_at: '2026-06-01T00:00:00Z', estimate_data: data(5200, 'estimatedTurfSf') });
    expect(run({ linked: [a, b] })).toMatchObject({ class: 'ambiguous', reason: 'linked_estimates_disagree', candidate_count: 2 });
    // different basis with the same size is a different guess too
    const c = est('gc', { estimate_data: data(4000, 'lotFallback') });
    expect(run({ linked: [a, c] }).class).toBe('ambiguous');
  });
  test('two linked estimates with the same unconfirmed guess are not ambiguous; without the flag nothing changes from before', () => {
    const a = est('ga', { accepted_at: '2026-01-01T00:00:00Z', estimate_data: data(4000, 'estimatedTurfSf') });
    const b = est('gb', { accepted_at: '2026-06-01T00:00:00Z', estimate_data: data(4000, 'estimatedTurfSf') });
    expect(run({ linked: [a, b] })).toMatchObject({ class: 'turf_profile_empty_unconfirmed', estimate_id: 'gb' });
    const d = est('gd', { estimate_data: data(5200, 'estimatedTurfSf') });
    expect(run({ linked: [a, d] }, false).class).toBe('estimate_has_no_confirmed_size');
  });
  test('the summary lists customers with no size on file (ids only) with the guess', () => {
    const row = (() => { const { estimate, snapshot, ...r } = run({}, false); return r; })();
    const text = script.summaryText(script.summarize([row]), 1, 'dry run', [row]);
    expect(text).toContain('customers with no lawn size on file (1)');
    expect(text).toContain('c1  estimate_has_no_confirmed_size  guess 4793 (estimatedTurfSf)');
  });
});

describe('no_accepted_lawn_estimate: information about unaccepted estimates (never written)', () => {
  const expired = (id, created, sqft, basis, over = {}) => est(id, { status: 'expired', accepted_at: null, created_at: created, estimate_data: data(sqft, basis), ...over });
  const run = (unaccepted) => script.classifyCustomer({ customer: customer(), primary: primary(), turf: null, linked: [], accepted: [], unaccepted });

  test('the newest unaccepted estimate carries a typed 1300 and an older one an AI size: both are shown, the class is unchanged', () => {
    const r = run([expired('old', '2026-03-01T00:00:00Z', 4793, 'estimatedTurfSf'), expired('new', '2026-08-01T00:00:00Z', 1300, 'measuredTurfSf')]);
    expect(r).toMatchObject({ class: 'no_accepted_lawn_estimate', unaccepted_confirmed_sqft: 1300, unaccepted_guess_sqft: 4793, unaccepted_estimate_status: 'expired' });
    expect(script.APPLY_CLASSES.has(r.class)).toBe(false);
  });
  test('nothing unaccepted, or only another property: the columns stay empty', () => {
    expect(run([])).toMatchObject({ class: 'no_accepted_lawn_estimate', unaccepted_confirmed_sqft: '', unaccepted_guess_sqft: '', unaccepted_estimate_status: '' });
    expect(run([expired('x', '2026-08-01T00:00:00Z', 1300, 'measuredTurfSf', { property_id: 'p9' })]).unaccepted_confirmed_sqft).toBe('');
  });
  test('other classes never carry the columns', () => {
    const r = script.classifyCustomer({ customer: customer(), primary: primary(), turf: null, linked: [est('e1')], accepted: [], unaccepted: [expired('x', '2026-08-01T00:00:00Z', 1300, 'measuredTurfSf')] });
    expect(r.class).toBe('turf_profile_empty');
    expect(r.unaccepted_confirmed_sqft).toBe('');
  });
  test('the CSV has the three columns', () => {
    expect(script.CSV_COLUMNS).toEqual(expect.arrayContaining(['unaccepted_confirmed_sqft', 'unaccepted_guess_sqft', 'unaccepted_estimate_status']));
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

describe('guess apply path and the office-edit race', () => {
  const guess = est('g1', { customer_id: 'c1', estimate_data: data(4793, 'estimatedTurfSf') });
  const loaders = (turf) => ({
    loadLawnCustomers: async () => [{ customer_id: 'c1', estimate_ids: ['g1'] }],
    loadRows: async () => ({
      customers: new Map([['c1', customer()]]), primaries: new Map([['c1', primary()]]),
      turfs: new Map(turf === undefined ? [] : [['c1', turf()]]), estimates: new Map([['g1', guess]]), acceptedBy: new Map([['c1', [guess]]]),
    }),
  });
  const writer = () => jest.fn(async (_k, args) => {
    const stale = await args.revalidate({});
    return stale ? { status: 'skipped', reason: 'changed_since_read', detail: stale } : { status: 'written', sqft: 4793, before: {}, after: {} };
  });

  test('flag + empty customer: written through the shared writer as backfill_unconfirmed', async () => {
    const apply = writer();
    const out = await script.runBackfill({ knex: {}, today: 't', apply: true, useUnconfirmedWhenEmpty: true }, { ...loaders(), applyEstimateLawnSqft: apply });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toMatchObject({ trigger: 'backfill_unconfirmed', allowUnconfirmedWhenEmpty: true });
    expect(out.applied[0]).toMatchObject({ class: 'turf_profile_empty_unconfirmed', status: 'written' });
  });
  test('no flag: the same customer is not written', async () => {
    const apply = writer();
    const out = await script.runBackfill({ knex: {}, today: 't', apply: true }, { ...loaders(), applyEstimateLawnSqft: apply });
    expect(apply).not.toHaveBeenCalled();
    expect(out.rows[0]).toMatchObject({ class: 'estimate_has_no_confirmed_size', guess_sqft: 4793 });
  });
  test('flag but the customer has a size: never written', async () => {
    const apply = writer();
    await script.runBackfill({ knex: {}, today: 't', apply: true, useUnconfirmedWhenEmpty: true }, { ...loaders(() => ({ lawn_sqft: 4000 })), applyEstimateLawnSqft: apply });
    expect(apply).not.toHaveBeenCalled();
  });
  test('dry run with the flag previews the class and writes nothing', async () => {
    const apply = writer();
    const out = await script.runBackfill({ knex: {}, today: 't', apply: false, useUnconfirmedWhenEmpty: true }, { ...loaders(), applyEstimateLawnSqft: apply });
    expect(out.rows[0].class).toBe('turf_profile_empty_unconfirmed');
    expect(apply).not.toHaveBeenCalled();
  });

  test('an office edit (turf 4000 -> 6100) between the read and the fence is not overwritten with the estimate size', async () => {
    const e1 = est('e1', { customer_id: 'c1' }); // confirmed 5200
    let turf = 4000;
    const deps = {
      loadLawnCustomers: async () => [{ customer_id: 'c1', estimate_ids: ['e1'] }],
      loadRows: async () => ({
        customers: new Map([['c1', customer()]]), primaries: new Map([['c1', primary()]]), turfs: new Map([['c1', { lawn_sqft: turf }]]),
        estimates: new Map([['e1', e1]]), acceptedBy: new Map([['c1', [e1]]]),
      }),
    };
    const wrote = jest.fn();
    const apply = jest.fn(async (_k, args) => {
      turf = 6100; // the office edit commits before the fence is taken
      const stale = await args.revalidate({});
      if (stale) return { status: 'skipped', reason: 'changed_since_read', detail: stale };
      wrote();
      return { status: 'written', sqft: 5200, before: {}, after: {} };
    });
    const out = await script.runBackfill({ knex: {}, today: 't', apply: true }, { ...deps, applyEstimateLawnSqft: apply });
    expect(out.rows[0].class).toBe('differs'); // 4000 vs 5200 ...
    expect(wrote).not.toHaveBeenCalled(); // ... and still differs at 6100, yet it is skipped
    expect(out.applied[0]).toMatchObject({ status: 'skipped_changed_since_read', reason: 'turf 4000 -> 6100' });
  });
  test('a changed mirror, primary-property identity or address key also skips', async () => {
    for (const [mutate, expected] of [
      [(st) => { st.primary = primary({ property_sqft: 111 }); }, 'primarySqft none -> 111'],
      [(st) => { st.customer = customer({ property_sqft: 222 }); }, 'customerSqft none -> 222'],
      [(st) => { st.primary = primary({ id: 'p-other' }); }, 'primary_property_changed'],
      [(st) => { st.primary = primary({ address_line1: '5 Elm St' }); st.customer = customer(); }, 'primary_address_changed'],
    ]) {
      const e1 = est('e1', { customer_id: 'c1' });
      const st = { customer: customer(), primary: primary() };
      const deps = {
        loadLawnCustomers: async () => [{ customer_id: 'c1', estimate_ids: ['e1'] }],
        loadRows: async () => ({ customers: new Map([['c1', st.customer]]), primaries: new Map([['c1', st.primary]]), turfs: new Map([['c1', { lawn_sqft: 4000 }]]), estimates: new Map([['e1', e1]]), acceptedBy: new Map([['c1', [e1]]]) }),
      };
      const apply = jest.fn(async (_k, args) => { mutate(st); const stale = await args.revalidate({}); return stale ? { status: 'skipped', reason: 'changed_since_read', detail: stale } : { status: 'written', before: {}, after: {} }; });
      const out = await script.runBackfill({ knex: {}, today: 't', apply: true }, { ...deps, applyEstimateLawnSqft: apply });
      expect(out.applied[0].status).toBe('skipped_changed_since_read');
      expect(out.applied[0].reason).toContain(expected);
    }
  });

  test('an address change is reported by NAME only: no digits, street or unit text in the reason, the log or the CSV', async () => {
    for (const [mutate, name] of [
      [(st) => { st.primary = primary({ address_line1: '77 Secret Lane Apt 9', zip: '34999' }); }, 'primary_address_changed'],
      [(st) => { st.customer = customer({ address_line1: '88 Hidden Way', zip: '34888' }); }, 'customer_address_changed'],
    ]) {
      const e1 = est('e1', { customer_id: 'c1' });
      const st = { customer: customer(), primary: primary() };
      const deps = {
        loadLawnCustomers: async () => [{ customer_id: 'c1', estimate_ids: ['e1'] }],
        loadRows: async () => ({ customers: new Map([['c1', st.customer]]), primaries: new Map([['c1', st.primary]]), turfs: new Map([['c1', { lawn_sqft: 4000 }]]), estimates: new Map([['e1', e1]]), acceptedBy: new Map([['c1', [e1]]]) }),
      };
      const apply = jest.fn(async (_k, args) => { mutate(st); const stale = await args.revalidate({}); return { status: 'skipped', reason: 'changed_since_read', detail: stale }; });
      const logs = [];
      const out = await script.runBackfill({ knex: {}, today: 't', apply: true, log: (m) => logs.push(m) }, { ...deps, applyEstimateLawnSqft: apply });
      expect(out.applied[0].reason).toBe(name);
      const everything = [out.applied[0].reason, ...logs, JSON.stringify(out.applied)].join('\n');
      expect(everything).not.toMatch(/Secret|Hidden|Lane|Way|Apt|34999|34888|Main|Bradenton|34205/i);
      expect(out.applied[0].reason).not.toMatch(/\d/);
    }
  });

  test('a database error reaches the log and the CSV as a code only', async () => {
    const e1 = est('e1', { customer_id: 'c1' });
    const deps = {
      loadLawnCustomers: async () => [{ customer_id: 'c1', estimate_ids: ['e1'] }],
      loadRows: async () => ({ customers: new Map([['c1', customer()]]), primaries: new Map([['c1', primary()]]), turfs: new Map([['c1', { lawn_sqft: 4000 }]]), estimates: new Map([['e1', e1]]), acceptedBy: new Map([['c1', [e1]]]) }),
    };
    const logs = [];
    const boom = Object.assign(new Error('duplicate key Key (address)=(100 Main St) already exists'), { code: '23505' });
    const out = await script.runBackfill({ knex: {}, today: 't', apply: true, log: (m) => logs.push(m) }, { ...deps, applyEstimateLawnSqft: async () => { throw boom; } });
    expect(out.applied[0]).toMatchObject({ status: 'error', reason: 'error_23505' });
    expect(logs.join('\n')).not.toMatch(/Main St/);
  });
});

describe('--set-size (owner-stated size for an empty customer)', () => {
  const entry = (id) => ({ customer_id: id, estimate_ids: [] });
  const world = (over = {}) => {
    const st = { live: ['c1'], turf: null, customerSqft: null, primarySqft: null, ...over };
    return {
      st,
      deps: {
        loadLawnCustomers: async (_h, { only }) => st.live.filter((id) => !only || id === only).map(entry),
        loadRows: async () => ({
          customers: new Map([['c1', customer({ property_sqft: st.customerSqft })]]), primaries: new Map([['c1', primary({ property_sqft: st.primarySqft })]]),
          turfs: new Map(st.turf == null ? [] : [['c1', { lawn_sqft: st.turf }]]), estimates: new Map(), acceptedBy: new Map(),
        }),
      },
    };
  };
  const run = (deps, targets, extra = {}) => script.runOwnerSet({ knex: { tag: 'db' }, today: 't', targets, reason: 'owner: use 1300', ...extra }, deps);

  test('fills an empty size through the shared writer with the reason', async () => {
    const { deps } = world();
    const apply = jest.fn(async (_k, args) => { expect(await args.revalidate({})).toBeNull(); return { status: 'written', sqft: 1300 }; });
    const out = await run({ ...deps, applyOwnerSetLawnSqft: apply }, [{ customerId: 'c1', sqft: 1300 }], { apply: true });
    expect(out).toEqual([{ customer_id: 'c1', sqft: 1300, status: 'written', reason: '' }]);
    expect(apply).toHaveBeenCalledWith({ tag: 'db' }, expect.objectContaining({ customerId: 'c1', sqft: 1300, reason: 'owner: use 1300' }));
  });
  test.each([['turf', { turf: 4000 }], ['customer mirror', { customerSqft: 3000 }], ['primary mirror', { primarySqft: 3000 }]])('refuses when the %s already has a size, and says where', async (_n, over) => {
    const { deps } = world(over);
    const apply = jest.fn();
    const out = await run({ ...deps, applyOwnerSetLawnSqft: apply }, [{ customerId: 'c1', sqft: 1300 }], { apply: true });
    expect(out[0]).toMatchObject({ status: 'refused', reason: expect.stringMatching(/^has_size_in_/) });
    expect(apply).not.toHaveBeenCalled();
  });
  test.each([499, 20001, 0, 1.5])('refuses an out-of-bounds size (%s)', async (sqft) => {
    const { deps } = world();
    const apply = jest.fn();
    expect((await run({ ...deps, applyOwnerSetLawnSqft: apply }, [{ customerId: 'c1', sqft }], { apply: true }))[0]).toMatchObject({ status: 'refused', reason: 'out_of_bounds' });
    expect(apply).not.toHaveBeenCalled();
  });
  test('refuses a customer outside the candidate set', async () => {
    const { deps } = world();
    const apply = jest.fn();
    expect((await run({ ...deps, applyOwnerSetLawnSqft: apply }, [{ customerId: 'other', sqft: 1300 }], { apply: true }))[0]).toMatchObject({ status: 'refused', reason: 'not_a_live_lawn_customer' });
    expect(apply).not.toHaveBeenCalled();
  });
  test('a dry run reports would_set and writes nothing', async () => {
    const { deps } = world();
    const apply = jest.fn();
    expect(await run({ ...deps, applyOwnerSetLawnSqft: apply }, [{ customerId: 'c1', sqft: 1300 }], { apply: false })).toEqual([{ customer_id: 'c1', sqft: 1300, status: 'would_set', reason: '' }]);
    expect(apply).not.toHaveBeenCalled();
  });
  test('a size that appears between the read and the fence stops the write', async () => {
    const { deps, st } = world();
    const apply = jest.fn(async (_k, args) => { st.turf = 3300; const stale = await args.revalidate({}); return { status: 'skipped', reason: 'changed_since_read', detail: stale }; });
    const out = await run({ ...deps, applyOwnerSetLawnSqft: apply }, [{ customerId: 'c1', sqft: 1300 }], { apply: true });
    expect(out[0]).toMatchObject({ status: 'skipped_changed_since_read', reason: 'turf none -> 3300' });
  });
  test('CLI: needs --set-reason, --apply needs the confirmation flag, and it runs on its own', async () => {
    const env = { DATABASE_URL: 'postgresql://h.example.net:5432/d' };
    const original = console.log; console.log = jest.fn();
    try {
      const id = '11111111-2222-3333-4444-555555555555';
      await expect(script.main(['--set-size', `${id}=1300`, '--out', '/x'], env, {})).rejects.toThrow('--set-reason');
      await expect(script.main(['--set-size', `${id}=1300`, '--set-reason', 'r', '--apply', '--out', '/x'], env, {})).rejects.toThrow('--i-am-sure');
      await expect(script.main(['--set-size', 'nope', '--set-reason', 'r', '--out', '/x'], env, { knexFactory: () => ({ destroy: async () => {} }) })).rejects.toThrow('<customerId>=<sqft>');
      await expect(script.main(['--set-size', `${id}=1300`, '--set-reason', 'r', '--only', 'x', '--out', '/x'], env, {})).rejects.toThrow('on its own');
      const runOwnerSet = jest.fn(async () => []);
      const out = require('path').join(require('os').tmpdir(), `lawn-set-${process.pid}.csv`);
      const f = jest.fn(() => ({ destroy: async () => {} }));
      await script.main(['--set-size', `${id}=1300`, '--set-size', `22222222-2222-3333-4444-555555555555=900`, '--set-reason', 'owner ruling', '--out', out], env, { knexFactory: f, runOwnerSet });
      expect(runOwnerSet.mock.calls[0][0]).toMatchObject({ apply: false, reason: 'owner ruling', targets: [{ customerId: id, sqft: 1300 }, { customerId: '22222222-2222-3333-4444-555555555555', sqft: 900 }] });
      expect(f.mock.calls[0][0].pool.afterCreate).toEqual(expect.any(Function)); // dry run stays read-only
      require('fs').rmSync(out, { force: true });
    } finally { console.log = original; }
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
    expect(runBackfill.mock.calls.map(([a]) => a.useUnconfirmedWhenEmpty)).toEqual([false, false]);
    await script.main(['--use-unconfirmed-when-empty', '--out', out], env, { knexFactory: fakeFactory(), runBackfill });
    expect(runBackfill.mock.calls[2][0].useUnconfirmedWhenEmpty).toBe(true);
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
