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
 *   - a crop is CLAIMED with a pending row (one per crop, a partial unique index) before the image fetch and the model
 *     call, so two requests, on one server or two, cannot both pay for it, and no connection or lock is held while the
 *     slow, paid steps run. The paid result is written to the claimed row by id.
 *   - a failure that may have been billed (timeout, 5xx, body error, unknown) is kept as a 'failed' row at the 5-cent
 *     ceiling (spend unknown); only a confirmed pre-billing failure releases the claim. A failed row is never reused.
 * Migrations (all pushed, none editable): 20261119140000 roof_entry_reads, 20261119150000 claims (status, claimed_at,
 * source_id, pending and copy indexes), 20261119160000 context_key (replaces the copy index), 20261119170000 rollback
 * guard (a no-op up; its down detaches colliding copies, deleting nothing, so the 160000 down can recreate the old copy
 * index after an estimate with copies was deleted and SET NULL made two old-style keys equal).
 * The model gives yes / no / unsure per entry type and up to 6 pins as 0-1 image fractions. It is never asked to
 * count: vision models count poorly, and the technician's own count (saveTechCount) is the ground truth.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');
const llmCost = require('./llm-cost');
const { isMergeRetiredRow } = require('./merge-retired');

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
const STATUS_DONE = 'done';
const STATUS_PENDING = 'pending';
const STATUS_FAILED = 'failed';
const CLAIM_STALE_MINUTES = 5;
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
/** The crop centre, rounded ONCE to 5 decimals (~1 m): the cache key and the image request both use this value. */
const roundCentre = (n) => Number(n.toFixed(5));

function cropBounds(lat, lng) {
  const R = 6378137;
  const x = (lng * Math.PI * R) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
  const half = (CROP_METERS / 2) / Math.cos((lat * Math.PI) / 180);
  return [x - half, y - half, x + half, y + half];
}

function exportRequestUrl(src, rawLat, rawLng) {
  // Same rounded centre as lookupKey: a cached read's pins describe exactly the crop that was requested for its key.
  const lat = roundCentre(rawLat);
  const lng = roundCentre(rawLng);
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

/**
 * The response body as a Buffer, or null when it is empty or passes MAX_IMAGE_BYTES. It is read in chunks and the read
 * stops (leaving the loop cancels the stream) as soon as the cap is passed, so an oversized answer is never buffered whole.
 */
async function readCapped(res) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    await res.body?.cancel?.();
    return null;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES) return null;
    chunks.push(chunk);
  }
  return total ? Buffer.concat(chunks, total) : null;
}

