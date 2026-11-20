'use strict';

/**
 * Staff roof read (GATE_ROOF_ENTRY_READ, owner 2026-11-19). From a free county aerial photo of the home, ONE vision
 * call flags which rodent entry-point types the roof likely has, so the technician knows where to look and the
 * estimate is not short. Staff only; nothing here reaches a customer. Every read is a paid model call, so:
 *   - a stored read of the same crop (imagery source + centre rounded to 5 decimals) is reused for 90 days from the
 *     PAID call. Another estimate or customer reusing it gets its own row (a cost-0 copy), so technician feedback
 *     stays with its own context;
 *   - an unknown county or a failed image fetch is { status: 'no_image' } and makes NO model call;
 *   - the model gets ONE provider call: the estimateVision policy is cut to its primary route, so a billed answer
 *     that fails to parse or validate is never retried on the second provider. It is stored with tier 'unknown' and
 *     no pins, and is never reused;
 *   - a property is read under a database advisory lock, so two server instances cannot both pay for it.
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
// The estimateVision policy without its fallback leg: dispatchWithFallback skips a missing route, so one read is
// one provider call (a billed-but-unusable Gemini answer must not buy a second read from OpenAI).
const ONE_CALL_POLICY = Object.freeze({ ...MODELS.TEXT_POLICIES.estimateVision, fallback: null });

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
const TIER_UNKNOWN = 'unknown';
const TIERS = Object.freeze(['low', 'med', 'high', TIER_UNKNOWN]);

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
Pins only go with "yes". Never give counts. Give "tier" for the whole roof: "low" (few places a rodent could get in), "med", or "high" (many or complex places).
If the roof cannot be read (the picture is blank, cloudy or cut off, or no building is visible at the centre), give tier "unknown" and answer "unsure" for every type with no pins. Never answer "low" for a roof you cannot see.
Return only JSON: {"flags": {"<type>": {"likely": "...", "pins": [...]}, ...for every type}, "tier": "..."}.`;

// ── Image ─────────────────────────────────────────────────────────────────

const normalizeCounty = (county) => String(county || '').toLowerCase().replace(/\s+county\s*$/, '').trim();
/** The allowlisted county key ('manatee' | 'sarasota' | 'charlotte'), or null: the only county text that may be logged. */
const countyKey = (county) => {
  const key = normalizeCounty(county);
  return Object.hasOwn(IMAGE_SOURCES, key) ? key : null;
};

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
  const key = countyKey(county);
  if (!key) return null;
  const src = IMAGE_SOURCES[key];
  try {
    const res = await fetch(exportRequestUrl(src, lat, lng), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // ArcGIS answers an out-of-range or failed export with a 200 and a JSON body, so the type is checked too.
    if (!res.ok || !String(res.headers.get('content-type') || '').startsWith('image/')) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
    return { data: buffer.toString('base64'), mimeType: 'image/jpeg', source: src.source, year: src.year };
  } catch (err) {
    logger.warn(`[roof-entry-read] aerial fetch failed county=${key}: ${err.message}`);
    return null;
  }
}

// ── Model answer ──────────────────────────────────────────────────────────

const inUnit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function validPins(entry) {
  if (!Array.isArray(entry.pins) || entry.pins.length > MAX_PINS) return null;
  // Pins mark where a thing IS: only a 'yes' may carry them.
  if (entry.likely !== 'yes' && entry.pins.length) return null;
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
  // An unreadable roof (tier 'unknown') carries no flags, like an answer that failed validation.
  return { flags: json.tier === TIER_UNKNOWN ? {} : flags, tier: json.tier };
}

/** Prices read once, BEFORE the transaction opens (a second pool connection inside it could deadlock the pool); null if unreadable. */
async function loadPriceMap() {
  try {
    return (await llmCost.loadPrices()).map;
  } catch (err) {
    logger.warn(`[roof-entry-read] price lookup failed: ${err.message}`);
    return null;
  }
}

