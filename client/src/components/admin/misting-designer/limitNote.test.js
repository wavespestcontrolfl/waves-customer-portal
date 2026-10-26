import { describe, expect, it } from 'vitest';
import { limitNote } from './MistingLayoutParts.jsx';

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
