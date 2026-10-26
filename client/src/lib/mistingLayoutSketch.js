// Misting layout sketch, step 3 (GATE_MISTING_LAYOUT_DESIGNER): the pure layout math behind the saved PNG.
//
// DOM-free so it is unit-testable. The canvas drawing lives in mistingLayoutSketchCanvas.js and only
// consumes the model built here: numbered nozzles in walking order with their spray aim, risers with theirs, and the scale bar.
// The picture is the plain drawing; its title, counts, legend and concept note belong to the estimate document's card.
import { MAP_HEIGHT, MAP_WIDTH, pxToFeet } from '../components/tech/treatmentZoneSpray';
import { aimHandle, aimReachPx, effectiveAim } from './mistingLayoutAim';
import { insideAnyZone, zoneKindDef } from './mistingLayoutExtras';

// Sketch canvas: the satellite photo at its native size, filling the frame, with the drawing over it. The photo's
// bottom strip is where Google prints its attribution; nothing of ours is drawn on it.
export const SKETCH_WIDTH = MAP_WIDTH;
export const SKETCH_HEIGHT = MAP_HEIGHT;
export const SKETCH_ATTRIBUTION_H = 44;

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Nearest point of one polyline to `p`: its distance and its arc length from the line's first point.
function projectOnLine(points, p) {
  let best = { dist: Infinity, arc: 0 };
  let walked = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(len2);
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = distance(p, { x: a.x + dx * t, y: a.y + dy * t });
    if (d < best.dist - 1e-9) best = { dist: d, arc: walked + segLen * t };
    walked += segLen;
  }
  return best;
}

function lineFor(lines, nozzle) {
  const idx = Number(nozzle.lineIndex);
  if (Number.isInteger(idx) && idx >= 0 && idx < lines.length && lines[idx].points.length > 1) {
    return { index: idx, ...projectOnLine(lines[idx].points, nozzle) };
  }
  // No usable line index (a nozzle added after a restore): the closest drawn line.
  let best = { index: lines.length, dist: Infinity, arc: 0 };
  lines.forEach((line, index) => {
    if (line.points.length < 2) return;
    const hit = projectOnLine(line.points, nozzle);
    if (hit.dist < best.dist - 1e-9) best = { index, ...hit };
  });
  return best;
}

/**
 * Number the final nozzles 1..N in walking order: line by line in the order drawn, and along each
 * line by how far its nearest point on the line is from the line's first point. A moved nozzle keeps
 * its line, so an edit never renumbers a neighbour out of order. Ties break on position, so the
 * order is deterministic.
 * @returns {Array<object>} copies of the nozzles with `number` set, sorted by number
 */
export function numberNozzles(nozzles, lines) {
  const drawn = Array.isArray(lines) ? lines : [];
  return (nozzles || [])
    .map((n) => ({ n, at: lineFor(drawn, n) }))
    .sort((a, b) => a.at.index - b.at.index || a.at.arc - b.at.arc || a.n.x - b.n.x || a.n.y - b.n.y)
    .map(({ n }, i) => ({ ...n, number: i + 1 }));
}

const SCALE_STEPS_FT = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];

/**
 * A scale bar for the footer: the longest round number of feet that fits in `maxPx` sketch pixels,
 * and its length in pixels, from the same px-to-feet math as the placement (so it is true to the map).
 */
export function scaleBar(lat, zoom, maxPx = 300) {
  const ftPerPx = pxToFeet(1, lat, zoom);
  let feet = SCALE_STEPS_FT[0];
  SCALE_STEPS_FT.forEach((step) => { if (step / ftPerPx <= maxPx) feet = step; });
  return { feet, px: feet / ftPerPx };
}

export function zoneLabel(zone) {
  return `No mist: ${zoneKindDef(zone.kind).label}`;
}

/**
 * Everything the canvas needs, from the designer's final geometry.
 * Nozzles come back with `flagged` true when inside a zone, and with their spray aim: `aimHeading`
 * (degrees, a manual aim when the nozzle has one), `nearWater`, `reachPx` (the throw in map pixels) and `arrowPx`
 * (the arrow's length).
 * @param {{lat:number, zoom:number, lines:Array, nozzles:Array, risers:Array,
 *          pump:object|null, zones:Array<{kind,x,y,radiusFt,radiusPx}>}} layout
 */
export function buildSketchModel(layout) {
  const zones = layout.zones || [];
  // A nozzle inside a no-mist zone (the designer's own rule, insideAnyZone) is flagged, so the sketch
  // draws it amber, with a ring and a "!", instead of printing it as any other nozzle.
  const map = { lat: layout.lat, zoom: layout.zoom };
  const numbered = numberNozzles(layout.nozzles, layout.lines);
  const nozzles = numbered.map((n) => {
    const aim = effectiveAim(n, layout.lines, zones, map);
    return {
      ...n,
      flagged: insideAnyZone(n, zones, layout.lat, layout.zoom),
      aimHeading: aim.heading,
      nearWater: aim.nearWater,
      reachPx: aimReachPx(aim, layout.lat, layout.zoom),
      arrowPx: aimHandle(n, aim.heading, numbered).lengthPx,
    };
  });
  // A riser carries a nozzle, so it sprays too: the same default aim, along the bed line it stands on when it has one.
  const risers = (layout.risers || []).map((r) => {
    const aim = effectiveAim(r, layout.lines, zones, map);
    return { ...r, aimHeading: aim.heading, nearWater: aim.nearWater, reachPx: aimReachPx(aim, layout.lat, layout.zoom) };
  });
  return {
    lines: layout.lines || [],
    nozzles,
    risers,
    pump: layout.pump || null,
    zones,
    scale: scaleBar(layout.lat, layout.zoom),
  };
}
