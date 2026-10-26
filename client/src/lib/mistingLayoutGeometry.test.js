import { describe, expect, it } from 'vitest';
import { pxToFeet } from '../components/tech/treatmentZoneSpray';
import {
  MIN_SPACING_FT,
  NOMINAL_SPACING_FT,
  applyNozzleEdits,
  hitNozzleIndex,
  nearestNozzleIndex,
  nozzleHitRadiusPx,
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

  it('splits a stretch at a nozzle of another line that crosses within the minimum spacing', () => {
    // a fence line starts 1 ft off where the eave line's midpoint nozzle would go
    const eave = line('eave', [[0, 0], [20, 0]], 'e'); // midpoint nozzle would be at 10 ft
    const fence = line('fence', [[10, 1], [10, 40]], 'f');
    const r = placeNozzles([eave, fence], opts);
    // the eave walks through the fence corner (10.05 ft each way), so each half needs a nozzle
    expect(r.lines[0].keys).toContain('f:v0');
    expect(r.totals.eaveCount).toBe(4);
    for (let i = 0; i < r.nozzles.length; i += 1) {
      for (let j = i + 1; j < r.nozzles.length; j += 1) {
        expect(ftBetween(r.nozzles[i], r.nozzles[j])).toBeGreaterThanOrEqual(MIN_SPACING_FT - 1e-6);
      }
    }
  });

  it('gives each nozzle a unique, repeatable key within one placement', () => {
    const lines = [line('eave', [[0, 0], [25, 0]], 'a')];
    const a = placeNozzles(lines, opts);
    expect(a.nozzles.map((n) => n.key)).toEqual(['a:v0', 'a:s0:1', 'a:s0:2', 'a:v1']);
    expect(placeNozzles(lines, opts).nozzles.map((n) => n.key)).toEqual(a.nozzles.map((n) => n.key));
  });
});

// Seeded generator so a failure reproduces.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertInvariants(lines, result, spacingFt = NOMINAL_SPACING_FT, minFt = MIN_SPACING_FT) {
  const byKey = new Map(result.nozzles.map((n) => [n.key, n]));
  expect(byKey.size).toBe(result.nozzles.length); // keys are unique
  // every pair of nozzles keeps the minimum spacing
  for (let i = 0; i < result.nozzles.length; i += 1) {
    for (let j = i + 1; j < result.nozzles.length; j += 1) {
      expect(ftBetween(result.nozzles[i], result.nozzles[j])).toBeGreaterThanOrEqual(minFt - 1e-6);
    }
  }
  // every consecutive gap along each line is within the spacing
  result.lines.forEach((l, li) => {
    l.keys.forEach((key) => expect(byKey.has(key)).toBe(true));
    for (let i = 1; i < l.keys.length; i += 1) {
      expect(ftBetween(byKey.get(l.keys[i - 1]), byKey.get(l.keys[i]))).toBeLessThanOrEqual(spacingFt + 1e-6);
    }
    expect(l.nozzleCount).toBe(result.nozzles.filter((n) => n.lineIndex === li).length);
  });
}

