import { describe, expect, it } from 'vitest';
import { MAP_HEIGHT, MAP_WIDTH } from '../components/tech/treatmentZoneSpray';
import { fitsAfterZoom, layoutPoints, scaleDraft, scaleEdits, scaleExtras, scaleLines } from './mistingLayoutZoom';

const CX = MAP_WIDTH / 2;
const CY = MAP_HEIGHT / 2;

const state = () => ({
  lines: [{ id: 'L1', kind: 'eave', points: [{ x: 600, y: 400 }, { x: 760, y: 400 }, { x: 760, y: 520 }] }],
  draft: { id: 'L2', kind: 'fence', points: [{ x: 700, y: 600 }] },
  edits: {
    removed: ['L1:s0:1'],
    moved: { 'L1:v1': { x: 770, y: 410 } },
    added: [{ key: 'm1', manual: true, x: 650, y: 400, kind: 'eave', lineIndex: 0, aim: 120 }],
    aimed: { 'L1:v0': 45 },
  },
  extras: {
    risers: [{ key: 'R1', x: 640, y: 480 }],
    pump: { x: 700, y: 440 },
    zones: [{ key: 'Z1', kind: 'pool', x: 560, y: 430, radiusFt: 15, radiusPx: 99 }],
  },
});

const scaled = (s, delta) => ({
  lines: scaleLines(s.lines, delta),
  draft: scaleDraft(s.draft, delta),
  edits: scaleEdits(s.edits, delta),
  extras: scaleExtras(s.extras, delta),
});

describe('scaling a layout with the photo\'s zoom', () => {
  it('moves every placed point about the frame center by 2^delta and keeps everything else', () => {
    const out = scaled(state(), 1);
    expect(out.lines[0].points).toEqual([{ x: CX + (600 - CX) * 2, y: CY + (400 - CY) * 2 }, { x: CX + 240, y: CY - 160 }, { x: CX + 240, y: CY + 80 }]);
    expect(out.lines[0]).toMatchObject({ id: 'L1', kind: 'eave' });
    expect(out.draft.points[0]).toEqual({ x: CX + 120, y: CY + 240 });
    expect(out.edits.moved['L1:v1']).toEqual({ x: CX + 260, y: CY - 140 });
    expect(out.edits.added[0]).toMatchObject({ key: 'm1', x: CX + 20, y: CY - 160, aim: 120, manual: true });
    // A removed nozzle and a manual aim name a nozzle, not a position.
    expect(out.edits.removed).toEqual(['L1:s0:1']);
    expect(out.edits.aimed).toEqual({ 'L1:v0': 45 });
    expect(out.extras.risers[0]).toMatchObject({ key: 'R1', x: CX, y: CY });
    expect(out.extras.pump).toEqual({ x: CX + 120, y: CY - 80 });
    // A zone keeps its radius in feet, so it follows the photo on its own.
    expect(out.extras.zones[0]).toMatchObject({ kind: 'pool', radiusFt: 15, x: CX - 160, y: CY - 100 });
  });

  it('zooming out one step and in one step brings every point back', () => {
    const start = state();
    const there = scaled(scaled(start, -1), 1);
    const flat = (s) => layoutPoints(s).map((p) => [p.x, p.y]);
    flat(there).forEach(([x, y], i) => {
      expect(x).toBeCloseTo(flat(start)[i][0], 9);
      expect(y).toBeCloseTo(flat(start)[i][1], 9);
    });
    expect(there.edits.aimed).toEqual(start.edits.aimed);
    expect(there.edits.removed).toEqual(start.edits.removed);
  });

  it('survives a pump, a draft and edits that are absent', () => {
    expect(scaleDraft(null, 1)).toBeNull();
    expect(scaleExtras({ risers: [], pump: null, zones: [] }, 1)).toEqual({ risers: [], pump: null, zones: [] });
    expect(scaleEdits({ removed: [], moved: {}, added: [], aimed: {} }, -1)).toEqual({ removed: [], moved: {}, added: [], aimed: {} });
    expect(layoutPoints({})).toEqual([]);
  });
});

describe('fitsAfterZoom', () => {
  it('lets a zoom in through while every point stays in the frame, edges included, and refuses it otherwise', () => {
    expect(fitsAfterZoom(state(), 1)).toBe(true);
    const edge = { lines: [{ points: [{ x: CX + 320, y: CY - 240 }, { x: CX - 320, y: CY + 240 }] }] }; // lands exactly on the frame's edge
    expect(fitsAfterZoom(edge, 1)).toBe(true);
    const past = { lines: [{ points: [{ x: CX + 320.5, y: CY }] }] };
    expect(fitsAfterZoom(past, 1)).toBe(false);
  });

  it('checks every kind of point: a moved or added nozzle, a riser, the pump, a zone center and the draft', () => {
    const far = { x: CX + 400, y: CY };
    [
      { draft: { points: [far] } },
      { edits: { moved: { a: far } } },
      { edits: { added: [far] } },
      { extras: { risers: [far] } },
      { extras: { pump: far } },
      { extras: { zones: [{ ...far, radiusFt: 8 }] } },
    ].forEach((s) => expect(fitsAfterZoom(s, 1)).toBe(false));
  });

  it('a zoom out always fits what fit before', () => {
    expect(fitsAfterZoom({ lines: [{ points: [{ x: 0, y: 0 }, { x: MAP_WIDTH, y: MAP_HEIGHT }] }] }, -1)).toBe(true);
  });
});
