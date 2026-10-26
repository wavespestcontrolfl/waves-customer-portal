// Pointer handling for the misting layout map (mouse, pen and touch share it), keyed by tool.
// Each tool names what it does and nothing else, so a tap never means two things in one tool:
//   eave / fence   a tap adds a point (or ends the line, or closes the loop)
//   edit           a tap on a nozzle deletes it, a drag moves it, a tap elsewhere does nothing.
//                  It never touches risers, the pump or zones.
//   add            a tap on or near a line adds a nozzle there; it never deletes
//   riser          a tap within the hit radius of a riser deletes it, a drag moves it, a tap anywhere
//                  else adds one. This is the one tool where a tap can add or delete, and the radius
//                  alone decides which. It never touches nozzles.
//   pump           a tap places the pump, or moves it if it is placed. Never deletes.
//   zone           a tap inside an existing no-mist zone deletes it, a tap elsewhere adds one of the
//                  picked kind.
import { useRef } from 'react';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';
import { hitNozzleIndex, nozzleHitRadiusPx } from '../../../lib/mistingLayoutGeometry';

const DRAG_START_CSS_PX = 5;

// The item under a press, from a list of {x, y} items, or null. Same radius rule for nozzles and risers
// (it scales with the on-screen spacing); the newest of overlapping items wins.
function grabFrom(items, p, mapState) {
  const radius = nozzleHitRadiusPx(mapState.center.lat, mapState.zoom, p.scale);
  const idx = hitNozzleIndex(items, p, radius);
  return idx < 0 ? null : items[idx];
}

const drawTool = { tap: (layout, p) => layout.addDraftPoint(p, p.scale) };

// grab: what a press can pick up. move: a drag of it. pick: a tap on it (no drag). tap: a tap that picked nothing.
const TOOLS = {
  eave: drawTool,
  fence: drawTool,
  add: { tap: (layout, p) => layout.addNozzleOnLine(p, p.scale) },
  edit: {
    grab: (layout, p, mapState) => grabFrom(layout.nozzles, p, mapState),
    move: (layout, nozzle, p) => layout.moveNozzle(nozzle, p),
    pick: (layout, nozzle) => layout.deleteNozzle(nozzle),
  },
  riser: {
    grab: (layout, p, mapState) => grabFrom(layout.risers, p, mapState),
    move: (layout, riser, p) => layout.moveRiserTo(riser, p),
    pick: (layout, riser) => layout.deleteRiserOf(riser),
    tap: (layout, p) => layout.addRiserAt(p),
  },
  pump: { tap: (layout, p) => layout.placePump(p) },
  zone: { tap: (layout, p) => layout.tapZone(p) },
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

  const onPointerDown = (e) => {
    if (!layout.ready || (e.button !== undefined && e.button > 0)) return;
    const p = toMap(e);
    if (!insideMap(p)) return;
    const tool = TOOLS[layout.mode];
    const item = tool.grab ? tool.grab(layout, p, mapState) : null;
    gestureRef.current = { start: p, moved: false, item, tool };
    if (item) {
      try { frameRef.current.setPointerCapture(e.pointerId); } catch { /* older WebKit */ }
    }
  };

  const onPointerMove = (e) => {
    const g = gestureRef.current;
    if (!g || !g.item) return;
    const p = toMap(e);
    if (!g.moved && !movedFar(p, g.start, p.scale)) return;
    g.moved = true;
    g.tool.move(layout, g.item, p);
  };

  const onPointerUp = (e) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g || !layout.ready) return;
    const p = toMap(e);
    try { frameRef.current.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (g.item) {
      if (!g.moved) g.tool.pick(layout, g.item);
      return;
    }
    // A drag that started on empty photo is not a tap.
    if (g.tool.tap && !movedFar(p, g.start, p.scale)) g.tool.tap(layout, p);
  };

  const onPointerCancel = () => { gestureRef.current = null; };

  return { frameRef, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } };
}
