// The sheet's reading of the server's places and trouble areas (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-09):
// pure functions, synthetic data. The rules live on the server; these only read its answers.
import { describe, expect, test } from 'vitest';
import { defaultPlaceFor, knownPlacesOfType, placeProblems, troubleAreasOf, troubleTypeOfRow, withClearedTakeAll, withPlace } from './lawn-trouble-places';

const PLACES = [{ id: 'front', label: 'Front' }, { id: 'back', label: 'Back' }];
const block = (extra = {}) => ({ v: 1, places: PLACES, known: [], knownUnavailable: false, blocked: {}, ...extra });
const data = (extra = {}) => ({ spotRules: true, troubleAreas: block(extra) });
const row = (extra = {}) => ({ productId: 'P1', name: 'Spot Fungicide', product: { category: 'fungicide' }, method: 'spot_treatment', ...extra });

describe('troubleAreasOf', () => {
  test('null without the spot rules, without version 1, or without a place list', () => {
    expect(troubleAreasOf(undefined)).toBeNull();
    expect(troubleAreasOf({ troubleAreas: block() })).toBeNull();
    expect(troubleAreasOf({ spotRules: true })).toBeNull();
    expect(troubleAreasOf({ spotRules: true, troubleAreas: { ...block(), v: 2 } })).toBeNull();
    expect(troubleAreasOf({ spotRules: true, troubleAreas: { ...block(), places: [] } })).toBeNull();
    expect(troubleAreasOf({ spotRules: true, troubleAreas: { ...block(), places: [{ id: 'x' }] } })).toBeNull();
  });

  test('keeps the places, drops a known area at a place not on the list, and defaults the rest', () => {
    const areas = troubleAreasOf(data({ known: [{ id: 'a', place: 'back', type: 'fungus' }, { id: 'b', place: 'roof', type: 'fungus' }, { place: 'front', type: 'weeds' }] }));
    expect(areas.places).toEqual(PLACES);
    expect(areas.known.map((area) => area.id)).toEqual(['a']);
    expect(areas.known[0]).toMatchObject({ placeLabel: 'back', typeLabel: 'fungus', lastTreatedOn: null });
    expect(areas.blocked).toEqual({});
    expect(areas.knownUnavailable).toBe(false);
  });
});

describe('troubleTypeOfRow', () => {
  test.each([
    [{ guided: 'chinch', product: { category: 'insecticide' } }, 'chinch'],
    [{ guided: 'caterpillars' }, 'other_insect'],
    [{ guided: 'dry_spots' }, 'dry_spot'],
    [{ guided: 'weeds' }, 'weeds'],
    [{ guided: 'fungus' }, 'fungus'],
    [{ product: { category: 'Herbicide' } }, 'weeds'],
    [{ product: { category: 'insecticide' } }, 'other_insect'],
    [{ product: { category: 'adjuvant' } }, null],
    [{}, null],
  ])('%j is %s', (input, expected) => expect(troubleTypeOfRow(input)).toBe(expected));
});

describe('a take-all product added through Search', () => {
  const areas = troubleAreasOf(data({ known: [{ id: 'a', place: 'back', type: 'take_all' }, { id: 'b', place: 'front', type: 'fungus' }] }));
  test('is a take_all trouble type when the guide\'s take-all set holds it, plain fungus otherwise', () => {
    const fungicide = row({ productId: 'T1' });
    expect(troubleTypeOfRow(fungicide)).toBe('fungus');
    expect(troubleTypeOfRow({ ...fungicide, takeAllRow: true })).toBe('take_all');
    expect(withPlace(fungicide, { areas, chosen: 'back', takeAll: new Set(['t1']) }).takeAllRow).toBe(true);
    expect(withPlace(fungicide, { areas, chosen: 'back', takeAll: new Set(['other']) }).takeAllRow).toBeUndefined();
    expect(withPlace(fungicide, { areas, chosen: 'back' }).takeAllRow).toBeUndefined();
  });

  test('its default place is the lawn\'s known take-all area, not the fungus one', () => {
    const fungicide = row({ productId: 'T1' });
    expect(withPlace(fungicide, { areas, chosen: '', takeAll: new Set(['t1']) }).place).toBe('back');
    expect(withPlace(fungicide, { areas, chosen: '' }).place).toBe('front');
  });
});

