import { describe, expect, it } from 'vitest';
import { pestSheetTipIds, pestsInNote, pickableTipIds, rotatedTipGroups, unsentTipsFirst } from './tech-tips';

const tip = (id, extra = {}) => ({ id, label: id, copy: 'Advice.', keywords: [], ...extra });
const LIBRARY = {
  groups: [{ id: 'moisture', tips: [tip('drains', { pests: ['Roaches'] }), tip('drip', { pests: ['Ants'] }), tip('mats', { pests: ['Roaches', 'Earwigs'], keywords: ['mats'] }), tip('fan', { keywords: ['bath fan'] })] }],
  more: [tip('flea_yard', { pests: ['Fleas'] }), tip('bait_spots', { keywords: ['bait'] })],
};

describe('pestsInNote', () => {
  it('names the chips a note speaks of, by whole word', () => {
    expect(pestsInNote('Treated for ants and a few palmetto bugs. Knocked down wasp nests.')).toEqual(['Ants', 'Roaches', 'Wasps']);
    expect(pestsInNote('Plants trimmed back, wanted a quote.')).toEqual([]);
  });
  it('does not name a pest the note rules out', () => {
    expect(pestsInNote('No roaches seen. No signs of ants. Spiders on the lanai.')).toEqual(['Spiders']);
    expect(pestsInNote('Not seeing any fleas, without live wasps.')).toEqual([]);
    expect(pestsInNote('No ants, roaches, or spiders were seen.')).toEqual([]);
    expect(pestsInNote('No ants, roaches, or spiders, but earwigs under the mat.')).toEqual(['Earwigs']);
    expect(pestsInNote('No German roaches. No ants or roaches inside; without any evidence of fleas.')).toEqual([]);
    expect(pestsInNote('No roaches inside but ants at the back door.')).toEqual(['Ants']);
  });
});

describe('unsentTipsFirst', () => {
  it('moves tips the customer had lately behind the rest, keeping order', () => {
    const tips = [tip('a'), tip('b'), tip('c')];
    expect(unsentTipsFirst(tips, { a: '2026-09-01' }).map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(unsentTipsFirst(tips, null)).toBe(tips);
  });
});

describe('the admin picker helpers', () => {
  it('a searched off-list tip is a pick the picker keeps', () => {
    expect([...pickableTipIds(LIBRARY)].sort()).toEqual(['bait_spots', 'drains', 'drip', 'fan', 'flea_yard', 'mats']);
    expect(pickableTipIds(null).size).toBe(0);
  });
  it('puts tips sent lately last in each group, except on a lawn visit', () => {
    const sent = { ...LIBRARY, lastSent: { drains: '2026-09-20' } };
    expect(rotatedTipGroups(sent)[0].tips.map((t) => t.id)).toEqual(['drip', 'mats', 'fan', 'drains']);
    expect(rotatedTipGroups({ ...sent, line: 'lawn' })[0].tips.map((t) => t.id)).toEqual(['drains', 'drip', 'mats', 'fan']);
  });
});

describe('pestSheetTipIds', () => {
  it('lifts advice for the tapped pests, the most pests first, from the whole library', () => {
    expect(pestSheetTipIds(LIBRARY, { pests: ['Roaches', 'Earwigs'] })).toEqual(['mats', 'drains']);
    expect(pestSheetTipIds(LIBRARY, { pests: ['Fleas'] })).toEqual(['flea_yard']);
  });
  it('reads the pests from the note, then the visit tips the note calls for', () => {
    expect(pestSheetTipIds(LIBRARY, { note: 'Ants at the door. Told her to run the bath fan.' })).toEqual(['drip', 'fan']);
  });
  it('never lifts an off-list tip by a note keyword alone', () => {
    expect(pestSheetTipIds(LIBRARY, { note: 'Placed bait in the kitchen.' })).toEqual([]);
  });
  it('puts tips sent lately last and keeps the list short', () => {
    expect(pestSheetTipIds({ ...LIBRARY, lastSent: { mats: '2026-09-20' } }, { pests: ['Roaches', 'Earwigs'] })).toEqual(['drains', 'mats']);
    const many = { groups: [{ tips: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => tip(id, { pests: ['Ants'] })) }] };
    expect(pestSheetTipIds(many, { pests: ['Ants'] })).toHaveLength(4);
  });
  it('leaves a tip for the other season to search', () => {
    const library = { season: 'dry', groups: [{ tips: [tip('sweets', { pests: ['Wasps'], season: 'wet' }), tip('nest', { pests: ['Wasps'], season: 'all' })] }] };
    expect(pestSheetTipIds(library, { pests: ['Wasps'] })).toEqual(['nest']);
  });
  it('holds the keyword lift to the same rules: nothing ruled out, nothing out of season', () => {
    const library = { season: 'dry', groups: [{ tips: [tip('bowls', { keywords: ['ants'] }), tip('auto', { keywords: ['humidity'], season: 'wet' }), tip('fan', { keywords: ['humidity'] })] }] };
    expect(pestSheetTipIds(library, { note: 'No ants seen. Humidity is high inside.' })).toEqual(['fan']);
  });
  it('answers nothing before the library loads', () => {
    expect(pestSheetTipIds(null, { pests: ['Ants'] })).toEqual([]);
  });
});
