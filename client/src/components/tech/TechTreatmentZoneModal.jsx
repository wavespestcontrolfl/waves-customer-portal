// client/src/components/tech/TechTreatmentZoneModal.jsx
//
// Treatment Zone Mapper — the tech traces the treated perimeter over a live
// satellite photo of the property, an animated spray-mist "applies" the
// barrier along the traced line, and the result (path px + lat/lng, linear
// feet, composited snapshot PNG) saves to the visit:
//
//   GET  /api/tech/services/:id/treatment-zone  -> existing trace, if any
//   POST /api/tech/services/:id/treatment-zone  -> multipart snapshot + payload
//
// The saved snapshot replaces the generic schematic on the customer's service
// report (treatmentMap.traced). Gated server-side by GATE_TREATMENT_ZONE_MAP.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAdminAuthToken } from '../../lib/adminAuth';
import {
  DEFAULT_ZOOM,
  FALLBACK_ZOOM,
  MAP_WIDTH,
  MAP_HEIGHT,
  buildSettledAccum,
  composeSnapshot,
  loadMapImage,
  pathLengthPx,
  pixelToLatLng,
  pxToFeet,
  startSprayEngine,
  staticMapUrl,
  exportMapPng,
} from './treatmentZoneSpray';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  red: '#ef4444',
  green: '#22c55e',
  text: '#e2e8f0',
  muted: '#94a3b8',
};

// Spray visuals stay in customer brand colors (mist + sprayer head), separate
// from the DARK chrome above — the snapshot lands on the customer report.
const MIST_COLOR = '#2FA89D';
const HEAD_COLOR = '#E8622C';

const API = import.meta.env.VITE_API_URL || '';
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
const CLOSE_TAP_CSS_PX = 22;

const btnStyle = (kind, disabled) => ({
  padding: '10px 14px',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 700,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  border: kind === 'primary' ? 'none' : `1px solid ${DARK.border}`,
  background: kind === 'primary' ? DARK.teal : 'transparent',
  color: kind === 'primary' ? '#fff' : DARK.text,
});