/** Estimated spend of one billed leg, in cents: from llm_model_prices, else the ceiling. Never queries. */
function estimateCostCents({ provider, model, usage }, prices) {
  if (prices) {
    const usd = llmCost.costUsd(provider, usage || {}, llmCost.priceFor(prices, model));
    if (usd != null && Number.isFinite(usd)) return Math.max(1, Math.ceil(usd * 100));
  }
  return FALLBACK_COST_CENTS;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** sha256 of the imagery source and the crop centre rounded to 5 decimals (~1 m): the same roof in the same photo. */
function lookupKey({ source, lat, lng }) {
  return crypto.createHash('sha256').update(`${source}|${lat.toFixed(5)},${lng.toFixed(5)}`).digest('hex');
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

const sameContext = (row, ctx) => (row.estimate_id || null) === ctx.estimateId && (row.customer_id || null) === ctx.customerId;
const timeOf = (row) => new Date(row.created_at).getTime();

/**
 * The reusable reads of one crop, or null. The window is counted from the original PAID read: the anchor is the
 * newest row with cost_estimate_cents > 0 (a paid call books at least 1 cent; a copy for another estimate books 0)
 * that is not tier 'unknown' and is under 90 days old. Rows created at or after the anchor are its copies for other
 * contexts, so a copy never carries a read past 90 days from the paid call and never starts a new window.
 */
async function reuseCandidates(key, conn = db) {
  const rows = await conn(TABLE)
    .where({ lookup_key: key })
    .whereNot({ ai_tier: TIER_UNKNOWN })
    .whereRaw("created_at > now() - (? * interval '1 day')", [REUSE_DAYS])
    .select('*');
  const anchor = rows.filter((r) => r.cost_estimate_cents > 0).sort((a, b) => timeOf(b) - timeOf(a))[0];
  if (!anchor) return null;
  return { anchor, candidates: rows.filter((r) => timeOf(r) >= timeOf(anchor)) };
}

/**
 * The row to hand this request: the source itself when it belongs to the same (estimate, customer) context, else a
 * NEW row for this context that copies the paid AI result with cost 0 and empty technician fields. One row per
 * context keeps the technician's count for estimate B from overwriting estimate A's.
 */
async function answerFor(source, ctx, trx) {
  if (sameContext(source, ctx)) return publicRead(source);
  const [row] = await trx(TABLE).insert({
    estimate_id: ctx.estimateId,
    customer_id: ctx.customerId,
    lookup_key: source.lookup_key,
    county: source.county,
    image_source: source.image_source,
    image_year: source.image_year,
    model: source.model,
    ai_flags: JSON.stringify(parseJson(source.ai_flags) || {}),
    ai_tier: source.ai_tier,
    cost_estimate_cents: 0,
  }).returning('*');
  return publicRead(row);
}

/** Throws code 'unknown_reference' before any spend when a supplied estimate or customer does not exist. */
async function assertReferencesExist({ estimateId, customerId }) {
  const checks = [['estimates', estimateId], ['customers', customerId]];
  for (const [table, id] of checks) {
    if (id && !(await db(table).where({ id }).first('id'))) {
      const err = new Error(`unknown ${table} reference`);
      err.code = 'unknown_reference';
      throw err;
    }
  }
}

async function callModel(image) {
  return dispatchWithFallback(ONE_CALL_POLICY, {
    text: PROMPT,
    images: [{ data: image.data, mimeType: image.mimeType }],
    jsonMode: true,
    jsonSchema: READ_SCHEMA,
    maxTokens: 2048,
    temperature: 0.2,
    reasoningEffort: 'low',
    timeoutMs: MODEL_TIMEOUT_MS,
    laneId: 'satellite',
  });
}

// What the one provider call produced, as the row's model, validated read and billed leg. A call that failed but
// was billed (the provider answered, then the answer could not be parsed) is still on the books as tier 'unknown'.
function settleOutcome(outcome) {
  if (outcome.ok) {
    return { model: outcome.model, checked: validateRead(outcome.json), billed: { provider: outcome.provider, model: outcome.model, usage: outcome.usage } };
  }
  const leg = (outcome.failures || []).find((f) => f.usage);
  return leg ? { model: leg.model, checked: null, billed: leg } : null;
}

// The paid part, run under the property's advisory lock and one transaction: look again, then image, model call and
// insert. A second server instance waits on the lock and then finds this row instead of paying again. `seenIds` are
// the rows of this crop that existed when the request began: a row that appeared after that (even a billed tier
// 'unknown') was written by the holder we waited on, and is this request's answer. A LATER request, which did not wait
// on that attempt, may retry an unknown.
async function readUnderLock({ key, lat, lng, county, ctx, seenIds, prices }) {
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [key]);
    const hit = await reuseCandidates(key, trx);
    if (hit) {
      const source = hit.candidates.find((r) => sameContext(r, ctx)) || hit.anchor;
      return { status: 'ok', cached: true, read: await answerFor(source, ctx, trx) };
    }
    const appeared = (await trx(TABLE).where({ lookup_key: key }).select('*'))
      .filter((r) => !seenIds.has(r.id))
      .sort((a, b) => timeOf(b) - timeOf(a))[0];
    if (appeared) return { status: 'ok', cached: true, read: await answerFor(appeared, ctx, trx) };

    const image = await fetchAerial(lat, lng, county);
    if (!image) return { status: 'no_image', cached: false, read: null };
    const outcome = await callModel(image);
    const settled = settleOutcome(outcome);
    if (!settled) {
      logger.warn(`[roof-entry-read] model call failed: ${outcome.reason || 'unknown'}`);
      return { status: 'model_failed', cached: false, read: null };
    }
    const [row] = await trx(TABLE).insert({
      estimate_id: ctx.estimateId,
      customer_id: ctx.customerId,
      lookup_key: key,
      county: countyKey(county),
      image_source: image.source,
      image_year: image.year,
      model: settled.model,
      ai_flags: JSON.stringify(settled.checked ? settled.checked.flags : {}),
      ai_tier: settled.checked ? settled.checked.tier : TIER_UNKNOWN,
      cost_estimate_cents: estimateCostCents(settled.billed, prices),
    }).returning('*');
    return { status: 'ok', cached: false, read: publicRead(row) };
  });
}

