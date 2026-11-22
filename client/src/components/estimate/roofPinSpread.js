// Spreads roof point badges that would sit on top of each other on the county roof photo (owner "zoom" follow-up, 2026-11-21).
// On a 390 px phone the photo is about 294 px wide for about 60 m of ground, and a badge is 26 px, so two points less than
// about 5 m apart hide each other's number. Pure math, no DOM: the card measures the photo and calls spreadPins.
//
// A point is "crowded" when another point is closer than the badge width plus a 2 px gap. Rules:
//  - No crowded point: every badge keeps its true position exactly (the page as it was).
//  - A point that is not crowded never moves.
//  - Nudge: when pushing each overlapping pair apart moves no badge more than NUDGE_PX, the badges take those
//    positions. Each still sits on its point, so the card draws nothing else.
//  - Call out: otherwise every crowded point gets a dot on its true place, and the card draws a line from the dot to
//    the badge. Crowded points that chain together form a group. A group's badges go on one ring round the group, wide
//    enough that every dot stays CALLOUT_GAP_PX of roof clear of every badge: a badge that moved only a little used to
//    cover its own dot and line, and the customer saw a number and no place. The lines stay inside the ring, so a line
//    does not run under another badge and look as if it ends there, and the badges take the ring places that make the
//    lines shortest, so no two lines of a group cross.
//  - A ring cut by the photo edge, by another badge or by another group uses its longest free arc.
//  - A badge that does not move can sit inside a ring, and a line can run under it. So every ring that fits is
//    checked: the first one (smallest, then by start angle) whose lines run under no badge is used. The ring grows to
//    find one, and the ring with the fewest such lines is used when none is clean (10 to 20 points on one line).
//  - A group no ring fits (about seven or more points on one spot in a photo corner) places badge by badge at the
//    nearest free spot: badges apart first, then off the dots. With no free spot at all the badge stays on its point.
// Groups and badges are handled in pin order, with no randomness: the same input always gives the same output.

const GAP_PX = 2;
const NUDGE_PASSES = 60;
const SETTLED_EPSILON_PX = 0.05;
const MOVED_PX = 0.01;
// A badge this close to its true point still marks it (about 1.2 m on a phone): no dot, no line.
const NUDGE_PX = 6;
// The dot the card draws at a called-out point, and the clear roof between that dot and the rim of any badge.
export const DOT_PX = 8;
const CALLOUT_GAP_PX = 5;
// The clear roof between a line and the rim of a badge it is not for.
const LINE_GAP_PX = 3;
const TAU = 2 * Math.PI;
// A ring is checked at this many places round it, grows by RING_GROW_PX up to RING_REACH_PX past its smallest size, and
// a ring that is free all the way round is tried at RING_TURNS start angles.
const ARC_STEPS = 360;
const RING_GROW_PX = 6;
const RING_REACH_PX = 150;
const RING_TURNS = 4;
const SWAP_PASSES = 50;
// The badge-by-badge search looks on rings this far apart, at places this far apart along each ring.
const RING_STEP_PX = 4;

const unit = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};

const gapBetween = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const clearOf = (p, others, dist) => others.every((q) => gapBetween(p, q) >= dist - SETTLED_EPSILON_PX);

// The distance from q to the straight line drawn from a to b.
function gapToLine(q, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-9 ? 0 : Math.min(1, Math.max(0, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));
  return Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
}

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

// The crowded points in groups that chain together: each point of a group is closer than a badge plus the gap to
// another point of it. Lists of indexes, in pin order.
function crowdedGroups(pts, crowded, minDist) {
  const grouped = pts.map(() => false);
  const groups = [];
  pts.forEach((_, first) => {
    if (!crowded[first] || grouped[first]) return;
    const members = [first];
    grouped[first] = true;
    for (let k = 0; k < members.length; k += 1) {
      const own = pts[members[k]].from;
      pts.forEach((q, j) => {
        if (grouped[j] || !crowded[j] || gapBetween(own, q.from) >= minDist) return;
        grouped[j] = true;
        members.push(j);
      });
    }
    groups.push(members.sort((x, y) => x - y));
  });
  return groups;
}

