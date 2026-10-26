import { describe, expect, it } from 'vitest';
import { pxToFeet } from '../components/tech/treatmentZoneSpray';
import { applyRiserEdits, nozzleLines, placeBedRisers } from './mistingLayoutBeds';
import { placeNozzles } from './mistingLayoutGeometry';

const LAT = 26.95;
const ZOOM = 20;
const FT = 1 / pxToFeet(1, LAT, ZOOM);
const map = { lat: LAT, zoom: ZOOM };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ftBetween = (a, b) => pxToFeet(dist(a, b), LAT, ZOOM);

const bed = (id, feet, y = 600) => ({ id, kind: 'bed', points: [{ x: 100, y }, { x: 100 + feet * FT, y }] });
const eave = { id: 'E', kind: 'eave', points: [{ x: 100, y: 200 }, { x: 100 + 40 * FT, y: 200 }] };

describe('risers along a bed line', () => {
  it('puts one at each end and never more than 10 ft between neighbours', () => {
    const risers = placeBedRisers([bed('B', 40)], map);
    expect(risers).toHaveLength(5); // 40 ft in four 10 ft gaps
    const xs = risers.map((r) => r.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(100, 6);
    expect(xs[xs.length - 1]).toBeCloseTo(100 + 40 * FT, 6);
    for (let i = 1; i < xs.length; i += 1) expect(pxToFeet(xs[i] - xs[i - 1], LAT, ZOOM)).toBeLessThanOrEqual(10 + 1e-6);
  });

  it('spaces them like nozzles: 10 ft on the same line (the manual)', () => {
    const line = { id: 'X', kind: 'eave', points: bed('X', 80).points };
    const nozzles = placeNozzles([line], map).nozzles;
    const risers = placeBedRisers([{ ...line, kind: 'bed' }], map);
    expect(nozzles).toHaveLength(9); // 80 ft in 10 ft gaps
    expect(risers).toHaveLength(9); // 80 ft in 10 ft gaps, the same as nozzles
  });

  it('a short bed line still gets a riser at each end, and a corner closer than 5 ft to the last one is merged away', () => {
    expect(placeBedRisers([bed('S', 5)], map)).toHaveLength(2);
    const jog = { id: 'J', kind: 'bed', points: [{ x: 100, y: 600 }, { x: 100 + 20 * FT, y: 600 }, { x: 100 + 20 * FT + 3 * FT, y: 600 + 2 * FT }, { x: 100 + 40 * FT, y: 600 + 2 * FT }] };
    const risers = placeBedRisers([jog], map);
    for (let i = 0; i < risers.length; i += 1) {
      for (let j = i + 1; j < risers.length; j += 1) expect(ftBetween(risers[i], risers[j])).toBeGreaterThanOrEqual(5 - 1e-6);
    }
  });

  it('only bed lines get them, each carries its line, and keys are unique and stable', () => {
    const lines = [eave, bed('B1', 24, 500), bed('B2', 16, 700)];
    const risers = placeBedRisers(lines, map);
    expect(risers.every((r) => r.source === 'bed')).toBe(true);
    expect(new Set(risers.map((r) => r.lineIndex))).toEqual(new Set([1, 2])); // indexes into the full list
    expect(new Set(risers.map((r) => r.key)).size).toBe(risers.length);
    expect(placeBedRisers(lines, map).map((r) => r.key)).toEqual(risers.map((r) => r.key));
    expect(placeBedRisers([eave], map)).toEqual([]);
    expect(placeBedRisers(null, map)).toEqual([]);
  });

  it('a bed line gets no nozzles: nozzleLines empties it and keeps every index', () => {
    const lines = [eave, bed('B', 40)];
    const placed = placeNozzles(nozzleLines(lines), map);
    expect(placed.nozzles.every((n) => n.lineIndex === 0)).toBe(true);
    expect(placed.nozzles.length).toBe(placeNozzles([eave], map).nozzles.length);
    expect(placed.totals).toMatchObject({ fenceCount: 0, eaveCount: placed.nozzles.length });
    expect(placed.totals.linearFt).toBeCloseTo(placeNozzles([eave], map).totals.linearFt, 6); // the bed adds no line length
    expect(nozzleLines(lines)[1].points).toEqual([]);
    expect(lines[1].points).toHaveLength(2); // the original is untouched
  });
});

describe('editing the risers of a bed line', () => {
  const auto = placeBedRisers([bed('B', 40)], map);

  it('removes the deleted ones and puts the moved ones where they were put', () => {
    const out = applyRiserEdits(auto, { riserRemoved: [auto[1].key], riserMoved: { [auto[2].key]: { x: 5, y: 6 } } });
    expect(out).toHaveLength(auto.length - 1);
    expect(out.find((r) => r.key === auto[1].key)).toBeUndefined();
    expect(out.find((r) => r.key === auto[2].key)).toMatchObject({ x: 5, y: 6, edited: true, source: 'bed' });
    expect(out.find((r) => r.key === auto[0].key)).toBe(auto[0]);
  });

  it('ignores edits for a riser that no longer exists, and works with no edits', () => {
    expect(applyRiserEdits(auto, { riserRemoved: ['gone'], riserMoved: { gone: { x: 1, y: 1 } } })).toHaveLength(auto.length);
    expect(applyRiserEdits(auto, {})).toEqual(auto);
    expect(applyRiserEdits(null)).toEqual([]);
  });
});
