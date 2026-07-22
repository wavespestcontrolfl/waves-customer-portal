/**
 * Bouncie GPS Mileage Service
 *
 * Pulls trip data from the Bouncie API and syncs it into the mileage_log table
 * for IRS mileage deduction tracking (Schedule C, Line 9).
 *
 * Bouncie API docs: https://docs.bouncie.dev
 * Auth: OAuth access token via Authorization header
 * Base URL: https://api.bouncie.dev/v1
 */

const config = require('../config');
const db = require('../models/db');
const logger = require('./logger');
const mileageWriter = require('./bouncie-mileage');
const tokenStore = require('./bouncie-token-store');
const { parseETDateTime } = require('../utils/datetime-et');

const API_BASE = config.bouncie.apiBase || 'https://api.bouncie.dev/v1';
const AUTH_BASE = config.bouncie.authBase || 'https://auth.bouncie.com';

// In-memory token (shared with routes/bouncie.js pattern)
function cleanToken(value) {
  const trimmed = String(value || '').trim();
  return trimmed || null;
}

let currentToken = cleanToken(config.bouncie.accessToken);
let currentRefresh = cleanToken(config.bouncie.refreshToken);
let hydratedTokens = false;

async function hydrateTokens(force = false) {
  if (hydratedTokens && !force) return;
  const stored = await tokenStore.loadTokens();
  if (stored?.accessToken) currentToken = cleanToken(stored.accessToken);
  if (stored?.refreshToken) currentRefresh = cleanToken(stored.refreshToken);
  hydratedTokens = true;
}

/**
 * Refresh the Bouncie OAuth access token
 */
async function refreshAccessToken() {
  try {
    await hydrateTokens();
    const refreshToken = cleanToken(currentRefresh);
    if (!refreshToken) {
      logger.error('[bouncie] Token refresh failed: no refresh token configured');
      return false;
    }

    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.bouncie.clientId,
        client_secret: config.bouncie.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`[bouncie] Token refresh failed: ${res.status} ${body}`);
      return false;
    }

    const data = await res.json();
    currentToken = cleanToken(data.access_token);
    if (data.refresh_token) currentRefresh = cleanToken(data.refresh_token);
    await tokenStore.saveTokens({
      accessToken: currentToken,
      refreshToken: data.refresh_token ? currentRefresh : null,
      expiresIn: data.expires_in,
    });
    logger.info('[bouncie] Access token refreshed');
    return true;
  } catch (err) {
    logger.error(`[bouncie] Token refresh error: ${err.message}`);
    return false;
  }
}

/**
 * Make an authenticated GET request to the Bouncie API with auto-retry on 401
 */
async function bouncieRequest(path) {
  await hydrateTokens();
  if (!currentToken) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new Error('Bouncie access token is not configured');
  }

  const doFetch = () => fetch(`${API_BASE}${path}`, {
    headers: {
      'Authorization': cleanToken(currentToken),
      'Content-Type': 'application/json',
    },
  });

  let res = await doFetch();

  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      res = await doFetch();
    }
  }

  if (!res.ok) {
    const body = await res.text();
    logger.error(`[bouncie] API error ${res.status}: ${body}`);
    throw new Error(`Bouncie API returned ${res.status}`);
  }

  return res.json();
}

// (The IRS rate resolver lives in bouncie-mileage.js — a stale duplicate
// year-map here was dead code and was removed so rates can't drift.)

class BouncieService {
  /**
   * Verify outbound OAuth credentials using the same request path as all
   * other Bouncie API calls. This refreshes an expired access token before
   * reporting health.
   */
  async checkAuth() {
    return bouncieRequest('/user');
  }

