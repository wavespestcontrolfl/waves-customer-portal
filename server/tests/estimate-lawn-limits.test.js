// GATE_ESTIMATE_LAWN_LIMITS: the "What we can and can't fix" block on a recurring lawn
// estimate (services/estimate-lawn-limits.js). Gate off = nothing; a non-lawn estimate =
// nothing; each turf profile flag adds exactly its own line. Synthetic data only.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const limits = require('../services/estimate-lawn-limits');

const lawnEstimate = (extra = {}) => ({
  id: 'e1',
  customer_id: 'cust-1',
  estimate_data: { result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6 }] } } },
  ...extra,
});
const pestEstimate = () => ({
  id: 'e2',
  customer_id: 'cust-1',
  estimate_data: { result: { recurring: { services: [{ service: 'pest_control', name: 'Pest Control', visitsPerYear: 4 }] } } },
});

// A small in-memory knex: tables are arrays of rows; where({..}), where(fn) with where/orWhere/
// orWhereNull inside (the active scope), select(), first() and awaiting the builder all work.
function memKnex(tables, { failOn = null } = {}) {
  const calls = [];
  const knex = (table) => {
    calls.push(table);
    const rows = tables[table] || [];
    const eq = [];
    const groups = [];
    const q = {};
    const recorder = (target) => ({
      where(o) { target.push(['eq', o]); return this; },
      orWhere(o) { target.push(['eq', o]); return this; },
      orWhereNull(c) { target.push(['null', c]); return this; },
    });
    q.where = (arg) => {
      if (typeof arg === 'function') { const alts = []; arg.call(recorder(alts)); groups.push(alts); } else eq.push(arg);
      return q;
    };
    q.select = () => q;
    const has = (row, o) => Object.entries(o).every(([k, v]) => row[k] === v);
    const match = (row) => eq.every((o) => has(row, o))
      && groups.every((alts) => alts.some(([kind, x]) => (kind === 'eq' ? has(row, x) : row[x] == null)));
    const run = () => { if (failOn === table) throw new Error('db down'); return rows.filter(match); };
    q.first = async () => run()[0];
    q.then = (resolve, reject) => { try { return Promise.resolve(run()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); } };
    return q;
  };
  knex.calls = calls;
  return knex;
}

const PROP_A = 'prop-a';
const PROP_B = 'prop-b';
const ONE_PROPERTY = [{ id: PROP_A, customer_id: 'cust-1', active: true, is_primary: true }];
const TWO_PROPERTIES = [
  { id: PROP_A, customer_id: 'cust-1', active: true, is_primary: true },
  { id: PROP_B, customer_id: 'cust-1', active: true, is_primary: false },
];
const profile = (over = {}) => ({ customer_id: 'cust-1', active: true, grass_type: 'st_augustine', other_grasses: null, virus_streaks_suspected: null, ...over });
const world = ({ props = ONE_PROPERTY, profiles = [profile()], customers = [{ id: 'cust-1', lawn_type: null }] } = {}) => memKnex({
  customer_properties: props, customer_turf_profiles: profiles, customers,
});
const keysOf = (block) => block.paragraphs.map((p) => p.key);

afterEach(() => { delete process.env.GATE_ESTIMATE_LAWN_LIMITS; });

