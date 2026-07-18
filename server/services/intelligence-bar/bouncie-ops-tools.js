/**
 * Intelligence Bar — Bouncie Vehicle Ops Tools
 * server/services/intelligence-bar/bouncie-ops-tools.js
 *
 * Read-only visibility into the truck: live location/running state and a
 * day's trips. The mileage crons already sync trips into the tax ledger —
 * these tools answer the operator's real-time questions ("where's the
 * truck?", "what did it drive today?") straight from Bouncie.
 *
 * Reuses services/bouncie.js (OAuth token store handles refresh). Trip
 * start/end points trace customer service stops — the trips tool is in the
 * route's PII redaction set.
 */

const bouncie = require('../bouncie');
const { etDateString } = require('../../utils/datetime-et');
const logger = require('../logger');

const MAX_TRIPS_SHOWN = 30;

const BOUNCIE_OPS_TOOLS = [
  {
    name: 'get_truck_status',
    description: `Live vehicle state from the Bouncie tracker: which truck, running or parked, current/last-known location, fuel, odometer, and when the tracker last reported. A stale lastUpdated means the tracker itself is offline.
Use for: "where's the truck?", "is the truck moving?", "is the Bouncie tracker reporting?"`,
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_truck_trips',
    description: `Trips for one day (default today, Eastern): start/end times, distance, and total mileage. This is the live view of the same data the tax mileage ledger syncs on its cron.
Use for: "what did the truck drive today?", "how many miles yesterday?", "when did the day's route start?"`,
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Day to report, YYYY-MM-DD (Eastern; default today)' },
      },
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Bouncie access is not configured. BOUNCIE_CLIENT_ID/BOUNCIE_CLIENT_SECRET must be set in the Railway dashboard and the tracker connected.';

function isConfigured() {
  return !!(process.env.BOUNCIE_CLIENT_ID && process.env.BOUNCIE_CLIENT_SECRET);
}

async function getTruckStatus() {
  const vehicles = await bouncie.getVehicles();
  return {
    vehicles: vehicles.map(v => ({
      nickname: v.nickname,
      make: v.make,
      model: v.model,
      year: v.year,
      is_running: !!v.isRunning,
      speed: v.speed ?? null,
      fuel_level: v.fuelLevel ?? null,
      odometer: v.odometer ?? null,
      last_location: v.lastLocation
        ? { lat: v.lastLocation.lat ?? null, lng: v.lastLocation.lon ?? v.lastLocation.lng ?? null }
        : null,
      last_updated: v.lastUpdated || null,
    })),
    total: vehicles.length,
    note: 'Live tracker state. A stale last_updated (hours old while the truck is in use) means the Bouncie device itself is offline.',
  };
}

async function getTruckTrips(input) {
  const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date.trim())
    ? input.date.trim()
    : etDateString(new Date());
  const vehicles = await bouncie.getVehicles();
  if (!vehicles.length) {
    return { date, trips: [], total: 0, total_miles: 0, note: 'No vehicles registered on the Bouncie account.' };
  }
  const vehicle = vehicles.find(v => String(v.imei) === String(process.env.BOUNCIE_VEHICLE_IMEI)) || vehicles[0];
  const trips = await bouncie.getTrips(vehicle.id, date, date);
  // Normalized trips carry distance in METERS on `distance`; miles live on
  // `distanceMiles` — use the latter.
  const shown = (trips || []).slice(0, MAX_TRIPS_SHOWN).map(trip => ({
    started_at: trip.startTime || null,
    ended_at: trip.endTime || null,
    distance_miles: trip.distanceMiles != null ? Number(trip.distanceMiles) : null,
    duration_minutes: trip.durationMinutes ?? null,
    max_speed: trip.maxSpeed ?? null,
  }));
  const totalMiles = (trips || []).reduce((sum, trip) => sum + (Number(trip.distanceMiles) || 0), 0);
  return {
    date,
    vehicle: vehicle.nickname,
    trips: shown,
    total: (trips || []).length,
    total_miles: Number(totalMiles.toFixed(1)),
    truncated: (trips || []).length > MAX_TRIPS_SHOWN,
    note: 'Live Bouncie trips for the day (Eastern). The tax mileage ledger syncs this same data on its cron — discrepancies there are a sync question, not a tracker question.',
  };
}

async function executeBouncieOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!isConfigured()) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_truck_status': return await getTruckStatus();
      case 'get_truck_trips': return await getTruckTrips(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:bouncie-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { BOUNCIE_OPS_TOOLS, executeBouncieOpsTool };
