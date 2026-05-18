const { createGoogleMapsProvider } = require('./providers/google-maps-provider');
const { createMockBasemapProvider } = require('./providers/mock-basemap-provider');

function firstEnv(...names) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw != null && String(raw).length) return String(raw).toLowerCase();
  }
  return '';
}

function isSatelliteTreatmentMapEnabled() {
  const value = firstEnv(
    'SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED',
    'SERVICE_REPORT_SATELLITE_TREATMENT_MAP_V1',
    'service_report_satellite_treatment_map_v1',
  );
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return true;
}

function getBasemapProvider(name = process.env.SERVICE_REPORT_BASEMAP_PROVIDER) {
  const requested = String(name || '').trim().toLowerCase();
  if (requested === 'mock') return createMockBasemapProvider();
  if (requested === 'google' || requested === 'google_maps') return createGoogleMapsProvider();
  if (!requested && (process.env.GOOGLE_STATIC_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY)) {
    return createGoogleMapsProvider();
  }
  return null;
}

module.exports = {
  getBasemapProvider,
  isSatelliteTreatmentMapEnabled,
};
