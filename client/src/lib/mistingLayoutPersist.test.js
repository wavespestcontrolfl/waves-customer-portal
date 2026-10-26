import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyRiserEdits, nozzleLines, placeBedRisers } from './mistingLayoutBeds';
import { applyNozzleEdits, computeTotals, placeNozzles } from './mistingLayoutGeometry';
import {
  buildLayoutPayload, diffNozzleEdits, diffRiserEdits, fetchSavedLayout, layoutForExport, putLayout, restoreLayout, savedLayoutIsForOtherAddress,
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
    expect(restored.edits).toEqual({ removed: [], moved: {}, added: [], aimed: {}, riserRemoved: [], riserMoved: {} });
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

describe('bed lines and their risers: save then reopen', () => {
  const lines = () => [
    { id: 'L1', kind: 'eave', points: [{ x: 100, y: 200 }, { x: 700, y: 200 }] },
    { id: 'L2', kind: 'bed', points: [{ x: 150, y: 600 }, { x: 750, y: 600 }, { x: 750, y: 800 }] },
  ];
  const keyOf = (r) => `${r.x.toFixed(2)},${r.y.toFixed(2)}`;
  const finalRisers = (restored) => [
    ...applyRiserEdits(placeBedRisers(restored.lines, { lat: LAT, zoom: ZOOM }), restored.edits),
    ...restored.extras.risers,
  ];

  it('sends every final riser with where it came from, and the bed line as a line', () => {
    const ls = lines();
    const auto = placeBedRisers(ls, { lat: LAT, zoom: ZOOM });
    expect(auto.length).toBeGreaterThan(8);
    const risers = [...auto.slice(1).map((r, i) => (i === 0 ? { ...r, x: r.x + 9, y: r.y + 4 } : r)), { key: 'R1', x: 40, y: 50, source: 'manual' }];
    const payload = buildLayoutPayload({
      address: null, center: CENTER, zoom: ZOOM, lines: ls, nozzles: placeNozzles(nozzleLines(ls), { lat: LAT, zoom: ZOOM }).nozzles,
      risers, pump: { x: 5, y: 6 }, zones: [], mapWidth: 1280, mapHeight: 960,
    });
    expect(payload.lines.map((l) => l.kind)).toEqual(['eave', 'bed']);
    expect(payload.risers).toHaveLength(auto.length); // all but one bed riser, plus the manual one
    expect(payload.risers.filter((r) => r.source === 'bed')).toHaveLength(auto.length - 1);
    expect(payload.risers[payload.risers.length - 1]).toEqual({ x: 40, y: 50, source: 'manual' });
    expect(payload.nozzles.every((n) => n.lineIndex === 0)).toBe(true); // the bed line carries no nozzle
  });

  it('reopens with the same risers: the bed ones derived from the bed line, a deleted one still gone, a moved one still moved', () => {
    const ls = lines();
    const auto = placeBedRisers(ls, { lat: LAT, zoom: ZOOM });
    const finals = [
      ...auto.filter((_, i) => i !== 2).map((r, i) => (i === 4 ? { ...r, x: r.x + 12, y: r.y - 7 } : r)),
      { key: 'R1', x: 300, y: 400, source: 'manual' },
      { key: 'R2', x: 310, y: 410, source: 'manual' },
    ];
    const payload = buildLayoutPayload({
      address: null, center: CENTER, zoom: ZOOM, lines: ls, nozzles: placeNozzles(nozzleLines(ls), { lat: LAT, zoom: ZOOM }).nozzles,
      risers: finals, pump: { x: 5, y: 6 }, zones: [], mapWidth: 1280, mapHeight: 960,
    });
    const restored = restoreLayout(asSaved(payload));
    expect(restored.lines.map((l) => l.kind)).toEqual(['eave', 'bed']);
    expect(restored.edits.riserRemoved).toEqual([auto[2].key]);
    expect(Object.keys(restored.edits.riserMoved)).toHaveLength(1);
    expect(restored.extras.risers.map((r) => [r.x, r.y])).toEqual([[300, 400], [310, 410]]);
    expect(finalRisers(restored).map(keyOf).sort()).toEqual(payload.risers.map(keyOf).sort());
    // The nozzles reopen as they were: the bed line added none.
    const placed = placeNozzles(nozzleLines(restored.lines), { lat: LAT, zoom: ZOOM });
    expect(applyNozzleEdits(placed.nozzles, restored.edits)).toHaveLength(payload.nozzles.length);
    expect(restored.edits.removed).toEqual([]);
  });

  it('an unedited bed reopens with no riser edits, and a layout saved before risers had a source reopens them all as manual', () => {
    const ls = lines();
    const auto = placeBedRisers(ls, { lat: LAT, zoom: ZOOM });
    const payload = buildLayoutPayload({
      address: null, center: CENTER, zoom: ZOOM, lines: ls, nozzles: [], risers: auto, pump: { x: 1, y: 1 }, zones: [], mapWidth: 1280, mapHeight: 960,
    });
    const restored = restoreLayout(asSaved(payload));
    expect(restored.edits).toMatchObject({ riserRemoved: [], riserMoved: {} });
    expect(restored.extras.risers).toEqual([]);

    const old = restoreLayout(asSaved({ ...payload, risers: payload.risers.map(({ x, y }) => ({ x, y })) }));
    // Every one is a manual riser where it was saved, so the derived ones are all set aside: the same risers, in the same places.
    expect(old.extras.risers).toHaveLength(auto.length);
    expect(old.edits.riserRemoved).toHaveLength(auto.length);
    expect(finalRisers(old).map(keyOf).sort()).toEqual(payload.risers.map(keyOf).sort());
  });

  it('diffRiserEdits: a saved bed riser with no automatic one to pair with comes back as a manual riser', () => {
    const auto = [{ key: 'bed:a', x: 0, y: 0 }, { key: 'bed:b', x: 100, y: 0 }];
    const edits = diffRiserEdits(auto, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 500, y: 500 }]);
    expect(edits.riserRemoved).toEqual([]);
    expect(edits.riserMoved).toEqual({});
    expect(edits.manual).toEqual([{ x: 500, y: 500 }]);
    expect(diffRiserEdits(auto, [{ x: 0, y: 0 }]).riserRemoved).toEqual(['bed:b']);
  });
});

