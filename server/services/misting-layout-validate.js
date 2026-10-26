'use strict';

// Validation and normalization for a saved misting layout (GATE_MISTING_LAYOUT_DESIGNER, step 3).
//
// The layout JSON arrives from the staff designer and is stored, then printed on the estimate
// document, so everything is checked here: shapes, kinds, counts, coordinate ranges. The counts and
// the line length are derived from the geometry and never taken from the caller.
//
// Coordinates are in the Static Maps physical pixel space the Treatment Zone Mapper uses
// (client/src/components/tech/treatmentZoneSpray.js): 640x480 logical at scale 2 = 1280x960.

const MAP_WIDTH = 1280;
const MAP_HEIGHT = 960;
const MAP_SCALE = 2;
const MIN_ZOOM = 15;
const MAX_ZOOM = 22;

const MAX_LINES = 40;
const MAX_POINTS_PER_LINE = 300;
const MAX_TOTAL_POINTS = 2000;
const MAX_NOZZLES = 500;
const MAX_RISERS = 200;
const MAX_ZONES = 100;
const MAX_ZONE_RADIUS_FT = 100;
const MAX_ADDRESS = 300;
const MAX_ID = 40;

// Eave and fence lines carry nozzles. A bed line (a landscape bed edge) carries risers instead, placed by the designer about
// every 8 ft, so it never counts toward nozzles or the line length.
const NOZZLE_KINDS = Object.freeze(['eave', 'fence']);
const LINE_KINDS = Object.freeze(['eave', 'fence', 'bed']);
// A riser is either one staff dropped (manual) or one placed along a bed line (bed); reopening re-derives the second kind.
const RISER_SOURCES = Object.freeze(['bed', 'manual']);
// Same keys as client/src/lib/mistingLayoutExtras.js ZONE_KINDS.
const ZONE_KINDS = Object.freeze(['pool', 'water', 'door', 'dining', 'ac']);

function operationalError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.isOperational = true;
  return err;
}

const finite = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function asArray(value, label, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw operationalError(`${label} must be an array`);
  if (value.length > max) throw operationalError(`${label} cannot have more than ${max} entries`);
  return value;
}

// One map point. A tap can land a hair outside the frame, so 1 px of slack is allowed; anything
// further out is not a point on this map.
function point(p, label) {
  if (!p || typeof p !== 'object' || !finite(p.x) || !finite(p.y)) {
    throw operationalError(`${label} must have finite x and y`);
  }
  const x = Number(p.x);
  const y = Number(p.y);
  if (x < -1 || x > MAP_WIDTH + 1 || y < -1 || y > MAP_HEIGHT + 1) {
    throw operationalError(`${label} is outside the map`);
  }
  return { x: round2(clamp(x, 0, MAP_WIDTH)), y: round2(clamp(y, 0, MAP_HEIGHT)) };
}

function lineKind(kind, label, allowed = LINE_KINDS) {
  if (!allowed.includes(kind)) throw operationalError(`${label} kind must be ${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]}`);
  return kind;
}

function normalizeLines(raw) {
  let total = 0;
  return asArray(raw, 'lines', MAX_LINES).map((line, i) => {
    if (!line || typeof line !== 'object') throw operationalError(`lines[${i}] must be an object`);
    const points = asArray(line.points, `lines[${i}].points`, MAX_POINTS_PER_LINE);
    if (points.length < 2) throw operationalError(`lines[${i}] needs at least 2 points`);
    total += points.length;
    if (total > MAX_TOTAL_POINTS) throw operationalError(`lines cannot have more than ${MAX_TOTAL_POINTS} points in all`);
    return {
      id: String(line.id ?? i + 1).slice(0, MAX_ID),
      kind: lineKind(line.kind, `lines[${i}]`),
      points: points.map((p, j) => point(p, `lines[${i}].points[${j}]`)),
    };
  });
}

// Optional manual spray direction, a compass heading in degrees [0, 360). Absent or null means "use the default",
// which the screens derive; nothing else is accepted, so a stored aim is always a number a screen can draw.
function aimOf(n, label) {
  if (n.aim === undefined || n.aim === null) return {};
  const aim = Number(n.aim);
  if (!finite(n.aim) || aim < 0 || aim >= 360) throw operationalError(`${label} aim must be a heading from 0 up to 360 degrees`);
  return { aim: round2(aim) % 360 };
}

function normalizeNozzles(raw, lineCount) {
  const list = asArray(raw, 'nozzles', MAX_NOZZLES);
  if (list.length === 0) throw operationalError('A layout needs at least one nozzle');
  return list.map((n, i) => {
    const p = point(n, `nozzles[${i}]`);
    const kind = lineKind(n.kind, `nozzles[${i}]`, NOZZLE_KINDS);
    const idx = Number(n.lineIndex);
    const lineIndex = Number.isInteger(idx) && idx >= 0 && idx < lineCount ? idx : null;
    return { ...p, kind, lineIndex, ...aimOf(n, `nozzles[${i}]`) };
  });
}

function normalizeRisers(raw) {
  return asArray(raw, 'risers', MAX_RISERS).map((r, i) => {
    const p = point(r, `risers[${i}]`);
    if (r.source === undefined || r.source === null) return p;
    if (!RISER_SOURCES.includes(r.source)) throw operationalError(`risers[${i}] source must be bed or manual`);
    return { ...p, source: r.source };
  });
}

