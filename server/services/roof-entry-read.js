'use strict';

/**
 * Staff roof read (GATE_ROOF_ENTRY_READ, owner 2026-11-19). From a free county aerial photo of the home, ONE vision
 * call flags which rodent entry-point types the roof likely has, so the technician knows where to look and the
 * estimate is not short. Staff only; nothing here reaches a customer. Every read is a paid model call, so:
 *   - a stored read of the same property is reused for 90 days (no new call);
 *   - an unknown county or a failed image fetch is { status: 'no_image' } and makes NO model call;
 *   - the model gets one call (no validator-driven retry on a second provider): an answer that fails the strict
 *     schema is stored with tier 'unknown' and no pins, and is never reused.
 * The model gives yes / no / unsure per entry type and up to 6 pins as 0-1 image fractions. It is never asked to
 * count: vision models count poorly, and the technician's own count (saveTechCount) is the ground truth.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');
const llmCost = require('./llm-cost');

const TABLE = 'roof_entry_reads';
const REUSE_DAYS = 90;
const CROP_METERS = 60;
const FETCH_TIMEOUT_MS = 15000;
const MODEL_TIMEOUT_MS = 60000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PINS = 6;

// Free public county imagery, no key, no paid source. Each service answers an ArcGIS export request for a bounding
// box; the three were read with a plain GET on 2026-11-19 (a 60 m crop came back as a JPEG).
//   manatee   ImageServer  2025 RGB, 7.6 cm, flown 2024-12-13 to 2025-01-25. The county's Imagery Downloader page,
//             https://www.mymanatee.org/gisapps/gis/clipzipship/index.html, lists the service URLs.
//   sarasota  ImageServer  2025 natural colour, 3-inch, flown 2024-12-06 to 2025-01-03. Service directory:
//             https://srqgis.sarasotafl.gov/server/rest/services
//   charlotte MapServer    2026 county aerials, about 13 cm. Service directory (folder Aerials):
//             https://agis.charlottecountyfl.gov/arcgis/rest/services/Aerials
// resolutionM sizes the returned picture so a pixel is about one source pixel (no empty upscaling).
const IMAGE_SOURCES = Object.freeze({
  manatee: Object.freeze({
    source: 'manatee_2025_rgb', year: 2025, resolutionM: 0.076,
    exportUrl: 'https://www.mymanatee.org/gisimg/rest/services/2025/AERIAL_2025_RGB/ImageServer/exportImage',
  }),
  sarasota: Object.freeze({
    source: 'sarasota_2025_3in', year: 2025, resolutionM: 0.076,
    exportUrl: 'https://srqgis.sarasotafl.gov/server/rest/services/Aerials_COS_2025/ImageServer/exportImage',
  }),
  charlotte: Object.freeze({
    source: 'charlotte_2026', year: 2026, resolutionM: 0.13,
    exportUrl: 'https://agis.charlottecountyfl.gov/arcgis/rest/services/Aerials/Aerials2026/MapServer/export',
  }),
});

// Spend estimate when the model's per-token price is not in llm_model_prices (the weekly OpenRouter pull; prices are
// never hand-typed, config/models.js). One 800 px image plus the prompt and a short JSON answer is a few cents at
// most on the vision models, so an unpriced read is booked at this ceiling instead of at zero.
const FALLBACK_COST_CENTS = 5;

const ENTRY_TYPES = Object.freeze([
  'roof_returns_and_valleys',
  'plumbing_vent_stacks',
  'roof_vents_or_turbines',
  'chimney_or_flue',
  'ac_or_utility_line_entry',
  'soffit_or_fascia_gaps',
  'gable_vents',
  'trees_touching_roof',
  'tile_eave_open_ends',
]);
const LIKELY = Object.freeze(['yes', 'no', 'unsure']);
const TIERS = Object.freeze(['low', 'med', 'high']);
const TIER_UNKNOWN = 'unknown';

const PIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } },
  required: ['x', 'y'],
};
const TYPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    likely: { type: 'string', enum: [...LIKELY] },
    pins: { type: 'array', items: PIN_SCHEMA, maxItems: MAX_PINS },
  },
  required: ['likely', 'pins'],
};
const READ_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    flags: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(ENTRY_TYPES.map((t) => [t, TYPE_SCHEMA])),
      required: [...ENTRY_TYPES],
    },
    tier: { type: 'string', enum: [...TIERS] },
  },
  required: ['flags', 'tier'],
};

const PROMPT = `This is a top-down aerial photo, about ${CROP_METERS} metres across, north up, centred on a home in Southwest Florida. A pest control technician will use your answer to decide where to look for rodent entry points on the ROOF of the home at the centre of the picture. Ignore neighbouring buildings.

For each entry-point type below, answer "yes" when you can see it, "no" when that part of the roof is clearly visible and it is not there, and "unsure" when it cannot be judged from above (soffits, fascia and gable vents are often hidden from overhead: answer "unsure", never guess).
Types: ${ENTRY_TYPES.join(', ')}.
- roof_returns_and_valleys: places where roof planes meet at an angle (returns, valleys, dormer joins).
- plumbing_vent_stacks: round pipes poking through the roof.
- roof_vents_or_turbines: box vents, ridge vents, turbines, exhaust caps.
- chimney_or_flue: chimneys and metal flues.
- ac_or_utility_line_entry: where wires, conduit or refrigerant lines reach the roof or eave.
- soffit_or_fascia_gaps: visible gaps or damage along the eaves.
- gable_vents: triangular end-wall vents.
- trees_touching_roof: branches that touch or overhang the roof.
- tile_eave_open_ends: barrel or S-tile roofs with open tile ends at the eave.

For every type give "pins": up to ${MAX_PINS} points marking where you see it, each as {"x": 0-1, "y": 0-1} fractions of the picture width and height, measured from the top-left corner. Use an empty list when the answer is "no" or "unsure".
Never give counts. Give "tier" for the whole roof: "low" (few places a rodent could get in), "med", or "high" (many or complex places).
If the picture is blank, or no roof is visible at the centre, answer "unsure" for every type with no pins, and tier "low".
Return only JSON: {"flags": {"<type>": {"likely": "...", "pins": [...]}, ...for every type}, "tier": "..."}.`;

// ── Image ─────────────────────────────────────────────────────────────────

const normalizeCounty = (county) => String(county || '').toLowerCase().replace(/\s+county\s*$/, '').trim();

// A square ground crop centred on the home, as a Web Mercator box: a metre on the ground spans 1/cos(lat) mercator
// units, so the half-width is stretched by that factor to keep the crop square on the ground.
function cropBounds(lat, lng) {
  const R = 6378137;
  const x = (lng * Math.PI * R) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
  const half = (CROP_METERS / 2) / Math.cos((lat * Math.PI) / 180);
  return [x - half, y - half, x + half, y + half];
}

function exportRequestUrl(src, lat, lng) {
  const px = Math.min(1024, Math.ceil(CROP_METERS / src.resolutionM));
  const params = new URLSearchParams({
    bbox: cropBounds(lat, lng).map((n) => n.toFixed(2)).join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${px},${px}`,
    format: 'jpg',
    f: 'image',
  });
  return `${src.exportUrl}?${params}`;
}

/** The aerial crop as { data (base64), mimeType, source, year }, or null (unknown county, fetch or content failure). */
async function fetchAerial(lat, lng, county) {
  const src = IMAGE_SOURCES[normalizeCounty(county)];
  if (!src) return null;
  try {
    const res = await fetch(exportRequestUrl(src, lat, lng), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // ArcGIS answers an out-of-range or failed export with a 200 and a JSON body, so the type is checked too.
    if (!res.ok || !String(res.headers.get('content-type') || '').startsWith('image/')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
    return { data: buffer.toString('base64'), mimeType: 'image/jpeg', source: src.source, year: src.year };
  } catch (err) {
    logger.warn(`[roof-entry-read] aerial fetch failed county=${normalizeCounty(county)}: ${err.message}`);
    return null;
  }
}

// ── Model answer ──────────────────────────────────────────────────────────

const inUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function validPins(entry) {
  if (!Array.isArray(entry.pins) || entry.pins.length > MAX_PINS) return null;
  if (entry.likely === 'no' && entry.pins.length) return null;
  if (!entry.pins.every((p) => isPlainObject(p) && inUnit(p.x) && inUnit(p.y))) return null;
  return entry.pins.map((p) => ({ x: p.x, y: p.y }));
}

/** The model JSON as { flags, tier }, or null when it breaks the contract (extra keys are dropped, missing ones fail). */
function validateRead(json) {
  if (!isPlainObject(json) || !TIERS.includes(json.tier) || !isPlainObject(json.flags)) return null;
  const flags = {};
  for (const type of ENTRY_TYPES) {
    const entry = json.flags[type];
    if (!isPlainObject(entry) || !LIKELY.includes(entry.likely)) return null;
    const pins = validPins(entry);
    if (!pins) return null;
    flags[type] = { likely: entry.likely, pins };
  }
  return { flags, tier: json.tier };
}

async function estimateCostCents(outcome) {
  try {
    const { map } = await llmCost.loadPrices();
    const usd = llmCost.costUsd(outcome.provider, outcome.usage || {}, llmCost.priceFor(map, outcome.model));
    if (usd != null && Number.isFinite(usd)) return Math.max(1, Math.ceil(usd * 100));
  } catch (err) {
    logger.warn(`[roof-entry-read] price lookup failed: ${err.message}`);
  }
  return FALLBACK_COST_CENTS;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** sha256 of the normalized address; without one, of the coordinates rounded to ~1 m. */
function lookupKey({ address, lat, lng }) {
  const text = String(address || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return crypto.createHash('sha256').update(text || `geo:${lat.toFixed(5)},${lng.toFixed(5)}`).digest('hex');
}

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** The one response shape for the staff screen (the later PR draws pins from flags[type].pins). */
function publicRead(row) {
  return {
    id: row.id,
    estimate_id: row.estimate_id || null,
    customer_id: row.customer_id || null,
    county: row.county,
    image_source: row.image_source,
    image_year: row.image_year,
    model: row.model,
    tier: row.ai_tier,
    flags: parseJson(row.ai_flags) || {},
    tech_final_count: row.tech_final_count ?? null,
    tech_final_flags: row.tech_final_flags == null ? null : parseJson(row.tech_final_flags),
    created_at: row.created_at,
  };
}

async function findReusable(key) {
  return db(TABLE)
    .where({ lookup_key: key })
    .whereNot({ ai_tier: TIER_UNKNOWN })
    .whereRaw("created_at > now() - (? * interval '1 day')", [REUSE_DAYS])
    .orderBy('created_at', 'desc')
    .first();
}

async function runNewRead({ key, lat, lng, county, estimateId, customerId }) {
  const image = await fetchAerial(lat, lng, county);
  if (!image) return { status: 'no_image', cached: false, read: null };

  const outcome = await dispatchWithFallback(MODELS.TEXT_POLICIES.estimateVision, {
    text: PROMPT,
    images: [{ data: image.data, mimeType: image.mimeType }],
    jsonMode: true,
    jsonSchema: READ_SCHEMA,
    maxTokens: 2048,
    temperature: 0.2,
    reasoningEffort: 'low',
    timeoutMs: MODEL_TIMEOUT_MS,
    laneId: 'satellite',
  }, { reserveFallbackBudget: true });
  if (!outcome.ok) {
    logger.warn(`[roof-entry-read] model call failed: ${outcome.reason || 'unknown'}`);
    return { status: 'model_failed', cached: false, read: null };
  }

  const checked = validateRead(outcome.json);
  const [row] = await db(TABLE).insert({
    estimate_id: estimateId || null,
    customer_id: customerId || null,
    lookup_key: key,
    county: normalizeCounty(county),
    image_source: image.source,
    image_year: image.year,
    model: outcome.model,
    ai_flags: JSON.stringify(checked ? checked.flags : {}),
    ai_tier: checked ? checked.tier : TIER_UNKNOWN,
    cost_estimate_cents: await estimateCostCents(outcome),
  }).returning('*');
  return { status: 'ok', cached: false, read: publicRead(row) };
}

// One in-flight read per property in this process, so a double tap never pays for two calls.
const inFlight = new Map();

/**
 * Run or reuse a roof read. Returns { status: 'ok' | 'no_image' | 'model_failed', cached, read }.
 * input: { lat, lng, county, address?, estimateId?, customerId? }
 */
async function runRoofEntryRead(input) {
  const key = lookupKey(input);
  const reusable = await findReusable(key);
  if (reusable) return { status: 'ok', cached: true, read: publicRead(reusable) };
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = runNewRead({ ...input, key }).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

/** The technician's own final count and per-type flags, kept beside the AI read to compare them later. */
async function saveTechCount(id, { count, flags }) {
  const patch = {};
  if (count !== undefined) patch.tech_final_count = count;
  if (flags !== undefined) patch.tech_final_flags = JSON.stringify(flags);
  const [row] = await db(TABLE).where({ id }).update(patch).returning('*');
  return row ? publicRead(row) : null;
}

module.exports = {
  ENTRY_TYPES,
  LIKELY,
  IMAGE_SOURCES,
  REUSE_DAYS,
  FALLBACK_COST_CENTS,
  cropBounds,
  exportRequestUrl,
  fetchAerial,
  validateRead,
  lookupKey,
  runRoofEntryRead,
  saveTechCount,
};
