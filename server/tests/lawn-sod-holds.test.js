const fs = require('fs');
const path = require('path');
const {
  NEW_SOD_COLUMNS,
  SOD_SWAP_BAG,
  FERTILIZER_HOLD_DAYS,
  TETRINO_HOLD_DAYS,
  clearedNewSodColumns,
  validateSodLaidOn,
  preEmergentHoldUntil,
  sodHolds,
  resolveSodRecord,
} = require('../services/lawn-sod-holds');

// Whole-lawn sod laid Oct 1 2026 unless a case says otherwise.
const holds = (visitDate, extra = {}) => sodHolds({ sodLaidOn: '2026-10-01', visitDate, grass: 'bermuda', ...extra });

describe('constants', () => {
  test('the sod record is four columns, in one list', () => {
    expect(NEW_SOD_COLUMNS).toEqual(['sod_laid_on', 'sod_covers', 'sod_area', 'sod_rooted_on']);
    expect(clearedNewSodColumns()).toEqual({ sod_laid_on: null, sod_covers: null, sod_area: null, sod_rooted_on: null });
    expect([FERTILIZER_HOLD_DAYS, TETRINO_HOLD_DAYS]).toEqual([30, 21]);
  });
  test('the swap bag is named exactly as the v13 protocol names it', () => {
    const protocol = fs.readFileSync(path.join(__dirname, '../config/lawn-protocol-v13.json'), 'utf8');
    expect(protocol.includes(SOD_SWAP_BAG.name)).toBe(true);
    // The 2027 October note states the same 2.5 lb / 0.60 lb N figures.
    expect(protocol.includes(`${SOD_SWAP_BAG.name} at ${SOD_SWAP_BAG.lbPer1000} lb per 1,000 sq ft (${SOD_SWAP_BAG.lbN.toFixed(2)} lb N)`)).toBe(true);
    expect(SOD_SWAP_BAG).toEqual({ name: 'LESCO 24-0-11 with PolyPlus OPTI', lbPer1000: 2.5, lbN: 0.6 });
  });
});

describe('validateSodLaidOn', () => {
  const today = '2026-10-09';
  test('accepts today, a past day and exactly 24 months ago', () => {
    for (const day of ['2026-10-09', '2026-01-15', '2024-10-09']) expect(validateSodLaidOn(day, today)).toEqual({ ok: true, value: day });
  });
  test('rejects tomorrow and a day past 24 months', () => {
    expect(validateSodLaidOn('2026-10-10', today)).toEqual({ ok: false, message: 'Sod date cannot be in the future.' });
    expect(validateSodLaidOn('2024-10-08', today)).toEqual({ ok: false, message: 'Sod date cannot be more than 24 months ago.' });
  });
  test('24 months back from Feb 29 lands on Feb 28', () => {
    expect(validateSodLaidOn('2026-02-28', '2028-02-29').ok).toBe(true);
    expect(validateSodLaidOn('2026-02-27', '2028-02-29').ok).toBe(false);
  });
  test('null, empty and blank clear; non-dates and impossible days are rejected; a bad today fails closed', () => {
    for (const blank of [null, undefined, '', '   ']) expect(validateSodLaidOn(blank, today)).toEqual({ ok: true, value: null });
    for (const bad of ['2026-02-30', '10/01/2026', 'soon', '2026-10-01T00:00:00Z']) expect(validateSodLaidOn(bad, today).ok).toBe(false);
    expect(validateSodLaidOn('2026-10-01', 'today').ok).toBe(false);
    expect(validateSodLaidOn('2026-10-01', undefined).ok).toBe(false);
  });
});

describe('preEmergentHoldUntil', () => {
  test.each([
    ['2026-01-15', '2026-10-01'],
    ['2026-05-15', '2026-10-01'],
    ['2026-05-31', '2026-10-01'],
    ['2026-06-01', '2027-10-01'],
    ['2026-08-15', '2027-10-01'],
    ['2026-11-15', '2027-10-01'],
    ['2026-12-31', '2027-10-01'],
    ['2024-02-29', '2024-10-01'],
  ])('sod laid %s holds pre-emergent until %s', (laid, until) => {
    expect(preEmergentHoldUntil(laid)).toBe(until);
  });
  test('an unreadable date is null', () => {
    for (const bad of [null, undefined, '', 'nope', '2026-02-30']) expect(preEmergentHoldUntil(bad)).toBeNull();
  });
});

