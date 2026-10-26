// Misting layout designer: which way each nozzle sprays (GATE_MISTING_LAYOUT_DESIGNER).
//
// React-free and DOM-free. An aim is a compass heading in degrees, [0, 360): 0 points up the photo
// (north, Static Maps are north-up), 90 points right, 180 down, 270 left. A nozzle's own `aim` is set only by
// staff (drag the arrow tip in Edit nozzles); every other nozzle gets the default below, which is
// derived on every render and never stored.
//
// Default aim:
//   - Away from the house: the normal of the nozzle's line segment, pointing away from the centroid of
//     every eave-line point (the map center when there is no eave line). Throw 10 ft.
//   - Near water: a nozzle within 30 ft of the edge of a water or pool zone aims ALONG its line, in the
//     direction that points away from the nearest such zone, at half throw (5 ft). It is marked
//     `nearWater` so the screens can draw it amber.
// A saved manual aim wins over the default heading. The near-water mark and the throw still follow
// the nozzle's position, because the ground it stands on did not change.
import { MAP_HEIGHT, MAP_WIDTH, pxToFeet } from '../components/tech/treatmentZoneSpray';

export const THROW_FT = 10;
export const NEAR_WATER_THROW_FT = 5;
export const NEAR_WATER_DISTANCE_FT = 30;
export const WATER_ZONE_KINDS = Object.freeze(['water', 'pool']);
// Distance from a nozzle to its arrow tip, in map pixels. The tip is the drag handle in Edit nozzles. An arrow
// pointing at a neighbouring nozzle stops short of it (aimArrowLength), but never shorter than the minimum, so
// its head still shows.
export const AIM_ARROW_PX = 40;
export const AIM_ARROW_MIN_PX = 26;
const FORWARD_COS = Math.cos(Math.PI / 4); // a neighbour within 45 degrees of the aim is "ahead"


const EPS = 1e-9;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** A heading wrapped into [0, 360) and rounded to 0.01 degree, or null when it is not a finite number. */
export function normalizeAim(deg) {
  const n = typeof deg === 'string' && deg.trim() === '' ? NaN : Number(deg);
  if (deg === null || deg === undefined || !Number.isFinite(n)) return null;
  const wrapped = Math.round((((n % 360) + 360) % 360) * 100) / 100;
  return wrapped >= 360 ? 0 : wrapped;
}

/** Unit vector in map pixels (y grows downward) for a compass heading. */
export function aimVector(heading) {
  const rad = (heading * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

/** Compass heading of the direction (dx, dy) in map pixels, or null for a zero vector. */
export function headingFromVector(dx, dy) {
  if (Math.hypot(dx, dy) < EPS) return null;
  return normalizeAim((Math.atan2(dx, -dy) * 180) / Math.PI);
}

// The house is the eave lines: a fence or a bed line is not part of it.
const isEave = (line) => Boolean(line) && (line.kind === undefined || line.kind === 'eave');
const validPoint = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

// Mean of the eave-line vertices. A loop's closing vertex repeats its first, so it is counted once.
function houseCenter(lines) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  (Array.isArray(lines) ? lines : []).forEach((line) => {
    if (!isEave(line)) return;
    const pts = (line.points || []).filter(validPoint);
    const closed = pts.length >= 4 && distance(pts[0], pts[pts.length - 1]) < EPS;
    (closed ? pts.slice(0, -1) : pts).forEach((p) => { sx += p.x; sy += p.y; n += 1; });
  });
  return n > 0 ? { x: sx / n, y: sy / n } : { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
}

// Unit direction of the segment nearest to `p`, searching the nozzle's own line first.
function nearestSegmentDirection(lines, nozzle) {
  const all = Array.isArray(lines) ? lines : [];
  const own = Number.isInteger(nozzle.lineIndex) ? all[nozzle.lineIndex] : null;
  const searched = own && (own.points || []).filter(validPoint).length > 1 ? [own] : all;
  let best = null;
  searched.forEach((line) => {
    const pts = (line.points || []).filter(validPoint);
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < EPS) continue;
      const t = Math.max(0, Math.min(1, ((nozzle.x - a.x) * dx + (nozzle.y - a.y) * dy) / len2));
      const d = distance(nozzle, { x: a.x + dx * t, y: a.y + dy * t });
      if (!best || d < best.d - EPS) {
        const len = Math.sqrt(len2);
        best = { d, ux: dx / len, uy: dy / len };
      }
    }
  });
  return best;
}

