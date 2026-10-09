// The lawn Fast Complete treatment guide (GATE_LAWN_TREATMENT_GUIDE, owner 2026-10-08): the fixed
// rule table that turns a confirmed assessment into "Suggested from this lawn" cards, the staged-row
// product lookups and cap handling, and the completion record's validation. Synthetic data; the
// plan engine is faked.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ v13VisitLimits: jest.fn(), v13ProtocolRows: jest.fn() }));

const engine = require('../services/waveguard-plan-engine');
const {
  signalsFromAssessment, addOnOffers, weedOffer, resolveChinch, buildCards, treatmentGuideFreeze,
} = require('../services/lawn-treatment-guide');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P_ARENA = uuid(1);
const P_TALAK = uuid(2);
const P_ART = uuid(3);
const P_VEL = uuid(4);
const P_ACE = uuid(5);
const P_DISP = uuid(6);
const P_CEL = uuid(7);
const P_CERT = uuid(8);

const svc = { id: 'visit-1', customer_id: 'cust-1', property_id: 'prop-1', scheduled_date: '2026-10-05' };
const noLimits = () => engine.v13VisitLimits.mockResolvedValue({ capped: new Map(), warnings: [], blocks: [] });
const limited = (entries) => engine.v13VisitLimits.mockResolvedValue({ capped: new Map(entries), warnings: [], blocks: [] });

beforeEach(() => {
  jest.clearAllMocks();
  noLimits();
});
afterEach(() => { delete process.env.GATE_LAWN_TREATMENT_GUIDE; delete process.env.GATE_LAWN_SPOT_RULES; delete process.env.GATE_LAWN_V13; });

describe('signalsFromAssessment: where the finding levels come from', () => {
  test('a run-backed assessment reads the run\'s severities; weeds from the confirmed score', () => {
    const signals = signalsFromAssessment(
      { weed_suppression: 82, composite_scores: JSON.stringify({ drought_stress: 'minor' }) },
      { severities: { fungal_activity: { level: 'moderate' }, insect_damage: { level: 'minor' }, drought_stress: { level: 'severe' } }, scores_raw: { weed_coverage: 40 } },
    );
    expect(signals).toEqual({ weedCoverage: 18, fungus: 'moderate', insect: 'minor', drought: 'minor' });
  });

  test('weed coverage falls back to the composite, then the run\'s raw score; the confirmed column wins', () => {
    expect(signalsFromAssessment({ weed_suppression: 75 }, { scores_raw: { weed_coverage: 5 } }).weedCoverage).toBe(25);
    expect(signalsFromAssessment({ composite_scores: { weed_suppression: 70 } }).weedCoverage).toBe(30);
    expect(signalsFromAssessment({}, { scores_raw: JSON.stringify({ weed_coverage: 12 }) }).weedCoverage).toBe(12);
    expect(signalsFromAssessment({ weed_suppression: 0 }).weedCoverage).toBe(100);
    expect(signalsFromAssessment({}).weedCoverage).toBeNull();
  });

  test('a legacy assessment takes the WORST level across the per-photo reads, as the photo merge does', () => {
    const gemini = [
      { fungal_activity: 'none', insect_damage: 'minor' },
      { fungal_activity: 'moderate', insect_damage: 'none', drought_stress: 'minor' },
      { fungal_activity: 'minor', insect_damage: 'severe' },
    ];
    const signals = signalsFromAssessment({ gemini_raw: JSON.stringify(gemini), claude_raw: [null, null, null] });
    expect(signals).toMatchObject({ fungus: 'moderate', insect: 'severe', drought: 'minor' });
  });

  test('a level the model could not determine is no signal', () => {
    const signals = signalsFromAssessment({}, { severities: { fungal_activity: { level: 'unknown' }, insect_damage: { level: 'unknown' }, drought_stress: { level: 'unknown' } } });
    expect(signals).toEqual({ weedCoverage: null, fungus: null, insect: null, drought: null });
  });

  test('stored JSON that does not parse reads as nothing', () => {
    expect(signalsFromAssessment({ composite_scores: '{nope', gemini_raw: '[' }, { severities: 'x', scores_raw: 'y' }))
      .toEqual({ weedCoverage: null, fungus: null, insect: null, drought: null });
  });
});

describe('buildCards: the rule table', () => {
  const item = (productId, name, line = null) => ({ productId, name, line });
  const OFFERS = {
    fungus: { item: item(P_ART, 'Artavia 2 SC', 'Artavia 2 SC (Azoxy) — mapped large patch') },
    caterpillars: { item: item(P_ACE, 'Acelepryn', 'Acelepryn — caterpillars') },
    dry_spots: { item: item(P_DISP, 'Dispatch Sprayable', null) },
    chinch: { item: item(P_ARENA, 'Arena 50 WDG'), note: null },
  };
  const WEEDS = { productIds: [P_CEL, P_CERT], names: ['Celsius WG', 'Certainty'], items: [item(P_CEL, 'Celsius WG'), item(P_CERT, 'Certainty')], note: null };
  const run = (signals, { month = 7, offers = OFFERS, weeds = WEEDS } = {}) => buildCards({
    signals: { weedCoverage: 0, fungus: 'none', insect: 'none', drought: 'none', ...signals }, month, offers, weeds,
  });
  const kinds = (cards) => cards.map((card) => card.kind);

  test('a clean lawn has no cards', () => {
    expect(run({})).toEqual([]);
  });

  test.each([
    [9, false], [10, true], [11, true], [100, true],
  ])('weeds: %i%% coverage shows the card: %s', (weedCoverage, shown) => {
    const cards = run({ weedCoverage });
    expect(kinds(cards)).toEqual(shown ? ['weeds'] : []);
    if (shown) {
      expect(cards[0]).toMatchObject({
        title: 'Weed spots', finding: `Photos show weeds on about ${weedCoverage}% of the lawn.`, check: null,
        detail: 'Celsius WG, Certainty', productIds: [P_CEL, P_CERT], items: WEEDS.items, actionLabel: 'Add weed spots', dismissLabel: null,
      });
    }
  });

  test('weeds: no offerable weed mix, no card; coverage rounds to a whole percent', () => {
    expect(run({ weedCoverage: 30 }, { weeds: null })).toEqual([]);
    expect(run({ weedCoverage: 17.6 })[0].finding).toBe('Photos show weeds on about 18% of the lawn.');
  });

  test.each([['none', false], ['minor', true], ['moderate', true], ['severe', true]])('fungus: %s shows the card: %s', (fungus, shown) => {
    const cards = run({ fungus });
    expect(kinds(cards)).toEqual(shown ? ['fungus'] : []);
    if (shown) {
      expect(cards[0]).toMatchObject({
        finding: `Photos show ${fungus} fungus activity.`, check: 'Check first: look at the blades and the edge of the patch.',
        detail: 'Artavia 2 SC (Azoxy) — mapped large patch', productIds: [P_ART], actionLabel: 'I checked. Add it', dismissLabel: 'Nothing found',
      });
    }
  });

  describe('fungus in a take-all month: the check only, until a trouble area is on file', () => {
    const TAKE_ALL = { fungus: { item: item(P_ART, 'Artavia 2 SC', 'Artavia 2 SC (Azoxy) — mapped take-all areas, second spring application'), takeAll: true, blocked: false } };
    test('no trouble area on file (today always): the check and the line, no product and no button', () => {
      const [card] = run({ fungus: 'moderate' }, { offers: { ...OFFERS, ...TAKE_ALL } });
      expect(card).toMatchObject({
        kind: 'fungus', check: 'Check first: look at the blades and the edge of the patch.', note: 'Take-all is treated on known trouble areas only. None is on file for this lawn.',
        detail: null, productIds: [], items: [], actionLabel: null, dismissLabel: null,
        // The product is held, not offered: the sheet keeps it out of every other list.
        heldProductIds: [P_ART],
      });
    });
    test('the seam: with a trouble area on file the product shows as for any fungus card', () => {
      const [card] = buildCards({ signals: { weedCoverage: 0, fungus: 'moderate', insect: 'none', drought: 'none' }, month: 4, offers: { ...OFFERS, ...TAKE_ALL }, troubleAreas: [{ id: 'area-1' }] });
      expect(card).toMatchObject({ productIds: [P_ART], actionLabel: 'I checked. Add it', dismissLabel: 'Nothing found' });
    });
    test('a trouble area on file but the product at a limit: still the check only', () => {
      const offers = { ...OFFERS, fungus: { ...TAKE_ALL.fungus, blocked: true } };
      const [card] = buildCards({ signals: { weedCoverage: 0, fungus: 'moderate', insect: 'none', drought: 'none' }, month: 4, offers, troubleAreas: [{ id: 'area-1' }] });
      expect(card).toMatchObject({ productIds: [], actionLabel: null });
    });
    test('an offered fungus card holds nothing back', () => {
      expect(run({ fungus: 'minor' })[0].heldProductIds).toEqual([]);
    });
    test('no fungus finding, no card', () => {
      expect(run({ fungus: 'none' }, { offers: { ...OFFERS, ...TAKE_ALL } })).toEqual([]);
    });
  });

  test('fungus: no fungicide add-on this month, no card; with no protocol line the product name stands', () => {
    expect(run({ fungus: 'severe' }, { offers: { ...OFFERS, fungus: null } })).toEqual([]);
    expect(run({ fungus: 'minor' }, { offers: { ...OFFERS, fungus: { item: item(P_VEL, 'Velista') } } })[0].detail).toBe('Velista');
  });

  test.each([['none', false], ['minor', false], ['moderate', true], ['severe', true]])('insects: %s damage shows the cards: %s', (insect, shown) => {
    const cards = run({ insect });
    expect(kinds(cards)).toEqual(shown ? ['chinch', 'caterpillars'] : []);
    if (shown) {
      expect(cards[0]).toMatchObject({
        title: 'Insects: check for chinch bugs',
        check: 'Check first: part the grass at the sunny edge of the damaged patch. Do a float test only if you are unsure.',
        detail: 'Chinch bugs at the edge of the damage: Arena 50 WDG, spot treatment.', productIds: [P_ARENA], actionLabel: 'Found at the edge. Add it', dismissLabel: 'Nothing found',
      });
      expect(cards[1]).toMatchObject({
        title: 'Insects: check for caterpillars', check: 'Check first: soap flush to bring them to the surface.', productIds: [P_ACE], actionLabel: 'Found them. Add it',
      });
    }
  });

  test.each([[3, false], [4, true], [9, true], [10, false], [12, false], [1, false]])('chinch card in month %i: %s (caterpillars are not seasonal here)', (month, shown) => {
    const cards = run({ insect: 'moderate' }, { month });
    expect(kinds(cards).includes('chinch')).toBe(shown);
    expect(kinds(cards).includes('caterpillars')).toBe(true);
  });

  test('chinch: no product to offer (both at their limit), no card; the fallback note rides the card', () => {
    expect(kinds(run({ insect: 'severe' }, { offers: { ...OFFERS, chinch: { item: null, note: 'limit' } } }))).toEqual(['caterpillars']);
    expect(kinds(run({ insect: 'severe' }, { offers: { ...OFFERS, chinch: null } }))).toEqual(['caterpillars']);
    const fallback = { item: item(P_TALAK, 'Atticus Talak 7.9 F'), note: 'Arena yearly limit reached; Atticus is used in its place.' };
    const cards = run({ insect: 'severe' }, { offers: { ...OFFERS, chinch: fallback } });
    expect(cards[0]).toMatchObject({ kind: 'chinch', productIds: [P_TALAK], note: fallback.note, detail: 'Chinch bugs at the edge of the damage: Atticus Talak 7.9 F, spot treatment.' });
  });

  test('caterpillars: no Acelepryn add-on this month, no card', () => {
    expect(kinds(run({ insect: 'severe' }, { offers: { ...OFFERS, caterpillars: null } }))).toEqual(['chinch']);
  });

  test.each([['none', false], ['minor', true], ['moderate', true], ['severe', true]])('dry spots: %s drought stress shows the card: %s', (drought, shown) => {
    const cards = run({ drought });
    expect(kinds(cards)).toEqual(shown ? ['dry_spots'] : []);
    if (shown) {
      expect(cards[0]).toMatchObject({ title: 'Dry spots', finding: `Photos show ${drought} drought stress.`, check: null, productIds: [P_DISP], actionLabel: 'Add Dispatch Sprayable' });
    }
  });

  test('dry spots: no wetting agent in the month, no card (there is no overwatering card at all)', () => {
    expect(run({ drought: 'severe' }, { offers: { ...OFFERS, dry_spots: null } })).toEqual([]);
    expect(kinds(buildCards({ signals: { weedCoverage: 0, fungus: 'none', insect: 'none', drought: 'none', overwatering: true }, month: 5, offers: OFFERS, weeds: null }))).toEqual([]);
  });

  test('every finding at once: the cards come in screen order', () => {
    expect(kinds(run({ weedCoverage: 40, fungus: 'severe', insect: 'severe', drought: 'severe' }, { month: 7 })))
      .toEqual(['weeds', 'fungus', 'chinch', 'caterpillars', 'dry_spots']);
  });

  test('unknown signals show nothing', () => {
    expect(buildCards({ signals: { weedCoverage: null, fungus: null, insect: null, drought: null }, month: 7, offers: OFFERS, weeds: WEEDS })).toEqual([]);
    expect(buildCards({ signals: null, month: 7, offers: OFFERS, weeds: WEEDS })).toEqual([]);
  });
});

