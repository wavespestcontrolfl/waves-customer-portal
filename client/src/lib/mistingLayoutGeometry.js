// Mosquito misting layout designer: nozzle placement geometry (GATE_MISTING_LAYOUT_DESIGNER).
//
// React-free and DOM-free so it is unit-testable. Lines live in the Static Maps
// physical pixel space the Treatment Zone Mapper uses (treatmentZoneSpray.js);
// feet come from that module's pxToFeet(px, lat, zoom), so the scale is the same
// everywhere on the staff screens.
//
// Rules (concept layout only, final placement is set at the design visit):
//   1. Anchors first: one nozzle at a vertex of every line. A vertex within the
//      minimum spacing (3 ft) of an anchor already placed merges into it (the first one
//      kept), so a closed loop's repeated first and last vertex, and two lines that touch,
//      share one nozzle. A corner closer than half the spacing (5 ft), measured along the
//      line, to the previous kept nozzle of the same line, or to the line's last point, is
//      dropped: a roofline with 3 to 6 ft jogs (a garage, an entry) gets one nozzle there,
//      not one per step. The first and last point of a line always keep theirs.
//   2. Then each line is walked as stretches between consecutive anchors (a stretch can run
//      past dropped corners), and each stretch of L ft along the line gets
//      ceil(L / spacing) - 1 evenly spaced interior nozzles, so no gap along a line exceeds
//      the spacing (10 ft) by construction. Interior points of one stretch are at least
//      spacing / 2 from each other and from its anchors, along the line.
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

