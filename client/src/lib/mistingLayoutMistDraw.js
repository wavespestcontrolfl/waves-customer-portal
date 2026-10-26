// Misting layout: the spray-direction marks that the designer's still wedge and the saved sketch share
// (GATE_MISTING_LAYOUT_DESIGNER). Canvas 2D only, no DOM, so a recording context can test it.
//
// An aim arrow runs from just outside the nozzle's dot out to its tip (AIM_ARROW_PX from the nozzle's center, less near a neighbour), so
// it can be drawn over the dots without hiding a number. The mist wedge is the
// still frame of the spray: a translucent fan, 0.9 rad wide, as long as the nozzle's throw.
//
// The mist is the Treatment Zone Mapper's: the brand blue (MIST_COLOR #0A7EC2) with a white-mixed core, as that
// tool's spray puffs, and the traced line's layered glow (mistTraceStrokes), so the pest report's trace and a
// misting layout look like the same product. The helpers come from treatmentZoneSpray.js.
import { MIST_COLOR, MIST_LIGHT_MIX, hexToRgb, mixWithWhite, rgba } from '../components/tech/treatmentZoneSpray';
import { AIM_ARROW_PX, aimVector } from './mistingLayoutAim';

const MIST = hexToRgb(MIST_COLOR);
const MIST_LIGHT = mixWithWhite(MIST, MIST_LIGHT_MIX);
const MIST_CORE = mixWithWhite(MIST, 0.5);

export const MIST_ARROW = '#7dd3fc';
export const MIST_ARROW_NEAR_WATER = '#fbbf24';
// Flat fill for a canvas that cannot make gradients; the real wedge is a radial gradient of the same blue.
export const MIST_WEDGE_FILL = rgba(MIST_LIGHT, 0.3);
const MIST_WEDGE_EDGE = rgba(MIST, 0.4);
export const MIST_HALF_SPREAD_RAD = 0.45;
const HEAD_LENGTH = 10;
const HEAD_HALF_WIDTH = 7;

/** The arrow's tip in map pixels; `lengthPx` is the arrow's length (aimArrowLength), full length by default. */
export function aimTip(nozzle, heading, lengthPx = AIM_ARROW_PX) {
  const v = aimVector(heading);
  return { x: nozzle.x + v.x * lengthPx, y: nozzle.y + v.y * lengthPx };
}

/**
 * The layered glow of a traced eave or fence line, bottom to top, as the Treatment Zone Mapper draws its trace:
 * a wide soft blue, a white core and a narrow strong blue. `color` is a CSS color string.
 */
export const MIST_TRACE_STROKES = Object.freeze([
  { width: 16, color: rgba(MIST, 0.28) },
  { width: 9, color: rgba([255, 255, 255], 0.6) },
  { width: 4.5, color: rgba(MIST, 0.92) },
]);

// A radial gradient from the white-mixed core of the mist out to clear, or null where the canvas has none.
function mistGradient(ctx, x, y, r, alpha, outer = 0) {
  const g = ctx.createRadialGradient && ctx.createRadialGradient(x, y, 0, x, y, r);
  if (!g || !g.addColorStop) return null;
  g.addColorStop(0, rgba(MIST_CORE, alpha));
  g.addColorStop(0.55, rgba(MIST_LIGHT, alpha * 0.6));
  g.addColorStop(1, rgba(MIST, outer));
  return g;
}

/** One soft puff of mist at (x, y), `r` wide, `alpha` at its core: the Treatment Zone Mapper's puff. */
export function drawMistPuff(ctx, x, y, r, alpha) {
  ctx.fillStyle = mistGradient(ctx, x, y, r, alpha) || rgba(MIST_LIGHT, alpha * 0.6);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** A translucent fan from the nozzle along `heading`, `reachPx` long: blue, brightest at the nozzle, fading out. */
export function drawMistWedge(ctx, nozzle, heading, reachPx) {
  const v = aimVector(heading);
  const a0 = Math.atan2(v.y, v.x);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(nozzle.x, nozzle.y);
  ctx.arc(nozzle.x, nozzle.y, reachPx, a0 - MIST_HALF_SPREAD_RAD, a0 + MIST_HALF_SPREAD_RAD);
  ctx.closePath();
  ctx.fillStyle = mistGradient(ctx, nozzle.x, nozzle.y, reachPx, 0.55, 0.12) || MIST_WEDGE_FILL;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = MIST_WEDGE_EDGE;
  ctx.stroke();
  ctx.restore();
}

/** A short arrow from `fromPx` out of the nozzle (the dot's edge) to its tip, amber when the nozzle is near water. */
export function drawAimArrow(ctx, nozzle, heading, nearWater, fromPx = 0, lengthPx = AIM_ARROW_PX) {
  const v = aimVector(heading);
  const color = nearWater ? MIST_ARROW_NEAR_WATER : MIST_ARROW;
  const shaft = lengthPx - HEAD_LENGTH;
  const ex = nozzle.x + v.x * shaft;
  const ey = nozzle.y + v.y * shaft;
  ctx.save();
  ctx.lineCap = 'round';
  const sx = nozzle.x + v.x * fromPx;
  const sy = nozzle.y + v.y * fromPx;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = color;
  ctx.stroke();
  const tip = { x: ex + v.x * HEAD_LENGTH, y: ey + v.y * HEAD_LENGTH };
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(ex - v.y * HEAD_HALF_WIDTH, ey + v.x * HEAD_HALF_WIDTH);
  ctx.lineTo(ex + v.y * HEAD_HALF_WIDTH, ey - v.x * HEAD_HALF_WIDTH);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}
