// Misting layout designer, step 3: saving and reopening a layout (GATE_MISTING_LAYOUT_DESIGNER).
//
// Pure helpers plus the two API calls. A saved layout stores the FINAL nozzle positions (after staff
// edits) together with the lines they were placed on. Reopening restores the lines, re-runs the
// automatic placement, and turns the difference between that placement and the saved nozzles into the
// designer's usual edit overlay (removed, moved, added). The shown nozzles are then exactly the saved
// ones, and the overlay follows the step 1 rule: changing the lines re-places the nozzles and clears it.
import { adminFetch } from '../utils/admin-fetch';
import { normalizeAim } from './mistingLayoutAim';
import { nearestPointOnLines, placeNozzles } from './mistingLayoutGeometry';
import { numberNozzles } from './mistingLayoutSketch';

const MATCH_TOLERANCE_PX = 0.25;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The lines and nozzles as they are stored and drawn: lines with fewer than two points are dropped
 * (a lone draft vertex is not a line), and the nozzles are numbered in walking order with their
 * `lineIndex` pointing into the kept lines (null when their line was dropped). A nozzle keeps its
 * `key`, and its `aim` only when staff aimed it by hand.
 */
export function layoutForExport(allLines, nozzles) {
  const remap = new Map();
  const lines = [];
  (allLines || []).forEach((line, i) => {
    if (line.points.length < 2) return;
    remap.set(i, lines.length);
    lines.push({ id: line.id, kind: line.kind, points: line.points.map((p) => ({ x: p.x, y: p.y })) });
  });
  const prepared = (nozzles || []).map((n) => {
    const aim = normalizeAim(n.aim);
    return {
      key: n.key,
      x: n.x,
      y: n.y,
      kind: n.kind === 'fence' ? 'fence' : 'eave',
      lineIndex: remap.has(n.lineIndex) ? remap.get(n.lineIndex) : null,
      ...(aim === null ? {} : { aim }),
    };
  });
  return { lines, nozzles: numberNozzles(prepared, lines) };
}

/** The JSON part of the save request. Nozzles are in walking order. */
export function buildLayoutPayload({ address, center, zoom, lines, nozzles, risers, pump, zones, mapWidth, mapHeight }) {
  const exported = layoutForExport(lines, nozzles);
  return {
    address: address || null,
    center: { lat: center.lat, lng: center.lng },
    zoom,
    mapWidth,
    mapHeight,
    lines: exported.lines,
    nozzles: exported.nozzles.map(({ x, y, kind, lineIndex, aim }) => ({ x, y, kind, lineIndex, ...(aim === undefined ? {} : { aim }) })),
    risers: (risers || []).map(({ x, y }) => ({ x, y })),
    pump: pump ? { x: pump.x, y: pump.y } : null,
    zones: (zones || []).map(({ kind, x, y, radiusFt }) => ({ kind, x, y, radiusFt })),
  };
}

// A moved nozzle keeps the line it was placed on, and the line decides which way it aims, so a saved nozzle that
// names a different line than an automatic one is not that nozzle moved: it is another one (removed + added).
const sameLine = (auto, saved) => !Number.isInteger(saved.lineIndex) || saved.lineIndex === auto.lineIndex;

/**
 * Express `saved` nozzles as an edit overlay on the automatic placement `auto`.
 * Pass 1 keeps every saved nozzle that sits on an automatic one (same kind, same spot). Pass 2 pairs
 * what is left, nearest first, as MOVED nozzles. Whatever is still unpaired is removed (automatic) or
 * added (saved). Whatever the pairing, applyNozzleEdits(auto, overlay) has exactly the saved positions.
 * A saved manual `aim` goes with its nozzle: into `aimed` for a kept or moved automatic one, onto the
 * nozzle itself for an added one.
 */