describe('copy (the owner wording, word for word)', () => {
  test('heading and the fixed paragraph', () => {
    expect(limits.HEADING).toBe("What we can and can't fix");
    expect(limits.ALWAYS_TEXT).toBe("Our program clears most broadleaf weeds, sedge and dollarweed out of St. Augustine. A few grassy weeds are different: torpedograss, dallisgrass and bermudagrass have no spray that takes them out without hurting St. Augustine too. If we see them, we'll tell you, and we can spot-kill and replug those areas or add our bermuda removal service.");
  });

  test.each([
    ['carpetgrass', "Part of your lawn is carpetgrass. It looks a lot like St. Augustine, but our weed product kills it, so we'll keep it off those patches and talk with you about replugging them."],
    ['bahiagrass', "We saw bahiagrass mixed into your St. Augustine. There's no spray that removes it on its own, so spot-kill and replug is the fix."],
    ['bermudagrass', 'Bermudagrass is creeping into your St. Augustine. Our bermuda removal service holds it back over the season; nothing clears it in one visit.'],
    ['torpedograss', "We saw torpedograss in your lawn. It won't respond to our regular program, so spot-kill and replug is the fix for those areas."],
    ['dallisgrass', "We saw dallisgrass in your lawn. It won't respond to our regular program, so spot-kill and replug is the fix for those areas."],
  ])('%s line', (name, text) => {
    expect(limits.GRASS_TEXT[name]).toBe(text);
    const block = limits.buildLawnLimits({ otherGrasses: [name] });
    expect(block.paragraphs).toEqual([{ key: 'always', text: limits.ALWAYS_TEXT }, { key: name, text }]);
  });

  test('virus line', () => {
    expect(limits.VIRUS_TEXT).toBe("Some of your Floratam has yellow streaks that look like a virus that affects this grass. No treatment cures it. If it spreads, replanting with Palmetto or CitraBlue St. Augustine is the lasting fix, and we'll help you plan it.");
    const block = limits.buildLawnLimits({ virusStreaksSuspected: true });
    expect(block.paragraphs.map((p) => p.key)).toEqual(['always', 'virus_streaks']);
  });

  test('no flags: the fixed paragraph alone', () => {
    expect(limits.buildLawnLimits()).toEqual({ heading: limits.HEADING, paragraphs: [{ key: 'always', text: limits.ALWAYS_TEXT }] });
  });

  test('every flag: fixed paragraph, grasses in list order, virus last; unknown names dropped', () => {
    const block = limits.buildLawnLimits({
      otherGrasses: ['dallisgrass', 'carpetgrass', 'zoysia', 'carpetgrass'],
      virusStreaksSuspected: true,
    });
    expect(block.paragraphs.map((p) => p.key)).toEqual(['always', 'carpetgrass', 'dallisgrass', 'virus_streaks']);
  });

  test('a flag that is not exactly true adds no virus line', () => {
    expect(limits.buildLawnLimits({ virusStreaksSuspected: 'true' }).paragraphs).toHaveLength(1);
    expect(limits.buildLawnLimits({ virusStreaksSuspected: null }).paragraphs).toHaveLength(1);
  });

  test('no copy carries a dollar amount', () => {
    const all = [limits.ALWAYS_TEXT, limits.VIRUS_TEXT, ...Object.values(limits.GRASS_TEXT), limits.CARPETGRASS_CELSIUS_WARNING].join(' ');
    expect(all).not.toMatch(/\$|\d/);
  });
});

describe('which estimates carry it', () => {
  test('a recurring lawn estimate is a lawn estimate; pest-only and a malformed row are not', () => {
    expect(limits.estimateHasRecurringLawn(lawnEstimate())).toBe(true);
    expect(limits.estimateHasRecurringLawn(pestEstimate())).toBe(false);
    expect(limits.estimateHasRecurringLawn({ id: 'x', estimate_data: '{not json' })).toBe(false);
    expect(limits.estimateHasRecurringLawn(null)).toBe(false);
  });

  test('gate off: null, and nothing is read', async () => {
    const knex = world({ profiles: [profile({ other_grasses: ['carpetgrass'], virus_streaks_suspected: true })] });
    expect(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex })).toBeNull();
    expect(await limits.lawnLimitsBlock(lawnEstimate(), { knex })).toEqual({});
    expect(knex.calls).toEqual([]);
  });

  test('gate on, non-lawn estimate: null and nothing is read', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const knex = world({ profiles: [profile({ other_grasses: ['carpetgrass'] })] });
    expect(await limits.lawnLimitsForEstimate(pestEstimate(), { knex })).toBeNull();
    expect(await limits.lawnLimitsBlock(pestEstimate(), { knex })).toEqual({});
    expect(knex.calls).toEqual([]);
  });

  test.each(['1', 'on', 'TRUE', ''])('the gate reads on only for exactly "true" (%p)', async (value) => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = value;
    expect(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex: world() })).toBeNull();
  });

  test('gate on, lawn estimate, flags set: the fixed paragraph plus one line per flag', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const knex = world({ profiles: [profile({ other_grasses: ['bahiagrass', 'torpedograss'], virus_streaks_suspected: true })] });
    const block = await limits.lawnLimitsForEstimate(lawnEstimate(), { knex });
    expect(block.heading).toBe("What we can and can't fix");
    expect(keysOf(block)).toEqual(['always', 'bahiagrass', 'torpedograss', 'virus_streaks']);
    expect(await limits.lawnLimitsBlock(lawnEstimate(), { knex })).toEqual({ lawnLimits: block });
  });

  test('gate on, lawn estimate, no profile or NULL flags: the fixed paragraph alone', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    for (const profiles of [[], [profile()]]) {
      const block = await limits.lawnLimitsForEstimate(lawnEstimate(), { knex: world({ profiles }) });
      expect(keysOf(block)).toEqual(['always']);
    }
  });

  test('an estimate with no customer reads nothing and still gets the fixed paragraph', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const knex = world({ profiles: [profile({ other_grasses: ['carpetgrass'] })] });
    const block = await limits.lawnLimitsForEstimate(lawnEstimate({ customer_id: null }), { knex });
    expect(keysOf(block)).toEqual(['always']);
    expect(knex.calls).toEqual([]);
  });

  test('a failed read still gives the fixed paragraph, never throws', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    for (const failOn of ['customer_turf_profiles', 'customer_properties']) {
      const knex = memKnex({ customer_properties: ONE_PROPERTY, customer_turf_profiles: [profile({ other_grasses: ['carpetgrass'] })] }, { failOn });
      expect(keysOf(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex }))).toEqual(['always']);
    }
  });
});

