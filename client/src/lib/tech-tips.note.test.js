import { describe, expect, it } from 'vitest';
import { tipsCalledForByNote } from './tech-tips';

const tip = (id, keywords) => ({ id, label: id, copy: 'Water the lawn in the morning.', keywords });
const TIPS = [
  tip('water', ['water', 'morning']),
  tip('chinch', ['chinch', 'chinch bugs', 'driveway', 'hot']),
  tip('thatch', ['thatch', 'spongy']),
];

describe('tipsCalledForByNote', () => {
  it('lifts the tips whose keywords the note names, most matches first, by whole word or phrase', () => {
    expect(tipsCalledForByNote(TIPS, 'There are chinch bugs along the hot driveway edge.')).toEqual(['chinch']);
    expect(tipsCalledForByNote(TIPS, 'Spongy thatch and chinch bugs.')).toEqual(['chinch', 'thatch']);
  });
  it('matches keywords only, never the customer copy, and never a word fragment', () => {
    expect(tipsCalledForByNote(TIPS, 'Watered in the fertilizer.')).toEqual([]); // "watered" is not "water"
    expect(tipsCalledForByNote(TIPS, 'Applied this morning.')).toEqual(['water']); // a keyword
    expect(tipsCalledForByNote(TIPS, 'lawn in the morning')).toEqual(['water']);
    expect(tipsCalledForByNote(TIPS, 'Hotspot near the shed.')).toEqual([]);
  });
  it('an empty or tiny note lifts nothing', () => {
    expect(tipsCalledForByNote(TIPS, '')).toEqual([]);
    expect(tipsCalledForByNote(TIPS, 'ok')).toEqual([]);
  });
});