describe('placeProblems', () => {
  const areas = (extra) => troubleAreasOf(data(extra));
  test('a plain row follows the products a limit closes at a place', () => {
    const a = areas({ blocked: { p1: { front: 'closed up front' } } });
    expect(placeProblems(row(), { areas: a })).toEqual({ front: 'closed up front', back: null });
    // The server\'s ids are lower case; the row\'s may not be.
    expect(placeProblems(row({ productId: 'P1' }), { areas: a }).front).toBe('closed up front');
  });

  test('a weed row fits a place only if the place takes every weed row on the sheet; none or a missing place closes it; unavailable closes nothing', () => {
    const a = areas();
    const mix = { byPlace: {
      front: { mode: 'lead', productIds: ['W1', 'W2'], note: null },
      back: { mode: 'replacement', productIds: ['B1'], note: 'Back uses the replacement.' },
    } };
    const weedRows = [row({ productId: 'w1', weedGroup: true }), row({ productId: 'W2', weedGroup: true })];
    expect(placeProblems(weedRows[0], { areas: a, weedMix: mix, weedRows })).toEqual({ front: null, back: 'Back uses the replacement.' });
    expect(placeProblems(weedRows[0], { areas: a, weedMix: { byPlace: { front: { mode: 'none', productIds: [], note: 'At the limit.' }, back: { mode: 'unavailable', productIds: [] } } }, weedRows }))
      .toEqual({ front: 'At the limit.', back: null });
    expect(placeProblems(weedRows[0], { areas: a, weedMix: { byPlace: {} }, weedRows })).toEqual({ front: null, back: null });
  });

  test('a chinch row needs the place to offer this very product; an unreadable limit is not a refusal', () => {
    const a = areas();
    const chinch = { byPlace: {
      front: { item: { productId: 'C1' }, note: null, unreadableIds: [] },
      back: { item: { productId: 'C2' }, note: 'Used in its place.', unreadableIds: [] },
    } };
    expect(placeProblems(row({ productId: 'c1', guided: 'chinch' }), { areas: a, chinch })).toEqual({ front: null, back: 'Used in its place.' });
    const unread = { byPlace: { front: { item: null, note: 'could not be read', unreadableIds: ['C1'] }, back: { item: null, note: null, unreadableIds: [] } } };
    expect(placeProblems(row({ productId: 'C1', guided: 'chinch' }), { areas: a, chinch: unread })).toEqual({ front: null, back: 'This chinch product is not available at this place.' });
  });
});

describe('defaults and withPlace', () => {
  const area = (id, place, type) => ({ id, place, type, typeLabel: type, placeLabel: place });
  test('the single known area of the row\'s type that is open is the default; two, none or a closed one are not', () => {
    const one = troubleAreasOf(data({ known: [area('a', 'back', 'fungus')] }));
    expect(defaultPlaceFor(row(), { areas: one, problems: { front: null, back: null } })).toBe('back');
    expect(defaultPlaceFor(row(), { areas: one, problems: { front: null, back: 'closed' } })).toBe('');
    const two = troubleAreasOf(data({ known: [area('a', 'back', 'fungus'), area('b', 'front', 'fungus')] }));
    expect(defaultPlaceFor(row(), { areas: two, problems: {} })).toBe('');
    const other = troubleAreasOf(data({ known: [area('a', 'back', 'weeds')] }));
    expect(defaultPlaceFor(row(), { areas: other, problems: {} })).toBe('');
    expect(defaultPlaceFor(row({ product: { category: 'adjuvant' } }), { areas: one, problems: {} })).toBe('');
    expect(knownPlacesOfType(two, 'fungus')).toEqual(new Set(['back', 'front']));
  });

  test('the tech\'s tap beats the default; a tap on a place not on the list is ignored; the row says what holds it', () => {
    const a = troubleAreasOf(data({ known: [area('a', 'back', 'fungus')], blocked: { p1: { front: 'closed up front' } } }));
    const defaulted = withPlace(row(), { areas: a, chosen: '' });
    expect(defaulted).toMatchObject({ placeRule: true, place: 'back', placeDefaulted: true, placeBlock: null, placeNowhere: null, placeLabels: { front: 'Front', back: 'Back' } });
    expect(withPlace(row(), { areas: a, chosen: 'front' })).toMatchObject({ place: 'front', placeDefaulted: false, placeBlock: 'closed up front' });
    expect(withPlace(row(), { areas: a, chosen: 'roof' })).toMatchObject({ place: 'back', placeDefaulted: true });
    const every = troubleAreasOf(data({ blocked: { p1: { front: 'no', back: 'no' } } }));
    expect(withPlace(row(), { areas: every, chosen: '' })).toMatchObject({ place: '', placeNowhere: 'no' });
  });
});