export function diffNozzleEdits(auto, saved, lines, nextKey) {
  const freeAuto = new Set(auto.map((_, i) => i));
  const freeSaved = new Set(saved.map((_, i) => i));
  const aimed = {};
  const take = (a, s) => {
    freeAuto.delete(a);
    freeSaved.delete(s);
    const aim = normalizeAim(saved[s].aim);
    if (aim !== null) aimed[auto[a].key] = aim;
  };

  saved.forEach((s, si) => {
    let best = -1;
    let bestD = Infinity;
    freeAuto.forEach((ai) => {
      const d = distance(auto[ai], s);
      if (auto[ai].kind === s.kind && d <= MATCH_TOLERANCE_PX && d < bestD) { best = ai; bestD = d; }
    });
    if (best >= 0) take(best, si);
  });

  const pairs = [];
  freeAuto.forEach((ai) => freeSaved.forEach((si) => {
    if (auto[ai].kind === saved[si].kind && sameLine(auto[ai], saved[si])) pairs.push({ ai, si, d: distance(auto[ai], saved[si]) });
  }));
  pairs.sort((a, b) => a.d - b.d || a.ai - b.ai || a.si - b.si);
  const moved = {};
  pairs.forEach(({ ai, si }) => {
    if (!freeAuto.has(ai) || !freeSaved.has(si)) return;
    take(ai, si);
    moved[auto[ai].key] = { x: saved[si].x, y: saved[si].y };
  });

  const removed = [...freeAuto].map((ai) => auto[ai].key);
  const added = [...freeSaved].map((si) => {
    const s = saved[si];
    const byIndex = Number.isInteger(s.lineIndex) && lines[s.lineIndex] ? lines[s.lineIndex] : null;
    const near = byIndex ? null : nearestPointOnLines(lines, s, Infinity);
    const line = byIndex || (near ? lines[near.lineIndex] : null);
    const aim = normalizeAim(s.aim);
    return {
      key: nextKey(),
      ...(aim === null ? {} : { aim }),
      manual: true,
      x: s.x,
      y: s.y,
      kind: s.kind,
      lineId: line ? line.id : null,
      lineIndex: byIndex ? s.lineIndex : (near ? near.lineIndex : null),
      segmentIndex: near ? near.segmentIndex : 0,
      vertexIndex: null,
      corner: false,
    };
  });
  return { removed, moved, added, aimed };
}

/**
 * Turn a saved layout (the GET response) into the designer's starting state: lines with fresh ids,
 * the edit overlay, risers, pump and zones with fresh keys, and the id counters to continue from.
 */
export function restoreLayout(saved) {
  let counter = 0;
  const nextNumber = () => { counter += 1; return counter; };
  const lines = (saved.lines || []).map((line) => ({
    id: `L${nextNumber()}`,
    kind: line.kind === 'fence' ? 'fence' : 'eave',
    points: (line.points || []).map((p) => ({ x: p.x, y: p.y })),
  }));
  const placed = placeNozzles(lines, { lat: saved.center.lat, zoom: saved.zoom });
  const edits = diffNozzleEdits(placed.nozzles, saved.nozzles || [], lines, () => `m${nextNumber()}`);

  let extras = 0;
  const key = (prefix) => { extras += 1; return `${prefix}${extras}`; };
  return {
    lines,
    edits,
    idCounter: counter,
    extras: {
      risers: (saved.risers || []).map((r) => ({ key: key('R'), x: r.x, y: r.y })),
      pump: saved.pump ? { x: saved.pump.x, y: saved.pump.y } : null,
      zones: (saved.zones || []).map((z) => ({ key: key('Z'), kind: z.kind, x: z.x, y: z.y, radiusFt: z.radiusFt })),
      idCounter: extras,
    },
  };
}

// Same key as the server's (server/services/misting-layout-validate.js): case, spacing and punctuation blind, with a
// trailing Florida ZIP and then a trailing state taken off. A street suffix, direction, unit or city stays in the key.
const addressKey = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/ \d{5}(?: \d{4})?$/, '')
  .replace(/ (?:fl|florida)$/, '');

/**
 * True when a saved layout was drawn for a different address than the estimate has now. Its geometry sits on the
 * old property's photo, so it must not be reopened (or re-labeled with the new address) for the new property.
 * A layout saved with no address, or an estimate with no address, is not judged. Same rule as the server's sameProperty
 * (server/services/misting-layout-validate.js), which keeps the estimate document from printing the old property's sketch.
 */
export function savedLayoutIsForOtherAddress(saved, address) {
  if (!saved || !addressKey(saved.address) || !addressKey(address)) return false;
  return addressKey(saved.address) !== addressKey(address);
}

const layoutPath = (estimateId) => `/admin/estimates/${encodeURIComponent(estimateId)}/misting-layout`;

/** The saved layout for an estimate, or null. Throws when the request fails, so the caller never overwrites a layout it could not read. */
export async function fetchSavedLayout(estimateId) {
  const res = await adminFetch(layoutPath(estimateId));
  return res?.layout || null;
}

/** Save: the composited PNG plus the JSON, as multipart. Returns the saved layout. */
export async function putLayout(estimateId, payload, pngBlob) {
  const form = new FormData();
  form.append('snapshot', pngBlob, 'misting-layout.png');
  form.append('payload', JSON.stringify(payload));
  const res = await adminFetch(layoutPath(estimateId), { method: 'PUT', body: form });
  return res?.layout || null;
}
