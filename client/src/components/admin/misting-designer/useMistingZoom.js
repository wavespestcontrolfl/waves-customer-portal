// Zoom −/+ for the misting layout designer: load the photo at the new zoom, then swap it in and scale the layout in
// the same tick, so nothing is ever drawn at the wrong scale (lib/mistingLayoutZoom). Out as far as MIN_TRACE_ZOOM, in
// as far as the closest photo there is; a zoom in is refused while a point would leave the photo, with the reason shown.
import { useState } from 'react';
import { MIN_TRACE_ZOOM } from '../../tech/treatmentZoneSpray';

export default function useMistingZoom(mapState, layout) {
  const [failure, setFailure] = useState('');
  const ready = mapState.status === 'ready';
  const level = ready ? mapState.zoom : 0;
  const atClosest = ready && level >= mapState.maxZoom;
  const canOut = ready && level > MIN_TRACE_ZOOM;
  const canIn = ready && !atClosest && layout.zoomInFits;

  let reason = failure;
  if (!reason && atClosest) reason = 'This is the closest photo there is.';
  else if (!reason && ready && !layout.zoomInFits) reason = 'Zoom in is off: a point would leave the photo. Move it in, or zoom out.';

  const onStep = async (delta) => {
    const target = level + delta;
    if (!ready || layout.zoomBusy || target < MIN_TRACE_ZOOM || target > mapState.maxZoom) return;
    if (delta > 0 && !layout.zoomInFits) return;
    layout.setZoomBusy(true);
    setFailure('');
    try {
      const photo = await mapState.loadZoom(target);
      mapState.applyZoom(target, photo);
      layout.rescale(delta);
    } catch {
      setFailure('That zoom level failed to load. Try again.');
    } finally {
      layout.setZoomBusy(false);
    }
  };

  return { level, canOut, canIn, busy: layout.zoomBusy, reason, onStep };
}
