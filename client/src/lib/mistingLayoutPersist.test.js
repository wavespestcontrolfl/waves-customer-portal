import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyNozzleEdits, computeTotals, placeNozzles } from './mistingLayoutGeometry';
import {
  buildLayoutPayload, diffNozzleEdits, fetchSavedLayout, layoutForExport, putLayout, restoreLayout, savedLayoutIsForOtherAddress,
} from './mistingLayoutPersist';

const adminFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/admin-fetch', () => ({ adminFetch }));

const LAT = 26.95;
const ZOOM = 20;
const CENTER = { lat: LAT, lng: -82.4 };

const lineSet = () => [
  { id: 'L1', kind: 'eave', points: [{ x: 100, y: 200 }, { x: 700, y: 200 }, { x: 700, y: 500 }] },
  { id: 'L2', kind: 'fence', points: [{ x: 150, y: 700 }, { x: 900, y: 700 }] },
];

// The saved shape the server would hand back for a payload.
const asSaved = (payload) => ({ ...payload, center: payload.center, savedAt: '2026-10-26T15:00:00Z' });

describe('save then reopen round trip', () => {
  it('restores the same lines and exactly the saved nozzle positions, edits included', () => {
    const lines = lineSet();
    const placed = placeNozzles(lines, { lat: LAT, zoom: ZOOM });
    // Edits: delete two, move one, add one on the fence.
    const edits = {
      removed: [placed.nozzles[3].key, placed.nozzles[7].key],
      moved: { [placed.nozzles[1].key]: { x: 333, y: 215 } },
      added: [{ key: 'm1', manual: true, x: 400, y: 700, kind: 'fence', lineIndex: 1, lineId: 'L2', segmentIndex: 0, vertexIndex: null, corner: false }],
    };
    const finals = applyNozzleEdits(placed.nozzles, edits);
    const payload = buildLayoutPayload({
      address: '500 Example Court', center: CENTER, zoom: ZOOM, lines, nozzles: finals, risers: [{ key: 'R1', x: 50, y: 60 }],
      pump: { x: 70, y: 80 }, zones: [{ key: 'Z1', kind: 'pool', x: 300, y: 300, radiusFt: 15, radiusPx: 99 }], mapWidth: 1280, mapHeight: 960,
    });

    const restored = restoreLayout(asSaved(payload));
    const replaced = placeNozzles(restored.lines, { lat: LAT, zoom: ZOOM });
    const shown = applyNozzleEdits(replaced.nozzles, restored.edits);
    const key = (n) => `${n.kind}:${n.x.toFixed(2)},${n.y.toFixed(2)}`;
    expect(shown.map(key).sort()).toEqual(payload.nozzles.map(key).sort());
    // The counts the designer shows after the reopen are the saved ones.
    const totals = computeTotals(replaced.lines, shown);
    expect(totals.count).toBe(payload.nozzles.length);
    expect(totals.fenceCount).toBe(payload.nozzles.filter((n) => n.kind === 'fence').length);
    // Lines come back as the same geometry; extras come back with fresh keys.
    expect(restored.lines.map((l) => l.points)).toEqual(lines.map((l) => l.points));
    expect(restored.extras.risers).toEqual([{ key: 'R1', x: 50, y: 60 }]);
    expect(restored.extras.pump).toEqual({ x: 70, y: 80 });
    expect(restored.extras.zones).toEqual([{ key: 'Z2', kind: 'pool', x: 300, y: 300, radiusFt: 15 }]);
    // Ids continue past what was restored, so a new line or manual nozzle cannot collide.
    const usedIds = [...restored.lines.map((l) => l.id), ...restored.edits.added.map((n) => n.key)];
    expect(new Set(usedIds).size).toBe(usedIds.length);
    expect(restored.idCounter).toBeGreaterThanOrEqual(usedIds.length);
  });

  it('an unedited layout reopens with an empty overlay', () => {
    const lines = lineSet();
    const placed = placeNozzles(lines, { lat: LAT, zoom: ZOOM });
    const payload = buildLayoutPayload({
      address: null, center: CENTER, zoom: ZOOM, lines, nozzles: placed.nozzles, risers: [], pump: null, zones: [], mapWidth: 1280, mapHeight: 960,
    });
    const restored = restoreLayout(asSaved(payload));
    expect(restored.edits).toEqual({ removed: [], moved: {}, added: [] });
    expect(restored.extras).toMatchObject({ risers: [], pump: null, zones: [] });
  });

  it('a layout of nozzles with no lines reopens as added nozzles', () => {
    const restored = restoreLayout(asSaved({
      center: CENTER, zoom: ZOOM, lines: [], risers: [], pump: null, zones: [],
      nozzles: [{ x: 10, y: 20, kind: 'eave', lineIndex: null }, { x: 30, y: 40, kind: 'fence', lineIndex: null }],
    }));
    expect(restored.edits.added.map((n) => [n.x, n.y, n.kind])).toEqual([[10, 20, 'eave'], [30, 40, 'fence']]);
    expect(restored.edits.removed).toEqual([]);
  });
});

describe('diffNozzleEdits', () => {
  const auto = [
    { key: 'a', x: 0, y: 0, kind: 'eave' },
    { key: 'b', x: 100, y: 0, kind: 'eave' },
    { key: 'c', x: 200, y: 0, kind: 'fence' },
  ];
  const next = (() => { let n = 0; return () => `m${(n += 1)}`; })();

  it('keeps matching nozzles, pairs the rest by nearness as moves, and never pairs across kinds', () => {
    const edits = diffNozzleEdits(auto, [
      { x: 0, y: 0, kind: 'eave' },
      { x: 120, y: 5, kind: 'eave' }, // b moved
      { x: 205, y: 0, kind: 'eave' }, // not the fence nozzle: c is removed, this is added
    ], [], next);
    expect(edits.moved).toEqual({ b: { x: 120, y: 5 } });
    expect(edits.removed).toEqual(['c']);
    expect(edits.added).toHaveLength(1);
    expect(edits.added[0]).toMatchObject({ x: 205, y: 0, kind: 'eave', manual: true });
  });
});