describe('weedOffer: only what the Weed spots entry can add', () => {
  const items = [{ productId: P_CEL, name: 'Celsius WG' }, { productId: P_CERT, name: 'Certainty' }, { productId: P_TALAK, name: 'Other' }];
  test('lead mode offers the entry\'s products with their names', () => {
    expect(weedOffer({ mode: 'lead', productIds: [P_CEL, P_CERT], note: 'n' }, items)).toEqual({ productIds: [P_CEL, P_CERT], names: ['Celsius WG', 'Certainty'], items: items.slice(0, 2), note: 'n' });
  });
  test('replacement mode offers the replacement alone', () => {
    expect(weedOffer({ mode: 'replacement', productIds: [P_CERT] }, items)).toMatchObject({ productIds: [P_CERT], names: ['Certainty'], note: null });
  });
  test.each([['none'], ['unavailable']])('mode %s offers nothing', (mode) => {
    expect(weedOffer({ mode, productIds: [P_CEL] }, items)).toBeNull();
  });
  test('a lone weed herbicide add-on with no group is not a weed offer (no mix: no card)', () => {
    expect(weedOffer(null, [{ productId: P_CEL, name: 'Celsius WG' }])).toBeNull();
  });
  test('no mix, nothing to add, or a product the add-ons do not hold: nothing', () => {
    expect(weedOffer(null, items)).toBeNull();
    expect(weedOffer({ mode: 'lead', productIds: [] }, items)).toBeNull();
    expect(weedOffer({ mode: 'lead', productIds: [P_CEL, uuid(99)] }, items)).toBeNull();
  });
});

// A chainable stand-in for the knex query the staged-row lookup runs; it answers `rows`.
function fakeKnex(rows) {
  const knex = jest.fn(() => {
    const chain = {};
    for (const method of ['where', 'whereNotNull', 'whereRaw', 'join', 'leftJoin', 'select', 'orderBy']) chain[method] = jest.fn(() => chain);
    chain.then = (resolve, reject) => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows)).then(resolve, reject);
    return chain;
  });
  return knex;
}

