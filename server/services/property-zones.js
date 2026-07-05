// Property zones — the customer-scoped map layer behind satellite-accurate
// Service Coverage (owner-approved lane 2026-07-05).
//
// Zones live in `property_zones` (one row per named area of a property,
// unique letter per customer). The report builder prefers these rows over its
// fabricated `defaultZones` the moment ANY active row exists for the customer
// (report-data.js), so this module follows one hard rule: once a property has
// zone rows, EVERY completion keeps them label-synced with the technician's
// chipped areas — a chipped area without a matching row would silently vanish
// from the report's coverage list.
//
// To keep production behavior unchanged until a tech actually marks a map,
// nothing is written for customers with no zone rows AND no incoming shapes:
// their reports keep today's schematic defaults indefinitely.
//
// `geometry_image` stores the technician's satellite mark as a LOCAL SHAPE
// object (NOT GeoJSON — satellite-treatment-map's normalizeRectGeometry only
// understands rect/circle/points shapes), coordinates normalized 0-1 against
// the 640×340 satellite image (top-left origin):
//   { type: 'rect',   x, y, w, h, ref: { lat, lng, zoom, width, height, capturedAt } }
//   { type: 'circle', cx, cy, r, ref: { ... } }
// Circle radius normalizes against the SHORT side (r = px / 340) because
// normalizeRectGeometry scales r × min(width, height). `ref` records the
// image parameters the shape was drawn against so a future geocode or zoom
// change is detectable; both render consumers ignore it.

// The two status chips in AREAS_BY_SERVICE.universal are visit outcomes, not
// places — they must never become zone rows even if a stale client sends them.
// Entries are in normalizeZoneLabel's output space (lowercase, punctuation →
// spaces): 'Follow-up recommended' normalizes to 'follow up recommended'.
const NON_SPATIAL_CHIP_KEYS = new Set(['no issues found', 'follow up recommended']);

const MAX_ZONE_SHAPES_PER_COMPLETION = 30;

// Mirrors report-data.js zoneGeometryForIndex so the schematic (and PDF)
// treatment map draws freshly-created rows exactly where the default zones
// would have been.
const SCHEMATIC_ZONE_RECTS = [
  { x: 64, y: 42, w: 512, h: 46 },
  { x: 64, y: 250, w: 512, h: 46 },
  { x: 64, y: 88, w: 48, h: 162 },
  { x: 528, y: 88, w: 48, h: 162 },
  { x: 232, y: 210, w: 180, h: 58 },
  { x: 416, y: 212, w: 72, h: 92 },
];

function normalizeZoneLabel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Same vocabulary service-coverage.js areaKey uses, so category-driven copy
// and the perimeter-line heuristics keep working against authored rows.
function categoryForLabel(label) {
  const text = normalizeZoneLabel(label);
  if (/\b(entry|door|window|threshold|opening|access point)\b/.test(text)) return 'entry_points';
  if (/\b(perimeter|foundation|exterior|fence|fenceline)\b/.test(text)) return 'perimeter';
  if (/\b(station|bait)\b/.test(text)) return 'station';
  if (/\b(turf|yard|lawn)\b/.test(text)) return 'lawn';
  if (/\b(plant|shrub|tree|palm|hedge|landscape)\b/.test(text)) return 'plant';
  if (/\b(kitchen|bath|bathroom|garage|interior|attic|lanai|trash)\b/.test(text)) return 'interior';
  return 'generic';
}

function isFiniteInRange(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max;
}

