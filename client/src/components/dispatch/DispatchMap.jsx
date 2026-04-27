/**
 * <DispatchMap> — center pane. Google Maps via @react-google-maps/api
 * (pinned 2.20.8 in client/package.json — DON'T let the version float;
 * minor version bumps on map libs have a history of quietly breaking
 * marker rendering).
 *
 * Markers:
 *   - <Marker> per tech with valid lat/lng → "truck" pin colored by
 *     tech.id (deterministic hash → palette). Click → setSelectedTechId.
 *   - <Marker> per job with valid lat/lng → "job" pin colored by the
 *     assigned technician_id (matches the tech truck color so unassigned
 *     jobs render in a neutral gray). Click → console.log(job.id) for
 *     the v1; the per-job drawer is a separate PR.
 *
 * Selected tech receives a thicker stroke + halo to match the highlight
 * on the corresponding <TechCard>.
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
import React, { useMemo, useCallback } from 'react';
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
  // Inline SVG so we don't ship marker images. Truck pins are diamond,
  // job pins are circles — gives an at-a-glance read of "tech is here"
  // vs "job is there" without legend.
  const stroke = isSelected ? '#18181B' : '#FFFFFF';
  const strokeWidth = isSelected ? 3 : 1.5;
  const size = isSelected ? 28 : 22;
  const shape = isTruck
    ? `<polygon points="14,2 26,14 14,26 2,14" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`
    : `<circle cx="14" cy="14" r="9" fill="${color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 28 28">${shape}</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export default function DispatchMap({ techs, jobs, selectedTechId, onSelectTech, onSelectJob }) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: MAPS_KEY,
  });

  // Initial center: average of available marker coords, falls back to
  // Manatee core. Computed once-ish — a new center on every techs/jobs
  // update would yank the user's pan state, so we only re-center when
  // the marker set goes from empty to non-empty.
  const initialCenter = useMemo(() => {
    const points = [];
    for (const t of techs) if (t.lat != null && t.lng != null) points.push([t.lat, t.lng]);
    for (const j of jobs) if (j.lat != null && j.lng != null) points.push([j.lat, j.lng]);
    if (points.length === 0) return DEFAULT_CENTER;
    const lat = points.reduce((s, p) => s + p[0], 0) / points.length;
    const lng = points.reduce((s, p) => s + p[1], 0) / points.length;
    return { lat, lng };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [techs.length === 0 && jobs.length === 0]);

  const handleJobClick = useCallback(
    (jobId) => {
      if (onSelectJob) onSelectJob(jobId);
    },
    [onSelectJob]
  );

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
        center={initialCenter}
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
              onClick={() => handleJobClick(job.id)}
            />
          ) : null
        )}
      </GoogleMap>
    </div>
  );
}
