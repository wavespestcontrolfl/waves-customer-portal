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
    const holder = await dbc('customers').where({ id: estimate.customer_id }).first('city', 'address_line1');
    const normalize = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const estimateAddress = normalize(estimate.address);
    const customerStreet = normalize(holder?.address_line1);
    const quotesCustomerAddress = !estimateAddress
      || (!!customerStreet && estimateAddress.startsWith(customerStreet));
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

module.exports = { resolveEstimateZone, zoneSlugOf };
