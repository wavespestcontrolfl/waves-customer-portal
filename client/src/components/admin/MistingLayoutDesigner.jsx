// Misting layout designer (GATE_MISTING_LAYOUT_DESIGNER, step 1). Staff screen only.
//
// Opens over the property's Google satellite photo (the Treatment Zone Mapper's
// loader and px-to-feet math). Staff draw eave lines and fence lines; nozzles are
// placed live (a corner at every vertex, then about every 10 ft) by
// lib/mistingLayoutGeometry. Staff can delete a nozzle (tap it), add one (tap a
// line) and move one (drag it). "Use counts" hands the nozzle total back to the
// estimator's Nozzles input. Nothing is saved and there is no export in this step.
//
// Pointer model (mouse, pen and touch share it):
//   Draw modes   a tap adds a point. A tap on the last point finishes the line (the
//                double-click / double-tap), a tap on the first point of a line of
//                3+ points closes the loop. The Finish button does the same.
//   Edit mode    a tap on a nozzle deletes it, a drag moves it, a tap on a line adds one.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '../ui';
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  loadBestMapImage,
} from '../tech/treatmentZoneSpray';
import {
  applyNozzleEdits,
  computeTotals,
  hitNozzleIndex,
  nearestPointOnLines,
  nozzleHitRadiusPx,
  placeNozzles,
} from '../../lib/mistingLayoutGeometry';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
// A fence or a tall yard needs more of the lot than the tech tracer's zoom 21, so start one step wider.
const DESIGNER_ZOOMS = [20, 19];
export const CONCEPT_LABEL = 'Concept layout — final placement at the design visit and install.';

// Touch targets in CSS pixels, converted to map pixels from the frame width.
// The nozzle tap radius is computed per tap from the on-screen nozzle gap (nozzleHitRadiusPx).
const LINE_HIT_CSS_PX = 12;
const VERTEX_HIT_CSS_PX = 14;
const DRAG_START_CSS_PX = 5;

const MODES = [
  { key: 'eave', label: 'Eave line' },
  { key: 'fence', label: 'Fence line' },
  { key: 'edit', label: 'Edit nozzles' },
];

function geocodeInBrowser(address) {
  return new Promise((resolve, reject) => {
    const Geocoder = window.google?.maps?.Geocoder;
    if (!address || !Geocoder) {
      reject(new Error('No location for this property yet. Run the property lookup, then open the designer again.'));
      return;
    }
    new Geocoder().geocode({ address }, (results, status) => {
      const loc = status === 'OK' ? results?.[0]?.geometry?.location : null;
      const lat = typeof loc?.lat === 'function' ? loc.lat() : loc?.lat;
      const lng = typeof loc?.lng === 'function' ? loc.lng() : loc?.lng;
      if (Number.isFinite(lat) && Number.isFinite(lng)) resolve({ lat, lng });
      else reject(new Error('Could not find this address on the map.'));
    });
  });
}

const NO_EDITS = Object.freeze({ removed: [], moved: {}, added: [] });
const editCount = (e) => e.removed.length + Object.keys(e.moved).length + e.added.length;
const geometryKey = (lines, draft) => JSON.stringify([lines, draft && draft.points.length > 0 ? draft : null]);

const coord = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

