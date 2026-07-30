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
  MAP_WIDTH,
  MAP_HEIGHT,
  MIN_TRACE_ZOOM,
  buildAlignedBase,
  buildLawnHighlightMask,
  buildOutlineAccum,
  buildSettledAccum,
  composeSnapshot,
  dominantAngleRad,
  loadBestMapImage,
  loadMapImage,
  pathLengthPx,
  pixelToLatLng,
  pxToFeet,
  rescalePointsForZoom,
  rotatePointsAboutCenter,
  startSprayEngine,
  staticMapUrl,
  unrotatePointAboutCenter,
  exportMapPng,
} from './treatmentZoneSpray';

// Below this, the home already reads square — don't churn the frame. Radians.
const ALIGN_MIN_ANGLE = (4 * Math.PI) / 180;

// Two appearances, one component. `dark` is the tech-portal chrome (that
// surface stays Montserrat + dark palette by rule — see TechHomePage.jsx).
// `light` mirrors the admin CompletionPanel "M" theme (near-white surfaces,
// #111 ink, hairline borders, black pill CTAs, Roboto — the closeout host
// this modal opens from via "Trace where we sprayed").
const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  accent: '#0ea5e9',
  red: '#ef4444',
  ok: '#22c55e',
  noticeBg: '#22c55e18',
  noticeBorder: '#22c55e',
  noticeText: '#22c55e',
  text: '#e2e8f0',
  muted: '#94a3b8',
  mapBackdrop: '#0a0f14',
  scrim: 'rgba(0,0,0,0.7)',
};

// Owner rule (2026-07-23): the admin appearance is strictly black and white —
// success/info chrome renders in ink, never green. `red` stays only for
// genuine failures (the admin spec's red-is-for-alerts-only line). The spray
// visuals on the photo keep customer brand colors; that snapshot is a
// customer-report artifact, not admin chrome.
const LIGHT = {
  bg: '#FAFAFA',
  card: '#FFFFFF',
  border: '#E5E5E5',
  accent: '#111111',
  red: '#C2410C',
  ok: '#111111',
  noticeBg: '#FFFFFF',
  noticeBorder: '#E5E5E5',
  noticeText: '#111111',
  text: '#111111',
  muted: '#737373',
  mapBackdrop: '#F5F5F5',
  scrim: 'rgba(0,0,0,0.4)',
  font: "'Roboto', Arial, sans-serif",
};

// Spray visuals stay in customer brand colors (mist + sprayer head), separate
// from the DARK chrome above — the snapshot lands on the customer report.
// Mist is the bright waves blue (owner 2026-07-29; was teal #2FA89D, then
// glass navy #04395E which read like a shadow — "friendly, inviting" won).
// Keep in sync with TracedTreatmentZoneMap.jsx, which replays over the same
// snapshot.
const MIST_COLOR = '#0A7EC2';
const HEAD_COLOR = '#E8622C';

const API = import.meta.env.VITE_API_URL || '';
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
const CLOSE_TAP_CSS_PX = 22;

