const db = require('../models/db');
const logger = require('./logger');
const trackTransitions = require('./track-transitions');
const { ensureCustomerGeocoded } = require('./geocoder');
const { recordAuditEvent } = require('./audit-log');
const { stampedAddressDiverges } = require('./stamped-address');

const SETTINGS_KEYS = [
  'gps_arrival.enabled',
  'gps_arrival.radius_meters',
  'gps_arrival.immediate_radius_meters',
  'gps_arrival.max_speed_mph',
  'gps_arrival.immediate_max_speed_mph',
];

const DEFAULT_CONFIG = {
  enabled: true,
  radiusMeters: 175,
  immediateRadiusMeters: 55,
  maxSpeedMph: 12,
  immediateMaxSpeedMph: 20,
};

const CONFIG_CACHE_MS = 60 * 1000;
const GEOCODE_TIMEOUT_MS = 1200;
const MAX_SAMPLE_AGE_MS = 10 * 60 * 1000;
const SAMPLE_TIMESTAMP_TOLERANCE_MS = 2 * 60 * 1000;
const EN_ROUTE_TIMESTAMP_TOLERANCE_MS = 2 * 60 * 1000;

let configCache = null;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validLatitude(value) {
  const number = finiteNumber(value);
  return number != null && number >= -90 && number <= 90 ? number : null;
}

function validLongitude(value) {
  const number = finiteNumber(value);
  return number != null && number >= -180 && number <= 180 ? number : null;
}

function parseBoolean(value, fallback) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : fallback;
}

function applySetting(config, key, value) {
  switch (key) {
    case 'gps_arrival.enabled':
      config.enabled = parseBoolean(value, config.enabled);
      break;
    case 'gps_arrival.radius_meters':
      config.radiusMeters = positiveNumber(value, config.radiusMeters);
      break;
    case 'gps_arrival.immediate_radius_meters':
      config.immediateRadiusMeters = positiveNumber(value, config.immediateRadiusMeters);
      break;
    case 'gps_arrival.max_speed_mph':
      config.maxSpeedMph = positiveNumber(value, config.maxSpeedMph);
      break;
    case 'gps_arrival.immediate_max_speed_mph':
      config.immediateMaxSpeedMph = positiveNumber(value, config.immediateMaxSpeedMph);
      break;
    default:
      break;
  }
}

function applyEnv(config) {
  config.enabled = parseBoolean(process.env.GPS_ARRIVAL_ENABLED, config.enabled);
  config.radiusMeters = positiveNumber(process.env.GPS_ARRIVAL_RADIUS_METERS, config.radiusMeters);
  config.immediateRadiusMeters = positiveNumber(
    process.env.GPS_ARRIVAL_IMMEDIATE_RADIUS_METERS,
    config.immediateRadiusMeters
  );
  config.maxSpeedMph = positiveNumber(process.env.GPS_ARRIVAL_MAX_SPEED_MPH, config.maxSpeedMph);
  config.immediateMaxSpeedMph = positiveNumber(
    process.env.GPS_ARRIVAL_IMMEDIATE_MAX_SPEED_MPH,
    config.immediateMaxSpeedMph
  );
  return config;
}

async function loadConfig(configOverride = null) {
  if (configOverride) {
    return applyEnv({ ...DEFAULT_CONFIG, ...configOverride });
  }

  const now = Date.now();
  if (configCache && now - configCache.loadedAt < CONFIG_CACHE_MS) {
    return configCache.config;
  }

  const config = { ...DEFAULT_CONFIG };
  try {
    const rows = await db('system_settings')
      .whereIn('key', SETTINGS_KEYS)
      .select('key', 'value');
    for (const row of rows || []) {
      applySetting(config, row.key, row.value);
    }
  } catch (err) {
    logger.warn(`[gps-arrival] settings lookup failed; using defaults: ${err.message}`);
  }

  configCache = { loadedAt: now, config: applyEnv(config) };
  return configCache.config;
}