describe('sodHolds: no result', () => {
  test('no sod date, a visit before the sod date, and bad input are null (never a throw)', () => {
    expect(sodHolds({ visitDate: '2026-10-01' })).toBeNull();
    expect(holds('2026-09-30')).toBeNull();
    for (const bad of [undefined, null, {}, 'sod', 42]) expect(sodHolds(bad)).toBeNull();
    expect(sodHolds({ sodLaidOn: 'nope', visitDate: '2026-10-01' })).toBeNull();
    expect(sodHolds({ sodLaidOn: '2026-02-30', visitDate: '2026-10-01' })).toBeNull();
    expect(sodHolds({ sodLaidOn: '2026-10-01' })).toBeNull();
    expect(sodHolds({ sodLaidOn: '2026-10-01', visitDate: {} })).toBeNull();
    expect(sodHolds({ get sodLaidOn() { throw new Error('boom'); }, visitDate: '2026-10-01' })).toBeNull();
  });
  test('the visit on the sod day is day 1', () => {
    expect(holds('2026-10-01')).toMatchObject({ day: 1, covers: 'whole', area: null, sodLaidOn: '2026-10-01' });
  });
});

describe('sodHolds: fertilizer and Dylox (30 days, whole lawn only)', () => {
  test('held through day 30, free on day 31', () => {
    const d30 = holds('2026-10-30');
    expect(d30.day).toBe(30);
    expect(d30.fertilizer).toEqual({ held: true, until: '2026-10-31', scope: 'whole' });
    expect(d30.dylox).toEqual({ held: true, until: '2026-10-31', scope: 'whole' });
    const d31 = holds('2026-10-31');
    expect(d31.day).toBe(31);
    expect(d31.fertilizer).toEqual({ held: false, until: null, scope: 'whole' });
    expect(d31.dylox).toEqual({ held: false, until: null, scope: 'whole' });
  });
  test('never held when only part of the lawn is sod', () => {
    const part = holds('2026-10-05', { sodCovers: 'part', sodArea: 'back lawn' });
    expect(part.fertilizer).toEqual({ held: false, until: null, scope: 'whole' });
    expect(part.dylox).toEqual({ held: false, until: null, scope: 'whole' });
  });
  test('leap day and year end count real calendar days', () => {
    const leap = (visitDate) => sodHolds({ sodLaidOn: '2024-02-29', visitDate });
    expect(leap('2024-03-29').fertilizer.held).toBe(true);
    expect(leap('2024-03-29').day).toBe(30);
    expect(leap('2024-03-30').fertilizer.held).toBe(false);
    const yearEnd = (visitDate) => sodHolds({ sodLaidOn: '2026-12-15', visitDate });
    expect(yearEnd('2027-01-13').fertilizer).toEqual({ held: true, until: '2027-01-14', scope: 'whole' });
    expect(yearEnd('2027-01-14').fertilizer.held).toBe(false);
  });
});

describe('sodHolds: tetrino (21 days)', () => {
  test('held through day 21, free on day 22; area scope for a part lawn', () => {
    expect(holds('2026-10-21').tetrino).toEqual({ held: true, until: '2026-10-22', scope: 'whole' });
    expect(holds('2026-10-22').tetrino).toEqual({ held: false, until: '2026-10-22', scope: 'whole' });
    expect(holds('2026-10-10', { sodCovers: 'part', sodArea: 'back lawn' }).tetrino).toEqual({ held: true, until: '2026-10-22', scope: 'area' });
  });
});

describe('sodHolds: weed killer and Gravex (30 days and the rooted check)', () => {
  test('day 30 is held by the window whether or not rooted is ticked', () => {
    expect(holds('2026-10-30').weedKiller).toEqual({ held: true, until: '2026-10-31', needsRootedCheck: false, scope: 'whole' });
    expect(holds('2026-10-30', { sodRootedOn: '2026-10-25' }).weedKiller.held).toBe(true);
  });
  test('day 31 with no rooted tick stays held and asks for the check', () => {
    expect(holds('2026-10-31').weedKiller).toEqual({ held: true, until: null, needsRootedCheck: true, scope: 'whole' });
    expect(holds('2026-12-01').weedKiller.needsRootedCheck).toBe(true);
  });
  test('day 31 with a rooted tick on or before the visit is released', () => {
    expect(holds('2026-10-31', { sodRootedOn: '2026-10-25' }).weedKiller).toEqual({ held: false, until: null, needsRootedCheck: false, scope: 'whole' });
    expect(holds('2026-11-09', { sodRootedOn: '2026-11-09' }).weedKiller.held).toBe(false);
  });
  test('a rooted tick dated after the visit, or before the sod went down, does not count', () => {
    expect(holds('2026-11-09', { sodRootedOn: '2026-11-12' }).weedKiller).toMatchObject({ held: true, needsRootedCheck: true });
    expect(holds('2026-11-09', { sodRootedOn: '2026-09-01' }).weedKiller).toMatchObject({ held: true, needsRootedCheck: true });
    expect(holds('2026-11-09', { sodRootedOn: 'nope' }).weedKiller).toMatchObject({ held: true, needsRootedCheck: true });
  });
  test('part lawn is an area hold, the line stays on', () => {
    expect(holds('2026-10-05', { sodCovers: 'part', sodArea: 'back lawn' }).weedKiller.scope).toBe('area');
  });
  test('Gravex follows the weed killer exactly', () => {
    for (const [visit, extra] of [['2026-10-05', {}], ['2026-10-30', {}], ['2026-10-31', {}], ['2026-10-31', { sodRootedOn: '2026-10-25' }], ['2026-10-31', { sodCovers: 'part', sodArea: 'x' }]]) {
      const result = holds(visit, extra);
      expect(result.fungicideGravex).toEqual(result.weedKiller);
    }
  });
});

