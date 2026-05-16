/**
 * <DispatchMap> — center pane. Google Maps via @react-google-maps/api
 * (pinned 2.20.8 in client/package.json — DON'T let the version float;
 * minor version bumps on map libs have a history of quietly breaking
 * marker rendering).
 *
 * Markers:
 *   - <Marker> per tech with valid lat/lng → Waves van pin colored by
 *     tech.id (deterministic hash → palette). Click → setSelectedTechId.
 *   - <Marker> per job with valid lat/lng → "job" pin colored by the
 *     assigned technician_id (matches the tech van color so unassigned
 *     jobs render in a neutral gray). Click → onSelectJob(job.id) opens
 *     the JobDrawer; drag onto a tech roster card → reassign.
 *
 * Selected tech receives a thicker stroke + halo to match the highlight
 * on the corresponding <TechCard>.
 *
 * Drag-to-reassign:
 *   Job markers are draggable. On dragend we hit-test the drop point
 *   against React DOM tech cards via document.elementFromPoint, walk
 *   up to find a [data-tech-card-id] ancestor, and (if found) call
 *   onJobDropOnTech(jobId, techId). That handler in DispatchBoardPage
 *   PUTs /api/admin/dispatch/jobs/:id/assign — the existing assignment
 *   endpoint from PR #320. Drop outside any card is a no-op; React
 *   re-renders the marker at its original position because we never
 *   mutate job.lat/lng here.
 *
 *   Why not @dnd-kit: Google Maps markers render outside React's tree
 *   (they're WebGL/canvas managed by the Maps SDK), so @dnd-kit's
 *   sensors + collision detection don't apply. The native
 *   marker.draggable + DOM hit-test is the only path that bridges the
 *   two trees.
 *
 *   Snap-back: we never write the dragged coords anywhere; the marker
 *   visually moves during drag (Maps SDK behavior), then on the next
 *   React render it returns to job.lat/lng. The dispatch:job_update
 *   broadcast from a successful PUT will re-color the pin via the new
 *   technician_id without changing position.
 *
 * API key: pulled from VITE_GOOGLE_MAPS_API_KEY (server-controlled env,
 * already used by the customer tracker + AddressAutocomplete). The
 * key MUST be HTTP-referrer restricted to the Waves portal domains in
 * the Google Cloud Console — that's the security boundary, not the
 * absence of the key from the bundle.
 *
 * Tier 1 V2 styling for chrome (loading / error states); the GoogleMap
 * itself is a flex container with no V2 chrome.
 */
import React, { useMemo, useCallback, useEffect, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader, Marker } from '@react-google-maps/api';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

// Manatee/Sarasota core. Maps centers here when no markers have valid
// coords (first-load before any tech has pinged).
const DEFAULT_CENTER = { lat: 27.4989, lng: -82.5748 };

// Deterministic per-tech color palette — uses Waves brand + zinc
// accents so the map ties visually to the rest of V2 chrome. Stable
// hash of tech.id so the same tech gets the same color across reloads.
const PALETTE = [
  '#0A7EC2', // waves-blue
  '#065A8C', // waves-blue-dark
  '#F0A500', // waves-gold
  '#3F3F46', // zinc-700
  '#71717A', // zinc-500
  '#04395E', // waves-blue-deeper
  '#52525B', // zinc-600
  '#C0392B', // waves-red (reserve for high-attention; present here for diversity)
];
const NEUTRAL = '#A1A1AA'; // zinc-400 — unassigned jobs

