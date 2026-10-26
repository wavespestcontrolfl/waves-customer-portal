// Satellite photo for the misting layout designer: the property's coordinates (or a browser geocode of
// its address) through the Treatment Zone Mapper's loader, opening as close as it does (zoom 21, then 20, then 19).
// Returns { status: 'loading' } until it settles, then { status: 'ready', center, zoom, maxZoom, url, image,
// loadZoom, applyZoom } or { status: 'error', message }. `maxZoom` is the closest photo the imagery probe accepted:
// staff can step out to MIN_TRACE_ZOOM and back in to it. `loadZoom(zoom)` fetches the photo at another zoom without
// changing anything, and `applyZoom(zoom, photo)` then swaps it in (the caller scales the layout in the same tick).
// A saved layout passes `preset` ({ center, zoom }): the photo is then loaded at exactly that center and
// zoom, so the saved pixel positions land on the same ground; it reopens at that zoom, which is also its closest.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZOOM_ATTEMPTS, loadBestMapImage } from '../../tech/treatmentZoneSpray';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

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

const coord = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

async function loadMap(address, lat, lng, preset) {
  if (!MAPS_KEY) throw new Error('Google Maps key is not configured for this build.');
  if (preset) {
    const { url, zoom, image } = await loadBestMapImage(preset.center.lat, preset.center.lng, MAPS_KEY, [preset.zoom]);
    return { status: 'ready', center: preset.center, zoom, maxZoom: zoom, url, image };
  }
  const given = { lat: coord(lat), lng: coord(lng) };
  const center = Number.isFinite(given.lat) && Number.isFinite(given.lng) ? given : await geocodeInBrowser(address);
  const { url, zoom, image } = await loadBestMapImage(center.lat, center.lng, MAPS_KEY, ZOOM_ATTEMPTS);
  return { status: 'ready', center, zoom, maxZoom: zoom, url, image };
}

export default function useMistingMapImage(address, lat, lng, preset = null) {
  const [mapState, setMapState] = useState({ status: 'loading' });
  const latest = useRef(mapState);
  latest.current = mapState;
  const presetKey = preset ? `${preset.center.lat},${preset.center.lng},${preset.zoom}` : '';
  useEffect(() => {
    let cancelled = false;
    loadMap(address, lat, lng, preset)
      .then((ready) => { if (!cancelled) setMapState(ready); })
      .catch((err) => {
        if (!cancelled) setMapState({ status: 'error', message: err?.message || 'The satellite photo failed to load.' });
      });
    return () => { cancelled = true; };
    // The preset is an object; presetKey stands for it so a new object with the same values does not reload the photo.
  }, [address, lat, lng, presetKey]);

  const loadZoom = useCallback(async (zoom) => {
    const { center } = latest.current;
    const { url, image } = await loadBestMapImage(center.lat, center.lng, MAPS_KEY, [zoom]);
    return { url, image };
  }, []);
  const applyZoom = useCallback((zoom, { url, image }) => {
    setMapState((prev) => (prev.status === 'ready' ? { ...prev, zoom, url, image } : prev));
  }, []);
  return useMemo(() => ({ ...mapState, loadZoom, applyZoom }), [mapState, loadZoom, applyZoom]);
}