// The pump is required: the layout shows where the cabinet sits and how far it is from the lines.
function normalizePump(raw) {
  if (raw === undefined || raw === null) throw operationalError('A layout needs the pump placed');
  return point(raw, 'pump');
}

function normalizeZones(raw) {
  return asArray(raw, 'zones', MAX_ZONES).map((z, i) => {
    if (!z || typeof z !== 'object') throw operationalError(`zones[${i}] must be an object`);
    if (!ZONE_KINDS.includes(z.kind)) throw operationalError(`zones[${i}] kind is not a known no-mist kind`);
    if (!finite(z.radiusFt) || Number(z.radiusFt) <= 0 || Number(z.radiusFt) > MAX_ZONE_RADIUS_FT) {
      throw operationalError(`zones[${i}] radiusFt must be between 0 and ${MAX_ZONE_RADIUS_FT}`);
    }
    return { kind: z.kind, ...point(z, `zones[${i}]`), radiusFt: round2(z.radiusFt) };
  });
}

function normalizeMap(payload) {
  const lat = payload.center?.lat;
  const lng = payload.center?.lng;
  if (!finite(lat) || !finite(lng) || Math.abs(Number(lat)) > 90 || Math.abs(Number(lng)) > 180) {
    throw operationalError('center must have a latitude and longitude');
  }
  const zoom = Number(payload.zoom);
  if (!Number.isInteger(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) {
    throw operationalError(`zoom must be a whole number from ${MIN_ZOOM} to ${MAX_ZOOM}`);
  }
  if (Number(payload.mapWidth) !== MAP_WIDTH || Number(payload.mapHeight) !== MAP_HEIGHT) {
    throw operationalError(`The map must be ${MAP_WIDTH} by ${MAP_HEIGHT} pixels`);
  }
  return { centerLat: Number(lat), centerLng: Number(lng), zoom };
}

/** Feet on the ground per Static Maps physical pixel (scale 2) at this latitude and zoom. */
function feetPerPixel(lat, zoom) {
  const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / (2 ** zoom) / MAP_SCALE;
  return metersPerPixel * 3.28084;
}

function linearFeet(lines, lat, zoom) {
  let px = 0;
  lines.forEach((line) => {
    if (line.kind === 'bed') return; // a bed line is not eave or fence length
    for (let i = 1; i < line.points.length; i += 1) {
      px += Math.hypot(line.points[i].x - line.points[i - 1].x, line.points[i].y - line.points[i - 1].y);
    }
  });
  return Math.round(px * feetPerPixel(lat, zoom) * 10) / 10;
}

/**
 * @param {object} payload the parsed JSON part of the request
 * @returns the row fields to store (camelCase), with the counts and line length derived here
 * @throws an operational 400 error naming the first problem
 */
function validateLayoutPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw operationalError('payload must be a JSON object');
  }
  const map = normalizeMap(payload);
  const address = payload.address == null ? null : String(payload.address).trim().slice(0, MAX_ADDRESS) || null;
  const lines = normalizeLines(payload.lines);
  const nozzles = normalizeNozzles(payload.nozzles, lines.length);
  const risers = normalizeRisers(payload.risers);
  const pump = normalizePump(payload.pump);
  const zones = normalizeZones(payload.zones);
  const fence = nozzles.filter((n) => n.kind === 'fence').length;
  return {
    address,
    ...map,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    lines,
    nozzles,
    risers,
    pump,
    zones,
    nozzleCount: nozzles.length,
    eaveCount: nozzles.length - fence,
    fenceCount: fence,
    riserCount: risers.length,
    linearFt: linearFeet(lines, map.centerLat, map.zoom),
  };
}

// Lowercase, punctuation and spacing blind, with a recognized trailing ZIP (5 or 5+4) and then a trailing state
// (FL or Florida) taken off. Nothing else is trimmed: a street suffix, direction or unit stays part of the key.
const addressKey = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/ \d{5}(?: \d{4})?$/, '')
  .replace(/ (?:fl|florida)$/, '');

/**
 * Is the layout's address the estimate's address? Compared case, spacing and punctuation blind and ignoring a
 * trailing Florida ZIP or state; everything else must match exactly, so a changed house number, street, direction,
 * unit or city is a different property. When either side has no address nothing can be judged and the answer is
 * yes. Same rule as the designer client (client/src/lib/mistingLayoutPersist.js savedLayoutIsForOtherAddress).
 */
function sameProperty(layoutAddress, estimateAddress) {
  const a = addressKey(layoutAddress);
  const b = addressKey(estimateAddress);
  if (!a || !b) return true;
  return a === b;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True when the buffer starts with the PNG signature. The multipart mimetype is caller-supplied, so this checks the bytes. */
function looksLikePng(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);
}

module.exports = {
  MAP_WIDTH,
  MAP_HEIGHT,
  LINE_KINDS,
  ZONE_KINDS,
  MAX_NOZZLES,
  validateLayoutPayload,
  looksLikePng,
  sameProperty,
  operationalError,
  feetPerPixel,
};