describe('layoutForExport', () => {
  it('drops a lone-vertex draft line, remaps line indexes and numbers in walking order', () => {
    const allLines = [
      { id: 'L1', kind: 'eave', points: [{ x: 0, y: 0 }] },
      { id: 'L2', kind: 'fence', points: [{ x: 0, y: 100 }, { x: 400, y: 100 }] },
    ];
    const out = layoutForExport(allLines, [
      { x: 300, y: 100, kind: 'fence', lineIndex: 1 },
      { x: 0, y: 100, kind: 'fence', lineIndex: 1 },
      { x: 0, y: 0, kind: 'eave', lineIndex: 0 },
    ]);
    expect(out.lines).toHaveLength(1);
    expect(out.nozzles.map((n) => [n.number, n.x, n.y, n.lineIndex])).toEqual([
      [1, 0, 0, null], [2, 0, 100, 0], [3, 300, 100, 0],
    ].sort((a, b) => a[0] - b[0]));
  });
});

describe('buildLayoutPayload', () => {
  it('sends final nozzles in walking order and strips display-only fields', () => {
    const lines = [{ id: 'L1', kind: 'eave', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }] }];
    const payload = buildLayoutPayload({
      address: 'A', center: CENTER, zoom: ZOOM, lines,
      nozzles: [{ key: 'z', x: 300, y: 0, kind: 'eave', lineIndex: 0, edited: true }, { key: 'y', x: 100, y: 0, kind: 'eave', lineIndex: 0 }],
      risers: [{ key: 'R1', x: 1, y: 2 }], pump: { x: 3, y: 4 },
      zones: [{ key: 'Z1', kind: 'ac', x: 5, y: 6, radiusFt: 8, radiusPx: 40 }], mapWidth: 1280, mapHeight: 960,
    });
    expect(payload.nozzles).toEqual([{ x: 100, y: 0, kind: 'eave', lineIndex: 0 }, { x: 300, y: 0, kind: 'eave', lineIndex: 0 }]);
    expect(payload.risers).toEqual([{ x: 1, y: 2 }]);
    expect(payload.zones).toEqual([{ kind: 'ac', x: 5, y: 6, radiusFt: 8 }]);
    expect(payload).toMatchObject({ mapWidth: 1280, mapHeight: 960, zoom: ZOOM, center: CENTER });
  });
});

describe('api calls', () => {
  beforeEach(() => adminFetch.mockReset());

  it('reads the saved layout, or null', async () => {
    adminFetch.mockResolvedValueOnce({ layout: { id: 'l1' } });
    await expect(fetchSavedLayout('est 1')).resolves.toEqual({ id: 'l1' });
    expect(adminFetch).toHaveBeenCalledWith('/admin/estimates/est%201/misting-layout');
    adminFetch.mockResolvedValueOnce({ layout: null });
    await expect(fetchSavedLayout('e2')).resolves.toBeNull();
  });

  it('puts multipart with the png and the payload', async () => {
    adminFetch.mockResolvedValueOnce({ layout: { id: 'l1' } });
    const blob = new Blob(['png'], { type: 'image/png' });
    await putLayout('e1', { zoom: 20 }, blob);
    const [path, options] = adminFetch.mock.calls[0];
    expect(path).toBe('/admin/estimates/e1/misting-layout');
    expect(options.method).toBe('PUT');
    expect(options.body.get('payload')).toBe('{"zoom":20}');
    expect(options.body.get('snapshot')).toBeInstanceOf(Blob);
  });
});

describe('savedLayoutIsForOtherAddress', () => {
  const saved = { address: '500 Example Court, Venice, FL 34285' };
  it('is false for the same address in other case, spacing or punctuation', () => {
    expect(savedLayoutIsForOtherAddress(saved, '500 example court venice fl 34285')).toBe(false);
    expect(savedLayoutIsForOtherAddress(saved, ' 500  EXAMPLE COURT,  Venice, FL 34285. ')).toBe(false);
  });
  it('is true for another address, including a changed house number', () => {
    expect(savedLayoutIsForOtherAddress(saved, '900 Other Road, Venice, FL 34285')).toBe(true);
    expect(savedLayoutIsForOtherAddress(saved, '501 Example Court, Venice, FL 34285')).toBe(true);
    expect(savedLayoutIsForOtherAddress({ address: '500 Example Court' }, '500 Example Court East')).toBe(true);
    expect(savedLayoutIsForOtherAddress(saved, '500 Example Court Unit 2, Venice, FL 34285')).toBe(true);
  });
  it('ignores a trailing state and ZIP on either side', () => {
    expect(savedLayoutIsForOtherAddress(saved, '500 Example Court, Venice')).toBe(false);
    expect(savedLayoutIsForOtherAddress({ address: '500 Example Court, Venice, Florida 34285-1234' }, '500 Example Court Venice FL')).toBe(false);
  });
  it('does not judge when either side has no address, or there is no saved layout', () => {
    expect(savedLayoutIsForOtherAddress({ address: null }, 'x')).toBe(false);
    expect(savedLayoutIsForOtherAddress(saved, '')).toBe(false);
    expect(savedLayoutIsForOtherAddress(null, 'x')).toBe(false);
  });
});