// The longest run of free places round a ring, as { start, count }: count equals the list length when all are free.
function longestFreeArc(ok) {
  const firstBlocked = ok.indexOf(false);
  if (firstBlocked < 0) return { start: 0, count: ok.length };
  let best = { start: 0, count: 0 };
  let run = 0;
  for (let k = 1; k <= ok.length; k += 1) {
    const at = (firstBlocked + k) % ok.length;
    run = ok[at] ? run + 1 : 0;
    if (run > best.count) best = { start: (at - run + 1 + ok.length) % ok.length, count: run };
  }
  return best;
}

// n badge places on the ring, in order round it: evenly round a ring that is free all the way (from a start angle set
// by `turn`), else evenly along its free arc. null when they would not be a badge and the gap apart.
function ringPlaces({ c, r, minDist }, n, arc, turn) {
  const full = arc.count === ARC_STEPS;
  const span = full ? TAU : ((arc.count - 1) * TAU) / ARC_STEPS;
  // Never wider than an even ring, so the first and the last place are as far apart as any two neighbours.
  const used = Math.min(span, (TAU * (n - 1)) / n);
  const step = used / (n - 1);
  if (arc.count < 1 || 2 * r * Math.sin(step / 2) < minDist - SETTLED_EPSILON_PX) return null;
  const start = full ? (turn * step) / RING_TURNS : (arc.start * TAU) / ARC_STEPS + (span - used) / 2;
  return Array.from({ length: n }, (_, k) => ({ x: c.x + r * Math.cos(start + k * step), y: c.y + r * Math.sin(start + k * step) }));
}

// Which ring place each point's badge takes. Points and places are matched in order round the ring at the rotation
// with the shortest lines; then any two points swap places while that makes their lines shorter. Two lines that cross
// are shorter swapped, so none cross at the end.
function takePlaces(froms, places, c) {
  const n = froms.length;
  const inTurn = froms.map((f, i) => ({ i, a: Math.atan2(f.y - c.y, f.x - c.x) })).sort((p, q) => p.a - q.a || p.i - q.i).map((p) => p.i);
  const pairLen = (i, k) => gapBetween(froms[i], places[k]);
  let take = null;
  let shortest = Infinity;
  for (let turn = 0; turn < n; turn += 1) {
    const tried = new Array(n);
    inTurn.forEach((i, k) => { tried[i] = (k + turn) % n; });
    const len = tried.reduce((sum, k, i) => sum + pairLen(i, k), 0);
    if (len < shortest - 1e-9) {
      shortest = len;
      take = tried;
    }
  }
  for (let pass = 0, swapped = true; swapped && pass < SWAP_PASSES; pass += 1) {
    swapped = false;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        if (pairLen(i, take[j]) + pairLen(j, take[i]) < pairLen(i, take[i]) + pairLen(j, take[j]) - 1e-6) {
          [take[i], take[j]] = [take[j], take[i]];
          swapped = true;
        }
      }
    }
  }
  return take.map((k) => places[k]);
}

// How many times a line (from a point to its badge) runs under a badge that is not its own.
function linesUnderBadges(froms, spots, placed, lineClear) {
  let count = 0;
  froms.forEach((from, i) => {
    const under = (q) => gapToLine(q, from, spots[i]) < lineClear - SETTLED_EPSILON_PX;
    count += spots.filter((q, j) => j !== i && under(q)).length + placed.filter(under).length;
  });
  return count;
}

