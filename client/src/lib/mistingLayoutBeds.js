// Misting layout designer: bed lines and the risers along them (GATE_MISTING_LAYOUT_DESIGNER).
//
// A bed line traces the edge of a landscape bed. Risers go along it about every 10 ft (Pynamite's manual:
// "Nozzles/risers are typically placed 10 feet apart"), with one at each end and no gap over 10 ft: the same placement
// engine as the nozzles (placeNozzles), with a nominal spacing of RISER_SPACING_FT and a minimum of half that. A bed line gets no eave or fence nozzles.
//
// Bed risers are derived from the lines on every render, like the automatic nozzles. Staff can move or delete one; that is
// an edit overlay on the CURRENT bed lines (`riserMoved`, `riserRemoved` in the designer's edits) and is cleared, with the
// usual notice and Undo, when the lines change. A riser staff drop with the Riser tool is `manual` and independent of lines.
// (Reopening a saved layout pairs the saved bed risers with these again: diffRiserEdits in mistingLayoutPersist.js.)
import { placeNozzles } from './mistingLayoutGeometry';
import { RISER_SPACING_FT } from './mistingLayoutLimits';

export const BED_RISER_MIN_SPACING_FT = RISER_SPACING_FT / 2;
const KEY_PREFIX = 'bed:';

export const isBed = (line) => Boolean(line) && line.kind === 'bed';

/**
 * The lines nozzles are placed on: the same list with every bed line emptied, so nozzle `lineIndex` values still index
 * the full list (and a bed line gets no nozzle).
 */
export const nozzleLines = (lines) => (lines || []).map((line) => (isBed(line) ? { ...line, points: [] } : line));

/**
 * The automatic risers along every bed line: { key, x, y, source: 'bed', lineIndex, lineId }, `lineIndex` into `lines`.
 */
export function placeBedRisers(lines, { lat, zoom }) {
  const all = lines || [];
  const bedIndexes = all.map((line, i) => (isBed(line) ? i : -1)).filter((i) => i >= 0);
  if (bedIndexes.length === 0) return [];
  const placed = placeNozzles(
    bedIndexes.map((i) => ({ id: all[i].id, kind: 'eave', points: all[i].points })),
    { lat, zoom, spacingFt: RISER_SPACING_FT, minSpacingFt: BED_RISER_MIN_SPACING_FT },
  );
  return placed.nozzles.map((n) => ({
    key: `${KEY_PREFIX}${n.key}`,
    x: n.x,
    y: n.y,
    source: 'bed',
    lineIndex: bedIndexes[n.lineIndex],
    lineId: n.lineId,
  }));
}

/** The bed risers staff left in place: the automatic ones less the removed, with the moved ones where they were put. */
export function applyRiserEdits(autoRisers, edits = {}) {
  const removed = new Set(edits.riserRemoved || []);
  const moved = edits.riserMoved || {};
  return (autoRisers || []).filter((r) => !removed.has(r.key)).map((r) => {
    const m = moved[r.key];
    return m && Number.isFinite(m.x) && Number.isFinite(m.y) ? { ...r, x: m.x, y: m.y, edited: true } : r;
  });
}