// Fast path only: one in-flight read per crop and context in this process. The advisory lock is what holds across instances.
const inFlight = new Map();

/**
 * Run or reuse a roof read. Returns { status: 'ok' | 'no_image' | 'model_failed', cached, read }.
 * input: { lat, lng, county, estimateId?, customerId? }. Throws code 'unknown_reference' for a missing estimate or
 * customer. An unsupported county answers no_image before any database read. A reuse for a different estimate or
 * customer gets its own row (a copy of the paid result, cost 0), so each context keeps its own technician feedback.
 */
async function runRoofEntryRead(input) {
  const county = countyKey(input.county);
  if (!county) return { status: 'no_image', cached: false, read: null };
  await assertReferencesExist(input);
  const ctx = { estimateId: input.estimateId || null, customerId: input.customerId || null };
  const key = lookupKey({ source: IMAGE_SOURCES[county].source, lat: input.lat, lng: input.lng });
  // The rows of this crop as of now: what "already there" means for this request once it queues on the lock.
  const seenIds = new Set((await db(TABLE).where({ lookup_key: key }).select('id')).map((r) => r.id));
  const hit = await reuseCandidates(key);
  const same = hit && hit.candidates.find((r) => sameContext(r, ctx));
  if (same) return { status: 'ok', cached: true, read: publicRead(same) };
  const flightKey = `${key}|${ctx.estimateId}|${ctx.customerId}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);
  const pending = (async () => {
    const prices = hit ? null : await loadPriceMap();
    return readUnderLock({ ...input, key, ctx, seenIds, prices });
  })().finally(() => inFlight.delete(flightKey));
  inFlight.set(flightKey, pending);
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
  countyKey,
  lookupKey,
  runRoofEntryRead,
  saveTechCount,
};
