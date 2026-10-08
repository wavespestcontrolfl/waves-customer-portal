// The lawn Fast Complete "Weed spots" entry (GATE_LAWN_SPOT_RULES): the group is read from the
// protocol rows' own gates, the cap comes from the plan's limit reader, and the surfactant follows
// the air temperature. Synthetic data; the plan engine, the weather reader and the coordinates
// reader are faked.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ v13VisitLimits: jest.fn(), v13ProtocolRows: jest.fn(() => new Map()) }));
jest.mock('../services/property-coordinates', () => ({ resolvePropertyCoordinates: jest.fn() }));
jest.mock('../services/fawn-weather', () => ({ getCurrent: jest.fn() }));

const engine = require('../services/waveguard-plan-engine');
const { resolvePropertyCoordinates } = require('../services/property-coordinates');
const { getCurrent } = require('../services/fawn-weather');
const { SURFACTANT_MAX_TEMP_F, weedMixGroup, buildWeedMix } = require('../services/lawn-weed-mix');

const LEAD = 'p-lead';
const CERT = 'p-member';
const SURF = 'p-surfactant';
const REPL = 'p-replacement';
const OTHER = 'p-other';

const item = (id, name, gates = null) => ({ product: { id, name }, gates });
const addOns = () => [
  item(LEAD, 'Alpha WG', { annualCounter: 'alpha_oz_per_1000' }),
  item(CERT, 'Bravo Turf Herbicide', { tankMixWith: 'Alpha WG' }),
  item(SURF, 'Charlie Nonionic Surfactant', { concentration: '0.25% v/v', tankMixWith: 'Alpha WG' }),
  item(REPL, 'Delta Herbicide', { trigger: 'celsius_annual_cap_reached', annualMaxApps: 2 }),
  item(OTHER, 'Echo Fungicide', { trigger: 'gray_leaf_spot' }),
];
const svc = { id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1', scheduled_date: '2026-10-05' };
const run = (items = addOns(), visit = svc) => buildWeedMix({ addOns: items, svc: visit, structured: { products: [] }, knex: {} });
const inMonth = (date) => ({ ...svc, scheduled_date: date });
const capped = (...ids) => engine.v13VisitLimits.mockResolvedValue({ capped: new Map(ids.map((id) => [id, [{ type: 'annual_max_apps', message: 'limit' }]])), warnings: [], blocks: [] });
const weather = (temp, extra = {}) => getCurrent.mockResolvedValue({ temp_f: temp, station: 'Test Station', timestamp: new Date().toISOString(), observation_time: new Date().toISOString(), ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  capped();
  resolvePropertyCoordinates.mockResolvedValue({ latitude: 27.4, longitude: -82.5 });
  weather(80);
});

describe('weedMixGroup reads the group from the rows\' gates, never from product names', () => {
  test('lead, members and replacement', () => {
    const group = weedMixGroup(addOns());
    expect(group.lead.product.id).toBe(LEAD);
    expect(group.members.map((m) => m.product.id)).toEqual([CERT, SURF]);
    expect(group.replacement.product.id).toBe(REPL);
  });
  test('no add-on names a lead: no group', () => {
    expect(weedMixGroup([item(OTHER, 'Echo Fungicide', { trigger: 'x' }), item(REPL, 'Delta', { trigger: 'celsius_annual_cap_reached' })])).toBeNull();
    expect(weedMixGroup(undefined)).toBeNull();
  });
  test('members whose lead is not an add-on this month are not grouped', () => {
    expect(weedMixGroup([item(CERT, 'Bravo', { tankMixWith: 'Alpha WG' })])).toBeNull();
  });
  test('the lead matches a substituted product by its original name', () => {
    const lead = { ...item(LEAD, 'Alpha Equivalent'), substitution: { originalProductName: 'Alpha WG' } };
    expect(weedMixGroup([lead, item(CERT, 'Bravo', { tankMixWith: 'alpha wg' })]).lead).toBe(lead);
  });
  test('a lead without a replacement row still groups', () => {
    expect(weedMixGroup(addOns().filter((i) => i.product.id !== REPL)).replacement).toBeNull();
  });
});

describe('buildWeedMix', () => {
  test('no group: null, and nothing is read', async () => {
    expect(await run([item(OTHER, 'Echo Fungicide')])).toBeNull();
    expect(engine.v13VisitLimits).not.toHaveBeenCalled();
  });

  test('lead under its cap: one tap adds the lead and its members; the replacement is not offered', async () => {
    const mix = await run();
    expect(mix).toMatchObject({
      mode: 'lead', productIds: [LEAD, CERT, SURF], groupProductIds: [LEAD, CERT, SURF, REPL], replacementProductId: REPL,
      noAreaProductIds: [SURF], tempF: 80, note: null, surfactant: { productId: SURF, included: true, note: null },
    });
    // The plan's own reader judges every product of the group, as a selected line.
    const asked = engine.v13VisitLimits.mock.calls[0][2];
    expect(asked.map((i) => [i.product.id, i.selected])).toEqual([[LEAD, true], [CERT, true], [SURF, true], [REPL, true]]);
  });

  test('lead at its cap in November through March: the replacement alone, with the why line; lead and members are not offered', async () => {
    capped(LEAD);
    const mix = await run(addOns(), inMonth('2026-11-05'));
    expect(mix).toMatchObject({
      mode: 'replacement', productIds: [REPL], surfactant: null, tempF: null,
      note: 'Alpha yearly limit reached; Delta is used in its place.',
    });
    expect(getCurrent).not.toHaveBeenCalled();
  });

  test.each(['2026-11-01', '2026-12-15', '2027-01-10', '2027-02-10', '2027-03-31'])('the replacement is offered on %s', async (date) => {
    capped(LEAD);
    expect(await run(addOns(), inMonth(date))).toMatchObject({ mode: 'replacement', productIds: [REPL] });
  });

  // owner 2026-10-08: restricted until the full Blindside label is read (heat injury on St. Augustine).
  test.each(['2026-04-01', '2026-06-15', '2026-09-30', '2026-10-05'])('lead at its cap on %s (April through October): the replacement is not offered', async (date) => {
    capped(LEAD);
    expect(await run(addOns(), inMonth(date))).toMatchObject({
      mode: 'none', productIds: [], replacementProductId: REPL, note: 'Alpha yearly limit reached. Delta is used November through March only.',
    });
  });

  test('a visit with no date cannot be told to be in season: the replacement is not offered', async () => {
    capped(LEAD);
    expect(await run(addOns(), { ...svc, scheduled_date: null })).toMatchObject({ mode: 'none', productIds: [] });
  });

  test('the season rule does not touch the lead: under its cap it is offered in any month', async () => {
    for (const date of ['2026-04-01', '2026-07-01', '2026-10-05']) expect(await run(addOns(), inMonth(date))).toMatchObject({ mode: 'lead', productIds: [LEAD, CERT, SURF] });
  });

  test('February: the lead alone, no member and no surfactant, no temperature read, and the note says why', async () => {
    const mix = await run(addOns(), inMonth('2027-02-10'));
    expect(mix).toMatchObject({
      mode: 'lead', productIds: [LEAD], surfactant: null, tempF: null, noAreaProductIds: [SURF],
      groupProductIds: [LEAD, CERT, SURF, REPL], note: 'February: Alpha only while the lawn greens up.',
    });
    expect(getCurrent).not.toHaveBeenCalled();
    expect(resolvePropertyCoordinates).not.toHaveBeenCalled();
  });

  test('February with the lead at its cap still hands the tap to the replacement (it is in season)', async () => {
    capped(LEAD);
    expect(await run(addOns(), inMonth('2027-02-10'))).toMatchObject({ mode: 'replacement', productIds: [REPL] });
  });

  test('lead and replacement at the cap: nothing to add, one line', async () => {
    capped(LEAD, REPL);
    expect(await run(addOns(), inMonth('2026-12-05'))).toMatchObject({ mode: 'none', productIds: [], note: 'The yearly weed-spray limit is reached for this lawn.' });
  });

  test('lead at the cap and no replacement row: the same line', async () => {
    capped(LEAD);
    expect(await run(addOns().filter((i) => i.product.id !== REPL))).toMatchObject({ mode: 'none', productIds: [], replacementProductId: null });
  });

  test('a member at its own cap stays off the tap', async () => {
    capped(CERT);
    const mix = await run();
    expect(mix.productIds).toEqual([LEAD, SURF]);
    expect(mix.note).toBe('Bravo yearly limit reached; left out.');
  });

  test('a limit read that fails offers nothing', async () => {
    engine.v13VisitLimits.mockRejectedValue(new Error('boom'));
    expect(await run()).toMatchObject({ mode: 'unavailable', productIds: [], groupProductIds: [LEAD, CERT, SURF, REPL] });
  });

  // The real reader fails closed per product: a failed read is a block with no limit type.
  test('a per-product limit read that failed is not a reached cap: nothing is offered, not the replacement', async () => {
    engine.v13VisitLimits.mockResolvedValue({ capped: new Map([[LEAD, [{ message: 'Alpha Weed: application limits could not be read.' }]]]), warnings: [], blocks: [] });
    expect(await run()).toMatchObject({ mode: 'unavailable', productIds: [], note: 'The weed-spray limits could not be checked. Use Other product for what you sprayed.' });
  });

  test('a failed read on the replacement alone also offers nothing', async () => {
    engine.v13VisitLimits.mockResolvedValue({ capped: new Map([[REPL, [{ message: 'unread' }]]]), warnings: [], blocks: [] });
    expect(await run()).toMatchObject({ mode: 'unavailable', productIds: [] });
  });

  test('a lead held by another limit (a minimum interval) is not handed to the replacement', async () => {
    engine.v13VisitLimits.mockResolvedValue({ capped: new Map([[LEAD, [{ type: 'min_interval_days', message: 'Alpha Weed: only 5 days from another application (min 14).' }]]]), warnings: [], blocks: [] });
    expect(await run()).toMatchObject({ mode: 'none', productIds: [], note: 'Alpha Weed: only 5 days from another application (min 14).' });
  });

  describe('surfactant by air temperature', () => {
    test('the limit is 90', () => expect(SURFACTANT_MAX_TEMP_F).toBe(90));
    test.each([[90], [96.4]])('at %s F or hotter it is left out, with its note', async (temp) => {
      weather(temp);
      const mix = await run();
      expect(mix.productIds).toEqual([LEAD, CERT]);
      expect(mix.surfactant).toEqual({ productId: SURF, included: false, note: 'Surfactant left out: it is 90°F or hotter.' });
      expect(mix.note).toBe('Surfactant left out: it is 90°F or hotter.');
      expect(mix.tempF).toBe(temp);
    });
    test('below 90 it is added with no note', async () => {
      weather(89.9);
      const mix = await run();
      expect(mix.productIds).toContain(SURF);
      expect(mix.surfactant).toEqual({ productId: SURF, included: true, note: null });
    });
    const unknown = { productIds: [LEAD, CERT, SURF], tempF: null, surfactant: { productId: SURF, included: true, note: 'Leave the surfactant out if it is 90°F or hotter.' } };
    test('an unknown temperature adds it with the reminder: no station answer', async () => {
      getCurrent.mockResolvedValue({ temp_f: null, station: 'unavailable', timestamp: new Date().toISOString() });
      expect(await run()).toMatchObject(unknown);
    });
    test('an unknown temperature: no coordinates', async () => {
      resolvePropertyCoordinates.mockResolvedValue(null);
      expect(await run()).toMatchObject(unknown);
      expect(getCurrent).not.toHaveBeenCalled();
    });
    test('an unknown temperature: the weather reader throws', async () => {
      getCurrent.mockRejectedValue(new Error('network'));
      expect(await run()).toMatchObject(unknown);
    });
    test('an unknown temperature: an old cached reading', async () => {
      weather(70, { observation_time: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });
      expect(await run()).toMatchObject(unknown);
    });
    test('an unknown temperature: a fresh fetch that carries an old observation', async () => {
      weather(70, { timestamp: new Date().toISOString(), observation_time: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });
      expect(await run()).toMatchObject(unknown);
    });
    test('an unknown temperature: no observation time on the reading', async () => {
      weather(70, { observation_time: undefined });
      expect(await run()).toMatchObject(unknown);
    });
    test('an unknown temperature: no answer within the bound', async () => {
      jest.useFakeTimers();
      try {
        getCurrent.mockReturnValue(new Promise(() => {}));
        const pending = run();
        await jest.advanceTimersByTimeAsync(2600);
        expect(await pending).toMatchObject(unknown);
      } finally {
        jest.useRealTimers();
      }
    });
    test('no surfactant in the group: the temperature is not read', async () => {
      const mix = await run(addOns().filter((i) => i.product.id !== SURF));
      expect(mix).toMatchObject({ mode: 'lead', productIds: [LEAD, CERT], surfactant: null, noAreaProductIds: [] });
      expect(getCurrent).not.toHaveBeenCalled();
    });
  });
});
