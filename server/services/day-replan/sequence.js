/**
 * Day re-plan APPLY (owner ruling 2026-11-03, PR 2 of 3): the order in which an accepted plan's visits are written.
 *
 * The plan gives every moved visit a new hour, one visit per hour. Written one at a time, the app's occupancy
 * check refuses a visit whose new hours another visit still holds. So a plan that swaps two visits, or moves
 * several round a cycle, cannot be written straight. This module finds an order in which each visit's new hours
 * (every hour its window covers) are free at its step, parking one visit of a cycle on a TEMPORARY hour when it
 * must. Pure: no database, deterministic.
 *
 *   moves: [{ id, fromStart, toStart, widthMin, workMin, pref }]   minutes from midnight
 *   heldMask: hours held by everything that does not move (fixed stops, stops the plan leaves alone, blocked
 *             hours of unassigned or other technicians' visits); hour h = bit h
 *   options: { openMin, closeMin, blocks: [{startMin, endMin}] }
 *
 * A temporary hour is free at that moment, inside the day (starts at or after openMin, window ends by closeMin),
 * satisfies the visit's explicit time preference, keeps its work clear of the technician's schedule blocks, and
 * lets some other visit make progress once the parked visit has left its hours. It is never a final state: the
 * result ends with every visit on its new hour, or is null (no safe sequence).
 */

function hoursMask(startMin, widthMin) {
  const first = Math.floor(startMin / 60);
  const last = Math.max(first, Math.ceil((startMin + widthMin) / 60) - 1);
  let mask = 0;
  for (let h = first; h <= last; h += 1) mask |= 1 << h;
  return mask;
}

const overlaps = (a, b) => (a & b) !== 0;

function prefAllows(pref, startMin) {
  return !pref || (startMin >= pref.startMin && startMin < pref.endMin);
}

function clearOfBlocks(blocks, startMin, workMin) {
  return !(blocks || []).some((b) => startMin < b.endMin && startMin + workMin > b.startMin);
}

/** Hours (as start minutes) a visit may be parked on, ascending. */
function tempStarts(move, options) {
  const out = [];
  for (let start = Math.ceil(options.openMin / 60) * 60; start + move.widthMin <= options.closeMin; start += 60) {
    if (start === move.fromStart || start === move.toStart) continue;
    if (prefAllows(move.pref, start) && clearOfBlocks(options.blocks, start, move.workMin)) out.push(start);
  }
  return out;
}

function sequenceMoves({ moves, heldMask, options }) {
  const here = new Map(moves.map((m) => [m.id, m.fromStart]));
  const maskAt = (m, start) => hoursMask(start, m.widthMin);
  // Hours held right now by everything except visit `skipId`.
  const heldExcept = (skipId) => moves.reduce(
    (mask, m) => (m.id === skipId ? mask : mask | maskAt(m, here.get(m.id))), heldMask,
  );
  const atTarget = (m) => here.get(m.id) === m.toStart;
  const canGo = (m) => !overlaps(maskAt(m, m.toStart), heldExcept(m.id));
  const steps = [];
  const parked = new Set();

  const orderedLeft = () => moves.filter((m) => !atTarget(m)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const goNext = () => orderedLeft().find(canGo);

  // Park one visit of a cycle so another can go. Returns true when it did.
  const park = () => {
    for (const m of orderedLeft()) {
      if (parked.has(m.id)) continue;
      for (const start of tempStarts(m, options)) {
        if (overlaps(maskAt(m, start), heldExcept(m.id))) continue;
        const before = here.get(m.id);
        here.set(m.id, start);
        const progress = orderedLeft().some((o) => o.id !== m.id && canGo(o));
        if (progress) {
          parked.add(m.id);
          steps.push({ id: m.id, toStart: start, temp: true });
          return true;
        }
        here.set(m.id, before);
      }
    }
    return false;
  };

  for (let guard = 0; guard < moves.length * 3 + 3; guard += 1) {
    if (orderedLeft().length === 0) return steps;
    const next = goNext();
    if (next) {
      here.set(next.id, next.toStart);
      steps.push({ id: next.id, toStart: next.toStart, temp: false });
    } else if (!park()) {
      return null;
    }
  }
  return orderedLeft().length === 0 ? steps : null;
}

module.exports = { sequenceMoves, hoursMask };
