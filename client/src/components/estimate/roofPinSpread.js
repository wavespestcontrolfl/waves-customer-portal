// Spreads roof point badges that would sit on top of each other on the county roof photo (owner "zoom" follow-up, 2026-11-21).
// On a 390 px phone the photo is about 294 px wide for about 60 m of ground, and a badge is 26 px, so two points less than
// about 5 m apart hide each other's number. Pure math, no DOM: the card measures the photo and calls spreadPins.
//
// Rules: if no two badges are closer than the badge width plus a 2 px gap, every badge keeps its true position exactly.
// Otherwise a small relaxation loop pushes each overlapping pair apart along the line between them (two badges on one
// spot use a direction taken from their indexes), keeps every badge fully inside the photo, and stops after a fixed
// number of passes. That loop only moves a pair along its own line, so a row of pins longer than the photo ends squeezed
// against the edges: a last pass (settle) moves each badge that still overlaps to the nearest free spot around it. The
// same input always gives the same output: there is no randomness.

const GAP_PX = 2;
const MAX_PASSES = 300;
const SETTLED_EPSILON_PX = 0.05;
const GOLDEN_ANGLE = 2.399963229728653;
const MOVED_PX = 0.01;
// The last pass looks for a free spot on rings this far apart, at points this far apart along each ring.
const RING_STEP_PX = 4;

const unit = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

const gapBetween = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function hasOverlap(pts, minDist) {
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      if (gapBetween(pts[i], pts[j]) < minDist) return true;
    }
  }
  return false;
}

// One pass over every pair; returns true when a pair was still too close before it moved.
function pushApart(pts, minDist) {
  let pushed = false;
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const a = pts[i];
      const b = pts[j];
      const d = gapBetween(a, b);
      if (d >= minDist - SETTLED_EPSILON_PX) continue;
      pushed = true;
      let ux;
      let uy;
      if (d < 1e-6) {
        const angle = (i * 31 + j) * GOLDEN_ANGLE;
        ux = Math.cos(angle);
        uy = Math.sin(angle);
      } else {
        ux = (b.x - a.x) / d;
        uy = (b.y - a.y) / d;
      }
      const half = (minDist - d) / 2;
      a.x -= ux * half;
      a.y -= uy * half;
      b.x += ux * half;
      b.y += uy * half;
    }
  }
  return pushed;
}

function clampInside(pts, lo, hi) {
  for (const p of pts) {
    p.x = Math.min(hi, Math.max(lo, p.x));
    p.y = Math.min(hi, Math.max(lo, p.y));
  }
}

const clearOf = (p, placed, minDist) => placed.every((q) => gapBetween(p, q) >= minDist - SETTLED_EPSILON_PX);

// The nearest spot around `from` that is inside the photo and clear of every placed badge, or null when there is none.
function freeSpotNear(from, placed, minDist, lo, hi) {
  const farthest = (hi - lo) * Math.SQRT2;
  for (let r = RING_STEP_PX; r <= farthest; r += RING_STEP_PX) {
    const steps = Math.max(16, Math.ceil((2 * Math.PI * r) / RING_STEP_PX));
    for (let k = 0; k < steps; k += 1) {
      const angle = (k * 2 * Math.PI) / steps;
      const spot = { x: from.x + r * Math.cos(angle), y: from.y + r * Math.sin(angle) };
      const inside = spot.x >= lo && spot.x <= hi && spot.y >= lo && spot.y <= hi;
      if (inside && clearOf(spot, placed, minDist)) return spot;
    }
  }
  return null;
}

// Badge by badge, in order: one that still overlaps a badge placed before it moves to the nearest free spot. So no two
// badges overlap at the end, whatever the loop above left. A photo with no free spot leaves that badge where it is.
function settle(pts, minDist, lo, hi) {
  const placed = [];
  for (const p of pts) {
    const spot = clearOf(p, placed, minDist) ? null : freeSpotNear(p, placed, minDist, lo, hi);
    if (spot) {
      p.x = spot.x;
      p.y = spot.y;
    }
    placed.push(p);
  }
}

// pins: [{ x, y }] as 0-1 fractions of the photo. sizePx: the photo's width (it is square). pinPx: the badge width.
// Returns one entry per pin, in the same order: { x, y } the position to draw the badge at (fractions), { fromX, fromY }
// the true point, shiftPx how far the badge moved in px, and moved (true when it moved at all).
export function spreadPins(pins, sizePx, pinPx = 26) {
  const base = (Array.isArray(pins) ? pins : []).map((p) => ({ x: unit(p?.x), y: unit(p?.y) }));
  const still = () => base.map((b) => ({ x: b.x, y: b.y, fromX: b.x, fromY: b.y, shiftPx: 0, moved: false }));
  const size = Number(sizePx);
  if (!Number.isFinite(size) || size <= 0 || base.length < 2 || size < pinPx * 2) return still();
  const minDist = pinPx + GAP_PX;
  const pts = base.map((b) => ({ x: b.x * size, y: b.y * size }));
  if (!hasOverlap(pts, minDist)) return still();

  const lo = pinPx / 2;
  const hi = size - pinPx / 2;
  clampInside(pts, lo, hi);
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    if (!pushApart(pts, minDist)) break;
    clampInside(pts, lo, hi);
  }
  settle(pts, minDist, lo, hi);
  return pts.map((p, i) => {
    const shiftPx = Math.hypot(p.x - base[i].x * size, p.y - base[i].y * size);
    return { x: p.x / size, y: p.y / size, fromX: base[i].x, fromY: base[i].y, shiftPx, moved: shiftPx > MOVED_PX };
  });
}