  /**
   * List all registered vehicles from Bouncie
   * @returns {Array} vehicles
   */
  async getVehicles() {
    try {
      const vehicles = await bouncieRequest('/vehicles');
      logger.info(`[bouncie] Found ${vehicles.length} vehicle(s)`);
      return vehicles.map(v => ({
        id: v.imei,
        imei: v.imei,
        vin: v.vin,
        make: v.model?.make || 'Unknown',
        model: v.model?.name || 'Unknown',
        year: v.model?.year || null,
        nickname: v.nickName || `${v.model?.make || ''} ${v.model?.name || ''}`.trim(),
        isRunning: v.stats?.isRunning || false,
        fuelLevel: v.stats?.fuelLevel || null,
        odometer: v.stats?.odometer || null,
        speed: v.stats?.speed ?? null,
        lastLocation: v.stats?.location || null,
        lastUpdated: v.stats?.lastUpdated || v.stats?.location?.timestamp || null,
      }));
    } catch (err) {
      logger.error(`[bouncie] getVehicles failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get trips for a vehicle in a date range
   * @param {string} vehicleId - Bouncie vehicle IMEI
   * @param {string} startDate - ISO date string (YYYY-MM-DD)
   * @param {string} endDate - ISO date string (YYYY-MM-DD)
   * @returns {Array} trips
   */
  async getTrips(vehicleId, startDate, endDate) {
    try {
      const imei = vehicleId || config.bouncie.vehicleImei;
      if (!imei) throw new Error('No vehicle IMEI provided');

      const allTrips = [];
      for (const [chunkStart, chunkEnd] of dateChunks(startDate, endDate)) {
        const window = etDateChunkWindow(chunkStart, chunkEnd);
        const params = new URLSearchParams({
          imei,
          'gps-format': 'geojson',
          'starts-after': window.startsAfter,
          'ends-before': window.endsBefore,
        });

        const trips = await bouncieRequest(`/trips?${params.toString()}`);
        allTrips.push(...trips);
      }
      logger.info(`[bouncie] Found ${allTrips.length} trip(s) for vehicle ${imei} from ${startDate} to ${endDate}`);

      return allTrips.map((trip) => normalizeRestTrip(trip, imei));
    } catch (err) {
      logger.error(`[bouncie] getTrips failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Sync mileage from Bouncie into mileage_log table
   *
   * Pulls all trips for all vehicles in the date range, deduplicates by
   * bouncie_trip_id, calculates IRS deduction, and inserts new records.
   *
   * @param {string} startDate - YYYY-MM-DD
   * @param {string} endDate - YYYY-MM-DD
   * @returns {{ tripsImported: number, totalMiles: number, deductionAmount: number, skipped: number }}
   */
  async syncMileage(startDate, endDate) {
    try {
      const vehicles = await this.getVehicles();
      let tripsImported = 0;
      let totalMiles = 0;
      let totalDeduction = 0;
      let skipped = 0;

      for (const vehicle of vehicles) {
        let trips;
        try {
          trips = await this.getTrips(vehicle.id, startDate, endDate);
        } catch (err) {
          logger.warn(`[bouncie] Skipping vehicle ${vehicle.id}: ${err.message}`);
          continue;
        }

        for (const trip of trips) {
          // Dedup: skip if we already have this trip
          const existing = await db('mileage_log')
            .where({ bouncie_trip_id: trip.tripId })
            .first();

          if (existing) {
            skipped++;
            continue;
          }

          const inserted = await mileageWriter.processTripWebhook({
            eventType: 'tripCompleted',
            imei: vehicle.id,
            data: {
              ...trip,
              transactionId: trip.tripId,
              vehicleId: vehicle.id,
              nickName: vehicle.nickname || `${vehicle.make} ${vehicle.model}`,
              distanceMiles: trip.distanceMiles,
              durationSeconds: trip.durationSeconds,
            },
          });

          tripsImported++;
          totalMiles += trip.distanceMiles;
          totalDeduction += parseFloat(inserted?.deduction_amount || 0);
        }
      }

      totalMiles = parseFloat(totalMiles.toFixed(2));
      totalDeduction = parseFloat(totalDeduction.toFixed(2));

      logger.info(`[bouncie] Mileage sync complete: ${tripsImported} imported, ${skipped} skipped, ${totalMiles} miles, $${totalDeduction} deduction`);

      return { tripsImported, totalMiles, deductionAmount: totalDeduction, skipped };
    } catch (err) {
      logger.error(`[bouncie] syncMileage failed: ${err.message}`);
      throw err;
    }
  }
  /**
   * Get live vehicle location for a specific IMEI (tech-specific).
   * Used by the customer-facing service tracker to show the assigned
   * tech's truck on the live map — not a random running vehicle.
   * Returns null if the IMEI doesn't match any current vehicle or no
   * location is available.
   */
  async getLocationByImei(imei) {
    if (!imei) return null;
    try {
      const vehicles = await this.getVehicles();
      const match = vehicles.find((v) => String(v.imei || v.id) === String(imei));
      if (!match || !match.lastLocation) return null;
      return {
        vehicleId: match.id,
        vehicleName: match.nickname,
        lat: match.lastLocation.lat,
        lng: match.lastLocation.lon || match.lastLocation.lng,
        isRunning: !!match.isRunning,
        speed: match.speed ?? null,
        heading: match.lastLocation.heading ?? null,
        updatedAt: match.lastLocation.timestamp || match.lastUpdated || null,
      };
    } catch (err) {
      logger.error(`[bouncie] getLocationByImei failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Get live vehicle location for ETA calculation.
   * Returns { lat, lng, isRunning, speed } for the first running vehicle,
   * or the most recently active vehicle if none are running.
   */
  async getLiveLocation() {
    try {
      const vehicles = await this.getVehicles();
      // Prefer a running vehicle
      const running = vehicles.find(v => v.isRunning && v.lastLocation);
      const best = running || vehicles.find(v => v.lastLocation) || null;
      if (!best || !best.lastLocation) return null;
      return {
        vehicleId: best.id,
        vehicleName: best.nickname,
        lat: best.lastLocation.lat,
        lng: best.lastLocation.lon || best.lastLocation.lng,
        isRunning: best.isRunning,
        odometer: best.odometer,
      };
    } catch (err) {
      logger.error(`[bouncie] getLiveLocation failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Calculate ETA from explicit from-coords to a customer address.
   * Used by the customer track endpoint, which has the tech's coords
   * already from tech_status and shouldn't pick "the running vehicle".
   * Uses Google Distance Matrix API if available, falls back to haversine.
   * @returns { etaMinutes, distanceMiles, source } or null if from-coords missing
   */
  async calculateETAFromCoords(fromLat, fromLng, customerLat, customerLng) {
    if (fromLat == null || fromLng == null) return null;
    if (customerLat == null || customerLng == null) return null;

    const googleKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
    if (googleKey) {
      try {
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${fromLat},${fromLng}&destinations=${customerLat},${customerLng}&key=${googleKey}&units=imperial`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const element = data.rows?.[0]?.elements?.[0];
          if (element?.status === 'OK') {
            // Nullish-only fallback: a valid duration/distance of 0
            // (tech effectively at the destination right before the
            // en_route → on_property flip) must surface as ~0, not as
            // the 15-min default. Fall through to haversine only when
            // the API genuinely omits the value.
            const durationSec = element.duration?.value;
            const distanceMeters = element.distance?.value;
            if (durationSec != null) {
              const distanceMi = distanceMeters != null
                ? Math.round(distanceMeters / 1609.34 * 10) / 10
                : null;
              return { etaMinutes: Math.round(durationSec / 60), distanceMiles: distanceMi, source: 'google' };
            }
          }
        }
      } catch { /* fall through to haversine */ }
    }

    const R = 3959;
    const dLat = (customerLat - fromLat) * Math.PI / 180;
    const dLng = (customerLng - fromLng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(fromLat * Math.PI / 180) * Math.cos(customerLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const roadDist = dist * 1.4;
    const etaMin = Math.round((roadDist / 30) * 60);
    return { etaMinutes: Math.max(1, etaMin), distanceMiles: Math.round(roadDist * 10) / 10, source: 'haversine' };
  }

  /**
   * Calculate ETA from current vehicle location to a customer address.
   * Uses Google Distance Matrix API if available, falls back to haversine.
   * @returns { etaMinutes, distanceMiles, source }
   */
  async calculateETA(customerLat, customerLng) {
    const loc = await this.getLiveLocation();
    if (!loc) return { etaMinutes: 15, distanceMiles: null, source: 'default' };

    // Try Google Distance Matrix API first
    const googleKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
    if (googleKey && customerLat && customerLng) {
      try {
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${loc.lat},${loc.lng}&destinations=${customerLat},${customerLng}&key=${googleKey}&units=imperial`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const element = data.rows?.[0]?.elements?.[0];
          if (element?.status === 'OK') {
            // Nullish-only fallback: a real 0 (vehicle at the customer
            // address right before arrival) must surface as ~0, not be
            // converted to a 15-min default. Fall through to haversine
            // only when the API genuinely omits the value. Mirrors the
            // fix landed in calculateETAFromCoords (PR #361 followup).
            const durationSec = element.duration?.value;
            const distanceMeters = element.distance?.value;
            if (durationSec != null) {
              const distanceMi = distanceMeters != null
                ? Math.round(distanceMeters / 1609.34 * 10) / 10
                : null;
              return { etaMinutes: Math.round(durationSec / 60), distanceMiles: distanceMi, source: 'google', vehicleName: loc.vehicleName };
            }
          }
        }
      } catch { /* fall through to haversine */ }
    }

    // Fallback: haversine distance → ETA at 30mph avg
    if (customerLat && customerLng) {
      const R = 3959; // Earth radius in miles
      const dLat = (customerLat - loc.lat) * Math.PI / 180;
      const dLng = (customerLng - loc.lng) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(loc.lat * Math.PI / 180) * Math.cos(customerLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
      const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const roadDist = dist * 1.4; // road factor
      const etaMin = Math.round((roadDist / 30) * 60); // 30 mph avg
      return { etaMinutes: Math.max(5, etaMin), distanceMiles: Math.round(roadDist * 10) / 10, source: 'haversine', vehicleName: loc.vehicleName };
    }

    return { etaMinutes: 15, distanceMiles: null, source: 'default' };
  }

  /**
   * Update in-memory tokens (called from OAuth callback route)
   */
  async updateTokens(accessToken, refreshToken, options = {}) {
    if (accessToken) currentToken = cleanToken(accessToken);
    if (refreshToken) currentRefresh = cleanToken(refreshToken);
    hydratedTokens = true;
    if (options.persist !== false) {
      await tokenStore.saveTokens({
        accessToken: cleanToken(accessToken),
        refreshToken: cleanToken(refreshToken),
        expiresIn: options.expiresIn,
      });
    }
    logger.info('[bouncie] In-memory tokens updated from OAuth callback');
  }
}

module.exports = new BouncieService();

function dateChunks(startDate, endDate) {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  if (end < start) throw new Error('endDate must be on or after startDate');

  const chunks = [];
  for (let cursor = start; cursor <= end;) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 6);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push([formatDateOnly(cursor), formatDateOnly(chunkEnd)]);
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function parseDateOnly(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid date: ${value}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatDateOnly(date) {
  return date.toISOString().split('T')[0];
}

function etDateChunkWindow(chunkStart, chunkEnd) {
  return {
    startsAfter: parseETDateTime(`${chunkStart}T00:00:00`).toISOString(),
    endsBefore: parseETDateTime(`${chunkEnd}T23:59:59`).toISOString(),
  };
}

function normalizeRestTrip(trip, imei) {
  const route = routeEndpointsFromGps(trip.gps);
  const durationSeconds = trip.duration || trip.tripTime ||
    (trip.startTime && trip.endTime ? Math.max(0, Math.round((new Date(trip.endTime) - new Date(trip.startTime)) / 1000)) : 0);
  const distanceMeters = Number.isFinite(Number(trip.distance)) ? Number(trip.distance) : 0;
  const distanceMiles = parseFloat((distanceMeters / 1609.344).toFixed(2));
  return {
    tripId: trip.transactionId || trip.id || `${imei}-${trip.startTime || trip.endTime}`,
    vehicleId: imei,
    imei,
    startTime: trip.startTime,
    endTime: trip.endTime,
    startLocation: trip.startLocation || route.start || {},
    endLocation: trip.endLocation || route.end || {},
    distance: distanceMeters,
    distanceMeters,
    distanceMiles,
    durationMinutes: durationSeconds ? Math.round(durationSeconds / 60) : 0,
    durationSeconds,
    maxSpeed: trip.maxSpeed || null,
    averageSpeed: trip.averageSpeed || null,
    hardBrakes: trip.hardBrakingCount || trip.hardBrakes || 0,
    hardAccels: trip.hardAccelerationCount || trip.hardAccelerations || 0,
    idleTime: trip.totalIdleDuration || 0,
    fuelConsumed: trip.fuelConsumed || null,
    startOdometer: trip.startOdometer || null,
    endOdometer: trip.endOdometer || null,
  };
}

function routeEndpointsFromGps(gps) {
  if (!gps) return {};
  let parsed = gps;
  if (typeof gps === 'string') {
    try {
      parsed = JSON.parse(gps);
    } catch {
      return {};
    }
  }

  const coordinates =
    parsed?.type === 'Feature' ? parsed.geometry?.coordinates :
      parsed?.type === 'LineString' ? parsed.coordinates :
        parsed?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length === 0) return {};

  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  const toLocation = (coord) => {
    if (!Array.isArray(coord) || coord.length < 2) return null;
    return { lon: coord[0], lng: coord[0], lat: coord[1] };
  };
  return {
    start: toLocation(first),
    end: toLocation(last),
  };
}

module.exports._test = {
  dateChunks,
  etDateChunkWindow,
  normalizeRestTrip,
  routeEndpointsFromGps,
};
