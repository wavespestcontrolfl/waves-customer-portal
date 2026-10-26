// Mosquito misting layout designer: nozzle placement geometry (GATE_MISTING_LAYOUT_DESIGNER).
//
// React-free and DOM-free so it is unit-testable. Lines live in the Static Maps
// physical pixel space the Treatment Zone Mapper uses (treatmentZoneSpray.js);
// feet come from that module's pxToFeet(px, lat, zoom), so the scale is the same
// everywhere on the staff screens.
//
// Rules (concept layout only, final placement is set at the design visit):
//   1. Anchors first: one nozzle at every vertex of every line. A vertex within the
//      minimum spacing (3 ft) of an anchor already placed merges into it (the first one
//      kept), so a closed loop's repeated first and last vertex, and two lines that touch,
//      share one nozzle.
//   2. Then each line is walked as stretches between consecutive anchors, and each stretch
//      of L ft gets ceil(L / spacing) - 1 evenly spaced interior nozzles, so no gap along a
//      line exceeds the spacing (10 ft) by construction. Interior points of one stretch are
//      at least spacing / 2 from each other and from its anchors.
//   3. If an interior point would land within the minimum spacing of a nozzle that already
//      exists (a line crossing mid-segment), the stretch is split at that nozzle, which
//      becomes an anchor of this line too, and both halves are refilled. Nothing is dropped
//      after the fact, so the maximum gap and the minimum spacing both hold.
//      (The minimum spacing is capped at half the nominal spacing; that is what makes the
//      refill never crowd its own anchors.)
//
// Kinds: 'eave' and 'fence'. Both get nozzles; totals are kept apart.

import { pxToFeet } from '../components/tech/treatmentZoneSpray';

export const LINE_KINDS = Object.freeze(['eave', 'fence']);
export const NOMINAL_SPACING_FT = 10;
export const MIN_SPACING_FT = 3;
// Consecutive vertices closer than this are one vertex (a double tap), not a
// segment. Well under the minimum spacing.
const SAME_POINT_FT = 0.25;
const EPS = 1e-9;

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function feetPerPixel(lat, zoom) {
  return pxToFeet(1, lat, zoom);
}