describe('manual aim', () => {
  it('survives save then reopen on kept, moved and added nozzles, and only those', () => {
    const lines = lineSet();
    const placed = placeNozzles(lines, { lat: LAT, zoom: ZOOM });
    const [kept, moved, plain] = [placed.nozzles[0], placed.nozzles[2], placed.nozzles[4]];
    const edits = {
      removed: [],
      moved: { [moved.key]: { x: moved.x + 40, y: moved.y + 12 } },
      aimed: { [kept.key]: 0, [moved.key]: 212.5 },
      added: [{ key: 'm1', manual: true, aim: 90, x: 400, y: 700, kind: 'fence', lineIndex: 1, lineId: 'L2', segmentIndex: 0, vertexIndex: null, corner: false }],
    };
    const finals = applyNozzleEdits(placed.nozzles, edits);
    const payload = buildLayoutPayload({
      address: null, center: CENTER, zoom: ZOOM, lines, nozzles: finals, risers: [], pump: null, zones: [], mapWidth: 1280, mapHeight: 960,
    });
    // The payload carries an aim only for the three aimed nozzles, 0 included.
    expect(payload.nozzles.filter((n) => 'aim' in n).map((n) => n.aim).sort((a, b) => a - b)).toEqual([0, 90, 212.5]);
    expect(payload.nozzles.every((n) => !('aim' in n) || Number.isFinite(n.aim))).toBe(true);

    const restored = restoreLayout(asSaved(payload));
    const replaced = placeNozzles(restored.lines, { lat: LAT, zoom: ZOOM });
    const shown = applyNozzleEdits(replaced.nozzles, restored.edits);
    const at = (n) => `${n.x.toFixed(2)},${n.y.toFixed(2)}`;
    const aimAt = Object.fromEntries(shown.filter((n) => 'aim' in n).map((n) => [at(n), n.aim]));
    expect(aimAt).toEqual({
      [at(kept)]: 0,
      [`${(moved.x + 40).toFixed(2)},${(moved.y + 12).toFixed(2)}`]: 212.5,
      '400.00,700.00': 90,
    });
    expect(shown.find((n) => at(n) === at(plain))).not.toHaveProperty('aim');
    expect(restored.edits.aimed).toEqual({ [kept.key]: 0, [moved.key]: 212.5 });
  });

  it('an unaimed layout reopens with no aims and an unaimed payload has no aim keys', () => {
    const lines = lineSet();
    const placed = placeNozzles(lines, { lat: LAT, zoom: ZOOM });
    const payload = buildLayoutPayload({
      address: null, center: CENTER, zoom: ZOOM, lines, nozzles: placed.nozzles, risers: [], pump: null, zones: [], mapWidth: 1280, mapHeight: 960,
    });
    expect(payload.nozzles.some((n) => 'aim' in n)).toBe(false);
    expect(restoreLayout(asSaved(payload)).edits.aimed).toEqual({});
  });

  it('wraps a saved aim into range and ignores junk', () => {
    const edits = diffNozzleEdits(
      [{ key: 'a', x: 0, y: 0, kind: 'eave' }, { key: 'b', x: 100, y: 0, kind: 'eave' }],
      [{ x: 0, y: 0, kind: 'eave', aim: -90 }, { x: 100, y: 0, kind: 'eave', aim: 'north' }],
      [],
      () => 'm1',
    );
    expect(edits.aimed).toEqual({ a: 270 });
  });

  it('layoutForExport keeps the key and a manual aim on the numbered nozzle', () => {
    const out = layoutForExport([{ id: 'L1', kind: 'eave', points: [{ x: 0, y: 0 }, { x: 400, y: 0 }] }], [
      { key: 'p', x: 300, y: 0, kind: 'eave', lineIndex: 0, aim: 45 },
      { key: 'q', x: 100, y: 0, kind: 'eave', lineIndex: 0 },
    ]);
    expect(out.nozzles.map((n) => [n.number, n.key, n.aim])).toEqual([[1, 'q', undefined], [2, 'p', 45]]);
  });
});

