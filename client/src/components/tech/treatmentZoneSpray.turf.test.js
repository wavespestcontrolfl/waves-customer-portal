// Pins the lawn-highlight turf classifier (codex P1 #3075: saturated
// non-turf surfaces — terracotta/barrel-tile roofs, mulch, stained
// hardscape — must never be painted as treated lawn on a customer report).
import { describe, expect, test } from 'vitest';
import { growTurfRegion, isConfidentTurfPixel, isTurfPixel, lawnMaskPasses } from './treatmentZoneSpray';

describe('isTurfPixel (lawn highlight classifier)', () => {
  const TURF = [
    ['healthy green grass', 80, 140, 60],
    ['browning turf', 170, 150, 110],
    ['dry tan turf', 160, 140, 100],
    ['dark tree canopy (vegetation on the lawn)', 50, 80, 45],
  ];
  const NOT_TURF = [
    ['terracotta roof', 150, 60, 40],
    ['barrel tile', 180, 90, 60],
    ['brown roof (codex example)', 140, 90, 60],
    ['mulch bed', 110, 80, 55],
    ['gray shingle roof', 150, 150, 148],
    ['asphalt', 120, 122, 125],
    ['pool water', 80, 150, 180],
    ['white lanai / bright concrete', 230, 230, 225],
  ];

  test.each(TURF)('lights %s', (_name, r, g, b) => {
    expect(isTurfPixel(r, g, b)).toBe(true);
  });

  test.each(NOT_TURF)('rejects %s', (_name, r, g, b) => {
    expect(isTurfPixel(r, g, b)).toBe(false);
  });
});

describe('isConfidentTurfPixel (highlight confidence)', () => {
  test('green grass is confident', () => {
    expect(isConfidentTurfPixel(80, 140, 60)).toBe(true);
    expect(isConfidentTurfPixel(50, 80, 45)).toBe(true);
  });

  test('dry-tan turf/pavers are turf-eligible but NEVER confident (codex P1 #3075 — g must exceed r)', () => {
    expect(isTurfPixel(160, 140, 100)).toBe(true);
    expect(isConfidentTurfPixel(160, 140, 100)).toBe(false);
    expect(isConfidentTurfPixel(190, 170, 140)).toBe(false); // beige paver
  });
});

describe('lawnMaskPasses (paver-dominated areas fall back to the outline)', () => {
  test('beige-paver-dominated lit area fails the gate', () => {
    // e.g. a patio/deck-heavy trace: plenty lit, but only 15% confident green
    expect(lawnMaskPasses({ insideCount: 10000, litCount: 6000, confidentCount: 900 })).toBe(false);
  });

  test('green-dominated lawn passes', () => {
    expect(lawnMaskPasses({ insideCount: 10000, litCount: 6000, confidentCount: 3000 })).toBe(true);
  });

  test('near-empty masks fail the coverage floor', () => {
    expect(lawnMaskPasses({ insideCount: 10000, litCount: 50, confidentCount: 50 })).toBe(false);
    expect(lawnMaskPasses({ insideCount: 0, litCount: 0, confidentCount: 0 })).toBe(false);
  });
});

describe('growTurfRegion (connectivity + color continuity — codex P1 #3075)', () => {
  const GREEN = [80, 140, 60];
  const BROWNING = [110, 130, 85]; // gentle step from green (Δsum = 65 ≤ 72)
  const PAVER = [190, 170, 140]; // sharp step from any turf tone
  const GRAY = [150, 150, 148];
  const grid = (W, H, cells) => {
    // cells: (x,y) => [r,g,b, eligible, confident]
    const eligible = new Uint8Array(W * H);
    const confident = new Uint8Array(W * H);
    const colors = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = y * W + x;
        const [r, g, b, e, c] = cells(x, y);
        colors[i * 4] = r;
        colors[i * 4 + 1] = g;
        colors[i * 4 + 2] = b;
        eligible[i] = e;
        confident[i] = c;
      }
    }
    return { eligible, confident, colors };
  };
  const idx = (W) => (x, y) => y * W + x;

  test('tan connected to green stays; detached tan island is dropped', () => {
    // cols 0-1 green blob (seed at 0,1); cols 2-3 gray gap; cols 4-5 pavers
    const W = 6; const H = 3; const at = idx(W);
    const { eligible, confident, colors } = grid(W, H, (x, y) => {
      if (x <= 1) return [...GREEN, 1, x === 0 && y === 1 ? 1 : 0];
      if (x >= 4) return [...PAVER, 1, 0];
      return [...GRAY, 0, 0];
    });
    const kept = growTurfRegion(eligible, confident, W, H, colors);
    for (let y = 0; y < H; y += 1) {
      expect(kept[at(0, y)]).toBe(1);
      expect(kept[at(1, y)]).toBe(1);
      expect(kept[at(4, y)]).toBe(0);
      expect(kept[at(5, y)]).toBe(0);
    }
  });

  test('paver region DIRECTLY ADJOINING green turf is blocked by the color edge', () => {
    // cols 0-2 green (seed 0,0), cols 3-5 pavers touching the grass — the
    // sharp color step stops propagation at the boundary.
    const W = 6; const H = 2; const at = idx(W);
    const { eligible, confident, colors } = grid(W, H, (x, y) => {
      if (x <= 2) return [...GREEN, 1, x === 0 && y === 0 ? 1 : 0];
      return [...PAVER, 1, 0];
    });
    const kept = growTurfRegion(eligible, confident, W, H, colors);
    for (let y = 0; y < H; y += 1) {
      expect(kept[at(2, y)]).toBe(1);
      expect(kept[at(3, y)]).toBe(0);
      expect(kept[at(4, y)]).toBe(0);
    }
  });

  test('gradual browning gradient inside the lawn still propagates', () => {
    // green seed → browning neighbor (smooth step) both kept
    const W = 2; const H = 1; const at = idx(W);
    const { eligible, confident, colors } = grid(W, H, (x) => (
      x === 0 ? [...GREEN, 1, 1] : [...BROWNING, 1, 0]
    ));
    const kept = growTurfRegion(eligible, confident, W, H, colors);
    expect(kept[at(0, 0)]).toBe(1);
    expect(kept[at(1, 0)]).toBe(1);
  });

  test('no seeds → nothing kept', () => {
    const W = 4; const H = 2;
    const { eligible, colors } = grid(W, H, () => [...PAVER, 1, 0]);
    const kept = growTurfRegion(eligible, new Uint8Array(W * H), W, H, colors);
    expect(kept.every((v) => v === 0)).toBe(true);
  });
});
