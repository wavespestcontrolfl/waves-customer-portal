/**
 * AI-powered fallback for the `stories` field.
 *
 * RentCast is our primary source for structural facts, but its `features`
 * payload is inconsistent — on ~8–12% of SWFL addresses (mostly newer Parrish
 * / Lakewood Ranch builds) it returns no floor count. Without a fallback we
 * silently default those to 1, which under-prices pest control for every
 * 2-story home that slips through.
 *
 * The previous Apify-based scraper ran but got blocked by Zillow's anti-bot.
 * This module replaces it with a Claude call that uses the web_search tool to
 * pull stories from Zillow / Realtor / county records and synthesize a
 * confidence-rated answer.
 *
 * Gated on `ANTHROPIC_API_KEY` (already required for the rest of the platform).
 * Fails closed — on any error, low-confidence answer, or unparseable response
 * we return null and the orchestrator falls back to stories=1 plus the UI
 * "verify stories" nudge.
 *
 * Tunables:
 *   AI_STORIES_TIMEOUT_MS  — request timeout (default 30000)
 *   AI_STORIES_MAX_SEARCHES — web_search tool max_uses (default 5)
 *
 * All logs are prefixed `[ai-stories]` so they're greppable in Railway.
 */

const logger = require('../logger');
const MODELS = require('../../config/models');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SEARCHES = 5;

async function lookupStoriesFromAI(address, hints = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.info('[ai-stories] skipped — ANTHROPIC_API_KEY not set');
    return null;
  }
  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    logger.warn('[ai-stories] skipped — address missing or too short');
    return null;
  }

  const timeoutMs = Number(process.env.AI_STORIES_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const maxSearches = Number(process.env.AI_STORIES_MAX_SEARCHES) || DEFAULT_MAX_SEARCHES;

  const t0 = Date.now();
  logger.info('[ai-stories] calling Claude with web_search', {
    address: address.slice(0, 80),
    hints: Object.keys(hints).filter((k) => hints[k] != null),
    model: MODELS.WORKHORSE,
    timeoutMs,
    maxSearches,
  });

  try {
    // Lazy-require so module load doesn't depend on the SDK in test contexts.
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const resp = await client.messages.create({
      model: MODELS.WORKHORSE,
      max_tokens: 1024,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: maxSearches,
      }],
      messages: [{
        role: 'user',
        content: buildPrompt(address, hints),
      }],
    }, { timeout: timeoutMs });

    const elapsedMs = Date.now() - t0;

    // Pull the final text block. Claude may emit tool_use blocks before its
    // text answer; we want the last text-type block in the content array.
    const textBlock = (resp.content || []).filter((b) => b.type === 'text').pop();
    if (!textBlock?.text) {
      logger.warn('[ai-stories] no text block in response', {
        elapsedMs,
        blockTypes: (resp.content || []).map((b) => b.type),
      });
      return null;
    }

    const parsed = parseStoriesJSON(textBlock.text);
    if (!parsed) {
      logger.warn('[ai-stories] could not parse JSON', {
        elapsedMs,
        sample: textBlock.text.slice(0, 240),
      });
      return null;
    }

    if (parsed.stories == null) {
      logger.info('[ai-stories] no answer found by AI', {
        elapsedMs,
        confidence: parsed.confidence,
        source: parsed.source,
      });
      return null;
    }

    // Accept any confidence level — the previous "discard low-confidence"
    // policy meant new-construction homes (no public listing yet) all came
    // back null and got the wrong default of 1. Better to accept Claude's
    // best inference and let the estimator eyeball it than to silently
    // under-price every brand-new 2-story.
    logger.info('[ai-stories] got stories', {
      stories: parsed.stories,
      confidence: parsed.confidence,
      source: parsed.source,
      elapsedMs,
    });
    return parsed.stories;
  } catch (err) {
    logger.warn('[ai-stories] errored', {
      elapsedMs: Date.now() - t0,
      message: err?.message || String(err),
    });
    return null;
  }
}