describe('addOnOffers: the month\'s add-ons by what their staged rows say', () => {
  const candidate = (id, name, extra = {}) => ({ raw: { product: { id, name }, ...extra }, item: { productId: id, name } });
  const ROWS = new Map([
    [P_ART, { role: 'fungicide_spot', gates: { trigger: 'mapped_large_patch' } }],
    [P_VEL, { role: 'fungicide_spot', gates: { trigger: 'large_patch_next_application_after_artavia' } }],
    [P_ACE, { role: 'insecticide_spot', gates: { trigger: 'caterpillars' } }],
    [P_DISP, { role: 'wetting_agent_spot', gates: { trigger: 'dry_spots' } }],
    [P_CEL, { role: 'post_emergent_spot', gates: {} }],
  ]);
  const ALL = () => [candidate(P_CEL, 'Weed'), candidate(P_VEL, 'Velista'), candidate(P_ART, 'Artavia'), candidate(P_ACE, 'Acelepryn'), candidate(P_DISP, 'Dispatch')];
  const run = (candidates = ALL(), rows = ROWS) => addOnOffers({ candidates, rows, svc, knex: {} });

  test('the first fungicide in the program\'s own order, by role; the others by trigger', async () => {
    const offers = await run();
    expect(offers.fungus).toEqual({ item: { productId: P_ART, name: 'Artavia' } });
    expect(offers.fungus.item.productId).toBe(P_ART);
    expect(offers.caterpillars.item.productId).toBe(P_ACE);
    expect(offers.dry_spots.item.productId).toBe(P_DISP);
  });

  test('the plan\'s own judge is asked about the products it may suggest, as selected lines', async () => {
    await run();
    const asked = engine.v13VisitLimits.mock.calls[0][2];
    expect(asked.map((entry) => [entry.product.id, entry.selected])).toEqual([[P_ART, true], [P_ACE, true], [P_DISP, true]]);
  });

  test('a month without the add-ons offers nothing, and nothing is read', async () => {
    const offers = await run([candidate(P_CEL, 'Weed')]);
    expect(offers).toEqual({ fungus: null, caterpillars: null, dry_spots: null, blocked: [], unreadable: [] });
    expect(engine.v13VisitLimits).not.toHaveBeenCalled();
  });

  test('a product at a limit, or one the city holds, is never suggested; the next fungicide is not substituted', async () => {
    limited([[P_ART, [{ type: 'annual_max_apps', message: 'limit' }]], [P_DISP, [{ message: 'read failed' }]]]);
    const offers = await run();
    expect(offers).toEqual({ fungus: null, caterpillars: { item: { productId: P_ACE, name: 'Acelepryn' } }, dry_spots: null, blocked: [P_ART], unreadable: [P_DISP] });
    noLimits();
    const held = [candidate(P_ART, 'Artavia', { unavailable: { kind: 'city_hold' } }), candidate(P_VEL, 'Velista')];
    const heldOffers = await run(held);
    expect(heldOffers.fungus).toBeNull();
    expect(heldOffers.blocked).toEqual([P_ART]);
  });

  test('a limit read that fails offers nothing', async () => {
    engine.v13VisitLimits.mockRejectedValue(new Error('db down'));
    // The read failed: every pick is unreadable (not forbidden, not merely without a finding).
    expect(await run()).toEqual({ fungus: null, caterpillars: null, dry_spots: null, blocked: [], unreadable: [P_ART, P_ACE, P_DISP] });
  });

  test('take-all is told by the staged trigger, or by the protocol line; large patch and gray leaf spot are not', async () => {
    const take = (trigger, line = null) => {
      const c = candidate(P_ART, 'Artavia');
      c.item.line = line;
      return addOnOffers({ candidates: [c], rows: new Map([[P_ART, { role: 'fungicide_spot', gates: { trigger } }]]), svc, knex: {} });
    };
    expect((await take('mapped_take_all_spring_2')).fungus).toMatchObject({ takeAll: true, blocked: false });
    expect((await take('mapped_take_all_fall_1')).fungus.takeAll).toBe(true);
    expect((await take('x', 'Artavia 2 SC (Azoxy) — mapped take-all areas, first fall application')).fungus.takeAll).toBe(true);
    expect((await take('active_large_patch', 'Artavia — active large patch, mapped areas')).fungus).toEqual({ item: expect.anything() });
    expect((await take('gray_leaf_spot')).fungus).toEqual({ item: expect.anything() });
    // October's large patch row also mentions take-all in its trigger name, but does not start with it.
    expect((await take('mapped_large_patch_with_velista_and_take_all_fall_2')).fungus).toEqual({ item: expect.anything() });
  });

  test('a take-all fungicide at a limit stays as the check-only offer (it names no product)', async () => {
    limited([[P_ART, [{ type: 'annual_max_apps', message: 'limit' }]]]);
    const c = candidate(P_ART, 'Artavia');
    const offers = await addOnOffers({ candidates: [c], rows: new Map([[P_ART, { role: 'fungicide_spot', gates: { trigger: 'mapped_take_all_spring_1' } }]]), svc, knex: {} });
    expect(offers.fungus).toMatchObject({ takeAll: true, blocked: true });
  });

  test('a visit\'s substitute stands on its original\'s row', async () => {
    const substitute = candidate(uuid(40), 'Fungicide Equivalent', { substitution: { originalProductId: P_ART } });
    expect((await run([substitute])).fungus.item.productId).toBe(uuid(40));
  });
});

describe('take-all fungicide rows are governed in every month they are staged (the v13 migrations\' own rows)', () => {
  const { takeAllAddOns } = require('../services/lawn-treatment-guide');
  const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
  const matrix = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');
  const round2 = require('../models/migrations/20261007182000_lawn_v13_matrix_adds_round2');
  const round11 = require('../models/migrations/20261007188000_lawn_v13_matrix_adds_round11');
  const MONTH_OF = new Map(staged.WINDOWS.map(([month, key]) => [key, month]));

  // The staged rows of one window after the migrations that touch fungicide rows: the first migration's
  // products, the matrix adds (inserts, then the guarded updates), the round 2 trigger rewrites, round 11.
  function windowRows(windowKey) {
    const rows = staged.PRODUCTS.filter(([key]) => key === windowKey).map(([, [name, role, , , , , , gates]]) => ({ name, role, trigger: gates?.trigger || null }));
    for (const row of matrix.INSERTS.filter((insert) => insert.windowKey === windowKey)) rows.push({ name: row.name, role: row.role, trigger: row.gates?.trigger || null });
    for (const update of matrix.UPDATES.filter((u) => u.windowKey === windowKey)) {
      const hit = rows.find((row) => row.name === update.guard.product_name && row.trigger === update.guard.trigger);
      if (hit) { if (update.columns.product_name) hit.name = update.columns.product_name; if (update.gates.trigger) hit.trigger = update.gates.trigger; }
    }
    for (const [, name, from, to] of round2.TRIGGERS.filter(([window]) => window === windowKey)) {
      const hit = rows.find((row) => row.name === name && row.trigger === from);
      if (hit) hit.trigger = to;
    }
    for (const row of rows) if (windowKey === matrix.WINDOWS.SEP && row.name === staged.NAMES.ART && row.trigger === round11.OLD_TRIGGER) row.trigger = round11.NEW_TRIGGER;
    return rows;
  }
  const idFor = (windowKey, name) => uuid(500 + MONTH_OF.get(windowKey) * 20 + [...new Set(windowRows(windowKey).map((row) => row.name))].indexOf(name));

  const EXPECTED = new Map([
    [3, ['Artavia 2 SC (Azoxy)']], [4, ['Headway Fungicide']], [9, ['Artavia 2 SC (Azoxy)']], [10, ['Headway Fungicide']],
  ]);

  test.each(staged.TRACKS.map((track) => [track.track, track]))('%s: every take-all row of every month is found, and no other row is', (_name) => {
    for (const [windowKey, month] of MONTH_OF) {
      const rowsOf = windowRows(windowKey);
      const rows = new Map(rowsOf.map((row) => [idFor(windowKey, row.name), { role: row.role, gates: { trigger: row.trigger } }]));
      const candidates = rowsOf.map((row) => ({ raw: { product: { id: idFor(windowKey, row.name), name: row.name } }, item: { productId: idFor(windowKey, row.name), name: row.name, line: null } }));
      const names = takeAllAddOns(candidates, rows).map((candidate) => candidate.item.name);
      expect(names).toEqual(EXPECTED.get(month) || []);
    }
  });

  test('the October Headway row follows the large patch row, so the first-fungicide pick passes it over: it is still read, and a forbidden one is blocked', async () => {
    const rowsOf = windowRows(matrix.WINDOWS.OCT);
    const rows = new Map(rowsOf.map((row) => [idFor(matrix.WINDOWS.OCT, row.name), { role: row.role, gates: { trigger: row.trigger } }]));
    const candidates = rowsOf.map((row) => ({ raw: { product: { id: idFor(matrix.WINDOWS.OCT, row.name), name: row.name } }, item: { productId: idFor(matrix.WINDOWS.OCT, row.name), name: row.name, line: null } }));
    const head = idFor(matrix.WINDOWS.OCT, 'Headway Fungicide');
    const art = idFor(matrix.WINDOWS.OCT, staged.NAMES.ART);
    limited([[head, [{ type: 'min_interval_days', message: 'too soon' }]]]);
    const offers = await addOnOffers({ candidates, rows, svc, knex: {} });
    expect(offers.fungus.item.productId).toBe(art);
    expect(offers.blocked).toEqual([head]);
    // The limit read is asked about the pick and the take-all row, nothing else.
    expect(engine.v13VisitLimits.mock.calls[0][2].map((entry) => entry.product.id).sort()).toEqual([art, head].sort());
    // A read that failed releases it to the search with the note, as for any governed product.
    engine.v13VisitLimits.mockRejectedValue(new Error('db down'));
    expect((await addOnOffers({ candidates, rows, svc, knex: {} })).unreadable.sort()).toEqual([art, head].sort());
  });

  test('a take-all row that is also the pick is read once', async () => {
    const rowsOf = windowRows(matrix.WINDOWS.APR);
    const rows = new Map(rowsOf.map((row) => [idFor(matrix.WINDOWS.APR, row.name), { role: row.role, gates: { trigger: row.trigger } }]));
    const candidates = rowsOf.map((row) => ({ raw: { product: { id: idFor(matrix.WINDOWS.APR, row.name), name: row.name } }, item: { productId: idFor(matrix.WINDOWS.APR, row.name), name: row.name, line: null } }));
    await addOnOffers({ candidates, rows, svc, knex: {} });
    const asked = engine.v13VisitLimits.mock.calls[0][2].map((entry) => entry.product.id);
    expect(asked).toEqual([...new Set(asked)]);
  });
});

