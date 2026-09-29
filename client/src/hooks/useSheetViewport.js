import { useEffect, useState } from 'react';

// Keyboard opening can resize AND pan the visual viewport on iOS. A full-
// screen mobile sheet sizes itself to { top, height } and keeps the focused
// input or textarea in view. Shared by PortalPage's overlays and the visit
// prep photo sheet.
export default function useSheetViewport(open, dialogRef) {
  const [viewport, setViewport] = useState(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!open || !vv) return undefined;
    const update = () => setViewport({ height: Math.round(vv.height), top: Math.round(vv.offsetTop) });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !viewport) return undefined;
    const frame = requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (dialogRef.current?.contains(focused) && focused.matches('input, textarea')) {
        focused.scrollIntoView({ block: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, viewport?.height, viewport?.top, dialogRef]);
  return viewport;
}
