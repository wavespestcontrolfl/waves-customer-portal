// Zone-mark drift resolution (satellite coverage PR 3).
//
// Technician satellite marks (property_zones.geometry_image) are drawn
// against a specific image: the shape's `ref` block records the center
// lat/lng, zoom, and viewport it was captured against. When the property is
// later re-geocoded (address correction) the render-time center moves under
// the stored shapes — every mark would paint the wrong spot on the new
// imagery. This module re-anchors marks at render time:
//
//  - same zoom, small center delta  → shift the shape by the world-pixel
//    offset (web-mercator), so it stays on the same GROUND point;
//  - zoom change, large delta, or a shape shifted out of frame → the mark is
//    unreliable against today's imagery: drop it (callers fall back to the
//    schematic map / redraw flows);
//  - no ref at all (pre-drift-era mark) or no render center → trust as-is,
//    exactly the pre-PR-3 behavior.
//
// The resolver runs ONCE per zone (report-data resolves right after loading
// property_zones; the capture-UI's property-map endpoint resolves preloads),
// so every downstream consumer — coverage items, satellite overlay, marking
// preloads — sees one consistent answer.

const { latLngToWebMercatorPoint } = require('./map-projection');

// Beyond a quarter of the frame the "same ground point" correction is doing
// more harm than good (the imagery framing has materially changed) — drop.
const MAX_DRIFT_FRACTION = 0.25;

// Clipped rects thinner than this are noise, not a mark (matches the capture
// UI's minimum drag size).
const MIN_CLIPPED_SIZE = 0.02;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseShape(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Shifts a shape and CLIPS it to the 0-1 frame. Coordinates must stay in
// range: the report viewer only treats geometry as normalized when every
// coordinate is within 0-1, and the save path (sanitizeZoneShape) rejects
// out-of-range values — an unclipped partial overhang would render at an
// arbitrary extent and 400 on a preload confirm.
function shiftedInFrame(shape, dx, dy) {
  if (shape.type === 'rect') {
    const x = num(shape.x) + dx;
    const y = num(shape.y) + dy;
    const w = num(shape.w);
    const h = num(shape.h);
    // fully in frame → pure shift, size untouched (no float churn)
    if (x >= 0 && y >= 0 && x + w <= 1 && y + h <= 1) return { ...shape, x, y };
    const clippedX = Math.max(0, x);
    const clippedY = Math.max(0, y);
    const clippedW = Math.min(1, x + w) - clippedX;
    const clippedH = Math.min(1, y + h) - clippedY;
    // a sliver left at the edge is noise, not a mark
    if (clippedW < MIN_CLIPPED_SIZE || clippedH < MIN_CLIPPED_SIZE) return null;
    return { ...shape, x: clippedX, y: clippedY, w: clippedW, h: clippedH };
  }
  // circles keep their radius (it states the treated size) — once the CENTER
  // leaves the frame the mark no longer points at ground in this image, drop
  const cx = num(shape.cx) + dx;
  const cy = num(shape.cy) + dy;
  if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return null;
  return { ...shape, cx, cy };
}

/**
 * Re-anchors a stored geometry_image shape against the render-time image.
 *
 * @param {object|string} rawShape  stored geometry_image (object or JSON)
 * @param {object} imageContext     { center: {lat,lng}, zoom, width, height }
 * @returns {object|null} the shape to render (possibly shifted), or null
 *          when the mark can't be trusted against today's imagery
 */
function resolveZoneImageShape(rawShape, { center, zoom, width = 640, height = 340 } = {}) {
  const shape = parseShape(rawShape);
  if (!shape || Object.keys(shape).length === 0) return null;
  // unknown legacy shape formats pass through untouched — this module only
  // understands the rect/circle capture contract
  if (shape.type !== 'rect' && shape.type !== 'circle') return shape;

  const ref = shape.ref && typeof shape.ref === 'object' ? shape.ref : null;
  const refLat = ref ? num(ref.lat) : null;
  const refLng = ref ? num(ref.lng) : null;
  if (refLat == null || refLng == null) return shape; // pre-drift-era mark
  const curLat = center ? num(center.lat) : null;
  const curLng = center ? num(center.lng) : null;
  if (curLat == null || curLng == null) return shape; // no render context

  const curZoom = num(zoom);
  const refZoom = num(ref.zoom);
  // a zoom change rescales the ground-per-pixel ratio — shifting alone can't
  // fix that, and resizing marks silently would misstate treated areas
  if (refZoom != null && curZoom != null && refZoom !== curZoom) return null;

  const effZoom = curZoom ?? refZoom ?? 20;
  const refPt = latLngToWebMercatorPoint(refLat, refLng);
  const curPt = latLngToWebMercatorPoint(curLat, curLng);
  const worldScale = 256 * (2 ** effZoom);
  // ground point G renders at p = 0.5 + (world(G) - world(center)) / viewport,
  // so moving the center from ref to cur shifts every stored position by
  // (world(refCenter) - world(curCenter)) / viewport
  const dx = ((refPt.x - curPt.x) * worldScale) / (num(ref.width) || width);
  const dy = ((refPt.y - curPt.y) * worldScale) / (num(ref.height) || height);

  if (dx === 0 && dy === 0) return shape;
  if (Math.abs(dx) > MAX_DRIFT_FRACTION || Math.abs(dy) > MAX_DRIFT_FRACTION) return null;
  const shifted = shiftedInFrame(shape, dx, dy);
  if (!shifted) return null;
  // The shifted coordinates are anchored to the CURRENT image, so the ref
  // must say so — otherwise a consumer that round-trips the shape back into
  // the DB (preload → save without redraw) would store shifted coordinates
  // with the stale ref, and the next render would apply the same correction
  // again. capturedAt stays: it is provenance of the drawing, not the anchor.
  return {
    ...shifted,
    ref: {
      ...shifted.ref,
      lat: curLat,
      lng: curLng,
      zoom: effZoom,
      width,
      height,
    },
  };
}

/**
 * Resolves geometry_image drift for a list of property_zones rows against
 * the render-time image context. Returns row copies: shifted shapes replace
 * the stored ones; untrusted marks are removed (geometry_image: null) so
 * every consumer falls back the same way.
 *
 * options.allOrNothing — when true, ONE untrusted mark clears EVERY mark in
 * the set. The report's satellite overlay switches to image-only mode the
 * moment any zone carries geometry_image and drops the rest, so a partial
 * drop would silently omit a treated zone from the coverage map; clearing
 * the whole set sends the report to the schematic fallback instead. The
 * capture-UI preload keeps the default per-zone behavior on purpose — there
 * a dropped mark just asks the tech to redraw that one zone, and the
 * completion submit's own all-marked gate handles completeness.
 */
function resolveZoneRowsImageDrift(zones = [], imageContext = {}, { allOrNothing = false } = {}) {
  let anyDropped = false;
  const resolvedRows = zones.map((zone) => {
    const stored = parseShape(zone.geometry_image);
    if (!stored || Object.keys(stored).length === 0) return zone;
    const resolved = resolveZoneImageShape(stored, imageContext);
    if (resolved === stored) return zone;
    if (resolved === null) anyDropped = true;
    return { ...zone, geometry_image: resolved };
  });
  if (allOrNothing && anyDropped) {
    return resolvedRows.map((zone) => (zone.geometry_image ? { ...zone, geometry_image: null } : zone));
  }
  return resolvedRows;
}

module.exports = {
  resolveZoneImageShape,
  resolveZoneRowsImageDrift,
  MAX_DRIFT_FRACTION,
};
