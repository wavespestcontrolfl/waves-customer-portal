const { createGoogleMapsProvider } = require('./providers/google-maps-provider');
const { createMockBasemapProvider } = require('./providers/mock-basemap-provider');

function boolEnv(...names) {
  return names.some((name) => ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').toLowerCase()));
}

function isSatelliteTreatmentMapEnabled() {
  return boolEnv(
    'SERVICE_REPORT_SATELLITE_TREATMENT_MAP_ENABLED',
    'SERVICE_REPORT_SATELLITE_TREATMENT_MAP_V1',
    'service_report_satellite_treatment_map_v1',
  );
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