export default function MistingLayoutDesigner({ address, lat, lng, limits, onUseCounts, onClose }) {
  const [mapState, setMapState] = useState({ status: 'loading' });
  const [lines, setLines] = useState([]);
  const [draft, setDraft] = useState(null); // { id, kind, points }
  const [mode, setMode] = useState('eave');
  // Manual edits are an overlay on the CURRENT line geometry only. Any change to the lines
  // re-runs auto-placement and clears the overlay (applyGeometry), keeping one snapshot so
  // the notice's Undo can put the previous lines and edits back in a single step.
  const [edits, setEdits] = useState(NO_EDITS);
  const [notice, setNotice] = useState(null); // { count, snapshot: { lines, draft, edits } }
  const frameRef = useRef(null);
  const gestureRef = useRef(null);
  const idRef = useRef(0);
  const nextId = (prefix) => {
    idRef.current += 1;
    return `${prefix}${idRef.current}`;
  };

  // ── Satellite photo ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!MAPS_KEY) throw new Error('Google Maps key is not configured for this build.');
        let center = Number.isFinite(coord(lat)) && Number.isFinite(coord(lng))
          ? { lat: Number(lat), lng: Number(lng) }
          : null;
        if (!center) center = await geocodeInBrowser(address);
        const { url, zoom } = await loadBestMapImage(center.lat, center.lng, MAPS_KEY, DESIGNER_ZOOMS);
        if (!cancelled) setMapState({ status: 'ready', center, zoom, url });
      } catch (err) {
        if (!cancelled) setMapState({ status: 'error', message: err?.message || 'The satellite photo failed to load.' });
      }
    })();
    return () => { cancelled = true; };
  }, [address, lat, lng]);

  // ── Derived layout ─────────────────────────────────────────────────────────
  const ready = mapState.status === 'ready';
  const allLines = useMemo(() => (draft && draft.points.length > 0 ? [...lines, draft] : lines), [lines, draft]);
  const placed = useMemo(
    () => (ready ? placeNozzles(allLines, { lat: mapState.center.lat, zoom: mapState.zoom }) : null),
    [ready, allLines, mapState],
  );
  const nozzles = useMemo(() => (placed ? applyNozzleEdits(placed.nozzles, edits) : []), [placed, edits]);
  const totals = useMemo(() => computeTotals(placed ? placed.lines : [], nozzles), [placed, nozzles]);

  // ── Pointer handling ───────────────────────────────────────────────────────
  const toMap = (e) => {
    const rect = frameRef.current.getBoundingClientRect();
    const scale = MAP_WIDTH / (rect.width || MAP_WIDTH);
    return {
      x: (e.clientX - rect.left) * scale,
      y: (e.clientY - rect.top) * (MAP_HEIGHT / (rect.height || MAP_HEIGHT)),
      scale,
    };
  };

  // The one door for changes to the lines. A change that alters the geometry re-places the
  // nozzles, so it clears the manual edits and leaves a notice with a one-step Undo.
  const applyGeometry = (nextLines, nextDraft) => {
    if (geometryKey(nextLines, nextDraft) !== geometryKey(lines, draft) && editCount(edits) > 0) {
      setNotice({ count: editCount(edits), snapshot: { lines, draft, edits } });
      setEdits(NO_EDITS);
    }
    setLines(nextLines);
    setDraft(nextDraft);
  };

  const restoreSnapshot = () => {
    if (!notice) return;
    setLines(notice.snapshot.lines);
    setDraft(notice.snapshot.draft);
    setEdits(notice.snapshot.edits);
    setNotice(null);
  };

  // A manual edit starts a new overlay state, so an old restore point no longer applies.
  const editOverlay = (update) => {
    setNotice(null);
    setEdits(update);
  };

  const finishDraft = (extraPoint) => {
    if (!draft) return;
    const points = extraPoint ? [...draft.points, extraPoint] : draft.points;
    applyGeometry(points.length >= 2 ? [...lines, { ...draft, points }] : lines, null);
  };

  const addDraftPoint = (p, scale) => {
    const kind = mode === 'fence' ? 'fence' : 'eave';
    // Starting a line of the other kind ends nothing: switching modes finishes the draft.
    const current = draft && draft.kind === kind ? draft : { id: nextId('L'), kind, points: [] };
    const pts = current.points;
    const last = pts[pts.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) <= VERTEX_HIT_CSS_PX * scale && pts.length >= 2) {
      finishDraft();
      return;
    }
    const first = pts[0];
    if (first && pts.length >= 3 && Math.hypot(first.x - p.x, first.y - p.y) <= VERTEX_HIT_CSS_PX * scale) {
      finishDraft({ x: first.x, y: first.y });
      return;
    }
    if (last && Math.hypot(last.x - p.x, last.y - p.y) <= VERTEX_HIT_CSS_PX * scale) return;
    applyGeometry(lines, { ...current, points: [...pts, { x: p.x, y: p.y }] });
  };

  const deleteNozzle = (n) => {
    editOverlay((prev) => {
      if (n.manual) return { ...prev, added: prev.added.filter((a) => a.key !== n.key) };
      const { [n.key]: _moved, ...moved } = prev.moved;
      return { ...prev, moved, removed: [...prev.removed, n.key] };
    });
  };

  const moveNozzle = (n, p) => {
    const x = Math.max(0, Math.min(MAP_WIDTH, p.x));
    const y = Math.max(0, Math.min(MAP_HEIGHT, p.y));
    editOverlay((prev) => (n.manual
      ? { ...prev, added: prev.added.map((a) => (a.key === n.key ? { ...a, x, y } : a)) }
      : { ...prev, moved: { ...prev.moved, [n.key]: { x, y } } }));
  };

  const addNozzleOnLine = (p, scale) => {
    const hit = nearestPointOnLines(allLines, p, LINE_HIT_CSS_PX * scale);
    if (!hit) return;
    editOverlay((prev) => ({
      ...prev,
      added: [...prev.added, {
        key: nextId('m'),
        manual: true,
        x: hit.x,
        y: hit.y,
        kind: hit.kind,
        lineId: hit.lineId,
        lineIndex: hit.lineIndex,
        segmentIndex: hit.segmentIndex,
        vertexIndex: null,
        corner: false,
      }],
    }));
  };

  const onPointerDown = (e) => {
    if (!ready || (e.button !== undefined && e.button > 0)) return;
    const p = toMap(e);
    if (p.x < 0 || p.y < 0 || p.x > MAP_WIDTH || p.y > MAP_HEIGHT) return;
    gestureRef.current = { start: p, moved: false, nozzle: null, pointerId: e.pointerId };
    if (mode === 'edit') {
      const idx = hitNozzleIndex(nozzles, p, nozzleHitRadiusPx(mapState.center.lat, mapState.zoom, p.scale));
      if (idx >= 0) {
        gestureRef.current.nozzle = nozzles[idx];
        try { frameRef.current.setPointerCapture(e.pointerId); } catch { /* older WebKit */ }
      }
    }
  };

  const onPointerMove = (e) => {
    const g = gestureRef.current;
    if (!g || !g.nozzle) return;
    const p = toMap(e);
    if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) <= DRAG_START_CSS_PX * p.scale) return;
    g.moved = true;
    moveNozzle(g.nozzle, p);
  };

  const onPointerUp = (e) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g || !ready) return;
    const p = toMap(e);
    try { frameRef.current.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (g.nozzle) {
      if (!g.moved) deleteNozzle(g.nozzle);
      return;
    }
    // A drag that started on empty photo is not a tap.
    if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > DRAG_START_CSS_PX * p.scale) return;
    if (mode === 'edit') addNozzleOnLine(p, p.scale);
    else addDraftPoint(p, p.scale);
  };

  const onPointerCancel = () => { gestureRef.current = null; };

  // ── Toolbar actions ────────────────────────────────────────────────────────
  const chooseMode = (next) => {
    if (next !== mode) finishDraft();
    setMode(next);
  };

  const undo = () => {
    if (draft && draft.points.length > 0) {
      const points = draft.points.slice(0, -1);
      applyGeometry(lines, points.length ? { ...draft, points } : null);
    } else if (lines.length > 0) {
      applyGeometry(lines.slice(0, -1), null);
    }
  };

  const clearAll = () => {
    applyGeometry([], null);
    setEdits(NO_EDITS);
  };

  const useCounts = () => {
    if (totals.count <= 0) return;
    onUseCounts?.(totals.count);
    onClose?.();
  };

  const hasContent = lines.length > 0 || (draft && draft.points.length > 0);
  const maxNozzles = Number(limits?.maxNozzles);
  const minNozzles = Number(limits?.minNozzles);
  const limitNote = Number.isFinite(maxNozzles) && totals.count > maxNozzles
    ? `The estimator accepts up to ${maxNozzles} nozzles. Remove some before using this count.`
    : Number.isFinite(minNozzles) && totals.count > 0 && totals.count < minNozzles
      ? `The system includes at least ${minNozzles} nozzles. A lower count is billed at the included count.`
      : null;

  const hint = mode === 'edit'
    ? 'Tap a nozzle to delete it. Drag a nozzle to move it. Tap a line to add a nozzle.'
    : `Tap the photo to drop points along the ${mode === 'fence' ? 'fence' : 'eave'}. Tap the last point again, or press Finish line, to end it. Tap the first point to close a loop.`;

  const strokeFor = (kind) => ({ dash: kind === 'fence' ? '18 12' : undefined });

  return (
    <Dialog open onClose={onClose} size="lg" aria-label="Misting layout designer">
      <DialogHeader className="flex items-start justify-between gap-3">
        <div>
          <DialogTitle>Design misting layout</DialogTitle>
          {address ? <p className="text-14 text-zinc-600 mt-1">{address}</p> : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close layout designer"
          className="text-22 leading-none text-zinc-600 px-2 min-h-11"
        >
          ×
        </button>
      </DialogHeader>
      <DialogBody>
        {mapState.status === 'loading' && (
          <p role="status" className="text-14 text-zinc-600 text-center py-10">Loading satellite photo…</p>
        )}
        {mapState.status === 'error' && (
          <div role="alert" className="px-3 py-2 rounded-xs border-hairline border-zinc-300 bg-zinc-50 text-14 text-zinc-900">
            {mapState.message}
          </div>
        )}
        {ready && (
          <>
            <div role="group" aria-label="Drawing tool" className="flex flex-wrap gap-2 mb-3">
              {MODES.map((m) => (
                <Button
                  key={m.key}
                  variant={mode === m.key ? 'primary' : 'secondary'}
                  aria-pressed={mode === m.key}
                  onClick={() => chooseMode(m.key)}
                >
                  {m.label}
                </Button>
              ))}
              <Button variant="secondary" onClick={() => finishDraft()} disabled={!draft || draft.points.length < 2}>
                Finish line
              </Button>
              <Button variant="secondary" onClick={undo} disabled={!hasContent}>Undo</Button>
              <Button variant="secondary" onClick={clearAll} disabled={!hasContent && editCount(edits) === 0}>
                Clear
              </Button>
            </div>
            <p className="text-14 text-zinc-600 mb-3">{hint}</p>
            <div
              ref={frameRef}
              data-testid="layout-map"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              className="relative w-full overflow-hidden rounded-xs border-hairline border-zinc-300 bg-zinc-100 select-none"
              style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}`, touchAction: 'none', cursor: mode === 'edit' ? 'pointer' : 'crosshair' }}
            >
              <img
                src={mapState.url}
                alt={`Satellite view of ${address || 'the property'}`}
                draggable={false}
                className="absolute inset-0 w-full h-full block"
              />
              <svg
                viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                aria-hidden="true"
                className="absolute inset-0 w-full h-full"
                style={{ pointerEvents: 'none' }}
              >
                {allLines.map((l) => (l.points.length > 1 ? (
                  <g key={l.id} data-testid={`layout-line-${l.kind}`}>
                    <polyline points={l.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#000" strokeOpacity="0.7" strokeWidth="11" strokeLinejoin="round" strokeLinecap="round" />
                    <polyline points={l.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#fff" strokeWidth="5" strokeDasharray={strokeFor(l.kind).dash} strokeLinejoin="round" />
                  </g>
                ) : null))}
                {draft && draft.points.map((p, i) => (
                  <circle key={`d${i}`} cx={p.x} cy={p.y} r="5" fill="#fff" stroke="#000" strokeWidth="2" />
                ))}
                {nozzles.map((n) => (
                  <circle
                    key={n.key}
                    data-testid="layout-nozzle"
                    data-kind={n.kind}
                    cx={n.x}
                    cy={n.y}
                    r="11"
                    fill={n.kind === 'fence' ? '#fff' : '#000'}
                    stroke={n.kind === 'fence' ? '#000' : '#fff'}
                    strokeWidth="3.5"
                  />
                ))}
              </svg>
              <div className="absolute left-2 top-2 right-2 pointer-events-none">
                <span className="inline-block px-2 py-1 rounded-xs bg-black/70 text-white text-14">{CONCEPT_LABEL}</span>
              </div>
            </div>
            {notice && (
              <div role="status" data-testid="layout-edits-cleared" className="mt-3 px-3 py-2 rounded-xs border-hairline border-zinc-300 bg-zinc-50 text-14 text-zinc-900 flex flex-wrap items-center gap-2">
                <span>
                  Changing the lines re-places the nozzles. Your {notice.count} manual {notice.count === 1 ? 'edit was' : 'edits were'} cleared.
                </span>
                <Button variant="secondary" aria-label="Undo and restore the previous lines and edits" onClick={restoreSnapshot}>Undo</Button>
                <button type="button" aria-label="Dismiss notice" className="text-zinc-600 px-2 min-h-11" onClick={() => setNotice(null)}>×</button>
              </div>
            )}
            <div aria-live="polite" data-testid="layout-counts" className="mt-3 text-14 text-zinc-900">
              <div className="font-medium">
                Nozzles: {totals.count} <span className="font-normal text-zinc-600">(eave {totals.eaveCount}, fence {totals.fenceCount})</span>
              </div>
              <div className="text-zinc-600">
                Line: {Math.round(totals.linearFt)} ft <span>(eave {Math.round(totals.eaveFt)} ft, fence {Math.round(totals.fenceFt)} ft)</span>
              </div>
              {limitNote ? <div role="status" className="mt-1 text-amber-800">{limitNote}</div> : null}
            </div>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {ready && (
          <Button onClick={useCounts} disabled={totals.count <= 0}>
            Use counts
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
