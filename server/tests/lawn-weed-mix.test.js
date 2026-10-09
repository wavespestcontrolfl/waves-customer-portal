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
const run = (items = addOns()) => buildWeedMix({ addOns: items, svc, structured: { products: [] }, knex: {} });
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

  test('lead at its cap: the replacement alone, with the why line; lead and members are not offered', async () => {
    capped(LEAD);
    const mix = await run();
    expect(mix).toMatchObject({
      mode: 'replacement', productIds: [REPL], surfactant: null, tempF: null,
      note: 'Alpha yearly limit reached; Delta is used in its place.',
    });
    expect(getCurrent).not.toHaveBeenCalled();
  });

  test('lead and replacement at the cap: nothing to add, one line', async () => {
    capped(LEAD, REPL);
    expect(await run()).toMatchObject({ mode: 'none', productIds: [], note: 'The yearly weed-spray limit is reached for this lawn.' });
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

  // Additive, for the treatment guide: the members whose limit WAS read as forbidding stay named, so a
  // sibling's failed read never releases them. The mix is 'unavailable' either way.
  test('an unavailable mix names the members read as forbidding (blockedIds); a thrown read names none', async () => {
    engine.v13VisitLimits.mockResolvedValue({ capped: new Map([[LEAD, [{ type: 'annual_max_apps', message: 'limit' }]], [CERT, [{ message: 'unread' }]]]), warnings: [], blocks: [] });
    expect(await run()).toMatchObject({ mode: 'unavailable', blockedIds: [LEAD] });
    engine.v13VisitLimits.mockRejectedValue(new Error('boom'));
    expect(await run()).toMatchObject({ mode: 'unavailable', blockedIds: [] });
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

// GATE_LAWN_TROUBLE_AREAS: the same decision at each place of the lawn. The plan's limit reader is asked once for the
// lawn, then again for each place only when something is capped lawn-wide (a place can only be more open than the lawn).
describe('buildWeedMix with places: one decision per place', () => {
  const PLACES = ['front', 'back', 'left_side', 'right_side'];
  const CAP = [{ type: 'annual_max_apps', message: 'limit' }];
  const runPlaces = (items = addOns()) => buildWeedMix({ addOns: items, svc, structured: { products: [] }, knex: {}, places: PLACES });
  // Capped lawn-wide, and at the places named.
  const cappedAt = (...places) => engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => ({
    capped: new Map(!options?.place || places.includes(options.place) ? [[LEAD, CAP]] : []), warnings: [], blocks: [],
  }));

  test('no places asked: the answer has no byPlace and the limit reader gets the five arguments it always did', async () => {
    const mix = await run();
    expect('byPlace' in mix).toBe(false);
    expect(engine.v13VisitLimits.mock.calls.every((call) => call.length === 5)).toBe(true);
  });

  test('nothing capped: every place takes the lawn-wide mix and the reader is asked once', async () => {
    const mix = await runPlaces();
    expect(Object.keys(mix.byPlace)).toEqual(PLACES);
    for (const place of PLACES) expect(mix.byPlace[place]).toMatchObject({ mode: 'lead', productIds: [LEAD, CERT, SURF] });
    expect(mix).toMatchObject({ mode: 'lead', productIds: [LEAD, CERT, SURF] });
    expect(engine.v13VisitLimits).toHaveBeenCalledTimes(1);
  });

  test('the lead capped at the front only: the front takes the replacement, the others the lead; the top level is the first place that can lead', async () => {
    cappedAt('front');
    const mix = await runPlaces();
    expect(mix.byPlace.front).toMatchObject({ mode: 'replacement', productIds: [REPL] });
    expect(mix.byPlace.back).toMatchObject({ mode: 'lead', productIds: [LEAD, CERT, SURF] });
    expect(mix).toMatchObject({ mode: 'lead', productIds: [LEAD, CERT, SURF] });
    // The lawn once, then each place once with the place as the sixth argument.
    expect(engine.v13VisitLimits.mock.calls.map((call) => call[5]?.place)).toEqual([undefined, 'front', 'back', 'left_side', 'right_side']);
  });

  test('a yearly AMOUNT limit at a place marks that place\'s decision amountBlocked (the sheet drops it when the dose changes); a count or an interval limit does not', async () => {
    const at = (type) => engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => ({
      capped: new Map(options?.place === 'front' || !options?.place ? [[LEAD, [{ type, matchType: type === 'annual_max_rate' ? 'v13_amount' : 'product', message: 'x' }]]] : []), warnings: [], blocks: [],
    }));
    at('annual_max_rate');
    const amount = await runPlaces();
    expect(amount.byPlace.front.amountBlocked).toBe(true);
    expect('amountBlocked' in amount.byPlace.back).toBe(false);
    at('annual_max_apps');
    expect('amountBlocked' in (await runPlaces()).byPlace.front).toBe(false);
    at('min_interval_days');
    expect('amountBlocked' in (await runPlaces()).byPlace.front).toBe(false);
  });

  test('capped at every place: every place is none and so is the top level', async () => {
    cappedAt(...PLACES);
    const mix = await runPlaces();
    for (const place of PLACES) expect(mix.byPlace[place]).toMatchObject({ mode: 'replacement' });
    engine.v13VisitLimits.mockImplementation(async () => ({ capped: new Map([[LEAD, CAP], [REPL, CAP]]), warnings: [], blocks: [] }));
    const none = await runPlaces();
    for (const place of PLACES) expect(none.byPlace[place]).toMatchObject({ mode: 'none', productIds: [] });
    expect(none).toMatchObject({ mode: 'none', productIds: [] });
  });

  test('the replacement leads when no place can take the lead', async () => {
    cappedAt(...PLACES);
    expect(await runPlaces()).toMatchObject({ mode: 'replacement', productIds: [REPL] });
  });

  test('a place whose limit read throws is unavailable for that place only (fail closed, never "open")', async () => {
    engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => {
      if (options?.place === 'back') throw new Error('db down');
      return { capped: new Map([[LEAD, CAP]]), warnings: [], blocks: [] };
    });
    const mix = await runPlaces();
    expect(mix.byPlace.back).toMatchObject({ mode: 'unavailable' });
    expect(mix.byPlace.front).toMatchObject({ mode: 'replacement' });
    expect(mix).toMatchObject({ mode: 'replacement' });
  });

  test('mixed reads: Front takes the replacement, Back\'s read fails: the group stays unreadable at the top level, each place keeps its own answer', async () => {
    const TYPELESS = [{ message: 'application limits could not be read.' }];
    engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => ({
      capped: new Map(options?.place === 'back' ? [[LEAD, TYPELESS]] : [[LEAD, CAP]]), warnings: [], blocks: [],
    }));
    const mix = await runPlaces();
    expect(mix.byPlace.front).toMatchObject({ mode: 'replacement', productIds: [REPL] });
    expect(mix.byPlace.back).toMatchObject({ mode: 'unavailable' });
    expect(mix).toMatchObject({ mode: 'replacement', productIds: [REPL] });
    expect(mix.unreadableIds.sort()).toEqual([LEAD, CERT, SURF, REPL].sort());
  });

  test('mixed reads: a member read as forbidding at the failed place stays blocked there (not unreadable); a read that throws is the same unknown', async () => {
    engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => {
      if (options?.place === 'back') throw new Error('db down');
      if (options?.place === 'left_side') return { capped: new Map([[LEAD, [{ message: 'unreadable' }]], [CERT, CAP]]), warnings: [], blocks: [] };
      return { capped: new Map([[LEAD, CAP], [REPL, CAP]]), warnings: [], blocks: [] };
    });
    const mix = await runPlaces();
    expect(mix.byPlace.back.mode).toBe('unavailable');
    expect(mix.byPlace.left_side).toMatchObject({ mode: 'unavailable', blockedIds: [CERT] });
    expect(mix.unreadableIds).toEqual(expect.arrayContaining([LEAD, CERT, SURF, REPL]));
    expect(mix.mode).toBe('none');
  });

  test('mixed reads at one place: the member read as capped stays blocked there, only the member whose read failed is unreadable', async () => {
    const TYPELESS = [{ message: 'application limits could not be read.' }];
    engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => ({
      capped: new Map(!options?.place || options.place === 'front' ? [[LEAD, CAP], [CERT, TYPELESS]] : []), warnings: [], blocks: [],
    }));
    const mix = await runPlaces();
    expect(mix.byPlace.front).toMatchObject({ mode: 'unavailable', blockedIds: [LEAD] });
    // Only Certainty (and the members no read forbade) is the unknown at the front; the lead is not.
    expect(mix.unreadableIds).toEqual(expect.arrayContaining([CERT, SURF, REPL]));
    expect(mix.unreadableIds).not.toContain(LEAD);
    // Another place is judged on its own.
    expect(mix.byPlace.back).toMatchObject({ mode: 'lead' });
  });

  test('every read succeeded: no unreadableIds key', async () => {
    cappedAt('front');
    expect(await runPlaces()).not.toHaveProperty('unreadableIds');
  });

  test('the lawn-wide read throwing is unavailable, with no places', async () => {
    engine.v13VisitLimits.mockRejectedValue(new Error('db down'));
    expect(await runPlaces()).toMatchObject({ mode: 'unavailable', productIds: [] });
  });

  test('the air temperature is read once for all the places', async () => {
    cappedAt('front');
    await runPlaces();
    expect(getCurrent).toHaveBeenCalledTimes(1);
  });
});