// Evenly spaced interior points along a path (points with x, y): ceil(length / spacing) - 1 of them,
// each with its arc position `t` and the index `j` of the path edge it falls on.
function evenPointsAlong(path, spacingPx) {
  const cum = [0];
  for (let i = 1; i < path.length; i += 1) cum.push(cum[i - 1] + distance(path[i - 1], path[i]));
  const len = cum[cum.length - 1];
  const gaps = Math.max(1, Math.ceil(len / spacingPx - EPS));
  const candidates = [];
  for (let k = 1; k < gaps; k += 1) {
    const t = (len * k) / gaps;
    let j = 0;
    while (j + 2 < path.length && cum[j + 1] <= t) j += 1;
    const f = cum[j + 1] > cum[j] ? (t - cum[j]) / (cum[j + 1] - cum[j]) : 0;
    candidates.push({
      t,
      j,
      x: path[j].x + (path[j + 1].x - path[j].x) * f,
      y: path[j].y + (path[j + 1].y - path[j].y) * f,
    });
  }
  return { cum, candidates };
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
  const cornerMergeFt = Number(options.cornerMergeFt) >= 0 ? Number(options.cornerMergeFt) : spacingFt / 2;
  const cornerPx = Math.max(cornerMergeFt / ftPerPx, minPx);
  const samePx = SAME_POINT_FT / ftPerPx;

  const cleaned = (Array.isArray(lines) ? lines : []).map((line, lineIndex) => ({
    id: lineId(line, lineIndex),
    kind: lineKind(line),
    points: cleanPoints(line && line.points, samePx),
  }));

  const placed = [];
  const tooClose = (p) => placed.find((n) => distance(n, p) < minPx - EPS) || null;

  // 1. Anchors: a nozzle at every vertex, except a corner that sits within cornerPx (along the line)
  // of the previous kept nozzle or of the line's last point. A vertex within the minimum spacing of
  // a nozzle already placed merges into it (the first one kept). vertexAnchor[line][i] is null for a
  // dropped corner.
  const arcs = cleaned.map((line) => {
    const out = [0];
    for (let i = 1; i < line.points.length; i += 1) out.push(out[i - 1] + distance(line.points[i - 1], line.points[i]));
    return out;
  });
  // The nozzle for vertex i of a line: an existing one within the minimum spacing, else a new corner.
  const anchorAt = (lineIndex, i) => {
    const line = cleaned[lineIndex];
    const pt = line.points[i];
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
  };
  const vertexAnchor = cleaned.map((line, lineIndex) => {
    const total = arcs[lineIndex][line.points.length - 1] || 0;
    let lastKept = 0;
    return line.points.map((pt, i) => {
      const arc = arcs[lineIndex][i];
      const endpoint = i === 0 || i === line.points.length - 1;
      if (!endpoint && (arc - lastKept < cornerPx - EPS || total - arc < cornerPx - EPS)) return null;
      lastKept = arc;
      return anchorAt(lineIndex, i);
    });
  });

  // 2 and 3. Fill one stretch between two nozzles. `path` is the line from `a` to `b` (past any
  // dropped corners); each path point carries `seg`, the line segment that starts there. Returns the
  // nozzles strictly between a and b, in order (new interior nozzles, and existing ones the stretch
  // was split at). A path that bends (it runs past dropped corners) can double back on itself, so a
  // point could land within the minimum spacing of a nozzle the stretch cannot split at; it returns
  // null then, and the caller keeps those corners instead.
  const fillStretch = (a, b, path, meta, seen) => {
    const { cum, candidates } = evenPointsAlong(path, spacingPx);
    const bent = path.length > 2;
    if (bent) {
      for (let c = 1; c < candidates.length; c += 1) {
        if (distance(candidates[c - 1], candidates[c]) < minPx - EPS) return null;
      }
    }
    for (let c = 0; c < candidates.length; c += 1) {
      const blocker = tooClose(candidates[c]);
      if (bent && blocker && (seen.has(blocker) || blocker === a || blocker === b)) return null;
      if (blocker && !seen.has(blocker) && blocker !== a && blocker !== b) {
        const nextSeen = new Set(seen).add(blocker);
        const { j, t } = candidates[c];
        // Split the path where the candidate was, through the blocker.
        const before = [...path.slice(0, j + 1).filter((_, i) => cum[i] < t - EPS || i === 0), { x: blocker.x, y: blocker.y, seg: path[j].seg }];
        const after = [{ x: blocker.x, y: blocker.y, seg: path[j].seg }, ...path.slice(j + 1).filter((_, i) => cum[j + 1 + i] > t + EPS)];
        const first = fillStretch(a, blocker, before, meta, nextSeen);
        const second = first && fillStretch(blocker, b, after, meta, nextSeen);
        return second ? [...first, blocker, ...second] : null;
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
        segmentIndex: path[pt.j].seg,
        vertexIndex: null,
        corner: false,
      };
      placed.push(nozzle);
      return nozzle;
    });
  };

  // Walk one line from kept nozzle to kept nozzle and fill each stretch. Returns the nozzles in walking order.
  const walkLine = (line, lineIndex) => {
    const pts = line.points;
    const anchors = vertexAnchor[lineIndex];
    const keptAt = [];
    anchors.forEach((a, i) => { if (a) keptAt.push(i); });
    // Nozzles along the line in walking order (a shared anchor can appear twice on a loop).
    const sequence = keptAt.length ? [anchors[keptAt[0]]] : [];
    for (let k = 0; k + 1 < keptAt.length;) {
      const ia = keptAt[k];
      const ib = keptAt[k + 1];
      const a = anchors[ia];
      const b = anchors[ib];
      // A hairpin that comes back to the same nozzle needs a fill only when it is longer than a gap.
      if (a === b && arcs[lineIndex][ib] - arcs[lineIndex][ia] <= spacingPx + EPS) {
        k += 1;
        continue;
      }
      const path = [{ x: a.x, y: a.y, seg: ia }];
      for (let j = ia + 1; j < ib; j += 1) path.push({ x: pts[j].x, y: pts[j].y, seg: j });
      path.push({ x: b.x, y: b.y, seg: ib - 1 });
      const mark = placed.length;
      const fill = fillStretch(a, b, path, { line, lineIndex, segment: ia, count: 0 }, new Set());
      if (fill) {
        sequence.push(...fill, b);
        k += 1;
      } else {
        // The bent stretch cannot be filled cleanly: undo it and keep its corners instead.
        placed.length = mark;
        const restored = [];
        for (let j = ia + 1; j < ib; j += 1) {
          anchors[j] = anchorAt(lineIndex, j);
          restored.push(j);
        }
        keptAt.splice(k + 1, 0, ...restored);
      }
    }
    return sequence;
  };

  const lineStats = cleaned.map((line, lineIndex) => {
    const pts = line.points;
    const total = arcs[lineIndex][pts.length - 1] || 0;
    const sequence = walkLine(line, lineIndex);
    // A loop is a line whose last vertex is back on its first (within the minimum spacing).
    const closed = pts.length >= 4 && distance(pts[0], pts[pts.length - 1]) <= Math.max(minPx, samePx);
    return { id: line.id, kind: line.kind, closed, lengthFt: total * ftPerPx, nozzleCount: 0, keys: sequence.map((n) => n.key) };
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
 * Keys are unique within one placement only. Edits are valid for the lines they were made on;
 * when the lines change, placement is redone and the caller discards the edits.
 */
export function applyNozzleEdits(nozzles, edits = {}) {
  const removed = new Set(edits.removed || []);
  const moved = edits.moved || {};
  const untouched = [];
  const byKey = new Map();
  (nozzles || []).forEach((n) => {
    if (removed.has(n.key)) return;
    const m = moved[n.key];
    if (m && validPoint(m)) byKey.set(n.key, { ...n, x: m.x, y: m.y, edited: true });
    else untouched.push(n);
  });
  // Most recently edited last, so a tap on overlapping nozzles takes the newest first.
  const movedOut = Object.keys(moved).filter((k) => byKey.has(k)).map((k) => byKey.get(k));
  const addedOut = (edits.added || [])
    .filter((n) => !removed.has(n.key) && validPoint(n))
    .map((n) => ({ ...n, edited: true }));
  return [...untouched, ...movedOut, ...addedOut];
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
 * Index of the nozzle a tap at `p` selects, or -1: the nearest nozzle within `radiusPx`.
 * When nozzles overlap (equal distance), the one later in the list wins, which is the most
 * recently added or moved one (applyNozzleEdits lists those last), so each tap peels one off.
 */
export function hitNozzleIndex(nozzles, p, radiusPx) {
  let best = -1;
  let bestDistance = Infinity;
  (nozzles || []).forEach((n, i) => {
    const d = distance(n, p);
    if (d <= radiusPx && d <= bestDistance + EPS) {
      best = i;
      bestDistance = Math.min(bestDistance, d);
    }
  });
  return best;
}
