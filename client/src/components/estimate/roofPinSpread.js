// Spreads roof point badges that would sit on top of each other on the county roof photo (owner "zoom" follow-up, 2026-11-21).
// On a 390 px phone the photo is about 294 px wide for about 60 m of ground, and a badge is 26 px, so two points less than
// about 5 m apart hide each other's number. Pure math, no DOM: the card measures the photo and calls spreadPins.
//
// A point is "crowded" when another point is closer than the badge width plus a 2 px gap. Rules:
//  - No crowded point: every badge keeps its true position exactly (the page as it was).
//  - A point that is not crowded never moves.
//  - Nudge: when pushing each overlapping pair apart moves no badge more than NUDGE_PX, the badges take those
//    positions. Each still sits on its point, so the card draws nothing else.
//  - Call out: otherwise every crowded point gets a dot on its true place and its badge moves off it, to the nearest
//    spot that is inside the photo, clear of every other badge, and CALLOUT_GAP_PX of roof away from every dot. The card
//    draws a line from the dot to the badge. The dots are known before any badge is placed, so no badge is put on a dot:
//    a badge that moved only a little used to cover its own dot and line, and the customer saw a number and no place.
//  - A photo too full for that keeps the badges apart first and lets a dot go under a badge; with no free spot at all
//    the badge stays on its point.
// Badges are placed in pin order, one pass, no randomness: the same input always gives the same output.

const GAP_PX = 2;
const NUDGE_PASSES = 60;
const SETTLED_EPSILON_PX = 0.05;
const GOLDEN_ANGLE = 2.399963229728653;
const MOVED_PX = 0.01;
// A badge this close to its true point still marks it (about 1.2 m on a phone): no dot, no line.
const NUDGE_PX = 6;
// The dot the card draws at a called-out point, and the clear roof between that dot and the rim of any badge.
export const DOT_PX = 8;
const CALLOUT_GAP_PX = 5;
// The search for a free spot looks on rings this far apart, at points this far apart along each ring.
const RING_STEP_PX = 4;

const unit = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

const gapBetween = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const clearOf = (p, others, dist) => others.every((q) => gapBetween(p, q) >= dist - SETTLED_EPSILON_PX);

// For each point: is another point's true place closer than a badge plus the gap?
const crowdedFlags = (pts, minDist) => pts.map((p, i) => pts.some((q, j) => j !== i && gapBetween(p.from, q.from) < minDist));

// One pass over every pair of badges; returns true when a pair was still too close before it moved.
function pushApart(pts, minDist) {
  let pushed = false;
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const a = pts[i];
      const b = pts[j];
      const d = gapBetween(a, b);
      // Two badges on one spot have no line between them: that pair is called out, never nudged.
      if (d >= minDist - SETTLED_EPSILON_PX || d < 1e-6) continue;
      pushed = true;
      const half = (minDist - d) / 2;
      const ux = (b.x - a.x) / d;
      const uy = (b.y - a.y) / d;
      a.x -= ux * half;
      a.y -= uy * half;
      b.x += ux * half;
      b.y += uy * half;
    }
  }
  return pushed;
}

// The nudged positions, or null when a nudge is not enough: a badge would move more than NUDGE_PX or leave the photo,
// a point that is not crowded would move, or two badges would still overlap after the passes.
function nudged(pts, crowded, { minDist, lo, hi }) {
  const next = pts.map((p) => ({ x: p.x, y: p.y, from: p.from }));
  for (let pass = 0; pass < NUDGE_PASSES; pass += 1) {
    if (!pushApart(next, minDist)) break;
  }
  const fits = next.every((p, i) => {
    const moved = gapBetween(p, p.from);
    if (moved <= MOVED_PX) return true;
    return crowded[i] && moved <= NUDGE_PX && p.x >= lo && p.x <= hi && p.y >= lo && p.y <= hi;
  });
  const apart = next.every((p, i) => clearOf(p, next.slice(i + 1), minDist));
  return fits && apart ? next : null;
}

