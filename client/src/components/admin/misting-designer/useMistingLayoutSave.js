// Save layout for the misting layout designer (step 3): compose the branded sketch, send it with the
// geometry, and track whether what is on screen is what is saved.
//
// "Saved" shows only while the current layout still matches the last saved one (compared as the exact JSON
// that would be sent), so any later edit turns it into "Unsaved changes". A reopened saved layout counts as
// saved from the first render in which its geometry is ready.
import { useEffect, useMemo, useRef, useState } from 'react';
import { MAP_HEIGHT, MAP_WIDTH } from '../../tech/treatmentZoneSpray';
import { buildLayoutPayload, layoutForExport, putLayout } from '../../../lib/mistingLayoutPersist';
import { buildSketchModel } from '../../../lib/mistingLayoutSketch';
import { composeSketchPng } from '../../../lib/mistingLayoutSketchCanvas';

export default function useMistingLayoutSave({ estimateId, mapState, address, layout, saved }) {
  const ready = mapState.status === 'ready';
  const { allLines, nozzles, risers, pump, zones, totals } = layout;

  const payload = useMemo(() => (ready && nozzles.length > 0
    ? buildLayoutPayload({
      address, center: mapState.center, zoom: mapState.zoom, lines: allLines, nozzles, risers, pump, zones,
      mapWidth: MAP_WIDTH, mapHeight: MAP_HEIGHT,
    })
    : null), [ready, mapState, address, allLines, nozzles, risers, pump, zones]);
  const signature = payload ? JSON.stringify(payload) : '';

  const [savedSignature, setSavedSignature] = useState(null);
  const [savedAt, setSavedAt] = useState(saved ? saved.savedAt : null);
  const [phase, setPhase] = useState({ state: 'idle', message: '' }); // idle | saving | error
  const adopted = useRef(false);

  // A reopened layout is the saved one until the first change.
  useEffect(() => {
    if (saved && payload && !adopted.current) {
      adopted.current = true;
      setSavedSignature(signature);
    }
  }, [saved, payload, signature]);

  const save = async () => {
    if (!payload || !estimateId || phase.state === 'saving') return;
    setPhase({ state: 'saving', message: '' });
    const sentSignature = signature;
    try {
      const exported = layoutForExport(allLines, nozzles);
      const model = buildSketchModel({
        lat: mapState.center.lat,
        zoom: mapState.zoom,
        address,
        lines: exported.lines,
        nozzles: exported.nozzles,
        risers,
        pump,
        zones,
        totals,
      });
      const blob = await composeSketchPng({ mapImage: mapState.image, mapUrl: mapState.url, model });
      const result = await putLayout(estimateId, payload, blob);
      adopted.current = true;
      setSavedSignature(sentSignature);
      setSavedAt((result && result.savedAt) || new Date().toISOString());
      setPhase({ state: 'idle', message: '' });
    } catch (err) {
      setPhase({ state: 'error', message: err?.message || 'The layout could not be saved.' });
    }
  };

  let status = 'none';
  if (savedSignature !== null) status = signature === savedSignature ? 'saved' : 'dirty';
  return {
    save,
    status,
    savedAt,
    saving: phase.state === 'saving',
    error: phase.state === 'error' ? phase.message : '',
    hasEstimate: Boolean(estimateId),
    canSave: Boolean(estimateId && payload) && phase.state !== 'saving',
  };
}