describe('placement invariants (seeded random lines)', () => {
  it('keeps every gap along a line within the spacing and every pair of nozzles at the minimum', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = mulberry32(seed);
      const span = [12, 30, 60][seed % 3]; // small areas force crossings and merges
      const lineCount = 1 + Math.floor(rand() * 4);
      const lines = [];
      for (let l = 0; l < lineCount; l += 1) {
        const n = 2 + Math.floor(rand() * 6);
        const pts = [];
        for (let i = 0; i < n; i += 1) pts.push([rand() * span, rand() * span]);
        if (rand() < 0.25) pts.push(pts[0]); // some closed loops
        if (rand() < 0.2 && lines.length) pts[0] = [lines[0].fx, lines[0].fy]; // some touch another line
        const built = line(rand() < 0.5 ? 'eave' : 'fence', pts, `l${l}`);
        built.fx = pts[pts.length - 1][0];
        built.fy = pts[pts.length - 1][1];
        lines.push(built);
      }
      const result = placeNozzles(lines, opts);
      try {
        assertInvariants(lines, result);
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      }
    }
  });

  it('holds for a custom spacing and minimum', () => {
    const rand = mulberry32(99);
    for (let r = 0; r < 100; r += 1) {
      const lines = [0, 1, 2].map((l) => line('eave', Array.from({ length: 4 }, () => [rand() * 40, rand() * 40]), `c${l}`));
      const result = placeNozzles(lines, { ...opts, spacingFt: 6, minSpacingFt: 2 });
      assertInvariants(lines, result, 6, 2);
    }
  });

  it('splits at a nozzle where lines cross mid-segment instead of dropping it', () => {
    // fence crosses the middle of a 20 ft eave run, 1 ft from the eave's midpoint nozzle
    const eave = line('eave', [[0, 0], [20, 0]], 'e');
    const fence = line('fence', [[10, 1], [10, 30]], 'f');
    const result = placeNozzles([eave, fence], opts);
    assertInvariants([eave, fence], result);
    // the fence corner at (10, 1) sits in the eave's path: the eave walks through it
    const eaveKeys = result.lines[0].keys;
    expect(eaveKeys).toContain('f:v0');
    expect(result.totals.eaveCount).toBe(4);
  });
});

// Arc length (ft) of a nozzle along its own line: walked length to the start of its segment plus the
// distance from that vertex. Valid for any nozzle that sits on the line itself.
function arcFt(linePoints, nozzle) {
  let walked = 0;
  for (let i = 0; i < nozzle.segmentIndex; i += 1) walked += ftBetween(linePoints[i], linePoints[i + 1]);
  return walked + ftBetween(linePoints[nozzle.segmentIndex], nozzle);
}