describe('only the ACTIVE turf profile counts', () => {
  beforeEach(() => { process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true'; });

  test('an inactive profile gives no flag lines', async () => {
    const knex = world({ profiles: [profile({ active: false, other_grasses: ['carpetgrass'], virus_streaks_suspected: true })] });
    expect(keysOf(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex }))).toEqual(['always']);
  });

  test('an inactive profile of a bermuda lawn does not hide the block either', async () => {
    const knex = world({ profiles: [profile({ active: false, grass_type: 'bermuda' })] });
    expect(keysOf(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex }))).toEqual(['always']);
  });

  test('a legacy profile with active NULL counts, as in the canonical loader', async () => {
    const knex = world({ profiles: [profile({ active: null, other_grasses: ['dallisgrass'] })] });
    expect(keysOf(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex }))).toEqual(['always', 'dallisgrass']);
  });

  test('the tech-sheet flag read follows the same scope', async () => {
    expect((await limits.loadLawnLimitFlags('cust-1', PROP_A, world({ profiles: [profile({ active: false, other_grasses: ['carpetgrass'] })] }))).otherGrasses).toEqual([]);
    expect((await limits.loadLawnLimitFlags('cust-1', PROP_A, world({ profiles: [profile({ other_grasses: ['carpetgrass'] })] }))).otherGrasses).toEqual(['carpetgrass']);
  });
});