export default function TechTreatmentZoneModal({
  serviceId, customerName, address, lat, lng, onClose, onSaved,
  appearance = 'dark',
  // Lawn visits outline the treated AREA (clean pulsing outline on the report)
  // instead of the perimeter spray-mist metaphor (owner 2026-07-28).
  lawnMode = false,
}) {
  const light = appearance === 'light';
  const T = light ? LIGHT : DARK;
  // Light buttons are the M-theme pills (44px, rounded-full, UPPERCASE 500);
  // dark keeps the original tech-portal buttons untouched.
  const btnStyle = (kind, disabled) => (light
    ? {
        height: 44,
        padding: '0 16px',
        borderRadius: 999,
        fontFamily: LIGHT.font,
        fontSize: 14,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.3px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: kind === 'primary' ? 'none' : `1px solid ${LIGHT.text}`,
        background: kind === 'primary' ? LIGHT.accent : 'transparent',
        color: kind === 'primary' ? '#FFFFFF' : LIGHT.text,
      }
    : {
        padding: '10px 14px',
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: kind === 'primary' ? 'none' : `1px solid ${DARK.border}`,
        background: kind === 'primary' ? DARK.accent : 'transparent',
        color: kind === 'primary' ? '#fff' : DARK.text,
      });
  // Admin weight cap is 400/500; the dark variant keeps its original weights.
  const strong = light ? 500 : 700;
  // The admin surface enforces a 14px floor for readable text (AGENTS.md);
  // dark keeps the tech portal's original 13px small text.
  const smallText = light ? 14 : 13;
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
  // Zoom stepper (owner 2026-07-29): the default frame is sometimes too tight
  // to finish the trace. `maxZoom` is whatever the initial imagery probe
  // accepted — deeper was already tried and rejected.
  const [zoomBusy, setZoomBusy] = useState(false);
  // Interior spray showcase (owner 2026-07-29): renders the traced footprint
  // flooded with the brand-blue wash on top of the perimeter band. Area
  // claim ⇒ requires a closed loop, same rule as lawn outlines.
  const [interior, setInterior] = useState(false);
  const dragRef = useRef(null); // { index, moved } while a corner drag is live
  const traceRef = useRef(null);
  const canvasRef = useRef(null);
  // Waves mascot rides the spray line as the emitter (owner 2026-07-29).
  // Same-origin asset — no canvas taint; engine falls back to the circle
  // head until it loads.
  const logoRef = useRef(null);
  useEffect(() => {
    const im = new Image();
    im.onload = () => { logoRef.current = im; };
    im.src = '/waves-logo.png';
  }, []);

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
        const { image, url, zoom } = await loadBestMapImage(center.lat, center.lng, MAPS_KEY);
        // angle = how far the displayed frame is rotated from north-up (rad).
        // 0 until auto-trace finds the home's orientation and squares it up.
        if (!cancelled) setMapState({ status: 'ready', center, zoom, maxZoom: zoom, url, image, angle: 0 });
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
    // Locked while a zoom reload or auto-trace is in flight — their async
    // completions commit points/frames computed from the pre-await state,
    // and interleaved taps would be overwritten or land on the wrong frame
    // (pre-push audit P1 2026-07-29).
    if (zoomBusy || suggesting) return;
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
    if (suggesting || zoomBusy || mapState.status !== 'ready') return;
    setSuggesting(true);
    setSuggestNote('');
    try {
      // Same taint fallback the snapshot save uses (codex P2): a
      // non-canvas-readable map image re-fetches as a bitmap.
      const blob = await exportMapPng(mapState.image, mapState.url);
      const form = new FormData();
      form.append('map', blob, 'map.png');
      // Lawn mode asks the vision suggester for the TURF boundary — the
      // default building-footprint suggestion would outline the house as the
      // treated lawn area (pre-push audit P1 2026-07-28).
      if (lawnMode) form.append('mode', 'lawn');
      const res = await fetch(`${API}/api/tech/services/${serviceId}/treatment-zone/suggest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAdminAuthToken()}` },
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.suggestion?.perimeter?.length) {
        throw new Error(data.error || (lawnMode
          ? 'Could not detect the lawn outline — trace it manually.'
          : 'Could not detect the building outline — trace it manually.'));
      }
      let pts = data.suggestion.perimeter.map((pt) => ({ x: pt.x * MAP_WIDTH, y: pt.y * MAP_HEIGHT }));
      // Align the photo with the home (owner 2026-07-29): satellite tiles are
      // north-up, so homes on angled lots render crooked. The suggested
      // footprint gives us the property's orientation — rotate the working
      // frame so it sits square, and rotate the suggestion with it.
      // Fail-soft: any hiccup keeps the north-up frame. Lawn included (owner
      // 2026-07-30 "do it for lawn"): suburban turf boundaries follow the
      // rectangular lot, so their dominant angle is just as meaningful — and
      // a genuinely organic loop averages out below the threshold anyway.
      {
        const tilt = dominantAngleRad(pts, true);
        if (Math.abs(tilt) > ALIGN_MIN_ANGLE) {
          try {
            const { center, zoom, angle = 0 } = mapState;
            const aligned = await buildAlignedBase(center.lat, center.lng, zoom, MAPS_KEY, angle + tilt);
            const rotated = rotatePointsAboutCenter(pts, tilt);
            if (rotated.every((p) => p.x >= 0 && p.y >= 0 && p.x <= MAP_WIDTH && p.y <= MAP_HEIGHT)) {
              setMapState((prev) => ({ ...prev, image: aligned.image, url: aligned.url, angle: angle + tilt }));
              pts = rotated;
            }
          } catch { /* keep the north-up frame */ }
        }
      }
      setPoints(pts);
      setClosed(true);
      setSuggestNote(data.suggestion.includesPoolEnclosure
        ? `Auto-traced — pool enclosure included. Drag any corner to adjust, then ${lawnMode ? 'Set outline' : 'Play spray'}.`
        : `Auto-traced. Drag any corner to adjust, then ${lawnMode ? 'Set outline' : 'Play spray'}.`);
    } catch (err) {
      setSuggestNote(err.message || 'Auto-trace failed — trace manually.');
    } finally {
      setSuggesting(false);
    }
  };

  // Step the map zoom in place. The Static Map re-centers on the same
  // lat/lng, so dropped points re-project exactly (pure 2× scale per step) —
  // linear-ft and lat/lng math follow mapState.zoom automatically.
  const changeZoom = async (delta) => {
    if (zoomBusy || suggesting || step !== 'trace' || mapState.status !== 'ready') return;
    const target = mapState.zoom + delta;
    if (target < MIN_TRACE_ZOOM || target > mapState.maxZoom) return;
    const scaled = rescalePointsForZoom(points, delta);
    // Zooming in pushes points outward — never let a dropped point leave the
    // frame where it becomes untappable and undraggable.
    if (delta > 0 && scaled.some((p) => p.x < 0 || p.y < 0 || p.x > MAP_WIDTH || p.y > MAP_HEIGHT)) {
      setSuggestNote('Your trace fills the frame — finish it at this zoom.');
      return;
    }
    setZoomBusy(true);
    try {
      let next;
      if (mapState.angle) {
        // Aligned frame: rebuild the rotated crop at the new zoom.
        next = await buildAlignedBase(mapState.center.lat, mapState.center.lng, target, MAPS_KEY, mapState.angle);
      } else {
        const url = staticMapUrl(mapState.center.lat, mapState.center.lng, target, MAPS_KEY);
        next = { url, image: await loadMapImage(url) };
      }
      setMapState((prev) => ({ ...prev, zoom: target, url: next.url, image: next.image }));
      // Functional update — trace input is locked while zoomBusy, and this
      // re-derives from the latest state rather than the pre-await snapshot
      // (pre-push audit P1 2026-07-29).
      setPoints((prev) => rescalePointsForZoom(prev, delta));
    } catch {
      setSuggestNote('That zoom level failed to load — try again.');
    } finally {
      setZoomBusy(false);
    }
  };

  const save = useCallback(async () => {
    setSaveState('saving');
    try {
      const { center, zoom, url, image, angle = 0 } = mapState;
      // Align the SAVED frame with the home (owner 2026-07-29; lawn included
      // 2026-07-30). Manual traces usually run on the north-up display —
      // square the snapshot to the traced loop's own dominant angle so the
      // customer report shows the property straight-on. Display-aligned
      // frames (auto-trace) come through with tilt ≈ 0 and skip this.
      // Fail-soft to the north-up save.
      let finalPoints = points;
      let base = image;
      let baseUrl = url;
      let totalAngle = angle;
      if (MAPS_KEY) {
        const tilt = dominantAngleRad(points, closed);
        if (Math.abs(tilt) > ALIGN_MIN_ANGLE) {
          try {
            const aligned = await buildAlignedBase(center.lat, center.lng, zoom, MAPS_KEY, angle + tilt);
            const rotated = rotatePointsAboutCenter(points, tilt);
            if (rotated.every((p) => p.x >= 0 && p.y >= 0 && p.x <= MAP_WIDTH && p.y <= MAP_HEIGHT)) {
              base = aligned.image;
              baseUrl = aligned.url;
              finalPoints = rotated;
              totalAngle = angle + tilt;
            }
          } catch { /* save the north-up frame */ }
        }
      }
      let lawnMask = null;
      if (lawnMode && closed) {
        // Grass highlight for the SAVED snapshot (no box — owner
        // 2026-07-30), built from the same (possibly aligned) base the
        // snapshot composes over. A tainted canvas throws — retry from a
        // CORS-checked re-fetch of the same tile (the exact bitmap
        // composeSnapshot's own taint fallback will compose over), so the
        // report keeps the grass highlight instead of silently downgrading
        // to the outline (codex P2 #3075). A null return means "no turf
        // found" — re-fetching can't change that, so the outline fallback
        // is correct there (codex P1 #3075).
        const maskArgs = { points: finalPoints, closed, width: MAP_WIDTH, height: MAP_HEIGHT };
        try {
          lawnMask = buildLawnHighlightMask({ source: base, ...maskArgs });
        } catch {
          try {
            const bitmap = await createImageBitmap(await (await fetch(baseUrl)).blob());
            lawnMask = buildLawnHighlightMask({ source: bitmap, ...maskArgs });
          } catch { lawnMask = null; }
        }
      }
      const accum = lawnMode
        ? (lawnMask || buildOutlineAccum({
          width: MAP_WIDTH, height: MAP_HEIGHT, points: finalPoints, closed,
          color: MIST_COLOR,
        }))
        : buildSettledAccum({
          width: MAP_WIDTH, height: MAP_HEIGHT, points: finalPoints, closed,
          mistColor: MIST_COLOR, interior,
        });
      const blob = await composeSnapshot(base, accum, baseUrl);
      const fd = new FormData();
      fd.append('snapshot', blob, 'treatment-zone.png');
      fd.append('payload', JSON.stringify({
        // px lives in the (possibly rotated) snapshot's space — the report
        // replay overlays it on that snapshot. lat/lng is true ground truth:
        // the point is un-rotated back to north-up map space first.
        pathPoints: finalPoints.map((p) => ({
          px: p,
          latLng: pixelToLatLng(unrotatePointAboutCenter(p, totalAngle), center, zoom),
        })),
        closedLoop: closed,
        linearFt: Math.round(totalFeet),
        lat: center.lat,
        lng: center.lng,
        zoom,
        address: address || null,
        // Discriminates what was ACTUALLY rendered (codex P1 #3038, #3075):
        // 'lawn_highlight' = grass mask baked into this snapshot;
        // 'lawn' = lawn area claim that fell back to the outline;
        // 'interior' = building footprint + interior wash (owner 2026-07-29).
        captureMode: lawnMode
          ? (lawnMask ? 'lawn_highlight' : 'lawn')
          : (interior ? 'interior' : 'perimeter'),
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
      // Let the host prefill from the trace (e.g. perimeter-spray Linear ft
      // on the completion card) without refetching the row it just saved.
      onSaved?.(data.treatmentZone || null);
    } catch (err) {
      setSaveState(err.message || 'Save failed');
    }
  }, [mapState, points, closed, totalFeet, address, serviceId, onSaved, lawnMode, interior]);

  useEffect(() => {
    if (step !== 'play' || mapState.status !== 'ready') return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    setSaveState(null);
    // Lawn animates too (owner 2026-07-30 "now lets do it for lawn"): the
    // outline draws itself with the mascot riding the tip, then breathes —
    // outlineMode keeps the no-smoke lawn ruling; the spray path is untouched.
    setStatus({ phase: 'spraying', pct: 0, feet: 0 });
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
      logoImage: logoRef.current,
      interior: !lawnMode && interior,
      outlineMode: lawnMode,
      baseImage: mapState.image,
      // Lawn is a highlight fade-in — quick; the fallback outline draw and
      // the spray keep their pacing.
      durationMs: lawnMode
        ? 2200
        : Math.round(Math.min(8000, Math.max(6000, totalPx * 3))),
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
    // Save IMMEDIATELY — the on-screen spray is presentation. Waiting for the
    // animation to finish let an impatient Done/backdrop tap unmount the
    // modal before onSettled fired, silently losing the trace. save() builds
    // its own fully-settled band offscreen (home-aligned when applicable).
    save();
    return () => engine.stop();
    // deps intentionally omit `save`: points/closed/map are frozen while playing
  }, [step, runKey, mapState.status]);

  const settled = status.phase !== 'spraying';
  const statusText = lawnMode
    ? (settled
      ? `Lawn areas highlighted — ${Math.round(totalFeet)} ft boundary`
      : 'Highlighting the lawn…')
    : settled
      ? (interior
        ? `Home protected — interior + ${Math.round(totalFeet)} linear ft perimeter`
        : `Barrier set — ${Math.round(totalFeet)} linear ft treated`)
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
        borderRadius: light ? 12 : 10,
        overflow: 'hidden',
        background: T.mapBackdrop,
        border: `1px solid ${T.border}`,
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
        position: 'fixed', inset: 0, background: T.scrim,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: T.bg, width: '100%', maxWidth: 560,
          borderTopLeftRadius: 16, borderTopRightRadius: 16,
          padding: 16, maxHeight: '92vh', overflowY: 'auto',
          border: `1px solid ${T.border}`,
          fontFamily: T.font,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{
            margin: 0, fontSize: 18, fontWeight: strong, color: T.text,
            fontFamily: light ? LIGHT.font : "'Montserrat', sans-serif",
          }}>
            Treatment Zone
          </h2>
          <button
            onClick={guardedClose}
            disabled={saving}
            style={{
              background: 'transparent', border: 'none', color: T.muted,
              fontSize: 24, cursor: saving ? 'wait' : 'pointer',
              opacity: saving ? 0.4 : 1, padding: '0 4px', lineHeight: 1,
            }}
          >×</button>
        </div>
        {customerName && (
          <p style={{ margin: '0 0 12px', fontSize: smallText, color: T.muted }}>{customerName}</p>
        )}

        {existing && step === 'trace' && points.length === 0 && (
          <div style={{
            background: T.noticeBg, border: `1px solid ${T.noticeBorder}`,
            color: T.noticeText, padding: '8px 10px', borderRadius: 6,
            fontSize: smallText, marginBottom: 12,
          }}>
            Already traced ({existing.linear_ft ?? '?'} linear ft). Tracing again replaces it.
          </div>
        )}

        {mapState.status === 'loading' && (
          <p style={{ color: T.muted, fontSize: 14, textAlign: 'center', padding: 40 }}>
            Loading satellite photo…
          </p>
        )}
        {mapState.status === 'error' && (
          <div style={{
            background: `${T.red}22`, border: `1px solid ${T.red}`, color: T.red,
            padding: '10px 12px', borderRadius: 6, fontSize: 14,
          }}>
            {mapState.message}
          </div>
        )}

        {mapState.status === 'ready' && step === 'trace' && (
          <>
            <p style={{ margin: '0 0 10px', fontSize: smallText, color: T.muted }}>
              {points.length === 0
                ? (lawnMode
                  ? 'Auto-trace the lawn outline, or tap the photo to drop points yourself. Photo too tight? Tap − to zoom out.'
                  : 'Auto-trace the building outline (pool cage included), or tap the photo to drop points yourself. Photo too tight? Tap − to zoom out.')
                : 'Tap the photo to drop points along the treated line. Drag any point to adjust it.'}
              {points.length >= 3 && !closed ? ' Tap the first point again to close the loop.' : ''}
            </p>
            {suggestNote ? (
              <p style={{ margin: '0 0 10px', fontSize: smallText, fontWeight: light ? 500 : 600, color: T.accent }}>{suggestNote}</p>
            ) : null}
            {mapFrame(
              <>
              <svg
                viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
                aria-hidden="true"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
              >
                {/* Closed loop pulses (owner 2026-07-29): dashed while
                    tracing, solid + breathing once the loop completes. The
                    brand-navy line rides a white casing — navy alone sinks
                    into satellite imagery. */}
                {closed && (
                  <style>{'@keyframes tzLoopPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }'}</style>
                )}
                {points.length > 1 && (
                  <g style={closed ? { animation: 'tzLoopPulse 2s ease-in-out infinite' } : undefined}>
                    {[
                      { stroke: '#FFFFFF', width: closed ? 16 : 10, opacity: 0.85 },
                      { stroke: MIST_COLOR, width: closed ? 9 : 5, opacity: 1 },
                    ].map((line) => (
                      <polyline
                        key={line.stroke}
                        points={(closed ? [...points, points[0]] : points).map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="none"
                        stroke={line.stroke}
                        strokeOpacity={line.opacity}
                        strokeWidth={line.width}
                        strokeDasharray={closed ? undefined : '14 12'}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ))}
                  </g>
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
              </svg>
              <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[
                  { label: '+', delta: 1, blocked: mapState.zoom >= mapState.maxZoom },
                  { label: '−', delta: -1, blocked: mapState.zoom <= MIN_TRACE_ZOOM },
                ].map(({ label, delta, blocked }) => (
                  <button
                    key={label}
                    type="button"
                    aria-label={delta > 0 ? 'Zoom in' : 'Zoom out'}
                    disabled={blocked || zoomBusy}
                    // The frame's pointerdown drops trace points — the zoom
                    // buttons must never bubble into it.
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); changeZoom(delta); }}
                    style={{
                      width: 40, height: 40, borderRadius: 8, border: 'none',
                      background: 'rgba(15,25,35,0.72)', color: '#fff',
                      fontSize: 22, lineHeight: 1, fontWeight: 600,
                      cursor: blocked || zoomBusy ? 'default' : 'pointer',
                      opacity: blocked ? 0.35 : 1, touchAction: 'manipulation',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              </>,
              { cursor: 'crosshair', touchAction: 'none' },
            )}
            <p style={{ margin: '10px 0', fontSize: smallText, fontWeight: strong, color: T.text }}>
              {points.length} point{points.length === 1 ? '' : 's'}
              {points.length > 1 ? ` · ~${Math.round(totalFeet)} linear ft` : ''}
              {closed ? ' · loop closed' : ''}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                style={btnStyle('ghost', suggesting || zoomBusy || points.length > 0)}
                disabled={suggesting || zoomBusy || points.length > 0}
                onClick={handleAutoTrace}
              >
                {suggesting ? 'Detecting…' : 'Auto-trace'}
              </button>
              <button
                style={btnStyle('ghost', points.length === 0 || zoomBusy || suggesting)}
                disabled={points.length === 0 || zoomBusy || suggesting}
                onClick={() => {
                  if (closed) { setClosed(false); return; }
                  setPoints((prev) => prev.slice(0, -1));
                  if (points.length === 1) setSuggestNote('');
                }}
              >
                {closed ? 'Reopen loop' : 'Undo point'}
              </button>
              <button
                style={btnStyle('ghost', points.length < 3 || closed || zoomBusy || suggesting)}
                disabled={points.length < 3 || closed || zoomBusy || suggesting}
                onClick={() => setClosed(true)}
              >
                Close loop
              </button>
              {/* A lawn OUTLINE is an area claim — it needs a closed loop of
                  3+ points before it can be set; an open 2-point line would
                  save captureMode 'lawn' and read as a treated lawn area on
                  the report (codex P2 #3038). Interior spray is an area
                  claim too, so it carries the same closed-loop gate.
                  Plain perimeter keeps its open-path spray behavior. */}
              <button
                style={btnStyle('primary', zoomBusy || suggesting || ((lawnMode || interior) ? (points.length < 3 || !closed) : points.length < 2))}
                disabled={zoomBusy || suggesting || ((lawnMode || interior) ? (points.length < 3 || !closed) : points.length < 2)}
                onClick={() => setStep('play')}
              >
                {lawnMode ? 'Set outline' : 'Play spray'}
              </button>
            </div>
            {!lawnMode && (
              /* Interior spray showcase (owner 2026-07-29): also flood the
                 traced footprint with the brand-blue wash on the report. */
              <label style={{
                display: 'flex', alignItems: 'center', gap: 8, margin: '10px 0 0',
                fontSize: smallText, color: T.text, cursor: 'pointer', width: 'fit-content',
              }}>
                <input
                  type="checkbox"
                  checked={interior}
                  onChange={(e) => setInterior(e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: light ? LIGHT.accent : DARK.accent }}
                />
                Interior spray too — shade the whole home as treated
              </label>
            )}
            {(lawnMode || interior) && points.length >= 3 && !closed && (
              <p style={{ margin: '8px 0 0', fontSize: smallText, color: T.muted }}>
                Tap Close loop to finish the {lawnMode ? 'lawn outline' : 'home footprint'}.
              </p>
            )}
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
              margin: '10px 0', fontSize: 14, fontWeight: strong,
              color: settled ? T.ok : T.text,
            }}>
              {statusText}
            </p>
            {saveState === 'saving' && (
              <p style={{ margin: '0 0 10px', fontSize: smallText, color: T.muted }}>Saving to the service report…</p>
            )}
            {saveState === 'saved' && (
              <p style={{ margin: '0 0 10px', fontSize: smallText, color: T.ok }}>
                Saved — this map now appears on the customer&apos;s service report.
              </p>
            )}
            {saveState && saveState !== 'saving' && saveState !== 'saved' && (
              <div style={{
                background: `${T.red}22`, border: `1px solid ${T.red}`, color: T.red,
                padding: '8px 10px', borderRadius: 6, fontSize: smallText, marginBottom: 10,
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
              {/* Lawn replays too now that the outline animates (2026-07-30). */}
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
