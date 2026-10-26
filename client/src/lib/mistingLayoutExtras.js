// Misting layout designer, step 2 (GATE_MISTING_LAYOUT_DESIGNER): risers, the pump and no-mist zones.
//
// React-free and DOM-free. All of these are independent points on the map. They do not sit on the
// drawn lines, so re-placing the nozzles never moves or removes them, and Edit nozzles never touches them.
//
//   riser   a copper landscape riser in a bed. Any number. { key, x, y }
//   pump    exactly one, or none. { x, y }. The state holds one slot, so a second pump cannot exist.
//   zone    a circle the mist must avoid. { key, kind, x, y, radiusFt }. The radius is kept in feet
//           and turned into map pixels only when drawn or hit-tested, so it stays right for the
//           map zoom the photo was loaded at.
//
// A nozzle or riser is "in" a zone when its distance to the zone center is LESS than the radius.
// A point exactly on the boundary is out. The flag is derived (flagInZones) and never stored,
// so it follows every move, add, delete and zone change.
import { MAP_HEIGHT, MAP_WIDTH, pxToFeet } from '../components/tech/treatmentZoneSpray';

export const ZONE_KINDS = Object.freeze([
  { key: 'pool', label: 'Pool', radiusFt: 15 },
  { key: 'water', label: 'Water', radiusFt: 15 },
  { key: 'door', label: 'Door/window', radiusFt: 8 },
  { key: 'dining', label: 'Dining/grill', radiusFt: 8 },
  { key: 'ac', label: 'AC intake', radiusFt: 8 },
]);
export const DEFAULT_ZONE_KIND = 'pool';

// Rounding slack for "exactly on the boundary", in feet. Far below anything a tap can express.
const BOUNDARY_EPS_FT = 1e-6;
const EPS_PX = 1e-9;

export const NO_EXTRAS = Object.freeze({ risers: [], pump: null, zones: [] });

export const extrasCount = (e) => e.risers.length + (e.pump ? 1 : 0) + e.zones.length;

export function zoneKindDef(kind) {
  return ZONE_KINDS.find((k) => k.key === kind) || ZONE_KINDS[0];
}

export const feetToPx = (ft, lat, zoom) => ft / pxToFeet(1, lat, zoom);

export function clampToMap(p) {
  return { x: Math.max(0, Math.min(MAP_WIDTH, p.x)), y: Math.max(0, Math.min(MAP_HEIGHT, p.y)) };
}

const without = (list, key) => list.filter((item) => item.key !== key);

// ── Risers ───────────────────────────────────────────────────────────────────
export function addRiser(extras, key, p) {
  return { ...extras, risers: [...extras.risers, { key, ...clampToMap(p) }] };
}

// The moved riser goes last, so it is the first one a tap selects when two overlap (newest wins).
export function moveRiser(extras, key, p) {
  const current = extras.risers.find((r) => r.key === key);
  if (!current) return extras;
  return { ...extras, risers: [...without(extras.risers, key), { key, ...clampToMap(p) }] };
}

export function deleteRiser(extras, key) {
  return { ...extras, risers: without(extras.risers, key) };
}

// ── Pump ─────────────────────────────────────────────────────────────────────
/** Place the pump, or move it if there is one. There is never more than one. */
export function setPump(extras, p) {
  return { ...extras, pump: clampToMap(p) };
}

// ── Zones ────────────────────────────────────────────────────────────────────
export function addZone(extras, key, kind, p) {
  const def = zoneKindDef(kind);
  return { ...extras, zones: [...extras.zones, { key, kind: def.key, radiusFt: def.radiusFt, ...clampToMap(p) }] };
}

export function deleteZone(extras, key) {
  return { ...extras, zones: without(extras.zones, key) };
}

/** Index of the zone a tap at `p` is inside (newest first on overlap), or -1. */
export function hitZoneIndex(zones, p, lat, zoom) {
  let hit = -1;
  (zones || []).forEach((z, i) => {
    if (Math.hypot(z.x - p.x, z.y - p.y) <= feetToPx(z.radiusFt, lat, zoom) + EPS_PX) hit = i;
  });
  return hit;
}

// ── Flags ────────────────────────────────────────────────────────────────────
const feetBetween = (a, b, lat, zoom) => pxToFeet(Math.hypot(a.x - b.x, a.y - b.y), lat, zoom);

/** True when `point` is strictly inside any zone (distance to the center < the radius, in feet). */
export function insideAnyZone(point, zones, lat, zoom) {
  return (zones || []).some((z) => feetBetween(point, z, lat, zoom) < z.radiusFt - BOUNDARY_EPS_FT);
}

/** Set of `key`s of the points (nozzles or risers) that sit inside a no-mist zone. */
export function flagInZones(points, zones, lat, zoom) {
  const flagged = new Set();
  if (!zones || zones.length === 0) return flagged;
  (points || []).forEach((p) => {
    if (insideAnyZone(p, zones, lat, zoom)) flagged.add(p.key);
  });
  return flagged;
}
