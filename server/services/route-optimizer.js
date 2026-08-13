/**
 * Route Optimizer Service — Google Routes API
 *
 * Uses Google Routes API "computeRoutes" with optimizeWaypointOrder
 * to replace the nearest-neighbor heuristic with real traffic-aware routing.
 *
 * Falls back to nearest-neighbor if the API call fails or no API key is set.
 */

const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');

const HQ = { lat: 27.3946, lng: -82.3984 }; // Lakewood Ranch office

const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const FIELD_MASK = [
  'routes.optimizedIntermediateWaypointIndex',
  'routes.duration',
  'routes.distanceMeters',
  'routes.legs.duration',
  'routes.legs.distanceMeters',
  'routes.legs.startLocation',
  'routes.legs.endLocation',
].join(',');

/**
 * Build a Google Routes API waypoint from lat/lng
 */
function toWaypoint(lat, lng) {
  return {
    location: {
      latLng: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
    },
  };
}

/**
 * Haversine distance in miles
 */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Drive-time estimator — the ONE model every scheduling surface shares.
 *
 * This lived in three places (route-optimizer's own fallback, the find-time
 * scorer, and auto-dispatch/geo) with the constants copy-pasted between them.
 * They must agree: auto-dispatch ranks a visit's CURRENT placement against
 * CANDIDATE placements produced by find-time, so two models means comparing
 * numbers on different scales and "improving" a route that did not improve.
 *
 * Two models, selected by GATE_DRIVE_TIME_CALIBRATION:
 *
 *   legacy      haversine x 1.4 road factor @ 30 mph
 *   calibrated  a fixed per-leg overhead + a per-mile rate
 *
 * The calibrated constants were fitted against 150 real trips reconstructed
 * from Bouncie GPS (first/last fix per trip, with measured duration and
 * odometer distance), fitted on half the sample and scored on the held-out
 * half:
 *
 *   legacy      MAE 4.99 min   59% of legs within 5 min
 *   calibrated  MAE 3.89 min   79% of legs within 5 min
 *
 * The legacy constants were measurably wrong in both terms — the same trips
 * imply a road factor of 1.50 (not 1.40) and an average speed of 20.8 mph (not
 * 30). The speed assumption is the larger error and is why legacy
 * systematically under-estimates.
 *
 * The fixed term is measured, not a fudge factor: idle time averages 3.3 min on
 * a 13.2 min trip, and under-estimate correlates with idle at 0.886. It is the
 * park/unpark/idle overhead every leg carries regardless of length. One
 * consequence is deliberate — detour is computed as
 * d(prev,new) + d(new,next) - d(prev,next), so the fixed terms no longer cancel
 * and inserting a stop costs its overhead even when it sits directly en route.
 * A stop is never free; the legacy model priced it as if it were.
 */
const ROAD_FACTOR = 1.4;
const AVG_MPH = 30;

// Fitted per-leg overhead (minutes) and per-mile rate over STRAIGHT-LINE miles.
// The per-mile rate already carries the road-detour factor — it is not applied
// to road distance, so do not additionally multiply by ROAD_FACTOR.
const CALIBRATED_FIXED_MINUTES = 4.25;
const CALIBRATED_MINUTES_PER_MILE = 2.35;

// Below this, two points are the same place (~260 ft) and the leg is not a
// drive, so no overhead is charged. Guards the HQ bookends in candidate-slots,
// where an anchor can coincide with the stop being scored.
const SAME_PLACE_MILES = 0.05;

/**
 * Convert straight-line miles to estimated drive minutes.
 */
function milesToDriveMinutes(miles) {
  if (!Number.isFinite(miles) || miles <= 0) return 0;
  // Read at CALL time (not the baked gates map) so a flip needs no redeploy.
  if (gateEnvValue('GATE_DRIVE_TIME_CALIBRATION')) {
    if (miles < SAME_PLACE_MILES) return 0;
    return Math.round(CALIBRATED_FIXED_MINUTES + (miles * CALIBRATED_MINUTES_PER_MILE));
  }
  return Math.round((miles * ROAD_FACTOR / AVG_MPH) * 60);
}

/**
 * Drive minutes between two {lat,lng} points.
 */
function driveMin(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return 0;
  return milesToDriveMinutes(haversine(
    parseFloat(a.lat), parseFloat(a.lng),
    parseFloat(b.lat), parseFloat(b.lng),
  ));
}

/**
 * Calculate total straight-line distance for an ordered list of stops
 * (from HQ through all stops and back to HQ). Returns meters.
 */
function calcUnoptimizedDistance(stops, origin = HQ) {
  let total = 0;
  let prev = origin;
  for (const s of stops) {
    const lat = parseFloat(s.lat);
    const lng = parseFloat(s.lng);
    if (lat && lng) {
      total += haversine(prev.lat, prev.lng, lat, lng);
      prev = { lat, lng };
    }
  }
  // Return trip to HQ
  total += haversine(prev.lat, prev.lng, origin.lat, origin.lng);
  // Convert miles to meters
  return Math.round(total * 1609.34);
}