describe('corner clusters (short jogs get one nozzle)', () => {
  // A roofline stepping 4 ft out and 4 ft over, as at a garage or an entry.
  const stepped = [[0, 0], [30, 0], [30, 4], [34, 4], [34, 8], [38, 8], [38, 12], [70, 12]];

  it('drops corners within half the spacing along the line of the previous kept nozzle', () => {
    const ln = line('eave', stepped, 'st');
    const r = placeNozzles([ln], opts);
    assertInvariants([ln], r);
    const arcs = r.lines[0].keys.map((k) => arcFt(ln.points, r.nozzles.find((n) => n.key === k)));
    for (let i = 1; i < arcs.length; i += 1) {
      expect(arcs[i] - arcs[i - 1]).toBeGreaterThanOrEqual(NOMINAL_SPACING_FT / 2 - 1e-6);
      expect(arcs[i] - arcs[i - 1]).toBeLessThanOrEqual(NOMINAL_SPACING_FT + 1e-6);
    }
    // a nozzle on every corner (cornerMergeFt: 0) would put one on all 8; the 4 ft steps now share
    const corners = r.nozzles.filter((n) => n.corner);
    expect(corners.length).toBeLessThan(placeNozzles([ln], { ...opts, cornerMergeFt: 0 }).nozzles.filter((n) => n.corner).length);
    expect(corners[0].vertexIndex).toBe(0);
    expect(corners[corners.length - 1].vertexIndex).toBe(stepped.length - 1);
    // the nozzle count stays the length-driven one: nothing is lost from the line
    expect(r.totals.linearFt).toBeCloseTo(30 + 4 * 5 + 32, 1);
  });

  it('keeps the first and last point of an open line even when they sit 4 ft from a jog', () => {
    const ln = line('eave', [[0, 0], [3, 0], [3, 3], [20, 3], [24, 3], [24, 6]], 'e');
    const r = placeNozzles([ln], opts);
    assertInvariants([ln], r);
    expect(r.nozzles.find((n) => n.vertexIndex === 0)).toBeTruthy();
    expect(r.nozzles.find((n) => n.vertexIndex === 5)).toBeTruthy();
    // the corner 4 ft before the end is dropped, not kept beside the end nozzle
    expect(r.nozzles.find((n) => n.vertexIndex === 4)).toBeUndefined();
  });

  it('puts one nozzle where a closed loop has a 4 ft jog', () => {
    const loop = [[0, 0], [30, 0], [30, 4], [34, 4], [34, 0], [60, 0], [60, 40], [0, 40], [0, 0]];
    const ln = line('eave', loop, 'lp');
    const r = placeNozzles([ln], opts);
    assertInvariants([ln], r);
    expect(r.lines[0].closed).toBe(true);
    // the notch (30..34, 0..4) has four corners; they now share two nozzles 8 ft apart along the line
    const inNotch = (res) => res.nozzles.filter((n) => {
      const x = (n.x - 100) / FT;
      const y = (n.y - 100) / FT;
      return x >= 29 && x <= 35 && y >= -1 && y <= 5;
    });
    expect(inNotch(placeNozzles([ln], { ...opts, cornerMergeFt: 0 }))).toHaveLength(4);
    const kept = inNotch(r);
    expect(kept).toHaveLength(2);
    expect(arcFt(ln.points, kept[1]) - arcFt(ln.points, kept[0])).toBeGreaterThanOrEqual(NOMINAL_SPACING_FT / 2 - 1e-6);
    expect(r.nozzles.find((n) => n.vertexIndex === 0)).toBeTruthy();
  });

  it('keeps every gap along the line within the spacing and none under half of it on random stepped lines', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = mulberry32(seed);
      const pts = [[0, 0]];
      const steps = 3 + Math.floor(rand() * 14);
      for (let i = 0; i < steps; i += 1) {
        const [x, y] = pts[pts.length - 1];
        const len = 2 + rand() * 12; // jogs and runs; monotone in x and y so the line never crosses itself
        if (rand() < 0.15) pts.push([x + len * 0.7, y + len * 0.7]);
        else pts.push(i % 2 === 0 ? [x + len, y] : [x, y + len]);
      }
      const ln = line('eave', pts, 's');
      const r = placeNozzles([ln], opts);
      try {
        assertInvariants([ln], r);
        const arcs = r.lines[0].keys.map((k) => arcFt(ln.points, r.nozzles.find((n) => n.key === k)));
        const total = r.lines[0].lengthFt;
        for (let i = 1; i < arcs.length; i += 1) {
          expect(arcs[i] - arcs[i - 1]).toBeLessThanOrEqual(NOMINAL_SPACING_FT + 1e-6);
          // the only gap allowed under 5 ft is a whole line shorter than that
          if (total >= NOMINAL_SPACING_FT / 2) {
            expect(arcs[i] - arcs[i - 1]).toBeGreaterThanOrEqual(NOMINAL_SPACING_FT / 2 - 1e-6);
          }
        }
        expect(arcs[0]).toBeCloseTo(0, 5);
        expect(arcs[arcs.length - 1]).toBeCloseTo(total, 4);
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      }
    }
  });

  it('keeps the invariants on jagged lines that double back (corners are kept where a clean fill is impossible)', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const rand = mulberry32(seed + 5000);
      const lines = [0, 1].map((l) => {
        const pts = [[rand() * 14, rand() * 14]];
        const steps = 4 + Math.floor(rand() * 10);
        for (let i = 0; i < steps; i += 1) {
          const [x, y] = pts[pts.length - 1];
          const a = rand() * Math.PI * 2;
          const len = 1 + rand() * 8;
          pts.push([x + Math.cos(a) * len, y + Math.sin(a) * len]);
        }
        if (rand() < 0.3) pts.push(pts[0]);
        return line(l ? 'fence' : 'eave', pts, `j${l}`);
      });
      const result = placeNozzles(lines, opts);
      try {
        assertInvariants(lines, result);
      } catch (err) {
        err.message = `seed ${seed}: ${err.message}`;
        throw err;
      }
    }
  });
});

describe('polylineFeet', () => {
  it('measures a cleaned polyline in feet', () => {
    expect(polylineFeet(line('eave', [[0, 0], [10, 0], [10, 5]]).points, LAT, ZOOM)).toBeCloseTo(15, 1);
    expect(polylineFeet([], LAT, ZOOM)).toBe(0);
  });
});

