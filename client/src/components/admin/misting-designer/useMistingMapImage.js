// Satellite photo for the misting layout designer: the property's coordinates (or a browser geocode of
// its address) through the Treatment Zone Mapper's loader. Returns { status: 'loading' } until it settles,
// then { status: 'ready', center, zoom, url } or { status: 'error', message }.
import { useEffect, useState } from 'react';
import { loadBestMapImage } from '../../tech/treatmentZoneSpray';

const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';
// A fence or a tall yard needs more of the lot than the tech tracer's zoom 21, so start one step wider.
const DESIGNER_ZOOMS = [20, 19];

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

async function loadMap(address, lat, lng) {
  if (!MAPS_KEY) throw new Error('Google Maps key is not configured for this build.');
  const given = { lat: coord(lat), lng: coord(lng) };
  const center = Number.isFinite(given.lat) && Number.isFinite(given.lng) ? given : await geocodeInBrowser(address);
  const { url, zoom } = await loadBestMapImage(center.lat, center.lng, MAPS_KEY, DESIGNER_ZOOMS);
  return { status: 'ready', center, zoom, url };
}

export default function useMistingMapImage(address, lat, lng) {
  const [mapState, setMapState] = useState({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    loadMap(address, lat, lng)
      .then((ready) => { if (!cancelled) setMapState(ready); })
      .catch((err) => {
        if (!cancelled) setMapState({ status: 'error', message: err?.message || 'The satellite photo failed to load.' });
      });
    return () => { cancelled = true; };
  }, [address, lat, lng]);
  return mapState;
}