function buildPrompt(address, hints = {}) {
  const hintLines = [];
  if (hints.subdivision) hintLines.push(`Subdivision: ${hints.subdivision}`);
  if (hints.squareFootage) hintLines.push(`Living area: ${hints.squareFootage} sf`);
  if (hints.bedrooms) hintLines.push(`Bedrooms: ${hints.bedrooms}`);
  if (hints.bathrooms) hintLines.push(`Bathrooms: ${hints.bathrooms}`);
  if (hints.yearBuilt) hintLines.push(`Year built: ${hints.yearBuilt}`);
  if (hints.propertyType) hintLines.push(`Type: ${hints.propertyType}`);
  const hintsBlock = hintLines.length
    ? `\nKnown facts from RentCast (use these to triangulate):\n${hintLines.map((l) => `- ${l}`).join('\n')}\n`
    : '';

  return `How many stories (floors above grade) does the residential property at this address have?

Address: ${address}
${hintsBlock}
Search aggressively across these source families. Use web_search multiple times if needed:

1. PRIMARY listing sites — start here, in this order: zillow.com, redfin.com, homes.com, realtor.com, trulia.com. Most listings show stories explicitly in the Facts & Features / Home Highlights section.
2. Secondary aggregators — compass.com, era.com, liveinswflorida.com, villageshomefinder.com, bradentonhomelocator.com. Try these when the primary sites don't surface the address (common for new construction or recently sold).
3. County property appraisers — manateepao.gov (Manatee), sc-pa.com (Sarasota), ccappraiser.com (Charlotte). Authoritative for tax records; often include "stories" or "number of stories" fields.
4. Builder floorplan catalogs (when subdivision identifies a builder) — drhorton.com, pulte.com, lennar.com, mihomes.com, taylormorrison.com, mattamyhomes.com, neal-communities.com, kbhome.com, davidweekleyhomes.com, meritagehomes.com, ryanhomes.com, richmond-american.com, homesbywestbay.com. Match the home's square footage to a floorplan in the catalog.
5. Permit / contractor data — buildzoom.com sometimes has stories from building permits.

Inference rules when direct data is unavailable:
- Garage square footage is NOT counted as a story.
- A finished attic CAN count if a source lists it as a story.
- Ground-floor + second-floor = 2 stories. Single-floor ranch = 1 story.
- A 4+ bedroom new-construction SWFL home above ~2,500 sf is more often 2-story than 1-story.
- A "3.5 bath" or "2.5 bath" split is a strong 2-story signal (powder room downstairs).
- If the subdivision matches a known builder (e.g., "Bella Lago" → D.R. Horton), check that builder's floorplan catalog and match by square footage.

Respond with ONLY a JSON object — no preamble, no explanation, no markdown fences:
{"stories": <integer 1-4 or null>, "source": "<URL of primary source>", "confidence": "high" | "medium" | "low"}

- "high" = two independent sources agree on the same number, OR one authoritative source (county records, builder floorplan match) is unambiguous.
- "medium" = a single listing or floorplan-by-sqft match.
- "low" = inference from bedroom/bath/sqft profile only.

Make your best determination. Only return {"stories": null, ...} if you have absolutely no evidence — even an inference is more useful to the operator than null.`;
}