describe('applyNozzleEdits', () => {
  it('lists the most recently moved and added nozzles last, so a tap on overlapping ones takes them first', () => {
    const base = [{ key: 'a', x: 0, y: 0 }, { key: 'b', x: 1, y: 0 }, { key: 'c', x: 2, y: 0 }];
    const out = applyNozzleEdits(base, {
      moved: { a: { x: 9, y: 9 }, c: { x: 8, y: 8 } },
      added: [{ key: 'm1', x: 5, y: 5 }],
    });
    expect(out.map((n) => n.key)).toEqual(['b', 'a', 'c', 'm1']);
  });

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

  it('keeps a manual aim with its nozzle, moved or not, and leaves every other nozzle without one', () => {
    const out = applyNozzleEdits(base, {
      moved: { 'a:v1': { x: 5, y: 6 } },
      aimed: { 'a:v1': 135, 'a:v0': 0, 'a:s0:1': 'north', gone: 90 },
      added: [{ key: 'm1', x: 7, y: 8, kind: 'eave', aim: 270 }],
    });
    expect(out.find((n) => n.key === 'a:v1')).toMatchObject({ x: 5, y: 6, aim: 135 });
    expect(out.find((n) => n.key === 'a:v0').aim).toBe(0); // 0 degrees is an aim, not "no aim"
    expect(out.find((n) => n.key === 'a:s0:1')).not.toHaveProperty('aim');
    expect(out.find((n) => n.key === 'm1').aim).toBe(270);
    expect(out.find((n) => n.key === 'gone')).toBeUndefined();
    expect(base.find((n) => n.key === 'a:v1')).not.toHaveProperty('aim');
  });

  it('drops the aim of a removed nozzle with the nozzle', () => {
    const out = applyNozzleEdits(base, { removed: ['a:v1'], aimed: { 'a:v1': 90 } });
    expect(out.find((n) => n.key === 'a:v1')).toBeUndefined();
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

describe('nozzle hit radius', () => {
  it('shrinks with the on-screen nozzle gap and stays within 4..10 CSS px', () => {
    const cssPx = (zoom, cssScale) => nozzleHitRadiusPx(LAT, zoom, cssScale) / cssScale;
    expect(cssPx(20, 1)).toBe(10); // roomy: capped
    expect(cssPx(19, 2)).toBeLessThan(10);
    expect(cssPx(19, 4)).toBe(4); // tiny map: floor
    expect(cssPx(19, 2)).toBeGreaterThanOrEqual(4);
  });

  it('selects the nearest nozzle within the radius, and none beyond it', () => {
    const pts = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 80, y: 0 }];
    expect(hitNozzleIndex(pts, { x: 0, y: 0 }, 12)).toBe(0);
    expect(hitNozzleIndex(pts, { x: 17, y: 0 }, 12)).toBe(-1); // between nozzles, outside the radius
    expect(hitNozzleIndex(pts, { x: 33, y: 4 }, 12)).toBe(1);
    expect(hitNozzleIndex(pts, { x: 200, y: 0 }, 12)).toBe(-1);
    expect(hitNozzleIndex([{ x: 5, y: 5 }], { x: 6, y: 5 }, 10)).toBe(0);
    expect(hitNozzleIndex([], { x: 0, y: 0 }, 10)).toBe(-1);
  });

  it('lets overlapping nozzles be selected one at a time, newest first', () => {
    const list = [{ key: 'a', x: 10, y: 10 }, { key: 'b', x: 10, y: 10 }, { key: 'c', x: 50, y: 10 }];
    expect(list[hitNozzleIndex(list, { x: 10, y: 10 }, 12)].key).toBe('b');
    expect(list[hitNozzleIndex(list.slice(0, 1), { x: 10, y: 10 }, 12)].key).toBe('a'); // then the other
    // a nearer, older nozzle still beats a farther, newer one
    const pair = [{ key: 'old', x: 10, y: 10 }, { key: 'new', x: 14, y: 10 }];
    expect(pair[hitNozzleIndex(pair, { x: 10, y: 10 }, 12)].key).toBe('old');
  });
});
