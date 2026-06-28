/**
 * <GeoGridMap> — geo-grid map-pack heat map on a real Google map (Pillar 3 V2).
 *
 * Renders each scan pin at its true lat/lng, colored by the office's map-pack
 * rank there (green = top-3 … red = losing … gray = not in pack). Click a pin
 * to see the rank + the 3-pack (top competitors) at that exact point — the
 * Local-Falcon-style drill-down. All data comes from the existing
 * /admin/seo/geo-grid/heatmap response (pins carry latitude/longitude/
 * map_pack_rank/top_competitors), so this is a pure presentation component.
 *
 * Reuses the shared map setup from DispatchMap.jsx: @react-google-maps/api
 * (pinned 2.20.8), VITE_GOOGLE_MAPS_API_KEY (HTTP-referrer-restricted in GCP),
 * and the same useJsApiLoader id so the SDK loads once across the app.
 */
import { useMemo, useState } from 'react';
import { GoogleMap, useJsApiLoader, Marker, InfoWindow } from '@react-google-maps/api';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

// Rank → color, matching the grid view's geoRankColor() in SEOPage.jsx.
function rankColor(rank) {
  if (rank == null) return '#E4E4E7'; // not in pack
  if (rank <= 3) return '#15803D'; // green
  if (rank <= 10) return '#A16207'; // amber
  if (rank <= 20) return '#991B1B'; // red
  return '#52525B'; // 20+
}
function rankLabel(rank) {
  if (rank == null) return '—';
  if (rank > 20) return '20+';
  return String(rank);
}

// Circle pin with the rank number, as an SVG data URI (same approach as
// DispatchMap's svgPin). Text color flips to dark on the light "not in pack" fill.
function pinIcon(rank) {
  const bg = rankColor(rank);
  const fg = rank == null ? '#52525B' : '#FFFFFF';
  const label = rankLabel(rank);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">` +
    `<circle cx="15" cy="15" r="12" fill="${bg}" stroke="#FFFFFF" stroke-width="2"/>` +
    `<text x="15" y="19" text-anchor="middle" font-family="monospace" font-size="11" font-weight="700" fill="${fg}">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function parseCompetitors(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default function GeoGridMap({ pins = [], center }) {
  const { isLoaded, loadError } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: MAPS_KEY,
  });
  const [selected, setSelected] = useState(null);

  // Center on the office, or the average pin if no center supplied.
  const mapCenter = useMemo(() => {
    if (center && center.lat != null && center.lng != null) return { lat: center.lat, lng: center.lng };
    const pts = pins.filter((p) => p.latitude != null && p.longitude != null);
    if (!pts.length) return { lat: 27.4989, lng: -82.5748 }; // Manatee/Sarasota core
    return {
      lat: pts.reduce((s, p) => s + Number(p.latitude), 0) / pts.length,
      lng: pts.reduce((s, p) => s + Number(p.longitude), 0) / pts.length,
    };
  }, [center, pins]);

  if (!MAPS_KEY || loadError) {
    return (
      <div style={{ padding: 30, textAlign: 'center', color: '#71717A', fontSize: 13 }}>
        {loadError ? 'Failed to load Google Maps. Check VITE_GOOGLE_MAPS_API_KEY.' : 'Map unavailable (VITE_GOOGLE_MAPS_API_KEY not set).'}
      </div>
    );
  }
  if (!isLoaded) {
    return <div style={{ padding: 30, textAlign: 'center', color: '#71717A', fontSize: 13 }}>Loading map…</div>;
  }

  return (
    <div style={{ height: 420, borderRadius: 10, overflow: 'hidden', border: '1px solid #E4E4E7' }}>
      <GoogleMap
        mapContainerStyle={{ width: '100%', height: '100%' }}
        center={mapCenter}
        zoom={11}
        options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: false }}
      >
        {pins.map((p) =>
          p.latitude != null && p.longitude != null ? (
            <Marker
              key={`${p.pin_row}-${p.pin_col}`}
              position={{ lat: Number(p.latitude), lng: Number(p.longitude) }}
              icon={{ url: pinIcon(p.map_pack_rank) }}
              onClick={() => setSelected(p)}
            />
          ) : null,
        )}
        {selected && (
          <InfoWindow
            position={{ lat: Number(selected.latitude), lng: Number(selected.longitude) }}
            onCloseClick={() => setSelected(null)}
          >
            <div style={{ minWidth: 180, fontSize: 12, color: '#27272A' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Map-pack rank: {selected.map_pack_rank == null ? 'not in pack' : `#${selected.map_pack_rank}`}
              </div>
              {parseCompetitors(selected.top_competitors).length > 0 && (
                <>
                  <div style={{ color: '#71717A', marginBottom: 2 }}>Top 3 here:</div>
                  <ol style={{ margin: 0, paddingLeft: 16 }}>
                    {parseCompetitors(selected.top_competitors).slice(0, 3).map((c, i) => (
                      <li key={i}>
                        {c.title || 'Unknown'} {c.rank ? `(#${c.rank})` : ''}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          </InfoWindow>
        )}
      </GoogleMap>
    </div>
  );
}