// The water or pool zone whose edge is nearest to the nozzle, with that distance in feet (negative inside).
function nearestWater(nozzle, zones, lat, zoom) {
  let best = null;
  (Array.isArray(zones) ? zones : []).forEach((z) => {
    if (!WATER_ZONE_KINDS.includes(z.kind) || !validPoint(z)) return;
    const edgeFt = pxToFeet(distance(nozzle, z), lat, zoom) - Number(z.radiusFt || 0);
    if (!best || edgeFt < best.edgeFt) best = { zone: z, edgeFt };
  });
  return best;
}

/**
 * The automatic aim of a nozzle.
 * @param {{x:number,y:number,lineIndex?:number|null}} nozzle
 * @param {Array<{kind:string, points:Array<{x:number,y:number}>}>} lines the lines the nozzle sits on
 * @param {Array<{kind:string,x:number,y:number,radiusFt:number}>} zones
 * @param {{lat:number, zoom:number}} map
 * @returns {{heading:number, nearWater:boolean, throwFt:number}}
 */
export function defaultAim(nozzle, lines, zones, { lat, zoom }) {
  const seg = nearestSegmentDirection(lines, nozzle);
  const house = houseCenter(lines);
  const outX = nozzle.x - house.x;
  const outY = nozzle.y - house.y;

  const water = nearestWater(nozzle, zones, lat, zoom);
  if (water && water.edgeFt <= NEAR_WATER_DISTANCE_FT) {
    // Along the line, pointing away from the water. With no line to follow, straight away from the water.
    const awayX = nozzle.x - water.zone.x;
    const awayY = nozzle.y - water.zone.y;
    let dx = seg ? seg.ux : awayX;
    let dy = seg ? seg.uy : awayY;
    if (dx * awayX + dy * awayY < 0) { dx = -dx; dy = -dy; }
    return { heading: headingFromVector(dx, dy) ?? 0, nearWater: true, throwFt: NEAR_WATER_THROW_FT };
  }

  let dx = outX;
  let dy = outY;
  if (seg) {
    dx = -seg.uy;
    dy = seg.ux;
    if (dx * outX + dy * outY < 0) { dx = -dx; dy = -dy; }
  }
  return { heading: headingFromVector(dx, dy) ?? 0, nearWater: false, throwFt: THROW_FT };
}

/** The aim a screen draws: the nozzle's saved manual aim if it has one, else the default. `manual` says which. */
export function effectiveAim(nozzle, lines, zones, map) {
  const auto = defaultAim(nozzle, lines, zones, map);
  const manual = normalizeAim(nozzle.aim);
  return manual === null ? { ...auto, manual: false } : { ...auto, heading: manual, manual: true };
}

/**
 * How long a nozzle's arrow is, from its center to its tip. Nozzles on a line are about 10 ft apart, and a nozzle
 * aimed along its line (near water) points at the next one, so a full-length tip would sit on that nozzle and a tap
 * there could not tell the two apart. When another nozzle is ahead, the tip stops halfway to it.
 * @param {{x:number,y:number}} nozzle
 * @param {number} heading degrees
 * @param {Array<{x:number,y:number}>} nozzles every nozzle on the map (the nozzle itself is skipped)
 */
export function aimArrowLength(nozzle, heading, nozzles) {
  const v = aimVector(heading);
  let nearest = Infinity;
  (nozzles || []).forEach((o) => {
    if (o === nozzle) return;
    const dx = o.x - nozzle.x;
    const dy = o.y - nozzle.y;
    const d = Math.hypot(dx, dy);
    if (d < EPS || (dx * v.x + dy * v.y) / d < FORWARD_COS) return;
    nearest = Math.min(nearest, d);
  });
  return Math.max(AIM_ARROW_MIN_PX, Math.min(AIM_ARROW_PX, nearest / 2));
}

/** How far the mist travels, in map pixels. */
export function aimReachPx(aim, lat, zoom) {
  return aim.throwFt / pxToFeet(1, lat, zoom);
}