describe('a place whose limit read failed', () => {
  const areas = troubleAreasOf(data());
  test('is allowed and flagged unreadable for the weed rows and the chinch row; a place that read as capped is not', () => {
    const weedMix = { byPlace: { front: { mode: 'unavailable', productIds: [] }, back: { mode: 'none', productIds: [], note: 'Limit.' } } };
    const weedRows = [row({ productId: 'w1', weedGroup: true })];
    expect(withPlace(weedRows[0], { areas, chosen: 'front', weedMix, weedRows })).toMatchObject({ placeBlock: null, placeUnreadable: true });
    expect(withPlace(weedRows[0], { areas, chosen: 'back', weedMix, weedRows })).toMatchObject({ placeBlock: 'Limit.', placeUnreadable: false });
    const chinch = { byPlace: { front: { item: null, note: 'n', unreadableIds: ['C1'] }, back: { item: { productId: 'C1' }, note: null, unreadableIds: [] } } };
    expect(withPlace(row({ productId: 'c1', guided: 'chinch' }), { areas, chosen: 'front', chinch })).toMatchObject({ placeBlock: null, placeUnreadable: true });
    expect(withPlace(row({ productId: 'c1', guided: 'chinch' }), { areas, chosen: 'back', chinch })).toMatchObject({ placeUnreadable: false });
  });
});

describe('rows that stay on the sheet without the tag of the entry that opened them (a planned row, a Search-added row)', () => {
  const areas = troubleAreasOf(data({ blocked: { c1: { front: 'wrongly listed' } } }));
  const chinch = { rungIds: ['C1', 'C2'], byPlace: {
    front: { item: { productId: 'C2' }, note: 'Arena is at its limit up front.', unreadableIds: [], blockedIds: ['C1'] },
    back: { item: { productId: 'C1' }, note: null, unreadableIds: [], blockedIds: [] },
  } };
  test('a chinch rung is judged by the ladder\'s decision at each place, not by the generic closed list: Arena is closed where the ladder blocked it, the second rung is open', () => {
    expect(placeProblems(row({ productId: 'c1' }), { areas, chinch })).toEqual({ front: 'Arena is at its limit up front.', back: null });
    expect(placeProblems(row({ productId: 'C2' }), { areas, chinch })).toEqual({ front: null, back: null });
  });

  test('without the blocked ids (an older answer) the place offers its one product', () => {
    const old = { rungIds: ['C1', 'C2'], byPlace: { front: { item: { productId: 'C2' }, note: 'n', unreadableIds: [] }, back: { item: { productId: 'C1' }, note: null, unreadableIds: [] } } };
    expect(placeProblems(row({ productId: 'C1' }), { areas, chinch: old })).toEqual({ front: 'n', back: null });
  });

  test('a weed-group product on its own is judged by the weed decision at each place; the surfactant closes no place', () => {
    const weedMix = { groupProductIds: ['W1', 'W2', 'S1'], noAreaProductIds: ['S1'], byPlace: {
      front: { mode: 'replacement', productIds: ['W2'], note: 'Use the replacement up front.' },
      back: { mode: 'lead', productIds: ['W1', 'S1'], note: null },
    } };
    expect(placeProblems(row({ productId: 'w1' }), { areas, weedMix })).toEqual({ front: 'Use the replacement up front.', back: null });
    expect(placeProblems(row({ productId: 'W2' }), { areas, weedMix })).toEqual({ front: null, back: 'The weed products on the sheet do not fit this place.' });
    expect(placeProblems(row({ productId: 'S1' }), { areas, weedMix })).toEqual({ front: null, back: null });
    // Two untagged members are each judged alone: no shared set.
    expect(placeProblems(row({ productId: 'W1' }), { areas, weedMix, weedRows: [row({ productId: 'W1', weedGroup: true })] }).front).toBe('Use the replacement up front.');
  });
});

