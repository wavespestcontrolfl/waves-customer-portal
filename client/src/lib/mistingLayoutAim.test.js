import { describe, expect, it } from 'vitest';
import { pxToFeet } from '../components/tech/treatmentZoneSpray';
import {
  NEAR_WATER_THROW_FT,
  THROW_FT,
  AIM_ARROW_MIN_PX,
  AIM_ARROW_PX,
  aimArrowLength,
  aimReachPx,
  aimVector,
  defaultAim,
  effectiveAim,
  headingFromVector,
  normalizeAim,
} from './mistingLayoutAim';

const LAT = 26.95;
const ZOOM = 20;
const map = { lat: LAT, zoom: ZOOM };
const FT = 1 / pxToFeet(1, LAT, ZOOM); // pixels in one foot

// A closed square house, 300 px a side, drawn clockwise from its top-left corner.
const SQUARE = [{
  id: 'L1',
  kind: 'eave',
  points: [{ x: 400, y: 300 }, { x: 700, y: 300 }, { x: 700, y: 600 }, { x: 400, y: 600 }, { x: 400, y: 300 }],
}];
const onLine = (x, y, lineIndex = 0) => ({ x, y, kind: 'eave', lineIndex });

describe('normalizeAim', () => {
  it('wraps any angle into [0, 360) and rounds to 0.01 degree', () => {
    expect(normalizeAim(0)).toBe(0);
    expect(normalizeAim(360)).toBe(0);
    expect(normalizeAim(-90)).toBe(270);
    expect(normalizeAim(725)).toBe(5);
    expect(normalizeAim(359.999)).toBe(0);
    expect(normalizeAim(12.3456)).toBe(12.35);
    expect(normalizeAim('90')).toBe(90);
  });

  it('is null for anything that is not a finite number', () => {
    [undefined, null, '', 'north', NaN, Infinity].forEach((v) => expect(normalizeAim(v)).toBeNull());
  });
});

describe('aimVector and headingFromVector', () => {
  it('uses compass headings on a y-down map: 0 up, 90 right, 180 down, 270 left', () => {
    const near = (v, x, y) => { expect(v.x).toBeCloseTo(x, 9); expect(v.y).toBeCloseTo(y, 9); };
    near(aimVector(0), 0, -1);
    near(aimVector(90), 1, 0);
    near(aimVector(180), 0, 1);
    near(aimVector(270), -1, 0);
  });

  it('round trips, and gives null for a zero vector', () => {
    [0, 33, 90, 181.5, 270, 359.5].forEach((h) => {
      const v = aimVector(h);
      expect(headingFromVector(v.x, v.y)).toBeCloseTo(h, 1);
    });
    expect(headingFromVector(0, 0)).toBeNull();
  });
});

describe('defaultAim', () => {
  it('aims out from the house on every side of a square', () => {
    expect(defaultAim(onLine(550, 300), SQUARE, [], map)).toMatchObject({ heading: 0, nearWater: false, throwFt: THROW_FT });
    expect(defaultAim(onLine(700, 450), SQUARE, [], map).heading).toBeCloseTo(90, 5);
    expect(defaultAim(onLine(550, 600), SQUARE, [], map).heading).toBeCloseTo(180, 5);
    expect(defaultAim(onLine(400, 450), SQUARE, [], map).heading).toBeCloseTo(270, 5);
  });

  it('does not depend on the way the line was drawn', () => {
    const reversed = [{ ...SQUARE[0], points: [...SQUARE[0].points].reverse() }];
    expect(defaultAim(onLine(550, 300), reversed, [], map).heading).toBeCloseTo(0, 5);
    expect(defaultAim(onLine(700, 450), reversed, [], map).heading).toBeCloseTo(90, 5);
  });

  it('aims a fence nozzle away from the house too', () => {
    const lines = [...SQUARE, { id: 'F', kind: 'fence', points: [{ x: 200, y: 800 }, { x: 900, y: 800 }] }];
    expect(defaultAim({ x: 550, y: 800, kind: 'fence', lineIndex: 1 }, lines, [], map).heading).toBeCloseTo(180, 5);
  });

  it('uses the map center when there is no eave line', () => {
    const fenceOnly = [{ id: 'F', kind: 'fence', points: [{ x: 100, y: 100 }, { x: 300, y: 100 }] }];
    // The center (640, 480) is below and to the right of the fence, so it faces up.
    expect(defaultAim({ x: 200, y: 100, kind: 'fence', lineIndex: 0 }, fenceOnly, [], map).heading).toBeCloseTo(0, 5);
  });

  it('aims straight away from the house when a nozzle has no line', () => {
    expect(defaultAim({ x: 900, y: 450 }, SQUARE, [], map).heading).toBeCloseTo(90, 5);
    expect(defaultAim({ x: 550, y: 450 }, [], [], map).heading).toBeGreaterThanOrEqual(0);
  });

  describe('near water', () => {
    const pool = { kind: 'pool', x: 550, y: 200, radiusFt: 15 };

    it('aims along the line, away from the water, at half throw, within 30 ft of its edge', () => {
      // Right of the pool's center: along the line to the right. Left of it: to the left.
      expect(defaultAim(onLine(600, 300), SQUARE, [pool], map)).toMatchObject({ nearWater: true, throwFt: NEAR_WATER_THROW_FT });
      expect(defaultAim(onLine(600, 300), SQUARE, [pool], map).heading).toBeCloseTo(90, 5);
      expect(defaultAim(onLine(500, 300), SQUARE, [pool], map).heading).toBeCloseTo(270, 5);
    });

    it('treats a water zone like a pool, and ignores other kinds', () => {
      expect(defaultAim(onLine(600, 300), SQUARE, [{ ...pool, kind: 'water' }], map).nearWater).toBe(true);
      expect(defaultAim(onLine(600, 300), SQUARE, [{ ...pool, kind: 'door', radiusFt: 8 }], map)).toMatchObject({ nearWater: false, heading: 0 });
    });

    it('measures from the zone edge: just inside 30 ft is near, just outside is not', () => {
      const at = (edgeFt) => ({ kind: 'pool', x: 600, y: 300 - (15 + edgeFt) * FT, radiusFt: 15 });
      expect(defaultAim(onLine(600, 300), SQUARE, [at(29.5)], map).nearWater).toBe(true);
      expect(defaultAim(onLine(600, 300), SQUARE, [at(30.5)], map).nearWater).toBe(false);
    });

    it('points away from the NEAREST water when there are two', () => {
      const right = { kind: 'water', x: 700, y: 250, radiusFt: 15 };
      // Closer to the left pool, so it runs right, away from it; the far water does not decide.
      expect(defaultAim(onLine(520, 300), SQUARE, [pool, right], map).heading).toBeCloseTo(270, 5);
      expect(defaultAim(onLine(690, 300), SQUARE, [pool, right], map).heading).toBeCloseTo(270, 5);
    });
  });
});