function validPoint(p) {
  return p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

// Drops invalid points and consecutive duplicates. Returns the surviving points
// with the index they had in the input, so a caller can map back if it needs to.
function cleanPoints(points, samePointPx) {
  const out = [];
  (Array.isArray(points) ? points : []).forEach((p) => {
    if (!validPoint(p)) return;
    const last = out[out.length - 1];
    if (last && distance(last, p) <= samePointPx) return;
    out.push({ x: p.x, y: p.y });
  });
  return out;
}

function lineKind(line) {
  return line && line.kind === 'fence' ? 'fence' : 'eave';
}

function lineId(line, index) {
  return line && line.id !== undefined && line.id !== null ? String(line.id) : String(index);
}

/** Length of a cleaned polyline in feet. */
export function polylineFeet(points, lat, zoom, samePointFt = SAME_POINT_FT) {
  const ftPerPx = feetPerPixel(lat, zoom);
  const pts = cleanPoints(points, samePointFt / ftPerPx);
  let px = 0;
  for (let i = 1; i < pts.length; i += 1) px += distance(pts[i - 1], pts[i]);
  return px * ftPerPx;
}

/**
 * Place nozzles on a set of lines.
 *
 * @param {Array<{id?: string|number, kind: 'eave'|'fence', points: Array<{x:number,y:number}>}>} lines
 * @param {{lat: number, zoom: number, spacingFt?: number, minSpacingFt?: number}} options
 * @returns {{
 *   nozzles: Array<{key: string, x: number, y: number, kind: string, lineIndex: number, lineId: string,
 *                   segmentIndex: number, vertexIndex: number|null, corner: boolean}>,
 *   lines: Array<{id: string, kind: string, closed: boolean, lengthFt: number, nozzleCount: number,
 *                 keys: string[] (nozzle keys in walking order along the line)}>,
 *   totals: {count: number, eaveCount: number, fenceCount: number, linearFt: number, eaveFt: number, fenceFt: number},
 * }}
 */
export function placeNozzles(lines, options = {}) {
  const { lat, zoom } = options;
  const spacingFt = Number(options.spacingFt) > 0 ? Number(options.spacingFt) : NOMINAL_SPACING_FT;
  const minSpacingFt = Number(options.minSpacingFt) >= 0 ? Number(options.minSpacingFt) : MIN_SPACING_FT;
  if (!Number.isFinite(lat) || !Number.isFinite(zoom)) {
    throw new Error('placeNozzles needs the map latitude and zoom to convert pixels to feet.');
  }
  const ftPerPx = feetPerPixel(lat, zoom);
  const spacingPx = spacingFt / ftPerPx;
  const minPx = Math.min(minSpacingFt, spacingFt / 2) / ftPerPx;
  const samePx = SAME_POINT_FT / ftPerPx;

  const cleaned = (Array.isArray(lines) ? lines : []).map((line, lineIndex) => ({
    id: lineId(line, lineIndex),
    kind: lineKind(line),
    points: cleanPoints(line && line.points, samePx),
  }));

  const placed = [];
  const tooClose = (p) => placed.find((n) => distance(n, p) < minPx - EPS) || null;

  // 1. Anchors: every vertex of every line, merging near-duplicates into the first one kept.
  const vertexAnchor = cleaned.map((line, lineIndex) => line.points.map((pt, i) => {
    const near = tooClose(pt);
    if (near) return near;
    const anchor = {
      key: `${line.id}:v${i}`,
      x: pt.x,
      y: pt.y,
      kind: line.kind,
      lineIndex,
      lineId: line.id,
      // The last vertex closes the final segment; every other vertex opens one.
      segmentIndex: Math.min(i, Math.max(line.points.length - 2, 0)),
      vertexIndex: i,
      corner: true,
    };
    placed.push(anchor);
    return anchor;
  }));

  // 2 and 3. Fill one stretch between two nozzles. Returns the nozzles strictly between them,
  // in order (new interior nozzles, and existing ones the stretch was split at).
  const fillStretch = (a, b, meta, seen) => {
    const len = distance(a, b);
    const gaps = Math.max(1, Math.ceil(len / spacingPx - EPS));
    const candidates = [];
    for (let k = 1; k < gaps; k += 1) {
      candidates.push({ x: a.x + ((b.x - a.x) * k) / gaps, y: a.y + ((b.y - a.y) * k) / gaps });
    }
    for (let c = 0; c < candidates.length; c += 1) {
      const blocker = tooClose(candidates[c]);
      if (blocker && !seen.has(blocker) && blocker !== a && blocker !== b) {
        const nextSeen = new Set(seen).add(blocker);
        return [...fillStretch(a, blocker, meta, nextSeen), blocker, ...fillStretch(blocker, b, meta, nextSeen)];
      }
    }
    // No blocker (or a degenerate one already used to split this stretch): place the points.
    return candidates.map((pt) => {
      meta.count += 1;
      const nozzle = {
        key: `${meta.line.id}:s${meta.segment}:${meta.count}`,
        x: pt.x,
        y: pt.y,
        kind: meta.line.kind,
        lineIndex: meta.lineIndex,
        lineId: meta.line.id,
        segmentIndex: meta.segment,
        vertexIndex: null,
        corner: false,
      };
      placed.push(nozzle);
      return nozzle;
    });
  };

  const lineStats = cleaned.map((line, lineIndex) => {
    const pts = line.points;
    const anchors = vertexAnchor[lineIndex];
    let px = 0;
    // Nozzles along the line in walking order (a shared anchor can appear twice on a loop).
    const sequence = anchors.length ? [anchors[0]] : [];
    for (let i = 0; i + 1 < pts.length; i += 1) {
      px += distance(pts[i], pts[i + 1]);
      if (anchors[i] === anchors[i + 1]) continue;
      const meta = { line, lineIndex, segment: i, count: 0 };
      sequence.push(...fillStretch(anchors[i], anchors[i + 1], meta, new Set()), anchors[i + 1]);
    }
    // A loop is a line whose last vertex is back on its first (within the minimum spacing).
    const closed = pts.length >= 4 && distance(pts[0], pts[pts.length - 1]) <= Math.max(minPx, samePx);
    return { id: line.id, kind: line.kind, closed, lengthFt: px * ftPerPx, nozzleCount: 0, keys: sequence.map((n) => n.key) };
  });

  const accepted = placed;
  // Stable order: by line, then along the line.
  accepted.sort((a, b) => a.lineIndex - b.lineIndex
    || a.segmentIndex - b.segmentIndex
    || alongSegment(cleaned, a) - alongSegment(cleaned, b));

  accepted.forEach((n) => { lineStats[n.lineIndex].nozzleCount += 1; });
  return { nozzles: accepted, lines: lineStats, totals: computeTotals(lineStats, accepted) };
}

// Position of a nozzle along its segment, for ordering only.
function alongSegment(cleaned, n) {
  const pts = cleaned[n.lineIndex].points;
  const a = pts[n.segmentIndex];
  return a ? distance(a, n) : 0;
}

/** Counts and feet per kind. `lineStats` is placeNozzles().lines, `nozzles` the final set (after any edits). */
export function computeTotals(lineStats, nozzles) {
  let eaveFt = 0;
  let fenceFt = 0;
  (lineStats || []).forEach((l) => {
    if (l.kind === 'fence') fenceFt += l.lengthFt;
    else eaveFt += l.lengthFt;
  });
  let eaveCount = 0;
  let fenceCount = 0;
  (nozzles || []).forEach((n) => {
    if (n.kind === 'fence') fenceCount += 1;
    else eaveCount += 1;
  });
  return {
    count: eaveCount + fenceCount,
    eaveCount,
    fenceCount,
    linearFt: eaveFt + fenceFt,
    eaveFt,
    fenceFt,
  };
}

/**
 * Staff edits on top of the automatic placement: delete, move, add.
 * `edits` = { removed: string[] of nozzle keys, moved: { [key]: {x, y} }, added: nozzle objects }.
 * The automatic nozzle keys are stable while a line is unchanged, so an edit survives
 * a redraw of the line it belongs to; an edit whose key no longer exists is ignored.
 */
export function applyNozzleEdits(nozzles, edits = {}) {
  const removed = new Set(edits.removed || []);
  const moved = edits.moved || {};
  const out = [];
  (nozzles || []).forEach((n) => {
    if (removed.has(n.key)) return;
    const m = moved[n.key];
    out.push(m && validPoint(m) ? { ...n, x: m.x, y: m.y, edited: true } : n);
  });
  (edits.added || []).forEach((n) => {
    if (!removed.has(n.key) && validPoint(n)) out.push({ ...n, edited: true });
  });
  return out;
}

/** Closest point on any line to `p` within `thresholdPx`, or null. */
export function nearestPointOnLines(lines, p, thresholdPx) {
  let best = null;
  (Array.isArray(lines) ? lines : []).forEach((line, lineIndex) => {
    const pts = cleanPoints(line && line.points, 0);
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      const q = { x: a.x + dx * t, y: a.y + dy * t };
      const d = distance(p, q);
      if (d <= thresholdPx && (!best || d < best.distance)) {
        best = { x: q.x, y: q.y, distance: d, lineIndex, lineId: lineId(line, lineIndex), segmentIndex: i, kind: lineKind(line) };
      }
    }
  });
  return best;
}

