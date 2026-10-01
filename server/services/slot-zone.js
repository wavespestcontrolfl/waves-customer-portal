/**
 * Shared estimate → service-zone resolution for the slot offer/reserve pair.
 *
 * reserveSlot (slot-reservation.js) rejects a tap when an UNASSIGNED
 * scheduled service in the estimate's zone overlaps the requested window —
 * the zone is one capacity pool, so an estimate hold must not stack on top
 * of an unassigned self-booking. The slot generator
 * (estimate-slot-availability.js) has to apply the same exclusion when it
 * builds offers, or it keeps showing windows every tap on which 409s.
 * Both sides resolve the zone through THIS module so the two checks can't
 * drift apart again.
 *
 * Resolution order (unchanged from the original reserveSlot inline logic):
 *   1. Linked customer's city ↔ service_zones.cities (case-insensitive).
 *   2. Free-text estimate address contains any zone city (public estimates
 *      often have no customer row until acceptance creates one).
 * Returns the matching service_zones row or null. Throws on query failure —
 * callers decide how to degrade (both current callers log + proceed with
 * null rather than blocking the booking path).
 */

async function resolveEstimateZone(dbc, estimate) {
  if (!estimate) return null;
  const zones = await dbc('service_zones').select('id', 'cities', 'zone_name');
  let zone = null;
  // Customer-city resolution only applies when the estimate quotes the
  // customer's on-file address. A multi-property estimate keeps customer_id
  // while quoting a DIFFERENT address (codex #3244 r2) — resolving its zone
  // from the primary property's city would point the capacity check and
  // advisory lock at the wrong pool. Mirrors resolveEstimateCoords.
  if (estimate.customer_id) {
    const holder = await dbc('customers').where({ id: estimate.customer_id }).first('city', 'address_line1', 'address_line2', 'zip');
    // Full canonical tuple — mirrors resolveEstimateCoords (codex #3244 r8).
    const { estimateQuotesCustomerAddress } = require('./estimate-property-linkage');
    const quotesCustomerAddress = estimateQuotesCustomerAddress(estimate.address, holder || {});
    const holderCity = String(holder?.city || '').toLowerCase();
    if (quotesCustomerAddress && holderCity) {
      zone = zones.find((z) => (z.cities || []).some((c) => String(c).toLowerCase() === holderCity)) || null;
    }
  }
  if (!zone && estimate.address) {
    const addr = String(estimate.address).toLowerCase();
    zone = zones.find((z) => (z.cities || []).some((c) => c && addr.includes(String(c).toLowerCase()))) || null;
  }
  return zone;
}

// 'Sarasota / South' → 'sarasota' — the slug format scheduled_services.zone
// stores (availability.js writes it the same way for self-bookings).
function zoneSlugOf(zone) {
  return zone?.zone_name?.split('/')[0]?.trim()?.toLowerCase() || null;
}

// Coordinate-based zone resolution: the service_zones row whose CENTER is
// nearest (great-circle miles) to lat/lng, or null when none is within
// `maxMiles` (an address outside the service area belongs to no zone) or no
// zone row carries center coordinates. Resolution by coordinates rather than
// city text on purpose: 'North Venice', 'Northport' and the like are real
// customer addresses that are NOT in service_zones.cities, so a city scan
// would miss exactly the far-south addresses the zone route days serve.
// Approximate by design (nearest center, not a polygon — the table has no
// polygons); the consolidated Venice / North Port row and the retained Port
// Charlotte row both name the same south pool (see zone-day-funnel.js), so
// which of the two a far-south address lands on does not change the outcome
// for its callers. Throws on query failure — callers decide how to degrade.
const EARTH_RADIUS_MILES = 3958.8;
const DEFAULT_ZONE_RADIUS_MILES = 35;

function milesBetween(aLat, aLng, bLat, bLng) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Pure — exported for tests.
function nearestZoneByCoords(zones, lat, lng, { maxMiles = DEFAULT_ZONE_RADIUS_MILES } = {}) {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return null;
  let best = null;
  let bestMiles = Infinity;
  for (const zone of zones || []) {
    if (zone?.center_lat == null || zone?.center_lng == null) continue;
    const zLat = Number(zone.center_lat);
    const zLng = Number(zone.center_lng);
    if (!Number.isFinite(zLat) || !Number.isFinite(zLng)) continue;
    const miles = milesBetween(la, ln, zLat, zLng);
    if (miles < bestMiles) { best = zone; bestMiles = miles; }
  }
  return best && bestMiles <= maxMiles ? best : null;
}

async function resolveZoneByCoords(dbc, lat, lng, opts) {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return null;
  const zones = await dbc('service_zones').select('id', 'cities', 'zone_name', 'center_lat', 'center_lng');
  return nearestZoneByCoords(zones, la, ln, opts);
}

module.exports = { resolveEstimateZone, zoneSlugOf, resolveZoneByCoords, nearestZoneByCoords };