describe('a sibling\'s failed read never releases a product that read as capped', () => {
  const areas = troubleAreasOf(data());
  // At the front Certainty's read failed ('unavailable') while Celsius read as capped (blockedIds); the back is clean.
  const weedMix = {
    groupProductIds: ['W1', 'W2'], noAreaProductIds: [],
    byPlace: {
      front: { mode: 'unavailable', productIds: [], note: 'The weed-spray limits could not be checked. Use Other product for what you sprayed.', blockedIds: ['W1'] },
      back: { mode: 'lead', productIds: ['W1', 'W2'], note: null },
    },
  };

  test('the capped member stays closed at the front; the member whose read failed is allowed there, with the unreadable flag', () => {
    expect(placeProblems(row({ productId: 'w1' }), { areas, weedMix }).front).toMatch(/yearly limit is reached/);
    expect(placeProblems(row({ productId: 'W2' }), { areas, weedMix })).toEqual({ front: null, back: null });
    const celsius = withPlace(row({ productId: 'W1' }), { areas, chosen: 'front', weedMix });
    expect(celsius).toMatchObject({ placeUnreadable: false });
    expect(celsius.placeBlock).toMatch(/yearly limit is reached/);
    expect(withPlace(row({ productId: 'W2' }), { areas, chosen: 'front', weedMix })).toMatchObject({ placeBlock: null, placeUnreadable: true });
  });

  test('the entry\'s shared set is closed at the front while any member read as capped there', () => {
    const weedRows = [row({ productId: 'W1', weedGroup: true }), row({ productId: 'W2', weedGroup: true })];
    expect(placeProblems(weedRows[1], { areas, weedMix, weedRows }).front).toMatch(/yearly limit is reached/);
    // With no capped member, the failed read is the unknown: allowed.
    const unknownOnly = { ...weedMix, byPlace: { ...weedMix.byPlace, front: { ...weedMix.byPlace.front, blockedIds: [] } } };
    expect(placeProblems(weedRows[1], { areas, weedMix: unknownOnly, weedRows }).front).toBeNull();
    expect(withPlace(weedRows[1], { areas, chosen: 'front', weedMix: unknownOnly, weedRows })).toMatchObject({ placeUnreadable: true });
  });
});

describe('a chinch-ladder row is chinch when the program makes it so', () => {
  const area = (id, place, type) => ({ id, place, type, typeLabel: type, placeLabel: place });
  const areas = troubleAreasOf(data({ known: [area('a', 'back', 'chinch')] }));
  const insecticide = (id, extra = {}) => row({ productId: id, product: { category: 'insecticide' }, ...extra });
  const chinch = { chinchOnlyIds: ['A1'], rungIds: ['A1', 'T1'], byPlace: { front: { item: { productId: 'T1' }, note: null, unreadableIds: [] }, back: { item: { productId: 'A1' }, note: null, unreadableIds: [] } } };

  test('the chinch-only rung (Arena, by the staged triggers) is chinch with no tag, and pre-fills from the known chinch area', () => {
    const out = withPlace(insecticide('a1'), { areas, chosen: '', chinch });
    expect(out.chinchRow).toBe(true);
    expect(troubleTypeOfRow(out)).toBe('chinch');
    expect(out.place).toBe('back');
  });

  test('the later rung (also the caterpillar product) stays an insect unless the chinch entry or card opened it, or it is the decision\'s product where it sits', () => {
    expect(troubleTypeOfRow(withPlace(insecticide('t1'), { areas, chosen: 'back', chinch }))).toBe('other_insect');
    expect(troubleTypeOfRow(withPlace(insecticide('t1'), { areas, chosen: 'front', chinch }))).toBe('chinch');
    expect(troubleTypeOfRow(withPlace(insecticide('t1', { guided: 'chinch' }), { areas, chosen: 'back', chinch }))).toBe('chinch');
    expect(troubleTypeOfRow(withPlace(insecticide('t1', { guided: 'caterpillars' }), { areas, chosen: 'back', chinch }))).toBe('other_insect');
  });

  test('a product outside the ladder, or an answer with no chinch-only ids, is typed by its category as before', () => {
    expect(troubleTypeOfRow(withPlace(insecticide('x9'), { areas, chosen: 'back', chinch }))).toBe('other_insect');
    // (at the front the decision names the later rung, so Arena there is not the decision's product)
    expect(troubleTypeOfRow(withPlace(insecticide('a1'), { areas, chosen: 'front', chinch: { ...chinch, chinchOnlyIds: undefined } }))).toBe('other_insect');
  });

  test('a take-all product is never retyped as chinch', () => {
    expect(troubleTypeOfRow(withPlace(insecticide('a1'), { areas, chosen: 'back', chinch, takeAll: new Set(['a1']) }))).toBe('take_all');
  });
});

