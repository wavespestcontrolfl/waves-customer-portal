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

const API_BASE = config.bouncie.apiBase || 'https://api.bouncie.dev/v1';
const AUTH_BASE = config.bouncie.authBase || 'https://auth.bouncie.com';

// IRS standard mileage rates by year
const IRS_MILEAGE_RATES = {
  2024: 0.67,
  2025: 0.70,
  2026: 0.70, // placeholder — update when IRS publishes
};

// In-memory token (shared with routes/bouncie.js pattern)
let currentToken = config.bouncie.accessToken;
let currentRefresh = config.bouncie.refreshToken;

/**
 * Refresh the Bouncie OAuth access token
 */
async function refreshAccessToken() {
  try {
    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.bouncie.clientId,
        client_secret: config.bouncie.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: currentRefresh,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`[bouncie] Token refresh failed: ${res.status} ${body}`);
      return false;
    }

    const data = await res.json();
    currentToken = data.access_token;
    if (data.refresh_token) currentRefresh = data.refresh_token;
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
  const doFetch = () => fetch(`${API_BASE}${path}`, {
    headers: {
      'Authorization': currentToken,
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

/**
 * Get the IRS mileage rate for a given year
 */
function getIrsRate(year) {
  return IRS_MILEAGE_RATES[year] || IRS_MILEAGE_RATES[2025];
}

class BouncieService {
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
        vin: v.vin,
        make: v.model?.make || 'Unknown',
        model: v.model?.name || 'Unknown',
        year: v.model?.year || null,
        nickname: v.nickName || `${v.model?.make || ''} ${v.model?.name || ''}`.trim(),
        isRunning: v.stats?.isRunning || false,
        fuelLevel: v.stats?.fuelLevel || null,
        odometer: v.stats?.odometer || null,
        lastLocation: v.stats?.location || null,
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

      // Bouncie uses ISO format for date params
      const params = new URLSearchParams({
        imei,
        starts_after: `${startDate}T00:00:00Z`,
        ends_before: `${endDate}T23:59:59Z`,
      });

      const trips = await bouncieRequest(`/trips?${params.toString()}`);
      logger.info(`[bouncie] Found ${trips.length} trip(s) for vehicle ${imei} from ${startDate} to ${endDate}`);

      return trips.map(trip => ({
        tripId: trip.transactionId || trip.id || `${imei}-${trip.startTime}`,
        vehicleId: imei,
        startTime: trip.startTime,
        endTime: trip.endTime,
        startLocation: trip.startLocation || {},
        endLocation: trip.endLocation || {},
        distanceMiles: trip.distance ? parseFloat((trip.distance * 0.000621371).toFixed(2)) : 0, // meters to miles
        durationMinutes: trip.duration ? Math.round(trip.duration / 60) : 0, // seconds to minutes
        maxSpeed: trip.maxSpeed || null,
        hardBrakes: trip.hardBrakes || 0,
        hardAccels: trip.hardAccelerations || 0,
      }));
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

          const tripDate = new Date(trip.startTime);
          const year = tripDate.getFullYear();
          const irsRate = getIrsRate(year);
          const deductionAmount = parseFloat((trip.distanceMiles * irsRate).toFixed(2));

          // Build start/end address strings from location objects
          const startAddr = trip.startLocation?.address ||
            [trip.startLocation?.lat, trip.startLocation?.lon].filter(Boolean).join(', ') ||
            'Unknown';
          const endAddr = trip.endLocation?.address ||
            [trip.endLocation?.lat, trip.endLocation?.lon].filter(Boolean).join(', ') ||
            'Unknown';

          await db('mileage_log').insert({
            vehicle_id: vehicle.id,
            vehicle_name: vehicle.nickname || `${vehicle.make} ${vehicle.model}`,
            trip_date: tripDate.toISOString().split('T')[0],
            start_address: startAddr,
            end_address: endAddr,
            distance_miles: trip.distanceMiles,
            duration_minutes: trip.durationMinutes,
            purpose: 'business', // default all trips as business
            irs_rate: irsRate,
            deduction_amount: deductionAmount,
            bouncie_trip_id: trip.tripId,
            source: 'bouncie',
          });

          tripsImported++;
          totalMiles += trip.distanceMiles;
          totalDeduction += deductionAmount;
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
            const durationMin = Math.round((element.duration?.value || 900) / 60);
            const distanceMi = element.distance?.value ? Math.round(element.distance.value / 1609.34 * 10) / 10 : null;
            return { etaMinutes: durationMin, distanceMiles: distanceMi, source: 'google', vehicleName: loc.vehicleName };
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
}

module.exports = new BouncieService();
