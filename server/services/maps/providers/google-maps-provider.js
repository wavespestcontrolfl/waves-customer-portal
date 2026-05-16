const GOOGLE_CAPABILITIES = {
  canDisplayLive: true,
  canStoreStaticImage: false,
  canUseInPdf: false,
  canUseInSmsPreview: false,
  canDerivePersistentGeometry: false,
  maxCacheDays: 0,
  requiresAttribution: true,
};

function mapsApiKey() {
  return process.env.GOOGLE_STATIC_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
}

function createGoogleMapsProvider() {
  return {
    key: 'google_maps',
    capabilities: GOOGLE_CAPABILITIES,

    async getLiveMapConfig({
      center,
      zoom = 20,
      mapType = 'satellite',
      width = 640,
      height = 340,
    }) {
      const key = mapsApiKey();
      if (!key || !center?.lat || !center?.lng) return null;

      const params = new URLSearchParams({
        center: `${Number(center.lat).toFixed(7)},${Number(center.lng).toFixed(7)}`,
        zoom: String(zoom),
        size: `${Math.min(Number(width) || 640, 640)}x${Math.min(Number(height) || 340, 640)}`,
        scale: '2',
        maptype: mapType === 'hybrid' ? 'hybrid' : 'satellite',
        key,
      });

      return {
        provider: 'google_maps',
        imageUrl: `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`,
        center: {
          lat: Number(center.lat),
          lng: Number(center.lng),
        },
        zoom,
        mapType: mapType === 'hybrid' ? 'hybrid' : 'satellite',
        width: Math.min(Number(width) || 640, 640),
        height: Math.min(Number(height) || 340, 640),
        attributionText: 'Map data © Google',
      };
    },
  };
}

module.exports = {
  GOOGLE_CAPABILITIES,
  createGoogleMapsProvider,
};