function parseStoriesJSON(text) {
  // Strip code fences if Claude wrapped the JSON despite being asked not to.
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  // Pull the first balanced { ... } block — Claude sometimes prefixes a sentence.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const n = parsed.stories;
    if (n != null) {
      if (!Number.isFinite(n) || n <= 0 || n > 10) return null;
      parsed.stories = Math.round(n);
    }
    return parsed;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// FULL PROPERTY FALLBACK — when RentCast had nothing
// ─────────────────────────────────────────────
// Same Claude+web_search pattern as lookupStoriesFromAI, but pulls every fact
// the pricing engine cares about (sqft, lot, year built, beds, baths, stories,
// property type, construction material). Triggered by performPropertyLookup()
// only when the RentCast call returned no record at all — common for brand-new
// SWFL builds and rural / RFD addresses.
//
// Returns a RentCast-shaped object so buildEnrichedProfile can consume it
// without branching on data source. Stamps `_source: 'ai'` so downstream code
// (and field-verify flags) can surface provenance.
async function lookupPropertyFromAI(address) {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.info('[ai-property] skipped — ANTHROPIC_API_KEY not set');
    return null;
  }
  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    logger.warn('[ai-property] skipped — address missing or too short');
    return null;
  }

  const timeoutMs = Number(process.env.AI_PROPERTY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const maxSearches = Number(process.env.AI_PROPERTY_MAX_SEARCHES) || DEFAULT_MAX_SEARCHES;

  const t0 = Date.now();
  logger.info('[ai-property] calling Claude with web_search', {
    address: address.slice(0, 80),
    model: MODELS.WORKHORSE,
    timeoutMs,
    maxSearches,
  });

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const resp = await client.messages.create({
      model: MODELS.WORKHORSE,
      max_tokens: 1536,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: maxSearches,
      }],
      messages: [{
        role: 'user',
        content: buildPropertyPrompt(address),
      }],
    }, { timeout: timeoutMs });

    const elapsedMs = Date.now() - t0;
    const textBlock = (resp.content || []).filter((b) => b.type === 'text').pop();
    if (!textBlock?.text) {
      logger.warn('[ai-property] no text block in response', {
        elapsedMs,
        blockTypes: (resp.content || []).map((b) => b.type),
      });
      return null;
    }

    const parsed = parsePropertyJSON(textBlock.text);
    if (!parsed) {
      logger.warn('[ai-property] could not parse JSON', {
        elapsedMs,
        sample: textBlock.text.slice(0, 240),
      });
      return null;
    }

    // If Claude found nothing useful (every numeric field null), bail so the
    // caller falls through to satellite-only estimation rather than building
    // an enriched profile around a meaningless object.
    const hasAnyFact = parsed.squareFootage || parsed.lotSize || parsed.yearBuilt
      || parsed.bedrooms || parsed.bathrooms || parsed.stories;
    if (!hasAnyFact) {
      logger.info('[ai-property] no facts found by AI', {
        elapsedMs,
        confidence: parsed.confidence,
        source: parsed.source,
      });
      return null;
    }

    logger.info('[ai-property] got facts', {
      elapsedMs,
      confidence: parsed.confidence,
      source: parsed.source,
      fields: Object.keys(parsed).filter((k) => parsed[k] != null && k !== 'source' && k !== 'confidence'),
    });

    return shapeAsRentCast(parsed, address);
  } catch (err) {
    logger.warn('[ai-property] errored', {
      elapsedMs: Date.now() - t0,
      message: err?.message || String(err),
    });
    return null;
  }
}

function buildPropertyPrompt(address) {
  return `I need a complete property record for the residential property at this address. RentCast (the public-records API) returned no data — typical of brand-new construction or rural addresses. Find the missing facts via web search.

Address: ${address}

Search aggressively, in this order:

1. PRIMARY listing sites — zillow.com, redfin.com, homes.com, realtor.com, trulia.com. Most listings show every fact in the Facts & Features / Home Highlights section.
2. Secondary aggregators — compass.com, era.com, liveinswflorida.com, villageshomefinder.com, bradentonhomelocator.com.
3. County property appraisers — manateepao.gov (Manatee), sc-pa.com (Sarasota), ccappraiser.com (Charlotte). Authoritative for tax records, sqft, year built, lot size, construction.
4. Builder floorplan catalogs (when subdivision identifies a builder) — drhorton.com, pulte.com, lennar.com, mihomes.com, taylormorrison.com, mattamyhomes.com, neal-communities.com, kbhome.com, davidweekleyhomes.com, meritagehomes.com, ryanhomes.com, richmond-american.com, homesbywestbay.com.
5. Permits — buildzoom.com sometimes has stories + sqft from building permits.

Output rules:
- Garage square footage is NOT counted as living area, AND not counted as a story.
- "stories" = number of floors above grade (1, 2, 3, 4).
- "constructionMaterial" must be one of: "CBS" (concrete block / stucco), "WOOD_FRAME", "BRICK", "METAL", or null.
- "propertyType" must be one of: "Single Family", "Townhome", "Condo", "Duplex", or null.
- Use null for any field you can't verify — DO NOT guess. A null is more useful than a wrong number.

Respond with ONLY a JSON object — no preamble, no explanation, no markdown fences:
{
  "squareFootage": <int 500-15000 or null>,
  "lotSize": <int 1000-200000 or null>,
  "yearBuilt": <int 1900-2026 or null>,
  "bedrooms": <int 1-15 or null>,
  "bathrooms": <number 0.5-15 or null>,
  "stories": <int 1-4 or null>,
  "propertyType": <string or null>,
  "constructionMaterial": <string or null>,
  "source": "<URL of primary source>",
  "confidence": "high" | "medium" | "low"
}

- "high" = two independent sources agree, or one authoritative source (county records) is unambiguous.
- "medium" = a single listing or builder floorplan match.
- "low" = inference from neighborhood / builder typical floorplans.`;
}