// Validates and whitelists an incoming shape. Returns the sanitized object to
// persist, or null when the shape is malformed. Coordinates must be
// normalized 0-1 (the capture UI's contract) — pixel-space values are
// rejected rather than guessed at.
function sanitizeZoneShape(shape = {}) {
  if (!shape || typeof shape !== 'object') return null;
  const type = shape.type === 'circle' ? 'circle' : (shape.type === 'rect' ? 'rect' : null);
  if (!type) return null;
  let out = null;
  if (type === 'rect') {
    if (!isFiniteInRange(shape.x, 0, 1) || !isFiniteInRange(shape.y, 0, 1)
      || !isFiniteInRange(shape.w, 0, 1) || !isFiniteInRange(shape.h, 0, 1)
      || Number(shape.w) <= 0 || Number(shape.h) <= 0) return null;
    out = { type, x: Number(shape.x), y: Number(shape.y), w: Number(shape.w), h: Number(shape.h) };
  } else {
    if (!isFiniteInRange(shape.cx, 0, 1) || !isFiniteInRange(shape.cy, 0, 1)
      || !isFiniteInRange(shape.r, 0, 1) || Number(shape.r) <= 0) return null;
    out = { type, cx: Number(shape.cx), cy: Number(shape.cy), r: Number(shape.r) };
  }
  const ref = shape.ref && typeof shape.ref === 'object' ? shape.ref : null;
  if (ref && Number.isFinite(Number(ref.lat)) && Number.isFinite(Number(ref.lng))) {
    out.ref = {
      lat: Number(ref.lat),
      lng: Number(ref.lng),
      zoom: Number.isFinite(Number(ref.zoom)) ? Number(ref.zoom) : null,
      width: Number.isFinite(Number(ref.width)) ? Number(ref.width) : 640,
      height: Number.isFinite(Number(ref.height)) ? Number(ref.height) : 340,
      capturedAt: typeof ref.capturedAt === 'string' ? ref.capturedAt.slice(0, 40) : new Date().toISOString(),
    };
  }
  return out;
}

function parseServiceLines(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean) : [];
    } catch { return []; }
  }
  return [];
}

// A-Z allocator that respects the (customer_id, letter) unique constraint.
function makeLetterAllocator(existingZones) {
  const used = new Set(existingZones.map((zone) => String(zone.letter || '').toUpperCase()));
  return () => {
    for (let i = 0; i < 26; i += 1) {
      const letter = String.fromCharCode(65 + i);
      if (!used.has(letter)) {
        used.add(letter);
        return letter;
      }
    }
    return null; // 26 zones on one property — skip creation, never throw
  };
}

/**
 * Keeps a customer's property_zones in sync with a completion.
 *
 * @param {object} trx        knex transaction (or knex instance)
 * @param {object} args
 * @param {string} args.customerId
 * @param {string} args.serviceLine   detected line for this visit ('pest', 'lawn', ...)
 * @param {string[]} args.areaLabels  the technician's chipped areas (raw labels)
 * @param {Array}  args.zoneShapes    [{ areaLabel, shape }] satellite marks and/or
 *                                    [{ areaLabel, clear: true }] mark removals (may be empty)
 * @returns {{ created: number, updated: number, shapesApplied: number, cleared: number, skipped: string[] }}
 */
