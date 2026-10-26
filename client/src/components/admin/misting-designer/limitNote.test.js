import { describe, expect, it } from 'vitest';
import { limitNote, riserLimitNote, zoneWarnings } from './MistingLayoutParts.jsx';

const limits = { minNozzles: 10, maxNozzles: 80 };

describe('limitNote', () => {
  it('flags a count below the minimum as invalid, not as billed at the included count', () => {
    const note = limitNote(6, limits);
    expect(note).toMatch(/at least 10 nozzles/);
    expect(note).toMatch(/manual review/);
    expect(note).not.toMatch(/billed at the included count/);
  });
  it('flags a count above the maximum', () => {
    expect(limitNote(81, limits)).toMatch(/up to 80 nozzles/);
  });
  it('says nothing inside the range or for an empty layout', () => {
    expect(limitNote(30, limits)).toBeNull();
    expect(limitNote(0, limits)).toBeNull();
  });
});

describe('riserLimitNote', () => {
  it('flags a count above the maximum and is quiet otherwise', () => {
    expect(riserLimitNote(9, { maxRisers: 8 })).toMatch(/up to 8 risers/);
    expect(riserLimitNote(8, { maxRisers: 8 })).toBeNull();
    expect(riserLimitNote(3, {})).toBeNull();
  });
});

describe('zoneWarnings', () => {
  const flags = (n, r) => ({ nozzleKeys: new Set(Array.from({ length: n }, (_, i) => `n${i}`)), riserKeys: new Set(Array.from({ length: r }, (_, i) => `r${i}`)) });
  it('says in words how many nozzles and risers are inside a no-mist zone', () => {
    expect(zoneWarnings(flags(3, 0))).toEqual(['3 nozzles inside a no-mist zone: aim away or remove']);
    expect(zoneWarnings(flags(1, 2))).toEqual([
      '1 nozzle inside a no-mist zone: aim away or remove',
      '2 risers inside a no-mist zone: move or remove',
    ]);
    expect(zoneWarnings(flags(0, 0))).toEqual([]);
  });
});