/**
 * Call Google Routes API with waypoint optimization.
 *
 * @param {Array} stops - [{ id, lat, lng, customerName, serviceType, ... }]
 * @param {Object} options - { startLat, startLng, endAtStart, techId }
 * @returns {Object} { orderedStops, totalDistanceMeters, totalDurationSeconds, legs, source }
 */
async function callGoogleRoutesAPI(stops, options = {}) {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error('No Google API key configured (GOOGLE_API_KEY or GOOGLE_MAPS_API_KEY)');
  }

  // Filter to stops that have valid coordinates
  const validStops = stops.filter(s => parseFloat(s.lat) && parseFloat(s.lng));
  const invalidStops = stops.filter(s => !parseFloat(s.lat) || !parseFloat(s.lng));

  if (validStops.length === 0) {
    throw new Error('No stops have valid lat/lng coordinates');
  }

  // Google Routes API limit: 25 intermediates
  if (validStops.length > 25) {
    throw new Error(`Too many waypoints (${validStops.length}). Google Routes API supports max 25 intermediates.`);
  }

  const originLat = options.startLat || HQ.lat;
  const originLng = options.startLng || HQ.lng;
  const endAtStart = options.endAtStart !== false; // default: return to HQ

  const body = {
    origin: toWaypoint(originLat, originLng),
    destination: endAtStart
      ? toWaypoint(originLat, originLng)
      : toWaypoint(validStops[validStops.length - 1].lat, validStops[validStops.length - 1].lng),
    intermediates: validStops.map(s => toWaypoint(s.lat, s.lng)),
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    optimizeWaypointOrder: true,
  };

  logger.info(`[route-optimizer] Calling Google Routes API with ${validStops.length} waypoints`);

  const response = await fetch(ROUTES_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data.error?.message || JSON.stringify(data);
    // Provide helpful hint for common errors
    if (errorMsg.includes('not activated') || errorMsg.includes('PERMISSION_DENIED') || errorMsg.includes('disabled')) {
      throw new Error(`Google Routes API error: ${errorMsg}. Hint: Enable "Routes API" in your Google Cloud Console at https://console.cloud.google.com/apis/library/routes.googleapis.com`);
    }
    throw new Error(`Google Routes API error (${response.status}): ${errorMsg}`);
  }

  if (!data.routes || data.routes.length === 0) {
    throw new Error('Google Routes API returned no routes');
  }

  const route = data.routes[0];
  const waypointOrder = route.optimizedIntermediateWaypointIndex || [];

  // Reorder stops based on API optimization
  const orderedStops = waypointOrder.map(idx => validStops[idx]);

  // Append any stops without coordinates at the end
  orderedStops.push(...invalidStops);

  // Parse legs
  const legs = [];
  if (route.legs && route.legs.length > 0) {
    for (let i = 0; i < route.legs.length; i++) {
      const leg = route.legs[i];
      const durationStr = leg.duration || '0s';
      const durationSeconds = parseInt(durationStr.replace('s', '')) || 0;

      let fromName, toName;
      if (i === 0) {
        fromName = 'HQ';
        toName = orderedStops[0]?.customerName || orderedStops[0]?.customer_name || `Stop ${i + 1}`;
      } else if (i === route.legs.length - 1 && endAtStart) {
        fromName = orderedStops[i - 1]?.customerName || orderedStops[i - 1]?.customer_name || `Stop ${i}`;
        toName = 'HQ';
      } else {
        fromName = orderedStops[i - 1]?.customerName || orderedStops[i - 1]?.customer_name || `Stop ${i}`;
        toName = orderedStops[i]?.customerName || orderedStops[i]?.customer_name || `Stop ${i + 1}`;
      }

      legs.push({
        from: fromName,
        to: toName,
        distanceMeters: leg.distanceMeters || 0,
        durationMinutes: Math.round(durationSeconds / 60),
      });
    }
  }

  // Total distance and duration from the route
  const totalDistanceMeters = route.distanceMeters || 0;
  const routeDurationStr = route.duration || '0s';
  const totalDurationSeconds = parseInt(routeDurationStr.replace('s', '')) || 0;

  return {
    orderedStops,
    totalDistanceMeters,
    totalDurationSeconds,
    legs,
    source: 'google_routes_api',
  };
}

/**
 * Nearest-neighbor fallback optimizer (original algorithm).
 * Used when Google Routes API is unavailable.
 */