describe('sodHolds: pre-emergent (one full summer)', () => {
  test('sod laid before June is held to Oct 1 of the same year', () => {
    const laid = (visitDate) => sodHolds({ sodLaidOn: '2026-05-31', visitDate });
    expect(laid('2026-09-30').preEmergent).toEqual({ held: true, until: '2026-10-01', scope: 'whole' });
    expect(laid('2026-10-01').preEmergent).toEqual({ held: false, until: '2026-10-01', scope: 'whole' });
  });
  test('sod laid June 1 or later is held to Oct 1 of the next year', () => {
    const laid = (visitDate) => sodHolds({ sodLaidOn: '2026-06-01', visitDate });
    expect(laid('2027-09-30').preEmergent.held).toBe(true);
    expect(laid('2027-10-01').preEmergent.held).toBe(false);
  });
  test('part lawn is an area hold', () => {
    expect(holds('2026-12-01', { sodCovers: 'part', sodArea: 'back lawn' }).preEmergent).toEqual({ held: true, until: '2027-10-01', scope: 'area' });
  });
});

describe('sodHolds: large patch watch', () => {
  const watch = (laid, grass, visitDate = laid) => sodHolds({ sodLaidOn: laid, visitDate, grass }).largePatchWatch;
  test('St. Augustine and zoysia sod laid Oct 1 - Mar 31 is watched until the Mar 31 that ends that season', () => {
    expect(watch('2026-10-01', 'st_augustine')).toEqual({ on: true, until: '2027-03-31' });
    expect(watch('2026-10-01', 'zoysia')).toEqual({ on: true, until: '2027-03-31' });
    expect(watch('2027-03-31', 'st_augustine')).toEqual({ on: true, until: '2027-03-31' });
    expect(watch('2027-01-10', 'zoysia')).toEqual({ on: true, until: '2027-03-31' });
    expect(watch('2026-12-31', 'zoysia')).toEqual({ on: true, until: '2027-03-31' });
  });
  test('sod laid Apr 1 or Sep 30 is not watched', () => {
    expect(watch('2027-04-01', 'st_augustine')).toEqual({ on: false, until: null });
    expect(watch('2026-09-30', 'st_augustine')).toEqual({ on: false, until: null });
  });
  test('bermuda, bahia and an unknown grass are never watched', () => {
    for (const grass of ['bermuda', 'bahia', 'centipede', '', null, undefined, 7]) expect(watch('2026-10-01', grass)).toEqual({ on: false, until: null });
  });
  test('the watch ends after the season', () => {
    expect(watch('2026-10-01', 'st_augustine', '2027-03-31').on).toBe(true);
    expect(watch('2026-10-01', 'st_augustine', '2027-04-01')).toEqual({ on: false, until: '2027-03-31' });
  });
  test('a grass label is read loosely', () => {
    expect(watch('2026-10-01', 'St. Augustine').on).toBe(true);
    expect(watch('2026-10-01', ' ZOYSIA ').on).toBe(true);
  });
});