describe('diffNozzleEdits and the line a nozzle belongs to', () => {
  it('does not turn a nozzle added on another line into a move of the nearest automatic one', () => {
    const auto = [
      { key: 'a', x: 0, y: 0, kind: 'eave', lineIndex: 0 },
      { key: 'b', x: 100, y: 0, kind: 'eave', lineIndex: 0 },
    ];
    const edits = diffNozzleEdits(auto, [
      { x: 0, y: 0, kind: 'eave', lineIndex: 0 },
      { x: 105, y: 5, kind: 'eave', lineIndex: 1 }, // b was deleted, this one was added on the other line, close by
    ], [{ id: 'L1', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }, { id: 'L2', points: [{ x: 105, y: -50 }, { x: 105, y: 50 }] }], () => 'm1');
    expect(edits.moved).toEqual({});
    expect(edits.removed).toEqual(['b']);
    expect(edits.added).toHaveLength(1);
    expect(edits.added[0]).toMatchObject({ x: 105, y: 5, lineIndex: 1, manual: true });
  });

  it('keeps a nozzle moved onto another line\'s deleted spot on its own line, so its automatic aim does not change on reopen', () => {
    const auto = [
      { key: 'a', x: 0, y: 0, kind: 'eave', lineIndex: 0 },
      { key: 'b', x: 100, y: 0, kind: 'eave', lineIndex: 0 },
      { key: 'c', x: 100, y: 80, kind: 'eave', lineIndex: 1 },
    ];
    // b (line 0) was deleted, and c (line 1) was dragged onto b's exact spot.
    const edits = diffNozzleEdits(auto, [
      { x: 0, y: 0, kind: 'eave', lineIndex: 0 },
      { x: 100, y: 0, kind: 'eave', lineIndex: 1 },
    ], [], () => 'm1');
    // Not "a on b's spot": c is moved to it, and stays c, on line 1; b is removed from line 0.
    expect(edits.removed).toEqual(['b']);
    expect(edits.moved).toEqual({ c: { x: 100, y: 0 } });
    expect(edits.added).toEqual([]);
  });

  it('still pairs a moved nozzle with its own line\'s, and a saved nozzle that names no line with the nearest', () => {
    const auto = [{ key: 'a', x: 0, y: 0, kind: 'eave', lineIndex: 0 }, { key: 'b', x: 100, y: 0, kind: 'eave', lineIndex: 1 }];
    expect(diffNozzleEdits(auto, [{ x: 0, y: 0, kind: 'eave', lineIndex: 0 }, { x: 110, y: 4, kind: 'eave', lineIndex: 1 }], [], () => 'm').moved)
      .toEqual({ b: { x: 110, y: 4 } });
    expect(diffNozzleEdits(auto, [{ x: 0, y: 0, kind: 'eave' }, { x: 110, y: 4, kind: 'eave' }], [], () => 'm').moved)
      .toEqual({ b: { x: 110, y: 4 } });
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
    expect(payload.risers).toEqual([{ x: 1, y: 2, source: 'manual' }]);
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
