const { getBasemapProvider, isSatelliteTreatmentMapEnabled } = require('../maps/basemap-provider');

const VIEWBOX_W = 640;
const VIEWBOX_H = 340;

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function centerForService(service = {}) {
  const lat = numberOrNull(service.customer_latitude ?? service.latitude ?? service.lat);
  const lng = numberOrNull(service.customer_longitude ?? service.longitude ?? service.lng);
  if (lat == null || lng == null) return null;
  return { lat, lng };
}

function approximateBounds(center) {
  const latSpan = 0.00115;
  const lngSpan = 0.00155;
  return {
    north: center.lat + latSpan / 2,
    south: center.lat - latSpan / 2,
    east: center.lng + lngSpan / 2,
    west: center.lng - lngSpan / 2,
  };
}

function normalizeRectGeometry(geometry, width = VIEWBOX_W, height = VIEWBOX_H) {
  const g = parseJsonObject(geometry);
  if (Array.isArray(g.points)) {
    return {
      type: 'polygon',
      points: g.points.map(([x, y]) => [Number(x) * width, Number(y) * height]),
    };
  }
  if (g.type === 'circle' || (g.cx != null && g.cy != null)) {
    const normalized = Math.abs(Number(g.cx || 0)) <= 1 && Math.abs(Number(g.cy || 0)) <= 1;
    return {
      type: 'circle',
      cx: normalized ? Number(g.cx || 0) * width : Number(g.cx || 0),
      cy: normalized ? Number(g.cy || 0) * height : Number(g.cy || 0),
      r: normalized ? Number(g.r || 0.025) * Math.min(width, height) : Number(g.r || 8),
    };
  }
  const normalized = Math.abs(Number(g.x || 0)) <= 1
    && Math.abs(Number(g.y || 0)) <= 1
    && Math.abs(Number(g.w || 0)) <= 1
    && Math.abs(Number(g.h || 0)) <= 1;
  return {
    type: 'rect',
    x: normalized ? Number(g.x || 0) * width : Number(g.x || 0),
    y: normalized ? Number(g.y || 0) * height : Number(g.y || 0),
    w: normalized ? Number(g.w || 0) * width : Number(g.w || 0),
    h: normalized ? Number(g.h || 0) * height : Number(g.h || 0),
  };
}

function overlayZone(zone) {
  const imageGeometry = parseJsonObject(zone.geometry_image);
  const hasImageGeometry = Object.keys(imageGeometry).length > 0;
  return {
    id: String(zone.id),
    letter: zone.letter,
    label: zone.label,
    category: zone.category,
    geometry: normalizeRectGeometry(hasImageGeometry ? imageGeometry : zone.geometry),
    overlaySource: hasImageGeometry ? 'image_normalized' : 'local_schematic',
  };
}

function applicationZoneIds(app = {}) {
  const ids = Array.isArray(app.zone_ids)
    ? app.zone_ids
    : (Array.isArray(app.zoneIds) ? app.zoneIds : []);
  return ids.map(String);
}

function isRenderableApplication(app = {}) {
  return (app.method || 'perimeter_spray') !== 'station_check';
}

async function buildSatelliteTreatmentMapContext({
  service,
  zones = [],
  applications = [],
  flags = [],
  geometryRow = null,
  mode = 'live',
} = {}) {
  if (mode === 'sms_preview') {
    return { available: false, fallbackReason: 'sms_preview_privacy' };
  }
  if (!isSatelliteTreatmentMapEnabled()) {
    return { available: false, fallbackReason: 'disabled' };
  }
  if (mode !== 'live') {
    return { available: false, fallbackReason: 'static_export_not_enabled' };
  }

  const provider = getBasemapProvider();
  if (!provider?.capabilities?.canDisplayLive) {
    return { available: false, fallbackReason: 'provider_unavailable' };
  }

  const center = centerForService(service);
  if (!center) return { available: false, fallbackReason: 'missing_coordinates' };

  const bounds = parseJsonObject(geometryRow?.bounds);
  const liveConfig = await provider.getLiveMapConfig({
    center,
    bounds: Object.keys(bounds).length ? bounds : approximateBounds(center),
    zoom: Number(geometryRow?.zoom) || 20,
    width: VIEWBOX_W,
    height: VIEWBOX_H,
    mapType: 'satellite',
  });
  if (!liveConfig?.imageUrl) return { available: false, fallbackReason: 'provider_config_unavailable' };

  // Once ANY zone carries a technician-marked image shape, only marked zones
  // overlay the photo: schematic rects live in house-diagram space and would
  // paint meaningless boxes over the satellite image next to the real marks
  // (mirrors the client coverage map's all-or-nothing image gate). With no
  // marks at all, the legacy approximate-projection behavior is unchanged.
  const anyImageGeometry = zones.some((zone) => Object.keys(parseJsonObject(zone.geometry_image)).length > 0);
  const overlayCandidates = anyImageGeometry
    ? zones.filter((zone) => Object.keys(parseJsonObject(zone.geometry_image)).length > 0)
    : zones;
  const overlayZones = overlayCandidates.map(overlayZone);
  const overlayZoneById = new Map(overlayZones.map((zone) => [String(zone.id), zone]));
  const renderableApplications = applications.map((app) => {
    const zoneIds = applicationZoneIds(app).filter((zoneId) => overlayZoneById.has(String(zoneId)));
    return { app, zoneIds };
  }).filter(({ app, zoneIds }) => isRenderableApplication(app) && zoneIds.length);

  return {
    available: true,
    provider: provider.key,
    mapType: liveConfig.mapType || 'satellite',
    capabilities: provider.capabilities,
    live: {
      type: 'image',
      url: liveConfig.imageUrl,
      width: liveConfig.width || VIEWBOX_W,
      height: liveConfig.height || VIEWBOX_H,
      center: liveConfig.center,
      bounds: liveConfig.bounds || bounds || approximateBounds(center),
      zoom: liveConfig.zoom,
    },
    attributionText: liveConfig.attributionText || '',
    overlay: {
      width: VIEWBOX_W,
      height: VIEWBOX_H,
      zones: overlayZones,
      applications: renderableApplications.map(({ app, zoneIds }) => {
        return {
          id: app.id,
          method: app.method,
          methodLabel: app.methodLabel,
          productName: app.product?.name || '',
          epaReg: app.product?.epa_reg || '',
          activeIngredient: app.product?.active_ingredient || '',
          targets: Array.isArray(app.targets) ? app.targets.map(String) : [],
          zoneIds,
          zoneLabels: zoneIds.map((zoneId) => overlayZoneById.get(String(zoneId))?.label).filter(Boolean),
        };
      }),
      flags: flags.map((flag) => ({
        zoneId: String(flag.zone_id),
        label: flag.label,
      })),
    },
  };
}

module.exports = {
  buildSatelliteTreatmentMapContext,
  normalizeRectGeometry,
};
