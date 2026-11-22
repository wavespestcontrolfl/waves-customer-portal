// Spreading roof point badges that overlap on a phone-sized photo (owner "zoom" follow-up, 2026-11-21).
import { describe, expect, it } from 'vitest';
import { spreadPins } from './roofPinSpread';

const PIN = 26;
const MIN = PIN + 2;
const dist = (a, b, size) => Math.hypot((a.x - b.x) * size, (a.y - b.y) * size);

function minPairGap(out, size) {
  let min = Infinity;
  for (let i = 0; i < out.length; i += 1) {
    for (let j = i + 1; j < out.length; j += 1) min = Math.min(min, dist(out[i], out[j], size));
  }
  return min;
}

const insidePhoto = (out, size) => out.every((p) => p.x * size >= PIN / 2 - 1e-9 && p.x * size <= size - PIN / 2 + 1e-9
  && p.y * size >= PIN / 2 - 1e-9 && p.y * size <= size - PIN / 2 + 1e-9);

describe('spreadPins', () => {
  it('returns the true positions exactly when no two badges are closer than a badge plus the gap', () => {
    const pins = [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.95, y: 0.9 }];
    const out = spreadPins(pins, 294);
    expect(out.map((p) => [p.x, p.y])).toEqual([[0.1, 0.1], [0.5, 0.5], [0.95, 0.9]]);
    expect(out.every((p) => p.moved === false && p.shiftPx === 0)).toBe(true);
  });

  it('keeps an edge pin where it is when nothing overlaps, even if it hangs over the edge', () => {
    const out = spreadPins([{ x: 1, y: 0 }, { x: 0.4, y: 0.6 }], 294);
    expect([out[0].x, out[0].y]).toEqual([1, 0]);
    expect(out[0].moved).toBe(false);
  });

  it('treats a missing, zero or non-finite size as unknown and leaves positions alone', () => {
    const pins = [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }];
    for (const size of [undefined, null, 0, -5, NaN, Infinity, 'abc']) {
      const out = spreadPins(pins, size);
      expect(out.map((p) => [p.x, p.y, p.moved])).toEqual([[0.5, 0.5, false], [0.5, 0.5, false]]);
    }
  });

  it('pushes two pins on the same spot apart by at least the badge plus the gap', () => {
    const out = spreadPins([{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }], 294);
    expect(dist(out[0], out[1], 294)).toBeGreaterThanOrEqual(MIN - 0.05);
    expect(out.every((p) => p.moved)).toBe(true);
    expect(out[0].fromX).toBe(0.5);
    expect(insidePhoto(out, 294)).toBe(true);
  });

  it('pushes a close pair apart along the line between them and moves each about half the shortfall', () => {
    const out = spreadPins([{ x: 0.4, y: 0.5 }, { x: 0.4 + 10 / 294, y: 0.5 }], 294);
    expect(dist(out[0], out[1], 294)).toBeGreaterThanOrEqual(MIN - 0.05);
    expect(out[0].y).toBeCloseTo(0.5, 6);
    expect(out[0].shiftPx).toBeCloseTo(9, 1);
    expect(out[1].shiftPx).toBeCloseTo(9, 1);
  });

  it('moves only the pins that overlap and leaves a far pin where it was', () => {
    const out = spreadPins([{ x: 0.3, y: 0.3 }, { x: 0.3, y: 0.3 }, { x: 0.85, y: 0.85 }], 294);
    expect(out[2].moved).toBe(false);
    expect([out[2].x, out[2].y]).toEqual([0.85, 0.85]);
  });

  it('keeps 20 pins in one tight cluster at 294 px at least a badge plus gap apart and fully inside the photo', () => {
    const pins = Array.from({ length: 20 }, (_, i) => ({ x: 0.5 + (i % 5) * 0.002, y: 0.5 + Math.floor(i / 5) * 0.002 }));
    const out = spreadPins(pins, 294);
    expect(out).toHaveLength(20);
    expect(minPairGap(out, 294)).toBeGreaterThanOrEqual(MIN - 0.05);
    expect(insidePhoto(out, 294)).toBe(true);
  });

  it('keeps 20 pins on one exact spot, and 20 pins crowded into a corner, apart and inside the photo', () => {
    const same = Array.from({ length: 20 }, () => ({ x: 0.5, y: 0.5 }));
    const corner = Array.from({ length: 20 }, (_, i) => ({ x: 0.99 - (i % 4) * 0.003, y: 0.99 - Math.floor(i / 4) * 0.003 }));
    for (const pins of [same, corner]) {
      const out = spreadPins(pins, 294);
      expect(minPairGap(out, 294)).toBeGreaterThanOrEqual(MIN - 0.05);
      expect(insidePhoto(out, 294)).toBe(true);
    }
  });

  it('gives the same output for the same input', () => {
    const pins = Array.from({ length: 12 }, (_, i) => ({ x: 0.4 + (i % 3) * 0.01, y: 0.4 + (i % 4) * 0.01 }));
    expect(spreadPins(pins, 294)).toEqual(spreadPins(pins, 294));
  });

  it('honors a different badge width', () => {
    const out = spreadPins([{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }], 294, 40);
    expect(dist(out[0], out[1], 294)).toBeGreaterThanOrEqual(42 - 0.05);
  });

  it('returns an empty list for no pins and keeps out-of-range fractions inside 0 to 1', () => {
    expect(spreadPins([], 294)).toEqual([]);
    expect(spreadPins(undefined, 294)).toEqual([]);
    const [p] = spreadPins([{ x: 1.4, y: -0.2 }], 294);
    expect([p.x, p.y]).toEqual([1, 0]);
  });
});