describe('effectiveAim', () => {
  const water = [{ kind: 'pool', x: 550, y: 200, radiusFt: 15 }];

  it('uses the default heading for a nozzle with no manual aim', () => {
    expect(effectiveAim(onLine(550, 300), SQUARE, [], map)).toMatchObject({ heading: 0, manual: false, nearWater: false, throwFt: THROW_FT });
  });

  it('lets a saved manual aim win, wrapped into range, 0 included', () => {
    expect(effectiveAim({ ...onLine(550, 300), aim: 135 }, SQUARE, [], map)).toMatchObject({ heading: 135, manual: true });
    expect(effectiveAim({ ...onLine(550, 300), aim: 0 }, SQUARE, [], map)).toMatchObject({ heading: 0, manual: true });
    expect(effectiveAim({ ...onLine(550, 300), aim: -45 }, SQUARE, [], map).heading).toBe(315);
  });

  it('keeps the near-water mark and the half throw when staff set the heading', () => {
    expect(effectiveAim({ ...onLine(600, 300), aim: 200 }, SQUARE, water, map)).toMatchObject({
      heading: 200, manual: true, nearWater: true, throwFt: NEAR_WATER_THROW_FT,
    });
  });

  it('ignores a junk aim', () => {
    expect(effectiveAim({ ...onLine(550, 300), aim: 'x' }, SQUARE, [], map)).toMatchObject({ heading: 0, manual: false });
  });
});

describe('aimReachPx', () => {
  it('is the throw in map pixels', () => {
    expect(aimReachPx({ throwFt: 10 }, LAT, ZOOM)).toBeCloseTo(10 * FT, 9);
    expect(aimReachPx({ throwFt: 5 }, LAT, ZOOM)).toBeCloseTo(5 * FT, 9);
  });
});

describe('aimArrowLength', () => {
  const at = (x, y) => ({ x, y });
  const me = at(300, 300);

  it('is the full length with nothing ahead, and ignores itself, a neighbour beside it, one behind it and a coincident one', () => {
    expect(aimArrowLength(me, 90, [me])).toBe(AIM_ARROW_PX);
    expect(aimArrowLength(me, 90, [me, at(300, 344)])).toBe(AIM_ARROW_PX); // beside (aim is along x)
    expect(aimArrowLength(me, 90, [me, at(256, 300)])).toBe(AIM_ARROW_PX); // behind
    expect(aimArrowLength(me, 90, [me, at(300, 300)])).toBe(AIM_ARROW_PX); // on top of it
    expect(aimArrowLength(me, 90, null)).toBe(AIM_ARROW_PX);
  });

  it('stops halfway to a nozzle ahead, never below the minimum and never above the full length', () => {
    expect(aimArrowLength(me, 90, [me, at(344, 300)])).toBe(AIM_ARROW_MIN_PX); // 44 px ahead: half is 22, too short
    expect(aimArrowLength(me, 90, [me, at(370, 300)])).toBe(35); // 70 px ahead
    expect(aimArrowLength(me, 90, [me, at(500, 300)])).toBe(AIM_ARROW_PX); // far ahead: half is 100
    expect(aimArrowLength(me, 90, [me, at(331, 326)])).toBe(AIM_ARROW_MIN_PX); // 40 degrees off is still ahead
    expect(aimArrowLength(me, 90, [me, at(320, 345)])).toBe(AIM_ARROW_PX); // 66 degrees off is not
  });

  it('follows the nearest nozzle ahead', () => {
    expect(aimArrowLength(me, 90, [me, at(500, 300), at(370, 300), at(420, 300)])).toBe(35);
  });
});