/** Index of the nozzle nearest `p` within `thresholdPx`, or -1. */
export function nearestNozzleIndex(nozzles, p, thresholdPx) {
  let bestIndex = -1;
  let bestDistance = Infinity;
  (nozzles || []).forEach((n, i) => {
    const d = distance(n, p);
    if (d <= thresholdPx && d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  });
  return bestIndex;
}

const HIT_MAX_CSS_PX = 10;
const HIT_MIN_CSS_PX = 4;
const HIT_GAP_SHARE = 0.35;

/**
 * Tap radius for a nozzle, in map pixels. `cssScale` is map pixels per CSS pixel (the map's
 * logical width over its rendered width). The radius is 35% of the on-screen nominal nozzle
 * gap, clamped to 4..10 CSS px, so a small rendered map (phone) or a wider zoom keeps room
 * between two nozzles for a tap that adds one.
 */
export function nozzleHitRadiusPx(lat, zoom, cssScale, spacingFt = NOMINAL_SPACING_FT) {
  const scale = cssScale > 0 ? cssScale : 1;
  const gapCss = spacingFt / feetPerPixel(lat, zoom) / scale;
  const radiusCss = Math.max(HIT_MIN_CSS_PX, Math.min(HIT_MAX_CSS_PX, HIT_GAP_SHARE * gapCss));
  return radiusCss * scale;
}

/**
 * Index of the nozzle a tap at `p` hits, or -1. A hit needs the nearest nozzle within
 * `radiusPx` AND within 45% of the distance to that nozzle's own nearest neighbour, so the
 * tap midway between two nozzles never counts as a hit (it adds instead), float noise included.
 */
export function hitNozzleIndex(nozzles, p, radiusPx) {
  const list = nozzles || [];
  const idx = nearestNozzleIndex(list, p, radiusPx);
  if (idx < 0) return -1;
  const d = distance(list[idx], p);
  let nearestNeighbour = Infinity;
  list.forEach((n, i) => {
    if (i !== idx) nearestNeighbour = Math.min(nearestNeighbour, distance(n, list[idx]));
  });
  return d < nearestNeighbour * 0.45 ? idx : -1;
}