export default function TechTreatmentZoneModal({
  serviceId, customerName, address, lat, lng, onClose,
}) {
  const [mapState, setMapState] = useState({ status: 'loading' });
  const [existing, setExisting] = useState(null);
  const [step, setStep] = useState('trace');
  const [points, setPoints] = useState([]);
  const [closed, setClosed] = useState(false);
  const [runKey, setRunKey] = useState(0);
  const [status, setStatus] = useState({ phase: 'spraying', pct: 0, feet: 0 });
  const [saveState, setSaveState] = useState(null);
  // Auto-trace (owner 2026-07-21): vision-suggested building perimeter
  // (incl. attached lanai / pool cage) the tech adjusts by dragging corners.
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState('');
  const dragRef = useRef(null); // { index, moved } while a corner drag is live
  const traceRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = getAdminAuthToken();
        const res = await fetch(`${API}/api/tech/services/${serviceId}/treatment-zone`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json();
          // Gate probe: the read route answers enabled:false when
          // GATE_TREATMENT_ZONE_MAP is off, so the tech finds out here —
          // before tracing — instead of at save time.
          if (data.enabled === false) {
            if (!cancelled) {
              setMapState({
                status: 'error',
                message: 'Treatment-zone mapping is not enabled yet. Ask Adam to flip GATE_TREATMENT_ZONE_MAP.',
              });
            }
            return;
          }
          if (!cancelled && data.treatmentZone) setExisting(data.treatmentZone);
        }
      } catch {
        // non-fatal — the tech can still trace
      }

      try {
        if (!MAPS_KEY) throw new Error('Google Maps key is not configured for this build.');
        // null/'' must count as MISSING: Number(null) is 0, and a (0,0)
        // center would load an open-ocean tile the tech could trace and
        // save onto the customer report.
        const coord = (v) => (v == null || v === '' ? null : Number(v));
        let center = Number.isFinite(coord(lat)) && Number.isFinite(coord(lng))
          ? { lat: Number(lat), lng: Number(lng) }
          : null;
        if (!center) {
          // Coordless visit (divergent stamp): geocode server-side — the
          // Geocoding web service rejects referer-restricted browser keys.
          const geoRes = await fetch(`${API}/api/tech/services/${serviceId}/geocode`, {
            headers: { Authorization: `Bearer ${getAdminAuthToken()}` },
          });
          if (geoRes.ok) {
            const geo = await geoRes.json();
            if (Number.isFinite(geo.lat) && Number.isFinite(geo.lng)) {
              center = { lat: geo.lat, lng: geo.lng };
            }
          }
        }
        if (!center) throw new Error('No location on file for this visit.');
        let zoom = DEFAULT_ZOOM;
        let url = staticMapUrl(center.lat, center.lng, zoom, MAPS_KEY);
        let image;
        try {
          image = await loadMapImage(url);
        } catch {
          zoom = FALLBACK_ZOOM;
          url = staticMapUrl(center.lat, center.lng, zoom, MAPS_KEY);
          image = await loadMapImage(url);
        }
        if (!cancelled) setMapState({ status: 'ready', center, zoom, url, image });
      } catch (err) {
        if (!cancelled) setMapState({ status: 'error', message: err.message || 'Map failed to load.' });
      }
    })();
    return () => { cancelled = true; };
  }, [serviceId, address, lat, lng]);

  const totalFeet = mapState.status === 'ready'
    ? pxToFeet(pathLengthPx(points, closed), mapState.center.lat, mapState.zoom)
    : 0;

  const pointerToMapPx = (e) => {
    const rect = traceRef.current.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * MAP_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * MAP_HEIGHT,
      threshold: CLOSE_TAP_CSS_PX * (MAP_WIDTH / rect.width),
    };
  };

  const handleTracePointer = (e) => {
    if (step !== 'trace' || mapState.status !== 'ready') return;
    const { x, y, threshold } = pointerToMapPx(e);
    if (x < 0 || y < 0 || x > MAP_WIDTH || y > MAP_HEIGHT) return;
    // Corner drag: pointer down on an existing point picks it up — the tap
    // vs drag call is resolved on pointer-up (a no-move release on the first
    // point still closes the loop; auto-traced loops adjust the same way).
    const nearIndex = points.findIndex((p) => Math.hypot(p.x - x, p.y - y) < threshold);
    if (nearIndex >= 0) {
      dragRef.current = { index: nearIndex, moved: false };
      try { traceRef.current.setPointerCapture(e.pointerId); } catch { /* older WebKit */ }
      return;
    }
    if (closed) return;
    setPoints((prev) => [...prev, { x, y }]);
  };

  const handleTraceMove = (e) => {
    const drag = dragRef.current;
    if (!drag || step !== 'trace' || mapState.status !== 'ready') return;
    const { x, y } = pointerToMapPx(e);
    if (x < 0 || y < 0 || x > MAP_WIDTH || y > MAP_HEIGHT) return;
    drag.moved = true;
    setPoints((prev) => prev.map((p, i) => (i === drag.index ? { x, y } : p)));
  };

  const handleTraceUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.moved) return;
    // Stationary release = the original tap semantics: first point closes.
    if (!closed && drag.index === 0 && points.length >= 3) setClosed(true);
  };

  const handleAutoTrace = async () => {
    if (suggesting || mapState.status !== 'ready') return;
    setSuggesting(true);
    setSuggestNote('');
    try {
      // Same taint fallback the snapshot save uses (codex P2): a
      // non-canvas-readable map image re-fetches as a bitmap.
      const blob = await exportMapPng(mapState.image, mapState.url);
      const form = new FormData();
      form.append('map', blob, 'map.png');
      const res = await fetch(`${API}/api/tech/services/${serviceId}/treatment-zone/suggest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAdminAuthToken()}` },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.suggestion?.perimeter?.length) {
        throw new Error(data.error || 'Could not detect the building outline — trace it manually.');
      }
      setPoints(data.suggestion.perimeter.map((pt) => ({ x: pt.x * MAP_WIDTH, y: pt.y * MAP_HEIGHT })));
      setClosed(true);
      setSuggestNote(data.suggestion.includesPoolEnclosure
        ? 'Auto-traced — pool enclosure included. Drag any corner to adjust, then Play spray.'
        : 'Auto-traced. Drag any corner to adjust, then Play spray.');
    } catch (err) {
      setSuggestNote(err.message || 'Auto-trace failed — trace manually.');
    } finally {
      setSuggesting(false);
    }
  };

  const save = useCallback(async (accum) => {
    setSaveState('saving');
    try {
      const { center, zoom, url, image } = mapState;
      const blob = await composeSnapshot(image, accum, url);
      const fd = new FormData();
      fd.append('snapshot', blob, 'treatment-zone.png');
      fd.append('payload', JSON.stringify({
        pathPoints: points.map((p) => ({ px: p, latLng: pixelToLatLng(p, center, zoom) })),
        closedLoop: closed,
        linearFt: Math.round(totalFeet),
        lat: center.lat,
        lng: center.lng,
        zoom,
        address: address || null,
      }));
      const token = getAdminAuthToken();
      const res = await fetch(`${API}/api/tech/services/${serviceId}/treatment-zone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSaveState('saved');
      setExisting(data.treatmentZone || null);
    } catch (err) {
      setSaveState(err.message || 'Save failed');
    }
  }, [mapState, points, closed, totalFeet, address, serviceId]);

  useEffect(() => {
    if (step !== 'play' || mapState.status !== 'ready') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    setStatus({ phase: 'spraying', pct: 0, feet: 0 });
    setSaveState(null);
    const totalPx = pathLengthPx(points, closed);
    const lastEmit = { ts: 0 };
    const engine = startSprayEngine({
      canvas,
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      points,
      closed,
      mistColor: MIST_COLOR,
      headColor: HEAD_COLOR,
      durationMs: Math.round(Math.min(8000, Math.max(6000, totalPx * 3))),
      totalFeet,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      onStatus: (s) => {
        const now = performance.now();
        if (s.phase === 'spraying' && now - lastEmit.ts < 100) return;
        lastEmit.ts = now;
        setStatus((prev) => (prev.phase === s.phase && prev.pct === s.pct ? prev : s));
      },
      onSettled: () => {},
    });
    // Save IMMEDIATELY with a fully-settled offscreen band — the on-screen
    // spray is presentation. Waiting for the animation to finish let an
    // impatient Done/backdrop tap unmount the modal before onSettled fired,
    // silently losing the trace.
    save(buildSettledAccum({
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      points,
      closed,
      mistColor: MIST_COLOR,
    }));
    return () => engine.stop();
    // deps intentionally omit `save`: points/closed/map are frozen while playing
  }, [step, runKey, mapState.status]);

  const settled = status.phase !== 'spraying';
  const statusText = settled
    ? `Barrier set — ${Math.round(totalFeet)} linear ft treated`
    : `Applying perimeter barrier — ${Math.round(status.pct * 100)}%`;

  // Every close path locks while the upload is in flight (same reason
  // Back/Replay/Done do): closing lets the tech reopen and re-save, and the
  // OLDER in-flight POST could land last and overwrite the newer perimeter.
  const saving = saveState === 'saving';
  const guardedClose = () => {
    if (!saving) onClose();
  };

  const mapFrame = (children, extraStyle) => (
    <div
      ref={traceRef}
      onPointerDown={handleTracePointer}
      onPointerMove={handleTraceMove}
      onPointerUp={handleTraceUp}
      onPointerCancel={handleTraceUp}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: '4 / 3',
        borderRadius: 10,
        overflow: 'hidden',
        background: '#0a0f14',
        border: `1px solid ${DARK.border}`,
        ...extraStyle,
      }}
    >
      <img
        src={mapState.url}
        alt={`Satellite view of ${customerName || 'the property'}`}
        draggable={false}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />
      {children}
    </div>
  );

  return (
    <div
      onClick={guardedClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: DARK.bg, width: '100%', maxWidth: 560,
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          padding: 16, maxHeight: '92vh', overflowY: 'auto',
          border: `1px solid ${DARK.border}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{
            margin: 0, fontSize: 18, fontWeight: 700, color: DARK.text,
            fontFamily: "'Montserrat', sans-serif",
          }}>
            Treatment Zone
          </h2>
          <button
            onClick={guardedClose}
            disabled={saving}
            style={{
              background: 'transparent', border: 'none', color: DARK.muted,
              fontSize: 24, cursor: saving ? 'wait' : 'pointer',
              opacity: saving ? 0.4 : 1, padding: '0 4px', lineHeight: 1,
            }}
          >×</button>
        </div>
        {customerName && (
          <p style={{ margin: '0 0 12px', fontSize: 13, color: DARK.muted }}>{customerName}</p>
        )}

        {existing && step === 'trace' && points.length === 0 && (
          <div style={{
            background: `${DARK.green}18`, border: `1px solid ${DARK.green}`,
            color: DARK.green, padding: '8px 10px', borderRadius: 6,
            fontSize: 13, marginBottom: 12,
          }}>
            Already traced ({existing.linear_ft ?? '?'} linear ft). Tracing again replaces it.
          </div>
        )}

        {mapState.status === 'loading' && (
          <p style={{ color: DARK.muted, fontSize: 14, textAlign: 'center', padding: 40 }}>
            Loading satellite photo…
          </p>
        )}
        {mapState.status === 'error' && (
          <div style={{
            background: `${DARK.red}22`, border: `1px solid ${DARK.red}`, color: DARK.red,
            padding: '10px 12px', borderRadius: 6, fontSize: 14,
          }}>
            {mapState.message}
          </div>
        )}

        {mapState.status === 'ready' && step === 'trace' && (
          <>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: DARK.muted }}>
              {points.length === 0
                ? 'Auto-trace the building outline (pool cage included), or tap the photo to drop points yourself.'
                : 'Tap the photo to drop points along the treated line. Drag any point to adjust it.'}
              {points.length >= 3 && !closed ? ' Tap the first point again to close the loop.' : ''}
            </p>
            {suggestNote ? (
              <p style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: DARK.teal }}>{suggestNote}</p>
            ) : null}
            {mapFrame(
              <svg
                viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                aria-hidden="true"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
              >
                {points.length > 1 && (
                  <polyline
                    points={(closed ? [...points, points[0]] : points).map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke={MIST_COLOR}
                    strokeWidth={5}
                    strokeDasharray="14 12"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {points.map((p, i) => (
                  <g key={i}>
                    {i === 0 && points.length >= 3 && !closed && (
                      <circle cx={p.x} cy={p.y} r={20} fill="none" stroke={HEAD_COLOR} strokeWidth={3} />
                    )}
                    <circle
                      cx={p.x} cy={p.y} r={8}
                      fill={i === 0 ? HEAD_COLOR : MIST_COLOR}
                      stroke="#fff" strokeWidth={2.5}
                    />
                  </g>
                ))}
              </svg>,
              { cursor: 'crosshair', touchAction: 'none' },
            )}
            <p style={{ margin: '10px 0', fontSize: 13, fontWeight: 700, color: DARK.text }}>
              {points.length} point{points.length === 1 ? '' : 's'}
              {points.length > 1 ? ` · ~${Math.round(totalFeet)} linear ft` : ''}
              {closed ? ' · loop closed' : ''}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                style={btnStyle('ghost', suggesting || points.length > 0)}
                disabled={suggesting || points.length > 0}
                onClick={handleAutoTrace}
              >
                {suggesting ? 'Detecting…' : 'Auto-trace'}
              </button>
              <button
                style={btnStyle('ghost', points.length === 0)}
                disabled={points.length === 0}
                onClick={() => {
                  if (closed) { setClosed(false); return; }
                  setPoints((prev) => prev.slice(0, -1));
                  if (points.length === 1) setSuggestNote('');
                }}
              >
                {closed ? 'Reopen loop' : 'Undo point'}
              </button>
              <button
                style={btnStyle('ghost', points.length < 3 || closed)}
                disabled={points.length < 3 || closed}
                onClick={() => setClosed(true)}
              >
                Close loop
              </button>
              <button
                style={btnStyle('primary', points.length < 2)}
                disabled={points.length < 2}
                onClick={() => setStep('play')}
              >
                Play spray
              </button>
            </div>
          </>
        )}

        {mapState.status === 'ready' && step === 'play' && (
          <>
            {mapFrame(
              <canvas
                ref={canvasRef}
                aria-hidden="true"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
              />,
            )}
            <p style={{
              margin: '10px 0', fontSize: 14, fontWeight: 700,
              color: settled ? DARK.green : DARK.text,
            }}>
              {statusText}
            </p>
            {saveState === 'saving' && (
              <p style={{ margin: '0 0 10px', fontSize: 13, color: DARK.muted }}>Saving to the service report…</p>
            )}
            {saveState === 'saved' && (
              <p style={{ margin: '0 0 10px', fontSize: 13, color: DARK.green }}>
                Saved — this map now appears on the customer&apos;s service report.
              </p>
            )}
            {saveState && saveState !== 'saving' && saveState !== 'saved' && (
              <div style={{
                background: `${DARK.red}22`, border: `1px solid ${DARK.red}`, color: DARK.red,
                padding: '8px 10px', borderRadius: 6, fontSize: 13, marginBottom: 10,
              }}>
                {saveState}
              </div>
            )}
            {/* Back/Replay lock while the upload is in flight: re-tracing or
                replaying mid-save could let the OLDER request land last and
                overwrite the newer perimeter on the report. */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                style={btnStyle('ghost', saveState === 'saving')}
                disabled={saveState === 'saving'}
                onClick={() => setStep('trace')}
              >
                Back to trace
              </button>
              <button
                style={btnStyle('ghost', saveState === 'saving')}
                disabled={saveState === 'saving'}
                onClick={() => setRunKey((k) => k + 1)}
              >
                Replay
              </button>
              <button
                style={btnStyle('primary', saveState === 'saving')}
                disabled={saveState === 'saving'}
                onClick={onClose}
              >
                {saveState === 'saving' ? 'Saving…' : 'Done'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