/** The aerial crop as { data (base64), mimeType, source, year }, or null (unknown county, fetch or content failure). */
async function fetchAerial(lat, lng, county) {
  const key = countyKey(county);
  if (!key) return null;
  const src = IMAGE_SOURCES[key];
  try {
    const res = await fetch(exportRequestUrl(src, lat, lng), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // ArcGIS answers an out-of-range or failed export with a 200 and a JSON body, so the type is checked too.
    if (!res.ok || !String(res.headers.get('content-type') || '').startsWith('image/')) {
      await res.body?.cancel?.();
      return null;
    }
    const buffer = await readCapped(res);
    if (!buffer) return null;
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
  // No token counts captured (the provider omitted its usage block, so the counters are null): they would price to zero
  // and book 1 cent for a call that may have cost more. Book the ceiling instead.
  const counted = [usage?.input_tokens, usage?.output_tokens].some((n) => Number.isFinite(n));
  if (prices && counted) {
    const usd = llmCost.costUsd(provider, usage || {}, llmCost.priceFor(prices, model));
    if (usd != null && Number.isFinite(usd)) return Math.max(1, Math.ceil(usd * 100));
  }
  return FALLBACK_COST_CENTS;
}

// ── Reads ─────────────────────────────────────────────────────────────────

/** sha256 of the imagery source and the crop centre rounded to 5 decimals (~1 m): the same roof in the same photo. */
function lookupKey({ source, lat, lng }) {
  return crypto.createHash('sha256').update(`${source}|${roundCentre(lat).toFixed(5)},${roundCentre(lng).toFixed(5)}`).digest('hex');
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

/**
 * The context of a row, written once at insert on EVERY row (paid, claim and copy). An estimate that belongs to a customer
 * is keyed 'e:<estimate id>': estimate ids never change, and a customer merge repoints only the customer. An estimate with
 * NO customer that is read for a customer is keyed 'e:<estimate id>|c:<customer id>', so two customers on one unowned
 * estimate never share a row. Otherwise 'c:<customer id>' ('c:' when neither is given). Matching and copy dedupe use this,
 * never the nullable estimate_id / customer_id keys that ON DELETE SET NULL can change. All lower-case, at most 77
 * characters (varchar(80)). Migration 20261119160000 back-filled the legacy '<est>|<cust>' format; no rows exist from before
 * this format (the table is dark behind GATE_ROOF_ENTRY_READ), so it is never read back.
 * ctx.estimateOwned is false when the estimate has no customer yet (true or undefined otherwise).
 */
const unownedFor = (ctx) => !!(ctx.estimateId && ctx.customerId && ctx.estimateOwned === false);
const contextKey = (ctx) => {
  if (!ctx.estimateId) return `c:${ctx.customerId || ''}`.toLowerCase();
  return (unownedFor(ctx) ? `e:${ctx.estimateId}|c:${ctx.customerId}` : `e:${ctx.estimateId}`).toLowerCase();
};
/** Every key that answers this context: an estimate that has since been given its customer also finds the earlier two-part key. */
const contextKeys = (ctx) => {
  if (!ctx.estimateId || unownedFor(ctx) || !ctx.customerId) return [contextKey(ctx)];
  return [contextKey(ctx), `e:${ctx.estimateId}|c:${ctx.customerId}`.toLowerCase()];
};
const lowerOf = (v) => String(v || '').toLowerCase();
/**
 * Does this row answer this context? By key, and, after a customer-dedupe merge (which repoints customer_id and never the
 * key), also a row whose CURRENT customer is the supplied customer: for a customer-only lookup, a customer-only row with no
 * estimate; for an estimate lookup, that estimate's own two-part row. The customer must equal the row's current one.
 */
const matchesContext = (row, ctx) => {
  if (contextKeys(ctx).includes(row.context_key)) return true;
  if (!ctx.customerId || lowerOf(row.customer_id) !== ctx.customerId) return false;
  if (!ctx.estimateId) return !row.estimate_id && String(row.context_key).startsWith('c:');
  return String(row.context_key).startsWith(`e:${ctx.estimateId}|c:`);
};
const timeOf = (row) => new Date(row.created_at).getTime();
/** The oldest candidate that answers the context. */
const findForContext = (candidates, ctx) => candidates.filter((r) => matchesContext(r, ctx)).sort((a, b) => timeOf(a) - timeOf(b))[0];

/**
 * The reusable reads of one crop, or null. The window is counted from the original PAID read: the anchor is the
 * newest row with cost_estimate_cents > 0 (a paid call books at least 1 cent; a copy for another estimate books 0)
 * that is a finished ('done') read, not tier 'unknown', and under 90 days old. The candidates are the anchor and the
 * copies that name it in source_id, so a copy never carries a read past 90 days from the paid call and never starts a
 * new window. Pending and failed rows are never reused.
 */
async function reuseCandidates(key) {
  const rows = await db(TABLE)
    .where({ lookup_key: key, status: STATUS_DONE })
    .whereNot({ ai_tier: TIER_UNKNOWN })
    .whereRaw("created_at > now() - (? * interval '1 day')", [REUSE_DAYS])
    .select('*');
  const anchor = rows.filter((r) => r.cost_estimate_cents > 0).sort((a, b) => timeOf(b) - timeOf(a))[0];
  if (!anchor) return null;
  return { anchor, candidates: rows.filter((r) => r.id === anchor.id || r.source_id === anchor.id) };
}

/**
 * The row to hand this request: the source itself when it belongs to the same (estimate, customer) context, else a
 * NEW row for this context that copies the paid AI result with cost 0 and empty technician fields. One row per
 * context keeps the technician's count for estimate B from overwriting estimate A's. The copy names its paid source
 * in source_id, and a unique index on (source_id, context_key) lets two requests race for it: the loser's
 * insert does nothing and both return the winning row. Only copies carry a source_id, so no paid row is in that index.
 */
async function answerFor(source, ctx) {
  if (matchesContext(source, ctx)) return publicRead(source);
  let writtenKey;
  const [inserted] = await writeOwned(ctx, (conn, key) => conn(TABLE).insert({
    source_id: source.id,
    estimate_id: ctx.estimateId,
    customer_id: ctx.customerId,
    context_key: (writtenKey = key),
    lookup_key: source.lookup_key,
    county: source.county,
    image_source: source.image_source,
    image_year: source.image_year,
    model: source.model,
    ai_flags: JSON.stringify(parseJson(source.ai_flags) || {}),
    ai_tier: source.ai_tier,
    status: STATUS_DONE,
    cost_estimate_cents: 0,
  }).onConflict().ignore().returning('*'));
  const row = inserted || await db(TABLE).where({ source_id: source.id, context_key: writtenKey }).first();
  return publicRead(row);
}

const referenceError = (code, message) => Object.assign(new Error(message), { code });
// The estimate belongs to a customer other than the one supplied (ids compared lower-case).
const ownerMismatch = (estimateCustomerId, ctx) => !!(ctx.customerId && estimateCustomerId && String(estimateCustomerId).toLowerCase() !== ctx.customerId);

/**
 * Before any claim, copy, image fetch or model call: a supplied estimate and customer must exist (code
 * 'unknown_reference'), a customer retired by a duplicate merge counts as unknown (its id must never open a new read; the
 * merge repointed its rows to the surviving customer), and when both are given and the estimate belongs to a customer, that
 * customer must be the one supplied (code 'reference_mismatch'). One estimate's read can never be filed under another
 * customer. Returns { estimateOwned } (false when the estimate has no customer yet; undefined unless both ids are given).
 */
async function assertReferencesExist({ estimateId, customerId }) {
  const estimate = estimateId ? await db('estimates').where({ id: estimateId }).first('id', 'customer_id') : null;
  if (estimateId && !estimate) throw referenceError('unknown_reference', 'unknown estimates reference');
  if (customerId) {
    const customer = await db('customers').where({ id: customerId }).first('id', 'deleted_at', 'phone');
    if (!customer || isMergeRetiredRow(customer)) throw referenceError('unknown_reference', 'unknown customers reference');
  }
  if (estimate && ownerMismatch(estimate.customer_id, { customerId })) throw referenceError('reference_mismatch', 'the estimate belongs to another customer');
  return { estimateOwned: estimate && customerId ? !!estimate.customer_id : undefined };
}

/**
 * Runs `write(conn, contextKey)` that inserts a row for this context. When the context names both an estimate and a customer, the
 * write runs in a SHORT transaction that first locks the estimate row (FOR SHARE: a customer merge cannot change it
 * until we commit), rechecks that its customer is still the one supplied, writes, and commits. The check and the insert
 * are therefore atomic. This is the only transaction in the flow, and it holds no lock during any network I/O.
 */
async function writeOwned(ctx, write) {
  if (!(ctx.estimateId && ctx.customerId)) return write(db, contextKey(ctx));
  return db.transaction(async (trx) => {
    const estimate = await trx('estimates').where({ id: ctx.estimateId }).forShare().first('customer_id');
    if (!estimate) throw referenceError('unknown_reference', 'unknown estimates reference');
    if (ownerMismatch(estimate.customer_id, ctx)) throw referenceError('reference_mismatch', 'the estimate belongs to another customer');
    // The key is derived from the estimate as locked here, so it can never disagree with who owns it at write time.
    return write(trx, contextKey({ ...ctx, estimateOwned: !!estimate.customer_id }));
  });
}

async function callModel(image) {
  return dispatchWithFallback(ONE_CALL_POLICY, {
    text: PROMPT,
    images: [{ data: image.data, mimeType: image.mimeType }],
    jsonMode: true,
    jsonSchema: READ_SCHEMA,
    maxTokens: 2048,
    temperature: 0.2,
    // The Gemini adapter reads thinkingLevel (reasoningEffort is the OpenAI/Anthropic knob); the policy has no other leg.
    thinkingLevel: 'LOW',
    timeoutMs: MODEL_TIMEOUT_MS,
    laneId: 'satellite',
  }, {
    // A parseable answer that breaks the strict schema is a quality failure the call ledger must record, with the usage
    // it billed. The policy has no fallback leg, so this stays ONE provider call.
    validate: (candidate) => (validateRead(candidate.json) ? null : 'invalid_schema'),
  });
}

// Failures the dispatcher reports for a request that provably never reached the provider's billing: no key (nothing
// sent), no route, or a 4xx the provider refuses before any processing (the same statuses llm-cost treats as unbilled).
// Everything else (timeout, 5xx, a body read error, the catch-all 'error', anything new) may have been billed.
const UNBILLED_FAILURE = /^(no_key|no_route|same_provider_fallback)$|^[a-z0-9]+_(400|401|402|403|404|413|422)$/;

// What the one provider call produced, as the row's model, validated read and billed leg:
//  - an answer: its usage prices the read; a schema-breaking answer is kept as tier 'unknown' by the caller;
//  - a failed leg that reported usage was billed (it could not be parsed): kept as 'unknown' with that usage's cost;
//  - a failure that is confirmed pre-billing: null, so the caller releases the claim and the next request may retry;
//  - any other failure may have been billed (a timeout or body error after the request was sent): spend unknown, so the
//    caller keeps a 'failed' row at the ceiling. A failed row is never reused, so the next request may retry.
function settleOutcome(outcome) {
  if (outcome.ok) {
    return { model: outcome.model, checked: validateRead(outcome.json), billed: { provider: outcome.provider, model: outcome.model, usage: outcome.usage } };
  }
  const failures = outcome.failures || [];
  const leg = failures.find((f) => f.usage);
  if (leg) return { model: leg.model, checked: null, billed: leg };
  if (failures.every((f) => UNBILLED_FAILURE.test(String(f.reason)))) return null;
  return { model: failures[0]?.model || ONE_CALL_POLICY.primary.model, checked: null, billed: null, spendUnknown: true };
}

// One short statement takes the crop's claim: a pending row with this request's context and the policy's model id. The
// partial unique index admits one pending row per crop, so a conflict returns nothing. Autocommit: the claim is visible
// to every other request before the image fetch starts, and no connection stays open afterwards.
async function insertClaim(key, county, ctx) {
  const src = IMAGE_SOURCES[county];
  const rows = await writeOwned(ctx, (conn, contextKeyToWrite) => conn(TABLE).insert({
    estimate_id: ctx.estimateId,
    customer_id: ctx.customerId,
    context_key: contextKeyToWrite,
    lookup_key: key,
    county,
    image_source: src.source,
    image_year: src.year,
    model: ONE_CALL_POLICY.primary.model,
    ai_flags: '{}',
    ai_tier: STATUS_PENDING,
    cost_estimate_cents: 0,
    status: STATUS_PENDING,
    claimed_at: db.fn.now(),
  }).onConflict().ignore().returning('*'));
  return rows[0] || null;
}

// A claim whose holder died is stale after 5 minutes (an image fetch and a model call are capped well under that):
// mark it failed so the crop can be claimed again. The conditional UPDATE lets only one taker win.
async function expireStaleClaim(key) {
  const rows = await db(TABLE)
    .where({ lookup_key: key, status: STATUS_PENDING })
    .whereRaw("claimed_at < now() - (? * interval '1 minute')", [CLAIM_STALE_MINUTES])
    .update({ status: STATUS_FAILED, ai_tier: TIER_UNKNOWN })
    .returning('id');
  return rows.length > 0;
}

async function claimCrop(key, county, ctx) {
  const claimed = await insertClaim(key, county, ctx);
  if (claimed) return claimed;
  return (await expireStaleClaim(key)) ? insertClaim(key, county, ctx) : null;
}

// Just before the paid call, renew the claim: an atomic UPDATE that only a claim still pending can win. It returns the
// new claimed_at (set to millisecond precision so it round-trips through a JS Date), or null when the claim was lost
// (a 5-minute takeover marked it failed while this worker was fetching the image): then no call may be made. The same
// UPDATE books the ceiling as the cost: once the call is about to be sent it may be billed, so a worker that dies after
// the dispatch, or a result write that fails, leaves a row at 5 cents, never 0. The completion write replaces it with
// the real figure; a confirmed-unbilled failure deletes the claim.
async function renewClaim(claim) {
  const rows = await db(TABLE)
    .where({ id: claim.id, status: STATUS_PENDING })
    .update({ claimed_at: db.raw("date_trunc('milliseconds', now())"), cost_estimate_cents: FALLBACK_COST_CENTS })
    .returning('claimed_at');
  return rows[0] ? rows[0].claimed_at : null;
}

// What the paid call produced, written to the claimed row by id, but only while the claim is still this worker's: still
// pending AND still at the renewed claimed_at. A finished read is 'done'. A call that was billed but gave nothing usable
// (unparseable or schema-breaking answer) is 'failed' with its cost and tier 'unknown'. Returns null when another worker
// owns the row now: the expired claim is never revived or overwritten.
async function finishClaim(claim, renewedAt, settled, prices) {
  const [row] = await db(TABLE)
    .where({ id: claim.id, status: STATUS_PENDING, claimed_at: renewedAt })
    .update({
      model: settled.model,
      ai_flags: JSON.stringify(settled.checked ? settled.checked.flags : {}),
      ai_tier: settled.checked ? settled.checked.tier : TIER_UNKNOWN,
      status: settled.checked ? STATUS_DONE : STATUS_FAILED,
      // Spend unknown (the call may have been billed with no usage seen) is booked at the ceiling, never at zero.
      cost_estimate_cents: settled.spendUnknown ? FALLBACK_COST_CENTS : estimateCostCents(settled.billed, prices),
    })
    .returning('*');
  return row ? publicRead(row) : null;
}

// A claim with nothing to keep (no image, or a call that failed before billing) is deleted so the crop can be claimed
// again; the status condition keeps a row another worker has since taken over untouched.
const releaseClaim = (claim) => db(TABLE).where({ id: claim.id, status: STATUS_PENDING }).del();

// This worker lost its claim: answer from a read another worker finished, else tell the caller to retry. No call is made.
async function afterLostClaim(key, ctx) {
  logger.debug('[roof-entry-read] the claim is no longer this worker\'s; nothing is overwritten');
  const finished = await reuseCandidates(key);
  return finished ? reuseAnswer(finished, ctx) : { status: 'in_progress', cached: false, read: null };
}

// The paid part, with NO connection held: image fetch, renew the claim, one model call, then the conditional write.
async function payForRead({ claim, key, ctx, lat, lng, county, prices }) {
  const image = await fetchAerial(lat, lng, county);
  if (!image) {
    await releaseClaim(claim);
    return { status: 'no_image', cached: false, read: null };
  }
  const renewedAt = await renewClaim(claim);
  if (!renewedAt) return afterLostClaim(key, ctx);
  const outcome = await callModel(image);
  const settled = settleOutcome(outcome);
  if (!settled) {
    logger.warn(`[roof-entry-read] model call failed: ${outcome.reason || 'unknown'}`);
    await releaseClaim(claim);
    return { status: 'model_failed', cached: false, read: null };
  }
  const read = await finishClaim(claim, renewedAt, settled, prices);
  if (!read) return afterLostClaim(key, ctx);
  // A failed call with unknown spend is on the books, but there is no answer: the caller may simply try again.
  return settled.spendUnknown ? { status: 'model_failed', cached: false, read: null } : { status: 'ok', cached: false, read };
}

// The answer for a reusable read, for this request's context (a copy row when the context differs).
async function reuseAnswer(hit, ctx) {
  const source = findForContext(hit.candidates, ctx) || hit.anchor;
  return { status: 'ok', cached: true, read: await answerFor(source, ctx) };
}

async function readCrop({ input, county, key, ctx, hit }) {
  // Prices are read before the claim, only when a paid call is possible; the claim and the write are single statements.
  const prices = hit ? null : await loadPriceMap();
  const claim = await claimCrop(key, county, ctx);
  if (!claim) {
    // Another request holds the crop. It may have just finished: look once more, otherwise tell the caller to retry.
    const again = await reuseCandidates(key);
    if (again) return reuseAnswer(again, ctx);
    return { status: 'in_progress', cached: false, read: null };
  }
  // Everything after the claim insert runs inside this cleanup: an error anywhere releases THIS request's claim (only
  // while it is still pending), so the crop is never left pending for 5 minutes behind a failure.
  try {
    // The unique index covers pending rows only: another worker may have finished this crop between our reuse check and
    // our claim. Look again; a finished read makes the claim redundant, so drop it and answer from that read.
    const finished = await reuseCandidates(key);
    if (finished) {
      await releaseClaim(claim);
      return await reuseAnswer(finished, ctx);
    }
    return await payForRead({ claim, key, ctx, lat: input.lat, lng: input.lng, county, prices });
  } catch (err) {
    await db(TABLE).where({ id: claim.id, status: STATUS_PENDING }).update({ status: STATUS_FAILED, ai_tier: TIER_UNKNOWN }).catch(() => {});
    throw err;
  }
}

// Fast path only: one in-flight read per crop and context in this process. The claim row is what holds across instances.
const inFlight = new Map();

const lowerId = (v) => (v ? String(v).toLowerCase() : null);

/**
 * Run or reuse a roof read. Returns { status: 'ok' | 'in_progress' | 'no_image' | 'model_failed', cached, read }.
 * input: { lat, lng, county, estimateId?, customerId? }. Throws code 'unknown_reference' for a missing estimate or
 * customer. An unsupported county answers no_image before any database read. 'in_progress' means another request holds
 * this crop's claim: no image fetch or model call was made, ask again shortly. A reuse for a different estimate or
 * customer gets its own row (a copy of the paid result, cost 0), so each context keeps its own technician feedback.
 */
async function runRoofEntryRead(input) {
  const county = countyKey(input.county);
  if (!county) return { status: 'no_image', cached: false, read: null };
  // Ids are compared and stored lower-case: an upper-case UUID is the same context as its lower-case spelling.
  const ctx = { estimateId: lowerId(input.estimateId), customerId: lowerId(input.customerId) };
  ctx.estimateOwned = (await assertReferencesExist(ctx)).estimateOwned;
  const key = lookupKey({ source: IMAGE_SOURCES[county].source, lat: input.lat, lng: input.lng });
  const hit = await reuseCandidates(key);
  const same = hit && findForContext(hit.candidates, ctx);
  if (same) return { status: 'ok', cached: true, read: publicRead(same) };
  if (hit) return reuseAnswer(hit, ctx);
  const flightKey = `${key}|${ctx.estimateId}|${ctx.customerId}`;
  if (inFlight.has(flightKey)) return inFlight.get(flightKey);
  const pending = readCrop({ input, county, key, ctx, hit }).finally(() => inFlight.delete(flightKey));
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
  contextKey,
  cropBounds,
  exportRequestUrl,
  fetchAerial,
  validateRead,
  countyKey,
  lookupKey,
  runRoofEntryRead,
  saveTechCount,
};
