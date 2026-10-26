// Misting layout designer: stepping the photo's zoom (GATE_MISTING_LAYOUT_DESIGNER).
//
// React-free and DOM-free. The Static Map re-centers on the same lat/lng at every zoom, so one zoom step is a
// pure scale by 2^delta about the frame's center, the same as the Treatment Zone Mapper's rescalePointsForZoom.
// Everything staff placed in map pixels is scaled with it so it stays on the same ground: the drawn lines and the
// line in progress, the manual edits (moved and added nozzles; a removed nozzle or a manual aim names a nozzle, not a
// position, so it stays as it is; a moved bed riser is scaled like a moved nozzle), risers, the pump and the centers of no-mist zones. A zone's radius is kept in
// feet, so it follows by itself. The automatic nozzles are re-placed from the scaled lines, 10 ft apart as before.
//
// A zoom IN pushes points outward, and a point outside the 1280 by 960 frame cannot be tapped or dragged, so a
// zoom in is refused while any point would leave the frame.
import { MAP_HEIGHT, MAP_WIDTH } from '../components/tech/treatmentZoneSpray';

const scale = (p, delta) => {
  const f = 2 ** delta;
  return { ...p, x: MAP_WIDTH / 2 + (p.x - MAP_WIDTH / 2) * f, y: MAP_HEIGHT / 2 + (p.y - MAP_HEIGHT / 2) * f };
};
const scaleAll = (points, delta) => (points || []).map((p) => scale(p, delta));
const scaleMap = (object, delta) => Object.fromEntries(Object.entries(object || {}).map(([k, p]) => [k, scale(p, delta)]));

export const scaleLines = (lines, delta) => (lines || []).map((l) => ({ ...l, points: scaleAll(l.points, delta) }));
export const scaleDraft = (draft, delta) => (draft ? { ...draft, points: scaleAll(draft.points, delta) } : draft);
export const scaleEdits = (edits, delta) => ({
  ...edits,
  moved: scaleMap(edits.moved, delta),
  added: scaleAll(edits.added, delta),
  riserMoved: scaleMap(edits.riserMoved, delta),
});
export const scaleExtras = (extras, delta) => ({
  ...extras,
  risers: scaleAll(extras.risers, delta),
  pump: extras.pump ? scale(extras.pump, delta) : extras.pump,
  zones: scaleAll(extras.zones, delta),
});

/** Every point of a layout state ({ lines, draft, edits, extras }) that has a position on the map. */
export function layoutPoints({ lines, draft, edits, extras }) {
  return [
    ...(lines || []).flatMap((l) => l.points || []),
    ...((draft && draft.points) || []),
    ...Object.values((edits && edits.moved) || {}),
    ...Object.values((edits && edits.riserMoved) || {}),
    ...((edits && edits.added) || []),
    ...((extras && extras.risers) || []),
    ...(extras && extras.pump ? [extras.pump] : []),
    ...((extras && extras.zones) || []),
  ];
}

const inFrame = (p) => p.x >= 0 && p.y >= 0 && p.x <= MAP_WIDTH && p.y <= MAP_HEIGHT;

/** True when every point still sits inside the frame after the zoom changes by `delta`. */
export function fitsAfterZoom(state, delta) {
  return layoutPoints(state).every((p) => inFrame(scale(p, delta)));
}
