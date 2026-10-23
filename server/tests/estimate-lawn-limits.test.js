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

// A knex stand-in: knex('customer_turf_profiles').where(...).first(...) -> row.
const fakeKnex = (row, { fail = false } = {}) => {
  const calls = [];
  const knex = (table) => {
    calls.push(table);
    const q = {};
    q.where = jest.fn(() => q);
    q.first = jest.fn(async () => { if (fail) throw new Error('db down'); return row; });
    return q;
  };
  knex.calls = calls;
  return knex;
};

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

  test('gate off: null, and the turf profile is never read', async () => {
    const knex = fakeKnex({ other_grasses: ['carpetgrass'], virus_streaks_suspected: true });
    expect(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex })).toBeNull();
    expect(await limits.lawnLimitsBlock(lawnEstimate(), { knex })).toEqual({});
    expect(knex.calls).toEqual([]);
  });

  test('gate on, non-lawn estimate: null and no profile read', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const knex = fakeKnex({ other_grasses: ['carpetgrass'], virus_streaks_suspected: true });
    expect(await limits.lawnLimitsForEstimate(pestEstimate(), { knex })).toBeNull();
    expect(await limits.lawnLimitsBlock(pestEstimate(), { knex })).toEqual({});
    expect(knex.calls).toEqual([]);
  });

  test.each(['1', 'on', 'TRUE', ''])('the gate reads on only for exactly "true" (%p)', async (value) => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = value;
    expect(await limits.lawnLimitsForEstimate(lawnEstimate(), { knex: fakeKnex(null) })).toBeNull();
  });

  test('gate on, lawn estimate, flags set: the fixed paragraph plus one line per flag', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const knex = fakeKnex({ other_grasses: ['bahiagrass', 'torpedograss'], virus_streaks_suspected: true });
    const block = await limits.lawnLimitsForEstimate(lawnEstimate(), { knex });
    expect(block.heading).toBe("What we can and can't fix");
    expect(block.paragraphs.map((p) => p.key)).toEqual(['always', 'bahiagrass', 'torpedograss', 'virus_streaks']);
    expect(await limits.lawnLimitsBlock(lawnEstimate(), { knex })).toEqual({ lawnLimits: block });
  });

  test('gate on, lawn estimate, no profile or NULL flags: the fixed paragraph alone', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    for (const row of [undefined, { other_grasses: null, virus_streaks_suspected: null }]) {
      const block = await limits.lawnLimitsForEstimate(lawnEstimate(), { knex: fakeKnex(row) });
      expect(block.paragraphs.map((p) => p.key)).toEqual(['always']);
    }
  });

  test('an estimate with no customer reads no profile and still gets the fixed paragraph', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const knex = fakeKnex({ other_grasses: ['carpetgrass'] });
    const block = await limits.lawnLimitsForEstimate(lawnEstimate({ customer_id: null }), { knex });
    expect(block.paragraphs.map((p) => p.key)).toEqual(['always']);
    expect(knex.calls).toEqual([]);
  });

  test('a failed profile read still gives the fixed paragraph, never throws', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    const block = await limits.lawnLimitsForEstimate(lawnEstimate(), { knex: fakeKnex(null, { fail: true }) });
    expect(block.paragraphs.map((p) => p.key)).toEqual(['always']);
  });
});