describe('the profile speaks for one property only', () => {
  beforeEach(() => { process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true'; });
  const flagged = [profile({ other_grasses: ['carpetgrass'], virus_streaks_suspected: true })];

  test('one property, estimate names none: the profile applies', async () => {
    const block = await limits.lawnLimitsForEstimate(lawnEstimate({ property_id: null }), { knex: world({ profiles: flagged }) });
    expect(keysOf(block)).toEqual(['always', 'carpetgrass', 'virus_streaks']);
  });

  test('one property, estimate names it: the profile applies', async () => {
    const block = await limits.lawnLimitsForEstimate(lawnEstimate({ property_id: PROP_A }), { knex: world({ profiles: flagged }) });
    expect(keysOf(block)).toEqual(['always', 'carpetgrass', 'virus_streaks']);
  });

  test('several properties, estimate is for the one the profile speaks for (the primary): applies', async () => {
    const block = await limits.lawnLimitsForEstimate(lawnEstimate({ property_id: PROP_A }), { knex: world({ props: TWO_PROPERTIES, profiles: flagged }) });
    expect(keysOf(block)).toEqual(['always', 'carpetgrass', 'virus_streaks']);
  });

  test('several properties, estimate is for another property: fixed paragraph only', async () => {
    const block = await limits.lawnLimitsForEstimate(lawnEstimate({ property_id: PROP_B }), { knex: world({ props: TWO_PROPERTIES, profiles: flagged }) });
    expect(keysOf(block)).toEqual(['always']);
  });

  test('several properties, estimate names no property: fails closed, fixed paragraph only', async () => {
    const block = await limits.lawnLimitsForEstimate(lawnEstimate({ property_id: null }), { knex: world({ props: TWO_PROPERTIES, profiles: flagged }) });
    expect(keysOf(block)).toEqual(['always']);
  });

  test('a property the customer does not have: fixed paragraph only', async () => {
    const block = await limits.lawnLimitsForEstimate(lawnEstimate({ property_id: 'prop-elsewhere' }), { knex: world({ profiles: flagged }) });
    expect(keysOf(block)).toEqual(['always']);
  });

  test('a customer with no property rows and an estimate naming none is a legacy single home: applies', async () => {
    const block = await limits.lawnLimitsForEstimate(lawnEstimate({ property_id: null }), { knex: world({ props: [], profiles: flagged }) });
    expect(keysOf(block)).toEqual(['always', 'carpetgrass', 'virus_streaks']);
  });

  test('the tech-sheet read: wrong property and several-properties-no-property give no flags', async () => {
    const two = world({ props: TWO_PROPERTIES, profiles: flagged });
    expect((await limits.loadLawnLimitFlags('cust-1', PROP_B, two)).otherGrasses).toEqual([]);
    expect((await limits.loadLawnLimitFlags('cust-1', null, two)).otherGrasses).toEqual([]);
    expect((await limits.loadLawnLimitFlags('cust-1', PROP_A, two)).otherGrasses).toEqual(['carpetgrass']);
  });
});

describe('the St. Augustine paragraph only goes on St. Augustine lawns', () => {
  beforeEach(() => { process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true'; });

  test.each(['bermuda', 'zoysia', 'bahia', 'mixed'])('a %s lawn gets no block at all', async (grass) => {
    const knex = world({ profiles: [profile({ grass_type: grass, other_grasses: ['carpetgrass'], virus_streaks_suspected: true })] });
    expect(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex })).toBeNull();
    expect(await limits.lawnLimitsBlock(lawnEstimate(), { knex })).toEqual({});
  });

  test.each([['st_augustine'], ['unknown'], [null], ['']])('grass %p keeps the block', async (grass) => {
    const knex = world({ profiles: [profile({ grass_type: grass })] });
    expect(keysOf(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex }))).toEqual(['always']);
  });

  test('no profile and no legacy lawn text: unknown grass keeps the block', async () => {
    expect(keysOf(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex: world({ profiles: [] }) }))).toEqual(['always']);
  });

  test('a profile with no grass falls back to its track, then the customer legacy lawn text', async () => {
    const byTrack = world({ profiles: [profile({ grass_type: null, track_key: 'zoysia' })] });
    expect(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex: byTrack })).toBeNull();
    const byText = world({ profiles: [profile({ grass_type: null })], customers: [{ id: 'cust-1', lawn_type: 'Empire Zoysia' }] });
    expect(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex: byText })).toBeNull();
    const augustineText = world({ profiles: [], customers: [{ id: 'cust-1', lawn_type: 'Floratam full sun' }] });
    expect(keysOf(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex: augustineText }))).toEqual(['always']);
  });

  test('the recorded grass of another property is not used: several properties, wrong property keeps the block', async () => {
    const knex = world({ props: TWO_PROPERTIES, profiles: [profile({ grass_type: 'bermuda' })] });
    expect(keysOf(await limits.lawnLimitsForEstimate(lawnEstimate({ property_id: PROP_B }), { knex }))).toEqual(['always']);
  });
});

// ── frozen at accept ─────────────────────────────────────────────────────────
const OPEN = () => lawnEstimate({ status: 'sent', expires_at: new Date(Date.now() + 86400000).toISOString() });
const withSnapshot = (estimate, block) => ({ ...estimate, estimate_data: { ...estimate.estimate_data, [limits.SNAPSHOT_KEY]: block } });
const flagged = (over) => world({ profiles: [profile(over)] });