function hashId(id) {
  let h = 0;
  for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorForTech(techId) {
  if (!techId) return NEUTRAL;
  return PALETTE[hashId(techId) % PALETTE.length];
}

function svgPin(color, isSelected = false, isTruck = false) {
  // Inline SVG so we don't ship marker images. Tech pins are Waves
  // van icons; job pins stay circles for an at-a-glance "tech is here"
  // vs "job is there" read without a legend.
  const stroke = isSelected ? '#18181B' : '#FFFFFF';
  const strokeWidth = isSelected ? 3 : 1.5;
  if (isTruck) {
    const size = isSelected ? 38 : 34;
    const haloStroke = isSelected ? '#18181B' : color;
    const stripe = color === '#F0A500' ? '#0A7EC2' : '#F0A500';
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="${isSelected ? 17 : 15}" fill="#FFFFFF" stroke="${haloStroke}" stroke-width="${isSelected ? 3 : 2}"/>
        <g transform="translate(4 10)">
          <path d="M3 8.5C3 6.6 4.6 5 6.5 5h13.6c1.7 0 3.2.9 4.1 2.3l2.7 4.2H31c1.1 0 2 .9 2 2V18H3V8.5Z" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>
          <path d="M7 8h6.6v4.1H7V8Zm9 0h4.2c.8 0 1.5.4 1.9 1.1l1.8 3H16V8Z" fill="#DFF2FF"/>
          <path d="M5.3 14.6h25.8" stroke="${stripe}" stroke-width="2" stroke-linecap="round"/>
          <circle cx="10" cy="18" r="3.1" fill="#18181B"/>
          <circle cx="26" cy="18" r="3.1" fill="#18181B"/>
          <circle cx="10" cy="18" r="1.2" fill="#FFFFFF"/>
          <circle cx="26" cy="18" r="1.2" fill="#FFFFFF"/>
          <circle cx="30" cy="7" r="3" fill="#FFFFFF" stroke="${color}" stroke-width="1.5"/>
        </g>
      </svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  }
  const size = isSelected ? 28 : 22;
  const shape = `<circle cx="14" cy="14" r="9" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 28 28">${shape}</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export default function DispatchMap({
  techs, jobs, selectedTechId, onSelectTech, onSelectJob,
  // Drag-to-reassign hooks (optional; if omitted, markers render
  // non-draggable). DispatchBoardPage owns the drag state.
  onJobDragStart,
  onJobDragEnd,
  onJobDropOnTech,
}) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: MAPS_KEY,
  });

  const [mapCenter, setMapCenter] = useState(DEFAULT_CENTER);
  const centeredOnMarkersRef = useRef(false);

  // Average available marker coords. We use this only for the first
  // non-empty marker set so a late GPS ping centers the initial board,
  // while later pings don't yank a dispatcher away from their pan/zoom.
  const markerCenter = useMemo(() => {
    const points = [];
    for (const t of techs) if (t.lat != null && t.lng != null) points.push([t.lat, t.lng]);
    for (const j of jobs) if (j.lat != null && j.lng != null) points.push([j.lat, j.lng]);
    if (points.length === 0) return null;
    const lat = points.reduce((s, p) => s + p[0], 0) / points.length;
    const lng = points.reduce((s, p) => s + p[1], 0) / points.length;
    return { lat, lng };
  }, [techs, jobs]);

  useEffect(() => {
    if (!markerCenter || centeredOnMarkersRef.current) return;
    centeredOnMarkersRef.current = true;
    setMapCenter(markerCenter);
  }, [markerCenter]);

  const handleJobClick = useCallback(
    (jobId) => {
      if (onSelectJob) onSelectJob(jobId);
    },
    [onSelectJob]
  );

  // Hit-test the drop point against React DOM tech cards. Walks up
  // from the topmost element under (clientX, clientY) looking for an
  // ancestor with [data-tech-card-id]. Returns the tech id, or null
  // if the drop landed outside any card.
  //
  // Uses native MouseEvent coords (e.domEvent.clientX/clientY) because
  // Google Maps' internal MapMouseEvent wraps the native event but
  // doesn't expose the .closest() helper we need on its own coords.
  const handleJobDragEnd = useCallback(
    (job, e) => {
      try {
        const x = e?.domEvent?.clientX;
        const y = e?.domEvent?.clientY;
        if (typeof x !== 'number' || typeof y !== 'number') {
          if (onJobDragEnd) onJobDragEnd(job.id, null);
          return;
        }
        const el = document.elementFromPoint(x, y);
        const card = el?.closest('[data-tech-card-id]');
        const techId = card?.getAttribute('data-tech-card-id') || null;
        if (techId && onJobDropOnTech) {
          onJobDropOnTech(job.id, techId);
        }
        if (onJobDragEnd) onJobDragEnd(job.id, techId);
      } catch {
        if (onJobDragEnd) onJobDragEnd(job.id, null);
      }
    },
    [onJobDragEnd, onJobDropOnTech]
  );

  const handleJobDragStart = useCallback(
    (job) => {
      if (onJobDragStart) onJobDragStart(job.id);
    },
    [onJobDragStart]
  );

  // Drag is offered only when DispatchBoardPage wires the callback.
  // Lets us keep the read-only consumers of this component (if any
  // ever appear) from getting accidentally draggable markers.
  const dragEnabled = typeof onJobDropOnTech === 'function';

  if (loadError) {
    return (
      <div className="flex-1 flex items-center justify-center text-14 text-alert-fg bg-surface-page">
        Failed to load Google Maps. Check VITE_GOOGLE_MAPS_API_KEY.
      </div>
    );
  }
  if (!isLoaded) {
    return (
      <div className="flex-1 flex items-center justify-center text-14 text-ink-tertiary bg-surface-page">
        Loading map…
      </div>
    );
  }

  return (
    <div className="flex-1 relative min-w-0">
      <GoogleMap
        mapContainerStyle={{ width: '100%', height: '100%' }}
        center={mapCenter}
        zoom={11}
        options={{
          disableDefaultUI: false,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
        }}
      >
        {techs.map((tech) =>
          tech.lat != null && tech.lng != null ? (
            <Marker
              key={`tech-${tech.id}`}
              position={{ lat: tech.lat, lng: tech.lng }}
              icon={{
                url: svgPin(colorForTech(tech.id), tech.id === selectedTechId, true),
              }}
              title={tech.name}
              onClick={() => onSelectTech(tech.id)}
            />
          ) : null
        )}
        {jobs.map((job) =>
          job.lat != null && job.lng != null ? (
            <Marker
              key={`job-${job.id}`}
              position={{ lat: job.lat, lng: job.lng }}
              icon={{
                url: svgPin(colorForTech(job.technician_id), false, false),
              }}
              title={`${job.customer_name} — ${job.service_type || 'service'}`}
              draggable={dragEnabled}
              onClick={() => handleJobClick(job.id)}
              onDragStart={dragEnabled ? () => handleJobDragStart(job) : undefined}
              onDragEnd={dragEnabled ? (e) => handleJobDragEnd(job, e) : undefined}
            />
          ) : null
        )}
      </GoogleMap>
    </div>
  );
}