describe('what /complete refused is authoritative', () => {
  test('closes the place for that product whatever any map says, and for no other product', () => {
    const base = troubleAreasOf(data());
    const areas = { ...base, refused: { w1: { front: 'Celsius WG: LIMIT REACHED.' } } };
    expect(placeProblems(row({ productId: 'W1' }), { areas }).front).toBe('Celsius WG: LIMIT REACHED.');
    // Even a weed-group row the weed decision says fits the place.
    const weedMix = { groupProductIds: ['W1'], byPlace: { front: { mode: 'lead', productIds: ['W1'], note: null } } };
    expect(placeProblems(row({ productId: 'w1', weedGroup: true }), { areas, weedMix, weedRows: [row({ productId: 'w1', weedGroup: true })] }).front).toBe('Celsius WG: LIMIT REACHED.');
    expect(placeProblems(row({ productId: 'W2' }), { areas }).front).toBeNull();
    expect(placeProblems(row({ productId: 'W1' }), { areas: base }).front).toBeNull();
  });
});

describe('a take-all row from the guide card is held to the mapped places', () => {
  const areas = troubleAreasOf(data({ known: [{ id: 'a', place: 'back', type: 'take_all', typeLabel: 't', placeLabel: 'Back' }] }));
  const fungicide = (extra = {}) => row({ productId: 'T1', troubleSource: 'guide_card', ...extra });
  const mapped = new Set(['back']);

  test('the card row has only the mapped place open; the others carry the reason', () => {
    const out = withPlace(fungicide(), { areas, chosen: '', takeAll: new Set(['t1']), takeAllPlaces: mapped });
    expect(out.placeProblems).toEqual({ front: expect.stringMatching(/mapped take-all areas only/), back: null });
    expect(out.place).toBe('back');
    // Moved to an unmapped place, the row says so and Complete holds on it.
    const moved = withPlace(fungicide(), { areas, chosen: 'front', takeAll: new Set(['t1']), takeAllPlaces: mapped });
    expect(moved.placeBlock).toMatch(/mapped take-all areas only/);
  });

  test('a Search-added take-all row (tech_tap) may map any open place; so may a row with no allowlist', () => {
    expect(withPlace(fungicide({ troubleSource: 'tech_tap' }), { areas, chosen: 'front', takeAll: new Set(['t1']), takeAllPlaces: mapped }).placeBlock).toBeNull();
    expect(withPlace(fungicide(), { areas, chosen: 'front', takeAll: new Set(['t1']), takeAllPlaces: null }).placeBlock).toBeNull();
  });

  test('only a take-all product is held: a plain fungicide from a card is not', () => {
    expect(withPlace(fungicide(), { areas, chosen: 'front', takeAll: new Set(), takeAllPlaces: mapped }).placeBlock).toBeNull();
  });
});


describe('a block of the yearly AMOUNT ends when the row\'s dose moved; a count or interval block never does', () => {
  const withMoved = (extra, moved) => ({ ...troubleAreasOf(data(extra)), moved });
  const map = (type) => ({ blocked: { p1: { front: 'closed up front' } }, blockedTypes: { p1: { front: type } } });

  test('the maps: amount ends for the moved product only; count, interval and an untyped entry stay', () => {
    expect(placeProblems(row(), { areas: withMoved(map('annual_max_rate'), []) }).front).toBe('closed up front');
    expect(placeProblems(row(), { areas: withMoved(map('annual_max_rate'), ['p1']) }).front).toBeNull();
    expect(placeProblems(row(), { areas: withMoved(map('annual_max_rate'), ['other']) }).front).toBe('closed up front');
    for (const type of ['annual_max_apps', 'min_interval_days']) expect(placeProblems(row(), { areas: withMoved(map(type), ['p1']) }).front).toBe('closed up front');
    expect(placeProblems(row(), { areas: withMoved({ blocked: { p1: { front: 'closed up front' } } }, ['p1']) }).front).toBe('closed up front');
  });

  test('the weed decision and the chinch decision: amountBlocked ends for a moved row; without it they stay', () => {
    const weedRows = [row({ productId: 'w1', weedGroup: true })];
    const weedMix = (extra) => ({ byPlace: { front: { mode: 'none', productIds: [], note: 'At the limit.', ...extra } } });
    expect(placeProblems(weedRows[0], { areas: withMoved({}, ['w1']), weedMix: weedMix({ amountBlocked: true }), weedRows }).front).toBeNull();
    expect(placeProblems(weedRows[0], { areas: withMoved({}, []), weedMix: weedMix({ amountBlocked: true }), weedRows }).front).toBe('At the limit.');
    expect(placeProblems(weedRows[0], { areas: withMoved({}, ['w1']), weedMix: weedMix({}), weedRows }).front).toBe('At the limit.');
    const chinchRow = row({ productId: 'c1', guided: 'chinch' });
    const chinch = (extra) => ({ byPlace: { front: { item: null, note: 'Arena is at its limit.', unreadableIds: [], blockedIds: ['c1'], ...extra } } });
    expect(placeProblems(chinchRow, { areas: withMoved({}, ['c1']), chinch: chinch({ amountBlocked: true }) }).front).toBeNull();
    expect(placeProblems(chinchRow, { areas: withMoved({}, []), chinch: chinch({ amountBlocked: true }) }).front).toBe('Arena is at its limit.');
    expect(placeProblems(chinchRow, { areas: withMoved({}, ['c1']), chinch: chinch({}) }).front).toBe('Arena is at its limit.');
  });
});