describe('blockedProductIds: what the fresh read kept out, per governed kind', () => {
  const { blockedProductIds } = require('../services/lawn-treatment-guide');
  test('a clean read blocks nothing, and a pick with no finding is not blocked', () => {
    expect(blockedProductIds({ offers: { blocked: [] }, chinch: { blockedIds: [] }, weedMix: { mode: 'lead', groupProductIds: [P_CEL, P_CERT], productIds: [P_CEL, P_CERT] } })).toEqual([]);
    expect(blockedProductIds({})).toEqual([]);
  });
  test('the picks, the chinch rungs and the weed group are all named, each once', () => {
    const ids = blockedProductIds({
      offers: { blocked: [P_ART, P_ACE] },
      chinch: { blockedIds: [P_ARENA, P_TALAK] },
      weedMix: { mode: 'none', groupProductIds: [P_CEL, P_CERT], productIds: [] },
    });
    expect(ids.sort()).toEqual([P_ART, P_ACE, P_ARENA, P_TALAK, P_CEL, P_CERT].sort());
    expect(blockedProductIds({ offers: { blocked: [P_ART] }, chinch: { blockedIds: [P_ART] } })).toEqual([P_ART]);
  });
  test('the weed group: the replacement tap blocks the lead side, an unreadable limit blocks none, lead mode blocks none', () => {
    const group = [P_CEL, P_CERT, uuid(9)];
    expect(blockedProductIds({ weedMix: { mode: 'replacement', groupProductIds: group, productIds: [uuid(9)] } }).sort()).toEqual([P_CEL, P_CERT].sort());
    expect(blockedProductIds({ weedMix: { mode: 'unavailable', groupProductIds: group, productIds: [] } })).toEqual([]);
    expect(blockedProductIds({ weedMix: { mode: 'none', groupProductIds: group, productIds: [] } })).toHaveLength(3);
    expect(blockedProductIds({ weedMix: { mode: 'lead', groupProductIds: group, productIds: [P_CEL] } })).toEqual([]);
  });
});

describe('unreadableProductIds: what the fresh read could not read (not forbidden)', () => {
  const { unreadableProductIds, blockedProductIds, UNREADABLE_NOTE } = require('../services/lawn-treatment-guide');
  test('a clean read has none', () => {
    expect(unreadableProductIds({})).toEqual([]);
    expect(unreadableProductIds({ offers: { unreadable: [] }, chinch: { unreadableIds: [] }, weedMix: { mode: 'lead', groupProductIds: [P_CEL] } })).toEqual([]);
  });
  test('the picks, the chinch rungs and an unavailable weed group are named once, and never also blocked', () => {
    const input = {
      offers: { blocked: [], unreadable: [P_ART, P_ACE] },
      chinch: { blockedIds: [], unreadableIds: [P_ARENA, P_TALAK] },
      weedMix: { mode: 'unavailable', groupProductIds: [P_CEL, P_CERT], productIds: [] },
    };
    expect(unreadableProductIds(input).sort()).toEqual([P_ART, P_ACE, P_ARENA, P_TALAK, P_CEL, P_CERT].sort());
    expect(blockedProductIds(input)).toEqual([]);
  });
  test('an unavailable weed mix: members read as forbidden stay blocked; the rest are released (the mix is withheld as a whole)', () => {
    const weedMix = { mode: 'unavailable', groupProductIds: [P_CEL, P_CERT, uuid(9)], productIds: [], blockedIds: [P_CEL] };
    expect(blockedProductIds({ weedMix })).toEqual([P_CEL]);
    expect(unreadableProductIds({ weedMix }).sort()).toEqual([P_CERT, uuid(9)].sort());
    // A whole-read failure names no blocked member: all are released.
    const threw = { mode: 'unavailable', groupProductIds: [P_CEL, P_CERT], productIds: [], blockedIds: [] };
    expect(blockedProductIds({ weedMix: threw })).toEqual([]);
    expect(unreadableProductIds({ weedMix: threw }).sort()).toEqual([P_CEL, P_CERT].sort());
  });
  test('a weed mix that is not unavailable adds none', () => {
    for (const mode of ['lead', 'replacement', 'none']) expect(unreadableProductIds({ weedMix: { mode, groupProductIds: [P_CEL], productIds: [] } })).toEqual([]);
  });
  test('one wording', () => {
    expect(UNREADABLE_NOTE).toBe('The limits could not be checked. Use Search products for what you applied; the office will review it.');
  });
});

