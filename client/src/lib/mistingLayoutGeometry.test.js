import { describe, expect, it } from 'vitest';
import { pxToFeet } from '../components/tech/treatmentZoneSpray';
import {
  MIN_SPACING_FT,
  NOMINAL_SPACING_FT,
  applyNozzleEdits,
  nearestNozzleIndex,
  nearestPointOnLines,
  placeNozzles,
  polylineFeet,
} from './mistingLayoutGeometry';

const LAT = 26.95;
const ZOOM = 20;
const FT = 1 / pxToFeet(1, LAT, ZOOM); // pixels in one foot
const feet = (n) => n * FT;
const opts = { lat: LAT, zoom: ZOOM };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ftBetween = (a, b) => pxToFeet(dist(a, b), LAT, ZOOM);

function line(kind, pointsFt, id) {
  return { id, kind, points: pointsFt.map(([x, y]) => ({ x: 100 + feet(x), y: 100 + feet(y) })) };
}

describe('placeNozzles', () => {
  it('needs lat and zoom to convert pixels to feet', () => {
    expect(() => placeNozzles([], {})).toThrow(/latitude and zoom/);
  });

  it('returns nothing for no lines, a lone point, or junk points', () => {
    expect(placeNozzles([], opts).totals.count).toBe(0);
    const one = placeNozzles([line('eave', [[0, 0]], 'a')], opts);
    expect(one.nozzles).toHaveLength(1); // a single tap still marks a corner
    expect(one.totals.linearFt).toBe(0);
    const junk = placeNozzles([{ kind: 'eave', points: [{ x: NaN, y: 1 }, null, { x: 5 }] }], opts);
    expect(junk.nozzles).toHaveLength(0);
  });

  it('puts corners at both ends and even interior nozzles on a straight 35 ft line', () => {
    const r = placeNozzles([line('eave', [[0, 0], [35, 0]], 'a')], opts);
    // 35 ft / 10 ft spacing -> 4 gaps of 8.75 ft -> 3 interior + 2 corners
    expect(r.nozzles).toHaveLength(5);
    expect(r.totals.eaveCount).toBe(5);
    expect(r.totals.fenceCount).toBe(0);
    expect(r.totals.linearFt).toBeCloseTo(35, 1);
    const xs = r.nozzles.map((n) => n.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    for (let i = 1; i < r.nozzles.length; i += 1) {
      const gap = ftBetween(r.nozzles[i - 1], r.nozzles[i]);
      expect(gap).toBeLessThanOrEqual(NOMINAL_SPACING_FT + 1e-6);
      expect(gap).toBeCloseTo(8.75, 1);
    }
    expect(r.nozzles[0].corner).toBe(true);
    expect(r.nozzles[1].corner).toBe(false);
    expect(r.nozzles.every((n) => n.segmentIndex === 0)).toBe(true);
  });

  it('never exceeds the spacing on lengths around the boundary', () => {
    [9.9, 10, 10.1, 20, 29.99, 30.01, 100].forEach((len) => {
      const r = placeNozzles([line('fence', [[0, 0], [len, 0]], 'f')], opts);
      for (let i = 1; i < r.nozzles.length; i += 1) {
        expect(ftBetween(r.nozzles[i - 1], r.nozzles[i])).toBeLessThanOrEqual(NOMINAL_SPACING_FT + 1e-6);
      }
      // exactly ceil(len / 10) + 1 nozzles, no extra
      expect(r.nozzles).toHaveLength(Math.max(1, Math.ceil(len / 10 - 1e-9)) + 1);
    });
  });

  it('honors a custom spacing', () => {
    const r = placeNozzles([line('eave', [[0, 0], [30, 0]], 'a')], { ...opts, spacingFt: 5 });
    expect(r.nozzles).toHaveLength(7);
  });

  it('puts one nozzle on every corner of an L shape and spaces each leg', () => {
    const r = placeNozzles([line('eave', [[0, 0], [25, 0], [25, 12]], 'L')], opts);
    // leg 1: 25 ft -> 3 gaps -> 2 interior; leg 2: 12 ft -> 2 gaps -> 1 interior; 3 corners
    expect(r.nozzles).toHaveLength(6);
    const corners = r.nozzles.filter((n) => n.corner);
    expect(corners.map((n) => n.vertexIndex)).toEqual([0, 1, 2]);
    expect(corners[1].x).toBeCloseTo(100 + feet(25), 5);
    expect(corners[1].y).toBeCloseTo(100, 5);
    expect(r.totals.linearFt).toBeCloseTo(37, 1);
    // segment index: interior of leg 2 belongs to segment 1, last corner closes segment 1
    expect(r.nozzles.filter((n) => n.segmentIndex === 1).length).toBe(3);
    expect(r.nozzles.find((n) => n.vertexIndex === 2).segmentIndex).toBe(1);
  });

  it('counts a closed loop once at the repeated first and last vertex', () => {
    const square = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
    const r = placeNozzles([line('eave', square, 'sq')], opts);
    // 4 corners (closing vertex merged into the first) + 1 interior per 20 ft side
    expect(r.nozzles).toHaveLength(8);
    expect(r.lines[0].closed).toBe(true);
    expect(r.totals.linearFt).toBeCloseTo(80, 1);
    expect(r.nozzles.filter((n) => n.corner)).toHaveLength(4);
    const first = r.nozzles.find((n) => n.vertexIndex === 0);
    expect(first.x).toBeCloseTo(100, 5);
    for (let i = 0; i < r.nozzles.length; i += 1) {
      for (let j = i + 1; j < r.nozzles.length; j += 1) {
        expect(ftBetween(r.nozzles[i], r.nozzles[j])).toBeGreaterThanOrEqual(MIN_SPACING_FT - 1e-6);
      }
    }
  });

  it('does not call an open line closed', () => {
    const r = placeNozzles([line('eave', [[0, 0], [20, 0], [20, 20], [0, 20]], 'u')], opts);
    expect(r.lines[0].closed).toBe(false);
    expect(r.nozzles.filter((n) => n.corner)).toHaveLength(4);
  });

  it('merges the vertices of a very short segment', () => {
    // 2 ft hop between two corners: closer than the 3 ft minimum, so one nozzle
    const r = placeNozzles([line('eave', [[0, 0], [2, 0], [30, 0]], 'sh')], opts);
    const corners = r.nozzles.filter((n) => n.corner);
    expect(corners.map((n) => n.vertexIndex)).toEqual([0, 2]);
    for (let i = 1; i < r.nozzles.length; i += 1) {
      expect(ftBetween(r.nozzles[i - 1], r.nozzles[i])).toBeGreaterThanOrEqual(MIN_SPACING_FT - 1e-6);
    }
    // the short segment still counts toward linear feet
    expect(r.totals.linearFt).toBeCloseTo(30, 1);
  });

  it('treats a double tap as one vertex', () => {
    const r = placeNozzles([line('eave', [[0, 0], [0.05, 0], [8, 0]], 'dbl')], opts);
    expect(r.nozzles).toHaveLength(2);
    expect(r.nozzles.filter((n) => n.corner).map((n) => n.vertexIndex)).toEqual([0, 1]);
  });

  it('merges nozzles where two lines touch and keeps the totals per kind', () => {
    const eave = line('eave', [[0, 0], [30, 0]], 'e');
    const fence = line('fence', [[30, 0], [30, 30]], 'f'); // shares the (30, 0) corner
    const r = placeNozzles([eave, fence], opts);
    // eave: 2 corners + 2 interior = 4; fence: 2 corners (one merged away) + 2 interior = 3
    expect(r.totals.eaveCount).toBe(4);
    expect(r.totals.fenceCount).toBe(3);
    expect(r.totals.count).toBe(7);
    expect(r.totals.eaveFt).toBeCloseTo(30, 1);
    expect(r.totals.fenceFt).toBeCloseTo(30, 1);
    expect(r.totals.linearFt).toBeCloseTo(60, 1);
    // the shared corner belongs to the first line drawn
    const shared = r.nozzles.filter((n) => Math.abs(n.x - (100 + feet(30))) < 1 && Math.abs(n.y - 100) < 1);
    expect(shared).toHaveLength(1);
    expect(shared[0].kind).toBe('eave');
    expect(r.lines.map((l) => l.nozzleCount)).toEqual([4, 3]);
  });

  it('drops an interior nozzle that lands within the minimum of another line', () => {
    // a fence line crosses within 1 ft of where the eave line's midpoint nozzle goes
    const eave = line('eave', [[0, 0], [20, 0]], 'e'); // interior nozzle at 10 ft
    const fence = line('fence', [[10, 1], [10, 40]], 'f'); // corner 1 ft off it
    const r = placeNozzles([eave, fence], opts);
    expect(r.totals.eaveCount).toBe(2); // the eave midpoint is dropped
    for (let i = 0; i < r.nozzles.length; i += 1) {
      for (let j = i + 1; j < r.nozzles.length; j += 1) {
        expect(ftBetween(r.nozzles[i], r.nozzles[j])).toBeGreaterThanOrEqual(MIN_SPACING_FT - 1e-6);
      }
    }
  });

  it('gives each nozzle a stable key', () => {
    const a = placeNozzles([line('eave', [[0, 0], [25, 0]], 'a')], opts);
    const b = placeNozzles([line('eave', [[0, 0], [25, 0], [25, 12]], 'a')], opts);
    expect(a.nozzles.map((n) => n.key)).toEqual(['a:v0', 'a:s0:1', 'a:s0:2', 'a:v1']);
    // appending a point leaves every earlier key in place
    const keysB = b.nozzles.map((n) => n.key);
    a.nozzles.forEach((n) => expect(keysB).toContain(n.key));
  });
});

describe('polylineFeet', () => {
  it('measures a cleaned polyline in feet', () => {
    expect(polylineFeet(line('eave', [[0, 0], [10, 0], [10, 5]]).points, LAT, ZOOM)).toBeCloseTo(15, 1);
    expect(polylineFeet([], LAT, ZOOM)).toBe(0);
  });
});

describe('applyNozzleEdits', () => {
  const base = placeNozzles([line('eave', [[0, 0], [30, 0]], 'a')], opts).nozzles;

  it('removes, moves and adds nozzles', () => {
    const out = applyNozzleEdits(base, {
      removed: ['a:s0:1'],
      moved: { 'a:v1': { x: 5, y: 6 } },
      added: [{ key: 'm1', x: 7, y: 8, kind: 'fence', lineIndex: 0, lineId: 'a', segmentIndex: 0, corner: false }],
    });
    expect(out.find((n) => n.key === 'a:s0:1')).toBeUndefined();
    expect(out.find((n) => n.key === 'a:v1')).toMatchObject({ x: 5, y: 6, edited: true });
    expect(out.find((n) => n.key === 'm1')).toMatchObject({ x: 7, y: 8, kind: 'fence' });
    expect(out).toHaveLength(base.length);
  });

  it('ignores edits for keys that no longer exist and keeps the input untouched', () => {
    const out = applyNozzleEdits(base, { removed: ['gone'], moved: { gone: { x: 1, y: 1 } } });
    expect(out).toHaveLength(base.length);
    expect(base.find((n) => n.key === 'a:v1').edited).toBeUndefined();
  });

  it('works with no edits', () => {
    expect(applyNozzleEdits(base)).toEqual(base);
    expect(applyNozzleEdits(null)).toEqual([]);
  });
});

describe('hit testing', () => {
  const lines = [line('eave', [[0, 0], [20, 0]], 'a'), line('fence', [[0, 10], [20, 10]], 'b')];

  it('finds the closest point on a line within the threshold', () => {
    const hit = nearestPointOnLines(lines, { x: 100 + feet(5), y: 100 + feet(1) }, feet(2));
    expect(hit).toMatchObject({ lineId: 'a', segmentIndex: 0, kind: 'eave' });
    expect(hit.x).toBeCloseTo(100 + feet(5), 5);
    expect(hit.y).toBeCloseTo(100, 5);
  });

  it('clamps to the segment end and misses beyond the threshold', () => {
    const end = nearestPointOnLines(lines, { x: 100 + feet(22), y: 100 }, feet(3));
    expect(end.x).toBeCloseTo(100 + feet(20), 5);
    expect(nearestPointOnLines(lines, { x: 100 + feet(5), y: 100 + feet(5) }, feet(1))).toBeNull();
    expect(nearestPointOnLines([], { x: 0, y: 0 }, 50)).toBeNull();
  });

  it('finds the nearest nozzle', () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 0 }];
    expect(nearestNozzleIndex(pts, { x: 48, y: 1 }, 10)).toBe(1);
    expect(nearestNozzleIndex(pts, { x: 200, y: 0 }, 10)).toBe(-1);
  });
});