// The direction a called-out badge leaves its point in: away from the middle of the crowded points around it, or, with
// none around it or all on its own spot, a direction fixed by its index.
function outwardAngle(pts, crowded, i, reach) {
  const own = pts[i].from;
  const near = pts.filter((q, j) => j !== i && crowded[j] && gapBetween(own, q.from) < reach).map((q) => q.from);
  const mid = { x: near.reduce((s, q) => s + q.x, 0) / (near.length || 1), y: near.reduce((s, q) => s + q.y, 0) / (near.length || 1) };
  if (!near.length || gapBetween(own, mid) < 1e-6) return i * GOLDEN_ANGLE;
  return Math.atan2(own.y - mid.y, own.x - mid.x);
}

// The first spot that passes `free`, looking on rings around `from` from `startR` out, and on each ring from `angle`
// to both sides in turn. null when no ring inside the photo has one.
function spotAround(from, { startR, angle, farthest }, free) {
  for (let r = startR; r <= farthest; r += RING_STEP_PX) {
    const steps = Math.max(16, Math.ceil((2 * Math.PI * r) / RING_STEP_PX));
    for (let k = 0; k < steps; k += 1) {
      const turn = Math.ceil(k / 2) * (k % 2 ? 1 : -1);
      const a = angle + (turn * 2 * Math.PI) / steps;
      const spot = { x: from.x + r * Math.cos(a), y: from.y + r * Math.sin(a) };
      if (free(spot)) return spot;
    }
  }
  return null;
}

// Move every crowded badge off its point, in pin order. `placed` starts as the badges that do not move.
function callOut(pts, crowded, { minDist, dotClear, lo, hi }) {
  const dots = pts.filter((_, i) => crowded[i]).map((p) => p.from);
  const placed = pts.filter((_, i) => !crowded[i]);
  const inside = (s) => s.x >= lo && s.x <= hi && s.y >= lo && s.y <= hi;
  const apart = (s) => inside(s) && clearOf(s, placed, minDist);
  const farthest = (hi - lo) * Math.SQRT2;
  pts.forEach((p, i) => {
    if (!crowded[i]) return;
    const angle = outwardAngle(pts, crowded, i, minDist * 2);
    const spot = spotAround(p.from, { startR: dotClear, angle, farthest }, (s) => apart(s) && clearOf(s, dots, dotClear))
      || spotAround(p.from, { startR: RING_STEP_PX, angle, farthest }, apart);
    if (spot) {
      p.x = spot.x;
      p.y = spot.y;
    }
    placed.push(p);
  });
}

// pins: [{ x, y }] as 0-1 fractions of the photo. sizePx: the photo's width (it is square). pinPx: the badge width.
// Returns one entry per pin, in the same order: { x, y } the position to draw the badge at (fractions), { fromX, fromY }
// the true point, shiftPx how far the badge moved in px, moved (true when it moved at all) and callout (true when the
// card draws a dot at the true point and a line to the badge).
export function spreadPins(pins, sizePx, pinPx = 26) {
  const base = (Array.isArray(pins) ? pins : []).map((p) => ({ x: unit(p?.x), y: unit(p?.y) }));
  const still = () => base.map((b) => ({ x: b.x, y: b.y, fromX: b.x, fromY: b.y, shiftPx: 0, moved: false, callout: false }));
  const size = Number(sizePx);
  if (!Number.isFinite(size) || size <= 0 || base.length < 2 || size < pinPx * 2) return still();
  const minDist = pinPx + GAP_PX;
  const pts = base.map((b) => ({ x: b.x * size, y: b.y * size, from: { x: b.x * size, y: b.y * size } }));
  const crowded = crowdedFlags(pts, minDist);
  if (!crowded.some(Boolean)) return still();

  const lo = pinPx / 2;
  const hi = size - pinPx / 2;
  const laid = nudged(pts, crowded, { minDist, lo, hi });
  if (!laid) callOut(pts, crowded, { minDist, dotClear: pinPx / 2 + DOT_PX / 2 + CALLOUT_GAP_PX, lo, hi });
  return (laid || pts).map((p, i) => {
    const shiftPx = gapBetween(p, p.from);
    const moved = shiftPx > MOVED_PX;
    return { x: moved ? p.x / size : base[i].x, y: moved ? p.y / size : base[i].y, fromX: base[i].x, fromY: base[i].y, shiftPx: moved ? shiftPx : 0, moved, callout: Boolean(!laid && crowded[i] && moved) };
  });
}
