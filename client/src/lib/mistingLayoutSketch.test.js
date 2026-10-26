import { describe, expect, it } from 'vitest';
import { MAP_HEIGHT, MAP_WIDTH, pxToFeet } from '../components/tech/treatmentZoneSpray';
import { applyNozzleEdits, placeNozzles } from './mistingLayoutGeometry';
import {
  SKETCH_CONCEPT,
  SKETCH_FOOTER_H,
  SKETCH_HEADER_H,
  SKETCH_HEIGHT,
  buildSketchModel,
  numberNozzles,
  scaleBar,
  sketchDateLabel,
  zoneLabel,
} from './mistingLayoutSketch';
import { legendRows, mistingLayoutCountsLine } from './mistingLayoutCounts';
import { feetToPx, flagInZones } from './mistingLayoutExtras';

const LAT = 26.95;
const ZOOM = 20;

describe('numberNozzles', () => {
  const lines = [
    { id: 'L1', kind: 'eave', points: [{ x: 100, y: 100 }, { x: 500, y: 100 }] },
    { id: 'L2', kind: 'fence', points: [{ x: 100, y: 400 }, { x: 500, y: 400 }] },
  ];
  const at = (x, y, lineIndex, kind = 'eave') => ({ x, y, kind, lineIndex });

  it('numbers line by line in the order drawn, and along each line from its first point', () => {
    // Listed out of order on purpose.
    const numbered = numberNozzles([at(300, 400, 1, 'fence'), at(400, 100, 0), at(100, 100, 0), at(100, 400, 1, 'fence'), at(250, 100, 0)], lines);
    expect(numbered.map((n) => [n.number, n.x, n.y])).toEqual([
      [1, 100, 100], [2, 250, 100], [3, 400, 100], [4, 100, 400], [5, 300, 400],
    ]);
  });

  it('keeps a moved nozzle in its place in the walk when it stays near the same stretch', () => {
    const numbered = numberNozzles([at(100, 100, 0), at(260, 118, 0), at(400, 100, 0)], lines);
    expect(numbered.map((n) => n.number)).toEqual([1, 2, 3]);
    expect(numbered[1].x).toBe(260);
  });

  it('puts a nozzle with no line index on the closest drawn line, and numbers by position when there are no lines', () => {
    const numbered = numberNozzles([at(300, 395, null, 'fence'), at(200, 100, 0), { x: 5, y: 5, kind: 'eave', lineIndex: null }], lines);
    // (5, 5) projects to the start of the first line, so it walks first.
    expect(numbered.map((n) => [n.number, n.x])).toEqual([[1, 5], [2, 200], [3, 300]]);
    expect(numberNozzles([at(9, 9, null), at(1, 1, null)], []).map((n) => [n.number, n.x])).toEqual([[1, 1], [2, 9]]);
  });

  it('numbers the real placement 1..N with no gaps or repeats, in walking order along a single line', () => {
    const placed = placeNozzles([{ kind: 'eave', points: [{ x: 100, y: 200 }, { x: 700, y: 200 }] }], { lat: LAT, zoom: ZOOM });
    const numbered = numberNozzles(placed.nozzles, [{ points: [{ x: 100, y: 200 }, { x: 700, y: 200 }] }]);
    expect(numbered.map((n) => n.number)).toEqual(numbered.map((_, i) => i + 1));
    const xs = numbered.map((n) => n.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it('numbers after edits: a deleted nozzle leaves no hole and an added one slots into the walk', () => {
    const line = { kind: 'eave', points: [{ x: 100, y: 200 }, { x: 700, y: 200 }] };
    const placed = placeNozzles([line], { lat: LAT, zoom: ZOOM });
    const victim = placed.nozzles[2];
    const edited = applyNozzleEdits(placed.nozzles, {
      removed: [victim.key],
      added: [{ key: 'm1', x: 150, y: 200, kind: 'eave', lineIndex: 0 }],
    });
    const numbered = numberNozzles(edited, [line]);
    expect(numbered).toHaveLength(placed.nozzles.length);
    expect(numbered.map((n) => n.number)).toEqual(numbered.map((_, i) => i + 1));
    const added = numbered.find((n) => n.x === 150);
    expect(added.number).toBe(numbered.filter((n) => n.x < 150).length + 1);
    expect(numbered.find((n) => n.x === victim.x)).toBeUndefined();
  });
});

describe('scaleBar', () => {
  it('is a round number of feet whose pixel length is exactly those feet on the map', () => {
    const { feet, px } = scaleBar(LAT, ZOOM, 300);
    expect([1, 2, 5, 10, 20, 25, 50, 100, 200, 500]).toContain(feet);
    expect(pxToFeet(px, LAT, ZOOM)).toBeCloseTo(feet, 6);
    expect(px).toBeLessThanOrEqual(300);
  });

  it('picks the longest step that fits: more room, longer bar', () => {
    const small = scaleBar(LAT, ZOOM, 120);
    const large = scaleBar(LAT, ZOOM, 600);
    expect(large.feet).toBeGreaterThan(small.feet);
    expect(large.px).toBeLessThanOrEqual(600);
    // The next step up would not have fit.
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
    const next = steps[steps.indexOf(large.feet) + 1];
    if (next) expect(next / pxToFeet(1, LAT, ZOOM)).toBeGreaterThan(600);
  });

  it('shrinks in feet-per-pixel at a wider zoom: the same pixels cover more feet', () => {
    expect(scaleBar(LAT, 19, 300).feet).toBeGreaterThan(scaleBar(LAT, 20, 300).feet);
  });
});

describe('text', () => {
  it('lists the counts the server stores', () => {
    expect(legendRows({ nozzleCount: 12, eaveCount: 8, fenceCount: 4, riserCount: 3, hasPump: true, zoneCount: 2, linearFt: 118.6 })).toEqual([
      'Nozzles: 12 (eave 8, fence 4)', 'Risers: 3', 'Pump: placed', 'No-mist zones: 2', 'Line: 119 ft',
    ]);
    expect(mistingLayoutCountsLine({ nozzles: 5, eave: 5, fence: 0, risers: 0, zones: 0, linearFt: 40, pump: false }))
      .toBe('Nozzles: 5 (eave 5, fence 0) · Risers: 0 · Pump: not placed · No-mist zones: 0 · Line: 40 ft');
  });

  it('adds the no-mist zone row only when a nozzle sits in a zone', () => {
    const base = { nozzleCount: 12, eaveCount: 8, fenceCount: 4, riserCount: 3, hasPump: true, zoneCount: 2, linearFt: 118.6 };
    expect(legendRows({ ...base, flaggedCount: 0 })).toEqual(legendRows(base));
    expect(legendRows(base)).toHaveLength(5);
    const rows = legendRows({ ...base, flaggedCount: 2 });
    expect(rows).toHaveLength(6);
    expect(rows[5]).toBe('In a no-mist zone: 2 (aim away or move)');
  });

  it('prints the saved-counts line without a flagged row, because the server counts carry none', () => {
    const line = mistingLayoutCountsLine({ nozzles: 5, eave: 5, fence: 0, risers: 0, zones: 1, linearFt: 40, pump: false });
    expect(line).not.toMatch(/no-mist zone:/i);
    expect(line.split(' · ')).toHaveLength(5);
  });

  it('dates the sketch in Eastern time', () => {
    // 03:30 UTC on Oct 27 is still Oct 26 in Eastern time.
    expect(sketchDateLabel(new Date('2026-10-27T03:30:00Z'))).toBe('October 26, 2026');
  });

  it('labels a zone by its kind', () => {
    expect(zoneLabel({ kind: 'ac' })).toBe('No mist: AC intake');
  });
});

describe('buildSketchModel', () => {
  it('carries the concept note, numbered nozzles, scale and legend', () => {
    const lines = [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 100 }, { x: 400, y: 100 }] }];
    const model = buildSketchModel({
      lat: LAT,
      zoom: ZOOM,
      address: '500 Example Court',
      date: new Date('2026-10-26T15:00:00Z'),
      lines,
      nozzles: [{ x: 400, y: 100, kind: 'eave', lineIndex: 0 }, { x: 100, y: 100, kind: 'eave', lineIndex: 0 }],
      risers: [{ x: 10, y: 10 }],
      pump: { x: 20, y: 20 },
      zones: [{ kind: 'pool', x: 50, y: 50, radiusFt: 15, radiusPx: 60 }],
      totals: { eaveCount: 2, fenceCount: 0, linearFt: 55 },
    });
    expect(model.concept).toBe(SKETCH_CONCEPT);
    expect(model.concept).toBe('Concept layout — final placement at the design visit and install.');
    expect(model.nozzles.map((n) => [n.number, n.x])).toEqual([[1, 100], [2, 400]]);
    expect(model.dateLabel).toBe('October 26, 2026');
    expect(model.legend[0]).toBe('Nozzles: 2 (eave 2, fence 0)');
    expect(model.legend).toContain('Pump: placed');
    expect(model.scale.feet).toBeGreaterThan(0);
  });

  describe('nozzles inside a no-mist zone', () => {
    const zone = { key: 'z1', kind: 'pool', x: 500, y: 500, radiusFt: 15 };
    const withPx = { ...zone, radiusPx: feetToPx(15, LAT, ZOOM) };
    const lines = [{ id: 'L1', kind: 'eave', points: [{ x: 100, y: 500 }, { x: 900, y: 500 }] }];
    const R = feetToPx(15, LAT, ZOOM);
    const build = (nozzles, zones = [withPx]) => buildSketchModel({
      lat: LAT,
      zoom: ZOOM,
      lines,
      nozzles,
      risers: [],
      pump: null,
      zones,
      totals: { eaveCount: nozzles.length, fenceCount: 0, linearFt: 100 },
    });
    const n = (key, x) => ({ key, x, y: 500, kind: 'eave', lineIndex: 0 });

    it('marks a nozzle inside any zone, by the designer rule (strictly inside), and no other', () => {
      const nozzles = [n('out-left', 100), n('in', 500), n('edge-in', 500 + R - 1), n('edge', 500 + R), n('out', 500 + R + 20)];
      const model = build(nozzles);
      const flaggedKeys = new Set(model.nozzles.filter((m) => m.flagged).map((m) => m.key));
      expect([...flaggedKeys].sort()).toEqual(['edge-in', 'in']);
      // the same set the designer flags on screen
      expect([...flagInZones(nozzles, [withPx], LAT, ZOOM)].sort()).toEqual([...flaggedKeys].sort());
      expect(model.nozzles.every((m) => typeof m.flagged === 'boolean')).toBe(true);
    });

    it('adds the legend row with the count when some are flagged, and none when all are clear', () => {
      const some = build([n('a', 100), n('b', 500), n('c', 510)]);
      expect(some.legend).toContain('In a no-mist zone: 2 (aim away or move)');
      expect(some.legend[0]).toBe('Nozzles: 3 (eave 3, fence 0)');
      const none = build([n('a', 100), n('b', 900)]);
      expect(none.legend.some((row) => row.startsWith('In a no-mist zone'))).toBe(false);
      expect(none.legend).toHaveLength(5);
      const noZones = build([n('a', 500)], []);
      expect(noZones.nozzles[0].flagged).toBe(false);
      expect(noZones.legend).toHaveLength(5);
    });
  });

  it('keeps the photo at its native size between the header and the footer', () => {
    expect(SKETCH_HEIGHT).toBe(SKETCH_HEADER_H + MAP_HEIGHT + SKETCH_FOOTER_H);
    expect(MAP_WIDTH).toBe(1280);
  });
});