describe('which estimates are terminal', () => {
  test.each(['accepted', 'declined', 'expired'])('status %s is frozen', (status) => {
    expect(limits.lawnLimitsFrozen({ status })).toBe(true);
  });
  test.each([['price_locked_at', '2026-10-01T00:00:00Z'], ['archived_at', '2026-10-01T00:00:00Z']])('%s freezes it', (key, value) => {
    expect(limits.lawnLimitsFrozen({ status: 'sent', [key]: value })).toBe(true);
  });
  test('past its expiry is frozen; a future expiry, a draft and a bare row are open', () => {
    expect(limits.lawnLimitsFrozen({ status: 'sent', expires_at: '2020-01-01T00:00:00Z' })).toBe(true);
    expect(limits.lawnLimitsFrozen({ status: 'sent', expires_at: new Date(Date.now() + 86400000).toISOString() })).toBe(false);
    expect(limits.lawnLimitsFrozen({ status: 'draft' })).toBe(false);
    expect(limits.lawnLimitsFrozen({})).toBe(false);
    expect(limits.lawnLimitsFrozen(null)).toBe(false);
  });
});

describe('an open estimate follows the live flags; an accepted one prints only its stored block', () => {
  beforeEach(() => { process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true'; });

  test('open: a flag change shows at once', async () => {
    expect(keysOf(await limits.lawnLimitsForEstimate(OPEN(), { knex: flagged({}) }))).toEqual(['always']);
    expect(keysOf(await limits.lawnLimitsForEstimate(OPEN(), { knex: flagged({ other_grasses: ['carpetgrass'] }) }))).toEqual(['always', 'carpetgrass']);
  });

  test('accept freezes it: the stored block is what every later read gives, whatever the profile says', async () => {
    // At accept: the live block is read, then stored on the row.
    const atAccept = await limits.lawnLimitsToStampAtAccept(OPEN(), { knex: flagged({ other_grasses: ['carpetgrass'] }) });
    expect(keysOf(atAccept)).toEqual(['always', 'carpetgrass']);
    const accepted = withSnapshot({ ...OPEN(), status: 'accepted', price_locked_at: '2026-10-22T00:00:00Z' }, atAccept);
    // Afterwards the office changes the flags every way it can.
    for (const knex of [
      flagged({ other_grasses: null }),
      flagged({ other_grasses: ['bahiagrass'], virus_streaks_suspected: true }),
      flagged({ grass_type: 'bermuda' }),
      flagged({ active: false }),
      world({ profiles: [] }),
    ]) {
      expect(await limits.lawnLimitsForEstimate(accepted, { knex })).toEqual(atAccept);
      expect(await limits.lawnLimitsBlock(accepted, { knex })).toEqual({ lawnLimits: atAccept });
      expect(knex.calls).toEqual([]);
    }
  });

  test.each([
    ['declined', { status: 'declined' }],
    ['expired', { status: 'expired' }],
    ['past expiry', { status: 'sent', expires_at: '2020-01-01T00:00:00Z' }],
    ['price locked', { status: 'sent', price_locked_at: '2026-10-22T00:00:00Z' }],
  ])('a %s estimate prints its stored block too, never the live profile', async (_name, over) => {
    const stored = limits.buildLawnLimits({ otherGrasses: ['dallisgrass'] });
    const row = withSnapshot({ ...OPEN(), ...over }, stored);
    expect(await limits.lawnLimitsForEstimate(row, { knex: flagged({ other_grasses: ['carpetgrass'], virus_streaks_suspected: true }) })).toEqual(stored);
  });

  test('accepted before this shipped (no stored block): no block, and the profile is never read', async () => {
    const knex = flagged({ other_grasses: ['carpetgrass'] });
    for (const status of ['accepted', 'declined', 'expired']) {
      expect(await limits.lawnLimitsForEstimate({ ...OPEN(), status }, { knex })).toBeNull();
    }
    expect(await limits.lawnLimitsBlock({ ...OPEN(), status: 'accepted' }, { knex })).toEqual({});
    expect(knex.calls).toEqual([]);
  });

  test('the gate was off at accept (nothing was stored): the gate on later still shows no block', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    expect(await limits.lawnLimitsToStampAtAccept(OPEN(), { knex: world() })).not.toBeNull();
    delete process.env.GATE_ESTIMATE_LAWN_LIMITS;
    expect(await limits.lawnLimitsToStampAtAccept(OPEN(), { knex: world() })).toBeNull();
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    expect(await limits.lawnLimitsForEstimate({ ...OPEN(), status: 'accepted' }, { knex: world() })).toBeNull();
  });

  test('gate off: a stored block is not shown either (the kill switch wins)', async () => {
    delete process.env.GATE_ESTIMATE_LAWN_LIMITS;
    const row = withSnapshot({ ...OPEN(), status: 'accepted' }, limits.buildLawnLimits());
    expect(await limits.lawnLimitsForEstimate(row, { knex: world() })).toBeNull();
  });

  test('the stored block can arrive as a JSON string; a damaged one is no block', async () => {
    const stored = limits.buildLawnLimits({ virusStreaksSuspected: true });
    const asString = { ...OPEN(), status: 'accepted', estimate_data: JSON.stringify({ [limits.SNAPSHOT_KEY]: stored }) };
    expect(await limits.lawnLimitsForEstimate(asString, { knex: world() })).toEqual(stored);
    for (const bad of ['{nope', JSON.stringify({ [limits.SNAPSHOT_KEY]: { heading: 'x' } }), JSON.stringify({ [limits.SNAPSHOT_KEY]: { heading: '', paragraphs: [{ key: 'a', text: 't' }] } }), JSON.stringify({ [limits.SNAPSHOT_KEY]: { heading: 'x', paragraphs: [{ key: 1, text: 2 }] } })]) {
      expect(await limits.lawnLimitsForEstimate({ ...OPEN(), status: 'accepted', estimate_data: bad }, { knex: world() })).toBeNull();
    }
  });

  test('a stored block is returned as stored, not re-rendered from today\'s copy', async () => {
    const old = { heading: 'Older heading', paragraphs: [{ key: 'always', text: 'Older words.' }] };
    expect(await limits.lawnLimitsForEstimate(withSnapshot({ ...OPEN(), status: 'accepted' }, old), { knex: world() })).toEqual(old);
  });
});

describe('the accept writes the block', () => {
  test('stampLawnLimitsAtAccept sets the key on the estimate, once, with the block as JSON', async () => {
    const calls = [];
    const trx = (table) => {
      const q = {};
      q.where = (clause) => { calls.push({ table, clause }); return q; };
      q.update = (patch) => { calls[calls.length - 1].patch = patch; return Promise.resolve(1); };
      return q;
    };
    trx.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const block = limits.buildLawnLimits({ otherGrasses: ['carpetgrass'] });
    await limits.stampLawnLimitsAtAccept(trx, 'est-1', block);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ table: 'estimates', clause: { id: 'est-1' } });
    expect(trx.raw.mock.calls[0][0]).toContain("'{lawnLimitsAtAccept}'");
    expect(JSON.parse(trx.raw.mock.calls[0][1][0])).toEqual(block);
    await limits.stampLawnLimitsAtAccept(trx, 'est-1', null);
    expect(calls).toHaveLength(1);
  });

  test('lawnLimitsToStampForId reads the row and gives the live block; nothing with the gate off', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const knex = memKnex({ estimates: [{ ...lawnEstimate(), id: 'est-9' }], customer_properties: ONE_PROPERTY, customer_turf_profiles: [profile({ other_grasses: ['torpedograss'] })], customers: [] });
    expect(keysOf(await limits.lawnLimitsToStampForId('est-9', knex))).toEqual(['always', 'torpedograss']);
    delete process.env.GATE_ESTIMATE_LAWN_LIMITS;
    const off = memKnex({ estimates: [{ ...lawnEstimate(), id: 'est-9' }] });
    expect(await limits.lawnLimitsToStampForId('est-9', off)).toBeNull();
    expect(off.calls).toEqual([]);
  });
});

describe('the customer accept stamps the block inside its transaction (contract)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/estimate-public.js'), 'utf8');
  test('read before the transaction opens, written inside it after the guarded status flip', () => {
    const read = src.indexOf('lawnLimitsToStampAtAccept(estimate)');
    const open = src.indexOf('const txResult = await db.transaction(async (trx) => {', read);
    const write = src.indexOf('stampLawnLimitsAtAccept(trx, estimate.id, lawnLimitsAtAccept)');
    const flip = src.indexOf("accepted_service_mode: treatAsOneTime ? 'one_time' : serviceMode");
    expect(read).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(read);
    expect(write).toBeGreaterThan(open);
    expect(write).toBeGreaterThan(flip);
  });
});