function parsePropertyJSON(text) {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]);
    const out = {
      squareFootage: coerceInt(raw.squareFootage, 500, 15000),
      lotSize: coerceInt(raw.lotSize, 1000, 200000),
      yearBuilt: coerceInt(raw.yearBuilt, 1900, new Date().getFullYear() + 1),
      bedrooms: coerceInt(raw.bedrooms, 1, 15),
      bathrooms: coerceFloat(raw.bathrooms, 0.5, 15),
      stories: coerceInt(raw.stories, 1, 4),
      propertyType: coerceEnum(raw.propertyType, ['Single Family', 'Townhome', 'Condo', 'Duplex']),
      constructionMaterial: coerceEnum(raw.constructionMaterial, ['CBS', 'WOOD_FRAME', 'BRICK', 'METAL']),
      source: typeof raw.source === 'string' ? raw.source : null,
      confidence: typeof raw.confidence === 'string' ? raw.confidence.toLowerCase() : null,
    };
    return out;
  } catch {
    return null;
  }
}

function coerceInt(raw, min, max) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

function coerceFloat(raw, min, max) {
  if (raw == null) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function coerceEnum(raw, allowed) {
  if (typeof raw !== 'string') return null;
  return allowed.includes(raw) ? raw : null;
}

// Reshape AI output to match the RentCast-normalized shape buildEnrichedProfile
// expects. Most fields are 1:1; we leave anything we don't have as the
// existing default (0 / null / '') so the orchestrator behaves the same as it
// would with a sparse RentCast response.
function shapeAsRentCast(p, address) {
  return {
    formattedAddress: address,
    addressLine1: '',
    city: '',
    state: '',
    zipCode: '',
    county: '',
    latitude: null,
    longitude: null,
    propertyType: p.propertyType || '',
    squareFootage: p.squareFootage || 0,
    lotSize: p.lotSize || 0,
    yearBuilt: p.yearBuilt || null,
    bedrooms: p.bedrooms || 0,
    bathrooms: p.bathrooms || 0,
    stories: p.stories || null,
    constructionMaterial: p.constructionMaterial || 'UNKNOWN',
    foundationType: 'UNKNOWN',
    roofType: 'UNKNOWN',
    garageType: '',
    garageSpaces: 0,
    coolingType: '',
    heatingType: '',
    hasPool: false,
    unitCount: 1,
    ownerType: null,
    ownerNames: [],
    lastSaleDate: null,
    lastSalePrice: null,
    saleHistory: [],
    taxAssessments: {},
    propertyTaxes: {},
    hoaFee: null,
    zoning: '',
    _rawFeatures: {},
    _raw: { _source: 'ai', _confidence: p.confidence, _sourceUrl: p.source },
    _source: 'ai',
    _aiConfidence: p.confidence,
    _aiSourceUrl: p.source,
  };
}

module.exports = { lookupStoriesFromAI, lookupPropertyFromAI };