// GATE_LAWN_TROUBLE_AREAS: the other guided picks and the weeds and chinch cards, judged per place.
describe('per-place offers: a product is held back only when NO place permits it', () => {
  const PLACES = ['front', 'back', 'left_side', 'right_side'];
  const CAP = [{ type: 'annual_max_apps', message: 'Artavia: 2/2 — LIMIT REACHED.' }];
  const candidate = (id, name, extra = {}) => ({ raw: { product: { id, name }, ...extra }, item: { productId: id, name } });
  const ROWS = new Map([[P_ART, { role: 'fungicide_spot', gates: { trigger: 'mapped_large_patch' } }], [P_ACE, { role: 'insecticide_spot', gates: { trigger: 'caterpillars' } }]]);
  const both = () => [candidate(P_ART, 'Artavia'), candidate(P_ACE, 'Acelepryn')];
  const run = (candidates = both()) => addOnOffers({ candidates, rows: ROWS, svc, knex: {}, places: PLACES });
  // Capped lawn-wide, and at the places named only.
  const cappedAt = (id, ...places) => engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => ({
    capped: new Map(!options?.place || places.includes(options.place) ? [[id, CAP]] : []), warnings: [], blocks: [],
  }));

  test('capped lawn-wide and at the front, open at the back: still offered, not blocked, not unreadable', async () => {
    cappedAt(P_ART, 'front');
    const offers = await run();
    expect(offers.fungus).toEqual({ item: { productId: P_ART, name: 'Artavia' } });
    expect(offers.blocked).toEqual([]);
    expect(offers.unreadable).toEqual([]);
    // Only the capped pick is read again, once per place, with the place as the sixth argument.
    const calls = engine.v13VisitLimits.mock.calls;
    expect(calls).toHaveLength(5);
    expect(calls.slice(1).map((c) => [c[2].map((l) => l.product.id), c[5]])).toEqual(PLACES.map((place) => [[P_ART], { place }]));
  });

  test('capped at every place: blocked, with no offer', async () => {
    cappedAt(P_ART, ...PLACES);
    const offers = await run();
    expect(offers.fungus).toBeNull();
    expect(offers.blocked).toEqual([P_ART]);
    expect(offers.caterpillars).toEqual({ item: { productId: P_ACE, name: 'Acelepryn' } });
  });

  test('a place whose read throws permits nothing (fail closed) and is unknown there: the pick is not offered and is unreadable, not blocked', async () => {
    engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => {
      if (options?.place) throw new Error('db down');
      return { capped: new Map([[P_ART, CAP]]), warnings: [], blocks: [] };
    });
    const offers = await run();
    expect(offers.fungus).toBeNull();
    expect(offers.blocked).toEqual([]);
    expect(offers.unreadable).toEqual([P_ART]);
  });

  test('the per-place blocks this read found ride the offers, in the context\'s shape, for every product read (empty = open everywhere)', async () => {
    cappedAt(P_ART, 'front', 'left_side');
    const offers = await run();
    expect(offers.placeBlocked).toEqual({
      [P_ART]: { front: 'Artavia: 2/2 — LIMIT REACHED.', left_side: 'Artavia: 2/2 — LIMIT REACHED.' },
      [P_ACE]: {},
    });
  });

  test('a newly open product is an empty entry; a newly capped place is named; an unreadable place is not a block; nothing capped reads once', async () => {
    cappedAt(P_ART);
    expect((await run()).placeBlocked).toEqual({ [P_ART]: {}, [P_ACE]: {} });
    engine.v13VisitLimits.mockReset();
    noLimits();
    expect((await run()).placeBlocked).toEqual({ [P_ART]: {}, [P_ACE]: {} });
    expect(engine.v13VisitLimits).toHaveBeenCalledTimes(1);
    engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => {
      if (options?.place === 'back') throw new Error('db down');
      return { capped: new Map([[P_ART, CAP]]), warnings: [], blocks: [] };
    });
    expect((await run()).placeBlocked[P_ART]).toEqual({ front: 'Artavia: 2/2 — LIMIT REACHED.', left_side: 'Artavia: 2/2 — LIMIT REACHED.', right_side: 'Artavia: 2/2 — LIMIT REACHED.' });
  });

  test('no places asked: the offers carry no placeBlocked key (byte-identical)', async () => {
    cappedAt(P_ART, 'front');
    const offers = await addOnOffers({ candidates: both(), rows: ROWS, svc, knex: {} });
    expect(offers).not.toHaveProperty('placeBlocked');
  });

  test('nothing capped: one read, as before; a city hold is blocked at every place', async () => {
    const offers = await run();
    expect(engine.v13VisitLimits).toHaveBeenCalledTimes(1);
    expect(offers.blocked).toEqual([]);
    const held = await run([candidate(P_ART, 'Artavia', { unavailable: { kind: 'city_hold' } })]);
    expect(held.fungus).toBeNull();
    expect(held.blocked).toEqual([P_ART]);
  });

  test('no places asked: the lawn-wide answer, five arguments', async () => {
    cappedAt(P_ART, 'front');
    const offers = await addOnOffers({ candidates: both(), rows: ROWS, svc, knex: {} });
    expect(offers.fungus).toBeNull();
    expect(offers.blocked).toEqual([P_ART]);
    expect(engine.v13VisitLimits.mock.calls.every((c) => c.length === 5)).toBe(true);
  });

  // Mixed reads: a place whose limit read FAILS is unknown, not closed. A product unreadable at ANY place stays unreadable at the
  // top level (released to the search with the note, never dropped by reconciliation); each place keeps its own answer.
  describe('mixed successful and failed reads per place', () => {
    const TYPED = [{ type: 'annual_max_apps', message: 'limit' }];
    const TYPELESS = [{ message: 'application limits could not be read.' }];
    const readsBy = (perPlace, wide) => engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => {
      const answer = options?.place ? perPlace[options.place] : wide;
      if (answer instanceof Error) throw answer;
      return { capped: new Map(items.map((i) => i.product.id).filter((id) => answer[id]).map((id) => [id, answer[id]])), warnings: [], blocks: [] };
    });

    test('chinch: Front takes the bifenthrin product, Back\'s Arena read fails, the others cap Arena: Arena stays unreadable at the top level', async () => {
      readsBy({ front: { [P_ARENA]: TYPED }, back: { [P_ARENA]: TYPELESS }, left_side: { [P_ARENA]: TYPED }, right_side: { [P_ARENA]: TYPED } }, { [P_ARENA]: TYPED });
      engine.v13ProtocolRows.mockReturnValue(new Map([[P_ART, {}]]));
      const found = await resolveChinch({ svc, structured: { id: 'protocol-1', version: 'v13' }, knex: fakeKnex([
        { product_id: P_ARENA, product_name: 'Arena 50 WDG', gates: { trigger: 'chinch_20_to_25_per_sqft' }, rate_per_1000: null, rate_unit: 'label_rate', sort_order: 4, month: 4, catalog_id: P_ARENA, catalog_name: 'Arena 50 WDG', catalog_active: true },
        { product_id: P_TALAK, product_name: 'Atticus Talak 7.9 F', gates: { trigger: 'chinch_second_product_caterpillars_or_mole_cricket_nymphs' }, rate_per_1000: null, rate_unit: 'label_rate', sort_order: 4, month: 7, catalog_id: P_TALAK, catalog_name: 'Atticus Talak 7.9 F', catalog_active: true },
      ]), places: PLACES });
      expect(found).toMatchObject({ productId: P_TALAK });
      expect(found.unreadableIds).toContain(P_ARENA);
      expect(found.blockedIds).not.toContain(P_ARENA);
      // Each place keeps its own answer: Front is capped (blocked), Back is unknown (unreadable, nothing offered there).
      expect(found.byPlace.front).toMatchObject({ productId: P_TALAK, blockedIds: [P_ARENA] });
      expect(found.byPlace.back).toMatchObject({ productId: null, unreadableIds: expect.arrayContaining([P_ARENA]) });
      expect(found.byPlace.left_side.unreadableIds).toEqual([]);
    });

    test('weed mix lives in lawn-weed-mix.test.js; the add-on pick: capped at three places, unreadable at the fourth, is unreadable (not blocked) and not offered', async () => {
      const ROWS2 = new Map([[P_ART, { role: 'fungicide_spot', gates: { trigger: 'mapped_large_patch' } }]]);
      const c = [{ raw: { product: { id: P_ART, name: 'Artavia' } }, item: { productId: P_ART, name: 'Artavia' } }];
      const run2 = () => addOnOffers({ candidates: c, rows: ROWS2, svc, knex: {}, places: PLACES });
      readsBy({ front: { [P_ART]: TYPED }, back: { [P_ART]: TYPELESS }, left_side: { [P_ART]: TYPED }, right_side: { [P_ART]: TYPED } }, { [P_ART]: TYPED });
      let offers = await run2();
      expect(offers.fungus).toBeNull();
      expect(offers.unreadable).toEqual([P_ART]);
      expect(offers.blocked).toEqual([]);
      // The whole read at one place throwing is the same unknown; a pick open at another place is simply offered.
      readsBy({ front: { [P_ART]: TYPED }, back: new Error('db down'), left_side: { [P_ART]: TYPED }, right_side: { [P_ART]: TYPED } }, { [P_ART]: TYPED });
      offers = await run2();
      expect(offers.unreadable).toEqual([P_ART]);
      expect(offers.blocked).toEqual([]);
      readsBy({ front: { [P_ART]: TYPED }, back: new Error('db down'), left_side: {}, right_side: { [P_ART]: TYPED } }, { [P_ART]: TYPED });
      offers = await run2();
      expect(offers.fungus).toEqual({ item: { productId: P_ART, name: 'Artavia' } });
      expect(offers.unreadable).toEqual([]);
      // Capped at every place that was read, none unknown: still blocked.
      readsBy({ front: { [P_ART]: TYPED }, back: { [P_ART]: TYPED }, left_side: { [P_ART]: TYPED }, right_side: { [P_ART]: TYPED } }, { [P_ART]: TYPED });
      offers = await run2();
      expect(offers.blocked).toEqual([P_ART]);
      expect(offers.unreadable).toEqual([]);
    });

    test('chinch per place: Arena capped at the front while Talak\'s read fails there stays closed (blocked), Talak stays unreadable; a different place is judged on its own', async () => {
      readsBy({ front: { [P_ARENA]: TYPED, [P_TALAK]: TYPELESS }, back: {}, left_side: {}, right_side: {} }, { [P_ARENA]: TYPED });
      engine.v13ProtocolRows.mockReturnValue(new Map([[P_ART, {}]]));
      const found = await resolveChinch({ svc, structured: { id: 'protocol-1', version: 'v13' }, knex: fakeKnex([
        { product_id: P_ARENA, product_name: 'Arena 50 WDG', gates: { trigger: 'chinch_20_to_25_per_sqft' }, rate_per_1000: null, rate_unit: 'label_rate', sort_order: 4, month: 4, catalog_id: P_ARENA, catalog_name: 'Arena 50 WDG', catalog_active: true },
        { product_id: P_TALAK, product_name: 'Atticus Talak 7.9 F', gates: { trigger: 'chinch_second_product_caterpillars_or_mole_cricket_nymphs' }, rate_per_1000: null, rate_unit: 'label_rate', sort_order: 4, month: 7, catalog_id: P_TALAK, catalog_name: 'Atticus Talak 7.9 F', catalog_active: true },
      ]), places: PLACES });
      expect(found.byPlace.front).toMatchObject({ productId: null, blockedIds: [P_ARENA], unreadableIds: [P_TALAK] });
      expect(found.byPlace.back).toMatchObject({ productId: P_ARENA, blockedIds: [], unreadableIds: [] });
    });

    test('add-on picks are judged one by one: a pick capped at the front stays closed there while another pick\'s failed read does not release it', async () => {
      const ROWS3 = new Map([[P_ART, { role: 'fungicide_spot', gates: { trigger: 'mapped_large_patch' } }], [P_ACE, { role: 'insecticide_spot', gates: { trigger: 'caterpillars' } }]]);
      const cs = [{ raw: { product: { id: P_ART, name: 'Artavia' } }, item: { productId: P_ART, name: 'Artavia' } }, { raw: { product: { id: P_ACE, name: 'Acelepryn' } }, item: { productId: P_ACE, name: 'Acelepryn' } }];
      // Artavia: capped everywhere. Acelepryn: unknown everywhere. Neither read changes the other's verdict.
      readsBy(Object.fromEntries(PLACES.map((p) => [p, { [P_ART]: TYPED, [P_ACE]: TYPELESS }])), { [P_ART]: TYPED, [P_ACE]: TYPELESS });
      const offers = await addOnOffers({ candidates: cs, rows: ROWS3, svc, knex: {}, places: PLACES });
      expect(offers.blocked).toEqual([P_ART]);
      expect(offers.unreadable).toEqual([P_ACE]);
    });

    test('the guide\'s blocked and unreadable lists follow the top-level unreadable ids of the weed mix and the chinch ladder', () => {
      const { unreadableProductIds, blockedProductIds } = require('../services/lawn-treatment-guide');
      const weedMix = { mode: 'replacement', productIds: ['b'], groupProductIds: ['a', 'b', 'c'], unreadableIds: ['a'] };
      expect(unreadableProductIds({ offers: {}, chinch: { unreadableIds: [P_ARENA] }, weedMix })).toEqual([P_ARENA, 'a']);
      // 'a' is not offered by the top-level mode, but it is unknown somewhere, so it is not reported as forbidden.
      expect(blockedProductIds({ offers: {}, chinch: { blockedIds: [] }, weedMix })).toEqual(['c']);
    });
  });

  test('weedOffer carries what each place takes; a place whose set the sheet cannot build is left out', () => {
    const items = [{ productId: 'a', name: 'Lead' }, { productId: 'b', name: 'Blind' }];
    const mix = { mode: 'lead', productIds: ['a'], note: null, byPlace: {
      front: { mode: 'replacement', productIds: ['b'], note: 'Use Blind.' },
      back: { mode: 'lead', productIds: ['a'], note: null },
      left_side: { mode: 'none', productIds: [], note: 'Limit.' },
      right_side: { mode: 'lead', productIds: ['a', 'missing'], note: null },
    } };
    const offer = weedOffer(mix, items);
    expect(Object.keys(offer.byPlace)).toEqual(['front', 'back']);
    expect(offer.byPlace.front).toMatchObject({ productIds: ['b'], names: ['Blind'], note: 'Use Blind.' });
    expect(weedOffer({ mode: 'lead', productIds: ['a'] }, items)).not.toHaveProperty('byPlace');
  });

  test('the weeds card and the chinch card carry a set per place; other cards and the lawn-wide form carry none', () => {
    const weeds = { productIds: ['a'], names: ['Lead'], items: [{ productId: 'a', name: 'Lead' }], note: null, byPlace: { back: { productIds: ['a'], names: ['Lead'], items: [{ productId: 'a', name: 'Lead' }], note: null } } };
    const chinchItem = { productId: P_ARENA, name: 'Arena' };
    const talak = { productId: P_TALAK, name: 'Talak' };
    const offers = { chinch: { item: talak, note: 'n', byPlace: { front: { item: talak, note: 'n' }, back: { item: chinchItem, note: null }, left_side: { item: null, note: 'none' } } } };
    const cards = buildCards({ signals: { weedCoverage: 40, insect: 'severe' }, month: 7, offers, weeds });
    expect(cards.find((c) => c.kind === 'weeds').byPlace).toEqual(weeds.byPlace);
    expect(cards.find((c) => c.kind === 'chinch').byPlace).toEqual({
      front: { productIds: [P_TALAK], names: ['Talak'], items: [talak], note: 'n' },
      back: { productIds: [P_ARENA], names: ['Arena'], items: [chinchItem], note: null },
    });
    const plain = buildCards({ signals: { weedCoverage: 40, insect: 'severe' }, month: 7, offers: { chinch: { item: talak, note: null } }, weeds: { ...weeds, byPlace: undefined } });
    for (const card of plain) expect(card).not.toHaveProperty('byPlace');
  });
});