function distanceMeters(fromLat, fromLng, toLat, toLng) {
  const lat1 = validLatitude(fromLat);
  const lng1 = validLongitude(fromLng);
  const lat2 = validLatitude(toLat);
  const lng2 = validLongitude(toLng);
  if ([lat1, lng1, lat2, lng2].some((value) => value == null)) return null;

  const earthRadiusMeters = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180)
    * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLng / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildArrivalDecision({ distance, speedMph, ignition, config }) {
  if (distance == null) return { arrived: false, reason: 'invalid_distance' };

  const speed = finiteNumber(speedMph);
  const stoppedSignal = ignition === false;
  const slowEnough = stoppedSignal || (speed != null && speed <= config.maxSpeedMph);
  const closeEnoughSpeed = stoppedSignal || (speed != null && speed <= config.immediateMaxSpeedMph);

  if (distance <= config.immediateRadiusMeters && closeEnoughSpeed) {
    return { arrived: true, reason: 'inside_immediate_radius' };
  }

  if (distance <= config.radiusMeters && slowEnough) {
    return { arrived: true, reason: 'inside_arrival_radius_slow' };
  }

  if (distance <= config.radiusMeters) {
    return { arrived: false, reason: 'inside_radius_moving_too_fast' };
  }

  return { arrived: false, reason: 'outside_arrival_radius' };
}

function isAcceptedCurrentSample({ techLat, techLng, point }) {
  const pointLat = validLatitude(point?.lat);
  const pointLng = validLongitude(point?.lng);
  if (pointLat == null || pointLng == null) return false;
  const sampleDistance = distanceMeters(techLat, techLng, pointLat, pointLng);
  return sampleDistance != null && sampleDistance <= 15;
}

function timestampMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function validateSampleTiming({ techStatus, point, service, now = Date.now() }) {
  const pointMs = timestampMs(point?.reported_at);
  const techMs = timestampMs(techStatus?.location_updated_at);
  const enRouteMs = timestampMs(service?.en_route_at);

  if (pointMs == null || techMs == null) {
    return { ok: false, reason: 'missing_location_timestamp' };
  }
  if (enRouteMs == null) {
    return { ok: false, reason: 'missing_en_route_timestamp' };
  }
  if (now - pointMs > MAX_SAMPLE_AGE_MS) {
    return { ok: false, reason: 'stale_location_sample' };
  }
  if (Math.abs(pointMs - techMs) > SAMPLE_TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: 'stale_location_sample' };
  }
  if (pointMs < enRouteMs - EN_ROUTE_TIMESTAMP_TOLERANCE_MS) {
    return { ok: false, reason: 'sample_before_en_route' };
  }

  return { ok: true };
}

async function withTimeout(promise, timeoutMs, fallbackValue = null) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function extractDestination(service) {
  const serviceLat = validLatitude(service?.service_lat);
  const serviceLng = validLongitude(service?.service_lng);
  if (serviceLat != null && serviceLng != null) {
    return { lat: serviceLat, lng: serviceLng, source: 'scheduled_service' };
  }

  // A visit whose stamped service address DIVERGES from the primary
  // (secondary/rental booking) must never arrival-detect against the
  // customer's PRIMARY coords — a tech near the primary home would
  // auto-flip the rental job to on-site (codex round-3 P1). Every phone
  // booking stamps, so a non-divergent stamp (ordinary primary-address
  // booking) keeps the fallback (codex round-4 P1). No destination =
  // no auto-flip; the tech flips manually.
  if (stampedAddressDiverges(service)) return null;

  const customerLat = validLatitude(service?.customer_latitude);
  const customerLng = validLongitude(service?.customer_longitude);
  if (customerLat != null && customerLng != null) {
    return { lat: customerLat, lng: customerLng, source: 'customer' };
  }

  return null;
}

async function resolveDestination(service) {
  const existing = extractDestination(service);
  if (existing || !service?.customer_id) return existing;
  // The geocode fallback resolves the customer's PRIMARY address. A visit
  // whose stamp diverges from the primary must not arrival-detect against
  // the primary home — leave the destination unresolved (manual flip).
  if (stampedAddressDiverges(service)) return null;

  try {
    const geocoded = await withTimeout(
      ensureCustomerGeocoded(service.customer_id),
      GEOCODE_TIMEOUT_MS,
      null
    );
    const lat = validLatitude(geocoded?.lat);
    const lng = validLongitude(geocoded?.lng);
    return lat != null && lng != null
      ? { lat, lng, source: 'customer_geocode' }
      : null;
  } catch (err) {
    logger.warn(`[gps-arrival] customer geocode failed for ${service.customer_id}: ${err.message}`);
    return null;
  }
}

async function loadCurrentService(currentJobId) {
  if (!currentJobId) return null;
  return db('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.id', currentJobId)
    .first(
      's.id',
      's.customer_id',
      's.technician_id',
      's.track_state',
      's.status',
      's.cancelled_at',
      's.completed_at',
      's.arrived_at',
      's.en_route_at',
      's.lat as service_lat',
      's.lng as service_lng',
      's.service_address_line1 as service_address_line1',
      's.service_address_zip as service_address_zip',
      'c.address_line1 as customer_address_line1',
      'c.zip as customer_zip',
      'c.latitude as customer_latitude',
      'c.longitude as customer_longitude'
    );
}

