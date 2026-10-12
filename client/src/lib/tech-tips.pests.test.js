import { describe, expect, it } from 'vitest';
import { pickableTipIds, rotatedTipGroups, unsentTipsFirst } from './tech-tips';

const tip = (id, extra = {}) => ({ id, label: id, copy: 'Advice.', keywords: [], ...extra });
const LIBRARY = {
  groups: [{ id: 'moisture', tips: [tip('drains', { pests: ['Roaches'] }), tip('drip', { pests: ['Ants'] }), tip('mats', { pests: ['Roaches', 'Earwigs'], keywords: ['mats'] }), tip('fan', { keywords: ['bath fan'] })] }],
  more: [tip('flea_yard', { pests: ['Fleas'] }), tip('bait_spots', { keywords: ['bait'] })],
};

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
