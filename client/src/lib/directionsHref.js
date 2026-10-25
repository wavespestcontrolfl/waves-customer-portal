// The Google Maps directions link behind every Directions / address tap on a
// visit (tech field screens, the Fast Complete sheets, the schedule's day
// card and the mobile dispatch list), so they can never drift apart.
//
// Google Maps picks a gated community's entrance from the house address and
// often sends a visitor to a resident-only gate. When the day feed carries
// the neighborhood's main gate (`gateWaypoint`, set once by the office on the
// Gate codes page), the gate goes in as the one stop before the house, so the
// same tap routes through the right gate. No gate = the plain address link.
const BASE = 'https://www.google.com/maps/dir/?api=1';

function coordinate(value, limit) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

export function directionsHref(address, gateWaypoint = null) {
  const lat = coordinate(gateWaypoint?.lat, 90);
  const lng = coordinate(gateWaypoint?.lng, 180);
  const waypoint = lat !== null && lng !== null ? `&waypoints=${encodeURIComponent(`${lat},${lng}`)}` : '';
  return `${BASE}&destination=${encodeURIComponent(address || '')}${waypoint}&travelmode=driving`;
}