function isEnRouteService(service) {
  if (!service) return false;
  if (service.cancelled_at || service.completed_at) return false;
  if (['on_property', 'complete', 'cancelled'].includes(service.track_state)) return false;
  if (['on_site', 'completed', 'cancelled', 'skipped', 'no_show'].includes(service.status)) return false;
  return service.track_state === 'en_route' || service.status === 'en_route';
}

async function auditArrival({ service, techStatus, destination, distance, point, decision, result, error }) {
  await recordAuditEvent({
    actor_type: 'system:gps-arrival',
    action: result?.ok ? 'gps_arrival.mark_on_property' : 'gps_arrival.mark_on_property_failed',
    resource_type: 'scheduled_service',
    resource_id: service.id,
    metadata: {
      tech_id: techStatus.tech_id || null,
      destination_source: destination.source,
      distance_meters: distance == null ? null : Math.round(distance),
      speed_mph: finiteNumber(point?.speed_mph),
      ignition: point?.ignition ?? null,
      decision_reason: decision.reason,
      mark_on_property_result: result || null,
      error: error ? error.message : null,
    },
  });
}

async function maybeMarkArrivedFromGps({ techStatus, point, configOverride = null } = {}) {
  const config = await loadConfig(configOverride);
  if (!config.enabled) return { ok: false, reason: 'disabled' };

  const currentJobId = techStatus?.current_job_id;
  if (!currentJobId) return { ok: false, reason: 'no_current_job' };

  const techLat = validLatitude(techStatus.lat);
  const techLng = validLongitude(techStatus.lng);
  if (techLat == null || techLng == null) {
    return { ok: false, reason: 'missing_tech_location' };
  }
  if (!isAcceptedCurrentSample({ techLat, techLng, point })) {
    return { ok: false, reason: 'stale_location_sample' };
  }

  let service;
  try {
    service = await loadCurrentService(currentJobId);
  } catch (err) {
    logger.warn(`[gps-arrival] current service lookup failed for ${currentJobId}: ${err.message}`);
    return { ok: false, reason: 'service_lookup_failed' };
  }

  if (!service) return { ok: false, reason: 'service_not_found' };
  if (service.technician_id && techStatus.tech_id && service.technician_id !== techStatus.tech_id) {
    return { ok: false, reason: 'technician_mismatch' };
  }
  if (!isEnRouteService(service)) {
    return { ok: false, reason: 'service_not_en_route' };
  }
  const sampleTiming = validateSampleTiming({ techStatus, point, service });
  if (!sampleTiming.ok) {
    return { ok: false, reason: sampleTiming.reason };
  }

  const destination = await resolveDestination(service);
  if (!destination) {
    return { ok: false, reason: 'missing_destination' };
  }

  const distance = distanceMeters(techLat, techLng, destination.lat, destination.lng);
  const decision = buildArrivalDecision({
    distance,
    speedMph: point?.speed_mph,
    ignition: point?.ignition,
    config,
  });

  if (!decision.arrived) {
    return {
      ok: false,
      reason: decision.reason,
      distanceMeters: distance,
    };
  }

  let result = null;
  try {
    // techStatus.tech_id is the tech reporting this GPS sample; the guard above
    // already rejects a tech/assignment mismatch, so it's the one arriving.
    result = await trackTransitions.markOnProperty(service.id, { actingTechId: techStatus.tech_id });
    await auditArrival({ service, techStatus, destination, distance, point, decision, result });
    return {
      ok: result?.ok === true,
      reason: result?.ok ? 'marked_on_property' : 'mark_on_property_failed',
      state: result?.state || null,
      distanceMeters: distance,
      result,
    };
  } catch (err) {
    logger.error(`[gps-arrival] markOnProperty failed for ${service.id}: ${err.message}`);
    await auditArrival({ service, techStatus, destination, distance, point, decision, result, error: err });
    return { ok: false, reason: 'mark_on_property_threw', distanceMeters: distance };
  }
}

function resetConfigCache() {
  configCache = null;
}

module.exports = {
  maybeMarkArrivedFromGps,
  _test: {
    DEFAULT_CONFIG,
    buildArrivalDecision,
    distanceMeters,
    finiteNumber,
    isAcceptedCurrentSample,
    validateSampleTiming,
    loadConfig,
    resetConfigCache,
  },
};
