// Zone-mark drift resolution (satellite coverage PR 3).
//
// The contract under test: stored geometry_image shapes re-anchor to the SAME
// GROUND POINT when the render center moves a little (re-geocode), and are
// dropped — not guessed at — when the imagery has materially changed (zoom
// mismatch, large drift, shifted out of frame). Marks with no ref (pre-drift
// era) and unknown legacy shapes pass through untouched.

const {
  resolveZoneImageShape,
  resolveZoneRowsImageDrift,
  MAX_DRIFT_FRACTION,
} = require('../services/service-report/zone-drift');
const { latLngToWebMercatorPoint } = require('../services/service-report/map-projection');

const WIDTH = 640;
const HEIGHT = 340;
const ZOOM = 20;
// Sarasota-ish anchor — real service-area latitude so mercator y math is honest.
const REF = { lat: 27.3364, lng: -82.5307 };

function ref(overrides = {}) {
  return {
    lat: REF.lat, lng: REF.lng, zoom: ZOOM, width: WIDTH, height: HEIGHT,
    capturedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function context(center, overrides = {}) {
  return { center, zoom: ZOOM, width: WIDTH, height: HEIGHT, ...overrides };
}

// The exact normalized shift the module should apply for a center move,
// computed from the same projection primitive (mirror math, not a copy of a
// hardcoded constant — if the formula's sign or scale regresses, these
// disagree with the hand-derived direction assertions below).
function expectedShift(curCenter) {
  const refPt = latLngToWebMercatorPoint(REF.lat, REF.lng);
  const curPt = latLngToWebMercatorPoint(curCenter.lat, curCenter.lng);
  const worldScale = 256 * (2 ** ZOOM);
  return {
    dx: ((refPt.x - curPt.x) * worldScale) / WIDTH,
    dy: ((refPt.y - curPt.y) * worldScale) / HEIGHT,
  };
}

// A longitude delta that produces a ~0.1-frame shift at zoom 20 (~8.6e-5°).
const SMALL_LNG_DELTA = (0.1 * WIDTH * 360) / (256 * (2 ** ZOOM));

test('mark with no ref passes through untouched (pre-drift-era)', () => {
  const shape = { type: 'rect', x: 0.2, y: 0.3, w: 0.1, h: 0.1 };
  expect(resolveZoneImageShape(shape, context(REF))).toBe(shape);
});

test('no render center passes through untouched', () => {
  const shape = { type: 'rect', x: 0.2, y: 0.3, w: 0.1, h: 0.1, ref: ref() };
  expect(resolveZoneImageShape(shape, {})).toBe(shape);
});

test('identical center → unchanged', () => {
  const shape = { type: 'rect', x: 0.2, y: 0.3, w: 0.1, h: 0.1, ref: ref() };
  expect(resolveZoneImageShape(shape, context({ ...REF }))).toBe(shape);
});

test('unknown legacy shape type passes through', () => {
  const shape = { type: 'points', points: [[0.1, 0.1], [0.2, 0.2]] };
  expect(resolveZoneImageShape(shape, context(REF))).toBe(shape);
});

test('small center move east shifts the rect WEST onto the same ground point', () => {
  const cur = { lat: REF.lat, lng: REF.lng + SMALL_LNG_DELTA };
  const shape = { type: 'rect', x: 0.4, y: 0.3, w: 0.2, h: 0.2, ref: ref() };
  const out = resolveZoneImageShape(shape, context(cur));
  const { dx } = expectedShift(cur);
  expect(dx).toBeLessThan(0); // center moved east → ground renders left
  expect(out.x).toBeCloseTo(0.4 + dx, 10);
  expect(out.y).toBeCloseTo(0.3, 10);
  expect(out.w).toBe(0.2);
  // the shifted coordinates anchor to the CURRENT image — the ref must say
  // so, or a preload round-trip would double-shift on the next render
  expect(out.ref).toMatchObject({ lat: cur.lat, lng: cur.lng, zoom: ZOOM, width: WIDTH, height: HEIGHT });
  expect(out.ref.capturedAt).toBe(shape.ref.capturedAt); // provenance untouched
});

test('small center move north shifts the circle DOWN (mercator y-down)', () => {
  const cur = { lat: REF.lat + 0.00005, lng: REF.lng };
  const shape = { type: 'circle', cx: 0.5, cy: 0.5, r: 0.06, ref: ref() };
  const out = resolveZoneImageShape(shape, context(cur));
  const { dy } = expectedShift(cur);
  expect(dy).toBeGreaterThan(0); // center moved north → ground renders lower
  expect(out.cy).toBeCloseTo(0.5 + dy, 10);
  expect(out.cx).toBeCloseTo(0.5, 10);
  expect(out.r).toBe(0.06);
});

test('accepts a JSON-string geometry_image', () => {
  const cur = { lat: REF.lat, lng: REF.lng + SMALL_LNG_DELTA };
  const raw = JSON.stringify({ type: 'rect', x: 0.4, y: 0.3, w: 0.2, h: 0.2, ref: ref() });
  const out = resolveZoneImageShape(raw, context(cur));
  expect(out.x).toBeCloseTo(0.4 + expectedShift(cur).dx, 10);
});

test('zoom mismatch → dropped (shifting cannot fix a rescale)', () => {
  const shape = { type: 'rect', x: 0.4, y: 0.3, w: 0.2, h: 0.2, ref: ref({ zoom: 19 }) };
  expect(resolveZoneImageShape(shape, context(REF))).toBeNull();
});

test('drift beyond MAX_DRIFT_FRACTION of the frame → dropped', () => {
  const bigDelta = (MAX_DRIFT_FRACTION * 1.2 * WIDTH * 360) / (256 * (2 ** ZOOM));
  const cur = { lat: REF.lat, lng: REF.lng + bigDelta };
  const shape = { type: 'rect', x: 0.4, y: 0.3, w: 0.2, h: 0.2, ref: ref() };
  expect(resolveZoneImageShape(shape, context(cur))).toBeNull();
});

test('shape shifted entirely out of frame → dropped', () => {
  // rect hugging the left edge, center moves east by ~0.2 of frame:
  // in-tolerance drift, but the whole rect leaves the image.
  const delta = (0.2 * WIDTH * 360) / (256 * (2 ** ZOOM));
  const cur = { lat: REF.lat, lng: REF.lng + delta };
  const shape = { type: 'rect', x: 0.01, y: 0.3, w: 0.05, h: 0.1, ref: ref() };
  expect(resolveZoneImageShape(shape, context(cur))).toBeNull();
});

test('partial overhang at the edge is CLIPPED into the frame (coords stay 0-1)', () => {
  // the viewer only treats geometry as normalized when every coordinate is
  // 0-1, and sanitizeZoneShape rejects out-of-range values on a re-save —
  // so the shifted rect must clip, never go negative
  const delta = (0.2 * WIDTH * 360) / (256 * (2 ** ZOOM));
  const cur = { lat: REF.lat, lng: REF.lng + delta };
  const shape = { type: 'rect', x: 0.1, y: 0.3, w: 0.2, h: 0.1, ref: ref() };
  const out = resolveZoneImageShape(shape, context(cur));
  const { dx } = expectedShift(cur); // ≈ -0.2 → raw x ≈ -0.1
  expect(out).not.toBeNull();
  expect(out.x).toBe(0); // clipped at the left edge
  expect(out.w).toBeCloseTo(0.1 + dx + 0.2, 10); // right edge minus the clip
  expect(out.w).toBeGreaterThan(0);
  expect(out.y).toBeCloseTo(0.3, 10);
});

test('rect reduced to a sliver by clipping is dropped', () => {
  // raw x ≈ -0.19, right edge ≈ 0.01 → clipped width ≈ 0.01 < minimum
  const delta = (0.2 * WIDTH * 360) / (256 * (2 ** ZOOM));
  const cur = { lat: REF.lat, lng: REF.lng + delta };
  const shape = { type: 'rect', x: 0.01, y: 0.3, w: 0.2, h: 0.1, ref: ref() };
  expect(resolveZoneImageShape(shape, context(cur))).toBeNull();
});

test('circle whose center leaves the frame is dropped (never out-of-range coords)', () => {
  const delta = (0.2 * WIDTH * 360) / (256 * (2 ** ZOOM));
  const cur = { lat: REF.lat, lng: REF.lng + delta };
  // cx 0.1 shifts to ≈ -0.1 → center out of frame
  const gone = { type: 'circle', cx: 0.1, cy: 0.5, r: 0.08, ref: ref() };
  expect(resolveZoneImageShape(gone, context(cur))).toBeNull();
  // cx 0.5 shifts to ≈ 0.3 → still in frame, r untouched
  const kept = resolveZoneImageShape({ type: 'circle', cx: 0.5, cy: 0.5, r: 0.08, ref: ref() }, context(cur));
  expect(kept.cx).toBeCloseTo(0.5 + expectedShift(cur).dx, 10);
  expect(kept.r).toBe(0.08);
});

test('rows helper: shifts marked rows, nulls untrusted marks, leaves the rest', () => {
  const cur = { lat: REF.lat, lng: REF.lng + SMALL_LNG_DELTA };
  const zones = [
    { id: 'a', label: 'Perimeter', geometry_image: { type: 'rect', x: 0.4, y: 0.3, w: 0.2, h: 0.2, ref: ref() } },
    { id: 'b', label: 'Lawn', geometry_image: { type: 'circle', cx: 0.5, cy: 0.5, r: 0.05, ref: ref({ zoom: 19 }) } },
    { id: 'c', label: 'Entry', geometry_image: null },
    { id: 'd', label: 'Garage', geometry_image: 'not-json{{' },
  ];
  const out = resolveZoneRowsImageDrift(zones, context(cur));
  expect(out[0].geometry_image.x).toBeCloseTo(0.4 + expectedShift(cur).dx, 10);
  expect(out[1].geometry_image).toBeNull(); // zoom mismatch → untrusted
  expect(out[2]).toBe(zones[2]); // unmarked row untouched
  expect(out[3]).toBe(zones[3]); // unparseable legacy value untouched
  expect(zones[0].geometry_image.x).toBe(0.4); // input rows never mutated
});

test('allOrNothing: one untrusted mark clears the whole set (report semantics)', () => {
  // the satellite overlay goes image-only once ANY zone keeps a mark and
  // drops the rest — a partial drop would publish a coverage map missing a
  // treated zone, so the report path clears everything → schematic fallback
  const cur = { lat: REF.lat, lng: REF.lng + SMALL_LNG_DELTA };
  const zones = [
    { id: 'a', label: 'Perimeter', geometry_image: { type: 'rect', x: 0.4, y: 0.3, w: 0.2, h: 0.2, ref: ref() } },
    { id: 'b', label: 'Lawn', geometry_image: { type: 'circle', cx: 0.5, cy: 0.5, r: 0.05, ref: ref({ zoom: 19 }) } },
    { id: 'c', label: 'Entry', geometry_image: null },
  ];
  const out = resolveZoneRowsImageDrift(zones, context(cur), { allOrNothing: true });
  expect(out[0].geometry_image).toBeNull(); // trusted mark cleared along with the set
  expect(out[1].geometry_image).toBeNull();
  expect(out[2]).toBe(zones[2]); // unmarked row untouched

  // with every mark trustworthy, allOrNothing changes nothing
  const healthy = resolveZoneRowsImageDrift([zones[0], zones[2]], context(cur), { allOrNothing: true });
  expect(healthy[0].geometry_image.x).toBeCloseTo(0.4 + expectedShift(cur).dx, 10);
});