describe('sodHolds: swap bag and active', () => {
  test('swap the pre-emergent bag only for a whole lawn with the fertilizer hold over', () => {
    expect(holds('2026-10-10').swapPreEmergentBag).toBe(false); // fertilizer still held
    expect(holds('2026-10-31').swapPreEmergentBag).toBe(true);
    expect(holds('2026-12-15').swapPreEmergentBag).toBe(true);
    expect(holds('2027-10-01').swapPreEmergentBag).toBe(false); // pre-emergent allowed again
    expect(holds('2026-12-15', { sodCovers: 'part', sodArea: 'back lawn' }).swapPreEmergentBag).toBe(false);
  });
  test('active while any hold or watch is on, false once the sod record has no further effect', () => {
    expect(holds('2026-10-05').active).toBe(true);
    // Rooted, past every window, bermuda (no watch): nothing left.
    const done = sodHolds({ sodLaidOn: '2025-01-15', sodRootedOn: '2025-03-01', visitDate: '2026-10-02', grass: 'bermuda' });
    expect(done.active).toBe(false);
    // Same home, St. Augustine sod laid in winter: the watch is over by the next autumn.
    expect(sodHolds({ sodLaidOn: '2025-01-15', sodRootedOn: '2025-03-01', visitDate: '2026-10-02', grass: 'st_augustine' }).active).toBe(false);
    // Not rooted: the weed killer hold keeps the record active.
    expect(sodHolds({ sodLaidOn: '2025-01-15', visitDate: '2026-10-02', grass: 'bermuda' }).active).toBe(true);
  });
  test('an unknown covers value is read as the whole lawn', () => {
    expect(holds('2026-10-05', { sodCovers: 'half' })).toMatchObject({ covers: 'whole', fertilizer: { held: true } });
  });
  test('a part lawn reports its trimmed area; a whole lawn drops it', () => {
    expect(holds('2026-10-05', { sodCovers: 'part', sodArea: '  back lawn ' })).toMatchObject({ covers: 'part', area: 'back lawn' });
    expect(holds('2026-10-05', { sodCovers: 'whole', sodArea: 'back lawn' }).area).toBeNull();
  });
  test('a pg date value and a stored ISO string read as the same calendar day', () => {
    const fromDate = sodHolds({ sodLaidOn: new Date('2026-10-01T00:00:00.000Z'), visitDate: '2026-10-05' });
    expect(fromDate.sodLaidOn).toBe('2026-10-01');
    expect(sodHolds({ sodLaidOn: '2026-10-01T00:00:00.000Z', visitDate: '2026-10-05' }).day).toBe(5);
  });
});

describe('resolveSodRecord: the stored row merged with a write', () => {
  const row = { sod_laid_on: '2026-09-01', sod_covers: 'part', sod_area: 'front yard', sod_rooted_on: '2026-10-05' };
  test('a first date defaults to whole with no area and no rooted day', () => {
    expect(resolveSodRecord(null, { sod_laid_on: '2026-10-01' })).toEqual({ ok: true, columns: { sod_laid_on: '2026-10-01', sod_covers: 'whole', sod_area: null, sod_rooted_on: null } });
  });
  test('clearing the date clears the rest', () => {
    expect(resolveSodRecord(row, { sod_laid_on: null })).toEqual({ ok: true, columns: clearedNewSodColumns() });
  });
  test('a different date clears the rooted day; the same date and a pg Date value keep it', () => {
    expect(resolveSodRecord(row, { sod_laid_on: '2026-09-02' }).columns).toMatchObject({ sod_laid_on: '2026-09-02', sod_covers: 'part', sod_area: 'front yard', sod_rooted_on: null });
    expect(resolveSodRecord(row, { sod_laid_on: '2026-09-01' }).columns.sod_rooted_on).toBe('2026-10-05');
    const pgRow = { ...row, sod_laid_on: new Date('2026-09-01T00:00:00.000Z'), sod_rooted_on: new Date('2026-10-05T00:00:00.000Z') };
    expect(resolveSodRecord(pgRow, { sod_laid_on: '2026-09-01' }).columns).toMatchObject({ sod_laid_on: '2026-09-01', sod_rooted_on: '2026-10-05' });
  });
  test('part needs an area; whole drops it; a long area is refused', () => {
    expect(resolveSodRecord(null, { sod_laid_on: '2026-10-01', sod_covers: 'part' })).toMatchObject({ ok: false, field: 'sodArea' });
    expect(resolveSodRecord(null, { sod_laid_on: '2026-10-01', sod_covers: 'part', sod_area: '   ' })).toMatchObject({ ok: false, field: 'sodArea' });
    expect(resolveSodRecord(row, { sod_covers: 'whole' }).columns).toMatchObject({ sod_covers: 'whole', sod_area: null });
    expect(resolveSodRecord(row, { sod_area: 'x'.repeat(121) })).toMatchObject({ ok: false, field: 'sodArea' });
  });
  test('covers or area with no date at all are refused', () => {
    expect(resolveSodRecord(null, { sod_covers: 'part', sod_area: 'x' })).toMatchObject({ ok: false, field: 'sodLaidOn' });
    expect(resolveSodRecord(null, { sod_covers: null })).toEqual({ ok: true, columns: clearedNewSodColumns() });
  });
  test('the rooted day is never taken from the input', () => {
    expect(resolveSodRecord(null, { sod_laid_on: '2026-10-01', sod_rooted_on: '2026-10-20' }).columns.sod_rooted_on).toBeNull();
  });
});
