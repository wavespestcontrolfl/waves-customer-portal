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

// Every badge that moved sits fully inside the photo (a badge that did not move keeps its place, as on the old page).
const insidePhoto = (out, size) => out.filter((p) => p.moved).every((p) => p.x * size >= PIN / 2 - 1e-6 && p.x * size <= size - PIN / 2 + 1e-6
  && p.y * size >= PIN / 2 - 1e-6 && p.y * size <= size - PIN / 2 + 1e-6);

// The clear distance from a called-out point's dot to the centre of any badge: half a badge, half the 8 px dot, 5 px of roof.
const DOT_CLEAR = PIN / 2 + 4 + 5;
// How many times a called-out line (true point to badge) runs under a badge that is not its own: 13 px of badge and
// 3 px of clear roof.
const linesUnderBadges = (out, size) => {
  const toLine = (q, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.min(1, Math.max(0, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
  };
  const px = out.map((p) => ({ badge: { x: p.x * size, y: p.y * size }, from: { x: p.fromX * size, y: p.fromY * size }, callout: p.callout }));
  let count = 0;
  px.forEach((line, i) => {
    if (!line.callout) return;
    count += px.filter((other, j) => j !== i && toLine(other.badge, line.from, line.badge) < PIN / 2 + 3 - 0.06).length;
  });
  return count;
};
// How many pairs of called-out lines cross each other.
const linesCrossing = (out) => {
  const side = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const lines = out.filter((p) => p.callout).map((p) => [{ x: p.fromX, y: p.fromY }, { x: p.x, y: p.y }]);
  let count = 0;
  lines.forEach(([a, b], i) => lines.slice(i + 1).forEach(([c, d]) => {
    if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) count += 1;
  }));
  return count;
};
// Every called-out dot is clear of every badge, its own included, so the customer can see it.
const dotsVisible = (out, size) => out.filter((p) => p.callout).every((dot) => out.every((badge) => (
  Math.hypot((badge.x - dot.fromX) * size, (badge.y - dot.fromY) * size) >= DOT_CLEAR - 0.05)));

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

  it('nudges two badges that only touch: each moves a few px, stays on its point, and gets no dot or line', () => {
    const out = spreadPins([{ x: 0.4, y: 0.5 }, { x: 0.4 + 20 / 294, y: 0.5 }], 294);
    expect(dist(out[0], out[1], 294)).toBeGreaterThanOrEqual(MIN - 0.05);
    expect(out[0].y).toBeCloseTo(0.5, 6);
    expect(out[0].shiftPx).toBeCloseTo(4, 1);
    expect(out[1].shiftPx).toBeCloseTo(4, 1);
    expect(out.map((p) => [p.moved, p.callout])).toEqual([[true, false], [true, false]]);
  });

  it('calls out two points 10 px apart: each badge moves off its point to the far side, and both dots stay visible', () => {
    const out = spreadPins([{ x: 0.4, y: 0.5 }, { x: 0.4 + 10 / 294, y: 0.5 }], 294);
    expect(out.map((p) => p.callout)).toEqual([true, true]);
    // A badge that moved 9 px used to cover its own dot. Now each sits a full clear distance from its own point.
    expect(out[0].shiftPx).toBeCloseTo(DOT_CLEAR, 1);
    expect(out[1].shiftPx).toBeCloseTo(DOT_CLEAR, 1);
    expect(out[0].x).toBeLessThan(out[0].fromX);
    expect(out[1].x).toBeGreaterThan(out[1].fromX);
    expect(out[0].y).toBeCloseTo(0.5, 6);
    expect(dotsVisible(out, 294)).toBe(true);
    expect(dist(out[0], out[1], 294)).toBeGreaterThanOrEqual(MIN - 0.05);
  });

  it('keeps every dot visible in a tight group of four, and in the stress group of ten', () => {
    const four = [[0.5, 0.5], [0.52, 0.5], [0.5, 0.53], [0.53, 0.53]].map(([x, y]) => ({ x, y }));
    const ten = [[0.50, 0.50], [0.51, 0.50], [0.50, 0.51], [0.52, 0.52], [0.505, 0.49], [0.53, 0.50], [0.49, 0.53], [0.55, 0.55], [0.48, 0.48], [0.51, 0.545]].map(([x, y]) => ({ x, y }));
    for (const pins of [four, ten]) {
      for (const size of [294, 480]) {
        const out = spreadPins(pins, size);
        expect(out.every((p) => p.callout)).toBe(true);
        expect(dotsVisible(out, size)).toBe(true);
        expect(linesUnderBadges(out, size)).toBe(0);
        expect(linesCrossing(out)).toBe(0);
        expect(minPairGap(out, size)).toBeGreaterThanOrEqual(MIN - 0.05);
        expect(insidePhoto(out, size)).toBe(true);
      }
    }
  });

  it('runs no line under another badge: six points in 10 px at the photo edge fan out on one arc', () => {
    // Placed one by one at the nearest free spot, the first badges walled the points in and the line of badge 6 ran
    // under badge 3: the customer read it as the place of point 3.
    const out = spreadPins([0, 2, 4, 6, 8, 10].map((x) => ({ x: x / 294, y: 0.5 })), 294);
    expect(out.every((p) => p.callout)).toBe(true);
    expect(linesUnderBadges(out, 294)).toBe(0);
    expect(linesCrossing(out)).toBe(0);
    expect(dotsVisible(out, 294)).toBe(true);
    expect(minPairGap(out, 294)).toBeGreaterThanOrEqual(MIN - 0.05);
    expect(insidePhoto(out, 294)).toBe(true);
  });

  it('puts 20 points on one spot on one ring: every line is clear, and all 20 are the same distance from the spot', () => {
    const out = spreadPins(Array.from({ length: 20 }, () => ({ x: 0.5, y: 0.5 })), 294);
    expect(linesUnderBadges(out, 294)).toBe(0);
    expect(dotsVisible(out, 294)).toBe(true);
    expect(minPairGap(out, 294)).toBeGreaterThanOrEqual(MIN - 0.05);
    const shifts = out.map((p) => p.shiftPx);
    expect(Math.max(...shifts) - Math.min(...shifts)).toBeLessThan(0.01);
  });

  it('keeps a group clear of a badge that does not move: the ring uses the free arc and no line runs under that badge', () => {
    // Two points 10 px apart, and a third 34 px to the right of them: not crowded, so it stays where it is.
    const out = spreadPins([{ x: 0.4, y: 0.5 }, { x: 0.4 + 10 / 294, y: 0.5 }, { x: 0.4 + 44 / 294, y: 0.5 }], 294);
    expect(out.map((p) => p.callout)).toEqual([true, true, false]);
    expect(out[2].moved).toBe(false);
    expect(linesUnderBadges(out, 294)).toBe(0);
    expect(dotsVisible(out, 294)).toBe(true);
    expect(minPairGap(out, 294)).toBeGreaterThanOrEqual(MIN - 0.05);
  });

  it('never moves a point that is not crowded, also one that hangs over the photo edge, while others are called out', () => {
    const out = spreadPins([{ x: 0.3, y: 0.3 }, { x: 0.31, y: 0.3 }, { x: 1, y: 0 }, { x: 0.31 + 30 / 294, y: 0.3 }], 294);
    expect(out[0].callout && out[1].callout).toBe(true);
    expect([out[2].x, out[2].y, out[2].moved]).toEqual([1, 0, false]);
    // 30 px from the nearest point: not crowded, so it stays, and the called-out badges keep clear of it.
    expect([out[3].moved, out[3].callout]).toEqual([false, false]);
    expect(minPairGap(out.filter((_, i) => i !== 2), 294)).toBeGreaterThanOrEqual(MIN - 0.05);
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

  it('spreads a row of pins that is longer than the photo: the row cannot fit on its own line', () => {
    // 12 pins in one line need 11 gaps of 28 px = 308 px, and a 294 px photo has 268 px between its edge positions.
    const row = Array.from({ length: 12 }, (_, i) => ({ x: 0.12 + 0.035 * i, y: 0.5 }));
    for (const size of [294, 480]) {
      const out = spreadPins(row, size);
      expect(minPairGap(out, size)).toBeGreaterThanOrEqual(MIN - 0.05);
      expect(insidePhoto(out, size)).toBe(true);
      expect(dotsVisible(out, size)).toBe(true);
    }
    const edge = Array.from({ length: 12 }, (_, i) => ({ x: 0.03 * i, y: 0 }));
    const out = spreadPins(edge, 294);
    expect(minPairGap(out, 294)).toBeGreaterThanOrEqual(MIN - 0.05);
    expect(insidePhoto(out, 294)).toBe(true);
    expect(dotsVisible(out, 294)).toBe(true);
  });

  it('for 400 generated layouts of 2 to 20 pins (lines, clusters and scattered): no two badges overlap, every dot is visible, and a point that is not crowded stays', () => {
    // A fixed sequence (no Math.random): the same layouts on every run.
    let seed = 20261121;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const shapes = [
      () => ({ x: 0.5 + (next() - 0.5) * 0.1, y: 0.5 + (next() - 0.5) * 0.1 }),
      () => ({ x: next(), y: 0.3 }),
      () => ({ x: 0.97, y: next() }),
      () => ({ x: next(), y: next() }),
    ];
    for (let layout = 0; layout < 400; layout += 1) {
      const count = 2 + Math.floor(next() * 19);
      const shape = shapes[layout % shapes.length];
      const pins = Array.from({ length: count }, shape);
      const size = layout % 2 ? 294 : 480;
      const out = spreadPins(pins, size);
      const crowded = pins.map((p, i) => pins.some((q, j) => j !== i && dist(p, q, size) < MIN));
      expect(out.every((p, i) => crowded[i] || !p.moved)).toBe(true);
      if (crowded.some(Boolean)) {
        expect(minPairGap(out, size)).toBeGreaterThanOrEqual(MIN - 0.05);
        expect(insidePhoto(out, size)).toBe(true);
        expect(dotsVisible(out, size)).toBe(true);
        // A badge is either still on its point (no dot) or called out: never moved far with no dot.
        expect(out.every((p) => p.callout || p.shiftPx <= 6 + 1e-6)).toBe(true);
        // Tight clusters (the first shape) always get a clean ring: no line under a badge and no two lines crossed.
        // Long rows of 10 to 20 points are not held to that.
        if (layout % shapes.length === 0) {
          expect(linesUnderBadges(out, size)).toBe(0);
          expect(linesCrossing(out)).toBe(0);
        }
      }
    }
  });
});