describe('resolveChinch: Arena, then bifenthrin, from the staged rows', () => {
  const STRUCTURED = { id: 'protocol-1', version: 'v13' };
  const staged = (productId, name, trigger, month, extra = {}) => ({
    product_id: productId, product_name: name, gates: { trigger }, rate_per_1000: null, rate_unit: 'label_rate', sort_order: 4, month,
    catalog_id: productId, catalog_name: name, catalog_active: true, ...extra,
  });
  const ROWS = () => [
    staged(P_ARENA, 'Arena 50 WDG', 'chinch_20_to_25_per_sqft', 5),
    staged(P_ARENA, 'Arena 50 WDG', 'chinch_20_to_25_per_sqft', 4),
    staged(P_TALAK, 'Atticus Talak 7.9 F', 'chinch_second_product_caterpillars_or_mole_cricket_nymphs', 7),
  ];
  const run = (rows = ROWS(), structured = STRUCTURED) => resolveChinch({ svc, structured, knex: fakeKnex(rows) });
  const CAP = [{ type: 'annual_max_apps', message: 'Arena: 2/2 other applications — LIMIT REACHED.' }];
  beforeEach(() => engine.v13ProtocolRows.mockReturnValue(new Map([[P_ART, {}]])));

  test('Arena first, with no note', async () => {
    const found = await run();
    // Both rungs are governed; none is blocked when Arena is offered.
    expect(found).toMatchObject({ productId: P_ARENA, name: 'Arena 50 WDG', note: null, rungIds: [P_ARENA, P_TALAK], blockedIds: [] });
    // The earliest window's row stands for the product.
    expect(found.stagedRow.month).toBe(4);
    const asked = engine.v13VisitLimits.mock.calls[0][2];
    expect(asked.map((entry) => entry.product.id)).toEqual([P_ARENA, P_TALAK]);
  });

  test('Arena at its yearly cap: the bifenthrin product, and the note says so', async () => {
    limited([[P_ARENA, CAP]]);
    expect(await run()).toMatchObject({ productId: P_TALAK, name: 'Atticus Talak 7.9 F', note: 'Arena yearly limit reached; Atticus is used in its place.', rungIds: [P_ARENA, P_TALAK], blockedIds: [P_ARENA] });
  });

  test('both at their yearly cap: nothing to offer, and why', async () => {
    limited([[P_ARENA, CAP], [P_TALAK, CAP]]);
    expect(await run()).toMatchObject({ productId: null, note: 'The yearly limit is reached for the chinch bug products on this lawn.', rungIds: [P_ARENA, P_TALAK], blockedIds: [P_ARENA, P_TALAK] });
  });

  // The rule table, PER RUNG. A rung is blocked (a typed limit that was read), unreadable (only a block with
  // no limit type: its own read failed) or clean; a whole-read failure (the limits call threw) makes all unreadable.
  //   Arena          Talak          offered        blocked        unreadable (released)
  //   clean          any            Arena          -              -   (Talak not reached: only not offered)
  //   yearly-capped  clean          Talak (+note)  Arena          -
  //   yearly-capped  unreadable     nothing        Arena          Talak
  //   yearly-capped  yearly-capped  nothing        both           -
  //   unreadable     clean          nothing        -              Arena (Talak not offered: Arena's state is unknown)
  //   unreadable     blocked        nothing        Talak          Arena
  //   unreadable     unreadable     nothing        -              both
  //   other limit    any            nothing (held) both           -
  //   read threw     read threw     nothing        -              both
  const NOTE = 'The limits could not be checked. Use Search products for what you applied; the office will review it.';
  const UNREAD = [{ message: 'application limits could not be read.' }];
  const RUNGS = [P_ARENA, P_TALAK];
  test.each([
    ['Arena clean, Talak unreadable: Arena offered; Talak is not reached (hidden, neither blocked nor released)', [], [[P_TALAK, UNREAD]], { productId: P_ARENA, blockedIds: [], unreadableIds: [] }],
    ['Arena capped, Talak clean: Talak offered', [], [[P_ARENA, CAP]], { productId: P_TALAK, blockedIds: [P_ARENA], unreadableIds: [] }],
    ['Arena capped, Talak unreadable: nothing offered; Arena stays blocked, only Talak is released', [], [[P_ARENA, CAP], [P_TALAK, UNREAD]], { productId: null, note: NOTE, blockedIds: [P_ARENA], unreadableIds: [P_TALAK] }],
    ['Arena unreadable, Talak clean: nothing offered (Arena may not be exhausted); only Arena is released', [], [[P_ARENA, UNREAD]], { productId: null, note: NOTE, blockedIds: [], unreadableIds: [P_ARENA] }],
    ['Arena unreadable, Talak capped: Talak stays blocked, Arena is released', [], [[P_ARENA, UNREAD], [P_TALAK, CAP]], { productId: null, note: NOTE, blockedIds: [P_TALAK], unreadableIds: [P_ARENA] }],
    ['both unreadable: both released', [], [[P_ARENA, UNREAD], [P_TALAK, UNREAD]], { productId: null, note: NOTE, blockedIds: [], unreadableIds: RUNGS }],
    ['both capped: nothing, both blocked', [], [[P_ARENA, CAP], [P_TALAK, CAP]], { productId: null, blockedIds: RUNGS, unreadableIds: [] }],
    ['a named limit and an unreadable one on one rung: blocked (the read forbids it)', [], [[P_ARENA, [...UNREAD, ...CAP]], [P_TALAK, UNREAD]], { productId: null, blockedIds: [P_ARENA], unreadableIds: [P_TALAK] }],
  ])('%s', async (_name, _unused, entries, expected) => {
    limited(entries);
    expect(await run()).toMatchObject({ rungIds: RUNGS, ...expected });
  });

  test('another limit on Arena holds the offer, but a rung whose own read failed stays unreadable (a sibling\'s known limit does not make it forbidden)', async () => {
    limited([[P_ARENA, [{ type: 'min_interval_days', message: 'Arena: wait 14 days.' }]], [P_TALAK, UNREAD]]);
    expect(await run()).toMatchObject({ productId: null, note: 'Arena: wait 14 days.', blockedIds: [P_ARENA], unreadableIds: [P_TALAK] });
  });

  test('the whole read threw: nothing offered, every rung unreadable, none blocked', async () => {
    engine.v13VisitLimits.mockRejectedValue(new Error('db down'));
    expect(await run()).toMatchObject({ productId: null, note: NOTE, rungIds: RUNGS, blockedIds: [], unreadableIds: RUNGS });
  });

  test('another limit on Arena (not the yearly count) holds the offer with the limit\'s words; it does not fall through', async () => {
    limited([[P_ARENA, [{ type: 'min_interval_days', message: 'Arena: wait 14 days.' }]]]);
    expect(await run()).toMatchObject({ productId: null, note: 'Arena: wait 14 days.', blockedIds: [P_ARENA, P_TALAK] });
  });

  test('Arena not staged: the bifenthrin product alone, with no note', async () => {
    expect(await run([ROWS()[2]])).toMatchObject({ productId: P_TALAK, note: null });
  });

  test('a product the catalog no longer has, or has retired, is skipped', async () => {
    const rows = ROWS();
    rows[0].catalog_id = null;
    rows[1].catalog_active = false;
    expect(await run(rows)).toMatchObject({ productId: P_TALAK, note: null });
    expect(await run(rows.slice(0, 2))).toBeNull();
  });

  test('no staged chinch rows, or no v13 protocol: null, nothing read', async () => {
    expect(await run([])).toBeNull();
    engine.v13ProtocolRows.mockReturnValue(new Map());
    engine.v13VisitLimits.mockClear();
    expect(await run()).toBeNull();
    engine.v13ProtocolRows.mockReturnValue(new Map([[P_ART, {}]]));
    expect(await run(ROWS(), { version: 'v13' })).toBeNull();
    expect(engine.v13VisitLimits).not.toHaveBeenCalled();
  });

  // GATE_LAWN_TROUBLE_AREAS: the same ladder at each place of the lawn.
  describe('with places', () => {
    const PLACES = ['front', 'back', 'left_side', 'right_side'];
    const withPlaces = () => resolveChinch({ svc, structured: STRUCTURED, knex: fakeKnex(ROWS()), places: PLACES });
    const cappedAt = (...places) => engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => ({
      capped: new Map(!options?.place || places.includes(options.place) ? [[P_ARENA, CAP]] : []), warnings: [], blocks: [],
    }));

    test('no places asked: no byPlace, and the limit reader gets the five arguments it always did', async () => {
      const found = await run();
      expect('byPlace' in found).toBe(false);
      expect(engine.v13VisitLimits.mock.calls.every((call) => call.length === 5)).toBe(true);
    });

    test('nothing capped: every place takes Arena and the reader is asked once', async () => {
      const found = await withPlaces();
      expect(Object.keys(found.byPlace)).toEqual(PLACES);
      for (const place of PLACES) expect(found.byPlace[place]).toMatchObject({ productId: P_ARENA, note: null });
      expect(found).toMatchObject({ productId: P_ARENA });
      expect(engine.v13VisitLimits).toHaveBeenCalledTimes(1);
    });

    test('Arena at its yearly count at the front only: the front gets the bifenthrin product, the others Arena; the top level is the first place with a product', async () => {
      cappedAt('front');
      const found = await withPlaces();
      expect(found.byPlace.front).toMatchObject({ productId: P_TALAK, note: 'Arena yearly limit reached; Atticus is used in its place.', blockedIds: [P_ARENA] });
      expect(found.byPlace.back).toMatchObject({ productId: P_ARENA, note: null });
      expect(found).toMatchObject({ productId: P_TALAK });
      expect(engine.v13VisitLimits.mock.calls.map((call) => call[5]?.place)).toEqual([undefined, 'front', 'back', 'left_side', 'right_side']);
    });

    test('a yearly AMOUNT limit at a place marks that place amountBlocked; a count limit does not', async () => {
      const at = (type) => engine.v13VisitLimits.mockImplementation(async (_k, _s, _i, _r, _t, options) => ({
        capped: new Map(!options?.place || options.place === 'front' ? [[P_ARENA, [{ type, matchType: type === 'annual_max_rate' ? 'v13_amount' : 'product', message: 'x' }]]] : []), warnings: [], blocks: [],
      }));
      at('annual_max_rate');
      const amount = await withPlaces();
      expect(amount.byPlace.front.amountBlocked).toBe(true);
      expect('amountBlocked' in amount.byPlace.back).toBe(false);
      at('annual_max_apps');
      expect('amountBlocked' in (await withPlaces()).byPlace.front).toBe(false);
    });

    test('both rungs capped at every place: nothing anywhere, and why', async () => {
      engine.v13VisitLimits.mockImplementation(async () => ({ capped: new Map([[P_ARENA, CAP], [P_TALAK, CAP]]), warnings: [], blocks: [] }));
      const found = await withPlaces();
      for (const place of PLACES) expect(found.byPlace[place]).toMatchObject({ productId: null, note: 'The yearly limit is reached for the chinch bug products on this lawn.' });
      expect(found).toMatchObject({ productId: null });
    });

    test('a place whose limit read throws is unreadable for that place (never "open"), the others judge on their own', async () => {
      engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => {
        if (options?.place === 'back') throw new Error('db down');
        return { capped: new Map([[P_ARENA, CAP]]), warnings: [], blocks: [] };
      });
      const found = await withPlaces();
      expect(found.byPlace.back).toMatchObject({ productId: null, unreadableIds: [P_ARENA, P_TALAK] });
      expect(found.byPlace.front).toMatchObject({ productId: P_TALAK });
    });
  });

  // Three cases, kept apart: (1) the lookup succeeded and stages no chinch row = null; (2) the lookup
  // threw = the error propagates (never a "successful" answer with no rungs); (3) rows found but the
  // LIMIT read failed = unreadable (the rungs are known, released to the search, with the note).
  describe('the three failure cases', () => {
    test('(1) the lookup succeeded and no chinch row is staged: null, a real "nothing to offer"', async () => {
      expect(await run([])).toBeNull();
    });
    test('(2) the lookup threw: it rejects, so no answer claims "no rungs"', async () => {
      await expect(run(new Error('db down'))).rejects.toThrow('db down');
      expect(engine.v13VisitLimits).not.toHaveBeenCalled();
    });
    test('(3) rows found but the limit read failed: unreadable, with the rungs known', async () => {
      engine.v13VisitLimits.mockRejectedValue(new Error('limits down'));
      expect(await run()).toMatchObject({ productId: null, rungIds: [P_ARENA, P_TALAK], blockedIds: [], unreadableIds: [P_ARENA, P_TALAK], note: expect.stringMatching(/could not be checked/) });
    });
  });
});