describe('withClearedTakeAll: the take-all card follows the areas cleared on the sheet', () => {
  const BACK = { id: 'a1', place: 'back', placeLabel: 'Back', type: 'take_all' };
  const FRONT = { id: 'a2', place: 'front', placeLabel: 'Front', type: 'take_all' };
  const card = (extra = {}) => ({ kind: 'fungus', title: 'Fungus', note: 'Take-all area on file: Back, Front.', productIds: ['p1'], items: [{ productId: 'p1' }], heldProductIds: [], allowedPlaces: ['back', 'front'], checkOnlyNote: 'None is on file.', actionLabel: 'Add', dismissLabel: 'No', ...extra });
  const guide = (cards) => ({ assessmentId: 'x', cards });

  test('nothing cleared, or nothing take-all cleared: the same guide object', () => {
    const g = guide([card()]);
    expect(withClearedTakeAll(g, { known: [BACK, FRONT], clearedIds: [], clearedPlaces: [] })).toBe(g);
    expect(withClearedTakeAll(g, { known: [BACK, FRONT], clearedIds: ['zz'], clearedPlaces: [] })).toBe(g);
    expect(withClearedTakeAll(null, { clearedPlaces: ['back'] })).toBeNull();
  });

  test('one of two places cleared: the card keeps the other and names it', () => {
    const out = withClearedTakeAll(guide([card()]), { known: [BACK, FRONT], clearedIds: ['a1'], clearedPlaces: ['back'] });
    expect(out.cards[0]).toMatchObject({ allowedPlaces: ['front'], note: 'Take-all area on file: Front.', productIds: ['p1'] });
    expect(out.cards[0].items).toHaveLength(1);
  });

  test('another active take-all area at the same place keeps the place', () => {
    const second = { id: 'a3', place: 'back', placeLabel: 'Back', type: 'take_all' };
    const g = guide([card()]);
    expect(withClearedTakeAll(g, { known: [BACK, second, FRONT], clearedIds: ['a1'], clearedPlaces: ['back'] })).toBe(g);
  });

  test('every place cleared: the check-only card (no product offered, the product held, no action)', () => {
    const out = withClearedTakeAll(guide([card(), { kind: 'weeds', productIds: ['w'], items: [{ productId: 'w' }] }]), { known: [BACK, FRONT], clearedIds: ['a1', 'a2'], clearedPlaces: ['back', 'front'] });
    expect(out.cards[0]).toMatchObject({ productIds: [], items: [], heldProductIds: ['p1'], note: 'None is on file.', actionLabel: null, dismissLabel: null });
    expect('allowedPlaces' in out.cards[0]).toBe(false);
    // The other card is untouched.
    expect(out.cards[1].productIds).toEqual(['w']);
  });

  test('a cleared place after a fresh read (the area is no longer in known) still drops the place', () => {
    const out = withClearedTakeAll(guide([card({ allowedPlaces: ['back'] })]), { known: [], clearedIds: ['a1'], clearedPlaces: ['back'] });
    expect(out.cards[0].items).toEqual([]);
  });
});
