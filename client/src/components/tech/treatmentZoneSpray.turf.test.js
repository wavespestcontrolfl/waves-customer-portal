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

describe('growTurfRegion (connectivity — codex P1 #3075)', () => {
  // 6x3 grid: blob A (cols 0-1) has a confident-green seed with an adjacent
  // tan pixel; blob B (cols 4-5) is all-tan pavers, separated by a non-turf
  // gap (cols 2-3). B must be dropped even though A has plenty of grass.
  const W = 6;
  const H = 3;
  const idx = (x, y) => y * W + x;
  const eligible = new Uint8Array(W * H);
  const confident = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    for (const x of [0, 1]) eligible[idx(x, y)] = 1; // blob A
    for (const x of [4, 5]) eligible[idx(x, y)] = 1; // blob B (tan island)
  }
  confident[idx(0, 1)] = 1; // one green seed in blob A

  test('tan connected to green stays; detached tan island is dropped', () => {
    const kept = growTurfRegion(eligible, confident, W, H);
    for (let y = 0; y < H; y += 1) {
      expect(kept[idx(0, y)]).toBe(1);
      expect(kept[idx(1, y)]).toBe(1);
      expect(kept[idx(4, y)]).toBe(0);
      expect(kept[idx(5, y)]).toBe(0);
      expect(kept[idx(2, y)]).toBe(0);
      expect(kept[idx(3, y)]).toBe(0);
    }
  });

  test('no seeds → nothing kept', () => {
    const kept = growTurfRegion(eligible, new Uint8Array(W * H), W, H);
    expect(kept.every((v) => v === 0)).toBe(true);
  });
});