describe('lawnTreatmentGuideLive: strict, and only with the spot rules and the v13 program', () => {
  const { lawnTreatmentGuideLive } = require('../config/feature-gates');
  const set = (guide, spot, v13) => {
    for (const [name, value] of [['GATE_LAWN_TREATMENT_GUIDE', guide], ['GATE_LAWN_SPOT_RULES', spot], ['GATE_LAWN_V13', v13]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
  test.each([
    ['true', 'true', 'true', true],
    ['true', 'true', undefined, false],
    ['true', undefined, 'true', false],
    ['true', undefined, undefined, false],
    [undefined, 'true', 'true', false],
    ['1', 'true', 'true', false],
    ['TRUE', 'true', 'true', false],
    ['true', 'true', '1', false],
  ])('guide=%s spot rules=%s v13=%s is live: %s', (guide, spot, v13, live) => {
    set(guide, spot, v13);
    expect(lawnTreatmentGuideLive()).toBe(live);
  });
});

describe('treatmentGuideFreeze: the completion record', () => {
  const card = (extra = {}) => ({ kind: 'fungus', shown: true, checked: 'found', taken: true, productIds: [P_ART], ...extra });
  const freeze = (cards, extra = {}, options = undefined) => treatmentGuideFreeze({ visitType: 'recurring', treatmentGuide: { v: 1, cards, ...extra } }, options);
  beforeEach(() => { process.env.GATE_LAWN_SPOT_RULES = 'true'; process.env.GATE_LAWN_V13 = 'true'; process.env.GATE_LAWN_TREATMENT_GUIDE = 'true'; });

  test('the v13 program off: nothing is written (fail closed)', () => {
    delete process.env.GATE_LAWN_V13;
    expect(freeze([card()])).toEqual({});
  });

  test('gate off, or the spot rules off: nothing is written', () => {
    delete process.env.GATE_LAWN_TREATMENT_GUIDE;
    expect(freeze([card()])).toEqual({});
    process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
    delete process.env.GATE_LAWN_SPOT_RULES;
    expect(freeze([card()])).toEqual({});
  });

  test('the shape that is kept: kind, shown, checked, taken, product ids', () => {
    expect(freeze([card(), card({ kind: 'weeds', checked: null, taken: false, productIds: [P_CEL, P_CERT] })])).toEqual({
      lawnTreatmentGuide: {
        v: 1,
        cards: [
          { kind: 'fungus', shown: true, checked: 'found', taken: true, productIds: [P_ART] },
          { kind: 'weeds', shown: true, checked: null, taken: false, productIds: [P_CEL, P_CERT] },
        ],
      },
    });
  });

  test('a guide that showed no cards is recorded as such', () => {
    expect(freeze([])).toEqual({ lawnTreatmentGuide: { v: 1, cards: [] } });
  });

  test('no block, a wrong version or a malformed block: nothing', () => {
    expect(treatmentGuideFreeze({ visitType: 'recurring' })).toEqual({});
    expect(treatmentGuideFreeze(null)).toEqual({});
    expect(treatmentGuideFreeze({ treatmentGuide: { v: 2, cards: [card()] } })).toEqual({});
    expect(treatmentGuideFreeze({ treatmentGuide: [card()] })).toEqual({});
    expect(treatmentGuideFreeze({ treatmentGuide: 'x' })).toEqual({});
  });

  test('unknown kinds, repeats and malformed cards are dropped; a card is always recorded as shown', () => {
    const out = freeze([card({ kind: 'mystery' }), card({ shown: false }), null, 'x', card({ kind: 'dry_spots', checked: 'found' }), card()]).lawnTreatmentGuide.cards;
    expect(out.map((c) => c.kind)).toEqual(['fungus', 'dry_spots']);
    expect(out.every((c) => c.shown === true)).toBe(true);
  });

  test('checked is found | none | null; taken is a real boolean', () => {
    const out = freeze([
      card({ kind: 'fungus', checked: 'maybe', taken: 'yes' }),
      card({ kind: 'chinch', checked: 'none', taken: false }),
    ]).lawnTreatmentGuide.cards;
    expect(out[0]).toMatchObject({ checked: null, taken: false });
    expect(out[1]).toMatchObject({ checked: 'none', taken: false });
  });

  test('product ids are bounded: uuids only, lower-case, each once, at most four', () => {
    const ids = [P_ART.toUpperCase(), P_ART, 'not-an-id', 7, uuid(31), uuid(32), uuid(33), uuid(34)];
    expect(freeze([card({ productIds: ids })]).lawnTreatmentGuide.cards[0].productIds).toEqual([P_ART, uuid(31), uuid(32), uuid(33)]);
    expect(freeze([card({ productIds: 'x' })]).lawnTreatmentGuide.cards[0].productIds).toEqual([]);
  });

  test('the number of cards is bounded', () => {
    const many = Array.from({ length: 50 }, () => card());
    expect(freeze(many).lawnTreatmentGuide.cards).toHaveLength(1);
    const kinds = ['weeds', 'fungus', 'chinch', 'caterpillars', 'dry_spots'].map((kind) => card({ kind }));
    expect(freeze(kinds).lawnTreatmentGuide.cards).toHaveLength(5);
  });

  // GATE_LAWN_TROUBLE_AREAS: a card taken at a place also names the place, and its ids are the products actually added.
  describe('a card taken at a place', () => {
    const placed = (extra = {}) => card({ kind: 'weeds', productIds: [P_CEL, P_CERT], place: 'back', ...extra });
    const applied = (...ids) => ({ appliedIds: new Set(ids) });
    beforeEach(() => { process.env.GATE_LAWN_TROUBLE_AREAS = 'true'; });
    afterEach(() => { delete process.env.GATE_LAWN_TROUBLE_AREAS; });

    test('the place and the flat list of ids actually added are recorded', () => {
      expect(freeze([placed()], {}, applied(P_CEL, P_CERT)).lawnTreatmentGuide.cards).toEqual([
        { kind: 'weeds', shown: true, checked: 'found', taken: true, productIds: [P_CEL, P_CERT], place: 'back' },
      ]);
    });

    test('ids that were not applied are dropped; a card with a place and nothing applied is not taken and names no place', () => {
      expect(freeze([placed()], {}, applied(P_CEL)).lawnTreatmentGuide.cards[0]).toMatchObject({ taken: true, productIds: [P_CEL], place: 'back' });
      const none = freeze([placed()], {}, applied(P_ART)).lawnTreatmentGuide.cards[0];
      expect(none).toMatchObject({ taken: false, productIds: [] });
      expect(none).not.toHaveProperty('place');
    });

    test.each([['roof'], [''], [null], [3], ['BACK']])('a place that is not on the closed list (%p) is not recorded: the card is exactly what it always was', (place) => {
      const out = freeze([placed({ place })], {}, applied(P_CEL, P_CERT)).lawnTreatmentGuide.cards[0];
      expect(out).toEqual({ kind: 'weeds', shown: true, checked: 'found', taken: true, productIds: [P_CEL, P_CERT] });
    });

    test('a card not taken carries no place even if one is sent', () => {
      expect(freeze([placed({ taken: false })], {}, applied(P_CEL)).lawnTreatmentGuide.cards[0]).toEqual({ kind: 'weeds', shown: true, checked: 'found', taken: false, productIds: [P_CEL, P_CERT] });
    });

    test('the report ties read the same record: a find with a place still yields the flat ids actually applied (what verifyGuideFind checks)', () => {
      const { guideTakenFindings } = require('../services/lawn-treatment-guide');
      const record = freeze([card({ kind: 'chinch', productIds: [P_CEL, P_CERT], place: 'front', checked: 'found' })], {}, applied(P_CEL)).lawnTreatmentGuide;
      expect(guideTakenFindings({ lawnTreatmentGuide: record })).toEqual([{ kind: 'chinch', productIds: [P_CEL] }]);
    });

    test('without the places gate the record is byte-identical: the place is ignored and ids are not narrowed', () => {
      delete process.env.GATE_LAWN_TROUBLE_AREAS;
      expect(freeze([placed()], {}, applied(P_ART)).lawnTreatmentGuide.cards[0]).toEqual({ kind: 'weeds', shown: true, checked: 'found', taken: true, productIds: [P_CEL, P_CERT] });
    });
  });
});

describe('guideTakenFindings: the one deliberate reader of the record besides the freeze', () => {
  const { guideTakenFindings } = require('../services/lawn-treatment-guide');
  const notes = (cards, v = 1) => JSON.stringify({ lawnTreatmentGuide: { v, cards } });
  const card = (extra = {}) => ({ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: [P_ART], ...extra });

  test('a find that was taken: its kind and the product ids the card named (for the caller to verify)', () => {
    expect(guideTakenFindings(notes([card(), card({ kind: 'fungus' }), card({ kind: 'caterpillars' })]))).toEqual([
      { kind: 'chinch', productIds: [P_ART] }, { kind: 'fungus', productIds: [P_ART] }, { kind: 'caterpillars', productIds: [P_ART] },
    ]);
  });

  test('only found AND taken counts; "nothing found", unchecked and not-taken cards do not', () => {
    expect(guideTakenFindings(notes([card({ checked: 'none' }), card({ kind: 'fungus', checked: null }), card({ kind: 'caterpillars', taken: false })]))).toEqual([]);
  });

  test('weeds and dry spots name nothing the technician saw, so they never count', () => {
    expect(guideTakenFindings(notes([card({ kind: 'weeds' }), card({ kind: 'dry_spots' })]))).toEqual([]);
  });

  test('a repeat is one find; a wrong version, a missing block or a malformed one is nothing', () => {
    expect(guideTakenFindings(notes([card(), card()]))).toEqual([{ kind: 'chinch', productIds: [P_ART] }]);
    expect(guideTakenFindings(notes([card()], 2))).toEqual([]);
    expect(guideTakenFindings('{}')).toEqual([]);
    expect(guideTakenFindings(null)).toEqual([]);
    expect(guideTakenFindings({ lawnTreatmentGuide: { v: 1, cards: 'x' } })).toEqual([]);
  });
});

describe('the record never leaves the technician side', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const files = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? files(path.join(dir, entry.name)) : (entry.name.endsWith('.js') ? [path.join(dir, entry.name)] : [])));

  // The lawn report's finding-to-product tie (GATE_LAWN_REPORT_FACTS) is a second reader, and a deliberate one: it
  // goes through guideTakenFindings, which hands back kinds and the product ids only, so the key still has ONE owner.
  test('only the guide module names the structured_notes key: no report, public or customer path reads it', () => {
    const readers = [...files('routes'), ...files('services')]
      .filter((file) => file !== path.join('services', 'lawn-treatment-guide.js'))
      .filter((file) => /\blawnTreatmentGuide\b(?!Live)/.test(fs.readFileSync(path.join(root, file), 'utf8')));
    expect(readers).toEqual([]);
  });

  test('the completion freezes it through the validator, from the lawnFast echo', () => {
    const source = fs.readFileSync(path.join(root, 'services', 'complete-scheduled-service.js'), 'utf8');
    expect(source).toContain("...require('./lawn-treatment-guide').treatmentGuideFreeze(lawnFast, { products }),");
  });
});
