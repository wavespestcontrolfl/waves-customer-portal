/**
 * AI-powered property lookup helpers.
 *
 * The previous Apify-based scraper ran but got blocked by Zillow's anti-bot.
 * This module replaces it with a Claude call that uses the web_search tool to
 * pull stories from Zillow / Realtor / county records and synthesize a
 * confidence-rated answer.
 *
 * Individual providers are gated on their own API keys.
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
const DEFAULT_COUNTY_TIMEOUT_MS = 8000;
const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';
const OPENAI_PROPERTY_MODEL = process.env.OPENAI_PROPERTY_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini';
const GEMINI_PROPERTY_MODEL = process.env.GEMINI_PROPERTY_MODEL || 'gemini-2.5-flash';
const MANATEE_PAO_BASE = 'https://www.manateepao.gov';
const MANATEE_PAO_SEARCH_URL = `${MANATEE_PAO_BASE}/wp-content/themes/frontier-child/models/pao-model-parcel-search-results.php`;
const MANATEE_PAO_LAND_URL = `${MANATEE_PAO_BASE}/wp-content/themes/frontier-child/models/pao-model-land.php`;
const MANATEE_PAO_BUILDINGS_URL = `${MANATEE_PAO_BASE}/wp-content/themes/frontier-child/models/pao-model-buildings.php`;
const COUNTY_LOOKUP_MIN_REMAINING_MS = 750;
const MANATEE_CITY_NAMES = new Set([
  'ANNA MARIA',
  'BRADENTON',
  'BRADENTON BEACH',
  'CORTEZ',
  'DUETTE',
  'ELLENTON',
  'HOLMES BEACH',
  'LAKEWOOD RANCH',
  'LONGBOAT KEY',
  'MYAKKA CITY',
  'ONECO',
  'PALMETTO',
  'PARRISH',
  'RUBONIA',
  'TERRA CEIA',
  'UNIVERSITY PARK',
  'WHITFIELD',
]);
const MANATEE_ZIPS = new Set([
  '34201', '34202', '34203', '34204', '34205', '34206', '34207', '34208', '34209',
  '34210', '34211', '34212', '34215', '34216', '34217', '34218', '34219', '34220',
  '34221', '34222', '34228', '34243', '34250', '34251', '34264', '34270', '34280',
  '34281', '34282',
]);
const MANATEE_SHARED_ZIPS = new Set(['34228', '34243']);
const DIRECT_PROPERTY_RECORD_PROVIDERS = new Set(['manatee_pao']);
const PROPERTY_EVIDENCE_FIELDS = [
  'propertyType', 'squareFootage', 'lotSize', 'yearBuilt', 'bedrooms', 'bathrooms',
  'stories', 'constructionMaterial', 'foundationType', 'roofType',
];

const SOURCE_TYPE_WEIGHTS = {
  county: 100,
  permit: 95,
  builder: 85,
  listing: 75,
  aggregator: 55,
  generic: 25,
  unknown: 20,
};

const SOURCE_TYPE_LABELS = {
  county: 'county record',
  permit: 'permit record',
  builder: 'builder/floorplan',
  listing: 'listing',
  aggregator: 'aggregator',
  generic: 'generic web source',
  unknown: 'unknown source',
};

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function lookupStoriesFromAI(address, hints = {}, options = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.info('[ai-stories] skipped — ANTHROPIC_API_KEY not set');
    return null;
  }
  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    logger.warn('[ai-stories] skipped — address missing or too short');
    return null;
  }

  const configuredTimeoutMs = positiveInt(process.env.AI_STORIES_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const timeoutMs = positiveInt(options.timeoutMs, configuredTimeoutMs);
  const maxSearches = positiveInt(options.maxSearches || process.env.AI_STORIES_MAX_SEARCHES, DEFAULT_MAX_SEARCHES);

  const t0 = Date.now();
  logger.info('[ai-stories] calling Claude with web_search', {
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
        textLength: textBlock.text.length,
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
      error: summarizeProviderError(err),
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
    ? `\nKnown property facts (use these to triangulate):\n${hintLines.map((l) => `- ${l}`).join('\n')}\n`
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
// FULL PROPERTY LOOKUP
// ─────────────────────────────────────────────
// Pulls every public fact the pricing engine cares about (sqft, lot, year
// built, beds, baths, stories, property type, construction material).
// Returns the same normalized property-record shape used by the estimator.
async function lookupPropertyFromManateePAO(address, options = {}) {
  if (!address || typeof address !== 'string' || address.trim().length < 5) return null;
  if (!shouldQueryManateePAO(address)) return null;

  const timeoutMs = positiveInt(options.timeoutMs || process.env.COUNTY_PROPERTY_TIMEOUT_MS, DEFAULT_COUNTY_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const search = await searchManateeParcel(address, timeoutMs, t0);
    if (!search?.parcelId) return null;

    const remainingMs = remainingCountyLookupMs(t0, timeoutMs);
    if (remainingMs < COUNTY_LOOKUP_MIN_REMAINING_MS) return null;

    const [land, buildings] = await Promise.all([
      fetchManateePaoJson(`${MANATEE_PAO_LAND_URL}?parid=${encodeURIComponent(search.parcelId)}`, remainingMs),
      fetchManateePaoJson(`${MANATEE_PAO_BUILDINGS_URL}?parid=${encodeURIComponent(search.parcelId)}`, remainingMs),
    ]);

    const parsed = parseManateePaoRecord({ address, search, land, buildings });
    if (!hasAnyPropertyFact(parsed)) {
      logger.info('[county-property] Manatee PAO found parcel but no usable facts', {
        elapsedMs: Date.now() - t0,
        parcelId: search.parcelId,
      });
      return null;
    }

    const record = shapeAsPropertyRecord(parsed, address, 'manatee_pao');
    record._source = 'county';
    record._raw = {
      ...(record._raw || {}),
      _source: 'county',
      _provider: 'manatee_pao',
      parcelId: search.parcelId,
      situsAddress: search.situsAddress,
      postalCity: search.city,
      land,
      buildings,
    };
    record.addressLine1 = search.situsAddress || '';
    record.city = search.city || '';
    record.state = 'FL';
    record.county = 'Manatee';
    record._provider = 'manatee_pao';
    record._aiProviders = ['manatee_pao'];

    logger.info('[county-property] got Manatee PAO facts', {
      elapsedMs: Date.now() - t0,
      parcelId: search.parcelId,
      fields: Object.keys(parsed).filter((k) => parsed[k] != null && k !== 'source' && k !== 'confidence'),
    });
    return record;
  } catch (err) {
    logger.warn('[county-property] Manatee PAO errored', {
      elapsedMs: Date.now() - t0,
      error: summarizeProviderError(err),
    });
    return null;
  }
}

async function lookupPropertyFromAI(address) {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.info('[ai-property] skipped — ANTHROPIC_API_KEY not set');
    return null;
  }
  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    logger.warn('[ai-property] skipped — address missing or too short');
    return null;
  }

  const timeoutMs = positiveInt(process.env.AI_PROPERTY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxSearches = positiveInt(process.env.AI_PROPERTY_MAX_SEARCHES, DEFAULT_MAX_SEARCHES);

  const t0 = Date.now();
  logger.info('[ai-property] calling Claude with web_search', {
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
        textLength: textBlock.text.length,
      });
      return null;
    }

    // If Claude found nothing useful (every numeric field null), bail so the
    // caller falls through to satellite-only estimation rather than building
    // an enriched profile around a meaningless object.
    if (!hasAnyPropertyFact(parsed)) {
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

    return shapeAsPropertyRecord(parsed, address, 'claude');
  } catch (err) {
    logger.warn('[ai-property] errored', {
      elapsedMs: Date.now() - t0,
      error: summarizeProviderError(err),
    });
    return null;
  }
}

async function lookupPropertyFromOpenAI(address) {
  if (!process.env.OPENAI_API_KEY) {
    logger.info('[ai-property] skipped OpenAI — OPENAI_API_KEY not set');
    return null;
  }
  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    logger.warn('[ai-property] skipped OpenAI — address missing or too short');
    return null;
  }

  const timeoutMs = positiveInt(process.env.AI_PROPERTY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  try {
    logger.info('[ai-property] calling OpenAI with web_search', {
      model: OPENAI_PROPERTY_MODEL,
      timeoutMs,
    });

    const resp = await fetch(OPENAI_RESPONSES_API, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_PROPERTY_MODEL,
        tools: [{
          type: 'web_search_preview',
          user_location: {
            type: 'approximate',
            country: 'US',
            region: 'Florida',
            timezone: 'America/New_York',
          },
        }],
        tool_choice: 'auto',
        include: ['web_search_call.action.sources'],
        input: buildPropertyPrompt(address),
      }),
    });

    clearTimeout(timer);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 240)}`);
    }

    const data = await resp.json();
    const text = extractOpenAIText(data);
    const parsed = text ? parsePropertyJSON(text) : null;
    if (!parsed) {
      logger.warn('[ai-property] OpenAI could not parse JSON', {
        elapsedMs: Date.now() - t0,
        textLength: (text || '').length,
      });
      return null;
    }
    if (!hasAnyPropertyFact(parsed)) {
      logger.info('[ai-property] OpenAI found no usable facts', {
        elapsedMs: Date.now() - t0,
        confidence: parsed.confidence,
        source: parsed.source,
      });
      return null;
    }
    const record = shapeAsPropertyRecord(parsed, address, 'openai');
    record._aiSources = extractOpenAISources(data).map((source) => {
      const meta = classifyPropertySource(source.url);
      return { ...source, sourceType: meta.type, sourceQuality: meta.weight };
    });
    if (!record._aiSourceUrl && record._aiSources.length) record._aiSourceUrl = record._aiSources[0].url;
    refreshRecordSourceEvidence(record);
    return record;
  } catch (err) {
    clearTimeout(timer);
    logger.warn('[ai-property] OpenAI errored', {
      elapsedMs: Date.now() - t0,
      error: summarizeProviderError(err),
    });
    return null;
  }
}

async function lookupPropertyFromGemini(address) {
  if (!process.env.GEMINI_API_KEY) {
    logger.info('[ai-property] skipped Gemini — GEMINI_API_KEY not set');
    return null;
  }
  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    logger.warn('[ai-property] skipped Gemini — address missing or too short');
    return null;
  }

  const timeoutMs = positiveInt(process.env.AI_PROPERTY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  try {
    logger.info('[ai-property] calling Gemini with googleSearch', {
      model: GEMINI_PROPERTY_MODEL,
      timeoutMs,
    });

    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_PROPERTY_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPropertyPrompt(address) }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
      }),
    });

    clearTimeout(timer);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gemini ${resp.status}: ${text.slice(0, 240)}`);
    }

    const data = await resp.json();
    const text = extractGeminiText(data);
    const parsed = text ? parsePropertyJSON(text) : null;
    if (!parsed) {
      logger.warn('[ai-property] Gemini could not parse JSON', {
        elapsedMs: Date.now() - t0,
        textLength: (text || '').length,
      });
      return null;
    }
    if (!hasAnyPropertyFact(parsed)) {
      logger.info('[ai-property] Gemini found no usable facts', {
        elapsedMs: Date.now() - t0,
        confidence: parsed.confidence,
        source: parsed.source,
      });
      return null;
    }
    return shapeAsPropertyRecord(parsed, address, 'gemini');
  } catch (err) {
    clearTimeout(timer);
    logger.warn('[ai-property] Gemini errored', {
      elapsedMs: Date.now() - t0,
      error: summarizeProviderError(err),
    });
    return null;
  }
}

async function lookupPropertyFromAITrio(address) {
  const countyRecord = await lookupPropertyFromManateePAO(address).catch((err) => {
    logger.warn('[county-property] lookup failed before AI fallback', {
      error: summarizeProviderError(err),
    });
    return null;
  });
  if (countyRecord && hasCountyPricingCore(countyRecord)) {
    return mergePropertyRecords([countyRecord], address);
  }

  const results = await Promise.allSettled([
    lookupPropertyFromAI(address),
    lookupPropertyFromOpenAI(address),
    lookupPropertyFromGemini(address),
  ]);
  const records = [
    countyRecord,
    ...results
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => r.value),
  ].filter(Boolean);

  if (!records.length) return null;
  return mergePropertyRecords(records, address);
}

async function searchManateeParcel(address, timeoutMs, startedAt = Date.now()) {
  const candidates = manateeAddressSearchCandidates(address);
  for (const candidate of candidates) {
    const requestTimeoutMs = remainingCountyLookupMs(startedAt, timeoutMs);
    if (requestTimeoutMs < COUNTY_LOOKUP_MIN_REMAINING_MS) return null;

    const searchQ = JSON.stringify([
      { name: 'Address', value: candidate },
      { name: 'RollType', value: 'REAL PROPERTY' },
    ]);
    const body = new URLSearchParams();
    body.set('SearchQ', searchQ);
    body.set('VisitorIP', '127.0.0.1');

    const data = await fetchManateePaoJson(MANATEE_PAO_SEARCH_URL, requestTimeoutMs, {
      method: 'POST',
      body,
    });
    const match = pickManateeSearchResult(data, address);
    if (match) return match;
  }
  return null;
}

function remainingCountyLookupMs(startedAt, timeoutMs) {
  return Math.max(0, timeoutMs - (Date.now() - startedAt));
}

async function fetchManateePaoJson(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Origin: MANATEE_PAO_BASE,
        Referer: `${MANATEE_PAO_BASE}/search/`,
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (compatible; WavesPropertyLookup/1.0)',
        ...(init.headers || {}),
      },
    });
    if (!resp.ok) throw new Error(`Manatee PAO ${resp.status}`);
    return resp.json();
  } finally {
    clearTimeout(timer);
  }
}

function manateeAddressSearchCandidates(address) {
  const street = normalizeCountyStreetLine(address);
  if (!street) return [];

  const candidates = [street];
  const withoutSuffix = removeStreetSuffix(street);
  if (withoutSuffix && withoutSuffix !== street) candidates.push(withoutSuffix);

  const parts = withoutSuffix.split(/\s+/).filter(Boolean);
  if (parts.length >= 4) candidates.push(parts.slice(0, 4).join(' '));
  if (parts.length >= 3) candidates.push(parts.slice(0, 3).join(' '));

  return [...new Set(candidates.filter((candidate) => candidate.length >= 5))];
}

function shouldQueryManateePAO(address) {
  const zip = extractAddressZip(address);
  if (zip) return MANATEE_ZIPS.has(zip);

  const city = extractCommaCity(address);
  if (!city) return false;
  return MANATEE_CITY_NAMES.has(city);
}

function extractAddressZip(address) {
  return String(address || '').match(/\b(\d{5})(?:-\d{4})?\b/)?.[1] || null;
}

function extractCommaCity(address) {
  const parts = String(address || '').split(',').map((part) => normalizeCountyCityName(part)).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[1].replace(/\bFL(?:ORIDA)?\b.*$/i, '').replace(/\s+\d{5}(?:-\d{4})?$/, '').trim();
}

function normalizeCountyCityName(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCountyStreetLine(address) {
  const firstLine = String(address || '').split(',')[0] || '';
  return firstLine
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\bNORTH\b/g, 'N')
    .replace(/\bSOUTH\b/g, 'S')
    .replace(/\bEAST\b/g, 'E')
    .replace(/\bWEST\b/g, 'W')
    .replace(/\bAVENUE\b/g, 'AVE')
    .replace(/\bBOULEVARD\b/g, 'BLVD')
    .replace(/\bCIRCLE\b/g, 'CIR')
    .replace(/\bCOURT\b/g, 'CT')
    .replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bLANE\b/g, 'LN')
    .replace(/\bPARKWAY\b/g, 'PKWY')
    .replace(/\bPLACE\b/g, 'PL')
    .replace(/\bROAD\b/g, 'RD')
    .replace(/\bSTREET\b/g, 'ST')
    .replace(/\bTERRACE\b/g, 'TER')
    .replace(/\bTRAIL\b/g, 'TRL')
    .replace(/\bWAY\b/g, 'WAY')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeStreetSuffix(street) {
  return String(street || '')
    .replace(/\s+(AVE|BLVD|CIR|CT|DR|LN|PKWY|PL|RD|ST|TER|TRL|WAY)\b.*$/i, '')
    .trim();
}

function extractStreetSuffix(street) {
  return String(street || '').match(/\b(AVE|BLVD|CIR|CT|DR|LN|PKWY|PL|RD|ST|TER|TRL|WAY)\b/i)?.[1]?.toUpperCase() || null;
}

function extractPostSuffixDirection(street) {
  return String(street || '').match(/\b(?:AVE|BLVD|CIR|CT|DR|LN|PKWY|PL|RD|ST|TER|TRL|WAY)\s+([NSEW])\b/i)?.[1]?.toUpperCase() || null;
}

function pickManateeSearchResult(data, address) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  if (!rows.length) return null;

  const cols = Array.isArray(data?.cols) ? data.cols : [];
  const parcelIdx = findPaoColumnIndex(cols, ['Parcel ID', 'Parcel']);
  const addressIdx = findPaoColumnIndex(cols, ['Situs Address', 'Address']);
  const cityIdx = findPaoColumnIndex(cols, ['Postal City', 'City']);

  const target = normalizeCountyStreetLine(address);
  const targetNoSuffix = removeStreetSuffix(target);
  const targetNumber = target.match(/^\d+/)?.[0] || null;
  const targetCity = shouldRequireManateeResultCityMatch(address) ? extractCommaCity(address) : null;
  const candidates = rows
    .map((row) => ({
      parcelId: cleanPaoCell(row[parcelIdx >= 0 ? parcelIdx : 0]),
      situsAddress: cleanPaoCell(row[addressIdx >= 0 ? addressIdx : 3]),
      city: cleanPaoCell(row[cityIdx >= 0 ? cityIdx : 4]),
    }))
    .map((row) => ({ ...row, normalizedAddress: normalizeCountyStreetLine(row.situsAddress) }))
    .filter((row) => row.parcelId && row.situsAddress)
    .filter((row) => {
      if (targetNumber && !row.normalizedAddress.startsWith(`${targetNumber} `)) return false;
      if (targetCity && normalizeCountyCityName(row.city) !== targetCity) return false;
      return true;
    });

  const exactMatches = candidates.filter((row) => row.normalizedAddress === target);
  const exactMatch = pickUniqueManateeMatch(exactMatches, address);
  if (exactMatch) return exactMatch;
  if (exactMatches.length > 1) return null;

  const prefixMatches = candidates.filter((row) => row.normalizedAddress.startsWith(`${target} `));
  const prefixMatch = pickUniqueManateeMatch(prefixMatches, address);
  if (prefixMatch) return prefixMatch;

  const relaxedMatches = candidates.filter((row) => isRelaxedManateeStreetMatch(row.normalizedAddress, target, targetNoSuffix));
  if (relaxedMatches.length === 1 && shouldQueryManateePAO(address)) {
    return cleanManateeSearchMatch(relaxedMatches[0]);
  }
  return null;
}

function shouldRequireManateeResultCityMatch(address) {
  if (!extractCommaCity(address)) return false;
  const zip = extractAddressZip(address);
  // PAO postal city can differ from the entered municipality; require it when
  // the ZIP cannot disambiguate the Manatee parcel search by itself.
  return !zip || MANATEE_SHARED_ZIPS.has(zip);
}

function isRelaxedManateeStreetMatch(normalizedAddress, target, targetNoSuffix) {
  const targetSuffix = extractStreetSuffix(target);
  const resultSuffix = extractStreetSuffix(normalizedAddress);
  if (targetSuffix && resultSuffix !== targetSuffix) return false;

  const targetDirection = extractPostSuffixDirection(target);
  const resultDirection = extractPostSuffixDirection(normalizedAddress);
  if (targetDirection && resultDirection !== targetDirection) return false;

  return removeStreetSuffix(normalizedAddress) === targetNoSuffix;
}

function pickUniqueManateeMatch(matches, address) {
  if (matches.length === 1) return cleanManateeSearchMatch(matches[0]);
  if (matches.length < 2) return null;

  const targetCity = extractCommaCity(address);
  if (!targetCity) return null;

  const cityMatches = matches.filter((row) => normalizeCountyCityName(row.city) === targetCity);
  return cityMatches.length === 1 ? cleanManateeSearchMatch(cityMatches[0]) : null;
}

function cleanManateeSearchMatch(row) {
  const { normalizedAddress, ...match } = row;
  return match;
}

function parseManateePaoRecord({ address, search, land, buildings }) {
  const buildingRows = parsePaoRows(buildings);
  const landRows = parsePaoRows(land);
  const primaryBuilding = buildingRows
    .filter((row) => String(row.Type || row.Classification || '').toUpperCase().includes('RES'))
    .sort((a, b) => coerceInt(b.LivBus, 0, 100000) - coerceInt(a.LivBus, 0, 100000))[0]
    || buildingRows.sort((a, b) => coerceInt(b.LivBus, 0, 100000) - coerceInt(a.LivBus, 0, 100000))[0]
    || {};

  const lotSize = landRows.reduce((sum, row) => sum + (coerceLotSize(row.SqFootage) || 0), 0) || null;
  const rooms = parseManateeRooms(primaryBuilding.Rooms);
  const propertyType = normalizeManateePropertyType(primaryBuilding.Type, primaryBuilding.Classification);
  const source = `${MANATEE_PAO_BASE}/parcel/?parid=${encodeURIComponent(search.parcelId)}`;

  return {
    squareFootage: coerceInt(primaryBuilding.LivBus, 500, 15000),
    lotSize,
    yearBuilt: coerceInt(primaryBuilding.Yrblt, 1900, new Date().getFullYear() + 1),
    bedrooms: rooms.bedrooms,
    bathrooms: rooms.bathrooms,
    stories: coerceInt(primaryBuilding.Stories, 1, 4),
    propertyType,
    constructionMaterial: normalizeManateeConstruction(primaryBuilding['Const/ExtWall']),
    roofType: normalizeManateeRoof(primaryBuilding.RoofMaterial, primaryBuilding.RoofType),
    source,
    confidence: 'high',
    county: 'Manatee',
    formattedAddress: [search.situsAddress, search.city, 'FL'].filter(Boolean).join(', ') || address,
  };
}

function parsePaoRows(table) {
  const cols = Array.isArray(table?.cols) ? table.cols : [];
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const names = cols.map((col) => normalizePaoColumnTitle(col?.title));
  return rows.map((row) => names.reduce((out, name, index) => {
    if (name) out[name] = cleanPaoCell(row[index]);
    return out;
  }, {}));
}

function normalizePaoColumnTitle(title) {
  const compact = String(title || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const aliases = {
    parcelid: 'ParcelId',
    situsaddress: 'SitusAddress',
    postalcity: 'PostalCity',
    sqftlivingarea: 'SqFtLivingArea',
    sqfootage: 'SqFootage',
    yrblt: 'Yrblt',
    livbus: 'LivBus',
    constextwall: 'Const/ExtWall',
    roofmaterial: 'RoofMaterial',
    rooftype: 'RoofType',
  };
  return aliases[compact] || String(title || '').trim();
}

function findPaoColumnIndex(cols, titles) {
  const normalizedTitles = titles.map((title) => normalizePaoColumnTitle(title).toLowerCase());
  return cols.findIndex((col) => normalizedTitles.includes(normalizePaoColumnTitle(col?.title).toLowerCase()));
}

function cleanPaoCell(value) {
  if (value == null) return '';
  return String(value).replace(/^;+|;+$/g, '').replace(/;/g, '; ').replace(/\s+/g, ' ').trim();
}

function parseManateeRooms(value) {
  const parts = String(value || '').split('/').map((part) => Number(part));
  const bedrooms = Number.isFinite(parts[0]) && parts[0] > 0 ? Math.round(parts[0]) : null;
  const fullBaths = Number.isFinite(parts[1]) ? parts[1] : null;
  const halfBaths = Number.isFinite(parts[2]) ? parts[2] : 0;
  return {
    bedrooms,
    bathrooms: fullBaths == null ? null : fullBaths + (halfBaths * 0.5),
  };
}

function normalizeManateePropertyType(type, classification) {
  const text = `${type || ''} ${classification || ''}`.toUpperCase();
  if (/TOWN\s*HOME|TOWN\s*HOUSE|TOWNHOUSE/.test(text)) return 'Townhome';
  if (/DUPLEX/.test(text)) return 'Duplex';
  if (/APT|APARTMENT/.test(text)) return 'Apartment';
  if (/CONDO/.test(text)) return 'Condo';
  if (/MULTI|TRIPLEX|QUADPLEX|FOURPLEX/.test(text)) return 'Multifamily';
  if (/MEDICAL/.test(text)) return 'Medical Office';
  if (/OFFICE/.test(text)) return 'Office';
  if (/RETAIL/.test(text)) return 'Retail';
  if (/WAREHOUSE/.test(text)) return 'Warehouse';
  if (/RESTAURANT/.test(text)) return 'Restaurant';
  if (/SCHOOL/.test(text)) return 'School';
  if (/INDUSTRIAL/.test(text)) return 'Industrial';
  if (/COM|COMMERCIAL/.test(text)) return 'Commercial';
  if (/RES|RESIDENTIAL/.test(text)) return 'Single Family';
  return null;
}

function normalizeManateeConstruction(value) {
  const text = String(value || '').toUpperCase();
  if (/WOOD|FRAME/.test(text)) return 'WOOD_FRAME';
  if (/BRICK/.test(text)) return 'BRICK';
  if (/METAL|STEEL/.test(text)) return 'METAL';
  if (/MASONRY|CONCRETE|BLOCK|CBS|CMU/.test(text)) return 'CBS';
  return null;
}

function normalizeManateeRoof(material, type) {
  const text = `${material || ''} ${type || ''}`.toUpperCase();
  if (/TILE|CLAY|BARREL/.test(text)) return 'TILE';
  if (/SHINGLE|SHINGLES|COMP|ASPHALT/.test(text)) return 'SHINGLE';
  if (/METAL|STEEL|TIN/.test(text)) return 'METAL';
  if (/FLAT|BUILT|TPO|MEMBRANE/.test(text)) return 'FLAT';
  return String(material || type || '').trim() || null;
}

function countCriticalPropertyFields(record) {
  return [record?.squareFootage, record?.lotSize, record?.stories, record?.propertyType].filter(Boolean).length;
}

function hasCountyPricingCore(record) {
  return !!(record?.squareFootage && record?.lotSize && record?.propertyType);
}

function buildPropertyPrompt(address) {
  return `I need a complete property record for the property at this address. Find the missing facts via web search.

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
- "lotSize" is a CRITICAL pricing field. If the first listing says N/A or omits the lot, search the exact address again with "lot size square feet", "Lot Size Square Feet", "acre lot", and the county property appraiser before leaving it null.
- "lotSize" MUST be in square feet. If the exact-property source shows the lot in acres (e.g. "0.25 acres"), CONVERT to square feet by multiplying acres × 43560 before outputting. Example: "0.25 acres" → 10890.
- Do NOT borrow lot size from a nearby home, comparable, neighborhood median, or builder community page unless it is explicitly for the exact address.
- If the converted lot size is above 200000 square feet, output 200000 so the public quote flow prices at its maximum lot-size cap instead of defaulting to a small lot.
- "constructionMaterial" must be one of: "CBS" (concrete block / stucco), "WOOD_FRAME", "BRICK", "METAL", or null.
- "propertyType" must be one of: "Single Family", "Townhome", "Condo", "Duplex", "Commercial", "Office", "Retail", "Warehouse", "Restaurant", "Medical Office", "School", "Industrial", "Multifamily", "Apartment", "HOA Common Area", or null.
- The "source" URL must be the exact property page, parcel page, permit page, or builder floorplan/community page used for the facts.
- Do NOT use generic city/category pages such as apartment directories, short-term-rental lists, or broad "homes for sale in city" pages as the source.
- Use null for any field you can't verify — DO NOT guess. A null is more useful than a wrong number.

Respond with ONLY a JSON object — no preamble, no explanation, no markdown fences:
{
  "squareFootage": <int 500-15000 or null>,
  "lotSize": <int 1000-200000, in SQUARE FEET for the exact property (convert from acres if needed; cap verified oversized lots at 200000), or null>,
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
      squareFootage: coerceFirstInt([
        raw.squareFootage,
        raw.square_footage,
        raw.homeSqFt,
        raw.home_sqft,
        raw.livingArea,
        raw.living_area,
        raw.livingAreaSqFt,
        raw.living_area_sqft,
        raw.sqft,
      ], 500, 15000),
      lotSize: coerceParsedLotSize(raw),
      yearBuilt: coerceInt(raw.yearBuilt, 1900, new Date().getFullYear() + 1),
      bedrooms: coerceInt(raw.bedrooms, 1, 15),
      bathrooms: coerceFloat(raw.bathrooms, 0.5, 15),
      stories: coerceInt(raw.stories, 1, 4),
      propertyType: normalizeLookupPropertyType(raw.propertyType),
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

function coerceFirstInt(values, min, max) {
  for (const value of values) {
    const parsed = coerceInt(value, min, max);
    if (parsed != null) return parsed;
  }
  return null;
}

const SQFT_PER_ACRE = 43560;
const LOT_SQFT_MIN = 1000;
const LOT_SQFT_MAX = 200_000;

function coerceParsedLotSize(raw) {
  if (!raw || typeof raw !== 'object') return coerceLotSize(raw);

  const lotCandidates = [
    raw.lotSize,
    raw.lot_size,
    raw.lotArea,
    raw.lot_area,
    raw.lot,
  ];
  for (const candidate of lotCandidates) {
    const structuredLotSize = coerceStructuredLotSize(candidate);
    if (structuredLotSize != null) return structuredLotSize;
  }

  const lotSqftCandidates = [
    raw.lotSize,
    raw.lot_size,
    raw.lotSqFt,
    raw.lot_sqft,
    raw.lotSizeSqFt,
    raw.lot_size_sqft,
    raw.lotSquareFeet,
    raw.lot_square_feet,
    raw.lotAreaSqFt,
    raw.lot_area_sqft,
    raw.lotAreaSquareFeet,
    raw.lot_area_square_feet,
    raw.lotArea,
    raw.lot_area,
    raw.lot,
  ];
  for (const candidate of lotSqftCandidates) {
    const lotSqft = coerceLotSize(candidate);
    if (lotSqft != null) return lotSqft;
  }

  const lotAcreCandidates = [
    raw.lotSizeAcres,
    raw.lot_size_acres,
    raw.lotAcres,
    raw.lot_acres,
    raw.lotAreaAcres,
    raw.lot_area_acres,
    raw.acres,
  ];
  for (const candidate of lotAcreCandidates) {
    if (candidate == null || candidate === '') continue;
    const lotAcres = coerceLotSize(`${candidate} acres`);
    if (lotAcres != null) return lotAcres;
  }

  return null;
}

function coerceStructuredLotSize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const sqftCandidates = [
    raw.squareFeet,
    raw.square_feet,
    raw.sqft,
    raw.sqFt,
    raw.sq_ft,
    raw.valueSqft,
    raw.value_sqft,
    raw.areaSqft,
    raw.area_sqft,
  ];
  for (const candidate of sqftCandidates) {
    const sqftValue = coerceLotSize(candidate);
    if (sqftValue != null) return sqftValue;
  }

  const acreCandidates = [raw.acres, raw.valueAcres, raw.value_acres, raw.areaAcres, raw.area_acres];
  for (const candidate of acreCandidates) {
    if (candidate == null || candidate === '') continue;
    const acresValue = coerceLotSize(`${candidate} acres`);
    if (acresValue != null) return acresValue;
  }

  const unit = String(raw.unit || raw.units || raw.uom || '').toLowerCase();
  const valueCandidates = [raw.value, raw.amount, raw.size, raw.area];
  for (const candidate of valueCandidates) {
    if (candidate == null || candidate === '') continue;
    if (/\bacre/.test(unit)) {
      const acresValue = coerceLotSize(`${candidate} acres`);
      if (acresValue != null) return acresValue;
    }
    if (/\bsq\.?\s*ft\b|\bsqft\b|\bsf\b|square\s*feet/.test(unit)) {
      const sqftValue = coerceLotSize(`${candidate} sqft`);
      if (sqftValue != null) return sqftValue;
    }
  }
  return null;
}

// Lot sizes show up two ways in source data: square feet ("8,712 sqft Lot")
// or acres ("5.99 Acres Lot", "1/2 acre"). The pricing engine always wants
// square feet, so we normalize here.
//   - Strings with "acre" → first number is acres, multiply by 43560.
//   - Strings with "sqft" / "sq ft" → first number is sqft.
//   - Bare numbers: small (< LOT_SQFT_MIN) are treated as acres only when
//     conversion stays within the public quote cap; larger ambiguous values
//     remain null.
//   - Verified values above the public quote max are capped, not discarded.
//   - Strings with BOTH "acre" and "sqft" (e.g. "0.5 acres (21,780 sqft)")
//     are accepted only when the unit-qualified values agree.
function coerceLotSize(raw) {
  if (raw == null) return null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const sqft = coerceUnqualifiedLotSqft(raw);
    return sqft == null ? null : clampLotSqft(Math.round(sqft));
  }

  const str = String(raw).toLowerCase();
  const hasAcre = /\bacre/.test(str);
  const hasSqft = /\bsq\.?\s*ft\b|\bsqft\b|\bsquare\s*feet\b/.test(str);
  if (hasAcre && hasSqft) {
    return coerceDualUnitLotSize(str);
  }

  const value = parseFirstLotNumber(str);
  if (value == null || value <= 0) return null;

  let sqft;
  if (hasAcre) sqft = value * SQFT_PER_ACRE;
  else if (hasSqft) sqft = value;
  else sqft = coerceUnqualifiedLotSqft(value);
  if (sqft == null) return null;

  const rounded = Math.round(sqft);
  return clampLotSqft(rounded);
}

function coerceUnqualifiedLotSqft(value) {
  if (value < LOT_SQFT_MIN) {
    const converted = value * SQFT_PER_ACRE;
    return converted <= LOT_SQFT_MAX ? converted : null;
  }
  return value;
}

function clampLotSqft(n) {
  if (!Number.isFinite(n) || n < LOT_SQFT_MIN) return null;
  return Math.min(n, LOT_SQFT_MAX);
}

function coerceDualUnitLotSize(str) {
  const acres = parseUnitQualifiedLotNumber(str, /acres?\b/);
  const sqft = parseUnitQualifiedLotNumber(str, /sq\.?\s*ft\b|sqft\b|square\s*feet\b/);

  const acreSqft = acres == null ? null : Math.round(acres * SQFT_PER_ACRE);
  const roundedSqft = sqft == null ? null : Math.round(sqft);

  if (acreSqft != null && roundedSqft != null) {
    if (!lotValuesAgree(acreSqft, roundedSqft)) return null;
    return clampLotSqft(roundedSqft);
  }

  const candidate = roundedSqft ?? acreSqft;
  return candidate != null ? clampLotSqft(candidate) : null;
}

function lotValuesAgree(a, b) {
  const tolerance = Math.max(250, Math.round(Math.max(a, b) * 0.02));
  return Math.abs(a - b) <= tolerance;
}

function parseUnitQualifiedLotNumber(str, unitPattern) {
  const numberPattern = String.raw`(\d+\s+\d+\/\d+|\d+\/\d+|\d[\d,]*(?:\.\d+)?)`;
  const re = new RegExp(`${numberPattern}\\s*-?\\s*(?:${unitPattern.source})`, 'i');
  const match = str.match(re);
  return match ? parseFirstLotNumber(match[1]) : null;
}

// Pull the FIRST numeric value out of a lot-size string. Supports mixed
// numbers ("1 1/2"), simple fractions ("1/2"), decimals ("5.99"), and
// comma-grouped integers ("21,780"). We deliberately do NOT strip all
// non-digit characters — that would merge "0.5 acres (21,780)" into a
// single bogus number, or turn "1/2" into "12".
function parseFirstLotNumber(str) {
  const mixed = str.match(/(\d+)\s+(\d+)\/(\d+)/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (Number.isFinite(whole) && Number.isFinite(num) && den > 0) {
      return whole + num / den;
    }
  }
  const frac = str.match(/(\d+)\/(\d+)/);
  if (frac) {
    const num = Number(frac[1]);
    const den = Number(frac[2]);
    if (Number.isFinite(num) && den > 0) return num / den;
  }
  const decimal = str.match(/\d[\d,]*(?:\.\d+)?/);
  if (decimal) {
    const n = Number(decimal[0].replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
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

function normalizeLookupPropertyType(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const key = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) return null;

  if (/(restaurant|food_service)/.test(key)) return 'Restaurant';
  if (/(medical|clinic)/.test(key)) return 'Medical Office';
  if (/(school|daycare)/.test(key)) return 'School';
  if (/(warehouse)/.test(key)) return 'Warehouse';
  if (/(industrial)/.test(key)) return 'Industrial';
  if (/(government|municipal)/.test(key)) return 'Government Municipal';
  if (/(office|retail|business|plaza|storefront|shop)/.test(key)) return 'Office';
  if (/(apartment|apartments|multi_family|multifamily)/.test(key)) return 'Multifamily';
  if (/(hoa_common|common_area)/.test(key)) return 'HOA Common Area';
  if (/(commercial)/.test(key)) {
    return 'Commercial';
  }
  if (/(townhome|town_home|townhouse)/.test(key)) return 'Townhome';
  if (/duplex/.test(key)) return 'Duplex';
  if (/(condo|condominium)/.test(key)) return 'Condo';
  if (/(single_family|single|house|home|residential)/.test(key)) return 'Single Family';
  return coerceEnum(text, [
    'Single Family',
    'Townhome',
    'Condo',
    'Duplex',
    'Commercial',
    'Office',
    'Retail',
    'Warehouse',
    'Restaurant',
    'Medical Office',
    'School',
    'Industrial',
    'Multifamily',
    'Apartment',
    'HOA Common Area',
  ]);
}

function hasAnyPropertyFact(parsed) {
  return !!(parsed?.squareFootage || parsed?.lotSize || parsed?.yearBuilt
    || parsed?.bedrooms || parsed?.bathrooms || parsed?.stories || parsed?.propertyType);
}

// Reshape AI output to match the normalized property-record shape
// buildEnrichedProfile expects. Most fields are 1:1; we leave anything we don't
// have as the existing default (0 / null / '') so the orchestrator behaves the
// same as it would with a sparse public-record response.
function shapeAsPropertyRecord(p, address, provider = 'ai') {
  const sourceMeta = classifyPropertySource(p.source);
  const evidence = buildRecordEvidence(p, provider, sourceMeta);
  const sourceKind = DIRECT_PROPERTY_RECORD_PROVIDERS.has(provider) ? 'county' : 'ai';
  return {
    formattedAddress: p.formattedAddress || address,
    addressLine1: '',
    city: '',
    state: '',
    zipCode: '',
    county: p.county || '',
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
    foundationType: p.foundationType || 'UNKNOWN',
    roofType: p.roofType || 'UNKNOWN',
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
    _raw: {
      _source: sourceKind,
      _provider: provider,
      _confidence: p.confidence,
      _sourceUrl: p.source,
      _sourceType: sourceMeta.type,
      _sourceQuality: sourceMeta.weight,
    },
    _source: sourceKind,
    _provider: provider,
    _aiConfidence: p.confidence,
    _aiSourceUrl: p.source,
    _aiSourceType: sourceMeta.type,
    _aiSourceQuality: sourceMeta.weight,
    _aiSources: p.source ? [{ provider, url: p.source, sourceType: sourceMeta.type, sourceQuality: sourceMeta.weight }] : [],
    _fieldEvidence: evidence,
  };
}

function mergePropertyRecords(records, address) {
  const sorted = [...records].sort((a, b) => evidenceBaseScore(b) - evidenceBaseScore(a));
  const merged = { ...sorted[0], formattedAddress: sorted[0].formattedAddress || address };
  const mergedFieldEvidence = {};

  for (const field of PROPERTY_EVIDENCE_FIELDS) {
    const candidates = sorted
      .map((record) => fieldEvidenceFromRecord(record, field))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) continue;

    const winner = candidates[0];
    if (!isMissingPropertyValue(winner.value)) {
      merged[field] = winner.value;
    }
    const uniqueValues = [...new Set(candidates.map((item) => normalizeEvidenceValue(item.value)))];
    mergedFieldEvidence[field] = {
      value: winner.value,
      confidence: scoreToConfidence(winner.score),
      sourceType: winner.sourceType,
      sourceLabel: SOURCE_TYPE_LABELS[winner.sourceType] || winner.sourceType,
      winningSource: winner.url || null,
      winningProvider: winner.provider,
      score: winner.score,
      disagreement: uniqueValues.length > 1,
      fieldVerify: winner.score < 65 || uniqueValues.length > 1 || winner.sourceType === 'generic' || winner.sourceType === 'unknown',
      evidence: candidates.map(({ score, ...item }) => ({ ...item, confidence: scoreToConfidence(score) })),
    };
  }

  const providers = [...new Set(sorted.map((r) => r._provider).filter(Boolean))];
  const sources = sorted.flatMap((r) => r._aiSources || (r._aiSourceUrl ? [{ provider: r._provider, url: r._aiSourceUrl }] : []));
  const sourceTypes = [...new Set(sources.map((s) => s.sourceType).filter(Boolean))];
  const sourceKinds = [...new Set(sorted.map((r) => r._source).filter(Boolean))];
  const hasCountySource = sorted.some((r) => r._source === 'county');
  const hasAiSource = sorted.some((r) => r._source === 'ai');
  merged._source = hasCountySource && !hasAiSource ? 'county' : hasCountySource ? 'hybrid' : 'ai';
  merged._provider = providers.join('+') || 'ai';
  merged._aiProviders = providers;
  merged._aiSources = sources;
  merged._aiSourceUrl = sources[0]?.url || sorted.find((r) => r._aiSourceUrl)?._aiSourceUrl || null;
  merged._aiSourceTypes = sourceTypes;
  merged._aiConfidence = scoreToConfidence(Math.max(...Object.values(mergedFieldEvidence).map((item) => item.score), 0));
  merged._fieldEvidence = mergedFieldEvidence;
  merged._dataQuality = buildPropertyDataQuality(mergedFieldEvidence, providers);
  merged._raw = {
    ...(merged._raw || {}),
    _source: merged._source === 'county' ? 'county' : merged._source === 'hybrid' ? 'county_ai' : 'ai_trio',
    _provider: merged._provider,
    _providers: providers,
    _sources: sources,
    _sourceTypes: sourceTypes,
    _sourceKinds: sourceKinds,
    _fieldEvidence: mergedFieldEvidence,
    _dataQuality: merged._dataQuality,
  };
  return merged;
}

function confidenceRank(confidence) {
  if (confidence === 'high') return 3;
  if (confidence === 'medium') return 2;
  if (confidence === 'low') return 1;
  return 0;
}

function evidenceBaseScore(record) {
  return (record?._aiSourceQuality || SOURCE_TYPE_WEIGHTS.unknown) + (confidenceRank(record?._aiConfidence) * 10);
}

function fieldEvidenceFromRecord(record, field) {
  if (!record || isMissingPropertyValue(record[field])) return null;
  const existing = record._fieldEvidence?.[field]?.[0];
  const sourceType = existing?.sourceType || record._aiSourceType || classifyPropertySource(record._aiSourceUrl).type;
  const sourceWeight = existing?.sourceQuality || record._aiSourceQuality || SOURCE_TYPE_WEIGHTS[sourceType] || SOURCE_TYPE_WEIGHTS.unknown;
  const confidence = existing?.providerConfidence || record._aiConfidence;
  const score = Math.min(100, sourceWeight + confidenceRank(confidence) * 10);
  return {
    field,
    value: record[field],
    provider: existing?.provider || record._provider || 'ai',
    url: existing?.url || record._aiSourceUrl || null,
    sourceType,
    sourceQuality: sourceWeight,
    providerConfidence: confidence || null,
    score,
  };
}

function buildRecordEvidence(parsed, provider, sourceMeta) {
  const evidence = {};
  for (const field of PROPERTY_EVIDENCE_FIELDS) {
    if (isMissingPropertyValue(parsed[field])) continue;
    evidence[field] = [{
      field,
      value: parsed[field],
      provider,
      url: parsed.source || null,
      sourceType: sourceMeta.type,
      sourceQuality: sourceMeta.weight,
      providerConfidence: parsed.confidence || null,
    }];
  }
  return evidence;
}

function refreshRecordSourceEvidence(record) {
  if (!record?._aiSourceUrl) return record;
  const meta = classifyPropertySource(record._aiSourceUrl);
  if (meta.weight > (record._aiSourceQuality || 0)) {
    record._aiSourceType = meta.type;
    record._aiSourceQuality = meta.weight;
    record._raw = {
      ...(record._raw || {}),
      _sourceUrl: record._aiSourceUrl,
      _sourceType: meta.type,
      _sourceQuality: meta.weight,
    };
  }
  for (const evidenceItems of Object.values(record._fieldEvidence || {})) {
    for (const item of evidenceItems || []) {
      if (!item.url) item.url = record._aiSourceUrl;
      if (!item.sourceType || item.sourceType === 'unknown') {
        item.sourceType = meta.type;
        item.sourceQuality = meta.weight;
      }
    }
  }
  return record;
}

function classifyPropertySource(url) {
  if (!url || typeof url !== 'string') return { type: 'unknown', weight: SOURCE_TYPE_WEIGHTS.unknown };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { type: 'unknown', weight: SOURCE_TYPE_WEIGHTS.unknown };
  }
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (host.includes('manateepao.gov') || host.includes('sc-pa.com') || host.includes('ccappraiser.com')) {
    return { type: 'county', weight: SOURCE_TYPE_WEIGHTS.county };
  }
  if (host.includes('buildzoom.com') || path.includes('permit')) {
    return { type: 'permit', weight: SOURCE_TYPE_WEIGHTS.permit };
  }
  if ([
    'drhorton.com', 'pulte.com', 'lennar.com', 'mihomes.com', 'taylormorrison.com',
    'mattamyhomes.com', 'neal-communities.com', 'kbhome.com', 'davidweekleyhomes.com',
    'meritagehomes.com', 'ryanhomes.com', 'richmondamerican.com', 'richmond-american.com',
    'homesbywestbay.com',
  ].some((domain) => host.includes(domain))) {
    return { type: 'builder', weight: SOURCE_TYPE_WEIGHTS.builder };
  }
  if (['zillow.com', 'redfin.com', 'homes.com', 'realtor.com', 'trulia.com', 'compass.com'].some((domain) => host.includes(domain))) {
    if (isGenericListingPath(path)) return { type: 'generic', weight: SOURCE_TYPE_WEIGHTS.generic };
    return { type: 'listing', weight: SOURCE_TYPE_WEIGHTS.listing };
  }
  if (['apartments.com', 'era.com', 'liveinswflorida.com', 'villageshomefinder.com', 'bradentonhomelocator.com'].some((domain) => host.includes(domain))) {
    if (isGenericListingPath(path)) return { type: 'generic', weight: SOURCE_TYPE_WEIGHTS.generic };
    return { type: 'aggregator', weight: SOURCE_TYPE_WEIGHTS.aggregator };
  }
  return { type: isGenericListingPath(path) ? 'generic' : 'unknown', weight: isGenericListingPath(path) ? SOURCE_TYPE_WEIGHTS.generic : SOURCE_TYPE_WEIGHTS.unknown };
}

function isGenericListingPath(path) {
  const normalized = String(path || '').toLowerCase();
  return normalized === '/'
    || normalized.includes('/short-term/')
    || normalized.includes('/apartments/')
    || normalized.includes('/real-estate/')
    || normalized.includes('/homes-for-sale/')
    || normalized.includes('/new-homes/')
    || /^\/[a-z-]+-fl\/?$/.test(normalized)
    || /^\/[a-z-]+-fl\/(rentals|short-term|apartments)\/?$/.test(normalized);
}

function normalizeEvidenceValue(value) {
  if (typeof value === 'string') return value.trim().toUpperCase();
  if (typeof value === 'number') return String(Math.round(value * 10) / 10);
  return JSON.stringify(value);
}

function scoreToConfidence(score) {
  if (score >= 95) return 'high';
  if (score >= 65) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}

function buildPropertyDataQuality(fieldEvidence, providers) {
  const values = Object.values(fieldEvidence || {});
  const criticalFields = ['squareFootage', 'lotSize', 'stories', 'propertyType'];
  const verifiedCriticalFields = criticalFields.filter((field) => fieldEvidence?.[field] && !fieldEvidence[field].fieldVerify);
  const criticalCovered = verifiedCriticalFields.length;
  const avgEvidenceScore = values.length
    ? Math.round(values.reduce((sum, item) => sum + (item.score || 0), 0) / values.length)
    : 0;
  const criticalCoverageScore = Math.round((criticalCovered / criticalFields.length) * 100);
  const avgScore = values.length ? Math.min(avgEvidenceScore, criticalCoverageScore) : 0;
  const verifyCount = values.filter((item) => item.fieldVerify).length;
  const sourceTypes = [...new Set(values.map((item) => item.sourceType).filter(Boolean))];
  const level = avgScore >= 85 && criticalCovered === criticalFields.length && verifyCount === 0
    ? 'high'
    : avgEvidenceScore >= 60 && criticalCovered >= 2
      ? 'medium'
      : 'low';
  return {
    level,
    score: avgScore,
    evidenceScore: avgEvidenceScore,
    criticalCoverageScore,
    providerCount: providers?.length || 0,
    providers: providers || [],
    sourceTypes,
    verifiedCriticalFields: criticalCovered,
    totalCriticalFields: criticalFields.length,
    missingCriticalFields: criticalFields.filter((field) => !fieldEvidence?.[field]),
    verifyCriticalFields: criticalFields.filter((field) => fieldEvidence?.[field]?.fieldVerify),
    fieldVerifyCount: verifyCount,
  };
}

function isMissingPropertyValue(value) {
  return value == null || value === '' || value === 0 || value === 'UNKNOWN';
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && content.text) parts.push(content.text);
      if (content?.type === 'text' && content.text) parts.push(content.text);
    }
  }
  return parts.join('');
}

function extractOpenAISources(data) {
  const sources = [];
  for (const item of data?.output || []) {
    const actionSources = item?.action?.sources || [];
    for (const source of actionSources) {
      if (source?.url) sources.push({ provider: 'openai', url: source.url, title: source.title || null });
    }
    for (const content of item?.content || []) {
      for (const ann of content?.annotations || []) {
        if (ann?.type === 'url_citation' && ann.url) {
          sources.push({ provider: 'openai', url: ann.url, title: ann.title || null });
        }
      }
    }
  }
  return sources;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter((part) => !part.thought && part.text).map((part) => part.text).join('')
    || parts.filter((part) => part.text).map((part) => part.text).join('');
}

function summarizeProviderError(err) {
  const message = err?.message || String(err || '');
  const status = message.match(/\b(?:HTTP|OpenAI|Gemini|Claude)?\s*(\d{3})\b/)?.[1] || null;
  return {
    name: err?.name || 'Error',
    code: err?.code || null,
    status,
    aborted: err?.name === 'AbortError' || err?.code === 'ABORT_ERR',
  };
}

module.exports = {
  lookupStoriesFromAI,
  lookupPropertyFromAI,
  lookupPropertyFromOpenAI,
  lookupPropertyFromGemini,
  lookupPropertyFromManateePAO,
  lookupPropertyFromAITrio,
  _private: {
    buildPropertyDataQuality,
    hasCountyPricingCore,
    hasAnyPropertyFact,
    lookupPropertyFromManateePAO,
    manateeAddressSearchCandidates,
    mergePropertyRecords,
    normalizeLookupPropertyType,
    parseManateePaoRecord,
    parsePropertyJSON,
    pickManateeSearchResult,
    shapeAsPropertyRecord,
    shouldQueryManateePAO,
  },
};