async function upsertZonesForCompletion(trx, {
  customerId,
  serviceLine = null,
  areaLabels = [],
  zoneShapes = [],
} = {}) {
  const summary = { created: 0, updated: 0, shapesApplied: 0, cleared: 0, skipped: [] };
  if (!customerId) return summary;

  const spatialLabels = [];
  const seenLabels = new Set();
  for (const raw of Array.isArray(areaLabels) ? areaLabels : []) {
    const key = normalizeZoneLabel(raw);
    if (!key || NON_SPATIAL_CHIP_KEYS.has(key) || seenLabels.has(key)) continue;
    seenLabels.add(key);
    spatialLabels.push({ key, label: String(raw).trim() });
  }

  // Entries split into shape WRITES and CLEARS ({ areaLabel, clear: true } —
  // the tech removed a previously-stored mark). Clears never create rows and
  // never count toward the prod guard: they only null geometry_image on a
  // row that already exists.
  const incomingShapes = [];
  const incomingClears = [];
  for (const entry of (Array.isArray(zoneShapes) ? zoneShapes : []).slice(0, MAX_ZONE_SHAPES_PER_COMPLETION)) {
    const key = normalizeZoneLabel(entry?.areaLabel);
    const rawLabel = String(entry?.areaLabel || '').trim();
    if (!key || NON_SPATIAL_CHIP_KEYS.has(key)) continue;
    if (entry?.clear === true) {
      incomingClears.push({ key, rawLabel });
      continue;
    }
    const shape = sanitizeZoneShape(entry?.shape);
    if (!shape) {
      summary.skipped.push(rawLabel || 'invalid-shape');
      continue;
    }
    incomingShapes.push({ key, shape, rawLabel });
  }

  const existing = await trx('property_zones')
    .where({ customer_id: customerId, is_active: true })
    .orderBy('letter');

  // Prod-behavior guard: a property with no rows and no marks stays on the
  // report builder's defaultZones path — writing rows here without any shape
  // would flip every completed property's report off the schematic defaults
  // for zero satellite benefit.
  if (!existing.length && !incomingShapes.length) return summary;

  const byLabel = new Map(existing.map((zone) => [normalizeZoneLabel(zone.label), zone]));
  const nextLetter = makeLetterAllocator(existing);
  const line = String(serviceLine || '').trim().toLowerCase() || null;

  // Every chipped spatial area gets a row (create or line-tag update) — see
  // module header for why this is mandatory once any row exists. Shaped areas
  // that weren't chipped (defensive; the UI derives shapes from chips) get
  // rows too so their marks aren't orphaned.
  const labelsNeedingRows = [...spatialLabels];
  for (const entry of incomingShapes) {
    if (!seenLabels.has(entry.key)) {
      seenLabels.add(entry.key);
      labelsNeedingRows.push({ key: entry.key, label: entry.rawLabel });
    }
  }

  for (let i = 0; i < labelsNeedingRows.length; i += 1) {
    const { key, label } = labelsNeedingRows[i];
    const match = byLabel.get(key);
    if (match) {
      const lines = parseServiceLines(match.service_lines);
      if (line && lines.length && !lines.includes(line)) {
        await trx('property_zones')
          .where({ id: match.id })
          .update({ service_lines: [...lines, line], updated_at: trx.fn.now() });
        summary.updated += 1;
      }
      continue;
    }
    const letter = nextLetter();
    if (!letter) {
      summary.skipped.push(label);
      continue;
    }
    const [created] = await trx('property_zones')
      .insert({
        customer_id: customerId,
        letter,
        label,
        category: categoryForLabel(label),
        geometry: JSON.stringify(SCHEMATIC_ZONE_RECTS[i % SCHEMATIC_ZONE_RECTS.length]),
        service_lines: line ? [line] : [],
      })
      .returning('*');
    summary.created += 1;
    if (created) byLabel.set(key, created);
  }

  for (const entry of incomingShapes) {
    const zone = byLabel.get(entry.key);
    if (!zone || !zone.id) {
      summary.skipped.push(entry.rawLabel);
      continue;
    }
    await trx('property_zones')
      .where({ id: zone.id })
      .update({ geometry_image: JSON.stringify(entry.shape), updated_at: trx.fn.now() });
    summary.shapesApplied += 1;
  }

  for (const entry of incomingClears) {
    const zone = byLabel.get(entry.key);
    if (!zone || !zone.id) {
      // nothing stored under that label — a clear with no target is a no-op,
      // not an error (the row may have been deactivated since preload)
      summary.skipped.push(entry.rawLabel);
      continue;
    }
    await trx('property_zones')
      .where({ id: zone.id })
      .update({ geometry_image: null, updated_at: trx.fn.now() });
    summary.cleared += 1;
  }

  return summary;
}

// Route-level validation for the completion body's zoneShapes payload.
// Returns an error string (400 material) or null when acceptable.
function validateZoneShapesBody(zoneShapes) {
  if (zoneShapes == null) return null;
  if (!Array.isArray(zoneShapes)) return 'zoneShapes must be an array';
  if (zoneShapes.length > MAX_ZONE_SHAPES_PER_COMPLETION) {
    return `zoneShapes supports at most ${MAX_ZONE_SHAPES_PER_COMPLETION} entries`;
  }
  for (const entry of zoneShapes) {
    if (!entry || typeof entry !== 'object' || typeof entry.areaLabel !== 'string' || !entry.areaLabel.trim()) {
      return 'each zoneShapes entry needs an areaLabel string and a shape object';
    }
    // { areaLabel, clear: true } removes a stored mark — no shape allowed.
    if (entry.clear === true) {
      if (entry.shape != null) {
        return `zoneShapes entry "${entry.areaLabel.trim()}" sets clear alongside a shape — send one or the other`;
      }
      continue;
    }
    // A malformed shape must 400 here, not silently drop in the upsert: on a
    // first-marked property the prod guard writes nothing, so a silent skip
    // would lose the tech's drawing behind a successful completion.
    if (!sanitizeZoneShape(entry.shape)) {
      return `zoneShapes entry "${entry.areaLabel.trim()}" has a malformed shape — expected a rect or circle with coordinates normalized 0-1`;
    }
  }
  return null;
}

module.exports = {
  upsertZonesForCompletion,
  validateZoneShapesBody,
  sanitizeZoneShape,
  categoryForLabel,
  normalizeZoneLabel,
  MAX_ZONE_SHAPES_PER_COMPLETION,
  _internal: { makeLetterAllocator, parseServiceLines },
};
