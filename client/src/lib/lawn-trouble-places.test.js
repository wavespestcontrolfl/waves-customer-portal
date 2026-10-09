// The sheet's reading of the server's places and trouble areas (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-09):
// pure functions, synthetic data. The rules live on the server; these only read its answers.
import { describe, expect, test } from 'vitest';
import { defaultPlaceFor, knownPlacesOfType, placeProblems, troubleAreasOf, troubleTypeOfRow, withPlace } from './lawn-trouble-places';

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
