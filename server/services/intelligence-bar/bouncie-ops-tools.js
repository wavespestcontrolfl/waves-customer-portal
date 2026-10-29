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
const { technicianNamesByImei } = require('../bouncie-mileage');
const { truckViewsPerVehicleLive } = require('../../config/feature-gates');
const { etDateString } = require('../../utils/datetime-et');
const logger = require('../logger');

const MAX_TRIPS_SHOWN = 30;

const TRIPS_DESCRIPTION = `Trips for one day (default today, Eastern): start/end times, distance, and total mileage. This is the live view of the same data the tax mileage ledger syncs on its cron.
Use for: "what did the truck drive today?", "how many miles yesterday?", "when did the day's route start?"`;

const TRIPS_DESCRIPTION_PER_VEHICLE = `Trips for one day (default today, Eastern) for EVERY vehicle on the Bouncie account, each with its assigned technician: start/end times, distance, per-vehicle miles and total miles. Pass vehicle (a vehicle nickname or a technician's name) to see just that one. This is the live view of the same data the tax mileage ledger syncs on its cron.
Use for: "what did the truck drive today?", "how many miles did each truck drive?", "what did <technician> drive yesterday?", "when did the day's route start?"`;

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
    // GATE_TRUCK_VIEWS_PER_VEHICLE: read when the model's tool list is serialized,
    // so off = the description and schema below, byte for byte.
    get description() {
      return truckViewsPerVehicleLive() ? TRIPS_DESCRIPTION_PER_VEHICLE : TRIPS_DESCRIPTION;
    },
    get input_schema() {
      return {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Day to report, YYYY-MM-DD (Eastern; default today)' },
          ...(truckViewsPerVehicleLive() && {
            vehicle: { type: 'string', description: 'One vehicle, by its nickname or by the name of the technician it is assigned to (not case-sensitive). Leave out for every vehicle.' },
          }),
        },
      };
    },
  },
];

const NOT_CONFIGURED_MESSAGE = 'Bouncie access is not configured. BOUNCIE_CLIENT_ID/BOUNCIE_CLIENT_SECRET must be set in the Railway dashboard and the tracker connected.';

function isConfigured() {
  return !!(process.env.BOUNCIE_CLIENT_ID && process.env.BOUNCIE_CLIENT_SECRET);
}

async function getTruckStatus() {
  const vehicles = await bouncie.getVehicles();
  const technicians = truckViewsPerVehicleLive() ? await technicianNamesByImei() : null;
  return {
    vehicles: vehicles.map(v => ({
      nickname: v.nickname,
      ...(technicians && { technician: technicians.get(String(v.imei)) || null }),
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

// Normalized trips carry distance in METERS on `distance`; miles live on
// `distanceMiles` — use the latter.
function summarizeTrips(trips) {
  const all = trips || [];
  const totalMiles = all.reduce((sum, trip) => sum + (Number(trip.distanceMiles) || 0), 0);
  return {
    trips: all.slice(0, MAX_TRIPS_SHOWN).map(trip => ({
      started_at: trip.startTime || null,
      ended_at: trip.endTime || null,
      distance_miles: trip.distanceMiles != null ? Number(trip.distanceMiles) : null,
      duration_minutes: trip.durationMinutes ?? null,
      max_speed: trip.maxSpeed ?? null,
    })),
    total: all.length,
    total_miles: Number(totalMiles.toFixed(1)),
    truncated: all.length > MAX_TRIPS_SHOWN,
  };
}

const TRIPS_NOTE = 'Live Bouncie trips for the day (Eastern). The tax mileage ledger syncs this same data on its cron — discrepancies there are a sync question, not a tracker question.';

async function getTruckTrips(input) {
  const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date.trim())
    ? input.date.trim()
    : etDateString(new Date());
  const vehicles = await bouncie.getVehicles();
  if (truckViewsPerVehicleLive()) return getTripsPerVehicle(date, vehicles, input.vehicle);
  if (!vehicles.length) {
    return { date, trips: [], total: 0, total_miles: 0, note: 'No vehicles registered on the Bouncie account.' };
  }
  const vehicle = vehicles.find(v => String(v.imei) === String(process.env.BOUNCIE_VEHICLE_IMEI)) || vehicles[0];
  const trips = await bouncie.getTrips(vehicle.id, date, date);
  return {
    date,
    vehicle: vehicle.nickname,
    ...summarizeTrips(trips),
    note: TRIPS_NOTE,
  };
}

// GATE_TRUCK_VIEWS_PER_VEHICLE on: every vehicle with its technician, or the one named.
async function getTripsPerVehicle(date, vehicles, wanted) {
  if (!vehicles.length) {
    return { date, vehicles: [], total_miles: 0, note: 'No vehicles registered on the Bouncie account.' };
  }
  const technicians = await technicianNamesByImei();
  const rows = vehicles.map(v => ({ v, technician: technicians.get(String(v.imei)) || null }));
  const name = typeof wanted === 'string' ? wanted.trim().toLowerCase() : '';
  const chosen = name
    ? rows.filter(r => String(r.v.nickname || '').toLowerCase() === name || String(r.technician || '').toLowerCase() === name)
    : rows;
  if (!chosen.length) {
    // A plain answer, not { error }: errors count against the shared circuit breaker.
    const known = rows.map(r => (r.technician ? `${r.v.nickname} (${r.technician})` : r.v.nickname)).join(', ');
    return { date, vehicles: [], total_miles: 0, note: `No vehicle matches "${wanted.trim()}". Known vehicles: ${known}.` };
  }
  const perVehicle = await Promise.all(chosen.map(async ({ v, technician }) => ({
    vehicle: v.nickname,
    technician,
    ...summarizeTrips(await bouncie.getTrips(v.id, date, date)),
  })));
  return {
    date,
    vehicles: perVehicle,
    total_miles: Number(perVehicle.reduce((sum, r) => sum + r.total_miles, 0).toFixed(1)),
    note: TRIPS_NOTE,
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
