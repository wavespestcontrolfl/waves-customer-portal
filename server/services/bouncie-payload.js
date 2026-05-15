const crypto = require('crypto');

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function normalizeEventType(raw) {
  const value = String(raw || 'unknown').trim();
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {
    tripstart: 'trip-start',
    tripdata: 'trip-data',
    tripend: 'trip-end',
    tripmetrics: 'trip-metrics',
    tripcompleted: 'trip-metrics',
    trip: 'trip-metrics',
    connect: 'connect',
    deviceconnect: 'connect',
    disconnect: 'disconnect',
    devicedisconnect: 'disconnect',
    usergeozone: 'userGeozone',
    geozone: 'userGeozone',
    applicationgeozone: 'applicationGeozone',
  };
  return map[compact] || value;
}

function eventTypeFromPayload(payload = {}) {
  return normalizeEventType(
    payload.eventType ||
    payload.event_type ||
    payload.event ||
    payload.type ||
    'unknown'
  );
}

function extractImei(payload = {}) {
  const data = payload.data && !Array.isArray(payload.data) ? payload.data : null;
  return String(firstPresent(
    payload.imei,
    payload.vehicleId,
    payload.vehicle_id,
    payload.deviceId,
    payload.device_id,
    payload.vehicle?.imei,
    data?.imei,
    data?.vehicleId,
    data?.vehicle_id,
    data?.deviceId,
    data?.device_id
  ) || '');
}

function pointFromSource(source) {
  if (!source) return null;
  const gps = source.gps || source.location || source.position || null;
  const lat = num(firstPresent(source.lat, source.latitude, gps?.lat, gps?.latitude));
  const lng = num(firstPresent(source.lon, source.lng, source.longitude, gps?.lon, gps?.lng, gps?.longitude));
  if (lat == null || lng == null) return null;
  return {
    lat,
    lng,
    heading: num(firstPresent(source.heading, source.bearing, gps?.heading, gps?.bearing)),
    speed_mph: num(firstPresent(source.speed, source.speed_mph, source.speedMph, gps?.speed)),
    ignition: typeof source.ignition === 'boolean' ? source.ignition : null,
    reported_at: firstPresent(source.timestamp, source.ts, gps?.timestamp, gps?.ts),
  };
}

function pickLatestSample(payload = {}) {
  const arr = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.samples)
      ? payload.samples
      : null;
  if (!arr || arr.length === 0) return null;
  let best = arr[0];
  let bestMs = Date.parse(firstPresent(best.timestamp, best.ts, best.gps?.timestamp, 0)) || 0;
  for (let i = 1; i < arr.length; i++) {
    const sample = arr[i];
    const ms = Date.parse(firstPresent(sample.timestamp, sample.ts, sample.gps?.timestamp, 0)) || 0;
    if (ms > bestMs) {
      best = sample;
      bestMs = ms;
    }
  }
  return best;
}

function pointFromPayload(payload = {}, canonicalEventType = eventTypeFromPayload(payload)) {
  if (canonicalEventType === 'trip-data') {
    return pointFromSource(pickLatestSample(payload));
  }
  return (
    pointFromSource(payload) ||
    pointFromSource(payload.location) ||
    pointFromSource(payload.position) ||
    pointFromSource(payload.connect) ||
    pointFromSource(payload.disconnect) ||
    pointFromSource(payload.start) ||
    pointFromSource(payload.end)
  );
}

function milesFromSource(source = {}) {
  const miles = num(firstPresent(
    source.tripDistance,
    source.distanceMiles,
    source.distance_miles,
    source.miles
  ));
  if (miles != null) return miles;

  const meters = num(firstPresent(source.distanceMeters, source.distance_meters));
  if (meters != null) return meters / 1609.344;

  // Legacy webhook payloads used `distance` as meters.
  const legacyMeters = num(source.distance);
  return legacyMeters != null ? legacyMeters / 1609.344 : null;
}

function secondsFromSource(source = {}) {
  const seconds = num(firstPresent(
    source.tripTime,
    source.durationSeconds,
    source.duration_seconds,
    source.duration
  ));
  if (seconds != null) return seconds;

  const minutes = num(firstPresent(
    source.durationMinutes,
    source.duration_minutes,
    source.minutes
  ));
  return minutes != null ? minutes * 60 : null;
}

function normalizeTripMetricsPayload(payload = {}, imei = extractImei(payload)) {
  const source = payload.metrics || (payload.data && !Array.isArray(payload.data) ? payload.data : payload);
  const distanceMiles = milesFromSource(source);
  const durationSeconds = secondsFromSource(source);
  if (distanceMiles == null && durationSeconds == null) return null;

  const transactionId = firstPresent(
    payload.transactionId,
    payload.transaction_id,
    payload.tripId,
    payload.trip_id,
    payload.id,
    source.transactionId,
    source.transaction_id,
    source.tripId,
    source.trip_id,
    source.id
  );
  if (!transactionId) return null;

  const distanceMeters = distanceMiles != null ? distanceMiles * 1609.344 : 0;
  return {
    eventType: 'tripCompleted',
    imei,
    data: {
      ...source,
      imei,
      vehicleId: firstPresent(source.vehicleId, source.vehicle_id, payload.vehicleId, payload.vehicle_id, imei),
      transactionId,
      startTime: firstPresent(source.startTime, source.start_time, payload.startTime, payload.start_time, source.startedAt, source.started_at),
      endTime: firstPresent(source.endTime, source.end_time, payload.endTime, payload.end_time, source.endedAt, source.ended_at, source.timestamp, payload.end?.timestamp),
      distance: distanceMeters,
      distanceMiles: distanceMiles ?? 0,
      duration: durationSeconds ?? 0,
      durationSeconds: durationSeconds ?? 0,
      startLocation: firstPresent(source.startLocation, source.start_location, payload.startLocation, payload.start_location),
      endLocation: firstPresent(source.endLocation, source.end_location, payload.endLocation, payload.end_location),
      maxSpeed: firstPresent(source.maxSpeed, source.max_speed_mph),
      averageSpeed: firstPresent(source.averageDriveSpeed, source.averageSpeed, source.avgSpeed),
      hardBrakes: firstPresent(source.hardBrakingCounts, source.hardBrakingCount, source.hardBrakes),
      hardAccelerations: firstPresent(source.hardAccelerationCounts, source.hardAccelerationCount, source.hardAccelerations, source.hardAccels),
      idleTime: firstPresent(source.totalIdlingTime, source.totalIdleDuration, source.idleTime),
    },
  };
}

function normalizeTripCompletedPayload(payload = {}) {
  if (normalizeEventType(payload.eventType || payload.event_type || payload.type) === 'trip-metrics') {
    return normalizeTripMetricsPayload(payload);
  }
  return payload;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function webhookDedupeKey(payload = {}, canonicalEventType = eventTypeFromPayload(payload), namespace = 'default') {
  return crypto
    .createHash('sha256')
    .update(stableJson({
      namespace,
      eventType: canonicalEventType,
      imei: extractImei(payload),
      transactionId: firstPresent(payload.transactionId, payload.transaction_id, payload.tripId, payload.trip_id),
      payload,
    }))
    .digest('hex');
}

module.exports = {
  eventTypeFromPayload,
  extractImei,
  firstPresent,
  normalizeEventType,
  normalizeTripCompletedPayload,
  normalizeTripMetricsPayload,
  num,
  pickLatestSample,
  pointFromPayload,
  pointFromSource,
  stableJson,
  webhookDedupeKey,
};
