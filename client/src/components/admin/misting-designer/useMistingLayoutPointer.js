// Pointer handling for the misting layout map (mouse, pen and touch share it), keyed by tool:
//   eave / fence   a tap adds a point (or ends the line, or closes the loop)
//   edit           a tap on a nozzle deletes it, a drag moves it, a tap elsewhere does nothing
//   add            a tap on or near a line adds a nozzle there; it never deletes
import { useRef } from 'react';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';
import { hitNozzleIndex, nozzleHitRadiusPx } from '../../../lib/mistingLayoutGeometry';

const DRAG_START_CSS_PX = 5;

// What a tap that did not start on a nozzle does, per tool.
const TAP_TOOLS = {
  eave: (layout, p) => layout.addDraftPoint(p, p.scale),
  fence: (layout, p) => layout.addDraftPoint(p, p.scale),
  add: (layout, p) => layout.addNozzleOnLine(p, p.scale),
  edit: () => undefined,
};

const movedFar = (a, b, scale) => Math.hypot(a.x - b.x, a.y - b.y) > DRAG_START_CSS_PX * scale;
const insideMap = (p) => p.x >= 0 && p.y >= 0 && p.x <= MAP_WIDTH && p.y <= MAP_HEIGHT;

export default function useMistingLayoutPointer(layout, mapState) {
  const frameRef = useRef(null);
  const gestureRef = useRef(null);

  const toMap = (e) => {
    const rect = frameRef.current.getBoundingClientRect();
    const scale = MAP_WIDTH / (rect.width || MAP_WIDTH);
    return {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top) * (MAP_HEIGHT / (rect.height || MAP_HEIGHT)),
      scale,
    };
  };

  // Edit nozzles only: pick up the nozzle under the pointer, if any.
  const grabNozzle = (p, e) => {
    const radius = nozzleHitRadiusPx(mapState.center.lat, mapState.zoom, p.scale);
    const idx = hitNozzleIndex(layout.nozzles, p, radius);
    if (idx < 0) return;
    gestureRef.current.nozzle = layout.nozzles[idx];
    try { frameRef.current.setPointerCapture(e.pointerId); } catch { /* older WebKit */ }
  };

  const onPointerDown = (e) => {
    if (!layout.ready || (e.button !== undefined && e.button > 0)) return;
    const p = toMap(e);
    if (!insideMap(p)) return;
    gestureRef.current = { start: p, moved: false, nozzle: null };
    if (layout.mode === 'edit') grabNozzle(p, e);
  };

  const onPointerMove = (e) => {
    const g = gestureRef.current;
    if (!g || !g.nozzle) return;
    const p = toMap(e);
    if (!g.moved && !movedFar(p, g.start, p.scale)) return;
    g.moved = true;
    layout.moveNozzle(g.nozzle, p);
  };

  const onPointerUp = (e) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g || !layout.ready) return;
    const p = toMap(e);
    try { frameRef.current.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (g.nozzle) {
      if (!g.moved) layout.deleteNozzle(g.nozzle);
      return;
    }
    // A drag that started on empty photo is not a tap.
    if (!movedFar(p, g.start, p.scale)) TAP_TOOLS[layout.mode](layout, p);
  };

  const onPointerCancel = () => { gestureRef.current = null; };

  return { frameRef, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
}