function nearestNeighborOptimize(stops, options = {}) {
  const origin = {
    lat: options.startLat || HQ.lat,
    lng: options.startLng || HQ.lng,
  };

  // Coordless stops append at the END, same as the Google Routes path — the
  // ZIP heuristic used to interleave them mid-route, which hands a stamped
  // no-geocode visit a confident-looking route_order pointing nowhere.
  const coordlessStops = stops.filter(s => !parseFloat(s.lat) || !parseFloat(s.lng));
  const validStops = stops.filter(s => parseFloat(s.lat) && parseFloat(s.lng));
  const ordered = [];
  let current = origin;
  let totalDistanceMeters = 0;
  const legs = [];

  while (validStops.length > 0) {
    let nearestIdx = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < validStops.length; i++) {
      const s = validStops[i];
      const sLat = parseFloat(s.lat);
      const sLng = parseFloat(s.lng);

      if (sLat && sLng) {
        const dist = haversine(current.lat, current.lng, sLat, sLng);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearestIdx = i;
        }
      }
    }

    const nearest = validStops.splice(nearestIdx, 1)[0];
    const distMeters = nearestDist < Infinity ? Math.round(nearestDist * 1609.34 * 1.4) : 0; // 1.4x road factor
    const durationMin = distMeters > 0 ? Math.round((distMeters / 1609.34 / 30) * 60) : 0; // 30 mph avg

    const fromName = ordered.length === 0
      ? 'HQ'
      : (ordered[ordered.length - 1].customerName || ordered[ordered.length - 1].customer_name || `Stop ${ordered.length}`);
    const toName = nearest.customerName || nearest.customer_name || `Stop ${ordered.length + 1}`;

    legs.push({
      from: fromName,
      to: toName,
      distanceMeters: distMeters,
      durationMinutes: durationMin,
    });

    totalDistanceMeters += distMeters;
    ordered.push(nearest);
    current = {
      lat: parseFloat(nearest.lat) || current.lat,
      lng: parseFloat(nearest.lng) || current.lng,
      zip: nearest.zip || current.zip,
    };
  }

  // Add return-to-HQ leg
  const lastStop = ordered[ordered.length - 1];
  if (lastStop) {
    const returnDist = haversine(current.lat, current.lng, origin.lat, origin.lng);
    const returnMeters = Math.round(returnDist * 1609.34 * 1.4);
    totalDistanceMeters += returnMeters;
    legs.push({
      from: lastStop.customerName || lastStop.customer_name || `Stop ${ordered.length}`,
      to: 'HQ',
      distanceMeters: returnMeters,
      durationMinutes: Math.round((returnMeters / 1609.34 / 30) * 60),
    });
  }

  const totalDurationSeconds = legs.reduce((sum, l) => sum + l.durationMinutes * 60, 0);

  // Coordless stops land after the routed ones (no legs — nothing to route).
  ordered.push(...coordlessStops);

  return {
    orderedStops: ordered,
    totalDistanceMeters,
    totalDurationSeconds,
    legs,
    source: 'nearest_neighbor_fallback',
  };
}

/**
 * Main optimization function. Tries Google Routes API first, falls back to nearest-neighbor.
 *
 * @param {Array} stops - [{ id, lat, lng, customerName, serviceType, timeWindow, zone, city, zip }]
 * @param {Object} options - { startLat, startLng, endAtStart, techId }
 * @returns {Object} optimization result
 */
async function optimizeRoute(stops, options = {}) {
  if (!stops || stops.length === 0) {
    return {
      orderedStops: [],
      totalDistanceMeters: 0,
      totalDurationSeconds: 0,
      unoptimizedDistanceMeters: 0,
      legs: [],
      source: 'empty',
    };
  }

  // For a single stop, no optimization needed
  if (stops.length === 1) {
    const s = stops[0];
    const distToStop = haversine(HQ.lat, HQ.lng, parseFloat(s.lat) || HQ.lat, parseFloat(s.lng) || HQ.lng);
    const distMeters = Math.round(distToStop * 1609.34 * 2); // round trip
    return {
      orderedStops: stops,
      totalDistanceMeters: distMeters,
      totalDurationSeconds: Math.round((distMeters / 1609.34 / 30) * 60) * 60,
      unoptimizedDistanceMeters: distMeters,
      legs: [
        { from: 'HQ', to: s.customerName || s.customer_name || 'Stop 1', distanceMeters: Math.round(distMeters / 2), durationMinutes: Math.round((distMeters / 2 / 1609.34 / 30) * 60) },
        { from: s.customerName || s.customer_name || 'Stop 1', to: 'HQ', distanceMeters: Math.round(distMeters / 2), durationMinutes: Math.round((distMeters / 2 / 1609.34 / 30) * 60) },
      ],
      source: 'single_stop',
    };
  }

  // Calculate unoptimized distance (original order)
  const unoptimizedDistanceMeters = calcUnoptimizedDistance(stops);

  let result;
  let apiWarning = null;

  try {
    result = await callGoogleRoutesAPI(stops, options);
  } catch (err) {
    logger.warn(`[route-optimizer] Google Routes API failed, using fallback: ${err.message}`);
    apiWarning = err.message;
    result = nearestNeighborOptimize(stops, options);
  }

  result.unoptimizedDistanceMeters = unoptimizedDistanceMeters;
  if (apiWarning) {
    result.apiWarning = apiWarning;
  }

  return result;
}

module.exports = {
  optimizeRoute,
  callGoogleRoutesAPI,
  nearestNeighborOptimize,
  calcUnoptimizedDistance,
  haversine,
  HQ,
  milesToDriveMinutes,
  driveMin,
};