// The badge places for one group, one per point in the group's order, or null when no ring fits. The smallest ring
// keeps every dot of the group clear and holds the group's badges; the first ring whose lines run under no badge wins.
function ringFor(froms, placed, free, { minDist, dotClear, lineClear }) {
  const n = froms.length;
  const c = { x: froms.reduce((sum, f) => sum + f.x, 0) / n, y: froms.reduce((sum, f) => sum + f.y, 0) / n };
  const smallest = Math.max(Math.max(...froms.map((f) => gapBetween(f, c))) + dotClear, minDist / 2 / Math.sin(Math.PI / n));
  let best = null;
  for (let r = smallest; r <= smallest + RING_REACH_PX && !(best && best.faults === 0); r += RING_GROW_PX) {
    const ring = { c, r, minDist };
    const arc = longestFreeArc(Array.from({ length: ARC_STEPS }, (_, k) => free({ x: c.x + r * Math.cos((k * TAU) / ARC_STEPS), y: c.y + r * Math.sin((k * TAU) / ARC_STEPS) })));
    const turns = arc.count === ARC_STEPS ? RING_TURNS : 1;
    for (let turn = 0; turn < turns; turn += 1) {
      const places = ringPlaces(ring, n, arc, turn);
      if (!places) break;
      const spots = takePlaces(froms, places, c);
      const faults = linesUnderBadges(froms, spots, placed, lineClear);
      const len = spots.reduce((sum, spot, i) => sum + gapBetween(froms[i], spot), 0);
      const better = !best || faults < best.faults || (faults === best.faults && r === best.r && len < best.len - 1e-9);
      if (better) best = { spots, faults, len, r };
    }
  }
  return best && best.spots;
}

// The first spot that passes `free`, looking on rings around `from` from `startR` out, and on each ring from `angle`
// to both sides in turn. null when no ring inside the photo has one.
function spotAround(from, { startR, angle, farthest }, free) {
  for (let r = startR; r <= farthest; r += RING_STEP_PX) {
    const steps = Math.max(16, Math.ceil((TAU * r) / RING_STEP_PX));
    for (let k = 0; k < steps; k += 1) {
      const turn = Math.ceil(k / 2) * (k % 2 ? 1 : -1);
      const a = angle + (turn * TAU) / steps;
      const spot = { x: from.x + r * Math.cos(a), y: from.y + r * Math.sin(a) };
      if (free(spot)) return spot;
    }
  }
  return null;
}

// Move every crowded badge off its point, group by group. `placed` starts as the badges that do not move; `lines` are
// the lines drawn so far. A place is free when it is inside the photo, a badge and the gap from every placed badge,
// clear of every dot, and on no line.
function callOut(pts, crowded, { minDist, dotClear, lineClear, lo, hi }) {
  const dots = pts.filter((_, i) => crowded[i]).map((p) => p.from);
  const placed = pts.filter((_, i) => !crowded[i]);
  const lines = [];
  const inside = (s) => s.x >= lo && s.x <= hi && s.y >= lo && s.y <= hi;
  const apart = (s) => inside(s) && clearOf(s, placed, minDist);
  const free = (s) => apart(s) && clearOf(s, dots, dotClear) && lines.every((l) => gapToLine(s, l.from, l.to) >= lineClear);
  const farthest = (hi - lo) * Math.SQRT2;
  for (const group of crowdedGroups(pts, crowded, minDist)) {
    const ring = ringFor(group.map((i) => pts[i].from), placed, free, { minDist, dotClear, lineClear });
    group.forEach((i, k) => {
      const p = pts[i];
      const spot = ring ? ring[k]
        : spotAround(p.from, { startR: dotClear, angle: i, farthest: Math.min(farthest, RING_REACH_PX) }, free) || spotAround(p.from, { startR: RING_STEP_PX, angle: i, farthest }, apart);
      if (spot) {
        p.x = spot.x;
        p.y = spot.y;
        lines.push({ from: p.from, to: spot });
      }
      placed.push(p);
    });
  }
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
  if (!laid) callOut(pts, crowded, { minDist, dotClear: pinPx / 2 + DOT_PX / 2 + CALLOUT_GAP_PX, lineClear: pinPx / 2 + LINE_GAP_PX, lo, hi });
  return (laid || pts).map((p, i) => {
    const shiftPx = gapBetween(p, p.from);
    const moved = shiftPx > MOVED_PX;
    return { x: moved ? p.x / size : base[i].x, y: moved ? p.y / size : base[i].y, fromX: base[i].x, fromY: base[i].y, shiftPx: moved ? shiftPx : 0, moved, callout: Boolean(!laid && crowded[i] && moved) };
  });
}
